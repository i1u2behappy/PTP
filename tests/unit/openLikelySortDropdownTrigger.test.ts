import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { openLikelySortDropdownTrigger } from '../../lib/scraper'

/**
 * 정글북(junglebook.co.kr) 실사용 확인(2026-09-15, 사용자 지적 "정렬은 클릭한번 해보면 여러개의
 * 정렬기준이 나오는데, 그걸 못해?") — 정렬 옵션이 `<button><span>최신순</span><svg/></button>` 트리거를
 * 클릭해야만 DOM에 나타나는 닫힌 드롭다운이었다(판매순/낮은 가격순/높은 가격순/상품명순은 클릭 전엔
 * document에 존재조차 하지 않음, Playwright로 실제 페이지를 열어 확인). 정렬탐지가 페이지를 있는
 * 그대로만 스캔/스크린샷해서 이 4개를 전혀 찾지 못했다 — openLikelySortDropdownTrigger가 스캔/스크린샷
 * 전에 트리거를 먼저 열어주는 안전장치다.
 */
describe('openLikelySortDropdownTrigger — 닫힌 정렬 드롭다운 트리거 열기', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('정글북류 마크업 — 트리거를 클릭해 닫혀있던 옵션들을 나타나게 한다', async () => {
    // 실제 정글북은 CSS로 숨기는 게 아니라 클릭 전엔 옵션 요소가 DOM에 아예 없다(React 조건부 렌더링) —
    // hidden 속성 토글은 Playwright count()가 여전히 DOM 존재로 세므로 실제와 다르게 통과해버린다.
    // insertAdjacentHTML로 클릭 시점에 진짜로 새로 삽입해 그 차이를 그대로 재현한다.
    await page.setContent(`
      <button id="dog">강아지<svg><path d="M0 0"/></svg></button>
      <button id="trigger"><span>최신순</span><svg><path d="M2 5L7 10L12 5"/></svg></button>
      <script>
        document.getElementById('trigger').addEventListener('click', () => {
          document.body.insertAdjacentHTML('beforeend', \`
            <ul id="menu">
              <li><button>최신순</button></li>
              <li><button>판매순</button></li>
              <li><button>낮은 가격순</button></li>
              <li><button>높은 가격순</button></li>
              <li><button>상품명순</button></li>
            </ul>
          \`)
        })
      </script>
    `)
    expect(await page.getByText('판매순', { exact: true }).count()).toBe(0)
    const opened = await openLikelySortDropdownTrigger(page)
    expect(opened).toBe(true)
    expect(await page.getByText('판매순', { exact: true }).count()).toBe(1)
    expect(await page.getByText('상품명순', { exact: true }).count()).toBe(1)
  })

  it('정렬 키워드처럼 생긴 트리거가 없으면(아이콘 버튼이 전부 무관함) 아무것도 안 열고 false를 돌려준다', async () => {
    await page.setContent(`
      <button id="dog">강아지<svg><path d="M0 0"/></svg></button>
      <button id="cat">고양이<svg><path d="M0 0"/></svg></button>
    `)
    const opened = await openLikelySortDropdownTrigger(page)
    expect(opened).toBe(false)
  })

  it('토글 트리거 — 이미 열려 있으면 다시 클릭해 도로 닫지 않는다', async () => {
    // 정글북 실사용 재확인(2026-09-15) — 트리거는 누를 때마다 열림/닫힘이 토글된다. 화면 인식 단계가
    // 한 번 열어둔 뒤 클릭 폴백 단계가 또 이 함수를 부르면, 무조건 클릭하는 구현은 방금 연 걸 도로
    // 닫아버려서 "고쳤는데도 여전히 후보가 안 잡힘" 사고가 났다 — 두 번 연달아 불러도 열린 채로 유지돼야
    // 한다.
    await page.setContent(`
      <button id="trigger"><span>최신순</span><svg><path d="M2 5L7 10L12 5"/></svg></button>
      <script>
        let open = false
        document.getElementById('trigger').addEventListener('click', () => {
          open = !open
          const existing = document.getElementById('menu')
          if (existing) existing.remove()
          if (open) {
            document.body.insertAdjacentHTML('beforeend', '<ul id="menu"><li><button>최신순</button></li><li><button>판매순</button></li></ul>')
          }
        })
      </script>
    `)
    expect(await openLikelySortDropdownTrigger(page)).toBe(true)
    expect(await page.getByText('판매순', { exact: true }).count()).toBe(1)
    expect(await openLikelySortDropdownTrigger(page)).toBe(true)
    expect(await page.getByText('판매순', { exact: true }).count()).toBe(1)
  })

  it('아이콘(svg) 없는 버튼은 텍스트가 정렬 키워드여도 트리거로 보지 않는다', async () => {
    await page.setContent(`
      <button id="trigger">최신순</button>
      <script>
        document.getElementById('trigger').addEventListener('click', () => {
          document.body.insertAdjacentHTML('beforeend', '<ul id="menu"><li><button>판매순</button></li></ul>')
        })
      </script>
    `)
    const opened = await openLikelySortDropdownTrigger(page)
    expect(opened).toBe(false)
    expect(await page.getByText('판매순', { exact: true }).count()).toBe(0)
  })
})
