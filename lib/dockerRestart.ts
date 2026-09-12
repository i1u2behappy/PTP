import { execFile } from 'child_process'
import { promisify } from 'util'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { restartWorker } from './workerRestart'
import { restartPtpServer } from './systemRestart'
import { recordRestart } from './restartHistory'

const execFileAsync = promisify(execFile)
// Docker Desktop 설치 위치가 머신마다 다르다 — 예전엔 Program Files 경로 하나만 하드코딩해뒀는데, 이
// 개발 PC는 사용자별 설치(AppData\Local\Programs)라 그 경로엔 실행파일이 없어 이 버튼 자체가 항상
// "찾을 수 없음" 에러만 내고 있었다(2026-09-11 실사용 확인 — Test-Path로 직접 대조). 설치 방식(전체 PC용/
// 현재 사용자용)에 따라 둘 중 하나만 존재하므로 둘 다 후보로 두고 실제 있는 쪽을 쓴다.
const DOCKER_DESKTOP_EXE_CANDIDATES = [
  'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
]
const TASK_NAME = 'PTPRestartDocker'
const DB_PORT = Number(process.env.DB_PORT) || 5433
const DB_WAIT_TIMEOUT_MS = 90_000

function findDockerDesktopExe(): string | null {
  return DOCKER_DESKTOP_EXE_CANDIDATES.find(p => fs.existsSync(p)) ?? null
}

function isDbReachable(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: DB_PORT })
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(2_000, () => done(false))
  })
}

/**
 * Docker/WSL이 다시 뜬 뒤, 이 프로세스(PTP 서버)와 워커 프로세스가 각자 들고 있던 DB 커넥션 풀(lib/db.ts,
 * 프로세스마다 독립적)에 남아있을 수 있는 "좀비 커넥션"(Docker 컨테이너가 내려갔다 올라오는 사이 끊긴
 * 소켓을 pg Pool이 아직 살아있다고 착각하는 것 — lib/db.ts의 query_timeout 주석 참고)을 확실히 없앤다.
 * 예전엔 이 버튼이 Docker/WSL만 살려놓고 끝나서, 워커와 PTP 서버는 각자 알아서 재시작해야 했다 — 워커는
 * 자체 재연결 로직(worker/index.ts)이 있어 결국 스스로 복구되지만, PTP 서버 쪽 풀은 그런 자동 재연결이
 * 없어 좀비 커넥션을 잡을 때마다 query_timeout(8초)까지 멈췄다 500을 내는 게 반복됐다(2026-09-11 실사용
 * 확인 — Docker Desktop이 꺼졌다 켜진 뒤 워커만 재시작하고 PTP 서버는 안 건드렸더니 `/api/scrape-staging`
 * 등이 한참 더 "Query read timeout"을 냈다).
 *
 * DB가 끝내 안 열려도(진짜 장애 등) 최대 대기 후 그냥 진행한다 — 워커/서버 모두 자기 쪽 DB 연결은 각자
 * 재시도 로직을 갖고 있어 무해하고, 최소한 "재시작 자체는 됐다"는 보장을 준다.
 */
async function cascadeRestartAfterDockerUp(): Promise<void> {
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDbReachable()) break
    await new Promise(r => setTimeout(r, 3_000))
  }
  // 워커 먼저 — restartPtpServer는 이 요청을 처리 중인 프로세스 자신을 잠시 뒤 죽이므로 항상 마지막에 둔다.
  await restartWorker('cascade').catch(() => {})
  await restartPtpServer('cascade').catch(() => {})
}

/** DB 연결 실패를 화면(DbHealthBanner)에서 감지했을 때, 버튼 한 번으로 Docker를 다시 띄울 수 있게 한다
 *  (app/api/system/restart-docker/route.ts가 이 함수를 그대로 부른다 — app/api/system/recover/route.ts도
 *  "진짜 인프라 문제"로 판정됐을 때 같은 처방을 재사용한다).
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
 *  감수한 절충이다. 이런 파급 때문에 app/api/system/recover/route.ts는 실제로 인프라(DB/워커/서버)가
 *  이상할 때만 이 함수를 부르고, 그냥 특정 작업 하나가 오래 걸리는 것뿐일 때는 부르지 않는다(2026-09-12,
 *  사용자 지적 — 도매토피아 몰 구조분석이 정상적으로 오래 걸리고 있었을 뿐인데 "다시 시도"를 누를
 *  때마다 이 무거운 처방이 반복 발동돼 오히려 그 작업을 계속 끊어버렸다).
 *
 *  child_process.spawn(powershell, {detached:true})으로 직접 띄우는 방식은 실사용 서버(npm run dev)
 *  에서는 실패했다 — pid는 정상 발급되고 에러 이벤트도 없는데, 프로세스가 스크립트를 실행하기도 전에
 *  조용히 죽는 걸 재현 확인(Get-Process로 직후 조회하면 이미 사라져 있음). 반면 같은 스크립트를 이
 *  서버 프로세스 밖(별도 터미널)에서 그대로 실행하면 정상 동작 — 개발 서버 프로세스가 속한 Job Object의
 *  kill-on-close 특성 때문으로 추정된다(detached:true는 CREATE_NEW_PROCESS_GROUP만 줄 뿐 Job에서
 *  breakaway는 안 시켜줌). 작업 스케줄러(schtasks)에 태스크를 등록해 실행시키면 스케줄러 서비스가
 *  전혀 별개의 프로세스 트리로 띄우므로 이 문제를 원천적으로 피한다. */
export async function restartDockerAndCascade(): Promise<{ ok: true } | { error: string }> {
  const dockerExe = findDockerDesktopExe()
  if (!dockerExe) {
    return { error: `Docker Desktop 실행파일을 찾을 수 없습니다 (확인한 경로: ${DOCKER_DESKTOP_EXE_CANDIDATES.join(', ')})` }
  }
  const scriptPath = path.join(os.tmpdir(), 'ptp-restart-docker.ps1')
  fs.writeFileSync(scriptPath, [
    `wsl --shutdown`,
    `Start-Sleep -Seconds 2`,
    `Start-Process -FilePath '${dockerExe}'`,
  ].join('\r\n'))
  const taskCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
  try {
    await execFileAsync('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', taskCmd, '/SC', 'ONCE', '/ST', '23:59', '/F'])
    await execFileAsync('schtasks', ['/Run', '/TN', TASK_NAME])
  } catch (e) {
    return { error: `작업 스케줄러 등록/실행 실패: ${e instanceof Error ? e.message : String(e)}` }
  }
  recordRestart('docker', 'manual')
  cascadeRestartAfterDockerUp() // 응답을 기다리게 하지 않는다 — DB가 다시 열릴 때까지(최대 90초) 이
  // 프로세스 안에서 계속 대기하다 워커·PTP 서버를 순서대로 재시작한다(위 cascadeRestartAfterDockerUp 참고).
  return { ok: true }
}
