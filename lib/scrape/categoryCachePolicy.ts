/**
 * "카테고리 불러오기"/"다시 확인"(app/api/scrape/categories/route.ts)이 방금 새로 훑은 결과로 캐시된
 * sites.scrape_profile.categoryLinks를 덮어써도 되는지 판단하는 순수 로직만 뽑아둔 것 — route 핸들러
 * 안에 있으면 실제 DB/인증 없이 이 판단 자체를 테스트할 방법이 없었다.
 *
 * 덮어쓰면 안 되는 두 경우:
 * 1. 이번엔 AI 없이 규칙 기반으로만 찾았는데, 예전엔 AI가 성공해 더 정확한 카테고리를 캐시해뒀을 때
 *    (신우 몰 실사용 확인, 2026-08-25 — "다시 확인"을 눌렀더니 무관한 카테고리로 캐시가 덮어써짐).
 * 2. 이번 크롤이 로그인 벽에 막혔을 때(loginBlockedExpansion) — 회원전용 도매몰은 서버 헤드리스가 개인
 *    크롬 프로필을 복사해도 로그인 세션이 넘어오지 않는 구조적 한계라, "다시 확인"을 누를 때마다 매번
 *    로그인 벽에 막힌 부실한 결과(하위구조가 안 펼쳐진 대분류 목록)로 덮어쓰면, 확장(chrome.debugger,
 *    실제 로그인된 탭)이 방금 저장해둔 좋은 결과가 매번 지워진다(실사용 확인, 2026-08-29 — 화면 안내가
 *    정확히 "확장 실행 → 다시 확인"을 시키는데 그 "다시 확인"이 결과를 원상복구시키고 있었음).
 */
export function shouldKeepPreviousCategoryLinks(input: {
  freshAiUsed: boolean
  freshLoginBlockedExpansion: boolean
  prevAiUsed: boolean
  prevCategoryLinksCount: number
}): boolean {
  if (input.prevCategoryLinksCount <= 0) return false
  if (!input.freshAiUsed && input.prevAiUsed) return true
  if (input.freshLoginBlockedExpansion) return true
  return false
}
