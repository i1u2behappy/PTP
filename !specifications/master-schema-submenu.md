# 마이그레이션 하위 메뉴 — "기준 Master 테이블 관리" 신설

## 배경 / 요구사항 (사용자 지시 원문 기준, 2026-07-18)

> 마이그레이션 하위 메뉴 첫번째에 '기준 Master 테이블 관리' 메뉴를 하나 만들어. 이 메뉴는 '기준 마스터
> 샘플 파일'을 내가 기초로 등록을 할 거야. 이 기준 마스터 테이블의 컬럼들을 내가 1차적으로 작성 작업을
> 할 것이고, 각 컬럼별 마이그 기준을 설정할 수 있게 메뉴를 만들어줘

AskUserQuestion으로 "각 컬럼별 마이그 기준 설정"의 범위를 확인: **스키마(컬럼 목록) 관리만 이 화면이
담당** — 컬럼별 실제 마이그레이션 방식(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라
기존 마이그레이션2_Transform에서 몰을 고른 뒤 설정하고, 이 화면에는 그리로 가는 링크만 둔다(추천안 채택).

기존에 "기준 Master DB" 스키마 관리(엑셀 업로드 → 헤더 자동매칭 → 편집 → 저장)는 이미 구현돼 있었지만
`ClientDetailPanel`(거래처 상세) 안의 카드 하나로만 존재해 마이그레이션 메뉴 흐름과 분리돼 있었다. 이번
작업은 그 기능을 마이그레이션 메뉴의 첫 번째 진입점으로 승격한 것 — 백엔드(`/api/master/schema`,
`/api/master/schema/upload`, `lib/master/schema.ts`)는 전부 기존 그대로 재사용, 신규 백엔드 코드 없음.

## 구현

- 새 탭 타입 `'master-schema'`(`components/shell/TabsContext.tsx`), `Workspace.tsx`에 라우팅 추가.
- 새 컴포넌트 `components/panels/MasterSchemaPanel.tsx` — 거래처 선택 → 엑셀 업로드/필드 목록 편집(라벨/
  필드키/고정·커스텀/삭제)/저장. `ClientDetailPanel.tsx`에 있던 것과 동일한 UI·핸들러를 이 화면으로 이전.
  하단에 "마이그레이션2_Transform에서 설정하기" 링크(클릭 시 `clientId`를 params로 넘겨 Transform의
  거래처 필터를 미리 채움 — `TransformPanel`이 `params?.clientId`를 받도록 소폭 확장).
- `ClientDetailPanel.tsx`의 "기준 Master DB" 카드 제거, 대신 이 새 메뉴로 이동하는 링크 버튼으로 교체
  (같은 로직을 두 곳에 중복 유지하지 않기 위함).
- `Sidebar.tsx`: 마이그레이션 NavGroup의 **첫 번째** 하위 항목으로 추가(판매관리코드 관리보다 위).
  같은 파일에서, 이전부터 있던 마이그레이션 NavGroup 자체의 폰트 크기 불일치(다른 하위 메뉴는 `text-sm`인데
  그룹 라벨만 `text-xs`)도 함께 수정(`text-sm`으로 통일) — 사용자가 "마이그레이션 메뉴바의 폰트가 작다"고
  지적한 별개 요청.

## 엣지 케이스

동일 클라이언트-스키마-Transform 연동의 엣지 케이스는 기존 [[custom-fields-transform-bulk-reapply]] 문서
참고(이번 작업은 새 화면만 추가했을 뿐 그 뒤 로직은 손대지 않음).

## 검증

`tsc --noEmit`, 변경 파일 `eslint` 통과(이 새 파일의 `useEffect(() => { loadFields() }, [loadFields])`
패턴은 `SalesCodePanel.tsx` 등 다른 마이그레이션 하위 메뉴와 동일하게 이미 존재하는 pre-existing
`set-state-in-effect` lint 패턴 — 이번에 새로 만든 문제가 아니라 기존 코드 스타일을 그대로 따른 것).
`/api/master/schema?clientId=` 실제 호출로 응답 확인.

## 관련 파일

**신규**: `components/panels/MasterSchemaPanel.tsx`

**수정**: `components/shell/TabsContext.tsx`, `components/shell/Workspace.tsx`, `components/shell/Sidebar.tsx`,
`components/panels/ClientDetailPanel.tsx`, `components/panels/TransformPanel.tsx`

## 상태

**완료 (2026-07-18).**
