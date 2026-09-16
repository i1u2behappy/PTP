import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { detectLoggedInSignal } from '../../lib/scraper'

/**
 * 정글북(junglebook.co.kr) 실사용 확인(2026-09-15, 사용자 질문 "로그인이 끊겼다는 내용은 맞는거야?"로
 * 재진단) — 이 몰의 로그아웃 컨트롤은 `<button aria-label="로그아웃">`처럼 텍스트 없이 아이콘뿐이었다.
 * detectLoggedInSignal은 <a> 태그의 화면 텍스트만 보고 있어서, 실제로는 로그인된 상태에서도 항상
 * "로그인 안 됨"으로 오판해 "로그인 세션이 끊긴 것으로 보임" 경고가 몰구조분석마다 매번(거짓으로) 떴다.
 */
describe('detectLoggedInSignal — 아이콘 전용 로그아웃 버튼도 인식', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('정글북류 마크업 — 텍스트 없이 aria-label만 있는 <button>도 로그인 신호로 인정한다', async () => {
    await page.setContent(`<header><button aria-label="로그아웃"><svg></svg></button></header>`)
    expect(await detectLoggedInSignal(page)).toBe(true)
  })

  it('기존 <a>로그아웃</a> 텍스트 링크도 그대로 인식한다(회귀 방지)', async () => {
    await page.setContent(`<a href="/logout">로그아웃</a>`)
    expect(await detectLoggedInSignal(page)).toBe(true)
  })

  it('title 속성에만 있는 경우도 인식한다', async () => {
    await page.setContent(`<button title="Logout"><svg></svg></button>`)
    expect(await detectLoggedInSignal(page)).toBe(true)
  })

  it('로그아웃 신호가 전혀 없으면 false를 돌려준다', async () => {
    await page.setContent(`<a href="/login">로그인</a><button aria-label="검색"></button>`)
    expect(await detectLoggedInSignal(page)).toBe(false)
  })
})
