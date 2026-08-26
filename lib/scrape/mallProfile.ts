import pool from '../db'
import { profileMallStructure, profileMallStructureForScrape, type MallProfileSignals, type ScrapeOptions } from '../scraper'
import { runAutoAnalysis } from './adjustment'

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
    p.hasPaginationWidget ? '페이지네이션 위젯 있음' : '페이지네이션 위젯 없음(미리보기 개수 확인 시 지수 탐색만 사용)',
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
  if (prev.hasPaginationWidget !== next.hasPaginationWidget) diffs.push(`페이지네이션 위젯: ${prev.hasPaginationWidget ? '있었음' : '없었음'} → ${next.hasPaginationWidget ? '있음' : '없음'}`)
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
  /** "몰 구조분석" 직후 자동으로 채워진 추출규칙 필드명 — 미리보기/스크랩이 이제 이 몰의 구조를
   *  실제로 참조한다는 것을 사용자가 확인할 수 있도록. deep=false(구조 변화 감지)에서는 항상 빈 배열. */
  autoRuleFields: string[]
}

/** 새로 샘플링한 프로파일을 기준정보와 비교해 DB에 반영한다. 기준정보가 없으면 이번 결과를 기준으로
 * 저장하고, 있으면 달라진 점만 site_memos에 메모로 남긴다(Mall 목록의 "최신 메모" 컬럼에 그대로 노출).
 * deep=false(로그인 확인/스크랩 시작 — 구조 변화 감지 전용)는 report를 만들지 않는데, 그렇다고 이전에
 * "몰 구조분석" 버튼(deep=true)이 만들어둔 거래정보 리포트를 지워버리면 안 되므로 prev.report를 그대로
 * 이어받는다. */
