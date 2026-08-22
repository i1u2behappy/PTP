'use client'
import { useEffect, useState } from 'react'

interface FailedRequest {
  id: number
  url: string
  message: string
  retryArgs: Parameters<typeof fetch>
  /** 지금까지 자동 재시도한 횟수 — MAX_AUTO_RETRIES에 닿으면 더 이상 자동으로는 안 하고 수동 "다시
   *  시도"만 남긴다(끝없이 실패하는 요청을 무한정 재시도하며 서버를 계속 두드리지 않기 위함). */
  attempt: number
}

const MAX_AUTO_RETRIES = 5
const BASE_RETRY_DELAY_MS = 4_000
// 실패해도 곧바로 토스트를 띄우지 않고, 이 유예시간 동안은 조용히 빠른 재시도(FAST_RETRY_DELAY_MS)로만
// 회복을 시도한다 — dev 서버 핫리로드처럼 순간적으로 끊겼다 스스로 풀리는 것까지 전부 "요청 실패"로
// 노출돼 실제로는 아무 조치도 필요 없는 알림이 간간이 뜬다는 지적(2026-08-22)에 따른 것. 처음엔 2초로
// 뒀는데도 다른 작업 중에 여전히 간간이 노출된다는 재지적으로 5초로 늘림. 유예시간이 지나도 여전히
// 실패 중이면 그때 처음 화면에 드러낸다 — 진짜 문제(서버/DB 다운 등)는 이 정도로는 안 풀리므로 그대로
// 노출된다.
const REVEAL_GRACE_MS = 5_000
const FAST_RETRY_DELAY_MS = 1_000

let nextId = 1
// 이미 떠 있는 실패 안내와 같은 url을 또 실패하면 새로 쌓지 않고(대신 시도 횟수만 올리고) — 여러 컴포넌트
// 인스턴스와 무관하게 항상 하나만 패치되도록 모듈 스코프에 둔다.
let patched = false
const listeners = new Set<(failures: FailedRequest[]) => void>()
let failures: FailedRequest[] = [] // 실제로 화면에 드러난(유예시간을 넘긴) 것만 담는다.
// 유예시간 동안 화면엔 아직 안 보이지만 내부적으로는 추적·재시도 중인 실패.
const pending = new Map<string, FailedRequest>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const revealTimers = new Map<string, ReturnType<typeof setTimeout>>()

function notify() {
  for (const fn of listeners) fn(failures)
}

function clearRetryTimer(url: string) {
  const timer = retryTimers.get(url)
  if (timer) { clearTimeout(timer); retryTimers.delete(url) }
}

function clearRevealTimer(url: string) {
  const timer = revealTimers.get(url)
  if (timer) { clearTimeout(timer); revealTimers.delete(url) }
}

/** delayMs 뒤 이 요청을 다시 보내본다 — 사용자가 "다시 시도"를 직접 눌러야만 해소되는 게 불편하다는
 *  피드백으로 추가. 화면에 드러난(failures) 뒤에는 시도할 때마다 간격을 2배로 늘려(4s, 8s, 16s, 32s,
 *  64s) 서버가 계속 안 좋은 상태일 때 괜히 더 두드리지 않게 하고, MAX_AUTO_RETRIES를 넘기면 자동
 *  재시도는 멈추고 수동 버튼만 남긴다. 아직 유예시간 중(pending)이면 매번 FAST_RETRY_DELAY_MS로 빠르게
 *  재시도한다. */
function scheduleRetry(entry: FailedRequest, delayMs: number) {
  clearRetryTimer(entry.url)
  if (entry.attempt >= MAX_AUTO_RETRIES) return
  const timer = setTimeout(() => {
    // 그 사이 성공했거나(clearFailure) 사용자가 닫았으면(dismiss) 이 실패는 이미 어디에도 없다 — 아무것도 안 함.
    if (!pending.has(entry.url) && !failures.some(f => f.id === entry.id)) return
    fetch(...entry.retryArgs).catch(() => {})
  }, delayMs)
  retryTimers.set(entry.url, timer)
}

function revealEntry(url: string) {
  clearRevealTimer(url)
  const entry = pending.get(url)
  if (!entry) return
  pending.delete(url)
  failures = [...failures, entry]
  notify()
}

function addFailure(url: string, message: string, retryArgs: Parameters<typeof fetch>) {
  const visible = failures.find(f => f.url === url)
  if (visible) {
    // 이미 화면에 드러난 뒤에 또 실패한 경우 — 새 토스트를 또 쌓지 않고 기존 것의 시도 횟수만 올려 이어간다.
    visible.message = message
    visible.attempt += 1
    failures = [...failures]
    notify()
    scheduleRetry(visible, BASE_RETRY_DELAY_MS * 2 ** visible.attempt)
    return
  }
  const inGrace = pending.get(url)
  if (inGrace) {
    // 아직 유예시간 중인데 빠른 재시도도 또 실패 — 계속 조용히(화면엔 안 띄우고) 빠르게 재시도만 이어간다.
    inGrace.message = message
    inGrace.attempt += 1
    scheduleRetry(inGrace, FAST_RETRY_DELAY_MS)
    return
  }
  const entry: FailedRequest = { id: nextId++, url, message, retryArgs, attempt: 0 }
  pending.set(url, entry)
  scheduleRetry(entry, FAST_RETRY_DELAY_MS)
  revealTimers.set(url, setTimeout(() => revealEntry(url), REVEAL_GRACE_MS))
}

function clearFailure(url: string) {
  clearRetryTimer(url)
  clearRevealTimer(url)
  pending.delete(url)
  if (!failures.some(f => f.url === url)) return
  failures = failures.filter(f => f.url !== url)
  notify()
}

