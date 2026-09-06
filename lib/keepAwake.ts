import { spawn, type ChildProcess } from 'child_process'

/**
 * withSiteLock으로 잠긴 작업(몰 구조분석/카테고리 불러오기/스크랩 시작 등, 전부 이 락을 거쳐감)이 하나라도
 * 진행 중인 동안 Windows가 절전모드로 빠지지 않게 한다 — 사용자 요청(2026-08-30, 도매토피아 검증 도중
 * PC가 절전모드로 들어가 25분짜리 테스트 데이터가 전부 오염되는 사고를 겪음: 절전 구간이 그대로 "매
 * 항목이 20초씩 걸린 것"처럼 기록됐다).
 *
 * Windows API SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)를 호출한 채로 대기하는
 * PowerShell 프로세스를 하나 띄워두고, 그 프로세스가 살아있는 동안만 절전이 억제된다 — 이 플래그는
 * "그걸 호출한 스레드"가 살아있는 동안만 유효하므로, 별도 네이티브 모듈 없이 이 프로세스를 띄워두고
 * 있다가 필요 없어지면 종료시키는 것만으로 충분하다. ES_DISPLAY_REQUIRED는 안 준다 — 화면은 꺼져도
 * 되고 시스템 절전만 막으면 된다(노트북이라면 화면은 꺼진 채 계속 동작).
 *
 * 워커 프로세스(worker/index.ts)는 Next dev 서버처럼 핫리로드되지 않는 일반 장기실행 프로세스라
 * globalThis 없이도 괜찮지만, 이 파일은 일반모드의 워커 프로세스뿐 아니라 lib/devKeepAwake.ts를 통해
 * Next.js 서버 프로세스(app/api/** 라우트)에서도 그대로 쓰인다 — 그쪽은 dev 서버가 파일 저장마다 이
 * 모듈을 다시 평가하므로(siteLocks/devPreviewStatus 등 다른 인메모리 상태와 같은 이유), 모듈 스코프
 * 변수로 두면 그 순간 변수만 초기화되고 이미 띄워둔 PowerShell 프로세스는 참조를 잃어버린 채 고아로
 * 계속 살아있는다(2026-09-06 실사용 확인 — 이 파일과 무관한 lib/devKeepAwake.ts만 고쳤는데도 재현됨).
 * globalThis에 담아 이 문제를 원천적으로 피한다.
 *
 * 참조 카운트를 두는 이유: withSiteLock(일반모드) 말고도 lib/devKeepAwake.ts(개발자모드 미리보기/실제
 * 스크랩, "확정" 병합)가 독립적으로 이 acquire/release를 부른다 — 서로 다른 두 출처가 "지금 내 일은
 * 끝났다"고 각자 releaseKeepAwake()를 부를 수 있으므로, 한쪽이 아직 진행 중인데 다른 쪽이 먼저 끝나
 * releaseKeepAwake()를 부르면 그 즉시 절전방지가 꺼져버리면 안 된다 — 정말로 아무도 안 쥐고 있을
 * 때만(refCount가 0으로 떨어질 때만) 실제로 끈다. */
declare global {
  var __keepAwakeProcess: ChildProcess | null | undefined
  var __keepAwakeRefCount: number | undefined
}
function getRefCount(): number { return globalThis.__keepAwakeRefCount ?? 0 }
function setRefCount(n: number): void { globalThis.__keepAwakeRefCount = n }

export function acquireKeepAwake(): void {
  setRefCount(getRefCount() + 1)
  if (globalThis.__keepAwakeProcess) return
  // 부호 최상위 비트가 켜진 16진 리터럴(0x80000000)을 PowerShell이 [uint32]로 직접 캐스팅하면
  // "Value was either too large or too small for a UInt32" 에러를 내며 조용히 실패한다(2026-08-30
  // 직접 테스트로 확인 — $ES_CONTINUOUS가 $null이 돼 ES_CONTINUOUS 없이 ES_SYSTEM_REQUIRED만 호출되고,
  // 그러면 "한 번만 절전 타이머를 리셋"하는 일회성 요청으로 취급돼 계속 떠 있어도 절전을 못 막는다) —
  // 16진 문자열을 Convert.ToUInt32로 변환하면 이 문제 없이 정확한 값을 얻는다.
  const script = `
$ES_CONTINUOUS = [System.Convert]::ToUInt32('80000000', 16)
$ES_SYSTEM_REQUIRED = [System.Convert]::ToUInt32('00000001', 16)
Add-Type -Namespace Win32 -Name PowerMgmt -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.PowerMgmt]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)) | Out-Null
while ($true) { Start-Sleep -Seconds 30 }
`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore', windowsHide: true,
  })
  globalThis.__keepAwakeProcess = child
  child.on('exit', () => { if (globalThis.__keepAwakeProcess === child) globalThis.__keepAwakeProcess = null })
  child.on('error', () => { if (globalThis.__keepAwakeProcess === child) globalThis.__keepAwakeProcess = null })
  console.log('[keepAwake] 진행 중인 작업이 있어 절전모드 방지 시작')
}

export function releaseKeepAwake(): void {
  setRefCount(Math.max(0, getRefCount() - 1))
  if (getRefCount() > 0) return
  if (!globalThis.__keepAwakeProcess) return
  globalThis.__keepAwakeProcess.kill()
  globalThis.__keepAwakeProcess = null
  console.log('[keepAwake] 남은 작업 없음 — 절전모드 방지 해제')
}
