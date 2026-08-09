# "스크랩 Raw 확인"에서도 세션 선택 병합 가능하게

## 배경

"스크랩 Raw 확인"(`ProductsListPanel`) 세션 목록에 "병합 일시" 컬럼과 "🔗 병합" 배지가 있는데, 이
화면 자체에는 병합을 실행할 버튼이 없었다 — 실제 "🔗 선택 병합" 버튼은 `MigrationDashboardPanel`(데이터
마이그 목록)에만 있었다. 사용자가 이 화면에서 그 기능이 빠진 것처럼 보인다고 보고(2026-08-10) — "상태"가
"확정"인 세션들만 체크해서 병합할 수 있게 해달라는 요청.

## 설계

`MigrationDashboardPanel`이 이미 쓰던 병합 UX(체크 → 같은 몰인지 즉시 검증 → "🔗 선택 병합" 버튼 →
`POST /api/sessions/merge`)를 그대로 이 화면에도 연결했다. 다만 이 화면은 몰 전체 세션(미확정 포함)을
그대로 보여주는 화면이라(`MigrationDashboardPanel`은 서버 조회 자체가 확정분만 내려줌), 체크 시점에
"확정"(`ScrapeSessionGrid`의 "상태" 컬럼이 보여주는 것과 같은 기준: `staged_count>0 && pending_count===0`)
여부를 추가로 검증해야 했다.

- `ScrapeSessionGrid`(공용 컴포넌트)에 `isRowCheckable?: (s) => boolean`(신규, 선택적) prop 추가 —
  지정하면 그 함수가 false인 행의 체크박스를 흐리게 비활성화한다. 안 주면(기존 3개 호출부 전부) 항상
  체크 가능해 기존 동작 그대로.
- `ProductsListPanel`: 체크박스 컬럼을 admin 전용에서 전체 사용자로 개방(병합은 admin 전용 기능이
  아님 — 기존 `MigrationDashboardPanel`도 admin 게이트가 없음). `isConfirmed()` 헬퍼로 체크 가능 여부를
  판단, 체크 시점에 확정 여부 + 같은 몰인지 검증(미확정/다른 몰이면 즉시 alert하고 선택에 안 넣음).
  체크 2개 이상이면 "🔗 선택 병합" 버튼 노출.
- 기존 "🗑 선택 삭제" 버튼(admin 전용)은 그대로 유지 — 체크박스가 이제 전체 사용자에게 보이지만, 삭제
  버튼 자체의 권한 게이트는 건드리지 않았다.

## 관련 파일

- `components/panels/shared/ScrapeSessionGrid.tsx`: `isRowCheckable` prop 추가(체크박스 비활성화 +
  전체선택 계산에서 제외).
- `components/panels/ProductsListPanel.tsx`: `isConfirmed`/`handleMergeSessions`(신규), 체크 검증 로직,
  "🔗 선택 병합" 버튼, 체크박스 컬럼 전체 사용자 개방.

## 상태

**구현 완료.** tsc/eslint 클린. 실제 화면에서의 최종 확인(체크 → 병합 → 데이터 마이그 목록에서 그룹
확인)은 사용자가 다음 사용 시 확인 예정.
