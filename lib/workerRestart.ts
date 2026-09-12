import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { orphanedChromeCleanupScript, closeAllOpenSessionsGracefully } from './scraper'
import { recordRestart, type RestartTrigger } from './restartHistory'

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
// "재시작 중" 잠금을 in-memory 변수 하나로만 두지 않고 파일로 둔다 — 이 함수는 서로 다른 두 프로세스에서
// 부를 수 있다(Next.js 서버가 app/api/system/restart-worker/route.ts를 통해, 워커 자신이
// worker/index.ts의 메모리 임계치 자동 재시작을 통해) — 각자 자기 프로세스 메모리 안의 변수만 봐서는
// 상대방이 지금 재시작 중인지 전혀 모른다. 게다가 실제 kill+재기동은 이 함수가 반환된 뒤에도 별개
// 프로세스(schtasks가 띄운 PowerShell)에서 몇 초간 더 이어지는데, 예전엔 이 in-memory 플래그를 schtasks
// 등록 명령이 끝나자마자 풀어버려서(2026-09-06 사고 — "재시작이 걸린 채 안 풀린다"를 고치다 반대로
// 너무 일찍 풀어버림) 그 몇 초 사이에 두 번째 재시작 요청이 들어오면 아직 안 끝난 첫 번째 kill+재기동과
// 포트를 두고 경쟁해 워커가 완전히 죽은 채 방치되는 사고가 났다(2026-09-08 실사용 확인 — 재시작을 짧은
// 간격으로 여러 번 호출했더니 재현됨). 파일 mtime 기반 TTL로 실제 물리적 재시작 소요 시간(스크립트의
// Start-Sleep 1초×2 + 죽이기/정리/재기동 오버헤드, 넉넉히 잡음)만큼 잠그고, 프로세스가 도중에 죽어도
// (예: 강제종료) TTL이 지나면 저절로 풀려 영구히 막히지 않는다 — in-memory 플래그의 "정상 경로에서
// 못 풀면 영원히 막힘" 문제를 파일 접근 시각 확인만으로 재현하지 않는다.
const LOCK_PATH = path.join(os.tmpdir(), 'ptp-worker-restart.lock')
const LOCK_TTL_MS = 15_000

export function isWorkerRestartInFlight(): boolean {
  try {
    return Date.now() - fs.statSync(LOCK_PATH).mtimeMs < LOCK_TTL_MS
  } catch {
    return false
  }
}

export async function restartWorker(trigger: RestartTrigger = 'manual'): Promise<void> {
  if (isWorkerRestartInFlight()) throw new Error('이미 재시작이 진행 중입니다')
  fs.writeFileSync(LOCK_PATH, String(Date.now()))
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
    // 등록/실행 자체가 실패하면 실제 kill+재기동이 전혀 시작되지 않은 것이므로, TTL을 기다릴 이유 없이
    // 잠금을 바로 풀어 재시도를 막지 않는다(2026-09-06 실사용 확인 — "재시작 버튼을 눌렀는데 안 되는 것
    // 같다"의 원인이 바로 이 경로에서 잠금을 안 풀어준 것이었다).
    fs.rmSync(LOCK_PATH, { force: true })
    throw new Error(`작업 스케줄러 등록/실행 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
  recordRestart('worker', trigger)
  // 성공 경로에선 잠금을 여기서 풀지 않는다 — 실제 kill+재기동은 이 시점 이후 별개 프로세스(schtasks가
  // 실행한 PowerShell)에서 몇 초간 더 이어지므로, 그 물리적 재시작이 실제로 끝날 때까지는 잠긴 채로
  // 둬야 두 번째 요청과 경쟁하지 않는다(위 LOCK_TTL_MS 주석 참고) — TTL이 지나면 isWorkerRestartInFlight가
  // 저절로 false를 돌려주므로 별도 해제 코드가 필요 없다.
}
