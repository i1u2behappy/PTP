import fs from 'fs'
import path from 'path'
import axios from 'axios'
import sharp from 'sharp'
import pool from './db'
import type { RawMasterImage } from './db'
import { withContext } from './scraper'

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

/** 이 세션의 이미지가 저장되는 로컬 폴더 절대경로 (대표/상세이미지 상위 폴더 — "스크랩 Raw 확인"의
 *  "파일 열기"용). 세션이 아직 한 건도 병합되지 않았다면 실제로는 폴더가 생성되지 않았을 수 있다. */
export async function resolveScrapeFolderPath(sessionId: number): Promise<string> {
  return path.join(SAVE_ROOT, await resolveScrapeFolderName(sessionId))
}

/** 폴더명: "몰_스크래핑날짜_회차" — 회차는 그 몰의 그 날짜(달력 기준) 내 몇 번째 스크랩 세션인지. */
export async function resolveScrapeFolderName(sessionId: number): Promise<string> {
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

async function fetchImageBytes(url: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
  })
  return Buffer.from(res.data)
}

/** 이미지 자체가 로그인 세션 없이는 안 열리는 몰(도매몰 등)을 위한 폴백 — 그 몰의 저장된 로그인 프로필로
 *  헤드리스 컨텍스트를 하나 띄워(로그인 창이 열려있으면 그걸 그대로 재사용) 실패한 URL들만 한 번에 다시
 *  받는다. 이미지마다 새로 띄우면 느려서, 배치 전체에 실패가 있을 때 딱 한 번만 띄운다. 브라우저 컨텍스트의
 *  request는 그 컨텍스트가 가진 쿠키를 자동으로 실어 보내므로, 로그인 창이 오래 전에 닫혔어도 프로필
 *  폴더에 남은 쿠키가 유효한 한 그대로 통과한다(withContext가 이미 하는 폴백 그대로 재사용). */
async function fetchViaLoginSession(siteId: number, urls: string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  await withContext({ siteId }, async (_page, context) => {
    for (const url of urls) {
      try {
        const res = await context.request.get(url, { headers: { Referer: url } })
        if (res.ok()) result.set(url, await res.body())
      } catch { /* 이 URL은 포기 */ }
    }
  })
  return result
}

async function saveNormalizedImage(
  buffer: Buffer, url: string, folderName: string, productCode: string, productName: string, type: 'thumb' | 'detail', idx: number | undefined,
): Promise<SavedImage> {
  const subDir = type === 'thumb' ? 'Top_img' : 'Detail_img'
  const dir = path.join(SAVE_ROOT, folderName, subDir)
  ensureDir(dir)

  const finalName = `${normalizeFileName(productCode, productName, type, idx)}.jpg`
  const filePath = path.join(dir, finalName)

  // 대표이미지는 정사각형에 가까워 가로·세로 모두 1200px로 제한해도 되지만, 상세이미지는 국내 쇼핑몰 관행상
  // 세로로 매우 긴 인포그래픽형이 많아 세로까지 같이 제한하면 가로가 찌그러진다 — 가로만 제한한다.
  const resizeOptions = type === 'thumb'
    ? { width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' as const, withoutEnlargement: true }
    : { width: MAX_DIMENSION, withoutEnlargement: true }
  await sharp(buffer)
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

/** 대표이미지(여러 장 가능) + 상세이미지 일괄 다운로드/정규화 후 product_images에 기록. siteId를 주면,
 *  로그인 없이 받다가 실패한 이미지만 그 몰의 로그인 세션으로 한 번 더 시도한다(일부 도매몰은 이미지
 *  자체가 로그인 세션이 있어야만 열린다). */
export async function downloadProductImages(
  thumbnailUrls: string[],
  detailUrls: string[],
  mallProductId: number,
  productCode: string,
  productName: string,
  folderName: string,
  siteId?: number,
): Promise<{ thumbnails: SavedImage[]; details: SavedImage[] }> {
  const thumbnails: (SavedImage | undefined)[] = []
  const details: (SavedImage | undefined)[] = []
  const failed: { url: string; type: 'thumb' | 'detail'; idx: number; slot: (SavedImage | undefined)[] }[] = []

  // 이미지마다 네트워크 요청+리사이즈를 순서대로 기다리면(예전 for await) 상품 하나에 이미지가 여러 장일 때
  // 그만큼 곱으로 느려진다 — 서로 독립적인 작업이라 동시에 진행한다(실사용 확인: 확정 작업이 오래 걸리는
  // 주된 원인 중 하나).
  await Promise.all(thumbnailUrls.map(async (url, i) => {
    try { thumbnails[i] = await saveNormalizedImage(await fetchImageBytes(url), url, folderName, productCode, productName, 'thumb', i + 1) }
    catch { failed.push({ url, type: 'thumb', idx: i + 1, slot: thumbnails }) }
  }))
  await Promise.all(detailUrls.map(async (url, i) => {
    try { details[i] = await saveNormalizedImage(await fetchImageBytes(url), url, folderName, productCode, productName, 'detail', i + 1) }
    catch { failed.push({ url, type: 'detail', idx: i + 1, slot: details }) }
  }))

  if (failed.length && siteId) {
    const recovered = await fetchViaLoginSession(siteId, failed.map(f => f.url)).catch(() => new Map<string, Buffer>())
    for (const f of failed) {
      const buffer = recovered.get(f.url)
      if (!buffer) continue
      try { f.slot[f.idx - 1] = await saveNormalizedImage(buffer, f.url, folderName, productCode, productName, f.type, f.idx) } catch { /* 그래도 실패 — 포기 */ }
    }
  }

  const savedThumbnails = thumbnails.filter((t): t is SavedImage => !!t)
  const savedDetails = details.filter((d): d is SavedImage => !!d)

  // 재스크랩 시 이전 이미지 레코드를 대체한다 (파일 자체는 같은 정규화 이름으로 덮어써짐)
  await pool.query(`DELETE FROM product_images WHERE mall_product_id=$1`, [mallProductId])
  const rows = [
    ...savedThumbnails.map((t, i) => ({ ...t, imageType: 'thumbnail', sortOrder: i })),
    ...savedDetails.map((d, i) => ({ ...d, imageType: 'detail', sortOrder: i + 1 })),
  ]
  for (const r of rows) {
    await pool.query(
      `INSERT INTO product_images
        (mall_product_id, image_type, sort_order, source_url, original_file_name, normalized_file_name, storage_path, file_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [mallProductId, r.imageType, r.sortOrder, r.url, r.originalFileName, r.normalizedFileName, r.storagePath, r.fileSizeBytes],
    )
  }

  return { thumbnails: savedThumbnails, details: savedDetails }
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
