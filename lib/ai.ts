import Anthropic from '@anthropic-ai/sdk'

// 매 호출마다 새로 생성 — 모듈 로드 시점에 키를 고정하면 .env 값을 나중에 바꿔도
// (dev 서버가 모듈을 재평가하지 않는 한) 예전 키가 계속 쓰이는 문제가 있었다.
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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
  type: 'label' | 'selector'
  value: string
}

const EXTRACTION_RULE_FIELDS = ['name', 'price', 'cost_price', 'shipping_fee', 'category', 'brand', 'manufacturer', 'origin'] as const

/**
 * "스크랩 조정" 기능용 — 사용자가 지적한 프롬프트 + 지금 잘못 추출된 값 + 실제 페이지 내용을 보고,
 * 수정이 필요한 필드마다 추출 규칙(라벨 정규식 또는 CSS 셀렉터)을 만든다. generateTransformColumns와
 * 같은 tool-call 강제 스키마 패턴 — 확신이 없는 필드는 rules에서 아예 빼도 되게 required를 안 건다.
 * 기존 8개 고정 필드 외에, 사용자가 프롬프트로 새 컬럼(예: 소재/세탁방법)을 요청하면 그 필드명을 rules에
 * 자유롭게 추가해도 되도록 스키마를 열어둔다 — 결과는 ExtractedProduct.custom_fields로 저장된다.
 * ANTHROPIC_API_KEY가 없으면 조용히 빈 규칙을 반환한다(호출부에서 전체 흐름을 막지 않도록).
 */
export async function generateExtractionRules(
  mallName: string,
  userPrompt: string,
  currentValues: Partial<ExtractedProduct>,
  pageText: string,
): Promise<Record<string, ExtractionRule>> {
  if (!process.env.ANTHROPIC_API_KEY || !userPrompt.trim()) return {}

  const ruleSchema = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['label', 'selector'], description: "'label'이면 dt/dd나 표의 라벨 텍스트를 정규식으로 찾고, 'selector'면 CSS 셀렉터로 직접 값을 읽는다." },
      value: { type: 'string', description: "type='label'이면 라벨과 매칭할 정규식 문자열(예: '도매가|공급가'), type='selector'면 CSS 셀렉터 문자열." },
    },
    required: ['type', 'value'],
  }
  const properties: Record<string, unknown> = {}
  EXTRACTION_RULE_FIELDS.forEach(f => { properties[f] = ruleSchema })
  // additionalProperties만으로는 모델이 스키마에 안 보이는 새 필드를 스스로 잘 안 채우는 경향이 있어
  // (실측 확인됨) — "'필드명' 필드 추가"로 시작하는 새 컬럼 요청은 그 필드명을 properties에 직접
  // 명시적으로 추가해, 기존 8개 필드와 똑같이 확실하게 채워지도록 한다.
  const newFieldMatch = userPrompt.match(/^'([^']+)' 필드 추가/)
  if (newFieldMatch) properties[newFieldMatch[1]] = ruleSchema

  const prompt = `몰 '${mallName}'의 상품 페이지를 스크랩하는데 값이 잘못 추출되고 있다.

[사용자 지적 사항]
${userPrompt}

[지금 추출된 값 (잘못됐을 수 있음, custom_fields는 이전에 추가한 커스텀 컬럼들)]
${JSON.stringify(currentValues)}

[실제 상품 페이지 내용 (일부)]
${pageText.slice(0, 30_000)}

위 페이지에서 사용자가 지적한 필드(들)의 올바른 값을 찾을 수 있는 방법을 알아내라. 페이지에 라벨-값
쌍(예: <dt>도매가격</dt><dd>12,000원</dd> 같은 구조나 표)이 보이면 그 라벨 텍스트를 정규식으로 만들고
(type='label'), 그게 아니라 특정 요소를 CSS 셀렉터로 바로 집어야 하면 type='selector'로 답하라. 사용자가
언급하지 않았거나 페이지에서 확신할 수 없는 필드는 절대 넣지 마라 — 아는 것만 답한다.

사용자 지적 사항에 작은따옴표(')로 감싼 필드명이 있으면(예: '소재' 필드 추가) 그 값을 정확히 그 이름
그대로 rules의 key로 써라 — 기존 8개 필드(name/price/cost_price/shipping_fee/category/brand/manufacturer/
origin)에 없는 완전히 새로운 종류의 정보라도 상관없다. 그 외의 경우 새 필드명을 임의로 지어내지 마라.`

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{
        name: 'set_extraction_rules',
        description: '수정이 필요하다고 확신하는 필드에 대해서만 추출 규칙을 채워 반환한다. 확신 없는 필드는 아예 넣지 않는다. 사용자가 새 컬럼명을 지정했으면 그 이름을 key로 추가해도 된다.',
        input_schema: {
          type: 'object',
          properties: { rules: { type: 'object', properties, additionalProperties: ruleSchema } },
          required: ['rules'],
        },
      }],
      tool_choice: { type: 'tool', name: 'set_extraction_rules' },
      messages: [{ role: 'user', content: prompt }],
    })
    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') return {}
    const input = toolUse.input as { rules?: Record<string, ExtractionRule> }
    return input.rules || {}
  } catch (e) {
    // generateTransformColumns(대량 배치 처리)와 달리 이 기능은 사용자가 방금 누른 단일 조정 시도라,
    // 실패를 조용히 삼키면 "AI가 확신을 못 해서 규칙을 안 만든 것"과 "API 호출 자체가 실패한 것"(크레딧
    // 부족, 네트워크 오류 등)을 구분할 수 없어 혼란스럽다 — 여기서는 그대로 던져 호출부가 사용자에게
    // 실제 실패 사유를 보여주게 한다.
    const message = e instanceof Anthropic.APIError ? e.message : e instanceof Error ? e.message : String(e)
    throw new Error(`AI 호출 실패: ${message}`)
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
