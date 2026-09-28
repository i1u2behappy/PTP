import { describe, it, expect, afterAll } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { isBotBlockPage } from '../../lib/scraper'

// ─────────────────────────────────────────────────────────────────────────────
// 이 테스트가 존재하는 이유 (2026-09-27, 모자사러)
//
// 카페24가 원래 도메인이 아니라 veritas-hub.cafe24.com/challenge로 통째로 리다이렉트하는 봇 차단
// 챌린지 페이지("안전한 이용을 위해" / "간단한 확인이 필요해요")를 만났는데, 기존 isBotBlockPage의
// 문구 정규식엔 하나도 안 걸려 "카테고리 하위구조 확인"이 이 페이지를 실제 카테고리 메뉴로 착각하고
// 몇십 분을 허비한 뒤 결국 "하위 카테고리 0개"로 잘못 결론지었다. 문구 추가 + 호스트명 검사를 회귀
// 테스트로 고정해둔다.
// ─────────────────────────────────────────────────────────────────────────────
describe('isBotBlockPage — 카페24 챌린지 페이지 감지', () => {
  let browser: Browser
  async function checkHtml(html: string): Promise<boolean> {
    browser ??= await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true })
    const page = await browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      return await isBotBlockPage(page)
    } finally {
      await page.close()
    }
  }
  afterAll(async () => { await browser?.close() })

  it('"간단한 확인이 필요해요" 챌린지 문구를 봇 차단으로 인식한다', async () => {
    const blocked = await checkHtml('<html><body><h1>안전한 이용을 위해</h1><p>간단한 확인이 필요해요.</p></body></html>')
    expect(blocked).toBe(true)
  }, 30_000)

  it('정상적인 카테고리 페이지는 봇 차단으로 오인하지 않는다', async () => {
    const blocked = await checkHtml('<html><body><h1>여성화</h1><ul><li>FLAT & LOAFER</li></ul></body></html>')
    expect(blocked).toBe(false)
  }, 30_000)
})
