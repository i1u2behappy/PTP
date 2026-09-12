import pool from './db'
import { checkWorkerFreshness } from './workerFreshness'
import { isWorkerRestartInFlight } from './workerRestart'
import { isRestartInFlight } from './systemRestart'
import { MEMORY_RESTART_THRESHOLD_MB } from './scheduler'

const DB_CHECK_TIMEOUT_MS = 3_000

export interface SystemHealth {
  db: { ok: boolean; latencyMs: number | null }
  worker: { ok: boolean; pid?: number; bootedAt?: number; stale: boolean; staleFileCount: number; restartInFlight: boolean }
  server: { pid: number; uptimeSec: number; rssMb: number; restartThresholdMb: number; restartInFlight: boolean }
}

/**
 * Docker/DB, 워커, PTP 서버(이 프로세스 자신)의 지금 상태를 한 번에 모은다 — 새 판정 로직은 없다, 전부
 * 이미 있던 조각(health/db가 쓰는 DB 핑, worker-freshness가 쓰는 checkWorkerFreshness, 재시작 버튼들이
 * 쓰는 isWorkerRestartInFlight/isRestartInFlight, lib/scheduler.ts의 메모리 임계치)을 그러모으기만 한다.
 * app/api/system/status/route.ts(시스템 상태 팝업)와 app/api/system/recover/route.ts(전역 "다시 시도"가
 * 재기동 여부를 판단할 때) 둘 다 이 함수를 쓴다.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const dbStart = Date.now()
  const db = await Promise.race([
    pool.query('SELECT 1').then(() => ({ ok: true as const, latencyMs: Date.now() - dbStart })),
    new Promise<{ ok: false; latencyMs: null }>(resolve =>
      setTimeout(() => resolve({ ok: false, latencyMs: null }), DB_CHECK_TIMEOUT_MS),
    ),
  ]).catch(() => ({ ok: false as const, latencyMs: null }))

  const freshness = await checkWorkerFreshness()

  return {
    db,
    worker: {
      ok: freshness.ok,
      pid: freshness.pid,
      bootedAt: freshness.bootedAt,
      stale: freshness.stale,
      staleFileCount: freshness.staleFileCount,
      restartInFlight: isWorkerRestartInFlight(),
    },
    server: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      restartThresholdMb: MEMORY_RESTART_THRESHOLD_MB,
      restartInFlight: isRestartInFlight(),
    },
  }
}

/** "재기동이 필요한 진짜 인프라 문제"인지 — 코드가 낡았을 뿐인 stale은 기능 장애가 아니므로 여기선
 *  안 본다(그건 별도로 worker-freshness 배너가 다룬다). app/api/system/recover/route.ts가 이 결과로
 *  "전체 재기동"과 "특정 작업만 중지" 중 뭘 할지 가른다. */
export function isSystemHealthy(h: SystemHealth): boolean {
  return h.db.ok && h.worker.ok && !h.worker.restartInFlight && !h.server.restartInFlight
}
