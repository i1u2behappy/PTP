/**
 * "카테고리 불러오기"/"다시 확인"(app/api/scrape/categories/route.ts)이 방금 새로 훑은 결과로 캐시된
 * sites.scrape_profile.categoryLinks를 덮어써도 되는지 판단하는 순수 로직만 뽑아둔 것 — route 핸들러
 * 안에 있으면 실제 DB/인증 없이 이 판단 자체를 테스트할 방법이 없었다.
 *
 * 덮어쓰면 안 되는 두 경우:
 * 1. 이번 크롤이 로그인 벽에 막혔을 때(loginBlockedExpansion) — 회원전용 도매몰은 서버 헤드리스가 개인
 *    크롬 프로필을 복사해도 로그인 세션이 넘어오지 않는 구조적 한계라, "다시 확인"을 누를 때마다 매번
 *    로그인 벽에 막힌 부실한 결과(하위구조가 안 펼쳐진 대분류 목록)로 덮어쓰면, 확장(chrome.debugger,
 *    실제 로그인된 탭)이 방금 저장해둔 좋은 결과가 매번 지워진다(실사용 확인, 2026-08-29 — 화면 안내가
 *    정확히 "확장 실행 → 다시 확인"을 시키는데 그 "다시 확인"이 결과를 원상복구시키고 있었음).
 * 2. 이번엔 AI 없이 규칙 기반으로만 찾았는데, 예전엔 AI가 성공해 더 정확한 카테고리를 캐시해뒀고, 이번에
 *    찾은 개수가 예전보다 늘지는 않았을 때(신우 몰 실사용 확인, 2026-08-25 — "다시 확인"을 눌렀더니
 *    무관한 카테고리로 캐시가 덮어써짐). "AI가 찾았다"는 "규칙 기반보다 신뢰할 만하다"는 뜻이었지 "그
 *    결과 자체가 항상 좋다"는 보장은 아니다 — 이번에 새로 찾은 개수가 이전보다 뚜렷이 많으면 AI 채택
 *    여부와 무관하게 더 나은 결과로 본다(펫토리 실사용 확인, 2026-09-06 — 예전에 AI가 겨우 3개만 찾아
 *    저장해둔 걸, 이후 규칙 기반 판정을 고쳐 실제 대분류 17개를 제대로 찾았는데도 "AI 채택분 보호"
 *    규칙 때문에 계속 3개짜리로 되돌아갔다 — count 비교 없이 AI 여부만 보던 게 원인).
 */
export function shouldKeepPreviousCategoryLinks(input: {
  freshAiUsed: boolean
  freshLoginBlockedExpansion: boolean
  freshCategoryLinksCount: number
  prevAiUsed: boolean
  prevCategoryLinksCount: number
}): boolean {
  if (input.prevCategoryLinksCount <= 0) return false
  if (input.freshLoginBlockedExpansion) return true
  if (input.freshCategoryLinksCount > input.prevCategoryLinksCount) return false
  if (!input.freshAiUsed && input.prevAiUsed) return true
  return false
}

/**
 * "몰 구조분석" 버튼 하나가 서버(sampleMallProfile, /api/sites/[id]/profile)와 개발자모드 확장
 * (runDetectSortOptions, /api/sites/[id]/sort-options)을 동시에 병렬로 실행시키는데, 로그인 없이도
 * 서버가 카테고리 페이지를 직접 열어볼 수 있는 몰(manual_login_required=true라도 실제로는 비로그인
 * 열람이 되는 몰, 모자사러 실사용 확인 2026-09-09)에서는 둘 다 각자 독립적으로 정렬 옵션을 찾아 같은
 * sites.scrape_profile.sortOptions 자리에 쓴다 — 서버는 [낮은가격,높은가격]을, 확장은 [상품명]을 각자
 * 화면(스크린샷)에서 찾아 클릭 확인한 서로 다른 부분집합이었는데, 어느 한쪽이 먼저 쓰고 나중에 쓴 쪽이
 * 그대로 덮어써버려 "정렬 구조"가 실행마다 무작위로 다르게(때로는 상품명만, 때로는 낮은가격/높은가격만)
 * 보였다. label 기준으로 합쳐서, 두 경로가 각자 찾은 걸 잃지 않고 누적되게 한다 — 같은 label이 양쪽에
 * 다 있으면 next(이번에 쓰려는 쪽) 값을 남긴다(어느 쪽을 남겨도 무방 — paramsToAdd 계산 방식이 같은
 * label이면 보통 같은 값이 나온다).
 */
export function mergeSortOptions<T extends { label: string }>(prev: T[] | undefined, next: T[] | undefined): T[] {
  if (!prev?.length) return next ?? []
  const seen = new Set((next ?? []).map(o => o.label))
  return [...(next ?? []), ...prev.filter(o => !seen.has(o.label))]
}
