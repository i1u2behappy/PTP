'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

// "원격으로 보기" — 워커가 CDP로 스트리밍하는 로그인 창 화면을 그려주고, 마우스/키보드를 그대로
// 그 탭에 전달한다(worker/screenRelay.ts와 짝). 로컬 창(headless:false 실제 크롬 창)은 그대로 유지되고,
// 이 컴포넌트는 그 화면을 "보여주는 또 다른 창구"일 뿐이다 — ScraperPanel의 로그인 흐름(handleOpenLogin
// 등)은 전혀 안 건드린다.

interface FrameMetadata {
  deviceWidth: number
  deviceHeight: number
}

const viewerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('frame'), data: z.string(), metadata: z.object({ deviceWidth: z.number(), deviceHeight: z.number() }), url: z.string() }),
  z.object({ type: z.literal('controlGranted') }),
  z.object({ type: z.literal('controlDenied'), holder: z.string().optional() }),
  z.object({ type: z.literal('controlHolder'), username: z.string() }),
  z.object({ type: z.literal('controlReleased') }),
  z.object({ type: z.literal('sessionClosed'), reason: z.string() }),
  z.object({ type: z.literal('reset') }),
])

type Modifiers = { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }

// 별도 키 이벤트로 다뤄야 하는 키들 — 나머지(일반 문자)는 숨겨진 입력창의 input 이벤트(조합입력 포함)로
// 처리한다. windowsVirtualKeyCode는 CDP Input.dispatchKeyEvent가 참고하는 값이라, 이 표에 없는 문자는
// insertText 경로로 보내는 게 더 안전하다(문자별 VK 코드를 다 채워 넣지 않아도 됨).
const SPECIAL_KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: 'Enter', vk: 13 }, Tab: { code: 'Tab', vk: 9 }, Backspace: { code: 'Backspace', vk: 8 },
  Escape: { code: 'Escape', vk: 27 }, Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
}

// 화면 너비를 사용자가 드래그로 조절할 수 있게(사용자 요청, 2026-08-24) — 개인 취향이라 세션이
// 바뀌어도 유지되도록 localStorage에 마지막 값을 남긴다.
const WIDTH_KEY = 'scrape.scraper.remoteScreenWidth'
const MIN_WIDTH = 320
const MAX_WIDTH = 1280
function readSavedWidth(): number {
  if (typeof window === 'undefined') return 640
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 640
}

