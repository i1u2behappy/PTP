import { NextResponse } from 'next/server'
import { spawn } from 'child_process'

/** PTP 서버(Next dev) 자체를 강제 재시작한다. taskkill로 죽이는 방식은 .next 캐시를 깨뜨려 이후 정상
 *  라우트가 404 나는 사고가 있었던 방식이라(과거 실제 경험), 반드시 dev:clean(.next 삭제 후 기동)으로
 *  재기동한다. 이 요청을 처리 중인 프로세스 자신(process.pid)을 죽여야 하므로, 죽이기/재기동은 이 요청과
 *  분리된 detached cmd 프로세스에 맡긴다 — 응답을 먼저 보내고, 1초 뒤 taskkill로 포트를 비운 뒤 새로
 *  기동한다.
 *
 *  주의: /T(자식 프로세스까지 정리) 플래그는 쓰지 않는다 — 이 detached cmd 프로세스 자체가 지금 죽이려는
 *  process.pid의 자식으로 생성되므로(Windows는 spawn detached:true로도 부모 PID 기록 자체를 못 숨긴다),
 *  /T를 쓰면 taskkill이 이 재시작 스크립트 자신까지 트리째 죽여버려 재기동이 아예 실행되지 못한다(실제로
 *  겪은 문제 — 서버가 죽은 채 복구되지 않았다). plain `next dev`는 포트를 쥔 프로세스가 하나뿐이라 /T 없이
 *  정확한 PID만 죽여도 충분하다. */
export async function POST() {
  const pid = process.pid
  const cwd = process.cwd()
  const script = `timeout /t 1 /nobreak >nul & taskkill /PID ${pid} /F & timeout /t 1 /nobreak >nul & cd /d "${cwd}" & npm run dev:clean`
  const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true, cwd })
  child.unref()
  return NextResponse.json({ ok: true })
}
