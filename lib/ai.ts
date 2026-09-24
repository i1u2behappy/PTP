import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, FunctionCallingConfigMode, Type, type Schema } from '@google/genai'
import sharp from 'sharp'
import { Agent } from 'undici'

/** 사용자가 화면에서 체크박스로 켜고 끄는 AI 공급자(2026-09-02, 사용자 요청: "엔트로픽/제미나이/올라마
 *  체크해서 쓰게 해달라, 나중에 다른 AI도 더 붙일 수 있게"). 정의와 관문은 lib/aiProviderGate.ts에 있고
 *  여기서는 그대로 re-export만 한다 — 기존 import 경로(`from './ai'`)를 바꾸지 않기 위함.
 *
 *  **중요**: "체크한 AI만 쓴다"는 더 이상 호출부가 인자를 넘겨서 지키는 규칙이 아니다. 이 파일에서 실제로
 *  외부 AI를 호출하는 함수는 전부 isAiProviderEnabled()를 먼저 통과해야 하고, 진입점이 한 번
 *  runWithAiProviders()로 감싸면 그 아래 전체에 자동 전파된다. 새 AI 호출 함수를 추가할 때도 인자를 받을
 *  필요 없이 맨 앞에 isAiProviderEnabled() 한 줄만 넣으면 된다(자세한 배경은 aiProviderGate.ts 주석).
 *
 *  새 공급자를 추가하려면: 1) aiProviderGate.ts의 AiProviderId/ALL_AI_PROVIDERS에 id 추가, 2) 이 파일에
 *  XxxYyy(mallName, ...) 형태의 생성 함수 추가(맨 앞에 isAiProviderEnabled 가드 포함), 3)
 *  generateMallProfileReport의 providers 배열에 { id, fn } 한 줄 추가 — 그러면 이 순서가 그대로 화면
 *  체크박스 순서 및 폴백 순서가 된다. components/panels/ScraperPanel.tsx가 같은 목록을 (서버 전용 SDK를
 *  클라이언트 번들에 안 실으려고) 별도로 들고 있으니 그쪽 AI_PROVIDER_OPTIONS도 같이 맞춰야 한다. */
export type { AiProviderId } from './aiProviderGate'
export { ALL_AI_PROVIDERS, runWithAiProviders } from './aiProviderGate'
import type { AiProviderId } from './aiProviderGate'
import { ALL_AI_PROVIDERS, isAiProviderEnabled } from './aiProviderGate'

/** "몰 구조분석"이 카테고리/정렬 화면인식에 실제로 어느 공급자(Groq/로컬 Ollama)를 썼는지 화면에 보여주기
 *  위한 기록(사용자 지시, 2026-09-22 — "Groq 토큰 문제가 발생하면 로컬로 넘어가는 건데, 어느 걸 쓰고
 *  있는지 화면에 표시해줄 수 있어?"). 호출부가 배열 하나를 만들어 아래로 넘기면, 실제로 성공한 화면인식
 *  함수들이 자기 몫을 그 배열에 追加한다 — 반환 타입을 안 바꾸고도(기존 호출부를 안 건드리고도) 부가
 *  정보만 곁다리로 모을 수 있다. 카테고리/정렬처럼 한 번의 몰구조분석 안에서도 항목마다 다른 공급자가
 *  성공할 수 있어(예: 카테고리는 Groq, 정렬은 한도초과로 로컬) 단일 값이 아니라 배열로 둔다.*/
export interface VisionAttempt { task: string; provider: 'groq' | 'ollama' }

/** generateMallProfileReport가 Anthropic→Gemini→Groq→Ollama 순으로 폴백하며 실제로 시도한 각 공급자의
 *  결과 — 최종 화면 배지("AI 호출 실패"/"AI 분석 성공(이전 리포트 유지 중)")만 봐서는 "어느 공급자가 왜
 *  실패했는지"(크레딧 부족·레이트리밋·타임아웃 등)를 알 수 없다는 지적(2026-09-23)으로 기록한다.
 *  VisionAttempt와 같은 이유로 반환 타입은 안 바꾸고 호출부가 넘긴 배열에 追加하는 방식 — 이번 실행
 *  전용 신호라 DB에는 저장하지 않는다(lib/scrape/mallProfile.ts의 DB UPDATE 제외 목록 참고). */
export interface AiReportAttempt { provider: AiProviderId; model: string; elapsedMs: number; success: boolean; error?: string }

// 매 호출마다 새로 생성 — 모듈 로드 시점에 키를 고정하면 .env 값을 나중에 바꿔도
// (dev 서버가 모듈을 재평가하지 않는 한) 예전 키가 계속 쓰이는 문제가 있었다.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// 원래 "AI모드 스크래핑"(규칙 자동생성 + 옵션 판별)과 "스크랩 조정"(사용자 지적 기반 규칙 생성) 전용으로
// (Anthropic 크레딧을 충전하지 않기로 하고) 도입했다가, "몰 구조분석"도 Anthropic이 실패하면(크레딧
// 부족 등) 이 Gemini로 자동 재시도하도록 확장함(2026-07-29) — generateMallProfileReport 참고. 나머지 AI
// 기능(상품명 생성/Transform)은 여전히 Anthropic 전용.
function getGeminiClient() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
}
// 'gemini-2.5-flash'는 신규 사용자에게 더는 제공되지 않아(실제 API 호출로 확인, 2026-07-26)
// 항상 최신 flash 모델을 가리키는 별칭을 쓴다 — 특정 버전이 나중에 또 폐기돼도 코드를 안 고쳐도 된다.
const GEMINI_MODEL = 'gemini-flash-latest'


const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
// qwen3:8b는 실측 비교(2026-08-30)에서 봇차단 페이지 링크를 카테고리로 오인하는 사고를 놓쳐(이상 탐지
// 판단 작업, detectCategoryAnomalyOllama — 이후 2026-09-03에 폴백에서 아예 빠짐) 로컬에서 삭제하고
// qwen3:14b로 교체했었다. 지금 이 상수를 실제로 쓰는 곳은 pickIndicesWithOllamaOnce(후보 목록에서
// 인덱스 고르기) 하나뿐인데, 이건 그 이상 탐지 작업과 다른 종류의(더 단순한) 판단이라 8b가 거기서도
// 약했는지는 확인된 바 없다 — 새 증거 없이 되돌릴 이유가 없어 14b를 그대로 둔다. 몰 구조분석 리포트
// 생성은 아래 OLLAMA_REPORT_MODEL로 분리됐다(2026-09-23).
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b'
// "몰 구조분석 리포트"(generateMallProfileReportOllama, 12개 항목을 한 번에 채우는 무거운 생성 작업)
// 전용 — 위 OLLAMA_MODEL(14b)로는 이 작업 하나가 모델 재로드(138초)+prefill(128초)+decode(2.9토큰/초)를
// 다 합쳐도 8분(MALL_REPORT_OLLAMA_TIMEOUT_MS) 안에 못 끝내는 게 실측으로 확인됐다(2026-09-23, 시즌백
// 실사용 — TimeoutError로 매번 실패해 규칙 기반으로 떨어짐). 같은 조건(원문 길이·필드 개수)으로 8b를
// 직접 테스트해보니 235.7초 만에 성공하고 추출 내용도 정확해(사용자 지시로 재검증) 이 작업 전용으로
// 채택 — 위 OLLAMA_MODEL을 8b로 통째로 바꾸지 않는 이유는, 이상 탐지 계열 작업에서 8b가 약하다는 전례
// (바로 위 주석)가 있어 그쪽까지 같이 흔들 근거는 없기 때문이다(작업별로 강점이 다른 모델을 쓴다).
const OLLAMA_REPORT_MODEL = process.env.OLLAMA_REPORT_MODEL || 'qwen3:8b'
// 정렬 UI 화면 인식(detectSortOptionsFromScreenshot) 전용 — OLLAMA_MODEL(qwen3, 텍스트 전용)은 이미지
// 입력 자체를 못 받는다. 신규 설치(2026-09-08, 사용자 지시로 pull) — Ollama가 "does not support tools"로
// 거부해 함수 호출은 못 쓰고 텍스트로 JSON 배열만 답하게 프롬프트로 강제한다(detectSortLabelsWithOllamaVision
// 참고). CPU 전용 추론이라 느리고(7B 기준 실측 약 40초/장) 정확도도 아래 GROQ_VISION_MODEL보다 낮아
// (같은 화면에서 Groq는 6개, 이 모델은 1개만 찾음, 2026-09-08 직접 비교), Groq가 실패했을 때만 쓰는
// 안전망이다.
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:7b'
// GROQ_VISION_MODEL이 계정에서 완전히 사라져(2026-09-16 실측 — /v1/models에 비전 모델 자체가 없음, vl류
// 모델이 전부 목록에서 빠짐) 아래 모든 화면인식 함수가 사실상 이 로컬 모델 하나에 전부 의존하게 됐다.
// 60초는 원래 "Groq가 실패했을 때만 쓰는 안전망"을 전제로 잡은 값이라, 유일한 경로가 된 지금은 복잡한
// 프롬프트(예: detectVisibleCategoryHierarchy)에서 실제로 60초를 넘겨 타임아웃되는 게 확인됐다(도매신
// 실사용 확인) — 여유를 더 준다.
const OLLAMA_VISION_TIMEOUT_MS = 90_000

/** Ollama는 이 PC에서 GPU 없이 CPU로만 추론한다(`ollama ps`의 `size_vram: 0`로 확인) — CPU 연산 자체인
 *  추론은 요청이 동시에 여러 개 들어오면 서로 CPU를 나눠 쓰며 배로(경우에 따라 수십 배까지, think 모드
 *  킴/끔 32배 차이가 같은 종류의 민감성을 보여줌) 느려진다. discoverCategoryLinks의 expandWorker가
 *  카테고리를 최대 8개까지 동시에 확인하는데, 그중 상품 없는 "허브" 카테고리를 여러 개 만나면 각자
 *  detectCategoryLinksWithAI를 불러 최대 8개 요청이 한꺼번에 몰릴 수 있었다(실사용 확인, 2026-08-22 —
 *  개발자모드의 비슷한 경합을 먼저 발견하고 고친 뒤, 같은 문제가 여기도 있다는 사용자 지적으로 발견).
 *  이 앱이 Ollama에 보내는 요청은 항상 이 큐를 거쳐 한 번에 하나씩만 실제로 나가게 한다 — 페이지 방문
 *  자체(네트워크 대기가 대부분이라 동시 처리에 상대적으로 안전)는 그대로 병렬로 두고, CPU 경합에 훨씬
 *  민감한 AI 호출만 직렬화하는 것이 핵심이다. */
let ollamaQueue: Promise<unknown> = Promise.resolve()
function withOllamaQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = ollamaQueue.then(fn, fn)
  ollamaQueue = run.then(() => undefined, () => undefined)
  return run
}

/** detectCategoryLinksWithAI/detectSortOptionsWithAI 전용 — Gemini 무료 티어 일일 한도(20회/일)에
 *  너무 쉽게 걸려서(2026-08-22 실사용 확인: 모자사러 정렬 감지가 하루 한도 초과로 계속 조용히
 *  실패했는데, 그 전까지는 매번 다른 원인으로 착각하고 고쳤었다) 이 둘만 로컬 Ollama로 옮긴다 — 사용자가
 *  "어떤 외부 서비스의 사업 지속성/요금 정책에도 의존하지 않겠다"고 명시적으로 선택함(Groq/GitHub
 *  Models 등 다른 무료 API 대신 로컬 모델). 이 파일의 나머지 Gemini 사용처(추출규칙 생성 등 4곳)는
 *  이번 이관 대상이 아니다. 두 함수 다 "후보 목록에서 조건에 맞는 인덱스만 고르기"라는 같은 패턴이라
 *  이 헬퍼 하나를 공유한다. Ollama가 꺼져 있거나 응답 형식이 다르면 조용히 빈 배열 — 호출부가 기존
 *  히스틱/미검출로 그대로 폴백한다(원래 Gemini 실패 시 폴백과 같은 동작). qwen3는 Ollama 공식 문서가
 *  도구 호출(함수 호출) 신뢰성 예시로 쓰는 모델이라 골랐다.
 *  think:false 필수 — qwen3는 기본이 "추론 모델"이라 답하기 전에 긴 내부 사고 과정을 토큰으로 전부
 *  생성한다(2026-08-22 실측: 4항목짜리 아주 작은 목록에서도 thinking 켠 채로 258초, 꺼서 8초 —
 *  32배 차이). 이 작업은 "목록에서 인덱스 고르기"라는 단순 분류라 추론 과정이 필요 없다.
 *  MAX_CANDIDATES로 후보를 자르고 timeoutMs로 강제 마감하는 이유(2026-08-23, "펫투비 10.7분" 재발 조사):
 *  처음엔 keep_alive 갱신으로 "5분 유휴 후 모델 언로드→콜드스타트"가 원인이라 보고 고쳤는데, 그 뒤에도
 *  똑같이 매번 300초 안팎이 반복돼 실측으로 재확인했다 — 모델이 이미 메모리에 로드된(warm) 상태에서도
 *  실제 몰 규모(약 120개 링크)의 프롬프트를 보내면 여전히 210초가 걸렸고, 그마저 think:false인데도
 *  도구 호출 대신 장문의 일반 텍스트로 답하며 tool_calls가 비어 결과 없이 시간만 태웠다. 즉 진짜 원인은
 *  "콜드스타트"가 아니라 "CPU 전용 8B 모델이 후보가 많은 긴 프롬프트를 못 감당해 도구 호출을 안 하고
 *  텍스트로 새는 것"이었다 — 후보 수를 줄여 프롬프트를 짧게 유지하고, 그래도 오래 걸리면(모델이 여전히
 *  텍스트로 새는 등) 몇 분씩 무작정 기다리지 않고 짧은 시간 안에 끊어 히스틱 폴백으로 넘어가게 한다. */
const OLLAMA_MAX_CANDIDATES = 60
const OLLAMA_TIMEOUT_MS = 25_000

// Ollama의 컨텍스트 기본값은 4096 토큰이고, 그걸 넘는 입력은 **에러 없이 조용히 잘려서** 들어간다.
// 실측(2026-09-13, 투비즈온 "AI 호출 실패" 조사): 1만8천 자(약 9천 토큰) 프롬프트를 보냈더니 실제 처리된
// 입력은 2,050토큰뿐이었고, 앞쪽의 지시문과 도구 설명이 통째로 날아가 모델이 도구 호출 대신 남은 본문을
// 요약하는 일반 텍스트로 답했다 — tool_calls가 비니 호출부는 null을 받고, 화면엔 "AI 호출 실패"로만
// 뜬다(왜인지는 아무 데도 안 남는다). 바로 위 OLLAMA_MAX_CANDIDATES 주석이 적어둔 "긴 프롬프트면 도구
// 호출 대신 텍스트로 샌다"도 십중팔구 같은 원인이었다 — 후보 수를 60개로 줄인 건 결과적으로 프롬프트를
// 기본 컨텍스트 안에 다시 집어넣은 것이었지, 모델 실력 문제가 아니었던 셈이다.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8_192
// num_ctx를 키우면 그만큼 VRAM과 시간이 든다(실측: 16384로 올리면 모델 적재가 9.6GB→11.8GB, 생성도 5분
// 넘게 걸려 아래 타임아웃에 걸렸다). 그래서 "컨텍스트를 키우는 것"과 "프롬프트를 줄이는 것"을 같이 쓴다 —
// 한국어는 대략 1.5자/토큰이라 6,000자면 약 4,000토큰, 도구 스키마와 출력까지 더해도 8,192 안에 든다
// (실측: 5,000자 프롬프트 → 입력 3,347토큰, 205초, 도구 호출 정상). Groq의 GROQ_CONTEXT_CHAR_LIMIT와
// 같은 취지이며, 이 PC의 Ollama가 느린 것(2천 자짜리도 122초)을 감안한 값이기도 하다.
const OLLAMA_PROMPT_CHAR_LIMIT = Number(process.env.OLLAMA_PROMPT_CHAR_LIMIT) || 6_000

/** 프롬프트가 num_ctx를 넘겨 "조용히" 잘리는 대신, 어디를 버릴지 우리가 정하고 잘랐다는 사실을 로그로
 *  남긴다 — 반드시 앞쪽(지시문 + 도구 설명)을 살리고 뒤쪽(수집 원문)을 버린다. Ollama의 기본 잘림은
 *  정확히 그 반대로 동작해(앞을 버림) 도구 호출 자체를 없애버린다. */
export function fitOllamaPrompt(prompt: string, label = '(이름없음)'): string {
  if (prompt.length <= OLLAMA_PROMPT_CHAR_LIMIT) return prompt
  console.log(`[AI:ollama] ${label}: 프롬프트 ${prompt.length}자 → ${OLLAMA_PROMPT_CHAR_LIMIT}자로 줄임(num_ctx ${OLLAMA_NUM_CTX} 초과 방지)`)
  return `${prompt.slice(0, OLLAMA_PROMPT_CHAR_LIMIT)}\n…(원문 이하 생략 — 컨텍스트 한도)`
}

// Node의 fetch(undici)는 headersTimeout/bodyTimeout이 각각 기본 300초다. Ollama 호출은 stream:false라
// 생성이 전부 끝날 때까지 헤더가 오지 않으므로, 5분을 넘기는 요청은 우리가 준 타임아웃(아래
// MALL_REPORT_OLLAMA_TIMEOUT_MS = 480초)과 무관하게 `TypeError: fetch failed`로 끊긴다 — 실측으로
// 두 번 재현(2026-09-13, 각각 305.1초/304.8초). lib/workerClient.ts가 2026-08-23에 겪은 것과 똑같은
// 함정인데 이쪽 호출들엔 적용돼 있지 않았다. 로컬호스트 전용이라 두 타임아웃을 끄고(0 = 비활성화),
// 실제 중단은 각 호출이 넘기는 AbortSignal이 책임진다.
const ollamaDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

/** 모든 Ollama /api/chat 호출이 공유하는 고정 옵션 — 새 호출을 추가할 때 num_ctx나 dispatcher를 빠뜨려
 *  위 두 함정(조용한 잘림 / 300초 강제 종료)에 다시 걸리지 않게 한 곳에 모아둔다. */
const OLLAMA_CHAT_OPTIONS = { num_ctx: OLLAMA_NUM_CTX }

/** signal(선택)을 넘기면 "몰 구조분석 중지" 버튼이 이 호출까지 실제로 끊는다 — CPU 연산 자체인 로컬
 *  추론은 끊자마자 Ollama(llama-server)도 그 요청의 생성을 멈춘다(fetch abort 시 서버가 요청 컨텍스트
 *  취소를 감지하는 표준 동작, 2026-08-22 사용자 요청: "중지를 누르면 llama-server 작업도 멈추게"). */
// 반환을 number[](성공, 빈 배열도 "확신 없어 안 고름"이라는 유효한 성공 응답)과 null(호출 자체가
// 안 됐거나 실패)로 구분한다 — detectXWithOllamaVision과 같은 계약(VisionAttempt 로그가 null이 아닐
// 때만 "이 공급자가 성공했다"고 기록하는 것과 동일)이라야, 이 함수를 쓰는 detectCategoryLinksWithAI/
// detectSortOptionsWithAI/detectLastPageLinkWithAI도 같은 방식으로 "Ollama(14b)가 실제로 쓰였는지"를
// 기록할 수 있다(사용자 지시, 2026-09-23 — "14b가 쓰인건지 확인 가능하게"). 예전엔 항상 number[]만
// 반환해 실패와 "성공했지만 빈 결과"를 구분할 방법이 없었다.
function pickIndicesWithOllama(
  prompt: string, toolName: string, toolDescription: string, signal?: AbortSignal, timeoutMs = OLLAMA_TIMEOUT_MS,
): Promise<number[] | null> {
  // 화면에서 Ollama 체크를 끄면 로컬 추론을 아예 시작하지 않는다.
  if (!isAiProviderEnabled('ollama')) return Promise.resolve(null)
  return withOllamaQueue(() => pickIndicesWithOllamaOnce(prompt, toolName, toolDescription, signal, timeoutMs))
}

async function pickIndicesWithOllamaOnce(
  prompt: string, toolName: string, toolDescription: string, signal?: AbortSignal, timeoutMs = OLLAMA_TIMEOUT_MS,
): Promise<number[] | null> {
  // AbortSignal.timeout()과 호출부의 signal(중지 버튼) 둘 중 먼저 오는 쪽으로 끊는다 — 이 호출이 정상
  // 범위(수 초~십수 초)를 넘기면 모델이 텍스트로 새고 있다고 보고 자른다. AbortSignal.any는 Node 20+.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: combinedSignal,
      dispatcher: ollamaDispatcher,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        options: OLLAMA_CHAT_OPTIONS,
        // 모델이 세션 중 계속 메모리에 남아있게(콜드스타트 자체는 실제로 막아준다 — 다만 위 주석대로
        // 이게 300초 지연의 진짜 원인은 아니었다).
        keep_alive: '30m',
        messages: [{ role: 'user', content: fitOllamaPrompt(prompt, toolName) }],
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: toolDescription,
            parameters: {
              type: 'object',
              required: ['indices'],
              properties: { indices: { type: 'array', items: { type: 'integer' }, description: '고른 항목들의 0-based 인덱스 목록' } },
            },
          },
        }],
      }),
    } as RequestInit)
    if (!res.ok) return null
    const data = await res.json() as { message?: { tool_calls?: { function: { name: string; arguments: unknown } }[] } }
    const call = data.message?.tool_calls?.[0]
    if (!call) return null
    // Ollama는 arguments를 이미 파싱된 객체로 주지만, 혹시 문자열로 오는 경우까지 방어적으로 처리한다.
    const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
    const indices = (args as { indices?: unknown } | null)?.indices
    return Array.isArray(indices) ? indices.filter((i): i is number => Number.isInteger(i)) : []
  } catch {
    // 위 timeoutSignal이 끊은 경우도 여기로 온다.
    return null
  }
}

