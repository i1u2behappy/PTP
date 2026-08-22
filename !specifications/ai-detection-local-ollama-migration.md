# 카테고리/정렬 옵션 AI 감지 — 로컬 Ollama로 이관 (2026-08-22)

## 배경

`lib/ai.ts`의 `detectCategoryLinksWithAI`(카테고리 메뉴/구조 탐지)와 `detectSortOptionsWithAI`(정렬
옵션 감지)는 원래 Gemini(`gemini-flash-latest`)를 썼다. 실사용 중(모자사러 몰) 정렬 옵션 감지가 계속
빈 결과로 실패해 여러 차례 다른 원인(DOM 구조, 동명 링크 중복)으로 착각하고 고쳤는데, 진단용 로그를
심어 확인한 진짜 원인은 **Gemini 무료 티어의 일일 호출 한도(모델당 하루 20회)를 이미 소진한 것**이었다.
실패를 전부 "조용히 빈 배열"로 삼키는 구조라 어떤 이유로 실패했는지 겉으로는 구분이 안 됐다.

## 검토한 대안과 선택

Gemini 무료 티어의 낮은 한도 문제를 근본적으로 피하기 위해 대안을 조사했다:

- **Groq**: 무료 한도가 가장 넉넉함(자료마다 하루 1,000~14,400회로 편차, 확인 필요) + OpenAI 호환.
  다만 스타트업이라 서비스 지속성/정책 변경 리스크가 있다는 사용자 우려로 보류.
- **GitHub Models**: 마이크로소프트 백엔드라 사업 지속성은 안정적이나 무료 한도가 하루 약 60회로
  Groq보다 훨씬 적고, "상업적 이용은 유료 Azure 구독 필요"라는 조건이 이 앱에 해당되는지 불명확.
- **로컬 Ollama (채택)**: 외부 서비스 자체에 의존하지 않아 사업 지속성/요금 정책/일일 한도 문제가
  구조적으로 발생할 수 없음. 사용자가 명시적으로 이 이유로 선택함. PC 사양이 이미 충분함
  (2026-08-20 PC 업그레이드로 8코어16스레드/28GB — `lib/scheduler.ts`/`ScraperPanel.tsx`의 동시성
  설정 상향과 같은 배경).

**이번에 이관한 건 이 두 함수뿐이다** — `lib/ai.ts`의 나머지 Gemini 사용처 4곳(`generateExtractionRules`,
`generateAutoExtractionRules`, `filterRealProductOptions`, `generateMallProfileReportGemini` — Anthropic
실패 시 폴백)은 이번 범위가 아니라 그대로 Gemini를 쓴다. 이 둘만 먼저 옮긴 이유: 오늘 실제로 문제가
됐고, 몰당 1회만 호출돼(카테고리 불러오기/몰 구조분석 시) 로컬 모델의 느린 속도 부담이 상대적으로
적다.

## 설치 구성 (이 PC 기준)

- Ollama 설치 위치: `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` (사용자 범위 설치, 관리자 권한 불필요)
- 서비스: 설치 시 자동으로 백그라운드 상주, `http://localhost:11434`에서 응답
- 모델: `qwen3:8b` (약 5.2GB) — Ollama 공식 문서가 도구 호출(함수 호출) 신뢰성 예시로 쓰는 모델이라
  선택. `ollama pull qwen3:8b`로 받음.
- 코드에서 base URL/모델명은 `OLLAMA_BASE_URL`(기본 `http://localhost:11434`), `OLLAMA_MODEL`(기본
  `qwen3:8b`) 환경변수로 재정의 가능(`lib/ai.ts`).

**주의**: 이 두 기능은 Ollama가 이 PC에서 떠 있어야만 동작한다. Ollama 서비스가 꺼져 있으면
`pickIndicesWithOllama`가 조용히 빈 배열을 반환해(호출부가 기존 히스틱/미검출로 자연 폴백) 기능
자체가 막히진 않지만, "카테고리를 못 찾는다"/"정렬을 못 찾는다"처럼 보일 수 있다 — 이땐 먼저 Ollama가
실행 중인지 확인할 것.

## 구현 세부사항 (`lib/ai.ts`)

- `pickIndicesWithOllama(prompt, toolName, toolDescription)`: 두 함수가 공유하는 헬퍼. Ollama의
  `/api/chat`에 `tools`(OpenAI 호환 함수 호출 스키마) + `think:false`를 실어 호출하고,
  `message.tool_calls[0].function.arguments.indices`만 뽑아 반환한다. 실패하면(Ollama 미실행, 응답
  형식 다름 등) 조용히 빈 배열.
- **`think:false` 필수**: qwen3는 기본이 "추론 모델"이라 답하기 전에 내부 사고 과정을 전부 토큰으로
  생성한다. 실측: 4항목짜리 아주 작은 후보 목록에서도 thinking 켠 채로 **258초**, 꺼서 **8초** — 32배
  차이. 실제 몰(72개 후보) 기준으로는 약 **77초** 걸린다(Gemini보다 느리지만 몰 구조분석 시 1회만
  실행되므로 감당 가능한 수준으로 판단).
- **동명 링크 오판 방지**: 텍스트가 같은 링크가 여러 개인데 그중 하나만 진짜 정렬/카테고리 링크이고
  나머지는 전혀 다른 곳으로 가는 경우(예: 모자사러의 "신상품"이 정렬 링크 하나, 완전히 다른 카테고리로
  가는 메뉴 링크 하나로 중복 존재), qwen3(think:false)가 Gemini보다 이 구분을 못해 엉뚱한 쪽을 고르는
  사례를 실사용으로 확인. `detectSortOptionsWithAI`에 `baseUrl` 파라미터를 추가해 프롬프트에 "지금
  보고 있는 목록을 유지한 채 순서만 바꾸는 링크만 정렬"이라는 판단 기준을 명시해 보강함. 완전히
  해결됐는지는 몰마다 다를 수 있어 계속 지켜볼 필요 있음.
- 정렬 옵션 라벨은 표준 라벨(기본순/최신순 등)로 정규화하지 않고 몰이 실제 쓰는 원문 그대로 노출한다
  (같은 날 별도로 결정된 사항 — `!specifications/scrape-preview-catalog-count-and-target-ui.md` 등
  다른 문서와 달리 이 결정 자체는 이 문서에만 기록됨). 표준 라벨 집합으로는 몰마다 제각각인 정렬
  기준(상품명순/제조사순/리뷰순 등)을 다 담을 수 없다는 게 실사용으로 확인됐기 때문.

## 관련 파일

- `lib/ai.ts`: `OLLAMA_BASE_URL`/`OLLAMA_MODEL` 상수, `pickIndicesWithOllama`, `detectCategoryLinksWithAI`,
  `detectSortOptionsWithAI`
- `lib/scraper.ts`: `detectSortOptionsWithAI` 호출부(일반모드, `sampleMallProfile`) — `baseUrl`을
  호출 전에 계산해 전달하도록 순서 조정
- `app/api/sites/[id]/sort-options/route.ts`: `detectSortOptionsWithAI` 호출부(개발자모드 확장 경유)
- `scripts/generate-extension-icons.mjs`, `scripts/make-logo-transparent.mjs`: 이번 세션에서 같이
  추가된 별개 1회성 유틸 스크립트(확장 아이콘 생성, 로고 배경 투명화) — AI 이관과는 무관하지만 같은
  세션에서 커밋됨.
