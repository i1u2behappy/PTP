import { NextRequest, NextResponse } from 'next/server'
import { getSystemHealth, isSystemHealthy } from '@/lib/systemHealth'
import { restartDockerAndCascade } from '@/lib/dockerRestart'
import { getSiteLockStatus, stopProfileAnalysis, stopCategoryDiscovery } from '@/lib/workerClient'

// 이 정도 이상 한 몰의 락을 계속 쥐고 있으면 "그냥 정상적으로 오래 걸리는 작업"으로 본다 — 이보다 짧으면
// 방금 시작한 정상적인 작업일 수 있어 건드리지 않는다(2026-09-12, 도매토피아 몰 구조분석 339개 카테고리
// 재발견 사례 — DB_WAIT_TIMEOUT_MS와 같은 자릿수로 넉넉히 잡았다).
const STUCK_LOCK_THRESHOLD_MS = 90_000

/** GlobalErrorNet(전역 "요청 실패" 토스트)의 "다시 시도"가 실패한 요청의 URL에서 siteId를 뽑아본다 —
 *  이 앱의 몰 관련 라우트는 거의 항상 /api/sites/<id>/... 아니면 ?siteId=<n> 둘 중 하나를 쓴다. 못 뽑으면
 *  (몰과 무관한 라우트) null — 그 경우 아래에서 "그냥 재시도"로만 처리된다. */
function extractSiteId(url: string | null): number | null {
  if (!url) return null
  const pathMatch = url.match(/\/api\/sites\/(\d+)\b/)
  if (pathMatch) return Number(pathMatch[1])
  const queryMatch = url.match(/[?&]siteId=(\d+)/)
  return queryMatch ? Number(queryMatch[1]) : null
}

/**
 * 전역 "요청 실패" 토스트(GlobalErrorNet)의 "다시 시도"가 부르는 복구 판단 엔드포인트 — 예전엔 이 버튼이
 * 무조건 Docker/워커/PTP 서버를 전부 재기동시켰는데(2026-09-11 도입, "사용자가 원인을 몰라도 되게"가
 * 목적이었다), 실제로는 "인프라가 죽은 것"과 "특정 작업 하나가 그냥 오래 걸리는 것"을 구분 못 해서,
 * 후자인 상황(도매토피아 몰 구조분석이 339개 카테고리를 재발견하느라 정상적으로 41분 걸리던 중)에도
 * 매번 무거운 재기동이 걸려 오히려 그 작업을 계속 끊어버렸다(2026-09-12 실사용 확인).
 *
 * 이제는 원인부터 가린다:
 * 1. DB/워커/PTP서버 중 하나라도 실제로 이상하면(다운/재시작 진행 중 등) → 이게 바로 "사용자가 원인을
 *    몰라도 되게" 의도했던 그 상황이므로, 기존처럼 Docker/워커/서버를 전부 재기동한다.
 * 2. 셋 다 멀쩡한데 계속 실패하면 → 인프라 문제가 아니라 특정 몰의 작업 하나가 막혔거나 오래 걸리는
 *    것뿐이다. 실패한 요청의 siteId를 뽑아 그 몰의 락이 일정 시간 이상 잡혀있으면, 그 작업만 중지시킨다
 *    (몰 구조분석/카테고리 불러오기 — 둘 다 이미 있는 "중지" 버튼과 같은 함수). Docker/워커/서버는 안
 *    건드려 다른 몰의 진행 중인 작업까지 같이 죽이지 않는다.
 * 3. 어느 쪽에도 안 걸리면(락도 안 잡혀있음) → 그 라우트 자체의 문제일 수 있으니 아무 조치 없이 그냥
 *    재시도만 한다(호출부가 이미 그렇게 함).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { url?: string }

  const health = await getSystemHealth()
  if (!isSystemHealthy(health)) {
    const result = await restartDockerAndCascade()
    return NextResponse.json({ action: 'restart-infra', ...result })
  }

  const siteId = extractSiteId(body.url ?? null)
  if (siteId) {
    const lock = await getSiteLockStatus(siteId).catch(() => null)
    if (lock && lock.sinceMs >= STUCK_LOCK_THRESHOLD_MS) {
      const [stoppedProfile, stoppedDiscovery] = await Promise.all([
        stopProfileAnalysis(siteId).catch(() => false),
        stopCategoryDiscovery(siteId).catch(() => false),
      ])
      if (stoppedProfile || stoppedDiscovery) {
        return NextResponse.json({ action: 'stopped-task', siteId, label: lock.label })
      }
    }
  }

  return NextResponse.json({ action: 'none' })
}
