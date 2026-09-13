/** 카테고리 URL을 표에 보여줄 때 쓰는 축약 — 카테고리를 구분하는 부분(`?ctno=001` 등)은 URL **뒤쪽**에
 *  있는데 CSS truncate는 앞부터 보여주고 뒤를 자른다. 그래서 모든 행이 `.../goods_list.php`로 똑같아 보여
 *  "현재 카테고리를 제대로 못 불러온다"는 오해를 샀다(2026-09-13, 투비즈온 — 저장된 값에는 ?ctno=001이
 *  멀쩡히 들어있었다). 도메인은 버리고 경로+쿼리를 보여주되, 그래도 길면 **앞쪽**을 줄인다.
 *  컴포넌트가 아니라 별도 파일에 두는 이유: 순수 함수라 테스트에서 무거운 클라이언트 컴포넌트를
 *  통째로 import하지 않고 그대로 검증할 수 있게 하기 위함. */
export function shortenCategoryUrlForDisplay(href: string, max = 52): string {
  let shown = href
  try {
    const u = new URL(href)
    shown = `${u.pathname}${u.search}${u.hash}`
  } catch { /* URL 형태가 아니면 원문을 그대로 줄인다 */ }
  return shown.length <= max ? shown : `…${shown.slice(-(max - 1))}`
}
