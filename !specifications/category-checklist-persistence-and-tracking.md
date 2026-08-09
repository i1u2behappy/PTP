# 카테고리 목록 - 탭 전환 후 사라지는 버그 수정 + 완료/제외 표시

## 배경

"스크랩 Raw 확인" 메뉴로 갔다가 스크래핑 메뉴로 돌아오면, 수집완료한 상품 리스트(진행 상황)는
보이는데 그 전에 "모든 카테고리 불러오기"로 골라둔 카테고리 목록은 사라져 있는 문제가 실사용 중
보고됐다(2026-08-10). 카테고리를 나눠서(오늘 일부, 나중에 나머지) 스크랩하는 경우가 있어, 어떤
카테고리를 이미 작업했고 어떤 게 아직인지 확인할 수 있어야 한다는 요청도 함께 있었다.

## 버그 — 카테고리 목록 복원 안 됨

`components/panels/ScraperPanel.tsx`의 마운트 복원 effect는 `LAST_SESSION_KEY`(스크랩 진행/완료
상태)가 있으면 그 즉시 `return`해버려서, 그 아래 `FORM_STATE_KEY`(몰 선택/카테고리 목록 등) 복원
코드까지 도달하지 못했다 — 완료된 세션이 있는 몰은 항상 카테고리 목록이 빈 채로 시작됐다.

**수정**: 두 저장소의 복원을 서로 독립적으로 만들었다. `applyFormState(saved)` 헬퍼로 폼 상태 적용
로직을 분리하고, 세션 복원 분기에서도(같은 몰일 때) 이 헬퍼를 호출한다. `selectSite()`(카테고리/
진행상황을 전부 초기화하는, "다른 몰 선택" 전용 함수)는 이 경로에서 호출하지 않아 방금 복원한 세션을
덮어쓰지 않는다.

## 기능 — 카테고리별 "완료" 표시

`app/api/scrape/route.ts`가 세션 생성 시 실제 선택된 카테고리 URL들을 `scrape_sessions.scope_params`
(기존에 있었지만 안 쓰이던 컬럼)에 저장한다. `app/api/scrape/categories/route.ts`가 이 몰의 완료
(`status='done'`) 세션들을 모아 "이미 스크랩한 카테고리 URL 집합"을 계산해 함께 내려주고, 카테고리
체크박스 목록에 `✓ 완료` 표시 + 헤더에 "완료 N개" 요약을 붙인다. `scope_type='all'`(전체 스크랩)
세션이 하나라도 있으면 카테고리 구분 없이 전부 완료로 본다.

**"완료"의 기준 범위**: 처음엔 이 몰의 역대 모든 완료 세션을 봤는데, 사용자 판단으로 **가장 최근
로그인 확인 이후**로 좁혔다 — 다시 로그인했다는 건 새 작업 사이클로 본다는 뜻이라, 그 이전 로그인
때 완료한 카테고리까지 "완료"로 보여줄 필요가 없다는 것. `sites.last_login_confirmed_at`(신규 컬럼)을
`app/api/scrape/login-confirm/route.ts`가 "로그인 확인"을 누를 때마다 갱신하고, 완료 집계 쿼리가
`created_at >= last_login_confirmed_at` 조건을 추가로 건다. 이 기록이 아직 없는 몰(컬럼 도입 전)은
기준 시점을 모르니 완료 이력을 비워둔다(다음 로그인 확인부터 정상 반영).

## 기능 — 상품이 없는 카테고리를 "제외"로 표시

카테고리 자동 탐색이 실제 상품이 없는 항목(안내/문의 페이지 등, `!specifications/
scrape-preview-catalog-count-and-target-ui.md`의 "버그 10" 참고)까지 카테고리로 잡는 걸 완전히
막을 방법은 없다(몰마다 메뉴 구조가 제각각이라 텍스트 블록리스트만으론 새 몰마다 새 예외가 계속
나옴) — 그래서 사용자가 직접 열어보고 "이건 상품 카테고리가 아니다"로 표시해둘 수 있는 보조 수단을
추가했다.

- `app/api/scrape/categories/exclude/route.ts`(신규): `{ siteId, href, excluded }`를 받아
  `sites.scrape_profile.excludedCategoryHrefs`(href 배열)에 추가/제거한다. `force`로 카테고리를
  다시 훑어도 이 표시는 유지된다.
- 목록 화면: 각 행에 "제외"/"복원" 토글 버튼. 제외된 항목은 취소선 + "제외됨" 배지 + 반투명 처리되고,
  목록 맨 아래로 자동 정렬된다(`Array.sort`의 안정 정렬 특성상 같은 그룹 안에서는 원래 발견 순서
  유지). 선택(체크박스) 동작 자체는 건드리지 않았다 — 표시/정리 목적으로만 동작.

## 관련 파일

- `components/panels/ScraperPanel.tsx`: `applyFormState`(신규 헬퍼), `scrapedCategoryHrefs`/
  `allCategoriesScraped`/`excludedCategoryHrefs`(신규 상태, `FORM_STATE_KEY`에도 저장),
  `isCategoryScraped`/`isCategoryExcluded`/`toggleCategoryExcluded`(신규), 카테고리 체크리스트
  렌더링(완료 배지, 제외 토글, 정렬).
- `app/api/scrape/route.ts`: 세션 생성 시 `scope_params`에 `categoryUrls` 저장.
- `app/api/scrape/categories/route.ts`: `findScrapedCategoryHrefs`/`getExcludedCategoryHrefs`(신규)
  계산 후 응답에 포함.
- `app/api/scrape/categories/exclude/route.ts`(신규).
- `app/api/scrape/login-confirm/route.ts`: `sites.last_login_confirmed_at` 갱신.
- `lib/db.ts`: `sites.last_login_confirmed_at TIMESTAMPTZ`(신규 컬럼).

## 상태

**구현 완료.** tsc/eslint 클린. 실제 앱 화면에서의 최종 확인(탭 전환 후 카테고리 유지, 완료/제외
표시)은 사용자가 다음 사용 시 확인 예정.
