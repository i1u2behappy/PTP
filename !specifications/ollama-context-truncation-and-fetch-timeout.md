# "AI 호출 실패"의 진짜 원인 — Ollama 컨텍스트 조용한 잘림 + Node fetch 300초 한도

## 증상 (2026-09-13, 투비즈온)

"몰 구조분석" 완료 후 화면에 `⚠ AI 호출 실패 — 이전 리포트 표시 중 · 12분 32초(AI 5분 2초)`.
워커 로그에는 `"AI로 결제/배송/업체정보 분석 중..." — 302.5초`만 있고 **실패 이유가 한 줄도 없었다.**

## 원인 — 셋이 겹쳐 있었다 (전부 실측 확인)

### ① 켜진 AI 공급자가 Ollama 하나뿐 → 폴백 없음

`ai_provider_config` 테이블에 `["ollama"]`만 저장돼 있었다(화면에서 사용자가 선택). 공급자 순서는
Anthropic → Gemini → Groq → Ollama인데 앞의 셋이 꺼져 있으니, Ollama가 실패하는 순간 곧장 규칙 기반
리포트로 떨어진다. `.env.local`에는 Anthropic/Gemini/Groq 키가 전부 들어 있다(즉 끄지 않았다면 폴백이
동작했을 상황).

### ② Ollama가 num_ctx를 넘는 입력을 **에러 없이 앞에서부터 잘라** 넣는다 ← 실제 실패 원인

`lib/ai.ts`의 Ollama 호출 5곳 중 어디에도 `options.num_ctx`가 없었다 → 기본값 4096 토큰.
반면 `buildMallReportPrompt`는 수집 원문을 최대 20,000자까지 넣는다.

실측(qwen3:14b, 이 PC):

| 조건 | 처리된 입력 토큰 | 도구 호출 | 소요 |
| --- | --- | --- | --- |
| 2,000자 / num_ctx 미지정 | 1,697 | O (7/12 채움) | 121.9초 |
| **18,000자 / num_ctx 미지정** | **2,050** | **X — 본문 요약 텍스트로 답함** | 131.6초 |
| 18,000자 / num_ctx 16384 | — | — | 305초에 ②로 실패 |
| 5,000자 / num_ctx 8192 | 3,347 | O (7/12 채움) | 205.6초 |

18,000자(약 9,000토큰)를 보냈는데 실제 처리된 입력이 2,050토큰이라는 건 **앞부분이 통째로 잘렸다**는
뜻이다. 그 앞부분에 지시문과 "set_mall_report 도구로 답하라"가 들어있으니, 모델은 남은 꼬리(수집 원문)만
보고 그걸 요약하는 일반 텍스트로 답한다 → `tool_calls` 없음 → 호출부는 `null` → 화면엔 "AI 호출 실패".

**주의: 이건 이 파일이 이미 한 번 잘못 진단했던 현상이다.** `OLLAMA_MAX_CANDIDATES`(60) 주석은
"CPU 전용 모델이 긴 프롬프트를 못 감당해 도구 호출 대신 텍스트로 샌다"고 적어뒀는데, 증상이 이번과
똑같다 — 후보 수를 줄인 것이 효과가 있었던 이유도 "모델 실력"이 아니라 결과적으로 프롬프트를 4096
컨텍스트 안에 도로 집어넣었기 때문으로 보인다.

### ③ Node fetch(undici)의 300초 한도가 우리가 준 480초를 덮어쓴다

`MALL_REPORT_OLLAMA_TIMEOUT_MS = 480_000`(8분)인데, Ollama 호출은 `stream:false`라 생성이 전부 끝날
때까지 헤더가 오지 않는다. undici의 기본 `headersTimeout`/`bodyTimeout`이 각각 300초라, 5분을 넘기는
생성은 우리 타임아웃과 무관하게 `TypeError: fetch failed`로 끊긴다 — **305.1초 / 304.8초로 두 번 재현.**
`lib/workerClient.ts`가 2026-08-23에 겪고 고친 것과 **똑같은 함정**인데(그 파일 주석에 상세히 기록돼
있다) Ollama 호출들엔 적용돼 있지 않았다.

### 왜 진단에 오래 걸렸나

