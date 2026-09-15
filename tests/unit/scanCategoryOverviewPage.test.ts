import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { scanCategoryOverviewPage } from '../../lib/scraper'

/**
 * "카테고리(51) → 합계 57개"로 뭉뚱그려지던 정글북(junglebook.co.kr) 실사용 사고(2026-09-15, 사용자
 * 지적 "왜 다 찾아내질 못했어?")의 실제 원인 — /category 페이지가 `<section><a>사료<svg/></a>
 * <div class="grid grid-cols-2"><a>건식사료</a><a>소프트사료</a>...</div></section>` 형태로, 제목이
 * <p>/<h*> 같은 텍스트 전용 태그가 아니라 그 자체가 링크(<a>)이고, 목록도 <ul>/<ol>이 아니라 grid형
 * <div>였다 — 기존 scanCategoryOverviewPage는 제목 태그 화이트리스트에 'a'가 없고 목록도 ul/ol만
 * 인정해 이 구조를 전혀 못 찾았다(첫 시도는 화면 캡처 없이 "굵은 글꼴로 구분되는 flat 형제 <a>"라고
 * 잘못 추측해 고쳤었는데, 실제로 Playwright로 /category를 열어 DOM을 확인해보니 전혀 다른 구조였다).
 *
 * getComputedStyle 등 브라우저 전용 API에 의존하진 않지만, page.evaluate 안에서 도는 함수라 실제
 * Playwright 브라우저로 테스트한다(cheerio가 아니라 scanCategoryMenu와 같은 이유).
 */
describe('scanCategoryOverviewPage — "제목+목록" 반복 구조 인식', () => {
  let browser: Browser
  let page: Page

  // scanCategoryOverviewPage는 a.href.startsWith(origin)으로 같은 출처만 카테고리 후보로 받는다(다른
  // 도메인 광고/제휴 링크 배제) — page.setContent()만 쓰면 문서 URL이 about:blank(origin="null")로 남아
  // 상대경로 href가 절대 URL로 정상 resolve되지 않는다. 실제 네트워크 없이 가짜 same-origin 응답을
  // route로 가로채 goto해서, 프로덕션과 같은 "실제 origin이 있는 페이지"로 테스트한다.
  async function loadHtml(html: string) {
    await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
    await page.goto('https://example.test/category')
    await page.unroute('https://example.test/**')
  }

  beforeAll(async () => {
    // headless-shell 대신 lib/scraper.ts의 실제 스크래핑 실행과 같은 channel(설치된 Chrome)을 쓴다 —
    // 이 프로젝트는 playwright의 번들 브라우저를 따로 설치해두지 않는다(lib/scraper.ts chromium.launch 참고).
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('정글북류 마크업 — 제목이 <a>이고 목록이 grid형 <div>여도 "대분류 > 중분류"로 인식한다', async () => {
    await loadHtml(`
      <section>
        <a href="/category/1650">사료<svg></svg></a>
        <div class="grid grid-cols-2 gap-x-3">
          <a href="/category/1674">건식사료</a>
          <a href="/category/1675">소프트사료</a>
          <a href="/category/1676">습식사료</a>
          <a href="/category/1677">화식사료</a>
        </div>
      </section>
      <section>
        <a href="/category/1651">간식</a>
        <div class="grid grid-cols-2 gap-x-3">
          <a href="/category/1680">덴탈껌</a>
          <a href="/category/1681">고기/가죽껌</a>
        </div>
      </section>
    `)
    const result = await scanCategoryOverviewPage(page)
    expect(result.map(l => l.name).sort()).toEqual([
      '간식 > 고기/가죽껌', '간식 > 덴탈껌', '사료 > 건식사료', '사료 > 소프트사료', '사료 > 습식사료', '사료 > 화식사료',
    ])
  })

  it('기존 신우류 마크업(<p>제목</p><ul>...) 도 그대로 인식한다(회귀 방지)', async () => {
    await loadHtml(`
      <p class="cate_t"><a href="/c/1">양말&amp;세트</a></p>
      <ul><li><a href="/c/11">발목양말</a></li><li><a href="/c/12">중목양말</a></li></ul>
      <p class="cate_t"><a href="/c/2">언더웨어</a></p>
      <ul><li><a href="/c/21">팬티</a></li><li><a href="/c/22">런닝</a></li></ul>
    `)
    const result = await scanCategoryOverviewPage(page)
    expect(result.map(l => l.name).sort()).toEqual([
      '양말&세트 > 발목양말', '양말&세트 > 중목양말', '언더웨어 > 런닝', '언더웨어 > 팬티',
    ])
  })

  it('"제목+목록" 짝이 1개뿐이면(반복 구조가 아님) 인식하지 않는다', async () => {
    await loadHtml(`
      <section>
        <a href="/category/1650">사료</a>
        <div class="grid grid-cols-2"><a href="/category/1674">건식사료</a><a href="/category/1675">소프트사료</a></div>
      </section>
    `)
    const result = await scanCategoryOverviewPage(page)
    expect(result).toEqual([])
  })

  it('같은 그리드 구조라도 반복되는 링크 컨테이너가 없으면(각 항목이 독립된 <a>) 오인하지 않는다', async () => {
    await loadHtml(`
      <a href="/p/1">더보기</a>
      <a href="/p/2">추천상품1</a>
    `)
    const result = await scanCategoryOverviewPage(page)
    expect(result).toEqual([])
  })
})
