# 스크랩 Raw 그리드 — 옵션 컬럼 고정 위치 & 엑셀 다운로드 WYSIWYG — 요구사항 기록

## 배경

`StagingItemsGrid`(수집확인/마이그레이션 목록 등에서 공용으로 쓰는 스크랩 세션 상세 그리드)는 컬럼을
드래그로 재배치할 수 있고, 엑셀 다운로드 버튼도 있다. 엑셀 다운로드는 원래 서버(`/api/scrape-staging/export`)가
그리드와 무관하게 자기만의 고정 컬럼 목록으로 DB를 다시 조회해서 만들고 있었다 — 옵션1/옵션2 분리, 카테고리
위치, 상품요약정보/영문상품명/상세페이지텍스트 등 raw_data 파생 컬럼이 전혀 반영 안 돼 있어 화면과 다운로드
내용이 크게 어긋났다.

## 요구사항 (사용자 지시 원문 기준)

> 그리드 컬럼에 옵션1, 옵션2 등의 옵션정보는 항상 상세이미지 컬럼 뒤로 배치해줘. 그리고 엑셀다운로드 시
> 내용이 다른데 그리드에 보이는 내용 그대로 다운로드 되게 고쳐

## 구현된 설계 결정

- **옵션 컬럼 고정 위치**: 컬럼 순서는 여전히 `colOrder`(localStorage 저장, 드래그로 변경 가능)로 관리하되,
  렌더링 직전에 `orderedColumns`를 계산할 때 `option_${i}` 키를 전부 골라내 `detail_image_urls`(상세이미지)
  컬럼 바로 뒤에 다시 끼워 넣는다. 즉 사용자가 옵션 컬럼을 다른 곳으로 드래그해도 다음 렌더에서 항상
  상세이미지 뒤로 돌아온다 — "항상" 요구사항을 컬럼 순서 저장 로직을 건드리지 않고 표시 시점에 강제하는
  방식으로 구현.
- **엑셀 = 그리드 그대로(WYSIWYG)**: 서버가 별도로 컬럼을 구성하는 대신, 클라이언트가 이미 갖고 있는
  `orderedColumns`(현재 컬럼 순서)와 `visibleItems`(현재 필터/정렬이 적용된 결과)를 그대로
  `{ headers, rows }` JSON으로 만들어 서버에 POST한다. 각 셀 값은 화면 렌더링과 같은 `ColumnDef.getValue()`
  함수로 계산하므로(단, 이미지 링크 리스트나 "열기 ↗" 같은 화면 전용 JSX 대신 그 밑에 있는 실제 데이터 값),
  필터링/검색에 쓰는 텍스트와 동일한 값이 엑셀에도 그대로 들어간다. 서버(`export/route.ts`)는 더 이상
  DB를 조회하지 않고 받은 headers/rows를 엑셀로 변환하는 것과 파일명용 몰 이름 조회만 담당 — 컬럼 구성에
  대한 유일한 소스는 그리드 컴포넌트 하나가 된다.
- **API 변경**: `GET /api/scrape-staging/export?sessionId=` → `POST` (같은 쿼리스트링의 sessionId + JSON
  바디의 headers/rows). 기존 GET의 고정 HEADERS 상수와 DB 조회 로직은 제거.

## 관련 파일

- `components/panels/shared/StagingItemsGrid.tsx`: `orderedColumns` 옵션 강제 재배치, `handleExport`가
  `orderedColumns`/`visibleItems`로 payload 구성
- `app/api/scrape-staging/export/route.ts`: POST로 변경, headers/rows를 그대로 엑셀 변환

## 상태

**구현 완료 (2026-07-17).** 커밋: `4a88b63`. `tsc --noEmit` 통과, export 라우트 curl로 실제 xlsx 생성 확인.
브라우저에서 실제로 컬럼 드래그 후 다운로드해 화면과 파일 내용이 일치하는지는 사용자가 직접 확인 예정.
