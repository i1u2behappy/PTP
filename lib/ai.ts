import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, FunctionCallingConfigMode, Type, type Schema } from '@google/genai'

/** "몰 구조분석" 리포트(generateMallProfileReport)가 시도할 수 있는 AI 공급자 — 사용자가 화면에서
 *  체크박스로 켜고 끌 수 있다(2026-09-02, 사용자 요청: "엔트로픽/제미나이/올라마 체크해서 쓰게 해달라,
 *  나중에 다른 AI도 더 붙일 수 있게"). 새 공급자를 추가하려면: 1) 여기 AiProviderId에 id 추가, 2) 이
 *  파일에 XxxYyy(mallName, ...) 형태의 생성 함수 추가, 3) generateMallProfileReport의 providers 배열에
 *  { id, label, fn } 한 줄 추가 — 그러면 이 순서가 그대로 화면 체크박스 순서 및 폴백 순서가 된다.
 *  components/panels/ScraperPanel.tsx가 같은 목록을 (서버 전용 SDK를 클라이언트 번들에 안 실으려고)
 *  별도로 들고 있으니, 공급자를 추가/삭제하면 그쪽 AI_PROVIDER_OPTIONS도 같이 맞춰야 한다. */
export type AiProviderId = 'anthropic' | 'gemini' | 'groq' | 'ollama'
export const ALL_AI_PROVIDERS: AiProviderId[] = ['anthropic', 'gemini', 'groq', 'ollama']

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
// qwen3:8b는 실측 비교(2026-08-30)에서 봇차단 페이지 링크를 카테고리로 오인하는 사고를 놓쳐 로컬에서
// 삭제하고 qwen3:14b로 교체했다(.env.local의 OLLAMA_MODEL) — 이 하드코드 기본값도 실제 설치된 모델과
// 맞춰둔다(env var가 없는 환경에서 이미 지운 8b를 다시 찾는 걸 방지).
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b'

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

/** signal(선택)을 넘기면 "몰 구조분석 중지" 버튼이 이 호출까지 실제로 끊는다 — CPU 연산 자체인 로컬
 *  추론은 끊자마자 Ollama(llama-server)도 그 요청의 생성을 멈춘다(fetch abort 시 서버가 요청 컨텍스트
 *  취소를 감지하는 표준 동작, 2026-08-22 사용자 요청: "중지를 누르면 llama-server 작업도 멈추게"). */
function pickIndicesWithOllama(
  prompt: string, toolName: string, toolDescription: string, signal?: AbortSignal, timeoutMs = OLLAMA_TIMEOUT_MS,
): Promise<number[]> {
  return withOllamaQueue(() => pickIndicesWithOllamaOnce(prompt, toolName, toolDescription, signal, timeoutMs))
}

async function pickIndicesWithOllamaOnce(
  prompt: string, toolName: string, toolDescription: string, signal?: AbortSignal, timeoutMs = OLLAMA_TIMEOUT_MS,
): Promise<number[]> {
  // AbortSignal.timeout()과 호출부의 signal(중지 버튼) 둘 중 먼저 오는 쪽으로 끊는다 — 이 호출이 정상
  // 범위(수 초~십수 초)를 넘기면 모델이 텍스트로 새고 있다고 보고 자른다. AbortSignal.any는 Node 20+.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: combinedSignal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        // 모델이 세션 중 계속 메모리에 남아있게(콜드스타트 자체는 실제로 막아준다 — 다만 위 주석대로
        // 이게 300초 지연의 진짜 원인은 아니었다).
        keep_alive: '30m',
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
      }),
    })
    if (!res.ok) return []
    const data = await res.json() as { message?: { tool_calls?: { function: { name: string; arguments: unknown } }[] } }
    const call = data.message?.tool_calls?.[0]
    if (!call) return []
    // Ollama는 arguments를 이미 파싱된 객체로 주지만, 혹시 문자열로 오는 경우까지 방어적으로 처리한다.
    const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
    const indices = (args as { indices?: unknown } | null)?.indices
    return Array.isArray(indices) ? indices.filter((i): i is number => Number.isInteger(i)) : []
  } catch {
    // 위 timeoutSignal이 끊은 경우도 여기로 온다 — 호출부는 빈 배열을 기존 히스틱/미검출 폴백과
    // 똑같이 취급하므로 "느려서 포기"와 "원래 실패"를 구분할 필요가 없다.
    return []
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

  const indices = await pickIndicesWithOllama(
    prompt, 'set_category_link_indices',
    '실제 상품 카테고리 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
    signal, timeoutMs,
  )
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
 *  주석 참고). 인덱스 하나(또는 빈 배열)만 반환하는 아주 짧은 답이라 50이면 충분하다. 키가 없거나 실패하면
 *  조용히 null — 호출부가 로컬 Ollama로 넘어간다. */
