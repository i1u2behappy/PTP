/** "이 URL은 몰 홈(첫 화면)이라 카테고리가 아니다"를 판정한다.
 *
 *  2026-09-13 투비즈온 실사용에서 두 사고가 같은 원인으로 이어졌다: "현재 카테고리 가져오기"가 사용자가
 *  보던 탭이 아니라 추적 중인 탭(홈)을 읽어 `https://www.tobizon.co.kr/index.php`를 카테고리 목록에
 *  넣었고, 그 뒤 "스크랩 미리보기"가 그 첫 줄을 기준으로 표본을 뽑아 **몰 홈페이지 자체를 상품으로**
 *  보여줬다(상품명이 몰 타이틀, 공급가 ₩2,640).
 *
 *  쿼리가 붙어 있으면 카테고리일 수 있으므로(예: `index.php?cate=12`) 홈으로 보지 않는다 — "경로가
 *  루트이거나 index.*이고 쿼리/해시가 없는 경우"만 홈으로 판정한다. */
export function looksLikeMallHomeUrl(href: string): boolean {
  try {
    const u = new URL(href)
    if (u.search || u.hash) return false
    const path = u.pathname.replace(/\/+$/, '')
    return path === '' || /^\/index\.(php|html?|asp|jsp)$/i.test(path)
  } catch {
    return false
  }
}

/** 두 URL이 "같은 페이지"인지 — 미리보기 표본이 목록 페이지 자신이 되는 걸 막는 데 쓴다.
 *  www 유무와 끝 슬래시, 해시 차이는 무시한다(같은 페이지를 다르게 쓴 것일 뿐). */
export function isSamePageUrl(a: string, b: string): boolean {
  const norm = (href: string) => {
    try {
      const u = new URL(href)
      return `${u.protocol}//${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`
    } catch {
      return href.trim()
    }
  }
  return norm(a) === norm(b)
}

export interface CategoryTreeGroup {
  top: string
  children: { name: string; href: string }[]
}

/** categoryLinks(대분류 > 중분류 > ... 형태로 " > "를 구분자로 쓰는 경로)를 최상위 조각(대분류) 기준으로
 *  묶는다 — "몰 구조분석" 결과 카드가 "카테고리 구조"를 "합계 N개" 한 줄 요약 대신 대분류별 개별 내역으로
 *  구분해서 보여주는 데 쓴다(사용자 지시, 2026-09-15 — "요약하지 말고 개별 내역을 잘 구분해서 볼 수 있게").
 *  화면(ScraperPanel.tsx)과 서버(lib/scraper.ts) 양쪽에서 쓸 수 있도록 이 client-safe 모듈에 둔다.
 *  순수 함수라 테스트로 규칙을 고정해둔다. */
export function buildCategoryTreeView(categoryLinks: { name: string; href: string }[] | undefined): CategoryTreeGroup[] {
  if (!categoryLinks?.length) return []
  const groups = new Map<string, { name: string; href: string }[]>()
  for (const link of categoryLinks) {
    const top = link.name.split(' > ')[0] || link.name
    const list = groups.get(top)
    if (list) list.push(link)
    else groups.set(top, [link])
  }
  return [...groups.entries()].map(([top, children]) => ({ top, children }))
}