export interface ExtractedProduct {
  name: string
  price: number | null
  sale_price: number | null
  /** 도매가/공급가 — 소비자가(price)와 별도로 노출하는 몰에서만 채워짐(예: 신우). */
  cost_price: number | null
  /** 배송비 — "3,000~4,000원"처럼 범위로 나오면 "3000~4000" 문자열로, 단일 값이면 숫자로 채운다.
   *  product_master로 옮길 때는 계산 가능하도록 최저값 숫자로 변환한다(lib/master/migrate.ts). */
  shipping_fee: number | string | null
  brand: string
  manufacturer: string
  origin: string
  category: string
  description: string
  options: { name: string; values: string[] }[]
  /** 옵션1 값마다 옵션2가 다르게 채워지는 몰(예: 신우 — 색상별 구매 가능 사이즈가 다름)의 실제 유효
   *  조합. [옵션1값, 옵션2값] 쌍의 목록 — 캐스케이딩이 없는 몰은 빈 배열. */
  option_combinations?: string[][]
  thumbnail_urls: string[]
  thumbnail_names: string[]
  detail_image_urls: string[]
  detail_image_names: string[]
  detail_text: string
  summary_info: string
  english_name: string
  extra_info: { label: string; value: string }[]
  stock_status: string
  stock_qty: number | null
  stock_by_option: { option: string; qty: number }[]
  mall_product_code: string
  /** "스크랩 조정"으로 사용자가 새로 추가한 컬럼들 — 정해진 스키마가 없는 몰별 임의 필드(예: 소재, 세탁방법). */
  custom_fields: Record<string, string>
}

const DEFAULT_PROMPT_TEMPLATE = `원본 상품명: {{name}}

위 이미지를 보고 오픈마켓(쿠팡, 네이버 등) 등록용 상품명을 한국어로 만들어줘.
조건:
- 20자 이내
- 특수문자 최소화
- 핵심 키워드 포함 (소재, 용도, 특징)
- 상품명만 출력, 설명 없이`

/** 대표이미지 URL → AI 상품명 생성. promptTemplate에 {{name}}이 원본상품명으로 치환된다. */
export async function generateProductName(
  imageUrl: string,
  originalName: string,
  promptTemplate?: string,
  maxLength = 20,
): Promise<string> {
  try {
    // 이미지를 base64로 다운로드
    const { default: axios } = await import('axios')
    const imgRes = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const base64 = Buffer.from(imgRes.data).toString('base64')
    const mimeType = (imgRes.headers['content-type'] as string) || 'image/jpeg'

    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 },
          },
          {
            type: 'text',
            text: (promptTemplate || DEFAULT_PROMPT_TEMPLATE).replace('{{name}}', originalName),
          },
        ],
      }],
      // generateAutoExtractionRules(lib/ai.ts)와 같은 이유로 추가(2026-09-02) — Anthropic은 지금까지
      // 대부분 크레딧 부족으로 즉시 실패했지만, 응답이 느려지는 다른 장애 모드에서도 이 호출 하나 때문에
      // 상품명 생성(대량 반복 호출 가능)이 무한정 멈추지 않게 방어적으로 맞춘다.
    }, { signal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS) })

    return (response.content[0] as { type: string; text: string }).text.trim().slice(0, maxLength)
  } catch {
    // 이미지 분석 실패 시 원본명 기반으로 축약
    return originalName.slice(0, maxLength)
  }
}

export interface TransformFewShotExample {
  /** 원본 mall_products 필드 (name_original, price, brand, mall_category, description, options 등) */
  sourceFields: Record<string, unknown>
  /** 완성본에서 이 상품에 해당하는 { 컬럼명: 값 } */
  targetValues: Record<string, string>
}

/**
 * 몰의 "기존 작업내역 완성본" few-shot 예시를 보고, 같은 패턴으로 신규 상품의 AI 대상 컬럼 값을 생성한다.
 * 정규식 파싱 대신 tool-call로 스키마를 강제해 컬럼 여러 개를 한 번에 안전하게 받는다.
 * ANTHROPIC_API_KEY가 없으면 조용히 빈 객체를 반환한다(호출부에서 전체 배치를 막지 않도록).
 */
export async function generateTransformColumns(
  siteName: string,
  columns: { name: string; instruction: string }[],
  examples: TransformFewShotExample[],
  sourceFields: Record<string, unknown>,
): Promise<Record<string, string>> {
  if (!process.env.ANTHROPIC_API_KEY || !columns.length) return {}

  const properties: Record<string, { type: string; description: string }> = {}
  columns.forEach(c => { properties[c.name] = { type: 'string', description: c.instruction || c.name } })

  const exampleText = examples.map((ex, i) =>
    `[예시 ${i + 1}]\n원본 데이터: ${JSON.stringify(ex.sourceFields)}\n완성값: ${JSON.stringify(ex.targetValues)}`,
  ).join('\n\n')

  const prompt = `몰 '${siteName}'의 기존 작업 완성 예시들이다 (원본 스크래핑 데이터 → 완성값). 같은 패턴으로 아래 신규 상품의 값을 만들어라.

${exampleText || '(참고할 예시 없음 — 컬럼 지시문만 보고 판단할 것)'}

[신규 상품 원본 데이터]
${JSON.stringify(sourceFields)}

각 컬럼의 지시문:
${columns.map(c => `- ${c.name}: ${c.instruction || '(지시문 없음, 예시 패턴을 참고해 합리적으로 생성)'}`).join('\n')}`

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{
        name: 'set_columns',
        description: '각 컬럼명을 key로, 생성한 값을 value(문자열)로 채워 반환한다.',
        input_schema: {
          type: 'object',
          properties,
          required: columns.map(c => c.name),
        },
      }],
      tool_choice: { type: 'tool', name: 'set_columns' },
      messages: [{ role: 'user', content: prompt }],
      // generateAutoExtractionRules와 같은 이유로 추가(2026-09-02) — 이 함수는 이름 그대로 대량 배치
      // 처리(신규 상품마다 반복 호출)라 타임아웃 없이 걸리면 그 배치 전체가 멈춘다.
    }, { signal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS) })
    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') return {}
    return toolUse.input as Record<string, string>
  } catch {
    return {}
  }
}

export interface ExtractionRule {
  /** 'fixed'는 페이지에서 읽지 않고 value를 모든 상품에 그대로 채운다 — 택배사처럼 페이지에 아예 안
   *  나오지만 이 몰은 항상 같은 값인 필드용(스크랩 대상 직접지정에서 "화면에 없는 값" 입력으로 생성).
   *  'multi'는 한 컬럼의 값이 페이지 여러 곳에 나뉘어 있을 때(예: 상품명이 브랜드+모델명 두 요소로
   *  분리된 몰) 여러 요소를 지정해 하나로 합친다 — value는 ExtractionRulePart[]를 JSON으로 담는다. */
  type: 'label' | 'selector' | 'fixed' | 'multi'
  value: string
}

/** 'multi' 규칙의 value에 JSON으로 담기는 각 조각 — 클릭으로 지정한 라벨/셀렉터뿐 아니라, 직접 입력한
 *  고정 텍스트도 다른 조각과 결합할 수 있어야 해서(예: 클릭으로 찾은 브랜드명 + 직접 입력한 접미사)
 *  'fixed'도 조각으로 허용한다. */
export interface ExtractionRulePart {
  type: 'label' | 'selector' | 'fixed'
  value: string
}

export const EXTRACTION_RULE_FIELDS = ['name', 'price', 'cost_price', 'shipping_fee', 'category', 'brand', 'manufacturer', 'origin'] as const

/**
 * "스크랩 조정" 기능용 — 사용자가 지적한 프롬프트("부족한/틀린 부분")+ 지금 잘못 추출된 값 + 실제
 * 페이지 내용을 보고, 수정이 필요한 필드마다 추출 규칙(라벨 정규식 또는 CSS 셀렉터)을 만든다.
 * generateTransformColumns와 같은 tool-call 강제 스키마 패턴 — 확신이 없는 필드는 rules에서 아예
 * 빼도 되게 required를 안 건다. 기존 8개 고정 필드 외에, 사용자가 프롬프트로 새 컬럼(예: 소재/세탁방법)을
 * 요청하면 그 필드명을 rules에 자유롭게 추가해도 되도록 스키마를 열어둔다 — 결과는
 * ExtractedProduct.custom_fields로 저장된다. GEMINI_API_KEY가 없으면 조용히 빈 규칙을 반환한다
 * (호출부에서 전체 흐름을 막지 않도록).
 *
 * "AI모드 스크래핑"(generateAutoExtractionRules)과 같은 이유로 Gemini(GEMINI_API_KEY)를 쓴다 — Anthropic
 * 크레딧을 충전하지 않기로 하고, "AI를 통해 부족한 부분을 조정하는" 이 기능도 Gemini로 옮겨달라고 확정함.
 */
export async function generateExtractionRules(
  mallName: string,
  userPrompt: string,
  currentValues: Partial<ExtractedProduct>,
  pageText: string,
  /** "몰 구조분석"으로 미리 확인해둔 이 몰의 구조 정보(있으면) — 플랫폼/옵션 UI 형태/재고 표기 방식 등을
   *  참고해 더 정확한 규칙을 만들 수 있다. lib/scraper.ts의 MallProfileSignals와 같은 모양. */
  mallProfile?: Record<string, unknown> | null,
): Promise<Record<string, ExtractionRule>> {
  if (!process.env.GEMINI_API_KEY || !userPrompt.trim()) return {}

  const ruleSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, enum: ['label', 'selector'], description: "'label'이면 dt/dd나 표의 라벨 텍스트를 정규식으로 찾고, 'selector'면 CSS 셀렉터로 직접 값을 읽는다." },
      value: { type: Type.STRING, description: "type='label'이면 라벨과 매칭할 정규식 문자열(예: '도매가|공급가'), type='selector'면 CSS 셀렉터 문자열." },
    },
    required: ['type', 'value'],
  }
  const properties: Record<string, Schema> = {}
  EXTRACTION_RULE_FIELDS.forEach(f => { properties[f] = ruleSchema })

  // 스키마에 없는 필드는 모델이 스스로 잘 안 채우는 경향이 있어(실측 확인됨) — "'필드명' 필드 추가"로
  // 시작하는 새 컬럼 요청은 그 필드명을 properties에 직접 명시적으로 추가해, 기존 8개 필드와 똑같이
  // 확실하게 채워지도록 한다.
  const newFieldMatch = userPrompt.match(/^'([^']+)' 필드 추가/)
  if (newFieldMatch) properties[newFieldMatch[1]] = ruleSchema

  const mallProfileBlock = mallProfile
    ? `\n[이 몰에 대해 "몰 구조분석"으로 미리 확인해둔 정보 — 참고만 하고, 실제 페이지 내용과 다르면 실제 페이지를 따른다]\n${JSON.stringify(mallProfile)}\n`
    : ''

  const prompt = `몰 '${mallName}'의 상품 페이지를 스크랩하는데 값이 잘못 추출되고 있다.

[사용자 지적 사항]
${userPrompt}

[지금 추출된 값 (잘못됐을 수 있음, custom_fields는 이전에 추가한 커스텀 컬럼들)]
${JSON.stringify(currentValues)}

[실제 상품 페이지 내용 (일부)]
${pageText.slice(0, 30_000)}
${mallProfileBlock}
위 페이지에서 사용자가 지적한 필드(들)의 올바른 값을 찾을 수 있는 방법을 알아내라. 페이지에 라벨-값
쌍(예: <dt>도매가격</dt><dd>12,000원</dd> 같은 구조나 표)이 보이면 그 라벨 텍스트를 정규식으로 만들고
(type='label'), 그게 아니라 특정 요소를 CSS 셀렉터로 바로 집어야 하면 type='selector'로 답하라. 사용자가
언급하지 않았거나 페이지에서 확신할 수 없는 필드는 절대 넣지 마라 — 아는 것만 답한다.

사용자 지적 사항에 작은따옴표(')로 감싼 필드명이 있으면(예: '소재' 필드 추가) 그 값을 정확히 그 이름
그대로 rules의 key로 써라 — 기존 8개 필드(name/price/cost_price/shipping_fee/category/brand/manufacturer/
origin)에 없는 완전히 새로운 종류의 정보라도 상관없다. 그 외의 경우 새 필드명을 임의로 지어내지 마라.`

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_extraction_rules',
          description: '수정이 필요하다고 확신하는 필드에 대해서만 추출 규칙을 채워 반환한다. 확신 없는 필드는 아예 넣지 않는다. 사용자가 새 컬럼명을 지정했으면 그 이름을 key로 추가해도 된다.',
          parameters: { type: Type.OBJECT, properties: { rules: { type: Type.OBJECT, properties } }, required: ['rules'] },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_extraction_rules'] } },
        // generateAutoExtractionRules와 같은 이유로 추가(2026-09-02) — Gemini가 응답 없이 걸리면 이
        // 호출 하나 때문에 "스크랩 조정" 버튼이 무한정 멈춘다.
        abortSignal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS),
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) return {}
    const args = call.args as { rules?: Record<string, ExtractionRule> }
    return args.rules || {}
  } catch (e) {
    // generateTransformColumns(대량 배치 처리)와 달리 이 기능은 사용자가 방금 누른 단일 조정 시도라,
    // 실패를 조용히 삼키면 "AI가 확신을 못 해서 규칙을 안 만든 것"과 "API 호출 자체가 실패한 것"(크레딧
    // 부족, 네트워크 오류 등)을 구분할 수 없어 혼란스럽다 — 여기서는 그대로 던져 호출부가 사용자에게
    // 실제 실패 사유를 보여주게 한다.
    throw new Error(`Gemini 호출 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * "AI모드 스크래핑" 전용 — 사용자가 지적한 특정 필드 없이, 몰 페이지 구조를 처음부터 스스로 분석해 8개
 * 필드(name/price/cost_price/shipping_fee/category/brand/manufacturer/origin) 전체에 대해 규칙을 시도한다.
 * 이렇게 한 번 만들어진 규칙은 sites.extraction_rules에 저장되어(runAutoAnalysis) 이후 같은 몰의 다른
 * 상품에는 AI 재호출 없이 그대로 재사용된다.
 *
 * 사용자 요청으로 이 함수만 Gemini(GEMINI_API_KEY)를 쓴다 — Anthropic API 크레딧을 충전하지 않기로
 * 했고, "스크래핑을 위한 AI모드"에만 국한해서 다른 AI를 붙여달라고 확정함. 나머지 AI 기능(스크랩 조정,
 * 상품명 생성, Transform)은 전부 그대로 Anthropic을 쓴다 — 전체 교체가 아니다. ("몰 구조분석"은 이후
 * Anthropic 실패 시 Gemini로 자동 재시도하도록 별도로 확장됨 — generateMallProfileReport 참고.)
 */
export async function generateAutoExtractionRules(
  mallName: string,
  pageText: string,
  mallProfile?: Record<string, unknown> | null,
): Promise<Record<string, ExtractionRule>> {
  if (!process.env.GEMINI_API_KEY) return {}

  const ruleSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, enum: ['label', 'selector'], description: "'label'이면 dt/dd나 표의 라벨 텍스트를 정규식으로 찾고, 'selector'면 CSS 셀렉터로 직접 값을 읽는다." },
      value: { type: Type.STRING, description: "type='label'이면 라벨과 매칭할 정규식 문자열(예: '도매가|공급가'), type='selector'면 CSS 셀렉터 문자열." },
    },
    required: ['type', 'value'],
  }
  const properties: Record<string, Schema> = {}
  EXTRACTION_RULE_FIELDS.forEach(f => { properties[f] = ruleSchema })

  const mallProfileBlock = mallProfile
    ? `\n[이 몰에 대해 "몰 구조분석"으로 미리 확인해둔 정보 — 참고만 하고, 실제 페이지 내용과 다르면 실제 페이지를 따른다]\n${JSON.stringify(mallProfile)}\n`
    : ''

  const prompt = `몰 '${mallName}'의 상품 페이지 구조를 처음 분석한다("AI모드 스크래핑"). 사용자가 지적한
특정 필드는 없다 — 아래 페이지 내용을 보고, 8개 필드(name/price/cost_price/shipping_fee/category/brand/
manufacturer/origin) 각각을 이 몰에서 어떻게 추출할 수 있는지 스스로 판단해 규칙을 만들어라.

판단 기준은 실제 소비자가 브라우저로 이 페이지를 볼 때 눈에 보이는 상품 데이터여야 한다 — 아래는 모두
상품 데이터가 아니니 절대 값으로 쓰지 마라: 사이트 로고/메뉴/푸터, 검색창·검색범위 선택, 카테고리
필터/정렬 드롭다운, 로그인·장바구니·회원가입 링크, "HOME | 회사소개 | 이용약관" 같은 사이트 전체 내비게이션.
페이지 <title>은 사이트명이 섞여있는 경우가 많아 name에는 되도록 쓰지 말고, 페이지 안의 실제 상품명
표시(예: "품명" 라벨이나 상품 제목 영역)를 우선하라.

[실제 상품 페이지 내용 (일부)]
${pageText.slice(0, 30_000)}
${mallProfileBlock}
각 필드마다 페이지에 라벨-값 쌍(예: <dt>도매가격</dt><dd>12,000원</dd> 같은 구조나 표)이 보이면 그 라벨
텍스트를 정규식으로 만들고(type='label'), 그게 아니라 특정 요소를 CSS 셀렉터로 바로 집어야 하면
type='selector'로 답하라. 라벨의 값에 다른 정보가 섞여 있어(예: "배송비" 금액이 배송 정책 설명 문장
안에 파묻혀 있는 경우) 규칙만으로 깨끗한 값을 뽑기 어렵다고 판단되면, 억지로 만들지 말고 그 필드는
비워둬라 — 틀린 값보다 빈 값이 낫다. 페이지에서 값이 안 보이거나 확신할 수 없는 필드도 마찬가지로
절대 넣지 마라 — 아는 것만 답한다.`

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_extraction_rules',
          description: '확신하는 필드에 대해서만 추출 규칙을 채워 반환한다. 확신 없는 필드는 아예 넣지 않는다.',
          parameters: { type: Type.OBJECT, properties: { rules: { type: Type.OBJECT, properties } }, required: ['rules'] },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_extraction_rules'] } },
        // 다른 Gemini 호출들(generateMallProfileReportGemini의 MALL_REPORT_TIMEOUT_MS 등)엔 다 있는
        // abortSignal이 여기만 빠져 있었다 — 이 함수는 "몰 구조분석" 마지막 단계(runAutoAnalysis)에서
        // 자동으로 도는데, Gemini가 응답 없이 걸리면 그 시그널 없는 호출 하나 때문에 몰 구조분석 전체가
        // 화면에서 무한정 "분석 중"으로 멈춘다(2026-09-02 실사용 확인 — Gemini 쿼터/과부하가 겹친 밤에
        // 재현). 다른 곳과 같은 20초로 맞춘다.
        abortSignal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS),
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) return {}
    const args = call.args as { rules?: Record<string, ExtractionRule> }
    return args.rules || {}
  } catch (e) {
    // generateExtractionRules(스크랩 조정)와 같은 이유로 그대로 던진다 — 조용히 삼키면 "AI가 확신을
    // 못 해서 규칙을 안 만든 것"과 "API 호출 자체가 실패한 것"(크레딧/네트워크/타임아웃 등)을 구분할 수
    // 없다. 호출부(runAutoAnalysis)는 이미 이 예외를 잡아 "몰 구조분석 자체는 성공했으니 결과를 막지
    // 않는다"는 정책이라, 여기서 안전하게 그대로 던져도 된다.
    throw new Error(`Gemini 호출 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface OptionCandidate { name: string; values: string[] }

/**
 * "AI모드 스크래핑" 전용 — DOM에서 감지된 후보 옵션 그룹(select/스와치 등)이 실제 소비자가 구매 시 고르는
 * 진짜 상품 옵션(색상/사이즈 등)인지, 아니면 검색범위·카테고리 필터·정렬 방식 같은 상품과 무관한 사이트
 * UI 위젯인지 AI가 페이지 맥락을 보고 판별한다(실제로 도매의신에서 "검색 범위"/"카테고리 필터" select가
 * 상품 옵션으로 잘못 잡히는 것을 확인 — extractOptionsFromDom은 알려진 플랫폼(카페24 등)의 컨테이너
 * 셀렉터가 없으면 document 전체에서 select를 찾아 이런 오탐이 생긴다).
 * 판단 실패(API 없음/오류)는 "지우는" 동작이라 보수적으로 후보 전체를 그대로 유지한다 — AI 문제로
 * 진짜 옵션까지 사라지는 것보다, 기존처럼 오탐이 섞여 있는 채로 두는 쪽이 낫다.
 * "AI모드 스크래핑" 전용이라 generateAutoExtractionRules와 같은 이유로 Gemini(GEMINI_API_KEY)를 쓴다.
 */
export async function filterRealProductOptions(
  mallName: string, candidates: OptionCandidate[], pageText: string,
): Promise<string[]> {
  const keepAll = candidates.map(c => c.name)
  if (!candidates.length || !process.env.GEMINI_API_KEY) return keepAll

  const prompt = `몰 '${mallName}'의 상품 페이지에서 아래 후보 목록(select/스와치 등)을 찾았다. 이 중 실제
소비자가 이 상품을 "구매할 때 고르는" 옵션(색상/사이즈/수량 단위 등)만 골라라. 검색창의 검색범위,
카테고리 필터, 정렬 방식처럼 이 상품과 무관한 사이트 UI는 절대 포함하지 마라. 확실하지 않으면 빼라.

[후보 목록]
${candidates.map(c => `- ${c.name}: ${c.values.slice(0, 8).join(', ')}${c.values.length > 8 ? ' 등' : ''}`).join('\n')}

[실제 페이지 내용 (일부)]
${pageText.slice(0, 20_000)}`

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_real_options',
          description: '후보 중 실제 구매 옵션인 것의 name만 골라 반환한다. 상품과 무관한 UI는 제외한다.',
          parameters: {
            type: Type.OBJECT,
            properties: { names: { type: Type.ARRAY, items: { type: Type.STRING }, description: '진짜 상품 옵션인 후보의 name 값만' } },
            required: ['names'],
          },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_real_options'] } },
        // generateAutoExtractionRules와 같은 이유로 추가(2026-09-02) — 이건 "AI모드 스크래핑"이 상품마다
        // 반복 호출할 수 있어, 타임아웃 없이 Gemini가 걸리면 대량 스크랩 전체가 멈출 위험이 더 크다.
        abortSignal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS),
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) return keepAll
    const args = call.args as { names?: string[] }
    return args.names ?? keepAll
  } catch {
    return keepAll
  }
}

