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
  stock_status: string
  stock_qty: number | null
  mall_product_code: string
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
