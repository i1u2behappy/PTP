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

/** 상품명 기반 파일명 정규화 (일괄 규칙: 대표N/상세N — 대표이미지도 여러 장일 수 있어 모두 번호를 붙인다) */
export function normalizeFileName(productName: string, type: 'thumb' | 'detail', idx?: number): string {
  const safe = (productName || '상품').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 30)
  return type === 'thumb' ? `${safe}_대표${idx ?? 1}` : `${safe}_상세${idx ?? 1}`
}

async function downloadAndNormalize(
  url: string, mallProductId: number, productName: string, type: 'thumb' | 'detail', idx: number | undefined,
): Promise<SavedImage> {
  const dir = path.join(SAVE_ROOT, String(mallProductId))
  ensureDir(dir)

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
  })

  const finalName = `${normalizeFileName(productName, type, idx)}.jpg`
  const filePath = path.join(dir, finalName)

  // 파일 사이즈/포맷을 일괄 규칙(최대 1200px, JPEG 85% 품질)으로 정리
  await sharp(Buffer.from(res.data))
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(filePath)

  return {
    url,
    storagePath: `/scraped/${mallProductId}/${finalName}`,
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
  productName: string,
): Promise<{ thumbnails: SavedImage[]; details: SavedImage[] }> {
  const thumbnails: SavedImage[] = []
  const details: SavedImage[] = []

  for (let i = 0; i < thumbnailUrls.length; i++) {
    try { thumbnails.push(await downloadAndNormalize(thumbnailUrls[i], mallProductId, productName, 'thumb', i + 1)) } catch { /* 실패 무시 */ }
  }
  for (let i = 0; i < detailUrls.length; i++) {
    try { details.push(await downloadAndNormalize(detailUrls[i], mallProductId, productName, 'detail', i + 1)) } catch { /* 실패 무시 */ }
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
