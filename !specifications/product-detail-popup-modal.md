# 상품/상품마스터 상세를 탭 대신 팝업으로 열기

## 배경

"스크랩 Raw 확인" 그리드 등에서 상품 상세를 열면, 새 탭이 뜨는 게 아니라 **지금 보고 있던 탭 자체가**
상품 상세로 바뀌치기됐다(`openTab({ id: activeTabId, type: 'product-detail', ... })` — 같은 탭 id를
재사용). 그러면 방금까지 "스크랩 Raw 확인" 같은 메뉴 이름이던 하단 탭이 갑자기 상품명으로 바뀌어 보여,
사용자가 "메뉴도 아닌 게 메뉴 자리에 떠 있다"고 오인했다(실사용 확인, 2026-08-13).

## 수정

상품 상세(`product-detail`)와 상품마스터 상세(`master-detail`)를 탭 시스템에서 완전히 분리해, 지금 탭을
건드리지 않는 팝업으로 띄운다.

- `components/shell/TabsContext.tsx`: `TabType`에서 `'product-detail'`/`'master-detail'`을 제거하고,
  `detailModal`(현재 열린 팝업 상태) + `openDetailModal(type, params)` + `closeDetailModal()`을 새로
  추가.
- `components/shell/DetailModal.tsx`(신규): `detailModal` 상태에 따라 `ProductDetailPanel`/
  `MasterDetailPanel`을 배경 딤 처리 + 중앙 팝업으로 렌더링. `AppShell.tsx`에 한 번만 마운트해 어떤
  탭이 활성화돼 있어도 항상 그 위에 뜬다.
- `components/shell/Workspace.tsx`: 이제 탭으로 열리지 않는 두 타입의 switch case를 제거.
- 상세를 열던 6곳(`StagingItemsGrid`, `MasterListPanel`, `ProductDetailPanel`, `MasterDetailPanel`,
  `ContinuousMigrationPanel`, `InternalCodePanel`)을 전부 `openDetailModal(...)` 호출로 교체.
- `MasterDetailPanel`의 "← 목록" 버튼(`backToList`)은 이제 팝업을 닫는 동작(`closeDetailModal`)으로,
  상품↔상품마스터 상세 사이를 오가는 버튼(`openProductDetail`)은 팝업 내용만 교체하는 동작으로 바뀜.

## 상태

**구현 완료.** tsc/eslint 클린.
