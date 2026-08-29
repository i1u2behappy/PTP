import { getMigratedCategoryLabels, getCategoryMemory } from '../scraper'
import { detectCategoryAnomaly } from '../ai'

/** AI 호출까지 갈 가치가 있는지 — 비교할 과거 증거(마이그레이션 확정 카테고리 + 사용자가 직접 확인한
 *  카테고리 URL)가 너무 적으면(신규 몰 등) 비교 자체가 무의미하고 오탐만 늘리므로 건너뛴다. 새로 찾은
 *  카테고리가 아예 없어도(다른 로직이 이미 처리) 비교할 게 없어 건너뛴다. */
export function shouldRunCategoryAnomalyCheck(migratedLabelCount: number, manualUrlCount: number, freshLinkCount: number): boolean {
  return migratedLabelCount + manualUrlCount >= 5 && freshLinkCount > 0
}

/**
 * "카테고리 불러오기"/"몰 구조분석"이 새로 확정한 categoryLinks가 이 몰의 검증된 과거 카테고리와 비교해
 * 터무니없는지 AI로 확인한다 — lib/scrape/categoryCachePolicy.ts(로그인/봇 차단으로 부실해진 결과 보호)와
 * 는 다른 종류의 안전망이다: 저 쪽은 "이번 크롤이 명백히 막혔는가"만 보고, 이쪽은 "막힌 티는 안 나지만
 * 결과 자체가 과거와 비교해 말이 안 되는가"를 AI에게 판단시킨다(2026-08-29, 봇 차단 페이지 링크가
 * 카테고리로 잘못 저장됐던 사고의 재발 감지용 — 사용자 요청).
 *
 * 비교할 과거 증거가 부족하면(shouldRunCategoryAnomalyCheck) AI를 부르지 않고 null을 반환한다 — 신규
 * 몰이나 아직 검수/수동확인 이력이 없는 몰에서 매번 헛되이 경고가 뜨는 걸 막기 위함.
 */
export async function checkCategoryAnomaly(
  siteId: number, mallName: string, freshLinks: { name: string; href: string }[],
): Promise<{ reason: string; source: 'anthropic' | 'gemini' | 'ollama' } | null> {
  const [migratedLabels, { manualSamples }] = await Promise.all([
    getMigratedCategoryLabels(siteId),
    getCategoryMemory(siteId),
  ])
  if (!shouldRunCategoryAnomalyCheck(migratedLabels.length, manualSamples.length, freshLinks.length)) return null

  const verdict = await detectCategoryAnomaly(mallName, freshLinks, migratedLabels, manualSamples).catch(() => null)
  if (!verdict?.suspicious) return null
  return { reason: verdict.reason, source: verdict.source }
}