async function pickLastPageIndexWithGroq(prompt: string, signal?: AbortSignal): Promise<number[] | null> {
  if (!process.env.GROQ_API_KEY) return null
  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)]) : AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'function',
          function: {
            name: 'set_last_page_link_index',
            description: LAST_PAGE_TOOL_DESCRIPTION,
            parameters: {
              type: 'object',
              required: ['indices'],
              properties: { indices: { type: 'array', items: { type: 'integer' }, description: '고른 항목들의 0-based 인덱스 목록' } },
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'set_last_page_link_index' } },
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

  let indices = await pickLastPageIndexWithGroq(prompt, signal)
  if (indices === null) {
    // Groq가 키 없음/한도 초과/오류로 실패했을 때만 로컬 Ollama를 시도한다 — Groq가 "성공적으로 빈 배열"을
    // 반환했을 때(확신 없어 안 고름)는 이미 유효한 답이므로 Ollama로 다시 물어보지 않는다.
    indices = await pickIndicesWithOllama(prompt, 'set_last_page_link_index', LAST_PAGE_TOOL_DESCRIPTION, signal)
  }
  const i = indices[0]
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
 * 인덱스로만 반환 — 할루시네이션 방지)으로 로컬 Ollama(pickIndicesWithOllama)를 쓴다. 실패하면 조용히
 * 빈 배열 — 호출부가 "정렬 옵션 없음"으로 처리한다.
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

  const indices = await pickIndicesWithOllama(
    prompt, 'set_sort_option_indices',
    '정렬 기준 링크라고 확신하는 항목의 인덱스만 반환한다. 확신 없는 항목은 넣지 않는다.',
    signal,
  )
  const seen = new Set<number>()
  return indices
    .filter(i => i >= 0 && i < candidates.length && !seen.has(i) && seen.add(i))
    .map(i => ({ label: candidates[i].text, href: candidates[i].href }))
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
   *  한다. 'groq'도 같은 이유로 분리했다 — Llama 3.3 70B가 이 추출 작업에 얼마나 정확한지 아직 실사용
   *  검증이 없다(도입 첫날, 2026-09-02). */
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

