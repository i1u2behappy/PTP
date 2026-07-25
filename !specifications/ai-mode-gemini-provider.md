# AI모드 스크래핑 전용 Gemini 전환

## 배경
Anthropic API 크레딧을 충전하지 않기로 결정 — "다른 AI를 붙여서라도 구현할 수 있는 방법을 찾아달라"는
요청. 처음엔 `lib/ai.ts` 전체를 교체하려 했으나, **정확히는 "스크래핑을 위한 AI모드"만 Gemini로 바꾸고
나머지 AI 기능은 그대로 Anthropic을 쓰는 것**으로 범위를 좁혔다(사용자가 명시적으로 확정 — Claude Code
자체를 바꾸는 게 아니냐는 오해도 있었음, 별개임을 확인).

## 범위
- **Gemini로 전환**: `generateAutoExtractionRules`(신규, AI모드의 규칙 자동생성), `filterRealProductOptions`
  (옵션 진위 판별)
- **그대로 Anthropic 유지**: `generateExtractionRules`("스크랩 조정", 사용자 지적 기반), `generateProductName`
  (상품명 생성), `generateTransformColumns`(Transform), `generateMallProfileReport`("몰 구조 파악"),
  `extractProductFieldsWithAI`(스크랩 최종 폴백)

기존엔 `generateExtractionRules`가 `userPrompt` 빈 문자열 여부로 "스크랩 조정"/"AI모드" 두 용도를 겸했는데,
이제 두 용도가 서로 다른 AI 제공자를 쓰게 되어 겸용이 더 이상 말이 안 돼 분리했다 — `generateExtractionRules`는
원래대로 "스크랩 조정" 전용(Anthropic, `userPrompt` 필수)으로 되돌리고, AI모드 자동분석은 신규
`generateAutoExtractionRules`(Gemini)로 완전히 독립.

## 구성
- 패키지: `@google/genai`(공식 Node SDK) 설치. 스크립트 승인(`npm approve-scripts`) 없이도 정상 로드
  확인됨 — 건드릴 필요 없었음.
- `lib/ai.ts`에 `getGeminiClient()`(`GEMINI_API_KEY` 사용, 매 호출마다 새로 생성 — 기존 Anthropic
  `getClient()`와 동일 패턴) + `GEMINI_MODEL = 'gemini-2.5-flash'` 추가.
- Gemini function-calling(tool use) 패턴: `ai.models.generateContent({model, contents, config: {tools:
  [{functionDeclarations:[...]}], toolConfig: {functionCallingConfig: {mode: FunctionCallingConfigMode.ANY,
  allowedFunctionNames:[...]}}}})` → 결과는 `response.functionCalls[0].args`. 스키마는 Anthropic의 raw
  JSON-schema 문자열(`type:'object'`) 대신 Gemini 전용 `Type` enum(`Type.OBJECT`/`Type.STRING`/...)으로
  작성해야 한다(SDK 공식 샘플로 확인 — README의 `parametersJsonSchema` 예시와 실제 코드 샘플의 `parameters`+
  `Type` enum 방식이 달라서, 실제 동작하는 쪽인 후자를 채택).
- `.env.local`에 `GEMINI_API_KEY` 추가(현재는 보류 상태라 빈 값 — 아래 "알려진 문제" 참고).

## 실사용 중 발견한 진짜 문제 — Windows 환경변수 우선순위
`.env.local`에 뭘 넣어도 계속 같은 값으로 덮어써지는 현상을 겪음 — 원인은 **이 PC에 이미 Windows 사용자
환경변수로 `GEMINI_API_KEY`가 설정되어 있었고(값: `AIzaSy-AIzaSyCFVKOeVwAMFbz862gfymibCNZKC4b4I4k`, 앞에
`AIzaSy-`가 잘못 붙은 47자 손상값)**, Node.js/Next.js의 dotenv류 로딩은 이미 존재하는 OS 프로세스
환경변수를 `.env.local`보다 우선시해서 덮어쓰지 않기 때문. `[System.Environment]::SetEnvironmentVariable(
"GEMINI_API_KEY", "<값>", "User")`로 고쳤다(사용자 확인 후 진행 — 시스템 설정 변경이라 먼저 물어봄).
**교훈**: 이 프로젝트에서 API 키 관련 env 문제가 재발하면 `.env.local`만 보지 말고
`[System.Environment]::GetEnvironmentVariable("<KEY>", "User")`로 OS 레벨 값도 반드시 확인할 것.

## 알려진 문제 — 미해결, Google 쪽 버그 (2026-07-26 기준 보류)
이 Google 계정은 Google AI Studio에서 새 API 키를 만들 때마다 **`AQ.` 형식**(예: `AQ.Ab8RN6...`)만
발급되는데, 이 형식은 **실제 Generative Language REST API(`generativelanguage.googleapis.com`, 우리가
쓰는 그 API)와 호환되지 않는다** — 공식 포럼(discuss.ai.google.dev)에 구글 담당자가 직접 "AIza에서 AQ로
전환 중"이라고 확인한 글이 있고, 기술적 해결책 없이 "피드백 폼에 제출"만 안내됨. 여러 사용자가 같은 문제로
"AIza 키 복원"을 요청 중.

- `AQ.` 키로 REST 호출 시: `401 UNAUTHENTICATED / ACCESS_TOKEN_TYPE_UNSUPPORTED` ("Expected OAuth 2
  access token...")
- (참고로 시도했던) 손상된 Windows env var 정정값 `AIzaSy...4b4I4k`로 호출 시: `400 INVALID_ARGUMENT /
  API_KEY_INVALID` — 이건 AQ 문제와 무관하게 그 키 자체가 유효하지 않았던 것으로 보임(출처 불명, 아마
  예전 다른 도구 설정의 잔재).
- SDK 버그 여부는 raw REST(`curl`)로 동일하게 재현해 완전히 배제함.

**사용자 결정: 일단 보류.** `.env.local`의 `GEMINI_API_KEY`를 빈 값으로 둠 — `generateAutoExtractionRules`/
`filterRealProductOptions` 둘 다 `!process.env.GEMINI_API_KEY` 가드로 즉시 조용히 스킵(불필요한 실패
API 호출도 안 함), AI모드는 기존 규칙 기반 결과만 그대로 쓰는 상태로 정상 동작한다.

**재개 시 확인할 것**: (1) 다른 Google 계정으로 발급 시도(이 문제가 계정별로 다르게 나타남 — 새 계정은
AIza가 나올 수도 있음), (2) Google Cloud Console(console.cloud.google.com/apis/credentials)에서 직접
발급하면 다른 경로라 AIza가 나올 가능성(미검증), (3) 또는 Groq API 등 이 문제와 무관한 다른 제공자로 전환.
