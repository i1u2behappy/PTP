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
- `.env.local`에 `GEMINI_API_KEY` 추가.
- 모델명은 `gemini-flash-latest`(별칭) — `gemini-2.5-flash`는 신규 사용자에게 더는 제공 안 됨을 실제
  API 호출로 확인하고 교체(`404 This model ... is no longer available to new users`).

## 최종 상태: 정상 동작 확인 (2026-07-26)
`generateAutoExtractionRules`/`filterRealProductOptions` 둘 다 실제 키로 end-to-end 검증 완료. 도매의신
실제 원문으로 테스트한 결과, `name`이 `<title>`이 아니라 "품명" 라벨을 정확히 골랐고, `price`/`manufacturer`/
`origin`도 정확한 라벨 정규식을 만들었으며, `shipping_fee`처럼 값이 다른 텍스트와 뭉쳐 깨끗이 못 뽑는
필드는 설계대로 억지로 만들지 않고 비워뒀다.

## 디버깅 중 겪은 두 가지 함정 (둘 다 코드 문제 아니었음)

**1. Windows 사용자 환경변수가 `.env.local`보다 우선한다.** `.env.local`에 뭘 넣어도 계속 같은(손상된)
값으로 덮어써지는 현상을 겪음 — 이 PC에 이미 Windows 사용자 환경변수로 `GEMINI_API_KEY`가 설정되어
있었고(값: `AIzaSy-AIzaSyCFVKOeVwAMFbz862gfymibCNZKC4b4I4k`, 앞에 `AIzaSy-`가 잘못 붙은 47자 손상값),
Node.js/Next.js의 dotenv류 로딩은 이미 존재하는 OS 프로세스 환경변수를 `.env.local`보다 우선시해서
덮어쓰지 않기 때문. `[System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<값>", "User")`로
고쳤다(사용자 확인 후 진행 — 시스템 설정 변경이라 먼저 물어봄).

**2. 이미 실행 중인 Bash 세션은 레지스트리 변경을 반영하지 못한다.** 위 1번을 고친 뒤에도 계속 같은 옛날
값이 나와서 다시 혼란스러웠는데, 원인은 이 세션 내내 써온 Bash 셸 프로세스 자체가 애초에 시작될 때의
환경변수 스냅샷을 그대로 물고 있어서(레지스트리를 나중에 고쳐도 이미 떠 있는 프로세스엔 반영 안 됨),
그 Bash에서 `npm run dev &`로 띄우는 서버도 계속 옛날 값을 상속받았던 것. **해결**: PowerShell에서
`$env:GEMINI_API_KEY = "<새 값>"`을 그 세션에 직접 설정한 뒤 그 세션에서 서버를 띄워야 새 값이 반영된다.
**교훈**: 이 프로젝트에서 API 키 관련 env 문제가 재발하면 (a) `.env.local`뿐 아니라
`[System.Environment]::GetEnvironmentVariable("<KEY>", "User")`로 OS 레벨 값도 확인하고, (b) 그 값을
고친 뒤에는 반드시 PowerShell에서 `$env:` 로 명시적으로 설정한 세션에서 서버를 재시작할 것 — 기존에 떠
있던 Bash 세션에서 그냥 재시작하면 계속 옛날 값을 쓴다. 디버그 라우트로 `process.env.GEMINI_API_KEY`의
길이/앞뒤 몇 글자를 직접 찍어봐야 확실히 구분된다(추측하지 말 것).

## 정정: "AQ. 형식 키는 구글 쪽 버그로 근본적으로 안 된다"는 이전 결론은 틀렸음
디버깅 초반에 여러 `AQ.` 키가 계속 실패해서 "AQ 형식이 REST API와 근본적으로 미호환"이라고 결론 내리고
공식 포럼 글까지 근거로 들었으나, 이는 **성급한 결론이었다**. 실제로는:
- 실패했던 시도 대부분이 위 두 함정(손상된 Windows env var, 레지스트리 변경 미반영) 때문에 애초에
  올바른 키를 테스트하고 있지 않았다.
- raw curl로 직접 테스트했던 특정 키(`...sEcA`, AI Studio에 처음 나열됐던 그 키)는 실제로 실패했는데,
  이건 AQ 형식 자체의 문제가 아니라 그 키 개별의 제한사항 설정 문제였을 가능성이 높다(사용자가 "제한사항
  추가" 중 애플리케이션 제한을 잘못 설정했을 수 있음 — 확인은 안 함).
- 사용자가 마지막으로 새로 발급한 키(`AQ.Ab8RN6IK...ybao8FA`)는 x-goog-api-key 헤더, `?key=` 쿼리
  파라미터, SDK 세 가지 방식 모두에서 정상 작동을 raw curl과 실제 함수 호출로 전부 확인했다.
- **결론**: `AQ.` 형식 자체는 정상 작동하는 유효한 키 형식이다. 개별 키가 실패하면 형식을 의심하기 전에
  먼저 (1) env 캐싱 문제, (2) 그 키의 제한사항 설정을 확인할 것.