export default function RemoteScreenViewer({ siteId }: { siteId: number }) {
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting')
  const [closedReason, setClosedReason] = useState<string | null>(null)
  const [hasControl, setHasControl] = useState(false)
  const [controlHolder, setControlHolder] = useState<string | null>(null)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  // 지연 초기화(useState(readSavedWidth))로 첫 렌더부터 저장된 값을 바로 쓴다 — 640으로 먼저 그렸다가
  // 이펙트에서 다시 setWidth하면 렌더가 한 번 더 겹쳐 돌고 React 린트도 이 패턴을 경고한다
  // (react-hooks/set-state-in-effect — 외부 시스템 동기화가 아니라 그냥 초기값 계산이라 이펙트가 아니라
  // useState 자체의 지연 초기화로 하는 게 맞는 경우).
  const [width, setWidth] = useState(readSavedWidth)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const hiddenInputRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const metadataRef = useRef<FrameMetadata>({ deviceWidth: 1280, deviceHeight: 800 })
  const composingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null

    async function connect() {
      setStatus('connecting')
      setClosedReason(null)
      try {
        const res = await fetch(`/api/sites/${siteId}/screen-ticket`, { method: 'POST' })
        if (!res.ok) { setStatus('closed'); setClosedReason('티켓 발급 실패'); return }
        const { ticket, wsUrl } = await res.json() as { ticket: string; wsUrl: string }
        if (cancelled) return
        ws = new WebSocket(`${wsUrl}/screen?siteId=${siteId}&ticket=${encodeURIComponent(ticket)}`)
        wsRef.current = ws
        ws.onopen = () => { if (!cancelled) setStatus('live') }
        ws.onclose = ev => {
          if (cancelled) return
          setStatus('closed')
          setClosedReason(ev.reason || '연결이 끊겼습니다')
        }
        ws.onerror = () => { if (!cancelled) { setStatus('closed'); setClosedReason('연결 오류') } }
        ws.onmessage = ev => {
          if (typeof ev.data !== 'string') return
          let parsed: unknown
          try { parsed = JSON.parse(ev.data) } catch { return }
          const result = viewerMessageSchema.safeParse(parsed)
          if (!result.success) return
          const msg = result.data
          if (msg.type === 'frame') {
            metadataRef.current = msg.metadata
            if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${msg.data}`
            setPageUrl(msg.url)
          } else if (msg.type === 'controlGranted') {
            setHasControl(true); setControlHolder(null)
          } else if (msg.type === 'controlDenied') {
            setHasControl(false); setControlHolder(msg.holder || null)
          } else if (msg.type === 'controlHolder') {
            setHasControl(false); setControlHolder(msg.username)
          } else if (msg.type === 'controlReleased') {
            setHasControl(false); setControlHolder(null)
          } else if (msg.type === 'sessionClosed') {
            setStatus('closed'); setClosedReason(msg.reason)
          } else if (msg.type === 'reset') {
            if (imgRef.current) imgRef.current.removeAttribute('src')
          }
        }
      } catch {
        if (!cancelled) { setStatus('closed'); setClosedReason('연결 실패') }
      }
    }
    connect()
    return () => { cancelled = true; ws?.close(); wsRef.current = null }
  }, [siteId])

  // CSS resize(브라우저 기본 드래그 손잡이)로 바뀐 실제 폭을 감지해 다음에도 그 크기로 열리게
  // localStorage에 남긴다 — React state가 크기를 직접 밀어붙이는 게 아니라, 드래그로 바뀐 결과를
  // 뒤따라가며 저장만 한다(그래야 드래그 자체는 브라우저 네이티브 동작 그대로 매끄럽다).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect.width || 0)
      if (w > 0) { setWidth(w); localStorage.setItem(WIDTH_KEY, String(w)) }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function send(msg: unknown) {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function toImageCoords(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const el = imgRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    const { deviceWidth, deviceHeight } = metadataRef.current
    return {
      x: ((e.clientX - rect.left) / rect.width) * deviceWidth,
      y: ((e.clientY - rect.top) / rect.height) * deviceHeight,
    }
  }

  function modifiersOf(e: React.MouseEvent | React.KeyboardEvent | React.WheelEvent): Modifiers {
    return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }
  }

  function requireControl() {
    if (!hasControl) send({ type: 'requestControl' })
  }

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 border-b border-gray-200 text-xs">
        <span className="text-gray-500">
          {status === 'connecting' && '연결 중...'}
          {status === 'live' && (hasControl ? '🖱 조작 중' : controlHolder ? `👀 읽기 전용 — ${controlHolder}님이 조작 중` : '👀 읽기 전용')}
          {status === 'closed' && `연결 종료됨${closedReason ? ` — ${closedReason}` : ''}`}
        </span>
        {status === 'live' && !hasControl && (
          <button type="button" onClick={() => send({ type: 'requestControl' })}
            className="text-teal-600 hover:underline font-medium">
            조작 권한 가져오기
          </button>
        )}
        {status === 'live' && hasControl && (
          <button type="button" onClick={() => send({ type: 'releaseControl' })}
            className="text-gray-400 hover:underline">
            조작 권한 놓기
          </button>
        )}
      </div>
      {/* CDP 스크린캐스트는 페이지 내용만 캡처해 브라우저 자체의 주소창은 원천적으로 안 보인다
          (사용자 질문, 2026-08-24) — 대신 지금 보고 있는 URL을 워커가 프레임마다 같이 보내줘서
          "가짜 주소창"으로 대신 보여준다. */}
      <div className="px-3 py-1 bg-white border-b border-gray-100 text-[11px] text-gray-500 truncate mx-auto"
        style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}>
        🔒 {pageUrl || '주소 확인 중...'}
      </div>
      <div
        ref={wrapperRef}
        tabIndex={0}
        // 실제 캡처 해상도(1280x720 등)를 그대로 꽉 채워 보여주면 화면이 너무 커진다(사용자 지적,
        // 2026-08-24) — 기본 폭을 적당히 줄이고, 우측 하단 손잡이로 드래그해 원하는 크기로 조절할 수
        // 있게 한다(resize-x, 위 ResizeObserver가 바뀐 폭을 저장). 클릭 좌표는 표시 크기 기준으로
        // metadata.deviceWidth/Height에 맞춰 환산하므로(toImageCoords) 크기를 바꿔도 정확도는 그대로다.
        className="relative mx-auto resize-x overflow-auto focus-within:outline focus-within:outline-2 focus-within:outline-teal-500"
        onFocus={() => hiddenInputRef.current?.focus()}
        style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
        onMouseDown={() => hiddenInputRef.current?.focus()}
        onMouseMove={e => { if (hasControl) send({ type: 'mouseMove', ...toImageCoords(e), modifiers: modifiersOf(e) }) }}
        onMouseUp={e => {
          if (!hasControl) { requireControl(); return }
          send({ type: 'mouseUp', ...toImageCoords(e), button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', modifiers: modifiersOf(e) })
        }}
        onMouseDownCapture={e => {
          if (!hasControl) { requireControl(); return }
          send({ type: 'mouseDown', ...toImageCoords(e), button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', modifiers: modifiersOf(e) })
        }}
        onContextMenu={e => e.preventDefault()}
        onWheel={e => { if (hasControl) send({ type: 'wheel', ...toImageCoords(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) }) }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URI로 계속 갱신되는 실시간 프레임이라 next/image 최적화 대상이 아님 */}
        <img ref={imgRef} alt="원격 화면" className="w-full h-auto block select-none" draggable={false} />
        {status !== 'live' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-gray-500">
            {status === 'connecting' ? '연결 중...' : `연결이 끊겼습니다${closedReason ? ` (${closedReason})` : ''}`}
          </div>
        )}
        {/* 화면 밖에 두는 실제 <input> — 한글 등 조합입력(IME)까지 정확히 받으려고 브라우저의 진짜
            텍스트 입력 처리에 맡긴다(직접 keydown만으로 한글 조합을 흉내내면 깨진다). Enter/Backspace 등
            특수키는 이 입력창의 keydown에서 가로채 CDP 키 이벤트로 보내고, 나머지 문자는 input 이벤트
            (조합 완료 시점 포함)로 받아 insertText로 보낸다. */}
        <input ref={hiddenInputRef} type="text" value=""
          className="absolute w-px h-px opacity-0 -left-full"
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={e => {
            composingRef.current = false
            if (hasControl && e.currentTarget.value) send({ type: 'insertText', text: e.currentTarget.value })
            e.currentTarget.value = ''
          }}
          onChange={e => {
            if (composingRef.current) return
            if (hasControl && e.currentTarget.value) send({ type: 'insertText', text: e.currentTarget.value })
            e.currentTarget.value = ''
          }}
          onKeyDown={e => {
            const special = SPECIAL_KEYS[e.key]
            if (!special && !e.ctrlKey && !e.altKey && !e.metaKey) return // 일반 문자는 input 이벤트가 처리
            e.preventDefault()
            if (!hasControl) { requireControl(); return }
            send({ type: 'keyDown', key: e.key, code: special?.code || e.code, windowsVirtualKeyCode: special?.vk, modifiers: modifiersOf(e) })
          }}
          onKeyUp={e => {
            const special = SPECIAL_KEYS[e.key]
            if (!special && !e.ctrlKey && !e.altKey && !e.metaKey) return
            if (!hasControl) return
            send({ type: 'keyUp', key: e.key, code: special?.code || e.code, windowsVirtualKeyCode: special?.vk, modifiers: modifiersOf(e) })
          }} />
      </div>
    </div>
  )
}
