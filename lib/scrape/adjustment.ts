import pool from '../db'
import { generateExtractionRules, type ExtractedProduct, type ExtractionRule } from '../ai'

/**
 * "스크랩 조정" 기능의 공용 계약 — 스크랩 방식(현재 일반모드/개발자모드, 앞으로 추가될 어떤 방식이든)은
 * 이 함수 하나만 호출하면 된다. 모드별로 다른 부분(실제 페이지 내용을 어떻게 구하는지, 규칙 갱신 후
 * 이미 스크랩된 데이터를 어떻게 재적용하는지)은 각 모드 쪽 코드가 맡고, "AI로 규칙을 만들고 그 몰의
 * 영구 규칙으로 저장"하는 핵심 로직은 여기 한 곳에만 있다.
 */
export async function runAdjustment(
  siteId: number,
  prompt: string,
  pageText: string,
  currentValues: Partial<ExtractedProduct>,
): Promise<Record<string, ExtractionRule>> {
  const res = await pool.query<{ name: string | null; extraction_rules: Record<string, ExtractionRule> | null }>(
    `SELECT name, extraction_rules FROM sites WHERE id=$1`, [siteId],
  )
  const site = res.rows[0]
  if (!site) throw new Error('mall not found')

  const rules = await generateExtractionRules(site.name || `site${siteId}`, prompt, currentValues, pageText)
  const merged = { ...(site.extraction_rules || {}), ...rules }
  await pool.query(`UPDATE sites SET extraction_rules=$1 WHERE id=$2`, [JSON.stringify(merged), siteId])
  // 방금 새로 갱신된 필드만 반환 — 호출부가 "어떤 필드가 바뀌었는지" 사용자에게 보여줄 때 쓴다.
  return rules
}
