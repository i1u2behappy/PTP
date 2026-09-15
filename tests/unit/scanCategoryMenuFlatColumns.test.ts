import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { scanCategoryMenu } from '../../lib/scraper'

/**
 * "카테고리(51) → 합계 57개"로 뭉뚱그려지던 정글북(junglebook.co.kr) 실사용 사고(2026-09-15, 사용자
 * 지적 "왜 다 찾아내질 못했어?")의 원인 — 실제 카테고리 메뉴가 <li> 없이 <div> 안에 <a> 형제가 그대로
 * 나열되고(<div><a class="font-bold">사료</a><a>건식사료</a>...</div>), 대분류/하위분류 구분은 오직
 * 글꼴 굵기 차이뿐이었다. 기존 scanCategoryMenu는 전부 <li> 기반이라 이 구조에서 후보를 하나도 못 찾고
 * AI 텍스트 폴백까지 떨어져, 대/중분류 구분 없이 일부만 뒤섞인 목록이 나왔다.
 *
 * getComputedStyle(글꼴 굵기 비교)이 있어야 검증되는 로직이라 실제 Playwright 브라우저를 띄워 테스트한다
 * (cheerio 기반 scanCategoryMenuFromHtml은 이 패턴을 지원하지 않는다 — CSS 엔진이 없어 글꼴 굵기를
 * 알 수 없으므로 대상이 아니다).
 */
describe('scanCategoryMenu — <li> 없는 플랫 앵커 그리드(메가메뉴) 인식', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    // headless-shell 대신 lib/scraper.ts의 실제 스크래핑 실행과 같은 channel(설치된 Chrome)을 쓴다 —
    // 이 프로젝트는 playwright의 번들 브라우저를 따로 설치해두지 않는다(lib/scraper.ts chromium.launch 참고).
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('정글북류 마크업 — 굵은 첫 <a>를 대분류, 나머지를 하위분류로 인식한다', async () => {
    await page.setContent(`
      <button>카테고리</button>
      <div class="menu">
        <div><a href="/c/1" style="font-weight:700">사료</a><a href="/c/11">건식사료</a><a href="/c/12">소프트사료</a></div>
        <div><a href="/c/2" style="font-weight:700">간식</a><a href="/c/21">덴탈껌</a><a href="/c/22">육포</a></div>
        <div><a href="/c/3" style="font-weight:700">장난감</a><a href="/c/31">봉제류</a><a href="/c/32">공</a></div>
      </div>
    `)
    const result = await scanCategoryMenu(page)
    expect(result.groupCount).toBe(3)
    expect(result.links.map(l => l.name).sort()).toEqual([
      '간식 > 덴탈껌', '간식 > 육포', '사료 > 건식사료', '사료 > 소프트사료', '장난감 > 공', '장난감 > 봉제류',
    ])
  })

  it('컬럼이 2개뿐이면(오탐 방지 상한 미만) 인식하지 않는다', async () => {
    await page.setContent(`
      <button>카테고리</button>
      <div>
        <div><a href="/c/1" style="font-weight:700">사료</a><a href="/c/11">건식사료</a></div>
        <div><a href="/c/2" style="font-weight:700">간식</a><a href="/c/21">덴탈껌</a></div>
      </div>
    `)
    const result = await scanCategoryMenu(page)
    expect(result.links).toEqual([])
  })

  it('형제 <a>들의 글꼴 굵기가 모두 같으면(헤더 구분 신호 없음) 인식하지 않는다', async () => {
    await page.setContent(`
      <button>카테고리</button>
      <div>
        <div><a href="/c/1">사료</a><a href="/c/11">건식사료</a><a href="/c/12">소프트사료</a></div>
        <div><a href="/c/2">간식</a><a href="/c/21">덴탈껌</a><a href="/c/22">육포</a></div>
        <div><a href="/c/3">장난감</a><a href="/c/31">봉제류</a><a href="/c/32">공</a></div>
      </div>
    `)
    const result = await scanCategoryMenu(page)
    expect(result.links).toEqual([])
  })

  it('"카테고리"류 트리거가 아예 없는 페이지에서는 시도조차 하지 않는다 — 무관한 그리드(예: 상품 목록)를 오인하지 않는다', async () => {
    await page.setContent(`
      <div class="products">
        <div><a href="/c/1" style="font-weight:700">브랜드 A</a><a href="/c/11">상품1</a><a href="/c/12">상품2</a></div>
        <div><a href="/c/2" style="font-weight:700">브랜드 B</a><a href="/c/21">상품1</a><a href="/c/22">상품2</a></div>
        <div><a href="/c/3" style="font-weight:700">브랜드 C</a><a href="/c/31">상품1</a><a href="/c/32">상품2</a></div>
      </div>
    `)
    const result = await scanCategoryMenu(page)
    expect(result.links).toEqual([])
  })
})