export interface CategoryLinkCandidate { name: string; href: string }

/**
 * "카테고리 메뉴/구조 탐지" — 페이지에서 발견한 모든 같은 출처 링크(텍스트+href) 중 실제 상품
 * 카테고리로 이동하는 것만 AI가 골라낸다. lib/scraper.ts의 scanCategoryMenu(class/id에 cat/lnb/gnb가
 * 들어간 영역을 찾아 그 안의 <li> 구조를 분석하는 셀렉터 히스틱)가 몰마다 마크업이 달라(2겹 이상 wrapper,
 * slick.js 캐러셀, 탭 위젯, 이미지 스프라이트 메뉴 등) 실사용 중 계속 새 패턴을 추가해와야 했던 문제를
 * 대신한다 — "이 링크가 진짜 카테고리냐 아니냐"는 판단(fuzzy) 문제라 셀렉터/정규식보다 AI가 잘 맞고,
 * 후보 링크는 DOM 위치/중첩 깊이와 무관하게 "페이지의 모든 링크를 그대로 나열"하는 것으로 충분해
 * 컨테이너 셀렉터 튜닝 자체가 필요 없어진다.
 * 링크 목록 대신 "인덱스"만 반환하게 해서 href를 AI가 잘못 옮겨 적을(할루시네이션) 위험을 없앤다.
 * 로컬 Ollama(pickIndicesWithOllama)를 쓴다 — 판단 실패/빈 결과/Ollama 미실행이면 빈 배열 반환,
 * 호출부가 기존 scanCategoryMenu 히스틱 체인으로 그대로 폴백한다.
 */
// 규칙 기반(구조 패턴) 스캔이 전부 실패했을 때만 도달하는 마지막 수단이 됐다(discoverTopLevelCategoryLinks
// 순서 변경, 사용자 요청 2026-08-26: "규칙기반 방식을 먼저 시도하고, 이후 AI 방식으로"). 이전엔 AI가
// 항상 먼저 시도돼 25초 안에 끊어야 했지만, 이제는 드물게만(규칙 기반이 못 찾는 몰에서만) 불리는 경로라
// 시간을 좀 더 넉넉히 줘도 전체 흐름이 그만큼 자주 느려지지 않는다("AI 시간을 충분히 늘려주고").
const CATEGORY_AI_TIMEOUT_MS = 60_000

export async function detectCategoryLinksWithAI(
  mallName: string,
  linkCandidates: { text: string; href: string }[],
  /** 지정하면 "이 카테고리의 하위 카테고리만 골라라"는 허브 펼치기 모드로 동작한다(discoverCategoryLinks의
   *  대분류 허브 확장과 같은 용도) — 생략하면 몰 전체의 최상위 카테고리 탐지 모드. */
  parentCategoryName?: string,
  signal?: AbortSignal,
  /** 이 몰에서 이미 확인된 진짜 카테고리 URL 예시 — 규칙 기반 탐지가 예전에 성공해뒀거나(scrape_profile.
   *  categoryLinks), 사용자가 "카테고리 선택 가져오기"로 직접 모아둔 것(scrape_profile.
   *  manualCategorySamples)이 있으면 프롬프트에 실제 근거로 얹어준다 — "이 몰은 이런 모양의 URL이
   *  카테고리다"라는 구체적인 기준을 주면 후보가 많아도 판단이 쉬워진다(사용자 요청, 2026-08-26: "수동
   *  선택 작업한 내용을 참고하여 AI가 참고해서 분석 가능하도록"). */
  knownExamples?: string[],
  /** 기본은 CATEGORY_AI_TIMEOUT_MS(60초, 몰 전체에서 한 번뿐인 최상위 탐지용) — expandCategoryHubs가
   *  허브마다 반복 호출할 땐(도매토피아 실사용 확인, 2026-08-30: 규칙기반이 실패하는 몰에서 허브 개수만큼
   *  최대 60초씩 전역 Ollama 대기열에 쌓여 몰 구조분석이 20분 넘게 걸림) 실패해도 정렬체크 안전망이
   *  있으니 더 짧은 타임아웃을 넘겨 최악의 소요시간 자체를 줄인다. */
  timeoutMs: number = CATEGORY_AI_TIMEOUT_MS,
  /** VisionAttempt 재사용 — 화면인식과 같은 "Groq 먼저, 실패하면 로컬 Ollama" 경쟁 구조라 같은 로그
   *  모양을 그대로 쓴다(사용자 지시, 2026-09-23 — "14b가 쓰인건지 확인 가능하게"). */
  log?: VisionAttempt[],
): Promise<CategoryLinkCandidate[]> {
  if (!linkCandidates.length) return []
  // 후보가 많을수록(실사용 확인: 몰 하나에 100개 넘는 링크도 흔함) 프롬프트가 길어져 CPU 전용 로컬
  // 모델이 도구 호출 대신 장문의 텍스트로 새며 몇 분씩 허비한다(pickIndicesWithOllamaOnce 주석 참고) —
  // 카테고리 메뉴는 보통 앞쪽(헤더/전체메뉴)에 몰려있으므로 앞에서 OLLAMA_MAX_CANDIDATES개만 판단시킨다.
  const candidates = linkCandidates.slice(0, OLLAMA_MAX_CANDIDATES)

  const scopeInstruction = parentCategoryName
    ? `이 링크들은 '${mallName}' 몰의 '${parentCategoryName}' 카테고리 페이지 안에 있던 것이다 — 이
'${parentCategoryName}'의 하위(중분류) 상품 카테고리로 보이는 링크만 골라라. '${parentCategoryName}'
자기 자신이나 다른 대분류 메뉴로 돌아가는 링크는 하위 카테고리가 아니니 제외한다.`
    : `이 링크들은 '${mallName}' 몰의 홈페이지(또는 전체메뉴)에 있던 것이다 — 실제 상품 대분류
카테고리로 이동하는 링크만 골라라.`

  const examplesSection = knownExamples?.length
    ? `\n\n[참고 — 이 몰에서 이미 실제 카테고리로 확인된 URL 예시]\n${knownExamples.slice(0, 5).map(u => `- ${u}`).join('\n')}\n위 예시와 비슷한 URL 모양(경로/쿼리파라미터 패턴)을 가진 링크는 카테고리일 가능성이 높다 — 참고만 하고, 실제로 판단이 안 서면 이 예시와 안 비슷해도 후보에서 빼지는 마라.`
    : ''

  const prompt = `${scopeInstruction}
로그인/회원가입/장바구니/마이페이지/고객센터/검색/공지사항/이용약관/사업자정보/이벤트 배너처럼 사이트
운영용이거나 상품 카테고리가 아닌 링크, 그리고 카테고리 목록이 아니라 상품 상세페이지로 바로 가는
링크는 절대 포함하지 마라. 확실하지 않으면 빼라.${examplesSection}

[링크 목록 (인덱스. "링크텍스트" → URL)]
${candidates.map((c, i) => `${i}. "${c.text}" → ${c.href}`).join('\n')}`

  let indices = await pickIndicesWithGroq(
    prompt, 'set_category_link_indices',
    '실제 상품 카테고리 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
    signal,
  )
  if (indices !== null) {
    log?.push({ task: '카테고리 후보 선별', provider: 'groq' })
  } else {
    // Groq가 키 없음/한도 초과/오류로 실패했을 때만 로컬 Ollama를 시도한다 — Groq가 "성공적으로 빈
    // 배열"을 반환했을 때(확신 없어 안 고름)는 이미 유효한 답이므로 Ollama로 다시 물어보지 않는다
    // (detectLastPageLinkWithAI와 같은 패턴, 2026-09-07 — 사용자 요청으로 카테고리/정렬 판별에도 Qwen을
    // 우선 시도하도록 확장. Ollama만 쓰던 이전 결정은 "어떤 외부 서비스에도 의존하지 않겠다"는 취지였는데,
    // Groq를 완전히 대체가 아니라 "더 빠르고 품질 좋은 1차 시도"로 앞에 두고 Ollama를 그대로 안전망으로
    // 남겨 그 취지를 지킨다 — 키 없음/한도초과/장애 어떤 이유로든 Groq가 안 되면 자동으로 Ollama로 넘어감).
    indices = await pickIndicesWithOllama(prompt, 'set_category_link_indices',
      '실제 상품 카테고리 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
      signal, timeoutMs)
    if (indices !== null) log?.push({ task: '카테고리 후보 선별', provider: 'ollama' })
  }
  indices = indices ?? []
  const seen = new Set<number>()
  return indices
    .filter(i => i >= 0 && i < candidates.length && !seen.has(i) && seen.add(i))
    .map(i => ({ name: candidates[i].text, href: candidates[i].href }))
}

function buildLastPagePrompt(mallName: string, baseUrl: string, candidates: { text: string; href: string }[]): string {
  return `이 링크들은 '${mallName}' 몰의 상품 목록(카테고리) 페이지(${baseUrl})의 페이지네이션(페이지 이동)
영역에 있던 것이다. 이 중 "마지막 페이지"로 이동하는 링크가 있으면 그 인덱스 하나만 골라라 — 숫자로 표시된
페이지 번호 중 가장 큰 값, "마지막"/"끝"/"last" 같은 문구, 또는 구조상 명백히 가장 뒤쪽 페이지를 가리키는
링크 등 근거가 있으면 고른다. 페이지 번호 링크만 쭉 나열돼 있고 어디까지가 진짜 마지막인지 이 목록만으로는
알 수 없으면(화면에 일부 번호만 보이는 경우 등) 무리해서 고르지 말고 아무것도 고르지 마라 — 확신 없는
추측보다는 고르지 않는 게 낫다.

[링크 목록 (인덱스. "링크텍스트" → URL)]
${candidates.map((c, i) => `${i}. "${c.text}" → ${c.href}`).join('\n')}`
}

const LAST_PAGE_TOOL_DESCRIPTION = '마지막 페이지로 이동하는 링크라고 확신하는 항목의 인덱스 하나만 반환한다(배열에 최대 1개). 확신 없으면 빈 배열.'

/** Groq(빠름, 무료지만 분당 8,000토큰 한도) 경로 — 응답 형식은 generateMallProfileReportGroq와 동일
 *  (OpenAI 호환 tool_choice 강제, max_tokens 명시 필수: 안 주면 이 모델의 기본 출력 한도가 그대로
 *  "요청한 출력 크기"로 잡혀 분당 출력 토큰 한도를 넘겨 시작도 못 하고 거절된다 — 위 GROQ_MAX_OUTPUT_TOKENS
 *  주석 참고). 인덱스 몇 개(또는 빈 배열)만 반환하는 아주 짧은 답이라 500이면 충분하다. 키가 없거나
 *  실패하면 조용히 null — 호출부가 로컬 Ollama로 넘어간다.
 *
 *  detectCategoryLinksWithAI/detectSortOptionsWithAI/detectLastPageLinkWithAI가 전부 "후보 목록에서
 *  조건에 맞는 인덱스만 고르기"라는 같은 패턴이라 이 헬퍼 하나를 공유한다(2026-09-07, 사용자 요청 —
 *  펫토리 카테고리 하위구조 판별에 Qwen을 실제로 붙여보니 품질이 좋아서 "카테고리/정렬 등 다른 판별에도
 *  Qwen을 써서 결과물 품질을 높여달라") — 원래는 detectLastPageLinkWithAI 하나만 이 Groq 경로를 썼는데
 *  (last-page 전용 하드코딩), toolName/toolDescription을 인자로 받도록 일반화했다. */
async function pickIndicesWithGroq(
  prompt: string, toolName: string, toolDescription: string, signal?: AbortSignal,
): Promise<number[] | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: toolDescription,
            parameters: {
              type: 'object',
              required: ['indices'],
              properties: { indices: { type: 'array', items: { type: 'integer' }, description: '고른 항목들의 0-based 인덱스 목록' } },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: toolName } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const args = JSON.parse(call.function.arguments) as { indices?: unknown }
    return Array.isArray(args.indices) ? args.indices.filter((i): i is number => Number.isInteger(i)) : []
  } catch {
    return null
  }
}

/**
 * 확장(개발자모드)의 규칙 기반 페이지네이션 지름길 3개("총 N개" 문구 / "마지막 페이지" 버튼 / 화면에
 * 보이는 페이지 번호 최댓값)가 전부 실패했을 때 쓰는 최후의 지름길 — 최후수단(최대 150페이지 완전탐색,
 * 카테고리 하나당 몇 분씩 걸릴 수 있음)으로 떨어지기 전에, 페이지네이션 영역에서 발견한 링크 후보를
 * AI에게 보여주고 "마지막 페이지로 가는 링크가 있으면 그 인덱스"만 고르게 한다(2026-09-06, 사용자 요청 —
 * 모자사러 실사용 확인: 규칙 기반 3개가 전부 실패하는 카테고리가 46개 중 다수 있어 카테고리 하나당 5~6분
 * 걸렸다). detectSortOptionsWithAI와 완전히 같은 이유·같은 패턴(href를 AI가 다시 타이핑하지 않고 인덱스로만
 * 반환 — 할루시네이션 방지)을 쓰되, 공급자는 Groq(빠름) 먼저 시도하고 실패하면 로컬 Ollama로 폴백한다.
 * "몰 구조분석"의 Anthropic→Gemini→Groq→Ollama 체인과 같은 발상이지만, 이 호출은 몰 구조분석과 달리
 * "미리보기 1회당 최대 카테고리 수만큼"(예: 46번) 반복될 수 있어 Groq 무료 등급의 분당 8,000토큰 한도에
 * 카테고리 여러 개가 몰리면 걸릴 수 있다 — 그래서 로컬 Ollama를 완전히 대체하지 않고 그대로 안전망으로
 * 남긴다(사용자 요청, 2026-09-06). 둘 다 실패하거나 확신이 없으면 null — 호출부가 기존 완전탐색으로
 * 그대로 폴백한다. */
export async function detectLastPageLinkWithAI(
  mallName: string,
  linkCandidates: { text: string; href: string }[],
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ href: string } | null> {
  if (!linkCandidates.length) return null
  const candidates = linkCandidates.slice(0, OLLAMA_MAX_CANDIDATES)
  const prompt = buildLastPagePrompt(mallName, baseUrl, candidates)

  let indices = await pickIndicesWithGroq(prompt, 'set_last_page_link_index', LAST_PAGE_TOOL_DESCRIPTION, signal)
  if (indices === null) {
    // Groq가 키 없음/한도 초과/오류로 실패했을 때만 로컬 Ollama를 시도한다 — Groq가 "성공적으로 빈 배열"을
    // 반환했을 때(확신 없어 안 고름)는 이미 유효한 답이므로 Ollama로 다시 물어보지 않는다.
    indices = await pickIndicesWithOllama(prompt, 'set_last_page_link_index', LAST_PAGE_TOOL_DESCRIPTION, signal)
  }
  const i = (indices ?? [])[0]
  return (i != null && i >= 0 && i < candidates.length) ? { href: candidates[i].href } : null
}

export interface SortOptionCandidate { label: string; href: string }

/**
 * "카테고리별 정렬기준 설정" 기능용 — 목록 페이지에서 발견한 모든 같은 출처 링크 중, 상품 정렬 방식을
 * 바꾸는 링크만 AI가 골라낸다. 표준 라벨로 정규화하지 않고 몰이 실제로 쓰는 문구(예: "신상품",
 * "제조사", "사용후기")를 그대로 label로 쓴다 — 표준 라벨(기본순/최신순/낮은가격순 등) 목록에 없는
 * 정렬 기준(상품명순, 제조사순, 리뷰순 등)은 AI가 억지로 끼워맞추지도, 통째로 빼지도 않고 그냥 원문
 * 그대로 노출해야 한다는 사용자 판단(2026-08-22) — 몰마다 표현이 정말 제각각이라(예: 어떤 몰은
 * "인기순", 어떤 몰은 "사용후기") 하나의 고정된 라벨 집합으로는 다 담을 수 없다는 게 실사용으로
 * 확인됨. detectCategoryLinksWithAI와 완전히 같은 이유·같은 패턴(href를 AI가 다시 타이핑하지 않고
 * 인덱스로만 반환 — 할루시네이션 방지)을 쓰되, 공급자는 Groq(빠름)를 먼저 시도하고 실패하면 로컬
 * Ollama로 폴백한다(2026-09-07 — 카테고리 하위구조 판별에 Groq/Qwen을 붙여보니 품질이 좋아서 다른
 * 판별에도 확장). 둘 다 실패하거나 확신이 없으면 빈 배열 — 호출부가 "정렬 옵션 없음"으로 처리한다.
 *
 * baseUrl(지금 보고 있던 목록 페이지 URL)을 프롬프트에 같이 준다 — 2026-08-22 모자사러 실사용 확인:
 * 같은 텍스트("신상품")를 쓰는 링크가 두 개(진짜 정렬 링크 하나, 완전히 다른 카테고리로 가는 메뉴
 * 링크 하나) 있을 때, Gemini는 구분했지만 로컬 qwen3는 헷갈려서 엉뚱한 쪽(카테고리 이동)을 정렬로
 * 잘못 골랐다 — baseUrl을 명시하고 "정렬은 지금 이 목록을 유지한 채 순서만 바꾼다"는 판단 기준을
 * 프롬프트에 직접 적어줘서 로컬 모델도 같은 구분을 하도록 보강했다. */
