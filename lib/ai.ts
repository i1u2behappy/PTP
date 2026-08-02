import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, FunctionCallingConfigMode, Type, type Schema } from '@google/genai'

// 매 호출마다 새로 생성 — 모듈 로드 시점에 키를 고정하면 .env 값을 나중에 바꿔도
// (dev 서버가 모듈을 재평가하지 않는 한) 예전 키가 계속 쓰이는 문제가 있었다.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// 원래 "AI모드 스크래핑"(규칙 자동생성 + 옵션 판별)과 "스크랩 조정"(사용자 지적 기반 규칙 생성) 전용으로
// (Anthropic 크레딧을 충전하지 않기로 하고) 도입했다가, "몰 구조 파악"도 Anthropic이 실패하면(크레딧
// 부족 등) 이 Gemini로 자동 재시도하도록 확장함(2026-07-29) — generateMallProfileReport 참고. 나머지 AI
// 기능(상품명 생성/Transform)은 여전히 Anthropic 전용.
function getGeminiClient() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
}
// 'gemini-2.5-flash'는 신규 사용자에게 더는 제공되지 않아(실제 API 호출로 확인, 2026-07-26)
// 항상 최신 flash 모델을 가리키는 별칭을 쓴다 — 특정 버전이 나중에 또 폐기돼도 코드를 안 고쳐도 된다.
const GEMINI_MODEL = 'gemini-flash-latest'

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
    })

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
    })
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
  /** "몰 구조 파악"으로 미리 확인해둔 이 몰의 구조 정보(있으면) — 플랫폼/옵션 UI 형태/재고 표기 방식 등을
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
    ? `\n[이 몰에 대해 "몰 구조 파악"으로 미리 확인해둔 정보 — 참고만 하고, 실제 페이지 내용과 다르면 실제 페이지를 따른다]\n${JSON.stringify(mallProfile)}\n`
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
 * 상품명 생성, Transform)은 전부 그대로 Anthropic을 쓴다 — 전체 교체가 아니다. ("몰 구조 파악"은 이후
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
    ? `\n[이 몰에 대해 "몰 구조 파악"으로 미리 확인해둔 정보 — 참고만 하고, 실제 페이지 내용과 다르면 실제 페이지를 따른다]\n${JSON.stringify(mallProfile)}\n`
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
      },
    })
    const call = response.functionCalls?.[0]
    if (!call) return {}
    const args = call.args as { rules?: Record<string, ExtractionRule> }
    return args.rules || {}
  } catch (e) {
    // generateExtractionRules(스크랩 조정)와 같은 이유로 그대로 던진다 — 조용히 삼키면 "AI가 확신을
    // 못 해서 규칙을 안 만든 것"과 "API 호출 자체가 실패한 것"(크레딧/네트워크 등)을 구분할 수 없다.
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

export interface MallStructureReport {
  urlHierarchy: string
  categoryStructure: string
  bankName: string
  accountNumber: string
  shippingCourier: string
  shippingFeeInfo: string
  returnAddress: string
  stockManagementType: string
  companyContact: string
  productPageStructure: string
  scrapingNeeds: string
  /** 이 리포트가 AI 분석인지 API 실패 시의 규칙 기반 대체 결과인지 — 화면에서 신뢰도를 구분해 보여주는 용도. */
  generatedBy: 'ai' | 'heuristic'
}

