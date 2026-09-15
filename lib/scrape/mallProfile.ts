import pool from '../db'
import { profileMallStructure, profileMallStructureForScrape, type MallProfileSignals, type ScrapeOptions } from '../scraper'
import { runAutoAnalysis } from './adjustment'
import { checkCategoryAnomaly } from './categoryAnomalyCheck'
import { mergeSortOptions, shouldKeepPreviousCategoryLinks } from './categoryCachePolicy'
import type { MallStructureReport, AiProviderId } from '../ai'
import { ALL_AI_PROVIDERS } from '../ai'

/** primary를 기준으로 하되, primary가 놓친(undefined 또는 "확인 안됨") 항목만 secondary 값으로
 *  채운다 — "어느 쪽을 기준으로 삼을지"(품질 좋은 쪽)와 "그 기준에 빠진 항목을 다른 쪽에서 보강"을
 *  분리하지 않고 한 번에 처리한다. 예전엔 이 둘을 별개 분기로 나눠서, 기준으로 정한 리포트를 통째로
 *  가져다 쓰는 분기를 타면 그 리포트 자체가 이미 항목 하나(sortStructure)를 통째로 잃어버린 상태여도
 *  보강 없이 그 "없음"이 그대로 영구히 이어져 내려가는 결함이 있었다(걸스굽 몰 실사용 확인, 2026-09-01
 *  — 정렬 구조 필드가 몇 주째 계속 비어있었음, AI 리포트 자체는 매번 통째로 교체되니 한 번 빠지면
 *  스스로 못 채움). Object.keys(primary)만 훑으면 secondary에만 있는 키(primary에서 아예 빠진 키)를
 *  놓치므로, 두 객체의 키를 합쳐서 훑는다. */