export async function detectSortOptionsWithAI(
  mallName: string,
  linkCandidates: { text: string; href: string }[],
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SortOptionCandidate[]> {
  if (!linkCandidates.length) return []
  // detectCategoryLinksWithAI와 같은 이유로 후보 수를 잘라 프롬프트를 짧게 유지한다.
  const candidates = linkCandidates.slice(0, OLLAMA_MAX_CANDIDATES)

  const prompt = `이 링크들은 '${mallName}' 몰의 상품 목록(카테고리) 페이지(${baseUrl})에 있던 것이다.
이 중 상품 정렬/정렬순서를 바꾸는 링크(신상품순, 낮은가격순, 높은가격순, 인기순, 판매량순, 조회순,
상품명순, 제조사순, 리뷰(사용후기)순 등 — 목록에 없는 기준이라도 정렬 링크면 포함)만 골라라.

중요: 정렬 링크는 지금 보고 있는 이 목록/카테고리를 그대로 유지한 채 상품이 나열되는 "순서"만 바꾼다.
텍스트가 정렬 기준처럼 보여도(예: "신상품") URL이 완전히 다른 카테고리나 목록으로 이동시킨다면(예:
카테고리 번호 자체가 바뀜) 그건 정렬이 아니라 카테고리 이동 메뉴이니 절대 포함하지 마라 — 같은
텍스트를 쓰는 링크가 여러 개면 그중 baseUrl과 같은 목록을 유지하는(정렬 파라미터만 다른) 것만 골라라.

카테고리 이동, 로그인, 검색, 필터(브랜드/가격대 등)처럼 정렬과 무관한 링크는 절대 포함하지 마라.
확실하지 않으면 빼라.

[링크 목록 (인덱스. "링크텍스트" → URL)]
${candidates.map((c, i) => `${i}. "${c.text}" → ${c.href}`).join('\n')}`

  let indices = await pickIndicesWithGroq(
    prompt, 'set_sort_option_indices',
    '정렬 기준 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
    signal,
  )
  if (indices === null) {
    // Groq가 키 없음/한도 초과/오류로 실패했을 때만 로컬 Ollama를 시도한다(위 detectCategoryLinksWithAI와
    // 같은 이유 — Groq가 "성공적으로 빈 배열"을 반환했을 때는 이미 유효한 답이므로 다시 안 물어본다).
    indices = await pickIndicesWithOllama(
      prompt, 'set_sort_option_indices',
      '정렬 기준 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
      signal,
    )
  }
  const seen = new Set<number>()
  return (indices ?? [])
    .filter(i => i >= 0 && i < candidates.length && !seen.has(i) && seen.add(i))
    .map(i => ({ label: candidates[i].text, href: candidates[i].href }))
}

function buildSortLabelScreenshotPrompt(mallName: string, knownExamples?: string[]): string {
  const examplesSection = knownExamples?.length
    ? `\n\n참고 — 이 몰에서 예전에 실제로 확인된 정렬 옵션 예시: ${knownExamples.join(', ')}. 화면에 이
예시와 완전히 같은 문구가 안 보여도 괜찮다(디자인이 바뀌었을 수 있음) — 다만 이런 종류의 선택지를 찾고
있다는 감을 잡는 데 참고만 해라.`
    : ''
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'의 상품 목록(카테고리) 페이지다. 화면에 상품 정렬 옵션
(상품이 나열되는 순서를 바꾸는 선택지 — 예: 추천순, 인기순, 낮은가격순, 높은가격순, 신상품순, 리뷰순,
판매량순, 최신순 등)이 보이면 그 각각의 정확한 화면 텍스트를 그대로 나열하라(줄임/의역 금지, 화면에 적힌
그대로). 안 보이면 빈 배열을 반환하라. 카테고리 메뉴, 브랜드/가격대 필터, 페이지당 개수(10개씩보기 등)는
정렬이 아니니 포함하지 마라.

중요: "정렬"/"정렬방식"/"정렬기준"/"SORT"라는 낱말 자체는 실제 순서를 알려주지 않는 버튼/드롭다운의
이름표일 뿐이니, 그 낱말 하나만 단독으로 쓰여 있다면(예: "정렬 ▾", "정렬방식 ▾") 그건 정렬 옵션이 아니다
— 절대 포함하지 마라. 이렇게 이름표만 보이고 실제 선택지(추천순 등)는 안 보인다면(드롭다운이 닫혀있는 것)
옵션이 하나도 안 보이는 것으로 보고 빈 배열을 반환하라 — 옵션 목록을 보려면 그 트리거를 먼저 열어야
한다는 뜻이다.

다만 닫힌 드롭다운이라도 지금 선택된 값이 그 낱말과 같이 붙어서 보이는 경우가 흔하다(예: "최신상품순
정렬 ▾", "낮은가격순 정렬 ▾" — "정렬"은 꼬리표고 "최신상품순"/"낮은가격순"이 실제 선택된 값이다). 이런
식으로 실제 순서 기준을 나타내는 단어(최신/신상품/인기/추천/가격/리뷰/판매량/이름 등)가 "정렬"이라는
낱말과 함께 붙어 있으면, 그건 이미 하나의 값이 화면에 보이는 것이니 빈 배열로 처리하지 말고 그 값을
옵션으로 반환하라(꼬리표 "정렬"만 뗀 나머지 부분, 예: "최신상품순").${examplesSection}`
}

/** Groq(qwen/qwen3.6-27b, 빠름) 경로 — 실패(키 없음/요청 실패/한도 초과 등)하면 null, 호출부가 로컬
 *  Ollama vision으로 넘어간다. reasoning_effort:'none' 필수(위 GROQ_VISION_MODEL 주석 참고 — 안 끄면
 *  <think> 과정만으로 max_tokens를 다 태워 정작 도구 호출까지 못 감). */
async function detectSortLabelsWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal, knownExamples?: string[],
): Promise<string[] | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) {
    console.log(`[AI:groq] 정렬 화면 인식 건너뜀(${mallName}) — ${!isAiProviderEnabled('groq') ? '공급자 꺼짐' : 'API 키 없음'}`)
    return null
  }
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 500,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildSortLabelScreenshotPrompt(mallName, knownExamples) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_sort_labels',
            description: '화면에서 실제로 보이는 정렬 옵션 라벨 텍스트만 반환한다. 안 보이면 빈 배열.',
            parameters: {
              type: 'object',
              required: ['labels'],
              properties: { labels: { type: 'array', items: { type: 'string' }, description: '화면에 보이는 정렬 옵션 텍스트 그대로' } },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_sort_labels' } },
      }),
    })
    if (!res.ok) {
      console.log(`[AI:groq] 정렬 화면 인식 실패(${mallName}) — HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      return null
    }
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) {
      console.log(`[AI:groq] 정렬 화면 인식 실패(${mallName}) — 도구 호출 없이 응답함`)
      return null
    }
    const args = JSON.parse(call.function.arguments) as { labels?: unknown }
    const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : []
    console.log(`[AI:groq] 정렬 화면 인식(${mallName}) — 라벨 ${labels.length}개: ${JSON.stringify(labels)}`)
    return labels
  } catch (e) {
    console.log(`[AI:groq] 정렬 화면 인식 실패(${mallName}) — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    return null
  }
}

/** 로컬 Ollama vision(qwen2.5vl) 경로 — Groq가 실패했을 때만 쓰는 안전망. Ollama가 이 모델에 대해
 *  "does not support tools"로 함수 호출 자체를 거부해(2026-09-08 실측 확인), 텍스트로 JSON 배열만
 *  답하도록 프롬프트로 강제하고 정규식으로 잘라내 파싱한다 — 다른 Ollama 호출(pickIndicesWithOllama)과
 *  같은 큐(withOllamaQueue)를 거쳐 CPU 경합을 피한다. 이미지 처리 자체가 텍스트보다 훨씬 느려(7B 기준
 *  실측 약 40초/장) 전용 타임아웃(OLLAMA_VISION_TIMEOUT_MS)을 따로 쓴다. */
async function detectSortLabelsWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal, knownExamples?: string[],
): Promise<string[] | null> {
  if (!isAiProviderEnabled('ollama')) {
    console.log(`[AI:ollama] 정렬 화면 인식 건너뜀(${mallName}) — 공급자 꺼짐`)
    return null
  }
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            content: `${buildSortLabelScreenshotPrompt(mallName, knownExamples)}\n\n다른 설명 없이 JSON 배열만 출력해라(예: ["추천순","인기순"]).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) {
        console.log(`[AI:ollama] 정렬 화면 인식 실패(${mallName}) — HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
        return null
      }
      const data = await res.json() as { message?: { content?: string } }
      const match = (data.message?.content ?? '').match(/\[[\s\S]*\]/)
      if (!match) {
        console.log(`[AI:ollama] 정렬 화면 인식(${mallName}) — 배열 형식 응답 없음, 빈 배열로 처리. 답 앞부분: ${JSON.stringify((data.message?.content ?? '').slice(0, 120))}`)
        return []
      }
      const parsed = JSON.parse(match[0]) as unknown
      const labels = Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : []
      console.log(`[AI:ollama] 정렬 화면 인식(${mallName}) — 라벨 ${labels.length}개: ${JSON.stringify(labels)}`)
      return labels
    } catch (e) {
      console.log(`[AI:ollama] 정렬 화면 인식 실패(${mallName}) — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      return null
    }
  })
}

/**
 * 정렬 UI 탐지의 1차 수단 — href/select 마크업이나 텍스트 키워드로 "정렬처럼 생긴 것"을 추측하는 대신,
 * 카테고리 목록 페이지 스크린샷을 그대로 비전 AI에게 보여주고 "화면에 보이는 정렬 옵션 라벨"을 물어본다
 * (사용자 지시, 2026-09-08 — "정렬은 어차피 사람 눈으로 화면에서 확인 가능하다, 화면을 먼저 보는 것으로
 * 설계 기준을 바꿔라"). <a>/<select>/버튼 onclick/커스텀 JS 드롭다운처럼 마크업 형태가 뭐든, 그리고 사이트
 * 공통 내비게이션 텍스트(예: "신상품")가 정렬 키워드와 우연히 겹치든 말든 화면에 실제로 안 보이면 후보에
 * 안 들어간다 — 이번 세션에 반복된 마크업 형태별 오탐/누락 사고(2026-09-08, 소꿉노리 다수)가 이 방식
 * 자체로는 재현되지 않는다.
 *
 * 여기서 반환하는 라벨은 "화면에 이렇게 보인다"는 것만 확정한다 — 그 라벨이 실제로 클릭했을 때 진짜
 * 정렬(같은 목록을 유지한 채 순서만 바뀜)로 동작하는지는 호출부가 실제 클릭 + diffQueryParams(또는
 * 상품 목록 순서 변화)로 다시 검증해야 한다(detectSortOptionsByClicking/confirmSortCandidatesByClicking
 * 참고) — 비전 AI도 화면을 잘못 읽을 수 있으니, "화면에 보임"과 "실제로 동작함"이라는 독립된 두 증거를
 * 요구하는 게 안전하다.
 *
 * Anthropic(Claude)도 Gemini도 아니라 Groq(qwen/qwen3.6-27b)를 1차로 쓴다 — 이 프로젝트는 Anthropic API
 * 크레딧을 충전하지 않기로 이미 확정돼 있어(generateProductName 등 기존 Claude 호출도 대부분 크레딧
 * 부족으로 실패, 2026-09-08 재확인) Claude vision을 쓸 수 없고, Gemini는 (사용자 지적, 2026-09-08) 이미
 * 다른 기능에서 무료 티어 일일 한도에 걸린 전례(위 withOllamaQueue 주석)가 있어 새 기능의 1차로 또 얹기엔
 * 부담스럽다. Groq는 이 계정에서 실제로 qwen3.6-27b라는 멀티모달(텍스트+이미지) 모델을 제공하는 것과
 * 실제 화면 인식 정확도(직접 비교, 2026-09-08 — 같은 스크린샷에서 Groq 6개 정탐 vs 로컬 qwen2.5vl:7b
 * 1개만 인식)까지 실측으로 확인했다. 실패하면(한도 초과 등) 과금 없는 로컬 Ollama vision으로,
 * 그마저 실패하면 null(호출부의 기존 href/키워드 기반 방식 폴백)로 이어진다 — 이 파일의 다른 "인덱스
 * 고르기" 함수들(detectSortOptionsWithAI 등)과 같은 Groq→Ollama 폴백 체인 패턴.
 *
 * null=1차·2차 둘 다 실패(호출부가 기존 href/키워드 기반 방식으로 폴백해야 함) — []=화면에 정렬 UI가 안
 * 보인다는 확정된 답. 다만 화면 인식이 완벽하지 않을 수 있으니, []가 와도 호출부는 안전하게 기존 방식을
 * 한 번 더 시도한다(이 함수를 "유일한 진실"로 과신하지 않는다).
 */
export async function detectSortOptionsFromScreenshot(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
  /** 이 몰에서 예전에 실제로 확인된 정렬 옵션 라벨(있으면) — 프롬프트에 예시로 얹어 비전이 "이런 종류의
   *  선택지를 찾는 것"이라는 감을 더 쉽게 잡게 한다(사용자 지시, 2026-09-18 — "기존에 정상적으로 정렬을
   *  찾은 내역이 있으면 더 확인하기 쉬울 것 아니야"). 강제하지 않는다 — 화면이 그새 바뀌었을 수 있어
   *  프롬프트 자체에도 "안 보여도 참고만" 이라고 명시해뒀다(buildSortLabelScreenshotPrompt 참고). */
  knownExamples?: string[], log?: VisionAttempt[],
): Promise<string[] | null> {
  const viaGroq = await detectSortLabelsWithGroqVision(mallName, imageBase64, mimeType, signal, knownExamples)
  if (viaGroq !== null) {
    log?.push({ task: '정렬 라벨', provider: 'groq' })
    return viaGroq
  }
  const viaOllama = await detectSortLabelsWithOllamaVision(mallName, imageBase64, signal, knownExamples)
  if (viaOllama !== null) log?.push({ task: '정렬 라벨', provider: 'ollama' })
  return viaOllama
}

/** null=이 함수 자체를 확정 못 함(호출부가 다음 페이지로 넘어가거나 폴백해야 함), found:false=이 화면엔
 *  없다고 확정, found:true=위치까지 확정. */
export type CategoryMenuTriggerResult = { found: true; label: string; xPercent: number; yPercent: number } | { found: false }

/** 격자 눈금 — 모델에게 좌표를 직접 추정(xPercent/yPercent 실수값)하게 시켰더니 같은 스크린샷을 다시
 *  줘도 호출마다 완전히 다른 위치를 골랐다(실측, 2026-09-12 — 투비즈온 홈 화면 반복 호출에서
 *  10.5%/96%/5%/11.8% 등 서로 무관한 값이 나왔고, 심지어 yPercent:256.63 같은 범위 밖 값도 나왔다).
 *  연속값 추정 대신 화면에 미리 그려둔 칸 중 하나를 "고르게"(분류 문제로 바꿈) 하면 비전 모델이 훨씬
 *  안정적이다(Set-of-Mark 프롬프팅) — 칸 이름(A1~H6)만 답하게 하고, 그 칸의 중심 좌표는 코드에서
 *  계산한다. */
const CATEGORY_TRIGGER_GRID_COLS = 8
const CATEGORY_TRIGGER_GRID_ROWS = 6

/** 스크린샷 위에 빨간 격자선과 칸 이름을 그려서 되돌려준다 — sharp로 SVG를 합성한다(픽셀 조작 없이
 *  DOM/CSS로 그리는 것보다, 이미 찍힌 스크린샷 버퍼에 바로 합성하는 쪽이 화면 배율과 무관하게 정확하다). */
async function overlayGridForVision(imageBase64: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const buf = Buffer.from(imageBase64, 'base64')
    const image = sharp(buf)
    const meta = await image.metadata()
    const width = meta.width ?? 1280
    const height = meta.height ?? 800
    const cellW = width / CATEGORY_TRIGGER_GRID_COLS
    const cellH = height / CATEGORY_TRIGGER_GRID_ROWS
    const lines: string[] = []
    for (let c = 1; c < CATEGORY_TRIGGER_GRID_COLS; c++) {
      const x = c * cellW
      lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="red" stroke-width="1" stroke-opacity="0.6"/>`)
    }
    for (let r = 1; r < CATEGORY_TRIGGER_GRID_ROWS; r++) {
      const y = r * cellH
      lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="red" stroke-width="1" stroke-opacity="0.6"/>`)
    }
    const labels: string[] = []
    for (let r = 0; r < CATEGORY_TRIGGER_GRID_ROWS; r++) {
      for (let c = 0; c < CATEGORY_TRIGGER_GRID_COLS; c++) {
        const label = `${String.fromCharCode(65 + c)}${r + 1}`
        const x = c * cellW + 2
        const y = r * cellH + 13
        labels.push(
          `<text x="${x}" y="${y}" font-size="13" font-weight="bold" fill="red" stroke="white" stroke-width="2" paint-order="stroke">${label}</text>`,
        )
      }
    }
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}${labels.join('')}</svg>`
    const out = await image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer()
    return { base64: out.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return null
  }
}

/** 모델이 답한 칸 이름(예: "C2")을 그 칸 중심의 화면 비율 좌표로 변환한다. 형식이 안 맞거나 격자 범위
 *  밖이면 null(호출부는 found:false로 취급). */
function cellLabelToPercent(cell: string): { xPercent: number; yPercent: number } | null {
  const match = /^\s*([A-Za-z])\s*(\d+)\s*$/.exec(cell)
  if (!match) return null
  const col = match[1].toUpperCase().charCodeAt(0) - 65
  const row = parseInt(match[2], 10) - 1
  if (col < 0 || col >= CATEGORY_TRIGGER_GRID_COLS || row < 0 || row >= CATEGORY_TRIGGER_GRID_ROWS) return null
  return {
    xPercent: ((col + 0.5) / CATEGORY_TRIGGER_GRID_COLS) * 100,
    yPercent: ((row + 0.5) / CATEGORY_TRIGGER_GRID_ROWS) * 100,
  }
}

function buildCategoryMenuTriggerScreenshotPrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'의 화면이다. 화면 위에는 빨간 격자선과 각 칸의 이름
(왼쪽 위부터 A1, A는 열(왼쪽→오른쪽 A~${String.fromCharCode(64 + CATEGORY_TRIGGER_GRID_COLS)}), 숫자는
행(위→아래 1~${CATEGORY_TRIGGER_GRID_ROWS}))이 그려져 있다. 화면에서 전체 상품 카테고리를 펼쳐서
보여주는 메뉴/버튼(예: 햄버거 아이콘 ☰, "전체 카테고리", "카테고리", "전체보기", "MENU" 같은 라벨 —
텍스트 없이 아이콘/이미지로만 표시돼 있어도 좋다)을 찾아서, 그 버튼의 중심이 들어있는 칸의 이름을
답해라. 실제 카테고리 이름 하나하나(예: "여성의류", "가전")가 아니라, 그 카테고리들을 "전부 펼쳐서
목록으로 보여주는" 트리거 버튼을 찾는 것이다.

중요1: 화면 중앙에 크게 걸린 회전 배너/광고/프로모션 이미지(상품 사진, 할인 문구, 큰 배너 슬라이드 등)는
이 트리거가 아니다 — 그런 배너를 착각해서 답하지 마라. 이 트리거는 거의 항상 화면 맨 위 헤더/내비게이션
바 안에 있는 작고 아이콘 크기의 요소다(로고, 로그인, 장바구니 같은 다른 헤더 아이콘들과 나란히 있는
경우가 많다).

중요2: 헤더 근처에 작고 서로 비슷하게 생긴 아이콘이 "여러 개 나란히 줄지어" 있는 경우가 있다 — 이런
줄은 각각 카테고리 하나씩으로 빠르게 이동하는 "바로가기" 아이콘 모음일 뿐, 찾는 트리거가 아니다. 찾는
트리거는 그런 줄과는 별개로 있는 단 하나의 아이콘/버튼으로, 누르면 "카테고리 전체"(하나가 아니라 여러
대분류 전부)가 한꺼번에 목록으로 펼쳐지는 것이다 — 보통 햄버거(☰) 모양이거나, 여러 줄이 겹친 듯한
아이콘이거나, 화면 왼쪽 맨 끝(또는 다른 아이콘들보다 먼저)에 단독으로 있다. "여러 개가 나란히 줄지어
있는 비슷한 아이콘들 중 하나"처럼 보이면 그건 트리거가 아닐 가능성이 높다 — 그 줄 자체가 아니라 그
줄을 여는 별도의 단일 버튼을 찾아라.

화면 맨 위 헤더 영역을 먼저 살펴보고, 거기서 못 찾겠으면 그때만 found를 false로 답하라.`
}

/** detectSortLabelsWithGroqVision과 같은 모델/제약(reasoning_effort:'none' 등, 같은 이유는 그쪽 주석
 *  참고) — 카테고리 메뉴 트리거는 텍스트가 아예 없는 이미지/아이콘일 수 있어(투비즈온 실사용 확인,
 *  2026-09-12 — "전체 카테고리" 버튼과 대분류 탭 전부 alt 없는 <img>) 라벨 텍스트 대신 화면에 그려둔
 *  격자 칸 이름(cellLabelToPercent 참고)을 받아온다 — 이 위치를 셀렉터가 아니라 화면 좌표 클릭으로
 *  그대로 쓴다(호출부 discoverCategoryMenuByVision 참고). */
async function detectCategoryMenuTriggerWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<CategoryMenuTriggerResult | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 300,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildCategoryMenuTriggerScreenshotPrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_category_menu_trigger',
            description: '화면에서 전체 카테고리 메뉴를 여는 버튼이 들어있는 격자 칸을 반환한다. 안 보이면 found:false만 채운다.',
            parameters: {
              type: 'object',
              required: ['found'],
              properties: {
                found: { type: 'boolean' },
                label: { type: 'string', description: '버튼 위 텍스트(있으면 그대로), 아이콘만 있으면 빈 문자열' },
                cell: { type: 'string', description: '버튼 중심이 들어있는 격자 칸 이름(예: "C2")' },
              },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_category_menu_trigger' } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const args = JSON.parse(call.function.arguments) as { found?: boolean; label?: string; cell?: string }
    if (!args.found || typeof args.cell !== 'string') return { found: false }
    const percent = cellLabelToPercent(args.cell)
    if (!percent) return { found: false }
    return { found: true, label: typeof args.label === 'string' ? args.label : '', ...percent }
  } catch {
    return null
  }
}

/** detectSortLabelsWithOllamaVision과 같은 이유(이 모델은 함수 호출을 거부해 텍스트 JSON으로 강제)·같은
 *  큐(withOllamaQueue)·같은 타임아웃을 쓴다. */
async function detectCategoryMenuTriggerWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<CategoryMenuTriggerResult | null> {
  if (!isAiProviderEnabled('ollama')) return null
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            content: `${buildCategoryMenuTriggerScreenshotPrompt(mallName)}\n\n다른 설명 없이 JSON 객체 하나만 출력해라(예: {"found":true,"label":"전체 카테고리","cell":"C2"} 또는 {"found":false}).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) return null
      const data = await res.json() as { message?: { content?: string } }
      const match = (data.message?.content ?? '').match(/\{[\s\S]*\}/)
      if (!match) return null
      const parsed = JSON.parse(match[0]) as { found?: boolean; label?: string; cell?: string }
      if (!parsed.found || typeof parsed.cell !== 'string') return { found: false }
      const percent = cellLabelToPercent(parsed.cell)
      if (!percent) return { found: false }
      return { found: true, label: typeof parsed.label === 'string' ? parsed.label : '', ...percent }
    } catch {
      return null
    }
  })
}

/**
 * 카테고리 탐지의 마지막 수단(AI 텍스트 폴백보다도 먼저 시도) — 카테고리 메뉴가 DOM 텍스트/셀렉터로는
 * 전혀 안 잡히는 몰(투비즈온 실사용 확인, 2026-09-12 — "전체 카테고리" 버튼과 대분류 탭이 전부 alt 없는
 * 이미지라 글자 자체가 존재하지 않음)을 위한 것이다. 사용자 지시(2026-09-12): "화면을 열면 다 잘 보인다,
 * 이 기준으로 방법을 찾아라" — 사람이 화면을 보고 "여기 카테고리 버튼이 있네"라고 판단하는 것과 똑같이,
 * 스크린샷을 그대로 비전 AI에게 보여주고 위치를 물어본 뒤, DOM 셀렉터가 아니라 화면 좌표로 직접 클릭
 * 한다(호출부 discoverCategoryMenuByVision 참고) — 그 버튼이 이미지든 텍스트든, 어떤 마크업이든 상관없다.
 *
 * null=두 공급자 다 실패(호출부가 이 페이지는 포기하고 다음 페이지나 기존 폴백으로 넘어가야 함).
 */
/** 모델이 가끔 0~100 범위를 벗어난 값을 내놓는다(실사용 확인, 2026-09-12 — yPercent:256.63 같은 값) —
 *  그런 좌표로 클릭하면 화면 밖 엉뚱한 요소(로그인/약관 링크 등)를 눌러 의도치 않은 페이지 이동만
 *  일으키므로, 범위를 벗어나면 "못 찾음"과 동일하게 취급해 호출부가 다음 페이지로 넘어가게 한다. */
function sanitizeCategoryMenuTrigger(result: CategoryMenuTriggerResult | null): CategoryMenuTriggerResult | null {
  if (!result?.found) return result
  if (result.xPercent < 0 || result.xPercent > 100 || result.yPercent < 0 || result.yPercent > 100) return { found: false }
  return result
}

export async function detectCategoryMenuTriggerFromScreenshot(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal, log?: VisionAttempt[],
): Promise<CategoryMenuTriggerResult | null> {
  const gridded = await overlayGridForVision(imageBase64)
  const gridImage = gridded?.base64 ?? imageBase64
  const gridMimeType = gridded?.mimeType ?? mimeType
  const viaGroq = await detectCategoryMenuTriggerWithGroqVision(mallName, gridImage, gridMimeType, signal)
  if (viaGroq !== null) {
    log?.push({ task: '카테고리 메뉴 트리거', provider: 'groq' })
    return sanitizeCategoryMenuTrigger(viaGroq)
  }
  const viaOllama = await detectCategoryMenuTriggerWithOllamaVision(mallName, gridImage, signal)
  if (viaOllama !== null) log?.push({ task: '카테고리 메뉴 트리거', provider: 'ollama' })
  return sanitizeCategoryMenuTrigger(viaOllama)
}

/** detectCategoryMenuTriggerFromScreenshot과 같은 타입 모양이지만 별도 타입으로 둔다 — 이 파일의
 *  트리거/그룹수/이름 계열 함수들이 전부 관심사별로 독립 복제돼 있는 기존 관례(공급자별 함수도 매번
 *  새로 만듦)와 맞추기 위함이라, 굳이 공유 타입으로 합치는 리팩터링은 지금 범위가 아니다. */
export type SortTriggerResult = { found: true; label: string; xPercent: number; yPercent: number } | { found: false }

function sanitizeSortTrigger(result: SortTriggerResult | null): SortTriggerResult | null {
  if (!result?.found) return result
  if (result.xPercent < 0 || result.xPercent > 100 || result.yPercent < 0 || result.yPercent > 100) return { found: false }
  return result
}

function buildSortTriggerScreenshotPrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'의 상품 목록/카테고리 화면이다. 화면 위에는 빨간 격자선과
각 칸의 이름(왼쪽 위부터 A1, A는 열(왼쪽→오른쪽 A~${String.fromCharCode(64 + CATEGORY_TRIGGER_GRID_COLS)}),
숫자는 행(위→아래 1~${CATEGORY_TRIGGER_GRID_ROWS}))이 그려져 있다. 화면에서 상품 정렬 순서를 바꾸는
버튼/드롭다운을 찾아라. 이 버튼은 두 가지 모양 중 하나다: ①"정렬"/"정렬방식"/"정렬기준"/"SORT" 같은
고정 라벨만 있는 버튼(지금 어떤 정렬인지는 안 보임), ②지금 선택된 정렬 값과 화살표가 같이 보이는 버튼
(예: "최신순 ▾", "인기순 ˅"). 둘 중 어느 쪽이든 그 버튼의 중심이 들어있는 칸의 이름을 답해라.

중요1: 이건 카테고리 메뉴 버튼(전체 카테고리/메뉴 아이콘)이 아니다 — 카테고리는 "무엇을 보여줄지"를
바꾸고, 이 버튼은 "이미 보이는 상품 목록을 어떤 순서로 보여줄지"만 바꾼다. 보통 상품 목록 영역 바로
위, 상품 개수 표시("총 306개" 등) 근처나 오른쪽 끝에 있다.
중요2: 그리드뷰/리스트뷰 전환 아이콘, 페이지 번호(페이지네이션), 필터/검색 아이콘과 헷갈리지 마라 —
그런 것들은 정렬과 무관하다.

화면에 이런 버튼이 안 보이면 found를 false로 답하라.`
}

/** detectCategoryMenuTriggerWithGroqVision과 같은 모델/제약 — 정렬 트리거도 텍스트 없이 화살표 아이콘만
 *  있을 수 있어 격자 칸 좌표로 클릭한다(호출부 detectSortOptionsByScreenshot 참고). */
async function detectSortTriggerWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<SortTriggerResult | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 300,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildSortTriggerScreenshotPrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_sort_trigger',
            description: '화면에서 정렬 순서를 바꾸는 버튼이 들어있는 격자 칸을 반환한다. 안 보이면 found:false만 채운다.',
            parameters: {
              type: 'object',
              required: ['found'],
              properties: {
                found: { type: 'boolean' },
                label: { type: 'string', description: '버튼 위 텍스트(있으면 그대로), 아이콘만 있으면 빈 문자열' },
                cell: { type: 'string', description: '버튼 중심이 들어있는 격자 칸 이름(예: "C2")' },
              },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_sort_trigger' } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const args = JSON.parse(call.function.arguments) as { found?: boolean; label?: string; cell?: string }
    if (!args.found || typeof args.cell !== 'string') return { found: false }
    const percent = cellLabelToPercent(args.cell)
    if (!percent) return { found: false }
    return { found: true, label: typeof args.label === 'string' ? args.label : '', ...percent }
  } catch {
    return null
  }
}

async function detectSortTriggerWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<SortTriggerResult | null> {
  if (!isAiProviderEnabled('ollama')) return null
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            content: `${buildSortTriggerScreenshotPrompt(mallName)}\n\n다른 설명 없이 JSON 객체 하나만 출력해라(예: {"found":true,"label":"정렬방식","cell":"F1"} 또는 {"found":false}).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) return null
      const data = await res.json() as { message?: { content?: string } }
      const match = (data.message?.content ?? '').match(/\{[\s\S]*\}/)
      if (!match) return null
      const parsed = JSON.parse(match[0]) as { found?: boolean; label?: string; cell?: string }
      if (!parsed.found || typeof parsed.cell !== 'string') return { found: false }
      const percent = cellLabelToPercent(parsed.cell)
      if (!percent) return { found: false }
      return { found: true, label: typeof parsed.label === 'string' ? parsed.label : '', ...percent }
    } catch {
      return null
    }
  })
}

/** 정렬 트리거가 "정렬방식"처럼 고정 라벨만 있고 지금 값이 화면에 안 보이는 경우를 찾는다
 *  (detectSortOptionsFromScreenshot은 이미 열려 있거나 값이 보이는 경우만 읽을 수 있어 이 경우를
 *  못 잡는다 — 도매신 실사용 확인, 2026-09-16). 호출부(detectSortOptionsByScreenshot)가 이 위치를
 *  clickNearestClickableAtPoint로 클릭해 연 뒤 다시 스크린샷을 찍어 값을 읽는다.
 *  null=두 공급자 다 실패(호출부는 이 신호 없이 기존 DOM 폴백으로 넘어가야 함). */
export async function detectSortTriggerFromScreenshot(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal, log?: VisionAttempt[],
): Promise<SortTriggerResult | null> {
  const gridded = await overlayGridForVision(imageBase64)
  const gridImage = gridded?.base64 ?? imageBase64
  const gridMimeType = gridded?.mimeType ?? mimeType
  const viaGroq = await detectSortTriggerWithGroqVision(mallName, gridImage, gridMimeType, signal)
  if (viaGroq !== null) {
    log?.push({ task: '정렬 트리거', provider: 'groq' })
    return sanitizeSortTrigger(viaGroq)
  }
  const viaOllama = await detectSortTriggerWithOllamaVision(mallName, gridImage, signal)
  if (viaOllama !== null) log?.push({ task: '정렬 트리거', provider: 'ollama' })
  return sanitizeSortTrigger(viaOllama)
}

function buildCategoryGroupCountPrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'에서 "전체 카테고리" 메뉴를 방금 열어본 화면이다(제대로
안 열렸을 수도 있다). 화면에 상품 대분류가 서로 다른 몇 개의 그룹(탭, 열, 컬럼 등 어떤 형태든)으로
나뉘어 보이는지 세어봐라 — 예를 들어 "여성의류/남성의류/신발/가방..." 같은 하위 카테고리 목록이 하나의
그룹 제목 아래 나열돼 있고, 그런 그룹이 화면에 나란히 여러 개(예: 3개, 7개) 보이면 그 그룹의 개수를
답해라. 그룹이 딱 하나만 보이거나(그 안 하위 카테고리 수는 몇 개든 상관없다), 메뉴 자체가 제대로 안
열려 있으면 1을 답해라. 카테고리 메뉴 자체가 전혀 안 보이면 0을 답해라.`
}

/** lib/scraper.ts의 discoverCategoryMenuByVision이 트리거를 클릭한 뒤, "지금 이 결과가 화면에 보이는
 *  전체 그룹 수를 다 담았는지" 검증하는 데 쓴다(사용자 지시, 2026-09-12 — "사람이 보는 화면을 기준으로
 *  카테고리가 어디까지인지 먼저 확인하고, 그 이후 각 카테고리에 들어가라"). 투비즈온 실사용 확인: 트리거
 *  클릭이 "전체 카테고리"(대분류 7개 전부 표시)가 아니라 비슷하게 생긴 다른 작은 아이콘(대분류 하나만
 *  펼치는 "빠른 이동" 아이콘)에 잘못 맞아도, DOM 스캔 결과 자체는 "진짜 카테고리"라 표본검증(looksLikeRealCategoryBatch)
 *  은 통과해버린다 — 그 검증은 "이게 진짜냐"만 보지 "이게 전부냐"는 안 보기 때문. 화면에 보이는 그룹
 *  수를 별도로 세어 스캔이 실제로 찾은 그룹 수(CategoryMenuScanResult.groupCount)와 비교하면, "진짜지만
 *  일부만" 잡은 경우를 잡아낼 수 있다.
 *  null=두 공급자 다 실패(호출부가 이 신호 없이 기존 방식대로 판단해야 함). */
export async function detectVisibleCategoryGroupCount(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<number | null> {
  const viaGroq = await detectCategoryGroupCountWithGroqVision(mallName, imageBase64, mimeType, signal)
  if (viaGroq !== null) return viaGroq
  return await detectCategoryGroupCountWithOllamaVision(mallName, imageBase64, signal)
}

async function detectCategoryGroupCountWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<number | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 200,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildCategoryGroupCountPrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_category_group_count',
            description: '화면에 보이는 상품 대분류 그룹의 개수를 반환한다.',
            parameters: {
              type: 'object',
              required: ['groupCount'],
              properties: { groupCount: { type: 'integer', description: '화면에 나란히 보이는 대분류 그룹 수(메뉴가 안 보이면 0, 하나뿐이면 1)' } },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_category_group_count' } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const args = JSON.parse(call.function.arguments) as { groupCount?: unknown }
    return typeof args.groupCount === 'number' && Number.isFinite(args.groupCount) ? Math.max(0, Math.round(args.groupCount)) : null
  } catch {
    return null
  }
}

async function detectCategoryGroupCountWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<number | null> {
  if (!isAiProviderEnabled('ollama')) return null
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            content: `${buildCategoryGroupCountPrompt(mallName)}\n\n다른 설명 없이 숫자 하나만 출력해라(예: 7).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) return null
      const data = await res.json() as { message?: { content?: string } }
      const match = (data.message?.content ?? '').match(/\d+/)
      if (!match) return null
      return Math.max(0, parseInt(match[0], 10))
    } catch {
      return null
    }
  })
}

function buildVisibleCategoryNamesPrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'에서 카테고리 메뉴를 열어본 화면이다. **사람이 이 화면에서
상품 카테고리로 읽는 이름을 전부** 순서대로 뽑아라. 대분류와 그 아래 하위 카테고리를 모두 포함한다.
다음은 카테고리가 아니므로 넣지 마라: 로그인/로그아웃/회원가입/장바구니/마이페이지/주문조회/고객센터/
검색창/공지사항/이벤트 배너 문구/가격이나 숫자만 있는 항목. 화면에 실제로 보이는 글자만 답하고, 안 보이는
것을 상상해서 채우지 마라.`
}

/** lib/scraper.ts가 "화면에서 파악한 카테고리"와 "최종 결과"를 대조하는 데 쓴다(사용자 지시, 2026-09-13 —
 *  "화면을 통해 카테고리를 파악했으면, 마지막 결과가 그 화면의 카테고리와 맞는지, 안 맞는 건 어떤 건지
 *  왜 그런지 피드백을 줄 수 있게 해야 한다"). 화면 인식은 이미 트리거를 찾고(detectCategoryMenuTriggerFromScreenshot)
 *  그룹 수를 세는 데(detectVisibleCategoryGroupCount) 쓰고 있었지만, "그래서 그 화면에 뭐가 보였는지"를
 *  이름 단위로 남기지 않아 결과와 대조할 근거 자체가 없었다.
 *  null=두 공급자 다 실패(호출부는 대조를 건너뛴다 — 없는 근거로 "누락"이라고 단정하지 않는다). */
export async function detectVisibleCategoryNames(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<string[] | null> {
  const viaGroq = await detectVisibleCategoryNamesWithGroqVision(mallName, imageBase64, mimeType, signal)
  if (viaGroq !== null) return viaGroq
  return await detectVisibleCategoryNamesWithOllamaVision(mallName, imageBase64, signal)
}

/** 비전이 돌려준 이름 목록을 정리한다 — 공백/빈 문자열/중복 제거, 길이 상한(메뉴 이름이 아닌 문장이
 *  섞여 들어오는 것 방지), 개수 상한. 순수 함수라 테스트로 규칙을 고정해둔다. */
export function sanitizeVisibleCategoryNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim()
    if (!name || name.length > 40) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= 300) break
  }
  return out
}

async function detectVisibleCategoryNamesWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<string[] | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 900,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildVisibleCategoryNamesPrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_visible_categories',
            description: '화면에 보이는 상품 카테고리 이름을 순서대로 반환한다.',
            parameters: {
              type: 'object',
              required: ['names'],
              properties: { names: { type: 'array', items: { type: 'string' }, description: '화면에 보이는 카테고리 이름들' } },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_visible_categories' } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const names = sanitizeVisibleCategoryNames((JSON.parse(call.function.arguments) as { names?: unknown }).names)
    return names.length ? names : null
  } catch {
    return null
  }
}

async function detectVisibleCategoryNamesWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<string[] | null> {
  if (!isAiProviderEnabled('ollama')) return null
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            // 이 모델은 도구 호출을 지원하지 않아(OLLAMA_VISION_MODEL 주석) 프롬프트로 JSON 배열만 강제한다.
            content: `${buildVisibleCategoryNamesPrompt(mallName)}\n\n다른 설명 없이 JSON 배열만 출력해라(예: ["여성의류","남성의류"]).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) return null
      const content = (await res.json() as { message?: { content?: string } }).message?.content ?? ''
      const match = content.match(/\[[\s\S]*\]/)
      if (!match) return null
      const names = sanitizeVisibleCategoryNames(JSON.parse(match[0]))
      return names.length ? names : null
    } catch {
      return null
    }
  })
}

function buildVisibleCategoryHierarchyPrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'의 화면이다 — 카테고리 메뉴를 클릭해서 열어본 화면일
수도 있고, 클릭 없이도 상품 대분류들이 항상 가로 탭/세로 메뉴 형태로 이미 보이는 화면(홈페이지 헤더
등)일 수도 있다. 어느 쪽이든 **사람이 이 화면을 보듯이** 같은 시각적 레벨에 나란히 나타난 상품
대분류(그룹 제목)와 그 아래 딸린 하위 카테고리(중분류/소분류)를 그룹으로 묶어서 답해라 — 각 그룹은
대분류 이름 하나와 그 아래 화면에 보이는 하위 카테고리 이름들(중분류뿐 아니라 그 아래 소분류가 같이
보이면 그것도 모두 포함, 순서대로)로 이루어진다. 하위 카테고리가 화면에 안 보이고 대분류 이름만
나란히 여러 개 보이면(예: 가로로 나열된 탭들) 각 이름을 그 자체로 하나의 그룹으로 삼고 하위 목록은
비워 둬라. 다음은 카테고리가 아니므로 넣지 마라: 로그인/로그아웃/회원가입/장바구니/마이페이지/주문조회/
고객센터/검색창/공지사항/이벤트 배너 문구/가격이나 숫자만 있는 항목. 화면에 실제로 보이는 글자만
답하고, 안 보이는 것을 상상해서 채우지 마라.`
}

/** detectVisibleCategoryNames(평평한 이름 목록)는 "이 이름이 화면에 있냐 없냐"만 검증하는 용도라 대/중/
 *  소분류가 서로 어떻게 묶이는지는 담지 않는다 — 사람이 화면을 보면 "이 대분류 아래 이런 하위 카테고리가
 *  있다"는 구조까지 한눈에 파악되는데, 그 구조 자체를 사용자에게 보여줄 근거가 없었다(사용자 지시,
 *  2026-09-15 — "사람과 같이 화면 전체를 캡쳐해서 보는 형태로 대분류/중소분류 및 정렬 구조를 파악").
 *  이미 카테고리 메뉴가 열린 화면을 찍어둔 시점에 한 번 더(추가 캡처 없이) 물어 구조까지 받아온다.
 *  detectVisibleCategoryNames는 그대로 두고(재검증 로직이 이미 그걸 쓰고 있음) 이 함수는 화면 대조
 *  카드에 "화면에서 본 구조"를 같이 보여주는 용도로만 쓰인다.
 *  null=두 공급자 다 실패(호출부는 구조 표시를 건너뛴다 — 없는 근거로 지어내지 않는다). */
export async function detectVisibleCategoryHierarchy(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal, log?: VisionAttempt[],
): Promise<{ group: string; items: string[] }[] | null> {
  const viaGroq = await detectCategoryHierarchyWithGroqVision(mallName, imageBase64, mimeType, signal)
  if (viaGroq !== null) {
    log?.push({ task: '카테고리 계층', provider: 'groq' })
    return viaGroq
  }
  const viaOllama = await detectCategoryHierarchyWithOllamaVision(mallName, imageBase64, signal)
  if (viaOllama !== null) log?.push({ task: '카테고리 계층', provider: 'ollama' })
  return viaOllama
}

/** 비전이 돌려준 그룹 목록을 정리한다 — sanitizeVisibleCategoryNames와 같은 이유(길이 상한/중복 제거)로
 *  순수 함수로 뽑아 테스트로 규칙을 고정해둔다. */
export function sanitizeVisibleCategoryHierarchy(raw: unknown): { group: string; items: string[] }[] {
  if (!Array.isArray(raw)) return []
  const seenGroups = new Set<string>()
  const out: { group: string; items: string[] }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const groupRaw = (entry as { group?: unknown }).group
    if (typeof groupRaw !== 'string') continue
    const group = groupRaw.replace(/\s+/g, ' ').trim()
    if (!group || group.length > 40 || seenGroups.has(group)) continue
    const items = sanitizeVisibleCategoryNames((entry as { items?: unknown }).items)
    seenGroups.add(group)
    out.push({ group, items })
    if (out.length >= 60) break
  }
  return out
}

async function detectCategoryHierarchyWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<{ group: string; items: string[] }[] | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) {
    console.log(`[AI:groq] 카테고리 계층 화면 인식 건너뜀(${mallName}) — ${!isAiProviderEnabled('groq') ? '공급자 꺼짐' : 'API 키 없음'}`)
    return null
  }
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 1200,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildVisibleCategoryHierarchyPrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_visible_category_hierarchy',
            description: '화면에 보이는 대분류와 그 아래 하위 카테고리를 그룹으로 묶어 반환한다.',
            parameters: {
              type: 'object',
              required: ['groups'],
              properties: {
                groups: {
                  type: 'array',
                  description: '대분류별 그룹 목록',
                  items: {
                    type: 'object',
                    required: ['group', 'items'],
                    properties: {
                      group: { type: 'string', description: '대분류 이름' },
                      items: { type: 'array', items: { type: 'string' }, description: '그 대분류 아래 보이는 하위 카테고리 이름들' },
                    },
                  },
                },
              },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_visible_category_hierarchy' } },
      }),
    })
    if (!res.ok) {
      console.log(`[AI:groq] 카테고리 계층 화면 인식 실패(${mallName}) — HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      return null
    }
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) {
      console.log(`[AI:groq] 카테고리 계층 화면 인식 실패(${mallName}) — 도구 호출 없이 응답함`)
      return null
    }
    const groups = sanitizeVisibleCategoryHierarchy((JSON.parse(call.function.arguments) as { groups?: unknown }).groups)
    console.log(`[AI:groq] 카테고리 계층 화면 인식(${mallName}) — 그룹 ${groups.length}개: ${JSON.stringify(groups.map(g => ({ group: g.group, items: g.items.length })))}`)
    return groups.length ? groups : null
  } catch (e) {
    console.log(`[AI:groq] 카테고리 계층 화면 인식 실패(${mallName}) — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    return null
  }
}