async function applyProfileResult(siteId: number, next: MallProfileSignals, deep: boolean): Promise<ProfileCheckResult> {
  const res = await pool.query<{
    scrape_profile: (MallProfileSignals & { categoryCounts?: unknown; excludedCategoryHrefs?: string[] }) | null
  }>(`SELECT scrape_profile FROM sites WHERE id = $1`, [siteId])
  const prev = res.rows[0]?.scrape_profile || null
  if (!next.report && prev?.report) next.report = prev.report
  // AI 크레딧이 없어 규칙 기반으로 떨어진 결과가, 이전에 실제 AI가 만들어둔 더 정확한 리포트를 조용히
  // 덮어써버리면 안 된다 — "몰 구조분석"을 다시 눌렀는데 그 사이 AI 호출이 실패했다면 기존 AI 리포트를
  // 그대로 유지한다(사용자가 화면에서 이유도 모른 채 리포트 품질이 나빠지는 것을 방지).
  else if (next.report?.generatedBy === 'heuristic' && prev?.report?.generatedBy === 'ai') next.report = prev.report

  // sortOptions는 deep=false거나 로그인 필요 몰이면 항상 []이다(성공적으로 "더 적게" 나올 일이 없음) —
  // 개발자모드 확장(runDetectSortOptions)이 채워둔 값을 이 얕은/실패 경로가 조용히 지우지 못하게 한다
  // (사용자 요청, 2026-08-19 — 위 report 가드와 같은 이유).
  if (!next.sortOptions?.length && prev?.sortOptions?.length) next.sortOptions = prev.sortOptions

  // 카테고리도 report와 같은 이유로 AI→규칙기반 품질 저하를 막는다: 이번엔 AI(로컬 Ollama)가 실패해
  // 규칙 기반으로 떨어졌는데 예전엔 AI가 성공해 정확한 카테고리를 찾아둔 상태였다면, 그 결과를 그대로
  // 유지한다(신우 몰 실사용 확인, 2026-08-25 — "몰구조분석을 다시 하니 '규칙 기반' + 무관한 카테고리만
  // 나온다"). deep=true도 예외 없이 적용한다 — 아래 개수 축소 가드(deep=false 전용)는 "실제로 카테고리가
  // 줄었을 수 있다"는 다른 문제를 다루는 것이라 별개다.
  if (!next.categoryLinksAiUsed && prev?.categoryLinksAiUsed && prev.categoryLinks?.length) {
    next.categoryLinks = prev.categoryLinks
    next.categoryMenuNames = prev.categoryMenuNames
    next.categoryLinksAiUsed = prev.categoryLinksAiUsed
  } else if (!deep && prev?.categoryLinks?.length && next.categoryLinks.length < prev.categoryLinks.length) {
    // categoryLinks는 deep=false("구조 변화 감지", 로그인 확인/스크랩 시작마다 자동으로 돎)에서도 매번
    // 다시(얕게) 계산된다 — 개발자모드 확장의 "카테고리 하위구조 자동확인"(runExpandCategories)이 펼쳐둔
    // 하위 카테고리 목록의 권위 있는 갱신 창구가 아니므로, 그 결과가 이전보다 얕아졌으면(개수가 줄었으면)
    // 덮어쓰지 않는다. deep=true(사용자가 명시적으로 누른 "몰 구조분석")는 실제 카테고리 구조 축소를
    // 반영할 수 있어야 하므로 건드리지 않는다.
    next.categoryLinks = prev.categoryLinks
    next.categoryMenuNames = prev.categoryMenuNames
  }

  // sampleProductPageText는 아래(runMallStructureReport)에서 추출규칙 자동생성에만 쓰는 임시 값 —
  // 원문 그대로라 용량이 커 기준정보로 영구 저장하지 않는다. categoryCounts/excludedCategoryHrefs는
  // MallProfileSignals에 없는 필드(app/api/scrape/categories/route.ts가 따로 관리)인데, 이 UPDATE가
  // scrape_profile 전체를 next로 통째로 갈아치우므로 명시적으로 이어받지 않으면 "몰 구조분석"을 한 번
  // 돌릴 때마다 카테고리 체크리스트의 상품개수/확인일시와 "제외" 표시가 조용히 사라진다(신우 몰 확인
  // 과정에서 같이 발견한 별개 결함, 2026-08-25).
  await pool.query(
    `UPDATE sites SET scrape_profile = $1, scrape_profile_updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({
      ...next, sampleProductPageText: undefined,
      categoryCounts: prev?.categoryCounts, excludedCategoryHrefs: prev?.excludedCategoryHrefs,
    }), siteId],
  )

  // "몰 구조분석"(deep)은 site_memos("운영 메모")에 아무것도 쓰지 않는다 — 운영 메모는 사용자가 직접
  // 기록·수정하는 공간으로 두고, 이 결과는 SiteDetailPanel이 sites.scrape_profile에서 직접 읽어 운영
  // 메모 아래에 "최근 1건"짜리 참고용 표시로만 보여준다(사용자가 그 내용을 보고 필요한 걸 운영 메모에
  // 직접 옮겨 적는 용도). 로그인 확인 전용 "구조 변경 감지" 메모와도 완전히 분리된다.
  if (deep) return { signals: next, diffs: [], isFirstTime: !prev, autoRuleFields: [] }

  if (!prev) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `🔍 상품페이지 구조 파악 완료 (샘플 ${next.sampleCount}건): ${summarizeProfile(next)}`],
    )
    return { signals: next, diffs: [], isFirstTime: true, autoRuleFields: [] }
  }

  const diffs = describeDiff(prev, next)
  if (diffs.length) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `⚠ 상품페이지 구조 변경 감지: ${diffs.join(' / ')}`],
    )
  }
  return { signals: next, diffs, isFirstTime: false, autoRuleFields: [] }
}

/**
 * "몰 구조분석" 버튼 전용 — 결제계좌/택배사/업체연락처/URL 계층 등 거래정보를 AI로 분석한다(deep=true).
 * runMallProfileCheckForScrape(구조 변화 감지 전용)와는 용도가 다르다: 사용자가 직접
 * "각각 다른 용도로 파악하고 리포팅"하도록 분리해달라고 확정함.
 *
 * 파악만 하고 끝나면 미리보기/스크랩은 여전히 예전 sites.extraction_rules만 보고 도는 채로 남아
 * 이 결과가 실제로 반영되지 않는 문제가 있었다(사용자 지적: "몰구조파악 한 내용은 이후 미리보기나
 * 스크래핑 할 때 반드시 참조가 되어야해") — AI모드를 켜거나 "스크랩 조정"을 따로 눌러야만 참조되던
 * 것을, 몰 구조분석 직후 자동으로 runAutoAnalysis(기존 값이 있는 필드는 덮어쓰지 않음)를 돌려
 * sites.extraction_rules를 즉시 채운다 — 이후 모든 미리보기/스크랩이 자동으로 이 규칙을 쓴다.
 */
export async function runMallStructureReport(siteId: number, useAi = true): Promise<ProfileCheckResult | null> {
  const next = await profileMallStructure(siteId, true, useAi)
  if (!next) return null
  const result = await applyProfileResult(siteId, next, true)

  if (next.sampleProductPageText) {
    try {
      const { rules } = await runAutoAnalysis(siteId, next.sampleProductPageText)
      result.autoRuleFields = Object.keys(rules)
    } catch { /* Gemini 호출 실패 등 — 몰 구조분석 자체는 이미 성공했으니 결과를 막지 않는다 */ }
  }
  return result
}

/**
 * 몰 구조("구조 변화 감지" 전용, 결제계좌·택배사 같은 거래정보 분석은 안 함) 변경 여부를 확인한다 —
 * 원래는 스크래핑 메뉴의 "로그인 확인" 클릭마다 자동으로 돌았는데, '마이그레이션3_연속관리'로 옮겨
 * 사용자가 그 화면에서 직접 실행하도록 바꿨다(2026-08). 로그인 창(openSessions)을 열어둘 필요 없이,
 * 저장된 계정정보로 이 스크랩이 쓸 브라우저 컨텍스트를 새로 열어 프로파일링하므로 직접로그인 필수 몰을
 * 포함한 모든 몰 유형에서 동작한다.
 */
export async function runMallProfileCheckForScrape(opts: ScrapeOptions): Promise<ProfileCheckResult | null> {
  if (!opts.siteId) return null
  const next = await profileMallStructureForScrape(opts)
  if (!next) return null
  return applyProfileResult(opts.siteId, next, false)
}
