import { NextResponse } from 'next/server'
import { restartWorker } from '@/lib/workerRestart'
import { restartPtpServer } from '@/lib/systemRestart'

/** 워커(worker/index.ts) 프로세스만 재시작하는 수동 버튼 — PTP 서버(Next dev) 자체를 재시작하는
 *  /api/system/restart-server와 달리, 워커가 낡은 코드를 계속 실행 중일 때(app/api/health/
 *  worker-freshness가 감지) 쓴다. 실제 재시작 로직/설계 이유는 lib/workerRestart.ts에 있다
 *  (메모리 임계치 자동 재시작과 공유).
 *
 *  워커와 PTP 서버는 완전히 별개 프로세스라 각자 자기 프로세스 안에 독립된 DB 커넥션 풀(lib/db.ts)을
 *  갖는다 — 워커만 재시작하고 PTP 서버는 그대로 두면, Docker/DB가 한 번 끊겼다 붙는 것처럼 두 풀이
 *  같이 영향받을 수 있는 상황에서 PTP 서버 쪽 풀은 좀비 커넥션을 그대로 들고 있게 된다(2026-09-11
 *  실사용 확인 — 워커만 재시작했더니 워커는 정상화됐는데 PTP 서버 쪽 API는 한참 더 타임아웃을 냈다).
 *  사람이 "이번엔 서버도 재시작해야 하나"를 매번 판단해서 챙기는 대신, 이 버튼도 PTP 서버까지 같이
 *  재시작하도록 강제한다(사용자 지시, 2026-09-11 — "재시작하던지 체크를 무조건 하도록 강제해"). PTP
 *  서버 재시작은 이 요청을 처리 중인 프로세스 자신을 잠시 뒤 죽이므로, 워커 재시작이 이미 확정된 뒤
 *  마지막에만 시도한다. */
export async function POST() {
  try {
    await restartWorker()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
  }
  restartPtpServer('cascade').catch(() => {}) // 이미 재시작 진행 중이면 조용히 무시 — 워커 재시작 자체는 이미 성공했다
  return NextResponse.json({ ok: true })
}
