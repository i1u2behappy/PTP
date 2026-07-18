import fs from 'fs'
import path from 'path'
import axios from 'axios'
import sharp from 'sharp'
import pool from './db'
import type { RawMasterImage } from './db'

const SAVE_ROOT = path.join(process.cwd(), 'public', 'scraped')
const MAX_DIMENSION = 1200
const JPEG_QUALITY = 85

export interface SavedImage {
  url: string
  storagePath: string        // public/ 기준 상대 경로 (브라우저 접근용)
  originalFileName: string
  normalizedFileName: string
  fileSizeBytes: number
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function originalFileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image')
  } catch {
    return 'image'
  }
}

/** 상품코드+상품명 기반 파일명 정규화 (일괄 규칙: 대표N/상세N). 폴더가 세션 단위로 여러 상품을 함께
 *  담으므로, 상품명만으로는 다른 상품과 겹칠 수 있어 상품코드를 항상 앞에 붙여 고유성을 보장한다. */
export function normalizeFileName(productCode: string, productName: string, type: 'thumb' | 'detail', idx?: number): string {
  const safeCode = (productCode || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeName = (productName || '상품').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 30)
  const base = safeCode ? `${safeCode}_${safeName}` : safeName
  return type === 'thumb' ? `${base}_대표${idx ?? 1}` : `${base}_상세${idx ?? 1}`
}

/** 폴더명: "몰_스크래핑날짜_회차" — 회차는 그 몰의 그 날짜(달력 기준) 내 몇 번째 스크랩 세션인지. */
async function resolveScrapeFolderName(sessionId: number): Promise<string> {
  const res = await pool.query<{ site_id: number; created_at: string; site_name: string | null }>(
    `SELECT ss.site_id, ss.created_at, s.name AS site_name
     FROM scrape_sessions ss JOIN sites s ON s.id = ss.site_id
     WHERE ss.id = $1`,
    [sessionId],
  )
  const row = res.rows[0]
  if (!row) return `session_${sessionId}`

  const created = new Date(row.created_at)
  const dateStr = `${created.getFullYear()}${String(created.getMonth() + 1).padStart(2, '0')}${String(created.getDate()).padStart(2, '0')}`
  const roundRes = await pool.query<{ round: string }>(
    `SELECT COUNT(*) AS round FROM scrape_sessions WHERE site_id=$1 AND created_at::date = $2::date AND id <= $3`,
    [row.site_id, row.created_at, sessionId],
  )
  const safeMallName = (row.site_name || `site${row.site_id}`).replace(/[^가-힣a-zA-Z0-9]/g, '_')
  return `${safeMallName}_${dateStr}_${roundRes.rows[0].round}`
}

async function downloadAndNormalize(
  url: string, folderName: string, productCode: string, productName: string, type: 'thumb' | 'detail', idx: number | undefined,
): Promise<SavedImage> {
  const subDir = type === 'thumb' ? 'Top_img' : 'Detail_img'
  const dir = path.join(SAVE_ROOT, folderName, subDir)
  ensureDir(dir)

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
  })

  const finalName = `${normalizeFileName(productCode, productName, type, idx)}.jpg`
  const filePath = path.join(dir, finalName)

  // 대표이미지는 정사각형에 가까워 가로·세로 모두 1200px로 제한해도 되지만, 상세이미지는 국내 쇼핑몰 관행상
  // 세로로 매우 긴 인포그래픽형이 많아 세로까지 같이 제한하면 가로가 찌그러진다 — 가로만 제한한다.
  const resizeOptions = type === 'thumb'
    ? { width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' as const, withoutEnlargement: true }
    : { width: MAX_DIMENSION, withoutEnlargement: true }
  await sharp(Buffer.from(res.data))
    .resize(resizeOptions)
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(filePath)

  return {
    url,
    storagePath: `/scraped/${folderName}/${subDir}/${finalName}`,
    originalFileName: originalFileNameFromUrl(url),
    normalizedFileName: finalName,
    fileSizeBytes: fs.statSync(filePath).size,
  }
}

/** 대표이미지(여러 장 가능) + 상세이미지 일괄 다운로드/정규화 후 product_images에 기록 */
export async function downloadProductImages(
  thumbnailUrls: string[],
  detailUrls: string[],
  mallProductId: number,
  productCode: string,
  productName: string,
  sessionId: number,
): Promise<{ thumbnails: SavedImage[]; details: SavedImage[] }> {
  const folderName = await resolveScrapeFolderName(sessionId)
  const thumbnails: SavedImage[] = []
  const details: SavedImage[] = []

  for (let i = 0; i < thumbnailUrls.length; i++) {
    try { thumbnails.push(await downloadAndNormalize(thumbnailUrls[i], folderName, productCode, productName, 'thumb', i + 1)) } catch { /* 실패 무시 */ }
  }
  for (let i = 0; i < detailUrls.length; i++) {
    try { details.push(await downloadAndNormalize(detailUrls[i], folderName, productCode, productName, 'detail', i + 1)) } catch { /* 실패 무시 */ }
  }

  // 재스크랩 시 이전 이미지 레코드를 대체한다 (파일 자체는 같은 정규화 이름으로 덮어써짐)
  await pool.query(`DELETE FROM product_images WHERE mall_product_id=$1`, [mallProductId])
  const rows = [
    ...thumbnails.map((t, i) => ({ ...t, imageType: 'thumbnail', sortOrder: i })),
    ...details.map((d, i) => ({ ...d, imageType: 'detail', sortOrder: i + 1 })),
  ]
  for (const r of rows) {
    await pool.query(
      `INSERT INTO product_images
        (mall_product_id, image_type, sort_order, source_url, original_file_name, normalized_file_name, storage_path, file_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [mallProductId, r.imageType, r.sortOrder, r.url, r.originalFileName, r.normalizedFileName, r.storagePath, r.fileSizeBytes],
    )
  }

  return { thumbnails, details }
}

/** 현재 설정된 이미지 호스팅 base URL (없으면 빈 문자열 = 상대경로 그대로 사용) */
export async function getImageHostBaseUrl(): Promise<string> {
  const res = await pool.query<{ base_url: string }>(`SELECT base_url FROM image_host_config ORDER BY id DESC LIMIT 1`)
  return res.rows[0]?.base_url || ''
}

/** base URL이 바뀌어도 이 함수만 거치면 항상 최신 URL이 나온다 — "URL 일괄 편집" 요구사항의 실제 구현 지점 */
export function resolveImageUrl(storagePath: string, baseUrl: string): string {
  if (!storagePath) return ''
  if (/^https?:\/\//i.test(storagePath)) return storagePath
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${storagePath}` : storagePath
}

export function resolveMasterImages(images: RawMasterImage[], baseUrl: string): { thumbnail_urls: string[]; detail_image_urls: string[] } {
  const thumbs = images.filter(i => i.image_type === 'thumbnail').sort((a, b) => a.sort_order - b.sort_order)
  const details = images.filter(i => i.image_type === 'detail').sort((a, b) => a.sort_order - b.sort_order)
  return {
    thumbnail_urls: thumbs.map(t => resolveImageUrl(t.storage_path, baseUrl)),
    detail_image_urls: details.map(d => resolveImageUrl(d.storage_path, baseUrl)),
  }
}
