import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { orphanedChromeCleanupScript, closeAllOpenSessionsGracefully } from './scraper'

const execFileAsync = promisify(execFile)
const TASK_NAME = 'PTPRestartWorker'

/** worker 프로세스(worker/index.ts) 자신을 강제 재시작한다 — lib/systemRestart.ts의 restartPtpServer와
 *  같은 이유로 같은 방식을 쓴다: `spawn(detached:true)`로 직접 새 프로세스를 띄우고 자신을 죽이는 방식은
 *  Windows에서 이 프로세스가 속한 Job Object가 "kill on close"면 새로 띈 자식도 같은 Job에 묶여 함께
 *  죽어버리는 사고가 이미 한 번 났다([[windows_spawn_job_object_kill]] 메모, restartPtpServer 주석 참고).
 *  schtasks로 완전히 별개의 프로세스 트리에서 재기동해 이 문제를 원천적으로 피한다.
 *
 *  Playwright(chromium.launchPersistentContext)가 이제 이 워커 프로세스에서 돈다 — 강제종료 시 그
 *  chrome.exe들은 이 프로세스의 자식이 아니라 프로필 폴더별 별개 프로세스라 orphan으로 남으므로,
 *  restartPtpServer와 마찬가지로 orphanedChromeCleanupScript()로 같이 정리한다. */
let restartInFlight = false

export function isWorkerRestartInFlight(): boolean {
  return restartInFlight
}

export async function restartWorker(): Promise<void> {
  if (restartInFlight) throw new Error('이미 재시작이 진행 중입니다')
  restartInFlight = true
  // 아래 스크립트의 Stop-Process -Force(강제종료) 전에 열린 로그인 창들을 정상 종료해 쿠키를 디스크에
  // 반영해둔다 — 안 그러면 재시작마다(특히 메모리 임계치로 자동 재시작될 때마다) 로그인 세션을 잃는다
  // (closeAllOpenSessionsGracefully 주석 참고, 2026-08-31 실사용 확인). 최대 몇 초짜리 안전장치라
  // 재시작 지연은 미미하다.
  await closeAllOpenSessionsGracefully()
  // 주의: 여기서 process.pid를 쓰면 안 된다 — 이 함수를 부르는 건 워커가 아니라 Next.js 서버 프로세스
  // 자신(app/api/system/restart-worker/route.ts)이라, process.pid는 그 서버 자신의 PID다(lib/
  // systemRestart.ts의 restartPtpServer는 진짜로 자기 자신을 죽이는 게 목적이라 process.pid가 맞지만,
  // 여기는 다른 프로세스를 죽여야 하는데 그대로 복사해와 실수로 남아있었다 — 2026-09-06 실사용 확인:
  // "워커 재시작"을 눌렀는데 실제로는 워커가 그대로고 서버 쪽이 죽어있었음). WORKER_PORT를 쥔 프로세스를
  // 스크립트 실행 시점에 직접 찾아 죽인다 — 어느 프로세스가 이 함수를 호출했는지와 무관하게 항상 정확한
  // 대상을 잡는다.
  const workerPort = Number(process.env.WORKER_PORT) || 4801
  const cwd = process.cwd()
  const scriptPath = path.join(os.tmpdir(), 'ptp-restart-worker.ps1')
  fs.writeFileSync(scriptPath, [
    `Start-Sleep -Seconds 1`,
    `$workerPid = (Get-NetTCPConnection -LocalPort ${workerPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    `if ($workerPid) { Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue }`,
    orphanedChromeCleanupScript(),
    `Start-Sleep -Seconds 1`,
    `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run worker >> ".worker.log" 2>&1' -WorkingDirectory '${cwd}' -WindowStyle Hidden`,
  ].join('\r\n'))
  const taskCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
  try {
    await execFileAsync('schtasks', ['/End', '/TN', TASK_NAME]).catch(() => {})
    await execFileAsync('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', taskCmd, '/SC', 'ONCE', '/ST', '23:59', '/F'])
    await execFileAsync('schtasks', ['/Run', '/TN', TASK_NAME])
  } catch (e) {
    restartInFlight = false
    throw new Error(`작업 스케줄러 등록/실행 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
  // 성공 경로에서도 반드시 리셋해야 한다 — 안 그러면 이 함수가 처음 성공한 그 순간부터 이 프로세스가
  // 살아있는 내내(다음 dev 서버 재시작 전까지) restartInFlight가 true로 박혀, 이후 모든 호출이 실제로는
  // 아무것도 안 하면서 "이미 재시작이 진행 중입니다"만 반환한다(2026-09-06 실사용 확인 — "재시작 버튼을
  // 눌렀는데 안 되는 것 같다"의 진짜 원인, catch 쪽 리셋만 있고 성공 경로엔 없었음). 실제 kill+재기동은
  // 이 시점 이후 별개 프로세스(schtasks가 실행한 PowerShell)에서 일어나므로, 여기서 리셋해도 그 자체를
  // 방해하지 않는다 — 이 플래그는 오직 "동시에 여러 번 등록/실행 명령이 겹치는 것"만 막으면 된다.
  restartInFlight = false
}
