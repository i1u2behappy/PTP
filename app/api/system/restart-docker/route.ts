import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileAsync = promisify(execFile)
const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
const TASK_NAME = 'PTPRestartDocker'

/** DB 연결 실패를 화면(DbHealthBanner)에서 감지했을 때, 버튼 한 번으로 Docker를 다시 띄울 수 있게 한다.
 *
 *  1차 시도: Docker Desktop 실행파일만 다시 실행 — 실사용해보니 이 버튼이 필요한 바로 그 상황(Docker
 *  Desktop은 떠 있는데 WSL2 쪽 네트워킹만 불안정해 DB 연결이 안 되는 경우)에서는 아무 효과가 없었다 —
 *  Docker Desktop은 단일 인스턴스 앱이라, 이미 실행 중이면 그냥 기존 창을 포커스할 뿐 백엔드(WSL2 VM)는
 *  전혀 재시작되지 않는다.
 *
 *  2차 시도: 기존 Docker 관련 프로세스를 전부 강제 종료한 뒤 새로 띄우는 방식 — 대화형 PowerShell에서
 *  직접 실행하면 되는데, 이 라우트가 실제로 쓰는 schtasks 경유 실행에서는 `com.docker.backend`/
 *  `Docker Desktop` 프로세스 중 일부가 몇 분이 지나도 안 죽고 스크립트 자체가 멈춰버리는 걸 재현
 *  확인했다(Get-Process로 보면 CPU를 거의 안 쓰며 그냥 걸려있음) — Task Scheduler 컨텍스트에서 GUI
 *  프로세스를 강제 종료하는 게 대화형 세션과 다르게 동작하는 것으로 보인다.
 *
 *  최종: `wsl --shutdown`으로 WSL2 VM 자체를 통째로 내린다 — Docker Desktop이 떠 있으면 자기 WSL 배포판
 *  (docker-desktop/docker-desktop-data)이 사라진 걸 감지해 스스로 백엔드를 재기동한다(실사용 확인: DB
 *  연결이 3~9초씩 걸리거나 완전히 멈추던 상태가 이 명령 한 번으로 정상화됨). Docker Desktop 자체가 아예
 *  꺼져있는 경우를 위해 실행파일 재실행도 안전망으로 같이 둔다(이미 떠 있으면 창 포커스만 하고 끝나는
 *  무해한 동작).
 *
 *  참고: wsl --shutdown은 이 프로젝트의 Postgres뿐 아니라 이 컴퓨터의 다른 모든 WSL 배포판도 같이
 *  내린다 — 이 버튼을 누르는 시점엔 어차피 DB 연결이 끊긴 상태라 다른 WSL 작업도 이미 영향권이라고 보고
 *  감수한 절충이다.
 *
 *  child_process.spawn(powershell, {detached:true})으로 직접 띄우는 방식은 실사용 서버(npm run dev)
 *  에서는 실패했다 — pid는 정상 발급되고 에러 이벤트도 없는데, 프로세스가 스크립트를 실행하기도 전에
 *  조용히 죽는 걸 재현 확인(Get-Process로 직후 조회하면 이미 사라져 있음). 반면 같은 스크립트를 이
 *  서버 프로세스 밖(별도 터미널)에서 그대로 실행하면 정상 동작 — 개발 서버 프로세스가 속한 Job Object의
 *  kill-on-close 특성 때문으로 추정된다(detached:true는 CREATE_NEW_PROCESS_GROUP만 줄 뿐 Job에서
 *  breakaway는 안 시켜줌). 작업 스케줄러(schtasks)에 태스크를 등록해 실행시키면 스케줄러 서비스가
 *  전혀 별개의 프로세스 트리로 띄우므로 이 문제를 원천적으로 피한다. */
export async function POST() {
  if (!fs.existsSync(DOCKER_DESKTOP_EXE)) {
    return NextResponse.json({ error: `Docker Desktop 실행파일을 찾을 수 없습니다 (${DOCKER_DESKTOP_EXE})` }, { status: 500 })
  }
  const scriptPath = path.join(os.tmpdir(), 'ptp-restart-docker.ps1')
  fs.writeFileSync(scriptPath, [
    `wsl --shutdown`,
    `Start-Sleep -Seconds 2`,
    `Start-Process -FilePath '${DOCKER_DESKTOP_EXE}'`,
  ].join('\r\n'))
  const taskCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
  try {
    await execFileAsync('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', taskCmd, '/SC', 'ONCE', '/ST', '23:59', '/F'])
    await execFileAsync('schtasks', ['/Run', '/TN', TASK_NAME])
  } catch (e) {
    return NextResponse.json({ error: `작업 스케줄러 등록/실행 실패: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
