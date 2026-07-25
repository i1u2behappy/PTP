import { NextResponse } from 'next/server'
import { spawn } from 'child_process'

/** PTP 서버(Next dev) 자체를 강제 재시작한다. 강제종료 후에는 .next 캐시가 깨질 수 있어(과거 실제 경험)
 *  반드시 dev:clean(.next 삭제 후 기동)으로 재기동한다. 이 요청을 처리 중인 프로세스 자신(process.pid)을
 *  죽여야 하므로, 죽이기/재기동은 이 요청과 분리된 detached PowerShell 프로세스에 맡긴다 — 응답을 먼저
 *  보내고, 1초 뒤 Stop-Process로 포트를 비운 뒤 새로 기동한다.
 *
 *  주의 1: 프로세스 트리째 죽이는 방식(taskkill /T)은 쓰지 않는다 — 이 detached 프로세스 자체가 지금
 *  죽이려는 process.pid의 자식으로 생성되므로(Windows는 spawn detached:true로도 부모 PID 기록 자체를 못
 *  숨긴다), 트리째 죽이면 이 재시작 스크립트 자신까지 같이 죽어버려 재기동이 아예 실행되지 못한다(실제로
 *  겪은 문제 — 서버가 죽은 채 복구되지 않았다). plain `next dev`는 포트를 쥔 프로세스가 하나뿐이라 정확한
 *  PID만 죽여도 충분하다.
 *
 *  주의 2: cmd.exe의 `timeout` 명령은 쓰지 않는다 — 이 앱이 Git Bash 환경에서 기동되어 PATH에 Git의
 *  coreutils(usr/bin)가 Windows System32보다 앞에 와 있으면, Windows용 `timeout /t 1`이 아니라 문법이 다른
 *  GNU `timeout`이 잡혀 즉시 에러로 죽는다(실제로 겪은 문제 — 재시작 자체가 조용히 실패했다).
 *  PowerShell의 Start-Sleep/Stop-Process는 외부 실행파일이 아니라 내장 cmdlet이라 이 PATH 셰도잉에서
 *  자유롭다.
 *
 *  주의 3: 버튼을 짧은 시간에 두 번 누르는 등으로 이 POST가 중복 도착하면, 첫 번째 요청이 예약한
 *  Stop-Process가 아직 실행되기 전(1초 딜레이 중)에 두 번째 요청도 "아직 살아있는" 이 프로세스에서
 *  처리돼 또 하나의 재기동 체인을 예약해버릴 수 있다 — 그러면 새 인스턴스가 두 개 동시에 뜨면서 같은
 *  .next 캐시에 동시에 쓰다 충돌하는 사고("Compaction failed" 등, 실제 다른 경로로 겪은 문제)로 이어질
 *  수 있다. 모듈 스코프 플래그로 중복 요청을 막는다. */
let restartInFlight = false

export async function POST() {
  if (restartInFlight) {
    return NextResponse.json({ error: '이미 재시작이 진행 중입니다' }, { status: 409 })
  }
  restartInFlight = true
  const pid = process.pid
  const cwd = process.cwd()
  const script = `Start-Sleep -Seconds 1; Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Set-Location -LiteralPath '${cwd}'; npm run dev:clean`
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true, cwd })
  child.unref()
  return NextResponse.json({ ok: true })
}