export function mergeReports(primary: MallStructureReport, secondary: MallStructureReport | null | undefined): MallStructureReport {
  if (!secondary) return primary
  const merged: MallStructureReport = { ...primary }
  const keys = new Set([...Object.keys(primary), ...Object.keys(secondary)]) as Set<keyof MallStructureReport>
  for (const key of keys) {
    // generatedBy처럼 scrapingNeeds도 "이 몰의 실제 데이터"가 아니라 리포트 출처에 묶인 메타 정보다 —
    // buildHeuristicMallReport(lib/ai.ts)가 채우는 값은 이 몰의 진짜 스크래핑 유의사항이 아니라 "AI
    // 미사용(규칙 기반) 리포트 — 정확도가 낮을 수 있음"이라는 경고문 그 자체라, secondary가 heuristic
    // 리포트일 때 이 필드를 여기서처럼 그냥 채워 넣으면 merged.generatedBy는 'ai'인데 그 안의
    // scrapingNeeds엔 "AI 미사용" 경고가 섞여 들어가는 자기모순이 생긴다(사용자 실사용 확인, 2026-09-03
    // — 시즌백에서 Anthropic/Gemini가 예전에 만든 'ai' 리포트에 방금 실패한 heuristic 실행의 경고문이
    // 병합돼 "AI 성공"이라 떠 있는데 내용은 "AI 미사용"이라고 나옴). primary 쪽 값을 그대로 쓴다 —
    // primary가 heuristic 자체면(다른 리포트가 없을 때) 그 경고문이 정상적으로 그대로 보인다.
    if (key === 'generatedBy' || key === 'scrapingNeeds') continue
    const v = merged[key]
    const sv = secondary[key]
    if ((v === undefined || v === '확인 안됨') && sv && sv !== '확인 안됨') merged[key] = sv as never
  }
  return merged
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
  /** 이번 실행에서 거래정보 리포트(report)를 실제로 새로 만들었는지 — 'ai'/'ollama'/'heuristic'는 이번
   *  실행이 직접 만든 결과, null은 이번 실행이 report를 아예 안 만들었다는 뜻(deep=false 등). 화면에
   *  최종 저장된 report.generatedBy만 보여주면 "AI 실패 시 예전 리포트를 그대로 이어받는" 안전장치 때문에
   *  이번 실행이 실패했다는 사실 자체가 안 보이므로 별도로 둔다. */
  thisRunReportSource: 'ai' | 'heuristic' | 'ollama' | 'groq' | null
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

  // 화면에 "이번 실행에서 AI가 실제로 성공했는지"를 알려주기 위해, 아래에서 next.report를 병합/치환하기
  // 전(이번 실행이 실제로 만든 그대로) 값을 따로 남겨둔다 — 병합 후엔 next.report.generatedBy가 최종
  // 채택된 리포트의 출처(대개 'ai', 예전 리포트를 그대로 이어받았을 때도)를 가리키게 되어 "이번 실행
  // 자체는 실패했다"는 사실이 가려진다(2026-09-01, Anthropic 크레딧 소진+Gemini 과부하가 겹쳤을 때
  // 화면엔 아무 신호 없이 예전 리포트가 계속 보여 사용자가 원인을 알 방법이 없었다는 지적).
  const thisRunReportSource: 'ai' | 'heuristic' | 'ollama' | 'groq' | null = next.report?.generatedBy ?? null
  // DB에도 그대로 남겨 개발자모드(확장이 직접 이 함수를 호출해 화면이 응답을 못 받음)가 나중에 GET으로
  // 같은 값을 읽어갈 수 있게 한다 — MallProfileSignals.lastRunReportSource 주석 참고.
  next.lastRunReportSource = thisRunReportSource

  // AI 크레딧이 없어 규칙 기반/로컬 Ollama로 떨어진 결과가, 이전에 실제 클라우드 AI가 만들어둔 더 정확한
  // 리포트를 조용히 덮어써버리면 안 된다 — "몰 구조분석"을 다시 눌렀는데 그 사이 AI 호출이 실패했다면
  // 기존 AI 리포트를 기준으로 삼는다(사용자가 화면에서 이유도 모른 채 리포트 품질이 나빠지는 것을 방지).
  // 'heuristic'과 'ollama' 둘 다 'ai'(클라우드)보다 약한 결과로 취급한다 — Ollama가 이런 종합 추출에
  // 클라우드보다 약하다는 게 실측으로 확인돼 있어(generateMallProfileReportOllama 주석 참고), 규칙
  // 기반과 똑같이 "예전 클라우드 AI 결과를 우선"한다. 반대로 이번 실행을 기준으로 삼는 경우(둘 다
  // ai거나 둘 다 heuristic 등)에도, 기준 리포트에 항목 하나가 빠져있으면(예: 정렬 옵션 샘플로 시도한
  // 카테고리 5개가 하필 전부 로그인/도매인증이 필요한 페이지였던 경우) 다른 쪽에서라도 채운다 — 안
  // 그러면 "기준 리포트를 통째로 쓴다"는 규칙 때문에 그 리포트가 예전에 한 번 놓친 항목이 스스로 못
  // 채운 채 영원히 이어져 내려간다(걸스굽 몰 실사용 확인, 2026-08-31→2026-09-01 — sortOptions 자체는
  // 아래(사이 근처) 가드로 안 지워지는데, report.sortStructure는 그 보호가 없어 혼자 "확인 안됨"이
  // 아니라 키 자체가 통째로 빠진 채 몇 주째 복구가 안 됐다). 자세한 병합 규칙은 mergeReports 참고.
  if (!next.report && prev?.report) next.report = prev.report
  else if (next.report && prev?.report) {
    const preferPrev = next.report.generatedBy !== 'ai' && prev.report.generatedBy === 'ai'
    next.report = preferPrev ? mergeReports(prev.report, next.report) : mergeReports(next.report, prev.report)
  }

  // sortOptions는 이 서버 경로(sampleMallProfile)와 개발자모드 확장(runDetectSortOptions)이 "몰 구조분석"
  // 한 번에 병렬로 각자 독립적으로 찾아 같은 자리에 쓸 수 있다 — 로그인 없이도 서버가 카테고리 페이지를
  // 열어볼 수 있는 몰에서는 둘 다 진짜로 뭔가를 찾아내는데, 서로 다른 부분집합을 찾고 나중에 쓰는 쪽이
  // 그대로 덮어써 "정렬 구조"가 실행마다 무작위로 바뀌어 보였다(모자사러 실사용 확인, 2026-09-09).
  // label 기준으로 합쳐서 둘 다 잃지 않는다(mergeSortOptions 주석 참고) — next가 비어있으면 그냥 prev를
  // 그대로 쓰는 예전 동작(2026-08-19)도 이 함수 하나로 그대로 커버된다.
  next.sortOptions = mergeSortOptions(prev?.sortOptions, next.sortOptions)

  // 카테고리도 report와 같은 이유로 AI→규칙기반 품질 저하를 막는다: 이번엔 AI(로컬 Ollama)가 실패해
  // 규칙 기반으로 떨어졌는데 예전엔 AI가 성공해 정확한 카테고리를 찾아둔 상태였다면, 그 결과를 그대로
  // 유지한다(신우 몰 실사용 확인, 2026-08-25 — "몰구조분석을 다시 하니 '규칙 기반' + 무관한 카테고리만
  // 나온다"). deep=true도 예외 없이 적용한다 — 아래 개수 축소 가드(deep=false 전용)는 "실제로 카테고리가
  // 줄었을 수 있다"는 다른 문제를 다루는 것이라 별개다.
  //
  // 다만 "AI 채택 여부"만으로 판단하면 "규칙 기반이 AI보다 항상 못하다"고 단정하는 셈이라, 이번에 새로
  // 찾은 개수가 예전보다 뚜렷이 많을 때도 무조건 예전(AI) 결과로 되돌리는 사고가 났다(정글북 실사용
  // 확인, 2026-09-15 — scanCategoryMenu/scanCategoryOverviewPage를 고쳐 규칙 기반으로 79개를 정확히
  // "대분류 > 중분류"까지 구분해 찾았는데도, 예전에 AI 텍스트 폴백이 뭉뚱그려 저장해둔 57개짜리 결과로
  // 매번 되돌아가 "몰구조분석을 다시 해도 결과가 그대로"였다). "카테고리 불러오기"(app/api/scrape/
  // categories/route.ts)가 바로 이 문제를 막으려고 만든 shouldKeepPreviousCategoryLinks(개수가 늘면 AI
  // 여부와 무관하게 더 나은 결과로 봄)가 있는데 여기는 그 판단을 따로 손으로 다시 짜뒀던 게 원인이었다
  // — 같은 판단을 두 곳에 따로 두면 이렇게 갈라진다는 게 실제로 확인됐으니, 이제 같은 함수를 쓴다.
  if (shouldKeepPreviousCategoryLinks({
    freshAiUsed: !!next.categoryLinksAiUsed,
    freshLoginBlockedExpansion: false,
    freshCategoryLinksCount: next.categoryLinks?.length ?? 0,
    prevAiUsed: !!prev?.categoryLinksAiUsed,
    prevCategoryLinksCount: prev?.categoryLinks?.length ?? 0,
  }) && prev?.categoryLinks?.length) {
    next.categoryLinks = prev.categoryLinks
    next.categoryMenuNames = prev.categoryMenuNames
    next.categoryLinksAiUsed = prev.categoryLinksAiUsed
    // categoryUrlPattern은 이번 회차에 새로 감지된(품질이 나빠 방금 버려진) categoryLinks에서 역산된
    // 값이라 위에서 되돌린 categoryLinks와 짝이 안 맞을 수 있다 — "카테고리 불러오기"는 이 패턴을 최우선
    // 지름길로 쓰므로(discoverTopLevelCategoryLinks), 어긋난 패턴이 남으면 되돌린 categoryLinks와 전혀
    // 다른(엉뚱한 게시판 등) 링크를 찾아오게 된다. categoryLinks를 되돌릴 땐 패턴도 같이 되돌린다
    // (오토카필 몰 실사용 확인, 2026-08-29 — "몰 구조분석"과 "카테고리 불러오기" 결과가 전혀 다름).
    next.categoryUrlPattern = prev.categoryUrlPattern
  } else if (prev?.categoryLinks?.length && next.categoryLinks.length < prev.categoryLinks.length) {
    // categoryLinks는 deep=false("구조 변화 감지", 로그인 확인/스크랩 시작마다 자동으로 돎)에서도 매번
    // 다시(얕게) 계산된다 — 개발자모드 확장의 "카테고리 하위구조 자동확인"(runExpandCategories)이 펼쳐둔
    // 하위 카테고리 목록의 권위 있는 갱신 창구가 아니므로, 그 결과가 이전보다 얕아졌으면(개수가 줄었으면)
    // 덮어쓰지 않는다.
    // 원래는 deep=true(사용자가 명시적으로 누른 "몰 구조분석")는 실제 카테고리 구조 축소를 반영할 수
    // 있어야 한다고 보고 이 가드에서 제외했었다 — 그런데 펫토리 실사용으로 이게 실제 사고로 이어지는 걸
    // 확인했다(2026-09-07): 이 몰은 서버 헤드리스 경로가 구조적으로 절대 로그인을 못 하므로(위 파일
    // 상단 참고), "몰 구조분석"을 실행할 때마다 그 안의 서버 쪽 카테고리 재탐지 단계가 매번 실패에
    // 가까운 결과를 내는데, 이 가드가 deep=true를 봐주는 바람에 "카테고리 불러오기"/확장이 어렵게
    // 찾아둔 정상 결과(17개)를 몰 구조분석 한 번에 조용히 지워버렸다 — 그 직후 확장의 하위구조 자동확인이
    // 이미 망가진 목록을 이어받아 엉뚱한 부모 아래로 수백 개를 잘못 붙이는 2차 사고로 번졌다. "진짜
    // 구조 축소"와 "이번 탐지가 실패함"을 이 개수 비교만으로는 구분할 수 없으니, deep 여부와 무관하게
    // 안전한 쪽(줄었으면 일단 지킨다)을 택한다 — 진짜 축소를 반영하고 싶으면 "카테고리 불러오기 다시
    // 확인"(shouldKeepPreviousCategoryLinks, 개수가 늘 때만 명확히 덮어씀)을 쓰면 된다.
    next.categoryLinks = prev.categoryLinks
    next.categoryMenuNames = prev.categoryMenuNames
    next.categoryUrlPattern = prev.categoryUrlPattern
  }

  // "몰 구조분석"(deep=true)일 때만 새 카테고리 구조가 검증된 과거 카테고리와 비교해 터무니없는지 AI로
  // 한 번 더 확인한다 — deep=false("구조 변화 감지")는 로그인 확인/스크랩 시작마다 자동으로 도는 가벼운
  // 경로라 매번 AI를 부르면 비용/지연만 늘고, 그 경로의 categoryLinks는 이미 위 가드로 "얕아지면 무시"
  // 처리돼 있어 이 검사의 효용도 낮다. 실행 안 했거나(과거 증거 부족) 검사를 안 돌린 경우엔
  // categoryCounts/excludedCategoryHrefs와 같은 이유로 이전 경고를 그대로 이어받는다 — 안 그러면 이
  // UPDATE가 scrape_profile을 통째로 갈아치우므로 있던 경고가 조용히 사라진다.
  // 이번 응답엔 일단 이전 경고를 그대로 이어받는다 — 실제 검사는 아래(메인 UPDATE 이후)에서 백그라운드로
  // 돌린다. checkCategoryAnomaly가 Anthropic/Gemini 둘 다 실패해 로컬 Ollama까지 가면(detectCategoryAnomalyOllama
  // 주석 참고) 180초 가까이 걸릴 수 있는데, 여기서 그대로 기다리면 "몰 구조분석" 결과 자체는 이미 다
  // 끝났는데도 화면 전체가 그 검사 하나 때문에 3분 넘게 안 뜨는 문제가 있었다(걸스굽 실사용 확인,
  // 2026-09-02 — Gemini가 불안정한 밤엔 거의 매번 재현됨). 이 검사는 원래도 "오탐이면 그냥 경고 없음"인
  // fail-open 안전망이라, 이번 응답에 안 실려도(다음에 이 몰을 다시 볼 때 반영) 치명적이지 않다.
  const categoryAnomalyWarning = prev?.categoryAnomalyWarning ?? null
  next.categoryAnomalyWarning = categoryAnomalyWarning

  // "카테고리 불러오기" 체크리스트가 "발견된 카테고리 N개" 옆에 "몰 구조분석 이후 새로 생긴 카테고리가
  // 몇 개인지"를 보여줄 수 있게, 위 가드들이 최종 확정한 categoryLinks를 이 실행 전(prev) 목록과 비교해
  // 새로 나타난 href만 남긴다(사용자 요청, 2026-09-05). 위에서 품질 저하를 막느라 prev.categoryLinks로
  // 되돌린 경우(146행 근처)엔 자연히 빈 배열이 된다 — 실제로 아무것도 안 바뀌었으니 "새 카테고리"도
  // 없는 게 맞다. deep 여부와 무관하게 계산한다 — categoryLinks 자체가 deep=false에서도 매번 다시 계산돼
  // 이 시점에 이미 최신 상태이기 때문이다.
  const prevCategoryHrefs = new Set((prev?.categoryLinks || []).map(c => c.href))
  const newCategoryHrefs = (next.categoryLinks || []).filter(c => !prevCategoryHrefs.has(c.href)).map(c => c.href)

  // sampleProductPageText는 아래(runMallStructureReport)에서 추출규칙 자동생성에만 쓰는 임시 값 —
  // 원문 그대로라 용량이 커 기준정보로 영구 저장하지 않는다. categoryCounts/excludedCategoryHrefs는
  // MallProfileSignals에 없는 필드(app/api/scrape/categories/route.ts가 따로 관리)인데, 이 UPDATE가
  // scrape_profile 전체를 next로 통째로 갈아치우므로 명시적으로 이어받지 않으면 "몰 구조분석"을 한 번
  // 돌릴 때마다 카테고리 체크리스트의 상품개수/확인일시와 "제외" 표시가 조용히 사라진다(신우 몰 확인
  // 과정에서 같이 발견한 별개 결함, 2026-08-25).
  await pool.query(
    `UPDATE sites SET scrape_profile = $1, scrape_profile_updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({
      // sessionLostDuringAnalysis: undefined — 이번 실행 한정 신호라 저장 안 함(MallProfileSignals 주석
      // 참고) — 안 그러면 다음에 이 몰을 선택했을 때(캐시 복원) 이미 지난 경고가 계속 남아있게 된다.
      ...next, sampleProductPageText: undefined, sessionLostDuringAnalysis: undefined,
      categoryCounts: prev?.categoryCounts, excludedCategoryHrefs: prev?.excludedCategoryHrefs,
      newCategoryHrefs,
    }), siteId],
  )

  // 카테고리 이상탐지는 위 categoryAnomalyWarning 주석 참고 — 메인 UPDATE가 이미 끝난 뒤에, 응답을
  // 기다리게 하지 않고 백그라운드로 돌린다. 끝나면 그 결과만 scrape_profile.categoryAnomalyWarning에
  // 따로 반영한다(jsonb_set — 그 사이 다른 실행이 scrape_profile의 다른 필드를 갈아치웠어도 이 한
  // 필드만 건드리므로 서로 덮어쓰지 않는다). await 없이 그냥 발사한다 — 이 함수(applyProfileResult)의
  // 반환을 막으면 안 되므로 실패해도 여기서 조용히 삼킨다.
  if (deep && next.categoryLinks.length) {
    void (async () => {
      try {
        const siteRow = await pool.query<{ name: string | null }>('SELECT name FROM sites WHERE id = $1', [siteId])
        const mallName = siteRow.rows[0]?.name || `site-${siteId}`
        const anomaly = await checkCategoryAnomaly(siteId, mallName, next.categoryLinks.map(c => ({ name: c.name, href: c.href })))
        const warning = anomaly ? { reason: anomaly.reason, checkedAt: new Date().toISOString(), source: anomaly.source } : null
        await pool.query(
          `UPDATE sites SET scrape_profile = jsonb_set(COALESCE(scrape_profile, '{}'::jsonb), '{categoryAnomalyWarning}', $1::jsonb) WHERE id = $2`,
          [JSON.stringify(warning), siteId],
        )
      } catch { /* 백그라운드 안전망일 뿐이라 실패해도 몰 구조분석 결과 자체엔 영향 없음 */ }
    })()
  }

  // "몰 구조분석"(deep)은 site_memos("운영 메모")에 아무것도 쓰지 않는다 — 운영 메모는 사용자가 직접
  // 기록·수정하는 공간으로 두고, 이 결과는 SiteDetailPanel이 sites.scrape_profile에서 직접 읽어 운영
  // 메모 아래에 "최근 1건"짜리 참고용 표시로만 보여준다(사용자가 그 내용을 보고 필요한 걸 운영 메모에
  // 직접 옮겨 적는 용도). 로그인 확인 전용 "구조 변경 감지" 메모와도 완전히 분리된다.
  if (deep) return { signals: next, diffs: [], isFirstTime: !prev, autoRuleFields: [], thisRunReportSource }

  if (!prev) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `🔍 상품페이지 구조 파악 완료 (샘플 ${next.sampleCount}건): ${summarizeProfile(next)}`],
    )
    return { signals: next, diffs: [], isFirstTime: true, autoRuleFields: [], thisRunReportSource }
  }

  const diffs = describeDiff(prev, next)
  if (diffs.length) {
    await pool.query(
      `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
      [siteId, `⚠ 상품페이지 구조 변경 감지: ${diffs.join(' / ')}`],
    )
  }
  return { signals: next, diffs, isFirstTime: false, autoRuleFields: [], thisRunReportSource }
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
export async function runMallStructureReport(siteId: number, aiProviders: AiProviderId[] = ALL_AI_PROVIDERS): Promise<ProfileCheckResult | null> {
  const next = await profileMallStructure(siteId, true, aiProviders)
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
