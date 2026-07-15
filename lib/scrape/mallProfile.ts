import pool from '../db'
import { profileMallStructure, type MallProfileSignals } from '../scraper'

function summarizeProfile(p: MallProfileSignals): string {
  return [
    p.hasMainImages ? '대표이미지 있음' : '대표이미지 없음',
    p.hasDetailImages ? '상세이미지 있음' : '상세이미지 없음',
    p.hasDetailText ? '상세텍스트 있음' : '상세텍스트 없음',
    `옵션: ${p.optionUiTypes.join('/') || '없음'}${p.hasCascadingOptions ? ' (연쇄옵션 있음)' : ''}`,
    p.hasStockQty ? '재고수량 표시' : '재고수량 미표시',
    p.hasStockStatusText ? '재고상태 문구 표시' : '재고상태 문구 미표시',
    p.hasStockByOption ? '옵션별 재고 위젯 있음' : '옵션별 재고 위젯 없음',
    `상품정보 항목: ${p.infoLabels.join(', ') || '없음'}`,
  ].join(', ')
}

function describeDiff(prev: MallProfileSignals, next: MallProfileSignals): string[] {
  const diffs: string[] = []
  if (prev.hasMainImages !== next.hasMainImages) diffs.push(`대표이미지: ${prev.hasMainImages ? '있었음' : '없었음'} → ${next.hasMainImages ? '있음' : '없음'}`)
  if (prev.hasDetailImages !== next.hasDetailImages) diffs.push(`상세이미지: ${prev.hasDetailImages ? '있었음' : '없었음'} → ${next.hasDetailImages ? '있음' : '없음'}`)
  if (prev.hasDetailText !== next.hasDetailText) diffs.push(`상세페이지 텍스트: ${prev.hasDetailText ? '있었음' : '없었음'} → ${next.hasDetailText ? '있음' : '없음'}`)
  if (prev.hasStockQty !== next.hasStockQty) diffs.push(`재고수량 표시: ${prev.hasStockQty ? '있었음' : '없었음'} → ${next.hasStockQty ? '있음' : '없음'}`)
  if (prev.hasStockStatusText !== next.hasStockStatusText) diffs.push(`재고상태 문구: ${prev.hasStockStatusText ? '있었음' : '없었음'} → ${next.hasStockStatusText ? '있음' : '없음'}`)
  if (prev.hasStockByOption !== next.hasStockByOption) diffs.push(`옵션별 재고 위젯: ${prev.hasStockByOption ? '있었음' : '없었음'} → ${next.hasStockByOption ? '있음' : '없음'}`)
  if (prev.hasCascadingOptions !== next.hasCascadingOptions) diffs.push(`연쇄옵션(색상→사이즈 등): ${prev.hasCascadingOptions ? '있었음' : '없었음'} → ${next.hasCascadingOptions ? '있음' : '없음'}`)
  const prevOpt = new Set(prev.optionUiTypes)
  const nextOpt = new Set(next.optionUiTypes)
  if (prevOpt.size !== nextOpt.size || [...prevOpt].some(t => !nextOpt.has(t))) {
    diffs.push(`옵션 UI 형태: [${prev.optionUiTypes.join('/') || '없음'}] → [${next.optionUiTypes.join('/') || '없음'}]`)
  }
  const prevLabels = new Set(prev.infoLabels)
  const nextLabels = new Set(next.infoLabels)
  const newLabels = next.infoLabels.filter(l => !prevLabels.has(l))
  const droppedLabels = prev.infoLabels.filter(l => !nextLabels.has(l))
  if (newLabels.length) diffs.push(`상품정보 항목 추가됨: ${newLabels.join(', ')}`)
  if (droppedLabels.length) diffs.push(`상품정보 항목 사라짐: ${droppedLabels.join(', ')}`)
  return diffs
}

/**
 * 로그인 확인마다 백그라운드로 호출한다. 이 몰의 기준정보(sites.scrape_profile)가 없으면 이번 샘플링
 * 결과를 기준정보로 저장하고, 있으면 새로 샘플링한 결과와 비교해 구조가 달라졌을 때만 메모로 남긴다.
 * (Mall 목록 화면에 이미 "최신 메모" 컬럼이 있어 별도 알림 UI 없이 그대로 노출된다.)
 */
export async function runMallProfileCheck(siteId: number): Promise<void> {
  const next = await profileMallStructure(siteId)
  if (!next) return

  const res = await pool.query<{ scrape_profile: MallProfileSignals | null }>(
    `SELECT scrape_profile FROM sites WHERE id = $1`, [siteId],
  )
  const prev = res.rows[0]?.scrape_profile || null

  await pool.query(
    `UPDATE sites SET scrape_profile = $1, scrape_profile_updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(next), siteId],
  )

  if (!prev) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `🔍 상품페이지 구조 파악 완료 (샘플 ${next.sampleCount}건): ${summarizeProfile(next)}`],
    )
    return
  }

  const diffs = describeDiff(prev, next)
  if (diffs.length) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `⚠ 상품페이지 구조 변경 감지: ${diffs.join(' / ')}`],
    )
  }
}
