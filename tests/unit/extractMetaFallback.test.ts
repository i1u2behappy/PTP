import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { extractFromHtml } from '../../lib/scraper'

// ─────────────────────────────────────────────────────────────────────────────
// 이 테스트가 존재하는 이유 (2026-09-13, 투비즈온)
//
// 상품 상세페이지인데도 `og:title`/`og:image`를 **사이트 공통 문구/로고**로 두는 몰이 있다. 추출기가
// 그 메타태그를 본문보다 먼저 믿는 바람에, 미리보기 상품명이 "투비즈온(코워크몰) - 도매 B2B 배송대행",
// 대표이미지가 로고로 나왔다 — 정작 본문에는 `<h3 class="product-name">여성 오버핏 …</h3>`이 있었다.
//
// 이 부류는 **에러가 안 나고 그럴듯한 값**이 나오기 때문에 로그로는 절대 안 드러나고, 결과물을 눈으로
// 대조해야만 잡힌다(그래서 실제로 사용자가 여러 번 지적한 뒤에야 발견됐다). 그러니 "다음에 잘 보겠다"가
// 아니라 **실제 몰 HTML을 픽스처로 박아 회귀를 자동 검출**한다. 같은 부류의 몰을 또 만나면 이 파일에
// 픽스처를 추가하는 것이 이 결함을 막는 방법이다.
//
// 픽스처는 실제 페이지에서 판정에 필요한 부분만 잘라 저장했다(사이트 공통 og/title + 상품명 본문 +
// 상품 이미지). extractFromHtml은 실제 크롬을 띄우므로 이 테스트만 조금 느리다(수 초).
// ─────────────────────────────────────────────────────────────────────────────
describe('상품 추출 — 사이트 공통 메타태그로 새지 않는다', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/tobizon-goods-view.html'), 'utf8')
  const url = 'https://www.tobizon.co.kr/mall/goods/goods_view.php?goodscd=DS01587858'

  it('og:title이 사이트 이름이어도 본문의 상품명을 쓴다', async () => {
    const product = await extractFromHtml(html, url)
    expect(product.name).toContain('오버핏')
    expect(product.name).not.toContain('투비즈온(코워크몰) - 도매 B2B 배송대행')
  }, 60_000)

  it('og:image가 로고여도 본문의 상품 이미지를 쓴다', async () => {
    const product = await extractFromHtml(html, url)
    expect(product.thumbnail_urls.length).toBeGreaterThan(0)
    expect(product.thumbnail_urls.some(u => /og_image|logo/i.test(u))).toBe(false)
  }, 60_000)
})