async function detectCategoryHierarchyWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<{ group: string; items: string[] }[] | null> {
  if (!isAiProviderEnabled('ollama')) {
    console.log(`[AI:ollama] 카테고리 계층 화면 인식 건너뜀(${mallName}) — 공급자 꺼짐`)
    return null
  }
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            // 이 모델은 도구 호출을 지원하지 않아(OLLAMA_VISION_MODEL 주석) 프롬프트로 JSON만 강제한다.
            content: `${buildVisibleCategoryHierarchyPrompt(mallName)}\n\n다른 설명 없이 JSON 배열만 출력해라`
              + `(예: [{"group":"여성의류","items":["원피스","블라우스"]},{"group":"가방","items":[]}]).`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) {
        console.log(`[AI:ollama] 카테고리 계층 화면 인식 실패(${mallName}) — HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
        return null
      }
      const content = (await res.json() as { message?: { content?: string } }).message?.content ?? ''
      const match = content.match(/\[[\s\S]*\]/)
      if (!match) {
        console.log(`[AI:ollama] 카테고리 계층 화면 인식(${mallName}) — 배열 형식 응답 없음. 답 앞부분: ${JSON.stringify(content.slice(0, 120))}`)
        return null
      }
      const groups = sanitizeVisibleCategoryHierarchy(JSON.parse(match[0]))
      console.log(`[AI:ollama] 카테고리 계층 화면 인식(${mallName}) — 그룹 ${groups.length}개: ${JSON.stringify(groups.map(g => ({ group: g.group, items: g.items.length })))}`)
      return groups.length ? groups : null
    } catch (e) {
      console.log(`[AI:ollama] 카테고리 계층 화면 인식 실패(${mallName}) — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      return null
    }
  })
}

function buildProductListVisiblePrompt(mallName: string): string {
  return `이 스크린샷은 한국 쇼핑몰 '${mallName}'의 어떤 카테고리 페이지를 연 화면이다. **사람이 보기에 이
화면에 판매 상품 목록이 있는가?** 상품 썸네일과 상품명/가격이 격자나 목록 형태로 여러 개 늘어서 있으면
있는 것이다. 다음은 "있다"의 근거가 아니다: 배너/기획전 이미지만 있음, 카테고리 메뉴만 있음, "상품이
없습니다" 안내, 로그인 화면, 빈 화면. 확실하지 않으면 false로 답해라.`
}

/** lib/scraper.ts의 "누락 카테고리 재검증"이 마지막 수단으로 쓴다(사용자 지시, 2026-09-13 — "사람이 보는
 *  화면에는 모든 카테고리가 확인이 된다. 누락된 카테고리가 있으면 다른 방법으로라도 다시 검증하는
 *  프로세스를 넣어라"). DOM 기반 상품 개수 세기(countProductsSettled)가 0으로 나와도, 사람 눈에 상품이
 *  보이면 그건 우리 셀렉터가 못 읽은 것이지 빈 카테고리가 아니다 — 그 판단을 화면으로 대신한다.
 *  null = 두 공급자 다 실패(호출부는 이 근거 없이 판단한다). */
export async function detectProductListVisible(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<boolean | null> {
  const viaGroq = await detectProductListVisibleWithGroqVision(mallName, imageBase64, mimeType, signal)
  if (viaGroq !== null) return viaGroq
  return await detectProductListVisibleWithOllamaVision(mallName, imageBase64, signal)
}

async function detectProductListVisibleWithGroqVision(
  mallName: string, imageBase64: string, mimeType: string, signal?: AbortSignal,
): Promise<boolean | null> {
  if (!isAiProviderEnabled('groq') || !process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 200,
        temperature: 0,
        reasoning_effort: 'none',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildProductListVisiblePrompt(mallName) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_product_list_visible',
            description: '이 화면에 판매 상품 목록이 보이는지 답한다.',
            parameters: {
              type: 'object',
              required: ['visible'],
              properties: {
                visible: { type: 'boolean', description: '상품 목록이 보이면 true' },
                itemCount: { type: 'integer', description: '대략 몇 개가 보이는지(모르면 0)' },
              },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_product_list_visible' } },
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    const args = JSON.parse(call.function.arguments) as { visible?: unknown }
    return typeof args.visible === 'boolean' ? args.visible : null
  } catch {
    return null
  }
}

async function detectProductListVisibleWithOllamaVision(
  mallName: string, imageBase64: string, signal?: AbortSignal,
): Promise<boolean | null> {
  if (!isAiProviderEnabled('ollama')) return null
  return withOllamaQueue(async () => {
    const timeoutSignal = AbortSignal.timeout(OLLAMA_VISION_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{
            role: 'user',
            content: `${buildProductListVisiblePrompt(mallName)}\n\n다른 설명 없이 true 또는 false만 출력해라.`,
            images: [imageBase64],
          }],
        }),
      } as RequestInit)
      if (!res.ok) return null
      const content = ((await res.json() as { message?: { content?: string } }).message?.content ?? '').toLowerCase()
      if (content.includes('true')) return true
      if (content.includes('false')) return false
      return null
    } catch {
      return null
    }
  })
}

export interface MallStructureReport {
  urlHierarchy: string
  categoryStructure: string
  sortStructure: string
  bankName: string
  accountNumber: string
  shippingCourier: string
  shippingFeeInfo: string
  returnAddress: string
  stockManagementType: string
  companyContact: string
  productPageStructure: string
  scrapingNeeds: string
  /** 이 리포트가 (검증된 클라우드) AI 분석인지, Groq/로컬 Ollama 분석인지, API 실패 시의 규칙 기반 대체
   *  결과인지 — 화면에서 신뢰도를 구분해 보여주는 용도. 'ollama'는 CategoryAnomalyVerdict의 source와
   *  같은 이유로 'ai'와 분리했다 — 로컬 소형 모델은 이런 종합 추론(12개 항목 동시 추출)에 클라우드보다
   *  약하다는 게 실측으로 확인돼 있어(detectCategoryAnomalyOllama 주석 참고), 신뢰도를 다르게 표시해야
   *  한다. 'groq'도 같은 이유로 분리했다 — GROQ_MODEL이 이 추출 작업에 얼마나 정확한지 아직 실사용
   *  검증이 없다(도입 첫날, 2026-09-02). 모델명을 여기 박아두지 않는다 — 도입 당시 쓰려던 llama-3.3-70b가
   *  같은 날 404 model_not_found로 교체됐는데(GROQ_MODEL 주석 참고) 이 주석과 화면 툴팁엔 옛 이름이
   *  그대로 남아 사용자에게 없는 모델을 안내하고 있었다(2026-09-12 수정). */
  generatedBy: 'ai' | 'heuristic' | 'ollama' | 'groq'
}

const MALL_REPORT_FIELDS: { key: keyof MallStructureReport; label: string; hint: string }[] = [
  { key: 'urlHierarchy', label: 'URL 계층', hint: '목록/상세 페이지 URL 패턴, 페이지네이션 방식' },
  { key: 'categoryStructure', label: '카테고리 구조', hint: '대분류/중분류 등 실제 카테고리 트리' },
  { key: 'sortStructure', label: '정렬 구조', hint: '카테고리 목록 페이지에서 실제로 확인된 정렬 옵션(인기순/낮은가격순 등)' },
  { key: 'bankName', label: '은행명', hint: '무통장입금 시 사용하는 은행명' },
  { key: 'accountNumber', label: '계좌번호', hint: '무통장입금 계좌번호' },
  { key: 'shippingCourier', label: '배송 택배사 정보', hint: '이용하는 택배사명' },
  { key: 'shippingFeeInfo', label: '택배비/배송비 정보', hint: '기본 배송비, 도서산간 추가비용, 무료배송 기준 등' },
  { key: 'returnAddress', label: '배송/반품 주소지', hint: '반품·교환 시 보내는 주소' },
  { key: 'stockManagementType', label: '재고 관리 형태', hint: '수량 노출/품절 문구/옵션별 재고 등 실제 표기 방식' },
  { key: 'companyContact', label: '업체 연락처', hint: '전화번호, 이메일 등' },
  { key: 'productPageStructure', label: '상품페이지 주요 구조', hint: '대표이미지/옵션/상세설명이 어떤 요소에 있는지' },
  { key: 'scrapingNeeds', label: '스크래핑 필요 데이터', hint: '이 몰에서 스크랩 시 특별히 놓치기 쉬운 데이터나 주의할 점' },
]

/**
 * "몰 구조분석"을 실제 몰들에서 반복하며 얻은 경험적 지식 — PTP의 기본 노하우로 축적해, 다음에 처음
 * 보는 몰을 분석할 때도 AI가 어디를 살펴봐야 할지 미리 참고하게 한다(이 몰이 실제로 그렇다는 뜻이 아니라
 * "이런 경우가 있더라"는 힌트일 뿐 — 항상 실제 원문이 최우선이라고 프롬프트에서도 명시함).
 * 새로운 몰을 분석하다 실사용으로 확인된 패턴/함정이 또 나오면 이 목록에 한 줄씩 추가한다.
 */
const MALL_ANALYSIS_KNOWLEDGE = [
  '결제계좌/은행 정보는 상품페이지가 아니라 "이용안내" 같은 정적 안내 페이지에 있는 경우가 많다.',
  '택배사명을 구체적으로 밝히지 않고 "택배 서비스 이용"이라고만 적어둔 몰도 있다 — 이런 경우 특정 택배사를 추측하지 말고 확인 안됨으로 답한다.',
  '반품 주소지가 따로 없고 회사(본사) 주소만 있는 몰도 있다 — 그 경우 회사 주소를 반품 주소로 단정하지 말고, "반품 주소"/"반송 주소"/"교환 주소"/"보내는 곳"처럼 반품·교환 목적임을 밝힌 라벨의 주소만 인정한다(정확한 문구는 몰마다 다르지만 의미가 같으면 인정 — "반품 주소"라는 글자가 그대로 있어야만 인정하는 게 아니다).',
  '고도몰(godomall) 계열은 스킨마다 카테고리 전체보기 메뉴의 클래스명이 다르다(.cate/.ovmenu, .lnb 등 스킨별로 확인된 사례가 있음).',
  '안내성 링크(이용안내/배송안내 등)는 보통 텍스트가 짧다 — "배송"처럼 느슨한 키워드만 보면 "~배송비별도" 같은 상품명에 잘못 걸릴 수 있다.',
  '계좌번호의 자릿수/구간 형식은 은행마다 다르다(예: 농협은 3-4-4-2처럼 구간이 4개인 경우가 있음) — 3구간으로 고정해서 자르면 뒷부분이 잘릴 수 있다.',
  '택배사/은행 정보가 글자가 아니라 로고 이미지로만 표시된 몰이 있다 — 이런 이미지는 원문에 "[이미지 설명/파일명]"으로 시작하는 절에 그 이미지의 alt 속성 또는 파일명이 따로 정리되어 있으니, 본문에 글자로 없어도 그 절에 택배사/은행 이름이 있으면 그것도 근거로 인정한다.',
  '카테고리 구조는 헤더 메뉴가 <ul><li>가 아닌 다른 마크업(div, 링크 나열 등)으로 되어 있어 구조적으로 못 뽑아낸 몰도 있다 — 이런 경우 원문의 "[헤더/카테고리 메뉴 텍스트]" 절에 나온 메뉴명들을 나열해 답해도 된다(계층이 불확실하면 "대분류: A, B, C" 처럼 평평하게 적어도 됨 — 아예 확인 안됨으로 답하기 전에 이 절을 먼저 확인한다).',
]

function buildMallReportPrompt(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
): string {
  return `몰 '${mallName}'(플랫폼: ${platform})의 실제 페이지에서 수집한 원문이다. 이 내용만 근거로 아래 항목들을 조사하라.
추측이나 일반적인 쇼핑몰 상식으로 채우지 말고, 원문에 실제로 있는 내용만 답하라. 원문에 없으면 그 항목은 정확히 "확인 안됨"이라고만 답한다.

[다른 몰들을 분석하며 얻은 참고 지식 — 이 몰이 실제로 그렇다는 뜻은 아니고, 어디를 살펴봐야 할지/어떤
함정이 있을 수 있는지 참고만 한다. 아래 원문과 다르면 항상 원문을 따른다]
${MALL_ANALYSIS_KNOWLEDGE.map(k => `- ${k}`).join('\n')}

[샘플 상품 URL]
${sampleProductUrl}

[카테고리 메뉴/경로]
${categoryHints.join(', ') || '(확인 안됨)'}

[카테고리 목록 페이지에서 실제로 확인된 정렬 옵션 — 클릭/URL 검증까지 거쳐 이미 구조적으로 확정된 값이니
그대로 정렬 구조 항목에 옮겨 적으면 된다(추측 불필요)]
${sortHints.join(', ') || '(확인 안됨)'}

[수집한 원문]
${contextText.slice(0, 20_000)}`
}

/** Anthropic으로 "몰 구조분석" 리포트를 생성한다. ANTHROPIC_API_KEY가 없거나 크레딧 부족 등으로
 *  실패하면 null — 호출부(generateMallProfileReport)가 Gemini로 재시도한다. */
// "몰 구조분석"의 AI 리포트 단계 하나가 164초까지 걸리는 게 실사용에서 확인됐다(2026-08-25, 가방쟁이 —
// Anthropic은 크레딧 부족으로 즉시 400 실패했지만, Gemini가 503(과부하)에 대해 응답하기까지 오래 걸렸다).
// 이미 규칙기반(buildHeuristicMallReport) 폴백이 있어 AI가 느리거나 안 되면 그걸로 대체하면 되는데,
// 아무 타임아웃도 없어 API가 응답을 줄 때까지(또는 SDK가 내부적으로 재시도하는 동안) 무작정 기다렸다 —
// pickIndicesWithOllamaOnce의 OLLAMA_TIMEOUT_MS와 같은 이유로, 여기도 짧게 끊고 폴백으로 넘어가게 한다.
const MALL_REPORT_TIMEOUT_MS = 20_000

/** 이 리포트 4개 공급자 함수가 전부 "자체 타임아웃 + 몰구조분석 중지/PTP 탭 종료로 걸리는 외부 signal"을
 *  같이 봐야 해서 한 곳으로 모았다(2026-09-06 — stopProfileAnalysis가 지금까지 이 AI 호출 단계에는 전혀
 *  전달되지 않아, "중지"를 눌러도/탭을 닫아도 이 호출만은 끝까지 그대로 돌던 문제의 수정). AbortSignal.any는
 *  둘 중 먼저 발생하는 쪽으로 그대로 abort된다. */
function reportAiSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
}

/** Anthropic/Groq 에러가 "400 {\"type\":\"error\",\"error\":{\"message\":\"...\"}}" 형태의 원문 그대로
 *  넘어오면(SDK가 상태코드+본문을 그대로 이어붙인 message, Groq HTTP 에러 응답 본문) 화면(onError, 이번
 *  실행의 AiReportAttempt.error)에 보여주기엔 너무 길고 사람이 읽기 어렵다 — 본문 JSON 안에 있는 실제
 *  사람이 읽을 메시지만 뽑아 보여준다. JSON이 아니거나 그 안에 message가 없으면 원문을 그대로 쓴다
 *  (2026-09-23, 실사용 확인 — Anthropic 크레딧 소진 사유가 이 형태로 왔다). */
function extractReadableApiError(raw: string): string {
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) return raw
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: unknown; message?: unknown }
    // Anthropic/Groq는 error가 {message: "..."} 객체, Ollama는 error가 그냥 문자열이다 — 둘 다 커버한다.
    const errorField = parsed?.error
    const message = typeof errorField === 'string' ? errorField
      : (errorField as { message?: unknown } | undefined)?.message ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch { /* JSON이 아니면 원문 그대로 */ }
  return raw
}

/** extractReadableApiError로 뽑아낸 메시지가 여전히 영어 원문(공급자 API가 영어로 응답)이라, 화면 나머지가
 *  전부 한국어인 이 툴에서 그대로 보여주면 어색하다는 지적(사용자 지시, 2026-09-23 — "AI 호출 상세" 패널에
 *  영어 원문이 그대로 뜬 걸 보고). 자주 나오는 몇 가지 패턴만 한국어 설명으로 바꾼다 — 매핑에 없는 낯선
 *  에러까지 억지로 번역하면 오히려 원인을 왜곡해 감출 수 있어, 그런 경우는 원문을 그대로 둔다(이미
 *  onError가 넘기는 값 중 "API 키 없음"/"분석할 원문이 수집되지 않음" 같은 건 이미 한국어라 아래 패턴에
 *  안 걸리고 그대로 통과한다). */
export function translateAiErrorReason(raw: string): string {
  const patterns: [RegExp, string][] = [
    [/credit balance is too low/i, '크레딧 잔액 부족 — 결제/충전이 필요합니다'],
    [/currently experiencing high demand/i, '일시적 과부하 — 나중에 다시 시도하면 될 수 있습니다'],
    [/tokens per day \(TPD\)/i, '일일 토큰 한도 초과 — 무료 등급 하루치를 다 써서 하루 지나야 복구됩니다'],
    [/tokens per minute \(I?TPM\)|output tokens per minute \(OTPM\)/i, '분당 토큰 한도 초과 — 잠시 후 재시도하면 될 수 있습니다'],
    [/free_tier_requests|RESOURCE_EXHAUSTED/i, '일일 무료 요청 한도 초과 — 하루 지나야 복구됩니다'],
    [/aborted due to timeout/i, '처리 시간 초과 — 이 PC(로컬)가 제한 시간 안에 응답을 못 만들었습니다'],
    [/model_not_found|does not exist/i, '모델을 찾을 수 없음 — 모델명이 바뀌었거나 이 계정에서 못 씀'],
  ]
  for (const [re, ko] of patterns) if (re.test(raw)) return ko
  return raw
}

async function generateMallProfileReportAnthropic(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
  // AiReportAttempt 주석 참고 — 이 함수는 실패를 전부 내부에서 삼키고 null만 반환해왔다(호출부가 던지는
  // 예외를 못 잡으니 generateMallProfileReport의 catch로는 "왜" 실패했는지 알 수 없었다, 2026-09-23 실사용
  // 확인 — 화면에 "결과 없음"만 뜨고 실제 원인인 크레딧 부족은 안 보였음). null을 반환하는 모든 지점에서
  // 이 콜백으로 이유를 같이 알린다.
  onError?: (reason: string) => void,
): Promise<MallStructureReport | null> {
  if (!process.env.ANTHROPIC_API_KEY) { onError?.('API 키 없음'); return null }
  if (!contextText.trim()) { onError?.('분석할 원문이 수집되지 않음'); return null }

  const properties: Record<string, { type: string; description: string }> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: 'string', description: `${f.label} — ${f.hint}. 아래 원문에서 확인할 수 없으면 반드시 "확인 안됨"이라고만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText)

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      tools: [{
        name: 'set_mall_report',
        description: `조사한 ${MALL_REPORT_FIELDS.length}개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.`,
        input_schema: { type: 'object', properties, required: MALL_REPORT_FIELDS.map(f => f.key) },
      }],
      tool_choice: { type: 'tool', name: 'set_mall_report' },
      messages: [{ role: 'user', content: prompt }],
    }, { signal: reportAiSignal(MALL_REPORT_TIMEOUT_MS, signal) })
    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') { onError?.('도구 호출 없이 응답함(빈 응답 또는 스키마 불일치)'); return null }
    return { ...(toolUse.input as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ai' }
  } catch (e) {
    const rawMessage = e instanceof Anthropic.APIError ? e.message : e instanceof Error ? e.message : String(e)
    console.error('[generateMallProfileReportAnthropic] API call failed:', rawMessage)
    onError?.(extractReadableApiError(rawMessage))
    return null
  }
}

/** Anthropic이 안 되면(크레딧 부족 등) Gemini로 같은 리포트를 시도한다 — "AI모드 스크래핑"/"스크랩 조정"과
 *  같은 GEMINI_API_KEY를 재사용. GEMINI_API_KEY가 없거나 원문이 없으면 null(호출부가 규칙 기반으로 대체). */
async function generateMallProfileReportGemini(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
  // generateMallProfileReportAnthropic의 onError 주석 참고 — 같은 이유로 실패 지점마다 이유를 알린다.
  onError?: (reason: string) => void,
): Promise<MallStructureReport | null> {
  if (!process.env.GEMINI_API_KEY) { onError?.('API 키 없음'); return null }
  if (!contextText.trim()) { onError?.('분석할 원문이 수집되지 않음'); return null }

  const properties: Record<string, Schema> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: Type.STRING, description: `${f.label} — ${f.hint}. 아래 원문에서 확인할 수 없으면 반드시 "확인 안됨"이라고만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText)

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_mall_report',
          description: `조사한 ${MALL_REPORT_FIELDS.length}개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.`,
          parameters: { type: Type.OBJECT, properties, required: MALL_REPORT_FIELDS.map(f => f.key) },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_mall_report'] } },
        abortSignal: reportAiSignal(MALL_REPORT_TIMEOUT_MS, signal),
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) { onError?.('functionCall 없이 응답함(빈 응답 또는 스키마 불일치)'); return null }
    return { ...(call.args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ai' }
  } catch (e) {
    const rawMessage = e instanceof Error ? e.message : String(e)
    console.error('[generateMallProfileReportGemini] API call failed:', rawMessage)
    onError?.(extractReadableApiError(rawMessage))
    return null
  }
}

