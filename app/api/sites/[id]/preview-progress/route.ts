import { NextRequest, NextResponse } from 'next/server'
import { markDevPreviewStarted, markDevPreviewProgress, isDevPreviewStarted, getDevPreviewProgress, isDevPreviewStopRequested } from '@/lib/devPreviewStatus'
import { ensureDevKeepAwakeWatcherStarted } from '@/lib/devKeepAwake'

// 개발자모드 확장(extension-poc/background.js의 runPreview)이 chrome-extension:// 출처에서 이 라우트를
// POST하므로, 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와 Private Network Access 헤더가 필요하다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

/** 확장이 attachDebugger에 성공해 실제로 캡처를 시작하는 그 순간(본문 없이) 호출한다(runPreview 참고) —
 *  그 전까지는 PTP 화면 입장에서 "사용자가 몰 탭에서 확장을 눌렀는지"조차 알 방법이 없어(캡처는 끝나야만
 *  결과를 한 번에 보내옴) "대기 중"과 "실제로 도는 중"을 구분할 수 없었다(사용자 요청, 2026-09-05 — 뱅뱅
 *  도는 스피너가 대기 중에도 계속 보여 오해를 줌).
 *  카테고리를 여러 개 선택했을 때는 그 뒤로도 카테고리 하나를 훑을 때마다 {done,total}을 실어 다시
 *  호출한다 — 일반모드의 previewCatalog(getPreviewProgress)와 같은 "카테고리 N/M 확인 중" 표시를
 *  개발자모드에도 주기 위함(2026-09-05, 실사용 확인: 46개 카테고리를 미리보기하는 동안 진행 정보가
 *  전혀 없어 "진행 중인 게 맞냐"는 문의로 이어짐). {done,total}이 없으면(최초 호출) 새 캡처 사이클
 *  시작으로 보고 진행값을 0/0으로 리셋한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })
  const body = await req.json().catch(() => ({})) as { done?: number; total?: number }
  if (typeof body.done === 'number' && typeof body.total === 'number') {
    markDevPreviewProgress(siteId, body.done, body.total)
  } else {
    markDevPreviewStarted(siteId)
  }
  // stop — PTP의 "⏹ 중지"가 이 사이클에 대해 눌렸는지 같이 실어 보낸다. 확장이 이미 카테고리마다 이
  // 라우트를 부르고 있으니(runPreview), 별도 왕복 없이 이 응답만으로 "그 순간 멈추라"는 요청을 알 수
  // 있다(2026-09-06, 사용자 요청 — run()의 checkStopRequested와 같은 발상, 개발자모드 미리보기 전용).
  return NextResponse.json({ ok: true, stop: isDevPreviewStopRequested(siteId) }, { headers: corsHeaders() })
}

/** ScraperPanel의 devmode 미리보기 결과 폴링(3초 주기)이 last_adjustment_preview와 함께 이 값도 같이
 *  확인해, "대기 중"(정적 아이콘)과 "실제로 캡처 중"(스피너 + 진행 카운트)을 구분해 보여준다.
 *  stop도 같이 내려준다 — collectCategoryLinks의 페이지 단위 루프(완전탐색/이분탐색)처럼 카테고리
 *  진행 신호(위 POST)와 무관하게 더 자주 확인해야 하는 안쪽 루프가 이 GET을 직접 불러 쓴다. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })
  // ScraperPanel이 개발자모드 몰을 선택해두면 이 GET을 3초마다 부르므로, 여기서 한 번만(멱등)
  // lib/devKeepAwake.ts의 주기 감시를 깨워둔다 — 실제 캡처/스크랩이 시작되기 전에 미리 떠 있어야
  // 그 시작 시점을 놓치지 않는다.
  ensureDevKeepAwakeWatcherStarted()
  return NextResponse.json({ started: isDevPreviewStarted(siteId), stop: isDevPreviewStopRequested(siteId), ...getDevPreviewProgress(siteId) }, { headers: corsHeaders() })
}
