/**
 * "이 프로세스에서 딱 한 번만 실행돼야 하는 초기화"(setInterval 등록, 백그라운드 감시자 시작 등)를
 * 위한 공용 가드 — globalThis에 담아, 이 모듈이 여러 번 다시 평가돼도(아래) 항상 같은 결과를 본다.
 *
 * 왜 필요한가 (2026-09-07, lib/scheduler.ts 사고로 재확인): Next.js dev 서버는 API 라우트를 각각
 * 온디맨드로 따로 컴파일하는데, 이 과정에서 여러 라우트가 공통으로 import하는 서버 모듈(예: lib/db.ts)이
 * 같은 프로세스 안에서 별도의 모듈 인스턴스로 여러 번 다시 만들어질 수 있다. 그러면 그 모듈의 일반
 * 변수(`let started = false`)도 인스턴스마다 따로 리셋되어, setInterval 같은 부작용이 등록될 때마다
 * 또 하나씩 쌓인다 — 실제로 lib/scheduler.ts의 60초 스케줄러가 이 이유로 여러 개 겹쳐 돌며 DB 커넥션
 * 풀을 소모해 무관한 다른 쿼리("Query read timeout")까지 타임아웃 내던 사고로 이어졌다.
 *
 * 이 프로젝트에서 같은 클래스의 사고가 이미 여러 번 났다(각자 다른 파일에서 그때그때 따로 고침):
 * lib/scraper.ts의 siteLocks/profileAbortControllers/categoryDiscoveryAbortControllers, lib/keepAwake.ts,
 * lib/devPreviewStatus.ts, lib/devKeepAwake.ts, instrumentation.ts. 매번 "이 파일 하나만" 고치는 대신,
 * 앞으로 "프로세스당 한 번만 실행"이 필요한 모든 곳이 이 함수 하나로 통일해서 쓴다 — 새 코드를 짤 때마다
 * `declare global`/`globalThis.__xxx` 보일러플레이트를 직접 다시 만들 필요가 없고, 실수로 빠뜨릴 위험도
 * 없앤다.
 *
 * key는 이 초기화를 부르는 곳마다 고유해야 한다(예: 'scheduler', 'instrumentation-register') — 서로
 * 다른 초기화가 같은 key를 쓰면 뒤에 등록하려는 쪽이 조용히 무시된다.
 */
declare global {
  var __onceGloballyStarted: Set<string> | undefined
}

function registry(): Set<string> {
  return globalThis.__onceGloballyStarted ?? (globalThis.__onceGloballyStarted = new Set())
}

/** key로 식별되는 초기화가 이 프로세스에서 아직 한 번도 안 돌았으면 fn을 실행하고 기록한다 — 이미
 *  돌았으면(같은 key로 다시 불려도) 아무것도 안 한다. fn 자체는 동기 함수만 받는다(setInterval 등록처럼
 *  "한 번 걸어두면 끝"인 부작용용 — 결과를 기다려야 하는 비동기 초기화는 이 함수의 대상이 아니다). */
export function ensureStartedOnce(key: string, fn: () => void): void {
  const started = registry()
  if (started.has(key)) return
  started.add(key)
  fn()
}
