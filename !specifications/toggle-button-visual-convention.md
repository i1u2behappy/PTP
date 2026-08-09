# 보조 기능(켜짐/꺼짐) 토글 버튼 vs 주 액션 버튼 — 모양으로 구분

## 배경

"동시 처리 수동"/"AI모드 켜짐" 같은 on/off 설정 버튼이 "🔍 스크랩 미리보기" 같은 클릭 한 번짜리 주
액션 버튼과 똑같은 `rounded-full`(알약) 모양이라, 클릭하면 바로 무슨 일이 벌어지는 버튼인지 그냥
상태를 켜고 끄는 설정인지 모양만으로 구분이 안 된다는 지적(2026-08-09).

## 조사 — 전수 조사 결과

boolean 상태에 따라 색이 필/테두리 방식으로 바뀌는 "체크박스형 버튼"을 `components/panels/**`,
`components/shell/**` 전체에서 찾은 결과, 아래 8곳(3가지 패턴, `ScraperPanel.tsx`에 3개 몰려있음)이
전부였다. `aria-pressed` 속성은 이 파일들 밖에는 전혀 없었다.

| 파일 | 컨트롤 |
|---|---|
| `components/panels/ScraperPanel.tsx` | AI모드 켜짐/꺼짐, 동시 처리 자동/수동, 필터 보이기(`siteShowFilters`) |
| `components/panels/ClientsListPanel.tsx` | 필터 보이기 |
| `components/panels/SitesListPanel.tsx` | 필터 보이기 |
| `components/panels/shared/ScrapeSessionGrid.tsx` | 필터 보이기 |
| `components/panels/shared/StagingItemsGrid.tsx` | 필터 보이기 |

**제외한 것들**(겉보기엔 비슷하지만 이 패턴이 아님): 접기/펼치기(▲/▼) 버튼들은 배경색이 절대 안
바뀌고(항상 `bg-gray-100`) 텍스트/화살표만 바뀌는 방식이라 애초에 "필/테두리로 상태를 보여주는"
패턴이 아니다 — 그대로 뒀다. 3단 모드 선택기(`manualLoginRequired` null/false/true 등)나 다중 선택
컬럼 하이라이트도 on/off 설정이 아니라 여러 선택지 중 하나를 고르는 방식이라 제외.

## 수정 — 모양·크기·색 3가지를 한 번에

**모양**: `rounded-full`(알약, 주 액션 버튼과 동일) → **`rounded-md`**(각진 사각형에 가까운 "체크박스형
스위치")로 8곳 전부 통일. 주 액션 버튼(`rounded-full`)/큰 CTA(`rounded-2xl`)와 형태부터 겹치지 않게 한다.

**크기(위아래 폭)**: 세로 패딩을 한 단계씩 줄였다 — AI모드/동시처리(`py-2`) → `py-1`, 대부분의 필터
토글(`py-1`) → `py-0.5`, `StagingItemsGrid`의 필터(`py-1.5`) → `py-1`. 동시처리 토글 옆의 숫자 입력칸도
같이 `py-1`로 줄여 높이를 맞췄다.

**색(파스텔화)**: OFF 상태는 이미 중립(백색/회색)이라 그대로 두고, ON 상태만 진한 단색(`bg-violet-600
text-white`, `bg-amber-600 text-white`, `bg-teal-500 text-white`)에서 옅은 톤(`bg-violet-100
text-violet-700`, `bg-amber-100 text-amber-700`, `bg-teal-100 text-teal-700`)으로 바꿨다 — 색 자체도
주 액션 버튼(진한 단색 채움)과 다른 카테고리라는 걸 보여준다.

## 관련 파일

- `components/panels/ScraperPanel.tsx`(토글 3개), `ClientsListPanel.tsx`, `SitesListPanel.tsx`,
  `shared/ScrapeSessionGrid.tsx`, `shared/StagingItemsGrid.tsx`(각 필터 토글 1개) — 클래스만 수정,
  클릭 핸들러/상태 로직은 그대로.

## 향후 개발 시 참고

새로운 on/off 설정 버튼을 추가할 때는 이 8곳과 같은 패턴(`rounded-md`, 세로 패딩 `py-0.5`~`py-1`,
ON 상태는 옅은 톤 `bg-{color}-100 text-{color}-700`)을 따른다 — `rounded-full`은 클릭하면 즉시
동작이 실행되는 주 액션 버튼 전용으로 남겨둔다.

## 상태

**구현 완료.** tsc/eslint 클린(`StagingItemsGrid.tsx`의 기존 무관 경고 1건 제외).
