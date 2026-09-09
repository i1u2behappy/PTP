import pool from './db'
import { acquireKeepAwake, releaseKeepAwake } from './keepAwake'
import { isAnyDevPreviewActive } from './devPreviewStatus'
import { getActiveMergeBatch } from './scrape/staging'
import { ensureStartedOnce } from './onceGlobally'

/**
 * lib/keepAwake.ts(절전방지)는 원래 withSiteLock(일반모드, 서버가 직접 Playwright로 여는 모든 작업)만
 * 걸어뒀다 — 사용자 지적(2026-09-06)으로 확인해보니 아래 두 가지는 전혀 안 걸려 있었다:
 *
 * 1) 개발자모드(크롬 확장)의 실제 작업 — 미리보기/실제 스크랩/카테고리 하위구조 확장이 전부 사용자의
 *    진짜 크롬에서 확장이 chrome.debugger로 직접 하는 거라, withSiteLock(서버 쪽 Playwright 자원 락)을
 *    아예 안 거친다.
 * 2) "확정"(스크랩 검토 → mall_products 병합, 이미지 다운로드) — 이것도 이 서버 프로세스에서 직접
 *    돌지만 withSiteLock을 안 거친다. 항목이 많으면 몇 시간씩 걸릴 수 있다(실측: 이미지 서버가 느린
 *    몰은 4707개에 13시간 이상 예상).
 *
 * withSiteLock처럼 "시작하는 그 순간"을 정확히 잡아 acquire/release를 호출하는 대신(그러려면 관련된
 * 모든 API 라우트를 하나하나 찾아 훅을 걸어야 하고, 몰 탭이 강제로 닫히는 등 "정상 종료를 못 타는"
 * 경로가 생기면 release가 영영 안 불려 켜진 채로 남을 위험이 있다 — devPreviewStatus.ts의 고아 상태
 * 사고가 실제로 있었다) 주기적으로 "지금 이 셋 중 뭐라도 진행 중인지"를 다시 계산해서 그 결과가 지난
 * 확인과 달라졌을 때만 acquire/release를 부른다 — 상태를 스스로 다시 계산하므로 고아 상태가 생겨도
 * 다음 확인 때 저절로 풀린다(강한 방향으로 자기치유). lib/keepAwake.ts가 참조 카운트를 두고 있어
 * withSiteLock과 이 워처가 서로 몰라도 안전하게 공존한다.
 *
 * currentlyActive를 globalThis에 담는 이유(2026-09-06 실사용 확인): 이 파일만 고쳐 저장해도 dev
 * 서버가 이 모듈을 다시 평가해 모듈 스코프 변수였다면 그 순간 초기화된다 — false로 리셋돼 실제로는
 * 아직 켜져 있는 keepAwake 프로세스를 "새 인스턴스"가 다시 모른 채 시작하는 등 상태가 꼬인다.
 * siteLocks/devPreviewStatus 등 이 프로젝트의 다른 인메모리 상태와 같은 이유로 globalThis에 둔다.
 * "감시 시작" 자체의 중복 방지(같은 이유의 다른 문제 — setInterval이 여러 개 쌓임)는
 * lib/onceGlobally.ts의 공용 가드를 쓴다(아래 ensureDevKeepAwakeWatcherStarted). */
declare global {
  var __devKeepAwakeCurrentlyActive: boolean | undefined
}

const CHECK_INTERVAL_MS = 15_000

async function hasActiveDevmodeScrapeSession(): Promise<boolean> {
  // 개발자모드(manual_login_required) 몰의 "실제 스크랩" 세션 — extension-progress/extension-ingest가
  // 만들고 끝날 때 상태를 done/stopped로 바꾼다. running으로 남아있는 게 하나라도 있으면 그 세션의 몰
  // 탭에서 지금 실제로 순회가 도는 중이라고 본다(끊긴 채 고아로 남는 경우는 lib/scraper.ts의
  // checkSessionCompletion 등 기존 정리 로직 대상이지 여기서 새로 다룰 문제가 아니다).
  const res = await pool.query(
    `SELECT 1 FROM scrape_sessions s JOIN sites si ON si.id = s.site_id
     WHERE s.status='running' AND si.manual_login_required=true LIMIT 1`,
  )
  return (res.rowCount ?? 0) > 0
}

async function checkAndToggle() {
  const active = isAnyDevPreviewActive()
    || getActiveMergeBatch() !== null
    || await hasActiveDevmodeScrapeSession().catch(() => false)
  if (active === (globalThis.__devKeepAwakeCurrentlyActive ?? false)) return
  globalThis.__devKeepAwakeCurrentlyActive = active
  if (active) acquireKeepAwake()
  else releaseKeepAwake()
}

/** 개발자모드 미리보기(preview-progress)나 "확정"(scrape-staging/merge) 라우트가 처음 호출될 때 한 번
 *  불러두면 된다 — 여러 번 불러도 안전(멱등)하다. instrumentation.ts의 30초 주기 워커 감시와 같은
 *  이유로 별도 프로세스 없이 이 Next.js 서버 프로세스 안에서 계속 돈다(devPreviewStatus/getActiveMergeBatch
 *  상태 자체가 이 프로세스의 globalThis에만 있으므로 워커 쪽에서는 애초에 볼 수도 없다). */
export function ensureDevKeepAwakeWatcherStarted(): void {
  ensureStartedOnce('devKeepAwake', () => {
    setInterval(() => { checkAndToggle().catch(() => {}) }, CHECK_INTERVAL_MS)
  })
}