async function generateMallProfileReportAnthropic(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
): Promise<MallStructureReport | null> {
  if (!process.env.ANTHROPIC_API_KEY || !contextText.trim()) return null

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
    if (!toolUse || toolUse.type !== 'tool_use') return null
    return { ...(toolUse.input as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ai' }
  } catch (e) {
    console.error('[generateMallProfileReportAnthropic] API call failed:', e instanceof Anthropic.APIError ? e.message : e instanceof Error ? e.message : e)
    return null
  }
}

/** Anthropic이 안 되면(크레딧 부족 등) Gemini로 같은 리포트를 시도한다 — "AI모드 스크래핑"/"스크랩 조정"과
 *  같은 GEMINI_API_KEY를 재사용. GEMINI_API_KEY가 없거나 원문이 없으면 null(호출부가 규칙 기반으로 대체). */
async function generateMallProfileReportGemini(
  mallName: string, platform: string, categoryHints: string[], sortHints: string[], sampleProductUrl: string, contextText: string,
  signal?: AbortSignal,
): Promise<MallStructureReport | null> {
  if (!process.env.GEMINI_API_KEY || !contextText.trim()) return null

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
    if (!call) return null
    return { ...(call.args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ai' }
  } catch (e) {
    console.error('[generateMallProfileReportGemini] API call failed:', e instanceof Error ? e.message : e)
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
): Promise<MallStructureReport | null> {
  if (!process.env.GROQ_API_KEY || !contextText.trim()) return null
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
      console.error(`[generateMallProfileReportGroq] API call failed: ${res.status} ${await res.text().catch(() => '')}`)
      return null
    }
    const data = await res.json() as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] }, finish_reason?: string }[] }
    const call = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!call) return null
    if (data.choices?.[0]?.finish_reason === 'length') {
      // GROQ_MAX_OUTPUT_TOKENS 안에 다 못 채웠다는 뜻 — 실제로 이 몰의 답변이 예상보다 길었던 경우다.
      // arguments가 잘린 JSON일 가능성이 높아 아래 JSON.parse가 대개 실패하지만, 혹시 우연히 필드
      // 경계에서 끊겨 파싱에 성공하더라도 일부 필드가 통째로 빠졌을 수 있다는 걸 로그로 남겨둔다.
      console.error('[generateMallProfileReportGroq] 응답이 max_tokens에 걸려 잘렸을 수 있음(finish_reason=length)')
    }
    const args = JSON.parse(call.function.arguments)
    if (!args || typeof args !== 'object') return null
    return { ...(args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'groq' }
  } catch (e) {
    console.error('[generateMallProfileReportGroq] API call failed:', e instanceof Error ? e.message : e)
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
): Promise<MallStructureReport | null> {
  if (!contextText.trim()) return null
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
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          think: false,
          keep_alive: '30m',
          messages: [{ role: 'user', content: prompt }],
          tools: [{
            type: 'function',
            function: {
              name: 'set_mall_report',
              description: `조사한 ${MALL_REPORT_FIELDS.length}개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.`,
              parameters: { type: 'object', required: MALL_REPORT_FIELDS.map(f => f.key), properties },
            },
          }],
        }),
      })
      if (!res.ok) return null
      const data = await res.json() as { message?: { tool_calls?: { function: { name: string; arguments: unknown } }[] } }
      const call = data.message?.tool_calls?.[0]
      if (!call) return null
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
      if (!args || typeof args !== 'object') return null
      return { ...(args as Omit<MallStructureReport, 'generatedBy'>), generatedBy: 'ollama' }
    } catch {
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
export async function generateMallProfileReport(
  mallName: string,
  platform: string,
  categoryHints: string[],
  sortHints: string[],
  sampleProductUrl: string,
  contextText: string,
  enabledProviders: AiProviderId[] = ALL_AI_PROVIDERS,
  signal?: AbortSignal,
): Promise<MallStructureReport | null> {
  const providers: { id: AiProviderId; fn: () => Promise<MallStructureReport | null> }[] = [
    { id: 'anthropic', fn: () => generateMallProfileReportAnthropic(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal) },
    { id: 'gemini', fn: () => generateMallProfileReportGemini(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal) },
    { id: 'groq', fn: () => generateMallProfileReportGroq(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal) },
    { id: 'ollama', fn: () => generateMallProfileReportOllama(mallName, platform, categoryHints, sortHints, sampleProductUrl, contextText, signal) },
  ]
  for (const p of providers) {
    // 몰구조분석 중지/PTP 탭 종료로 이미 취소됐으면 다음 공급자로 폴백을 계속 시도할 이유가 없다 —
    // 어차피 그 결과도 곧 버려질 것이므로 남은 API 호출(과금/무료한도 소모)을 아낀다.
    if (signal?.aborted) return null
    if (!enabledProviders.includes(p.id)) continue
    const result = await p.fn().catch(() => null)
    if (result) return result
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
