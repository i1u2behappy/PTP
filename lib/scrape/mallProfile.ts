import pool from '../db'
import { profileMallStructure, profileMallStructureForScrape, type MallProfileSignals, type ScrapeOptions } from '../scraper'

// 로그인 확인 직후 이 몰의 백그라운드 구조 체크가 아직 도는 중인지 추적한다 — 그 사이 사용자가 같은
// 로그인 창(탭)을 쓰는 다른 기능(미리보기/요소 지정 등)을 누르면 페이지 이동이 서로 겹쳐 조용히
// 결과가 틀어질 수 있어(실측: 겹치면 둘 중 하나의 page.goto가 net::ERR_ABORTED로 조용히 실패), "로그인
// 확인" 버튼을 깜빡이게 해 사용자가 끝날 때까지 기다리도록 안내한다. globalThis에 두는 이유는 다른
// 세션 상태(openSessions 등)와 같다 — 개발서버 핫리로드로 모듈이 재평가돼도 진행 중 여부가 유지되도록.
declare global {
  var __profileCheckInProgress: Set<number> | undefined
}
const profileCheckInProgress = globalThis.__profileCheckInProgress ?? (globalThis.__profileCheckInProgress = new Set<number>())

export function isProfileCheckInProgress(siteId: number): boolean {
  return profileCheckInProgress.has(siteId)
}