const MALL_REPORT_FIELDS: { key: keyof MallStructureReport; label: string; hint: string }[] = [
  { key: 'urlHierarchy', label: 'URL 계층', hint: '목록/상세 페이지 URL 패턴, 페이지네이션 방식' },
  { key: 'categoryStructure', label: '카테고리 구조', hint: '대분류/중분류 등 실제 카테고리 트리' },
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
 * "몰 구조 파악"을 실제 몰들에서 반복하며 얻은 경험적 지식 — PTP의 기본 노하우로 축적해, 다음에 처음
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
  mallName: string, platform: string, categoryHints: string[], sampleProductUrl: string, contextText: string,
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

[수집한 원문]
${contextText.slice(0, 20_000)}`
}

/** Anthropic으로 "몰 구조 파악" 리포트를 생성한다. ANTHROPIC_API_KEY가 없거나 크레딧 부족 등으로
 *  실패하면 null — 호출부(generateMallProfileReport)가 Gemini로 재시도한다. */
async function generateMallProfileReportAnthropic(
  mallName: string, platform: string, categoryHints: string[], sampleProductUrl: string, contextText: string,
): Promise<MallStructureReport | null> {
  if (!process.env.ANTHROPIC_API_KEY || !contextText.trim()) return null

  const properties: Record<string, { type: string; description: string }> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: 'string', description: `${f.label} — ${f.hint}. 아래 원문에서 확인할 수 없으면 반드시 "확인 안됨"이라고만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(mallName, platform, categoryHints, sampleProductUrl, contextText)

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      tools: [{
        name: 'set_mall_report',
        description: '조사한 11개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.',
        input_schema: { type: 'object', properties, required: MALL_REPORT_FIELDS.map(f => f.key) },
      }],
      tool_choice: { type: 'tool', name: 'set_mall_report' },
      messages: [{ role: 'user', content: prompt }],
    })
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
  mallName: string, platform: string, categoryHints: string[], sampleProductUrl: string, contextText: string,
): Promise<MallStructureReport | null> {
  if (!process.env.GEMINI_API_KEY || !contextText.trim()) return null

  const properties: Record<string, Schema> = {}
  MALL_REPORT_FIELDS.forEach(f => {
    properties[f.key] = { type: Type.STRING, description: `${f.label} — ${f.hint}. 아래 원문에서 확인할 수 없으면 반드시 "확인 안됨"이라고만 답한다(추측 금지).` }
  })
  const prompt = buildMallReportPrompt(mallName, platform, categoryHints, sampleProductUrl, contextText)

  try {
    const response = await getGeminiClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ functionDeclarations: [{
          name: 'set_mall_report',
          description: '조사한 11개 항목을 각각 문자열로 채운다. 원문에서 확인 못한 항목은 반드시 "확인 안됨"으로 채운다.',
          parameters: { type: Type.OBJECT, properties, required: MALL_REPORT_FIELDS.map(f => f.key) },
        }] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['set_mall_report'] } },
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

/**
 * "몰 구조 파악" 기능 — 실제로 수집한 원문(홈/게시판/상품페이지 텍스트)만 근거로 사용자가 알고 싶어하는
 * 11개 항목(URL 계층/카테고리/은행명/계좌번호/택배사/택배비/반품주소/재고관리/연락처/상품페이지 구조/
 * 스크래핑 유의사항)을 채운다. 원문에 없는 내용을 추측하지 않도록 프롬프트에서 명시적으로 금지하고,
 * 확인 못한 항목은 "확인 안됨"으로 답하게 한다. Anthropic을 먼저 시도하고, 크레딧 부족 등으로 실패하면
 * Gemini로 재시도한다(둘 다 실패하거나 원문을 하나도 못 모았으면 null — 호출부가 규칙 기반으로 대체).
 */
export async function generateMallProfileReport(
  mallName: string,
  platform: string,
  categoryHints: string[],
  sampleProductUrl: string,
  contextText: string,
): Promise<MallStructureReport | null> {
  return await generateMallProfileReportAnthropic(mallName, platform, categoryHints, sampleProductUrl, contextText).catch(() => null)
    ?? await generateMallProfileReportGemini(mallName, platform, categoryHints, sampleProductUrl, contextText).catch(() => null)
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
 * 크레딧이 없어도 "몰 구조 파악"이 동작해야 한다는 요구에 따른 것(월 정액 claude.ai/Claude Code 구독과
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
    })
    const text = (response.content[0] as { type: string; text: string }).text
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return { name: null, price: null }
    const parsed = JSON.parse(match[0]) as { name?: string | null; price?: number | null }
    return { name: parsed.name || null, price: typeof parsed.price === 'number' ? parsed.price : null }
  } catch {
    return { name: null, price: null }
  }
}