`generateMallProfileReport`는 공급자 실패를 `p.fn().catch(() => null)`로, Ollama 함수는 실패 경로 넷
(HTTP 오류 / 도구 호출 없음 / 인자 파싱 실패 / 예외)을 전부 `return null`로 삼켰다. 화면은 "실패"만
알고, 로그에는 아무것도 안 남는다.

## 수정

- **`num_ctx` 명시**(`OLLAMA_NUM_CTX`, 기본 8192, env로 조정 가능) — Ollama 호출 5곳 전부에
  `options: OLLAMA_CHAT_OPTIONS`로 공통 적용(텍스트 2곳 + 비전 3곳). 새 호출을 추가할 때 빠뜨리지
  않도록 상수 하나로 모아뒀다.
- **프롬프트 상한**(`OLLAMA_PROMPT_CHAR_LIMIT`, 기본 6,000자)과 `fitOllamaPrompt()` — 자를 거면
  **우리가 뒤쪽(수집 원문)을 자르고 그 사실을 로그에 남긴다.** Ollama의 기본 잘림은 정확히 반대로
  앞(지시문·도구 설명)을 버려 도구 호출 자체를 없앤다. 8192 컨텍스트에 6,000자(약 4,000토큰) +
  도구 스키마 + 출력이 들어간다. Groq의 `GROQ_CONTEXT_CHAR_LIMIT`(5,000)와 같은 취지.
- **undici dispatcher**(`ollamaDispatcher`, headersTimeout/bodyTimeout 0) — 480초 예산이 실제로
  유효해진다. 중단은 각 호출의 `AbortSignal`이 계속 책임진다.
- **실패 이유 로깅** — 공급자별(`[AI:<provider>] 몰 구조분석 리포트 실패 — …`)로 남기고, Ollama는 네
  경로를 구분해 기록한다(도구 호출이 없으면 처리된 입력 토큰 수와 답변 앞부분까지 같이 남겨, 이번과
  같은 잘림을 한눈에 알아볼 수 있게).

## 검증

- `tsc` / `lint` / 단위테스트 277개(신규 `tests/unit/ollamaPrompt.test.ts` 4개 포함) 통과.
- **실제 코드 경로로 확인**: Ollama만 켠 채 `generateMallProfileReport`를 23,763자 원문으로 호출 →
  `[AI:ollama] 몰 구조분석 리포트: 프롬프트 21496자 → 6000자로 줄임` 로그 후 **리포트 정상 생성**
  (generatedBy=ollama, 12개 중 9개 항목을 실제 값으로 채움 — 계좌번호/은행명/연락처/반품주소/택배사/
  정렬구조 전부 정확), 297.6초.

## 남는 사실 / 운영 판단거리

- **이 PC의 Ollama는 느리다** — 2,000자짜리 짧은 프롬프트도 121.9초, 실제 리포트는 약 5분. 수정 후에도
  "몰 구조분석" 총 시간에 5분 안팎이 그대로 얹힌다.
- 품질도 컨텍스트 6,000자에 맞춰 줄어든 원문 기준이다(Anthropic/Gemini는 20,000자를 다 본다).
  Groq가 5,000자 제한으로 "완전한 대안이 아니라 중간 단계"인 것과 같은 성격.
- 따라서 리포트 품질/속도를 원하면 화면에서 **Groq(무료, 키 이미 있음)를 같이 체크**하는 게 실질적인
  개선이다 — 순서상 Groq가 먼저 시도되고, 실패하면 Ollama가 그대로 폴백으로 남는다.
- `OLLAMA_NUM_CTX`를 16384로 올리는 건 이 PC에서 권하지 않는다(모델 적재 9.6GB→11.8GB, 생성이 5분을
  넘겨 오히려 실패했다). 컨텍스트를 키우는 것보다 프롬프트를 줄이는 쪽이 이 하드웨어에선 맞다.

## 관련 파일

- `lib/ai.ts`: `OLLAMA_NUM_CTX` / `OLLAMA_PROMPT_CHAR_LIMIT` / `fitOllamaPrompt` / `ollamaDispatcher` /
  `OLLAMA_CHAT_OPTIONS`(신규), Ollama 호출 5곳, `generateMallProfileReport`·
  `generateMallProfileReportOllama` 실패 로깅
- `tests/unit/ollamaPrompt.test.ts`(신규)
- `lib/workerClient.ts`: 같은 undici 300초 함정을 2026-08-23에 이미 겪은 기록(참고)
