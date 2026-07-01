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
  thumbnail_url: string
  detail_image_urls: string[]
}

/** HTML에서 상품 데이터 추출 (Claude Haiku — 빠르고 저렴) */
export async function extractProductFromHtml(html: string, url: string): Promise<ExtractedProduct> {
  // HTML이 너무 길면 앞 50000자만 사용 (토큰 절약)
  const trimmed = html.slice(0, 50_000)

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `다음 쇼핑몰 HTML에서 상품 정보를 추출해줘. JSON만 반환해.

URL: ${url}

HTML:
${trimmed}

JSON 형식:
{
  "name": "상품명",
  "price": 정상가(숫자, 없으면 null),
  "sale_price": 판매가(숫자, 없으면 null),
  "brand": "브랜드",
  "manufacturer": "제조사",
  "origin": "원산지",
  "category": "카테고리",
  "description": "상품 설명 (300자 이내 요약)",
  "options": [{"name": "옵션명", "values": ["값1","값2"]}],
  "thumbnail_url": "대표이미지 절대URL",
  "detail_image_urls": ["상세이미지URL1", "상세이미지URL2"]
}

주의:
- 이미지 URL은 반드시 절대 URL (http:// 또는 https:// 시작)
- 가격은 숫자만 (쉼표, 원 제거)
- 찾을 수 없는 필드는 빈문자열 또는 null`
    }],
  })

  const text = (response.content[0] as { type: string; text: string }).text
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI 응답에서 JSON을 찾지 못했습니다')
  return JSON.parse(jsonMatch[0]) as ExtractedProduct
}

/** 대표이미지 URL → AI 상품명 생성 (20자 이내, 오픈마켓 등록용) */
export async function generateProductName(imageUrl: string, originalName: string): Promise<string> {
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
            text: `원본 상품명: ${originalName}

위 이미지를 보고 오픈마켓(쿠팡, 네이버 등) 등록용 상품명을 한국어로 만들어줘.
조건:
- 20자 이내
- 특수문자 최소화
- 핵심 키워드 포함 (소재, 용도, 특징)
- 상품명만 출력, 설명 없이`,
          },
        ],
      }],
    })

    return (response.content[0] as { type: string; text: string }).text.trim().slice(0, 20)
  } catch {
    // 이미지 분석 실패 시 원본명 기반으로 축약
    return originalName.slice(0, 20)
  }
}