// detectCategoryAnomalyOllama와 같은 이유로 여유 있게 잡는다 — 이 리포트는 12개 항목을 한 번에 뽑아야 해
// 그 이분판정(180초 실측)보다도 더 오래 걸릴 수 있다. Anthropic/Gemini가 둘 다 안 될 때만 타는 마지막
// 폴백이라 무거워도 감수한다(사용자 요청, 2026-09-02 — "Anthropic/Gemini 빼고 Ollama로 하면 되잖아").
// 240초로 시작했다가 실측(걸스굽, 2026-09-02)에서 240초를 꽉 채우고도 못 끝내는 걸 확인해 480초(8분)로
// 늘렸다 — 그래도 안 끝나면 이 이상 늘리기보단 "이 리포트는 로컬 모델엔 원래 무리"로 보고 규칙 기반
// 폴백을 받아들이는 쪽을 권한다(파일 상단 generatedBy 주석 참고).
const MALL_REPORT_OLLAMA_TIMEOUT_MS = 480_000

// https://console.groq.com 무료 API(2026-09-02 사용자 발급, 카드 등록 불필요) — 전용 LPU 하드웨어로
// 돌려 Ollama(이 PC에서 CPU 전용이라 이 리포트 하나에 480초를 줘도 못 끝낸 적 있음, 위 주석 참고)보다
// 훨씬 빠르다. API가 OpenAI 호환(/chat/completions, tools 스키마)이라 Anthropic/Gemini/Ollama와 같은
// 셋 중 하나를 골라 붙이면 됐다. 무료 한도가 하루 1,000회 안팎(모델별로 다름)이라 Ollama보다 먼저,
// 그러나 유료인 Anthropic/Gemini보다는 뒤에 시도한다(아래 generateMallProfileReport 순서 참고).
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
// llama-3.3-70b-versatile로 시작했다가 실제 이 계정의 /v1/models 응답엔 없어(단종/개명, 404
// model_not_found로 실측 확인, 2026-09-02) 이 계정에서 실제로 쓸 수 있는 모델 목록을 /v1/models로 직접
// 조회해 골랐다 — 추측으로 고르지 않았다. gpt-oss-120b/20b, qwen3.8-27b 셋 다 무료 등급 TPM 한도(아래
// 주석)에 똑같이 걸려 모델 선택보다 컨텍스트 크기 쪽이 병목이다. qwen3.8-27b(270억)와 gpt-oss-120b
// (1200억, 계정에서 가장 큰 모델)를 직접 나란히 비교(걸스굽, 2026-09-02)했더니, 파라미터 수가 4배 이상
// 큰 gpt-oss-120b가 오히려 애매하면 "확인 안됨"으로 쉽게 포기하는 경향이 뚜렷했다(업체연락처/반품주소/
// URL계층/스크래핑유의사항 넷 다 qwen이 더 상세하고 정확했음, gpt-oss-120b는 그 중 절반을 아예
// "확인 안됨"으로 답함) — 크기가 아니라 이 작업(한국어 원문에서 도구 호출로 구조화 추출)과의 궁합
// 문제로 보인다. 그래서 qwen3.8-27b를 기본으로 둔다(이 프로젝트가 Ollama에서도 Qwen 계열을 한국어
// 정확도 이유로 검증해둔 전례가 있다 — OLLAMA_MODEL 주석 — 와도 일관됨).
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'
const MALL_REPORT_GROQ_TIMEOUT_MS = 20_000
// 정렬 UI 화면 인식(detectSortOptionsFromScreenshot) 전용 — 원래 qwen3.6-27b(프리뷰 모델)를 썼는데
// Groq가 이 모델을 완전히 폐기해(2026-09-16 확인 — /v1/models에서 사라짐, chat/completions 호출 시
// 404 model_not_found) 화면인식 전체가 로컬 Ollama 폴백에만 의존하는 상태가 됐었다. Groq 공식 후속
// 모델인 qwen3.8-27b(위 GROQ_MODEL과 같은 모델)로 교체 — 이것도 이미지 입력(OpenAI 호환 image_url
// content)과 함수 호출을 **동시에** 지원하는 멀티모달 모델임을 직접 호출해 확인했다(2026-09-16, 작은
// 테스트 이미지로 색상 인식 + tool_choice 강제 호출 둘 다 성공). GROQ_MODEL과 같은 모델이지만 상수를
// 분리해 둔다 — Groq가 텍스트/비전 모델을 다시 따로 낼 경우 이 값만 바꾸면 되게. 기본은 "추론 모델"이라
// 답 전에 <think> 과정을 전부 토큰으로 생성해(위 OLLAMA_MODEL의 think:false와 같은 문제) 아주 짧은
// 질문에도 max_tokens를 다 태우는 걸 실측했다 — reasoning_effort:'none'으로 꺼야 즉시 최종 답만 나온다.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b'

// 무료 등급 계정 공통 분당 토큰(TPM) 한도가 8,000인 게 실측으로 확인됐다(2026-09-02 — 모델을
// gpt-oss-120b/20b/qwen3.8-27b로 바꿔봐도 셋 다 똑같이 8,000에 걸림, 조직 단위 한도라 모델과 무관).
// 다른 공급자(Anthropic/Gemini)는 buildMallReportPrompt가 contextText를 20,000자까지 쓰는데, 그대로
// 쓰면 13,000~14,000토큰이 필요해 항상 실패한다 — Groq 전용으로 훨씬 짧게 자른다. 8,000토큰 한도에
// 여유를 두려고 원문을 5,000자로 줄인다(고정 프롬프트/스키마 설명 오버헤드까지 감안).
// 실측 품질(2026-09-02, 걸스굽): 계좌번호/업체연락처/반품주소/택배사/정렬구조는 정확했지만, 은행명은
// "기업"이 기업은행 약칭인 걸 못 알아채 놓쳤고(실제 오답), 상품페이지 구조/배송비/재고관리 방식은
// "확인 안됨"으로 나왔다(이건 모델 실력 문제가 아니라 5,000자로 잘리면서 그 정보가 담긴 샘플 상품
// 텍스트 자체가 안 보였기 때문 — Anthropic/Gemini/Ollama는 20,000자를 다 보므로 이 문제가 없다).
// 즉 Groq는 "완전한 대안"이 아니라 "느린 Ollama보다는 빠르게, 규칙 기반보다는 낫게" 채워주는 중간
// 단계로 보는 게 정확하다.
const GROQ_CONTEXT_CHAR_LIMIT = 5_000

// contextText는 위에서 이미 자르는데 categoryHints/sortHints는 그대로 프롬프트에 다 넣고 있었다 —
// 카테고리가 많은 몰(신우: 328개)은 이 목록만으로도 5,000자 넘게 나가 ITPM 7,000 한도를 넘겨버렸다
// (2026-09-06 실사용 확인: "Requested 12137" — contextText 5,000자와 별개로 카테고리 힌트 목록 자체가
// 병목이었음). 처음엔 앞쪽 40개만 잘라 보냈는데, 그러면 qwen이 잘린 뒤의 대분류는 아예 못 보고
// "나머지는 다수"로 뭉뚱그려 "카테고리 불러오기"(discoverCategoryLinks, 이런 한도 없이 전체를 그대로
// 보여줌)가 찾은 상세 구조와 딴판인 리포트가 나왔다(2026-09-06 실사용 확인, 사용자 지적 — "카테고리
// 불러오기 하면 159개를 상세히 찾는데 왜 groq 리포트는 대분류만 대충 찾았냐"). 단순히 앞부분만 자르는
// 대신 대분류별로 묶어 "대분류(하위 몇 개 중 대표 예시)"로 압축하면, 카테고리가 아무리 많아도 대분류
// 개수만큼만 늘어나 훨씬 적은 토큰으로 "실제로 몇 개 대분류에 하위가 각각 몇 개씩 있는지"까지 정확히
// 전달할 수 있다 — buildCategoryHintSummary 참고.
const GROQ_CATEGORY_HINT_EXAMPLES_PER_GROUP = 3

// max_tokens을 안 넘겨주면(기존 코드) Groq가 이 모델의 기본 최대 출력치를 그대로 "요청한 출력 크기"로
// 잡아 분당 출력 토큰(OTPM) 한도 자체를 넘겨버려 요청이 시작도 못 하고 거절된다(실사용 확인, 2026-09-05
// — 모자사러: "Request too large ... on output tokens per minute (OTPM): Limit 1000, Requested 1413",
// 이 계정 무료 등급의 OTPM 한도가 1,000인데 기본값만으로 1,413을 "요청"한 것으로 잡힘). 위 8,000
// TPM(입력 컨텍스트) 한도와는 별개의 한도라 컨텍스트를 더 줄여도 해결이 안 되고, Groq 에러 메시지가
// 직접 권하는 대로 max_tokens을 한도 아래로 명시해야 한다. 12개 필드 각각 "확인 안됨" 또는 한두 문장
// 짧은 답이라 900이면 정상적으로는 다 채우고도 여유가 있다 — 그래도 실제 답이 이보다 길어 잘리면
// JSON.parse가 실패해 아래 catch로 떨어지는데, 이는 기존에도 있던 안전한 폴백 경로와 같다(이 함수가
// null을 반환하면 호출부가 로컬 Ollama/규칙 기반으로 넘어감).
const GROQ_MAX_OUTPUT_TOKENS = 900

/** categoryHints("대분류 > 소분류" 문자열 배열, 최대 수백 개)를 대분류별로 묶어 "대분류(대표 소분류
 *  예시 몇 개 · 총 N개)" 형태로 압축한다 — 원본을 앞에서부터 그냥 자르면(이전 방식) 잘린 뒤의 대분류
 *  자체를 AI가 아예 못 보게 돼 "나머지는 다수"로 뭉뚱그리는 부정확한 리포트가 나온다. 대분류 단위로
 *  묶으면 카테고리가 아무리 많아도 프롬프트 길이는 "대분류 개수"에만 비례해서 늘어나고, 그 안에서도
 *  "이 대분류 밑에 정확히 몇 개가 있다"는 사실은 그대로 보존된다. */
function buildCategoryHintSummary(categoryHints: string[]): string {
  const groups = new Map<string, string[]>()
  for (const hint of categoryHints) {
    const sepIdx = hint.indexOf(' > ')
    const top = sepIdx === -1 ? hint : hint.slice(0, sepIdx)
    const sub = sepIdx === -1 ? '' : hint.slice(sepIdx + 3)
    if (!groups.has(top)) groups.set(top, [])
    if (sub) groups.get(top)!.push(sub)
  }
  return [...groups.entries()].map(([top, subs]) => {
    if (!subs.length) return top
    const examples = subs.slice(0, GROQ_CATEGORY_HINT_EXAMPLES_PER_GROUP).join(', ')
    return subs.length > GROQ_CATEGORY_HINT_EXAMPLES_PER_GROUP ? `${top}(${examples} 등 총 ${subs.length}개)` : `${top}(${examples})`
  }).join(', ')
}

/** Anthropic·Gemini가 둘 다 안 되면 Groq(무료, 빠름)로 시도하고, 그것도 안 되면(키 없음, 한도 초과 등)
 *  로컬 Ollama로 넘어간다. generatedBy를 'ai'가 아니라 'groq'로 따로 표시한다 — 이런 종합 추출에 얼마나
 *  정확한지 아직 실사용으로 검증된 적이 없어(도입 첫날, 2026-09-02), 클라우드 검증된 결과('ai')와는
 *  신뢰도를 구분해두는 편이 안전하다.
 *
 *  2026-09-06 실사용 확인(가방쟁이, 신우): 카테고리가 많은 몰일수록 categoryStructure를 하위 카테고리까지
 *  전부 나열하려 들어 GROQ_MAX_OUTPUT_TOKENS(900 — 계정 OTPM 한도 1,000 아래로 맞춘 값이라 더 못 올림)를
 *  다 쓰고도 못 끝내, Groq가 도구 호출 자체를 400 tool_use_failed로 거절했다(failed_generation을 보면
 *  qwen이 답 자체는 정확하게 만들고 있었다 — 그냥 다 쓰기엔 토큰이 모자랐을 뿐). "간결하게 답하라"는
 *  지시를 tool 함수 설명(딱 한 곳)에만 추가했다 — 이 계정은 입력 토큰(ITPM)도 분당 7,000으로 빠듯해서,
 *  같은 문구를 12개 필드 설명마다 반복하면 그만큼 입력 쪽에서 429/413을 더 유발한다(처음엔 필드마다
 *  반복했다가 이 문제로 다시 한 곳으로 합침). */
async function generateMallProfileReportGroq(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
  // generateMallProfileReportAnthropic의 onError 주석 참고 — 같은 이유로 실패 지점마다 이유를 알린다.
  onError?: (reason: string) => void,
): Promise<MallStructureReport | null> {
  if (!isAiProviderEnabled('groq')) { onError?.('공급자가 꺼져있음'); return null }
  if (!process.env.GROQ_API_KEY) { onError?.('API 키 없음'); return null }
  if (!contextText.trim()) { onError?.('분석할 원문이 수집되지 않음'); return null }
  const properties: Record<string, { type: string; description: string }> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: 'string', description: `${f.label} — ${f.hint}. 확인 못하면 "확인 안됨"만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(
    mallName, platform, categoryHints.length ? [buildCategoryHintSummary(categoryHints)] : [], sortHints, sampleProductUrl,
    contextText.slice(0, GROQ_CONTEXT_CHAR_LIMIT),
  )

  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: reportAiSignal(MALL_REPORT_GROQ_TIMEOUT_MS, signal),
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: GROQ_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_mall_report',
            description: `조사한 ${MALL_REPORT_FIELDS.length}개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다. `
              + `출력 예산이 작으니 항목마다 한두 문장, 100자 이내로 간결히 — 나열할 게 많아도 대표 몇 개만 들고 "등"으로 줄인다(categoryStructure는 특히 대분류 위주로만, 하위까지 다 나열하지 않는다).`,
            parameters: { type: 'object', required: MALL_REPORT_FIELDS.map(f => f.key), properties },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_mall_report' } },
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[generateMallProfileReportGroq] API call failed: ${res.status} ${detail}`)
      onError?.(`HTTP ${res.status}${detail ? `: ${extractReadableApiError(detail).slice(0, 150)}` : ''}`)
      return null
    }
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] }, finish_reason?: string }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    const finishReason = data.choices?.[0]?.finish_reason
    if (!call) { onError?.(`도구 호출 없이 응답함${finishReason ? `(finish_reason=${finishReason})` : ''}`); return null }
    if (finishReason === 'length') {
      // GROQ_MAX_OUTPUT_TOKENS 안에 다 못 채웠다는 뜻 — 실제로 이 몰의 답변이 예상보다 길었던 경우다.
      // arguments가 잘린 JSON일 가능성이 높아 아래 JSON.parse가 대개 실패하지만, 혹시 우연히 필드
      // 경계에서 끊겨 파싱에 성공하더라도 일부 필드가 통째로 빠졌을 수 있다는 걸 로그로 남겨둔다.
      console.error('[generateMallProfileReportGroq] 응답이 max_tokens에 걸려 잘렸을 수 있음(finish_reason=length)')
    }
    const args = JSON.parse(call.function.arguments)
    if (!args || typeof args !== 'object') { onError?.('도구 인자가 객체가 아님'); return null }
    return { ...(args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'groq' }
  } catch (e) {
    const rawMessage = e instanceof Error ? e.message : String(e)
    console.error('[generateMallProfileReportGroq] API call failed:', rawMessage)
    onError?.(extractReadableApiError(rawMessage))
    return null
  }
}

/** Anthropic·Gemini가 둘 다 안 되면(크레딧 소진, 쿼터 초과 등) 로컬 Ollama로 마지막 시도한다.
 *  detectCategoryAnomalyOllama와 같은 큐/타임아웃 관행을 따른다 — 다만 이 리포트는 12개 항목을 동시에
 *  뽑는 훨씬 복잡한 종합 추론이라, 로컬 소형 모델이 그 이분판정(suspicious/reason)보다도 더 약할 수
 *  있다는 걸 감안해야 한다(원래 이 함수에 Ollama 폴백을 안 넣어뒀던 이유이기도 함) — 그래도 "클라우드가
 *  둘 다 막혔을 때 규칙 기반으로 완전히 떨어지는 것"보다는 낫다고 보고 마지막 폴백으로만 둔다.
 *  generatedBy를 'ai'가 아니라 'ollama'로 따로 표시해 화면에서 신뢰도를 구분한다. */
