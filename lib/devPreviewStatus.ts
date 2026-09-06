// 개발자모드 "스크랩 미리보기"가 실제로 캡처를 시작했는지·몇 번째 카테고리를 확인 중인지 알리는 순수
// 정보성 신호 — 실제 작업(chrome.debugger로 사용자의 진짜 브라우저 탭을 조작하는 것)은 확장(extension-poc/
// background.js의 runPreview)이 이 프로세스와 무관하게 직접 하므로, lib/scraper.ts의 withSiteLock(실제
// 서버 Playwright 자원을 지키는 락)과는 다른 문제다 — 저기에 얹으면 아무 자원도 안 쥔 채로 락을 흉내
// 내게 되어 안전장치(withSiteLock의 큐)를 오염시킬 위험이 있다. 그래서 이 파일만의 독립된, 순수 표시용
// Map을 둔다. dev 서버 핫리로드에도 값이 살아있어야 폴링이 끊기지 않으므로 globalThis에 저장한다
// (siteLocks 등과 같은 이유).
interface DevPreviewProgress { startedAt: number; lastUpdatedAt: number; done: number; total: number }
const progress = globalThis.__devPreviewProgress ?? (globalThis.__devPreviewProgress = new Map<number, DevPreviewProgress>())
// PTP의 "⏹ 중지"가 눌렸는지 — 개발자모드는 실제 순회가 이 서버가 아니라 확장(사용자 브라우저) 안에서
// 도는 루프라, 일반모드처럼 서버가 직접 멈출 수 없다(withSiteLock/isStopRequested와 같은 문제, run()의
// checkStopRequested와 같은 해법). 여기 신호만 남겨두면 확장이 카테고리/페이지를 확인할 때마다 직접
// 물어봐서(2026-09-06, 사용자 요청: "중지를 누르면 그 순간 멈추라고" — 예전엔 화면만 멈추고 실제 순회는
// 안 끊겨 몰 탭을 강제로 닫아야만 했다) 다음 확인 지점에서 즉시 멈춘다.
const stopRequested = globalThis.__devPreviewStopRequested ?? (globalThis.__devPreviewStopRequested = new Set<number>())

declare global {
  var __devPreviewProgress: Map<number, DevPreviewProgress> | undefined
  var __devPreviewStopRequested: Set<number> | undefined
}

// 정상 종료 시(preview-capture)는 clearDevPreviewStarted가 이 항목을 지우지만, 몰 탭을 강제로 닫거나
// 확장이 도중에 죽으면(디버거 세션이 끊기며 그 이후 코드가 전혀 실행되지 못함) 그 신호 자체가 영영 안
// 온다 — "진행 중" 표시가 고아 상태로 무한정 남아, 사용자가 탭을 닫았다 다시 열어도 화면은 여전히
// "돌고 있다"고 보여준다(2026-09-06 실사용 확인: 카테고리 43/46에서 멈춘 채 몇 분째 그대로였는데도
// started:true가 계속 유지됨). 카테고리 하나가 실제로 몇 분씩 걸릴 수 있다는 걸 감안해(관측된 최댓값
// 7~8분대) 충분히 넉넉한 시간 동안 진행 신호가 전혀 없으면 죽은 것으로 보고 자동으로 만료시킨다 — 별도
// 정리 타이머 없이, 조회 시점에 판단만 하면 되므로 이 방식이 가장 단순하다.
const STALE_AFTER_MS = 15 * 60 * 1000

function getIfFresh(siteId: number): DevPreviewProgress | null {
  const p = progress.get(siteId)
  if (!p) return null
  if (Date.now() - p.lastUpdatedAt > STALE_AFTER_MS) {
    progress.delete(siteId)
    return null
  }
  return p
}

export function markDevPreviewStarted(siteId: number) {
  const now = Date.now()
  progress.set(siteId, { startedAt: now, lastUpdatedAt: now, done: 0, total: 0 })
  // 새로 시작하는 실행은 이전 실행의 중지 요청을 물려받으면 안 된다 — 안 지우면 "중지" 이후 재시도한
  // 새 실행이 첫 확인 지점에서 곧바로 멈춰버린다.
  stopRequested.delete(siteId)
}

export function requestDevPreviewStop(siteId: number) {
  stopRequested.add(siteId)
}

export function isDevPreviewStopRequested(siteId: number): boolean {
  return stopRequested.has(siteId)
}

// 카테고리를 여러 개 선택했을 때(runPreview) 한 번 훑을 때마다 호출 — 일반모드의 previewCatalog가
// getPreviewProgress로 "카테고리 N/M 확인 중"을 보여주는 것과 같은 목적. 아직 markDevPreviewStarted가
// 안 불렸으면(이론상 없어야 하지만) 조용히 무시한다.
export function markDevPreviewProgress(siteId: number, done: number, total: number) {
  const p = progress.get(siteId)
  if (!p) return
  p.done = done
  p.total = total
  p.lastUpdatedAt = Date.now()
}

export function clearDevPreviewStarted(siteId: number) {
  progress.delete(siteId)
  stopRequested.delete(siteId)
}

// 실행이 끝나는 순간(preview-capture) 걸린 시간을 last_adjustment_preview에 같이 저장해두기 위한 함수
// (사용자 요청, 2026-09-06 — "안 보고 있었어도 완료가 됐다면, 완료까지 걸린 시간도 표시해줘야지": 진행
// 중 표시는 화면을 보고 있어야만 보이는데, clearDevPreviewStarted가 시작시각(startedAt)까지 같이
// 지워버려서 나중에 결과 화면에서 "몇 분 걸렸는지"를 알 방법이 없었다). 지우기 직전에 startedAt을 읽어
// 소요시간을 계산해 반환한다 — 실행 중이 아니었으면(이론상 없어야 함) null.
export function clearDevPreviewStartedAndGetElapsed(siteId: number): number | null {
  const p = progress.get(siteId)
  const elapsedSec = p ? Math.round((Date.now() - p.startedAt) / 1000) : null
  progress.delete(siteId)
  stopRequested.delete(siteId)
  return elapsedSec
}

export function isDevPreviewStarted(siteId: number): boolean {
  return getIfFresh(siteId) !== null
}

/** lib/devKeepAwake.ts가 "지금 개발자모드 미리보기가 하나라도 도는 중인지" 절전방지 여부를 판단할 때
 *  쓴다 — siteId 하나가 아니라 전체를 훑어야 해서 isDevPreviewStarted와 별도로 둔다. getIfFresh를
 *  그대로 재사용해 고아 상태(STALE_AFTER_MS)까지 똑같이 반영되므로, 탭이 강제로 닫혀 죽은 미리보기
 *  때문에 절전방지가 계속 켜진 채로 남는 일이 없다. */
export function isAnyDevPreviewActive(): boolean {
  for (const siteId of progress.keys()) {
    if (getIfFresh(siteId) !== null) return true
  }
  return false
}

export function getDevPreviewProgress(siteId: number): { done: number; total: number } | null {
  const p = getIfFresh(siteId)
  return p ? { done: p.done, total: p.total } : null
}
