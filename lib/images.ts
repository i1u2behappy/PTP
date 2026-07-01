import fs from 'fs'
import path from 'path'
import axios from 'axios'

const SAVE_ROOT = path.join(process.cwd(), 'public', 'scraped')

export interface SavedImage {
  url: string
  local_path: string  // public/ 기준 상대 경로 (브라우저 접근용)
  file_name: string
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function ext(url: string): string {
  const u = url.split('?')[0]
  const m = u.match(/\.(jpe?g|png|gif|webp|avif)$/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

/** 이미지 1장 다운로드 → public/scraped/{sessionId}/{productId}/{fileName} */
export async function downloadImage(
  url: string,
  sessionId: number,
  productId: number,
  fileName: string,
): Promise<SavedImage> {
  const dir = path.join(SAVE_ROOT, String(sessionId), String(productId))
  ensureDir(dir)

  const extension = ext(url)
  const finalName = `${fileName}.${extension}`
  const filePath  = path.join(dir, finalName)

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
  })
  fs.writeFileSync(filePath, Buffer.from(res.data))

  return {
    url,
    local_path: `/scraped/${sessionId}/${productId}/${finalName}`,
    file_name:  finalName,
  }
}

/** 대표이미지 + 상세이미지 일괄 다운로드 */
export async function downloadProductImages(
  thumbnailUrl: string,
  detailUrls: string[],
  sessionId: number,
  productId: number,
): Promise<{
  thumbnail: SavedImage | null
  details: SavedImage[]
}> {
  let thumbnail: SavedImage | null = null
  const details: SavedImage[] = []

  if (thumbnailUrl) {
    try {
      thumbnail = await downloadImage(thumbnailUrl, sessionId, productId, 'thumb')
    } catch { /* 실패 무시 */ }
  }

  for (let i = 0; i < detailUrls.length; i++) {
    try {
      const img = await downloadImage(detailUrls[i], sessionId, productId, `detail_${i + 1}`)
      details.push(img)
    } catch { /* 실패 무시 */ }
  }

  return { thumbnail, details }
}

/** 상품명 기반 파일명 정규화 (엑셀 내보내기 시 최종 파일명) */
export function normalizeFileName(productName: string, index: number, type: 'thumb' | 'detail', detailIdx?: number): string {
  const safe = productName.replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 30)
  if (type === 'thumb') return `${safe}_대표`
  return `${safe}_상세${detailIdx ?? index + 1}`
}
