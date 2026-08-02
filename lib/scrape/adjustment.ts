import pool from '../db'
import { generateExtractionRules, generateAutoExtractionRules, EXTRACTION_RULE_FIELDS, type ExtractedProduct, type ExtractionRule } from '../ai'

/**
 * "스크랩 조정" 기능의 공용 계약 — 스크랩 방식(현재 일반모드/개발자모드, 앞으로 추가될 어떤 방식이든)은
 * 이 함수 하나만 호출하면 된다. 모드별로 다른 부분(실제 페이지 내용을 어떻게 구하는지, 규칙 갱신 후
 * 이미 스크랩된 데이터를 어떻게 재적용하는지)은 각 모드 쪽 코드가 맡고, "AI로 규칙을 만들고 그 몰의
 * 영구 규칙으로 저장"하는 핵심 로직은 여기 한 곳에만 있다.
 */
export interface AdjustmentResult {
  /** 방금 새로 갱신된 필드만 — 호출부가 "어떤 필드가 바뀌었는지" 사용자에게 보여줄 때 쓴다. */
  rules: Record<string, ExtractionRule>
  /** 기존 규칙 + 방금 갱신된 규칙 전체 — 미리보기 재추출 등 "지금 이 몰의 전체 규칙"이 필요할 때 쓴다. */
  merged: Record<string, ExtractionRule>
}

// SELECT로 읽은 site.extraction_rules를 JS에서 합쳐 그대로 UPDATE하면, 그 사이 "요소 지정" 등
// 다른 경로로 저장된 규칙이 이 UPDATE에 덮여씌워질 수 있다(lost update). Postgres jsonb `||`로 그
// 시점의 실제 값과 원자적으로 병합하고, RETURNING으로 병합 후 진짜 전체 규칙을 그대로 돌려준다.
async function mergeRulesIntoSite(siteId: number, rules: Record<string, ExtractionRule>): Promise<Record<string, ExtractionRule>> {
  const updated = await pool.query<{ extraction_rules: Record<string, ExtractionRule> }>(
    `UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) || $1::jsonb WHERE id=$2 RETURNING extraction_rules`,
    [JSON.stringify(rules), siteId],
  )
  return updated.rows[0].extraction_rules
}

export async function runAdjustment(
  siteId: number,
  prompt: string,
  pageText: string,
  currentValues: Partial<ExtractedProduct>,
): Promise<AdjustmentResult> {
  const res = await pool.query<{ name: string | null; extraction_rules: Record<string, ExtractionRule> | null; scrape_profile: Record<string, unknown> | null }>(
    `SELECT name, extraction_rules, scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  const site = res.rows[0]
  if (!site) throw new Error('mall not found')

  const rules = await generateExtractionRules(site.name || `site${siteId}`, prompt, currentValues, pageText, site.scrape_profile)
  const merged = await mergeRulesIntoSite(siteId, rules)
  return { rules, merged }
}

/**
 * "AI모드 스크래핑" — 사용자가 특정 필드를 지적한 게 아니라, 몰 페이지를 AI가 스스로 한 번 분석해
 * 8개 필드 전체에 대한 추출 규칙을 만들고 그 몰의 영구 규칙(sites.extraction_rules)으로 저장한다.
 * 몰 구조는 자주 바뀌지 않으니 이렇게 한 번만 분석해두면, 이후 같은 몰의 다른 상품은 이 저장된 규칙으로
 * AI 재호출 없이 빠르게 재사용된다 — runAdjustment와 핵심 저장 로직(mergeRulesIntoSite)을 공유한다.
 *
 * 이미 규칙이 있는 필드(스크랩 대상 직접지정으로 사람이 클릭해 확정했거나, 이전 AI 분석이 이미 만들어둔
 * 것)는 절대 다시 덮어쓰지 않는다 — 예전엔 미리보기/스크랩을 할 때마다 이 8개 필드를 매번 새로 분석해
 * 그대로 저장해버려서, 방금 "스크랩 대상 직접지정"으로 저장한 규칙이 곧바로 AI 결과에 덮여 사라지는
 * 문제가 있었다(2026-08 사용자 실측 발견 — 위 주석의 "AI 재호출 없이 재사용"이라는 의도가 실제로는
 * 구현돼 있지 않았다). 8개 필드가 이미 다 채워져 있으면 AI를 아예 호출하지 않는다.
 */
export async function runAutoAnalysis(siteId: number, pageText: string): Promise<AdjustmentResult> {
  const res = await pool.query<{ name: string | null; scrape_profile: Record<string, unknown> | null; extraction_rules: Record<string, ExtractionRule> | null }>(
    `SELECT name, scrape_profile, extraction_rules FROM sites WHERE id=$1`, [siteId],
  )
  const site = res.rows[0]
  if (!site) throw new Error('mall not found')

  const existing = site.extraction_rules || {}
  const missingFields = EXTRACTION_RULE_FIELDS.filter(f => !existing[f])
  if (!missingFields.length) return { rules: {}, merged: existing }

  const generated = await generateAutoExtractionRules(site.name || `site${siteId}`, pageText, site.scrape_profile)
  const rules = Object.fromEntries(Object.entries(generated).filter(([field]) => missingFields.includes(field as typeof EXTRACTION_RULE_FIELDS[number])))
  const merged = await mergeRulesIntoSite(siteId, rules)
  return { rules, merged }
}