function dismiss(id: number) {
  const entry = failures.find(f => f.id === id)
  if (entry) clearRetryTimer(entry.url)
  failures = failures.filter(f => f.id !== id)
  notify()
}

// DbHealthBanner가 이미 전담하는 엔드포인트는 제외한다 — 서버/DB가 죽으면 이 요청들도 같이 실패해
// 화면 위(DbHealthBanner)와 아래(이 토스트)에 같은 내용이 중복으로 뜨게 된다.
const EXCLUDED_PREFIXES = ['/api/health/db', '/api/system/restart-docker', '/api/system/restart-server']

function patchFetch() {
  if (patched || typeof window === 'undefined') return
  patched = true
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const [input] = args
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const excluded = EXCLUDED_PREFIXES.some(p => url.includes(p))
    try {
      const res = await originalFetch(...args)
      if (!excluded) {
        if (res.status >= 500) addFailure(url, `서버 오류 (${res.status})`, args)
        else clearFailure(url)
      }
      return res
    } catch (err) {
      // 화면이 AbortController로 스스로 취소한 요청(예: 미리보기 "중지" 버튼)까지 "서버 오류"로 띄우고
      // 자동 재시도까지 걸면 안 된다 — 사용자가 멈추라고 한 요청이 몇 초 뒤 저절로 다시 나가버린다.
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      if (!excluded && !isAbort) addFailure(url, '서버에 연결할 수 없습니다 — 네트워크 또는 서버 자체가 응답하지 않습니다', args)
      throw err
    }
  }
}

/**
 * 공통 에러 안전망 — 화면 어디서든 요청이 서버에 아예 닿지 못하거나(네트워크 오류/타임아웃) 5xx로
 * 실패하면, 그 화면이 별도로 처리하고 있는지와 무관하게 최소한 "무슨 요청이 실패했는지"는 항상 눈에
 * 보이게 한다. 4xx(로그인 실패, 입력값 검증 등)는 각 화면이 이미 의도적으로 처리하는 정상 실패
 * 경로라 제외한다.
 *
 * 실패해도 곧바로 화면에 띄우지 않는다 — 5초 유예시간 동안은 1초 간격으로 조용히 재시도만 하고,
 * 그 안에 회복되면 사용자는 아무것도 못 보고 지나간다(2026-08-22, dev 서버 핫리로드 같은 순간적
 * 끊김까지 매번 "요청 실패"로 노출돼 실제로는 조치가 필요 없는 알림이 간간이 뜬다는 지적 — 처음엔
 * 2초로 뒀는데 여전히 간간이 보인다는 재지적으로 5초로 늘림).
 * 유예시간이 지나도 여전히 실패 중이면 그때 처음 드러내고, 이후로는 4초부터 간격을 2배씩 늘려가며
 * (최대 5회) 자동으로 다시 시도한다 — 그 사이 성공하면 사용자가 아무것도 안 눌러도 알림이 저절로
 * 사라진다("다시 시도를 직접 눌러야만 없어진다"는 피드백으로 추가한 동작, 수동 버튼도 그대로 남겨
 * 바로 재시도하고 싶을 때 쓸 수 있게 한다). 진짜 서버/DB 다운처럼 실제 조치가 필요한 문제는 유예시간
 * 정도로는 회복되지 않으므로 그대로 노출된다.
 *
 * 이 앱은 수십 개 화면이 각자 fetch를 직접 호출하고(공용 API 클라이언트 레이어가 없음), 매번 화면마다
 * 에러 UI를 추가하는 대신 window.fetch 자체를 한 번 감싸는 것이 지금 전체를 즉시 덮는 방법이다 — 다만
 * 재시도는 실패했던 그 요청을 다시 보낼 뿐, 그 요청을 걸었던 원래 화면의 상태(예: 로딩 스피너)를
 * 되살리진 못한다(호출부의 그 시점 Promise 체인은 이미 끝났으므로) — 화면별로 정확한 복구가 필요하면
 * (예: 로그인확인 재확인 흐름처럼) 그 화면에 맞는 로직을 별도로 넣어야 한다.
 */
export function GlobalErrorNet() {
  const [visible, setVisible] = useState<FailedRequest[]>(failures)

  useEffect(() => {
    patchFetch()
    listeners.add(setVisible)
    return () => { listeners.delete(setVisible) }
  }, [])

  if (!visible.length) return null
  const shown = visible.slice(-3)
  const hiddenCount = visible.length - shown.length

  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 max-w-sm">
      {hiddenCount > 0 && (
        <p className="text-xs text-white bg-gray-700 rounded-full px-3 py-1 self-end shadow">그 외 {hiddenCount}건 더 실패</p>
      )}
      {shown.map(f => (
        <div key={f.id} className="bg-rose-600 text-white text-sm rounded-xl shadow-lg px-4 py-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold">⚠ 요청 실패</p>
            <p className="text-rose-100 text-xs mt-0.5">{f.message}</p>
            <p className="text-rose-200 text-[11px] mt-0.5 truncate" title={f.url}>{f.url}</p>
            <p className="text-rose-200 text-[11px] mt-0.5">
              {f.attempt < MAX_AUTO_RETRIES ? `자동으로 다시 시도 중 (${f.attempt}/${MAX_AUTO_RETRIES})` : '자동 재시도 종료 — 수동으로 다시 시도해주세요'}
            </p>
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            <button onClick={() => { dismiss(f.id); fetch(...f.retryArgs).catch(() => {}) }}
              className="px-2 py-1 bg-white text-rose-600 rounded-full text-xs font-semibold hover:bg-rose-50 transition-colors">
              다시 시도
            </button>
            <button onClick={() => dismiss(f.id)} className="px-2 py-1 text-rose-200 hover:text-white text-xs transition-colors">닫기</button>
          </div>
        </div>
      ))}
    </div>
  )
}
