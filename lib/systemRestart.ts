import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { orphanedChromeCleanupScript } from './scraper'
import { recordRestart, type RestartTrigger } from './restartHistory'

const execFileAsync = promisify(execFile)
const TASK_NAME = 'PTPRestartServer'

/** PTP 서버(Next dev) 자체를 강제 재시작한다. 강제종료 후에는 .next 캐시가 깨질 수 있어(과거 실제 경험)
 *  반드시 dev:clean(.next 삭제 후 기동)으로 재기동한다. 이 요청을 처리 중인 프로세스 자신(process.pid)을
 *  죽여야 하므로, 죽이기/재기동은 이 요청과 분리된 프로세스에 맡긴다.
 *
 *  `app/api/system/restart-server/route.ts`(수동 버튼)와 `lib/scheduler.ts`(메모리 임계치 초과 시
 *  자동 재시작)가 공유한다 — 둘 다 같은 방식으로 재시작해야 하므로 여기 한 곳에 모아둔다.
 *
 *  **2026-08-09 재발견: `child_process.spawn(powershell, {detached:true})`로 직접 띄우는 방식은
 *  이 서버(npm run dev) 안에서 호출하면 조용히 실패한다** — 이전엔 "이 방식은 restart-server에서는
 *  검증됐다(6초 만에 정상 복구)"고 기록돼 있었는데, 오늘 다시 확인해보니 API는 `{ok:true}`를 돌려줘도
 *  실제로는 재시작이 전혀 안 일어났다(재시작 전후로 PID/시작시각이 완전히 동일). `restart-docker`가
 *  이미 겪은 것과 똑같은 Windows Job Object kill-on-close 문제로 추정된다([[windows_spawn_job_object_kill]]
 *  메모 참고. `detached:true`는 `CREATE_NEW_PROCESS_GROUP`만 줄 뿐 Job에서 breakaway는 안 됨) — 예전엔
 *  어떤 시점엔 우연히 됐을 수 있으나 지금은 재현되는 실패다. **해결**: `restart-docker`와 똑같이
 *  PowerShell 스크립트를 임시 `.ps1` 파일로 써두고, `schtasks /Create ... /SC ONCE /F` +
 *  `schtasks /Run /TN <name>`으로 작업 스케줄러에 등록해 실행한다 — 스케줄러 서비스가 완전히 별개의
 *  프로세스 트리에서 띄우므로 이 문제를 원천적으로 피한다. 이 방식이면 이 스크립트 자신이 더 이상
 *  `process.pid`의 자식이 아니라서, 예전에 "트리째 죽이면 재시작 스크립트 자신까지 같이 죽는다"며
 *  피했던 `taskkill /T`도 이제 안전하지만, 굳이 바꿀 필요가 없어 그대로 `Stop-Process`만 쓴다(plain
 *  `next dev`는 포트를 쥔 프로세스가 하나뿐). 실제 재시작 확인: 3.65GB → 715MB, 핸들 1656 → 350.
 *
 *  **추가로 발견한 문제(같은 날 재현): 예약 작업의 마지막 명령을 `npm run dev:clean`으로 그대로 두면,
 *  그 명령 자체가 새 서버로서 영원히 실행되는 명령이라 작업 스케줄러 입장에서 이 작업이 "실행 중"
 *  상태에서 절대 끝나지 않는다.** 그 상태에서 같은 이름(`TASK_NAME`)으로 다시 트리거하면(재시작 버튼을
 *  또 누르거나, 자동 재시작이 겹치는 등) Windows가 "이미 실행 중인 작업"으로 보고 새 실행을 조용히
 *  무시해버린다(실제로 두 번째 재시작 시도가 이렇게 아무 반응 없이 묵혔다). **해결**: 스크립트의 마지막
 *  단계를 `npm run dev:clean`을 직접 부르는 대신 `Start-Process`로 완전히 분리된 프로세스로 띄우기만
 *  하고 끝낸다 — 그러면 이 스크립트(=예약 작업)는 몇 초 안에 "완료" 상태가 되고, 새로 뜬 dev 서버는
 *  그 작업과 무관하게 독립적으로 계속 산다. 매번 트리거 전에 `schtasks /End`로 혹시 남아있는 이전
 *  인스턴스도 먼저 정리한다(실패해도 무시 — 원래 없었거나 이미 끝났으면 에러가 나는 게 정상).
 *
 *  주의: cmd.exe의 `timeout` 명령은 쓰지 않는다 — 이 앱이 Git Bash 환경에서 기동되어 PATH에 Git의
 *  coreutils(usr/bin)가 Windows System32보다 앞에 와 있으면, Windows용 `timeout /t 1`이 아니라 문법이 다른
 *  GNU `timeout`이 잡혀 즉시 에러로 죽는다(실제로 겪은 문제) — PowerShell의 Start-Sleep/Stop-Process는
 *  외부 실행파일이 아니라 내장 cmdlet이라 이 PATH 셰도잉에서 자유롭다.
 *
 *  주의: 짧은 시간에 두 번 트리거되면(버튼 중복 클릭, 자동 재시작과 겹침 등) 첫 번째 요청이 예약한
 *  작업이 아직 실행되기 전에 두 번째도 "아직 살아있는" 이 프로세스에서 처리돼 재기동 체인을 하나 더
 *  예약해버릴 수 있다 — 그러면 새 인스턴스가 두 개 동시에 뜨면서 같은 .next 캐시에 동시에 쓰다 충돌하는
 *  사고("Compaction failed" 등, 실제 다른 경로로 겪은 문제)로 이어질 수 있다. 모듈 스코프 플래그로 막는다. */
let restartInFlight = false

export function isRestartInFlight(): boolean {
  return restartInFlight
}

export async function restartPtpServer(trigger: RestartTrigger = 'manual'): Promise<void> {
  if (restartInFlight) throw new Error('이미 재시작이 진행 중입니다')
  restartInFlight = true
  const pid = process.pid
  const cwd = process.cwd()
  const scriptPath = path.join(os.tmpdir(), 'ptp-restart-server.ps1')
  // Stop-Process는 이 dev 서버 프로세스만 죽인다 — Playwright가 띄운 chrome.exe들은 그 자식이 아니라
  // 프로필 폴더별로 launchPersistentContext된 별개 프로세스라 그대로 orphan으로 남아 메모리를 계속
  // 붙들고 있었다(재시작해도 메모리가 안 줄어드는 원인 중 하나) — orphanedChromeCleanupScript()로 같이 정리한다.
  // 재시작된 새 서버의 출력을 어디로도 안 보내면(예전엔 그랬다), 그 뒤 이 프로세스가 왜 멈추거나
  // 죽었는지 볼 로그가 전혀 없다(2026-08-09 실사용 확인 — 자동재시작 후 멀쩡히 떠 있던 서버가 나중에
  // 조용히 죽었는데, 원인을 볼 로그가 하나도 없었다). cmd.exe 자체의 리다이렉션으로 .dev-server.log에
  // 이어서(>>) 계속 쌓아 재시작 전후 기록이 끊기지 않게 한다.
  fs.writeFileSync(scriptPath, [
    `Start-Sleep -Seconds 1`,
    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    orphanedChromeCleanupScript(),
    `Start-Sleep -Seconds 1`,
    `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:clean >> ".dev-server.log" 2>&1' -WorkingDirectory '${cwd}' -WindowStyle Hidden`,
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
  recordRestart('server', trigger)
}
