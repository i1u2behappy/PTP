import { describe, it, expect } from 'vitest'
import { extractFromHtml } from '../../lib/scraper'

// ─────────────────────────────────────────────────────────────────────────────
// 이 테스트가 존재하는 이유 (2026-09-27, 시즌백)
//
// "상품정보제공고시" 표를 찾는 infoRows 스캐너(lib/extract.ts)는 페이지의 모든 <table><tr>에서
// "칸이 2개면 라벨/값 쌍"으로 무조건 받아들였다. 그런데 옵션(색상/사이즈) 선택 <select>를 <table><tr>
// 정렬로 배치하는 카페24 구형 테마가 있어, <select>의 <option> 목록 전체가 "값"으로, 그 옵션 그룹의
// 내부 이름(하필 상품 자체 스타일 코드와 같아 "BG-7868" 등)이 "라벨"로 잡혀 custom_fields에 그대로
// 섞여 들어갔다 — 상품마다 라벨이 전부 달라, 스크랩 Raw 확인 화면에 상품 수만큼 거의 빈 컬럼이 하나씩
// 생겨나는 결과로 이어졌다(실사용 확인 — 250개 상품 세션에서 사실상 고유값 하나뿐인 custom_fields 키가
// 수백 개 생김). <select>/<input> 같은 상호작용 위젯이 든 행을 통째로 제외해 막는다.
// ─────────────────────────────────────────────────────────────────────────────
describe('상품 추출 — 옵션 선택 위젯을 상품정보제공고시 값으로 안 읽는다', () => {
  const html = `
    <html><body>
      <h1 class="product-name">비즈니스 BG-7868</h1>
      <table>
        <tr>
          <th>BG-7868</th>
          <td>
            <select name="option1">
              <option value="*">- [필수] 옵션을 선택해 주세요 -</option>
              <option value="1">--------------------</option>
              <option value="2">블랙그레이</option>
            </select>
          </td>
        </tr>
        <tr>
          <th>소재</th>
          <td>천연가죽</td>
        </tr>
      </table>
    </body></html>
  `
  const url = 'https://seasonbag.co.kr/product/detail.html?product_no=1'

  it('옵션 select가 든 행은 custom_fields로 안 들어간다', async () => {
    const product = await extractFromHtml(html, url)
    expect(product.custom_fields['BG-7868']).toBeUndefined()
    expect(Object.values(product.custom_fields).some(v => v.includes('필수'))).toBe(false)
  }, 60_000)

  it('같은 표 안의 진짜 정보제공고시 행(소재)은 그대로 잡힌다', async () => {
    const product = await extractFromHtml(html, url)
    expect(product.custom_fields['소재']).toBe('천연가죽')
  }, 60_000)
})
