import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { extractFromHtml } from '../../lib/scraper'

// 실제 재발 사고(리얼백realbag.kr product_no=551, 2026-10-04) — 카페24 기본 스킨의 대표이미지는
// `.keyImg img` 하나뿐인데(추가이미지 `.xans-product-addimage`는 등록 안 해 비어있거나 숨겨짐), 이
// 셀렉터가 lib/extract.ts의 알려진-플랫폼 폴백 체인(신우 .img_small, 고도몰 .view_img, #bigimage 등)에
// 아예 없었다. 그래서 모든 알려진 셀렉터가 실패해 "본문 전체에서 /product/ 경로가 든 <img> 추측" 범용
// 폴백까지 떨어졌는데, 같은 상세페이지에 실리는 "최근 본 상품"/추천 위젯의 **다른 상품** 썸네일도 같은
// /product/ 경로를 쓰는 바람에 그것까지 대표이미지로 잘못 주워와 "대표이미지 5장"처럼 실제보다 훨씬
// 많이 나왔다(화면엔 분명히 1장만 보이는데도). 이 부류는 에러 없이 그럴듯한 값을 내 로그로는 안 잡히고
// 결과물 대조로만 발견되므로, 실제 몰 HTML을 픽스처로 박아 회귀를 자동 검출한다.
describe('상품 추출 — 카페24 .keyImg 대표이미지를 범용 폴백보다 먼저 쓴다', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/realbag-product-detail.html'), 'utf8')
  const url = 'https://realbag.kr/product/detail.html?product_no=551&cate_no=4&display_group=3'

  it('.keyImg의 실제 대표이미지만 쓰고, 관련 위젯의 다른 상품 썸네일/배너는 섞이지 않는다', async () => {
    const product = await extractFromHtml(html, url)
    expect(product.thumbnail_urls).toEqual([
      'https://realbag.kr/web/product/big/20191129/f4235da3e6c17706c7db6b2caa2e7d21.jpg',
      'https://realbag.kr/web/product/small/20191129/706b0310c297ca435fd54b9eece5247c.jpg',
    ])
    expect(product.thumbnail_urls.some(u => /other-product-thumb|naver_pay_banner/.test(u))).toBe(false)
  }, 60_000)
})