function summarizeProfile(p: MallProfileSignals): string {
  return [
    `플랫폼: ${p.platform}`,
    p.categoryMenuNames.length > 0
      ? `카테고리 메뉴: 전체 ${p.categoryMenuNames.length}개(${p.categoryMenuNames.slice(0, 5).join(', ')}${p.categoryMenuNames.length > 5 ? ' 등' : ''})`
      : `카테고리: ${p.categoryMaxDepth > 0 ? `${p.categoryMaxDepth}단계 (샘플 기준, 전체 트리 아님)` : '파악 안 됨'}`,
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
  if (prev.platform !== next.platform) diffs.push(`플랫폼: ${prev.platform} → ${next.platform}`)
  if (prev.categoryMaxDepth !== next.categoryMaxDepth) diffs.push(`카테고리 단계: ${prev.categoryMaxDepth || '?'} → ${next.categoryMaxDepth || '?'}`)
  if (prev.categoryMenuNames.length !== next.categoryMenuNames.length) diffs.push(`카테고리 메뉴 개수: ${prev.categoryMenuNames.length} → ${next.categoryMenuNames.length}`)
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

export interface ProfileCheckResult {
  signals: MallProfileSignals
  /** 기준정보가 이미 있었는데 이번에 달라진 점 — 최초 프로파일링이면 항상 빈 배열. */
  diffs: string[]
  isFirstTime: boolean
}

/** 새로 샘플링한 프로파일을 기준정보와 비교해 DB에 반영한다. 기준정보가 없으면 이번 결과를 기준으로
 * 저장하고, 있으면 달라진 점만 site_memos에 메모로 남긴다(Mall 목록의 "최신 메모" 컬럼에 그대로 노출).
 * deep=false(로그인 확인/스크랩 시작 — 구조 변화 감지 전용)는 report를 만들지 않는데, 그렇다고 이전에
 * "몰 구조 파악" 버튼(deep=true)이 만들어둔 거래정보 리포트를 지워버리면 안 되므로 prev.report를 그대로
 * 이어받는다. */
async function applyProfileResult(siteId: number, next: MallProfileSignals, deep: boolean): Promise<ProfileCheckResult> {
  const res = await pool.query<{ scrape_profile: MallProfileSignals | null }>(
    `SELECT scrape_profile FROM sites WHERE id = $1`, [siteId],
  )
  const prev = res.rows[0]?.scrape_profile || null
  if (!next.report && prev?.report) next.report = prev.report
  // AI 크레딧이 없어 규칙 기반으로 떨어진 결과가, 이전에 실제 AI가 만들어둔 더 정확한 리포트를 조용히
  // 덮어써버리면 안 된다 — "몰 구조 파악"을 다시 눌렀는데 그 사이 AI 호출이 실패했다면 기존 AI 리포트를
  // 그대로 유지한다(사용자가 화면에서 이유도 모른 채 리포트 품질이 나빠지는 것을 방지).
  else if (next.report?.generatedBy === 'heuristic' && prev?.report?.generatedBy === 'ai') next.report = prev.report

  await pool.query(
    `UPDATE sites SET scrape_profile = $1, scrape_profile_updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(next), siteId],
  )

  // "몰 구조 파악"(deep)은 site_memos("운영 메모")에 아무것도 쓰지 않는다 — 운영 메모는 사용자가 직접
  // 기록·수정하는 공간으로 두고, 이 결과는 SiteDetailPanel이 sites.scrape_profile에서 직접 읽어 운영
  // 메모 아래에 "최근 1건"짜리 참고용 표시로만 보여준다(사용자가 그 내용을 보고 필요한 걸 운영 메모에
  // 직접 옮겨 적는 용도). 로그인 확인 전용 "구조 변경 감지" 메모와도 완전히 분리된다.
  if (deep) return { signals: next, diffs: [], isFirstTime: !prev }

  if (!prev) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `🔍 상품페이지 구조 파악 완료 (샘플 ${next.sampleCount}건): ${summarizeProfile(next)}`],
    )
    return { signals: next, diffs: [], isFirstTime: true }
  }

  const diffs = describeDiff(prev, next)
  if (diffs.length) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `⚠ 상품페이지 구조 변경 감지: ${diffs.join(' / ')}`],
    )
  }
  return { signals: next, diffs, isFirstTime: false }
}

/**
 * 로그인 확인마다 백그라운드로 호출한다 — 상품/홈페이지 "구조 변화 감지" 전용(deep=false 고정, 결제계좌·
 * 택배사 같은 거래정보 분석은 하지 않는다). 로그인 창(openSessions)이 열려있어야 동작한다 — 직접로그인
 * 필수 몰처럼 추적되는 세션이 없으면 아무 일도 하지 않으므로, 그 경우를 위해 runMallProfileCheckForScrape가 있다.
 * "몰 구조 파악" 버튼은 용도가 다른(거래정보 분석) runMallStructureReport를 대신 쓴다.
 */
export async function runMallProfileCheck(siteId: number): Promise<ProfileCheckResult | null> {
  profileCheckInProgress.add(siteId)
  try {
    const next = await profileMallStructure(siteId, false)
    if (!next) return null
    return applyProfileResult(siteId, next, false)
  } finally {
    profileCheckInProgress.delete(siteId)
  }
}

/**
 * "몰 구조 파악" 버튼 전용 — 결제계좌/택배사/업체연락처/URL 계층 등 거래정보를 AI로 분석한다(deep=true).
 * runMallProfileCheck(로그인 확인 자동 체크, 구조 변화 감지 전용)와는 용도가 다르다: 사용자가 직접
 * "각각 다른 용도로 파악하고 리포팅"하도록 분리해달라고 확정함.
 */
export async function runMallStructureReport(siteId: number): Promise<ProfileCheckResult | null> {
  const next = await profileMallStructure(siteId, true)
  if (!next) return null
  return applyProfileResult(siteId, next, true)
}

/**
 * 실제 스크래핑 시작마다 백그라운드로 호출한다. openSessions 추적 여부와 무관하게 그 스크랩이 쓸 브라우저
 * 컨텍스트를 그대로 재사용해 프로파일링하므로, 직접로그인 필수 몰을 포함한 모든 몰 유형에서 동작한다.
 */
export async function runMallProfileCheckForScrape(opts: ScrapeOptions): Promise<ProfileCheckResult | null> {
  if (!opts.siteId) return null
  const next = await profileMallStructureForScrape(opts)
  if (!next) return null
  return applyProfileResult(opts.siteId, next, false)
}
