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

export interface CategoryTreeNode {
  name: string
  href?: string
  children: CategoryTreeNode[]
}

/** categoryLinks(대분류 > 중분류 > 소분류 ... 형태로 " > "를 구분자로 쓰는 경로)를 실제 단계 그대로
 *  중첩된 트리로 묶는다 — "몰 구조분석" 결과 카드가 "카테고리 구조"를 "합계 N개" 한 줄 요약 대신 대분류별
 *  개별 내역으로 구분해서 보여주는 데 쓴다(사용자 지시, 2026-09-15 — "요약하지 말고 개별 내역을 잘
 *  구분해서 볼 수 있게"). 처음엔 " > " 경로의 첫 조각(대분류)으로만 묶고 나머지는 전부 한 단계로 뭉쳐서
 *  보여줬는데, 중분류 밑에 소분류가 여러 개 있는 몰(도매신 실사용 확인, 2026-09-16 — 비전이 대/중/소분류를
 *  실제로 구분해 읽어낼 수 있게 되면서 이 구분을 화면에도 그대로 살려달라는 요청)에서는 중분류와 소분류가
 *  서로 다른 대분류 항목처럼 나란히만 나열돼 실제 계층이 안 보였다. 화면(ScraperPanel.tsx)과 서버 양쪽에서
 *  쓸 수 있도록 이 client-safe 모듈에 둔다. 순수 함수라 테스트로 규칙을 고정해둔다. */
export function buildCategoryTree(categoryLinks: { name: string; href: string }[] | undefined): CategoryTreeNode[] {
  const roots: CategoryTreeNode[] = []
  for (const link of categoryLinks ?? []) {
    const segments = link.name.split(' > ').map(s => s.trim()).filter(Boolean)
    if (!segments.length) continue
    let level = roots
    let node: CategoryTreeNode | undefined
    for (const seg of segments) {
      node = level.find(n => n.name === seg)
      if (!node) {
        node = { name: seg, children: [] }
        level.push(node)
      }
      level = node.children
    }
    if (node) node.href = link.href
  }
  return roots
}

/** node 자신과 그 아래 모든 자손 중 실제 categoryLinks 항목(href가 있는 노드)의 개수 — 경로 중간에서
 *  겹치는 이름(예: "WOMEN SHOES"가 그 자체로도 링크고 "WOMEN SHOES > 부츠/털신발"의 부모이기도 한 경우)을
 *  두 번 세거나 빠뜨리지 않는다. 대분류 블록 제목의 "(N개)"에 쓴다. */
export function countCategoryTreeEntries(node: CategoryTreeNode): number {
  return (node.href ? 1 : 0) + node.children.reduce((sum, c) => sum + countCategoryTreeEntries(c), 0)
}