async function generateMallProfileReportOllama(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
  // generateMallProfileReportAnthropic의 onError 주석 참고 — 같은 이유로 실패 지점마다 이유를 알린다.
  onError?: (reason: string) => void,
): Promise<MallStructureReport | null> {
  if (!isAiProviderEnabled('ollama')) { onError?.('공급자가 꺼져있음'); return null }
  if (!contextText.trim()) { onError?.('분석할 원문이 수집되지 않음'); return null }
  const properties: Record<string, { type: string; description: string }> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: 'string', description: `${f.label} — ${f.hint}. 아래 원문에서 확인할 수 없으면 반드시 "확인 안됨"이라고만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText)

  return withOllamaQueue(async () => {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: reportAiSignal(MALL_REPORT_OLLAMA_TIMEOUT_MS, signal),
        dispatcher: ollamaDispatcher,
        body: JSON.stringify({
          model: OLLAMA_REPORT_MODEL,
          stream: false,
          think: false,
          options: OLLAMA_CHAT_OPTIONS,
          keep_alive: '30m',
          messages: [{ role: 'user', content: fitOllamaPrompt(prompt, '몰 구조분석 리포트') }],
          tools: [{
            type: 'function',
            function: {
              name: 'set_mall_report',
              description: `조사한 ${MALL_REPORT_FIELDS.length}개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.`,
              parameters: { type: 'object', required: MALL_REPORT_FIELDS.map(f => f.key), properties },
            },
          }],
        }),
      } as RequestInit)
      // 실패 경로가 넷(HTTP 오류 / 도구 호출 없음 / 인자 파싱 실패 / 예외)인데 예전엔 전부 그냥 null이라,
      // 화면엔 "AI 호출 실패"만 뜨고 이유는 어디에도 안 남았다 — 2026-09-13 투비즈온 조사에서 원인
      // (num_ctx 초과로 프롬프트가 잘려 도구 호출이 아예 안 나옴)을 찾는 데 로그가 하나도 도움이 안 됐다.
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        console.log(`[AI:ollama] 몰 구조분석 리포트 실패 — HTTP ${res.status}: ${detail}`)
        onError?.(`HTTP ${res.status}${detail ? `: ${extractReadableApiError(detail)}` : ''}`)
        return null
      }
      const data = await res.json() as {
        message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }
        prompt_eval_count?: number
      }
      const call = data.message?.tool_calls?.[0]
      if (!call) {
        console.log(`[AI:ollama] 몰 구조분석 리포트 실패 — 도구 호출 없이 일반 텍스트로 답함(입력 ${data.prompt_eval_count ?? '?'}토큰, num_ctx ${OLLAMA_NUM_CTX}). 답 앞부분: ${JSON.stringify((data.message?.content || '').slice(0, 120))}`)
        onError?.(`도구 호출 없이 일반 텍스트로 답함(입력 ${data.prompt_eval_count ?? '?'}토큰이 num_ctx ${OLLAMA_NUM_CTX} 초과했을 수 있음)`)
        return null
      }
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
      if (!args || typeof args !== 'object') {
        console.log('[AI:ollama] 몰 구조분석 리포트 실패 — 도구 인자가 객체가 아님')
        onError?.('도구 인자가 객체가 아님')
        return null
      }
      return { ...(args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ollama' }
    } catch (e) {
      // fetch failed(UND_ERR_HEADERS_TIMEOUT)라면 ollamaDispatcher가 제대로 안 붙은 것이다 —
      // 그 상수 주석 참고.
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      console.log(`[AI:ollama] 몰 구조분석 리포트 실패 — ${message}`)
      onError?.(message)
      return null
    }
  })
}

/**
 * "몰 구조분석" 기능 — 실제로 수집한 원문(홈/게시판/상품페이지 텍스트)만 근거로 사용자가 알고 싶어하는
 * 12개 항목(URL 계층/카테고리/정렬/은행명/계좌번호/택배사/택배비/반품주소/재고관리/연락처/상품페이지 구조/
 * 스크래핑 유의사항)을 채운다. 원문에 없는 내용을 추측하지 않도록 프롬프트에서 명시적으로 금지하고,
 * 확인 못한 항목은 "확인 안됨"으로 답하게 한다. enabledProviders에 있는 공급자만, ALL_AI_PROVIDERS 순서
 * (Anthropic → Gemini → Groq → 로컬 Ollama — 유료 둘을 먼저, 그다음 무료 중 빠른 Groq, 느린 로컬
 * Ollama는 맨 마지막)대로 하나씩 시도해 처음 성공한 결과를 쓴다 — 전부 실패하거나 enabledProviders가
 * 비었거나 원문을 하나도 못 모았으면 null(호출부가 규칙 기반으로 대체). */
/** AiReportAttempt.model을 채우는 데 쓴다 — 공급자 하나당 리포트 생성에 실제로 쓰는 모델이 고정 하나뿐이라
 *  (Ollama만 다른 함수(pickIndicesWithOllamaOnce)에서는 별도로 OLLAMA_MODEL을 쓰지만, 이 리포트 생성
 *  함수는 항상 OLLAMA_REPORT_MODEL만 쓴다) 정적으로 매핑해도 어긋날 일이 없다. */
const AI_REPORT_PROVIDER_MODEL: Record<AiProviderId, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: GEMINI_MODEL,
  groq: GROQ_MODEL,
  ollama: OLLAMA_REPORT_MODEL,
}

export async function generateMallProfileReport(
  mallName: string,
  platform: string,
  categoryHints: string[],
  sortHints: string[],
  sampleProductUrl: string,
  contextText: string,
  enabledProviders: AiProviderId[] = ALL_AI_PROVIDERS,
  signal?: AbortSignal,
  // AiReportAttempt 주석 참고 — 진행 중 화면 표시(onEvent)와 최종 상세 요약(log) 둘 다 이 호출 하나가
  // 채운다. 둘 다 없어도(기존 호출부) 동작은 그대로라 하위호환 안 깨짐.
  log?: AiReportAttempt[],
  onEvent?: (event: { provider: AiProviderId; model: string; phase: 'start' } | ({ phase: 'done' } & AiReportAttempt)) => void,
): Promise<MallStructureReport | null> {
  // 각 generateMallProfileReportXxx가 실패를 전부 내부에서 삼키고 null만 반환해왔다(호출부가 던지는
  // 예외를 못 잡으니 여기 catch로는 "왜" 실패했는지 알 수 없었다, 2026-09-13/2026-09-23 실사용 확인 —
  // 화면엔 "AI 호출 실패"만 뜨고 실제 원인인 크레딧 부족/한도 초과는 안 보였음). 그래서 4개 함수 모두
  // 마지막 인자로 onError를 받아 null을 반환하는 모든 지점에서 이유를 직접 알려준다 — 아래 fn 클로저가
  // 그 콜백을 받아 넘긴다.
  const providers: { id: AiProviderId; fn: (onError: (reason: string) => void) => Promise<MallStructureReport | null> }[] = [
    { id: 'anthropic', fn: (onError) => generateMallProfileReportAnthropic(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal, onError) },
    { id: 'gemini', fn: (onError) => generateMallProfileReportGemini(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal, onError) },
    { id: 'groq', fn: (onError) => generateMallProfileReportGroq(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal, onError) },
    { id: 'ollama', fn: (onError) => generateMallProfileReportOllama(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal, onError) },
  ]
  for (const p of providers) {
    // 몰구조분석 중지/PTP 탭 종료로 이미 취소됐으면 다음 공급자로 폴백을 계속 시도할 이유가 없다 —
    // 어차피 그 결과도 곧 버려질 것이므로 남은 API 호출(과금/무료한도 소모)을 아낀다.
    if (signal?.aborted) return null
    if (!enabledProviders.includes(p.id)) continue
    onEvent?.({ provider: p.id, model: AI_REPORT_PROVIDER_MODEL[p.id], phase: 'start' })
    const startedAt = Date.now()
    let errorMsg: string | undefined
    const result = await p.fn(reason => { errorMsg = reason }).catch((e: unknown) => {
      // 이 catch는 onError가 못 잡는 경우(함수 자체가 예외를 던지는, 지금은 없지만 앞으로 생길 수 있는
      // 경로)를 위한 안전망 — onError가 이미 채웠으면 그 값을 우선한다.
      errorMsg = errorMsg ?? (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      console.log(`[AI:${p.id}] 몰 구조분석 리포트 실패 — ${errorMsg}`)
      return null
    })
    const attempt: AiReportAttempt = {
      provider: p.id,
      model: AI_REPORT_PROVIDER_MODEL[p.id],
      elapsedMs: Date.now() - startedAt,
      success: !!result,
      error: result ? undefined : translateAiErrorReason(errorMsg ?? '결과 없음(원인 미상)'),
    }
    log?.push(attempt)
    onEvent?.({ ...attempt, phase: 'done' })
    if (result) return result
    console.log(`[AI:${p.id}] 몰 구조분석 리포트를 못 만듦 — 다음 공급자로 넘어감(남은 공급자: ${providers.slice(providers.indexOf(p) + 1).filter(n => enabledProviders.includes(n.id)).map(n => n.id).join(', ') || '없음 → 규칙 기반으로 대체'})`)
  }
  return null
}

export interface CategoryAnomalyVerdict { suspicious: boolean; reason: string; source: 'anthropic' | 'gemini' }

const CATEGORY_ANOMALY_TIMEOUT_MS = 20_000

/** 두 AI 함수(Anthropic/Gemini)가 공유하는 프롬프트 — 봇 차단/로그인 안내 페이지의 링크가 "카테고리"로
 *  잘못 저장됐던 사고(2026-08-29, 펫토리: veritas-hub.cafe24.com/challenge?auth=... 링크 110개가 카테고리로
 *  둔갑)의 재발을 사람이 매번 눈으로 확인하지 않아도 감지하기 위한 안전망. migratedLabels(마이그레이션
 *  확정된 상품의 실제 카테고리명)와 manualCategoryUrls(사용자가 몰에 직접 들어가 확인한 카테고리 URL —
 *  이름은 없음, URL 패턴만 참고)를 "검증된 과거 증거"로 주고, freshLinks(방금 새로 찾은 카테고리)가
 *  이것과 터무니없이 다른지 판단시킨다. 몰이 실제로 메뉴를 개편했을 수 있으니 "완전 일치"를 요구하지
 *  않는다 — 새 목록이 페이지 탐색/로그인 안내/무관한 텍스트처럼 보이거나 두 증거 중 어느 쪽과도 URL
 *  패턴이 하나도 안 겹칠 때만 의심하도록 명시한다. */
function buildCategoryAnomalyPrompt(
  mallName: string, freshLinks: { name: string; href: string }[], migratedLabels: string[], manualCategoryUrls: string[],
): string {
  const freshList = freshLinks.slice(0, 60).map(l => `- ${l.name} (${l.href})`).join('\n')
  const migratedList = migratedLabels.length ? migratedLabels.slice(0, 40).map(l => `- ${l}`).join('\n') : '(없음)'
  const manualList = manualCategoryUrls.length ? manualCategoryUrls.slice(0, 20).map(u => `- ${u}`).join('\n') : '(없음)'
  return `쇼핑몰 "${mallName}"의 카테고리 구조를 방금 새로 자동 탐지했다. 이 결과가 신뢰할 만한지 판단해줘.

## 새로 찾은 카테고리 목록 (이번 탐지 결과)
${freshList || '(없음)'}

## 증거 ①: 실제로 스크랩→검수→마이그레이션 확정까지 끝난 과거 카테고리명
${migratedList}

## 증거 ②: 사용자가 이 몰에 직접 로그인해 카테고리 페이지로 이동한 뒤 확인한 URL(이름 정보는 없음 — URL 경로/파라미터 패턴만 참고)
${manualList}

중요: 새 목록이 증거 ①·②와 겹치는 항목이 있다는 것은 "의심스러운 신호"가 아니라 정반대로 "이 몰의 진짜
카테고리를 제대로 찾았다는 안심 신호"다 — 겹침 자체를 절대 suspicious 사유로 쓰지 마라. 몰이 실제로 메뉴를
개편했을 수 있으니 증거와 일부만 겹치거나 새 항목이 섞여 있는 정도도 정상이다 — 완전 일치를 요구하지 마라.
다만 "새로 찾은 카테고리 목록"이 아래 중 하나에 해당하면 suspicious:true로 판단해라:
- 실제 상품 분류명이 아니라 페이지 탐색/로그인 안내/에러 안내처럼 보이는 이름(예: "컨텐츠 바로가기", "로그인", "이전 페이지" 등)이 다수 섞여 있다.
- href가 이 몰의 실제 도메인이 아닌 다른 도메인(로그인 우회, 보안 인증, 광고 등)을 가리키는 게 다수다.
- 증거 ①·②가 모두 존재하는데(즉 비교할 근거가 있는데) 새 목록의 URL 패턴이 증거와 단 하나도 겹치지 않는다.
확실하지 않으면 suspicious:false로 판단해라(과잉 경고보다 누락이 낫다).`
}

async function detectCategoryAnomalyAnthropic(
  mallName: string, freshLinks: { name: string; href: string }[], migratedLabels: string[], manualCategoryUrls: string[],
): Promise<CategoryAnomalyVerdict | null> {
  if (!process.env.ANTHROPIC_API_KEY || !freshLinks.length) return null
  const prompt = buildCategoryAnomalyPrompt(mallName, freshLinks, migratedLabels, manualCategoryUrls)
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      tools: [{
        name: 'set_category_anomaly_verdict',
        description: '새로 찾은 카테고리 목록이 의심스러운지 판정한다.',
        input_schema: {
          type: 'object',
          properties: {
            suspicious: { type: 'boolean', description: '터무니없어 보이면 true' },
            reason: { type: 'string', description: '판단 근거를 한두 문장으로. suspicious가 false여도 간단히 채운다.' },
          },
          required: ['suspicious', 'reason'],
        },
      }],
      tool_choice: { type: 'tool', name: 'set_category_anomaly_verdict' },
      messages: [{ role: 'user', content: prompt }],
    }, { signal: AbortSignal.timeout(CATEGORY_ANOMALY_TIMEOUT_MS) })
    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') return null
    return { ...(toolUse.input as Omit<CategoryAnomalyVerdict, 'source'>), source: 'anthropic' }
  } catch (e) {
    console.error('[detectCategoryAnomalyAnthropic] API call failed:', e instanceof Anthropic.APIError ? e.message : e instanceof Error ? e.message : e)
    return null
  }
}

async function detectCategoryAnomalyGemini(
  mallName: string, freshLinks: { name: string; href: string }[], migratedLabels: string[], manualCategoryUrls: string[],
): Promise<CategoryAnomalyVerdict | null> {
  if (!process.env.GEMINI_API_KEY || !freshLinks.length) return null
  const prompt = buildCategoryAnomalyPrompt(mallName, freshLinks, migratedLabels, manualCategoryUrls)
  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_category_anomaly_verdict',
          description: '새로 찾은 카테고리 목록이 의심스러운지 판정한다.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              suspicious: { type: Type.BOOLEAN, description: '터무니없어 보이면 true' },
              reason: { type: Type.STRING, description: '판단 근거를 한두 문장으로. suspicious가 false여도 간단히 채운다.' },
            },
            required: ['suspicious', 'reason'],
          },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_category_anomaly_verdict'] } },
        abortSignal: AbortSignal.timeout(CATEGORY_ANOMALY_TIMEOUT_MS),
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) return null
    return { ...(call.args as unknown as Omit<CategoryAnomalyVerdict, 'source'>), source: 'gemini' }
  } catch (e) {
    console.error('[detectCategoryAnomalyGemini] API call failed:', e instanceof Error ? e.message : e)
    return null
  }
}

/** "카테고리 불러오기"/"몰 구조분석"이 새로 찾은 카테고리 구조가 터무니없는지 AI로 한 번 더 확인한다 —
 *  검증된 과거 카테고리(마이그레이션 확정분 + 사용자가 직접 확인한 URL)와 비교해 판단한다. Anthropic →
 *  Gemini 순으로 시도하고, 둘 다 실패하면 null(판단 불가 = 경고 안 함, 오탐으로 정상 결과를 막지 않기
 *  위해 fail-open). 호출부(lib/scrape/categoryAnomalyCheck.ts)가 애초에 비교할 과거 증거가 충분할 때만
 *  이 함수를 부른다.
 *  로컬 Ollama(detectCategoryAnomalyOllama)는 예전엔 세 번째 폴백이었는데 뺐다(2026-09-03) — 이 검사는
 *  applyProfileResult가 응답을 기다리지 않고 항상 백그라운드로 돌리는 데다(mallProfile.ts 주석 참고),
 *  "몰 구조분석" 화면의 AI 공급자 체크박스와 전혀 무관하게 실행돼, 사용자가 화면에서 Ollama를 꺼놔도
 *  Anthropic/Gemini가 실패할 때마다(이 세션 내내 그랬음) 조용히 Ollama를 불러 CPU를 오래 붙잡았다 —
 *  체크박스를 꺼도 왜 `llama-server.exe`가 계속 메모리에 남아있는지 사용자가 작업관리자로 직접 확인해
 *  지적함. 이 검사 자체가 fail-open(못 하면 그냥 경고 없이 넘어감)이라 완전히 꺼도 손실이 적다. */
export async function detectCategoryAnomaly(
  mallName: string, freshLinks: { name: string; href: string }[], migratedLabels: string[], manualCategoryUrls: string[],
): Promise<CategoryAnomalyVerdict | null> {
  return await detectCategoryAnomalyAnthropic(mallName, freshLinks, migratedLabels, manualCategoryUrls).catch(() => null)
    ?? await detectCategoryAnomalyGemini(mallName, freshLinks, migratedLabels, manualCategoryUrls).catch(() => null)
}

const COURIER_NAMES = ['CJ대한통운', '한진택배', '로젠택배', '우체국택배', '롯데택배', '경동택배', '대신택배', '합동택배', '일양로지스', 'CU편의점택배', 'GS Postbox']
const BANK_NAMES = ['국민은행', '신한은행', '우리은행', '하나은행', '기업은행', '농협', '카카오뱅크', '토스뱅크', 'SC제일은행', '씨티은행', '우체국']

function findCourier(text: string): string {
  // "CJ 대한통운"처럼 띄어쓰기가 섞인 표기가 실제로 있어(실사용 몰 확인됨) 공백을 지우고 비교한다.
  const flat = text.replace(/\s+/g, '')
  const found = COURIER_NAMES.filter(name => flat.includes(name.replace(/\s+/g, '')))
  return found.length ? found.join(', ') : '확인 안됨'
}

function findBankName(text: string): string {
  return BANK_NAMES.find(b => text.includes(b)) || '확인 안됨'
}

function findAccountNumber(text: string, bank: string): string {
  // 은행명을 못 찾았으면 원문 전체에서 "숫자-숫자-숫자" 패턴을 그냥 찾지 않는다 — 전화번호
  // (031-523-3090), 사업자등록번호(113-88-01792) 등도 같은 모양이라 계좌번호로 오인하는 문제가
  // 실제 발견됐다(가방쟁이). 은행명 주변(보통 계좌번호가 바로 붙어 나옴)에서만 찾는다.
  if (bank === '확인 안됨') return '확인 안됨'
  const around = text.slice(text.indexOf(bank), text.indexOf(bank) + 60)
  // 계좌번호는 은행마다 구간이 2~4개로 다르다(예: 농협 "312-0121-8472-61") — 뒤 구간 수를 고정하지 않는다.
  return around.match(/\d{2,6}(?:-\d{2,10}){1,3}/)?.[0] || '확인 안됨'
}

function findShippingFee(text: string): string {
  // "기본배송료는 3,500원 입니다"처럼 "배송료"(료)로 쓰는 몰도 있다(실사용 몰 확인됨) — "배송비"만
  // 찾으면 뒤에 나오는 "도서산간 추가배송비" 같은 부차적인 문장에 매칭돼 정작 기본요금을 놓친다.
  const m = text.match(/(배송비|배송료|택배비)[:\s]{0,10}[^\n]{0,60}/)
  return m ? m[0].replace(/\s+/g, ' ').trim() : '확인 안됨'
}

function findReturnAddress(text: string): string {
  // "반송 주소"처럼 "반품"이 아니라 "반송"이라는 단어를 쓰는 몰도 있다(실사용 확인) — 같은 뜻이라 함께 찾는다.
  const idx = text.search(/반품\s*(주소|받는\s*곳|보내는\s*곳)?|반송\s*(주소)?|교환\s*(주소|반품)/)
  if (idx === -1) return '확인 안됨'
  return text.slice(idx, idx + 100).replace(/\s+/g, ' ').trim()
}

function findContact(text: string): string {
  const phone = text.match(/0\d{1,2}-\d{3,4}-\d{4}/)?.[0]
  const email = text.match(/[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/)?.[0]
  return [phone, email].filter(Boolean).join(' / ') || '확인 안됨'
}

/**
 * generateMallProfileReport의 AI 호출 없이(과금 없이) 같은 11개 항목을 채우는 대체 경로 — ANTHROPIC_API_KEY
 * 크레딧이 없어도 "몰 구조분석"이 동작해야 한다는 요구에 따른 것(월 정액 claude.ai/Claude Code 구독과
 * Anthropic API 크레딧은 별개 — 이 앱의 API 호출은 구독으로 대체할 방법이 없어, 과금 자체를 안 쓰는 이
 * 경로를 대신 마련했다). URL 계층/카테고리/재고/상품페이지 구조는 이미 확보된 구조적 신호를 그대로
 * 문장으로 조립하고(신뢰도 높음), 은행명/계좌번호/택배사/택배비/반품주소/연락처는 원문에서 알려진
 * 은행명·택배사명·전화번호·이메일·"배송비"/"반품" 키워드 주변 텍스트를 찾는 정규식/키워드 매칭이다
 * (AI보다 재현율은 낮지만 오탐은 적음). scrapingNeeds는 자유 서술이 필요한 항목이라 규칙 기반으로는
 * 만들 수 없어 규칙 기반임을 알리는 문구로 대체한다.
 */
export function buildHeuristicMallReport(input: {
  platform: string
  categoryHints: string[]
  sortHints: string[]
  sampleProductUrl: string
  contextText: string
  optionUiTypes: string[]
  hasCascadingOptions: boolean
  hasMainImages: boolean
  hasDetailImages: boolean
  hasDetailText: boolean
  hasStockQty: boolean
  hasStockStatusText: boolean
  hasStockByOption: boolean
}): MallStructureReport {
  const bankName = findBankName(input.contextText)
  return {
    urlHierarchy: input.sampleProductUrl ? `상품 상세 URL 예시: ${input.sampleProductUrl} (플랫폼: ${input.platform})` : '확인 안됨',
    categoryStructure: input.categoryHints.length ? input.categoryHints.join(', ') : '확인 안됨',
    sortStructure: input.sortHints.length ? input.sortHints.join(', ') : '확인 안됨',
    bankName,
    accountNumber: findAccountNumber(input.contextText, bankName),
    shippingCourier: findCourier(input.contextText),
    shippingFeeInfo: findShippingFee(input.contextText),
    returnAddress: findReturnAddress(input.contextText),
    stockManagementType: [
      input.hasStockQty && '재고수량 표시',
      input.hasStockStatusText && '재고상태 문구 표시',
      input.hasStockByOption && '옵션별 재고 위젯',
    ].filter(Boolean).join(', ') || '확인 안됨',
    companyContact: findContact(input.contextText),
    productPageStructure: [
      input.hasMainImages && '대표이미지 있음',
      input.hasDetailImages && '상세이미지 있음',
      input.hasDetailText && '상세설명 텍스트 있음',
      input.optionUiTypes.length && `옵션 UI: ${input.optionUiTypes.join('/')}`,
      input.hasCascadingOptions && '연쇄옵션 있음',
    ].filter(Boolean).join(', ') || '확인 안됨',
    scrapingNeeds: 'AI 미사용(규칙 기반) 리포트 — 정확도가 AI 분석보다 낮을 수 있으니 실제 페이지와 대조 확인 권장',
    generatedBy: 'heuristic',
  }
}

export interface AiExtractedFallback {
  name: string | null
  price: number | null
}

/**
 * 규칙 기반 추출(schema.org/og메타/가격패턴)이 전부 실패했을 때 마지막 수단으로 쓰는 폴백.
 * 페이지의 눈에 보이는 텍스트를 그대로 Claude에 던져 상품명/가격만 뽑아낸다 — 나머지 필드는 규칙 기반 결과를 그대로 쓴다.
 * ANTHROPIC_API_KEY가 없으면 조용히 null을 반환한다(폴백 자체를 건너뜀).
 */
export async function extractProductFieldsWithAI(pageText: string): Promise<AiExtractedFallback> {
  if (!process.env.ANTHROPIC_API_KEY) return { name: null, price: null }
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `다음은 쇼핑몰 상품 상세페이지에서 눈에 보이는 텍스트를 그대로 가져온 것입니다. 상품명과 판매가격(원, 숫자만)을 찾아 JSON으로만 답해주세요. 못 찾으면 null로 표시하세요.\n형식: {"name": "...", "price": 12345}\n\n${pageText.slice(0, 4000)}`,
      }],
      // generateAutoExtractionRules와 같은 이유로 추가(2026-09-02) — 규칙 기반 추출이 전부 실패했을 때
      // 상품마다 반복될 수 있는 마지막 폴백이라, 타임아웃 없이 걸리면 스크랩 전체가 멈춘다.
    }, { signal: AbortSignal.timeout(MALL_REPORT_TIMEOUT_MS) })
    const text = (response.content[0] as { type: string; text: string }).text
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return { name: null, price: null }
    const parsed = JSON.parse(match[0]) as { name?: string | null; price?: number | null }
    return { name: parsed.name || null, price: typeof parsed.price === 'number' ? parsed.price : null }
  } catch {
    return { name: null, price: null }
  }
}
