import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { orphanedChromeCleanupScript } from './scraper'

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
  const pid = process.pid
  const cwd = process.cwd()
  const scriptPath = path.join(os.tmpdir(), 'ptp-restart-worker.ps1')
  fs.writeFileSync(scriptPath, [
    `Start-Sleep -Seconds 1`,
    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
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
}
