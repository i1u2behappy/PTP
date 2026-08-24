import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { CDPSession, Page } from 'playwright'
import { verifyScreenTicket } from '../lib/screenTicket'
import { getOpenSessionPage, onMainPageChange } from '../lib/scraper'

// "원격으로 보기" — 로그인 창(headless:false로 뜨는 실제 크롬 창)의 화면을 CDP(Chrome DevTools Protocol)
// 스크린캐스트로 실시간 스트리밍하고, 원격 뷰어의 마우스/키보드를 그대로 그 탭에 주입한다. RPC 서버
// (worker/rpc-server.ts)와 완전히 별도 포트에 둔다 — RPC 제어채널은 계속 127.0.0.1 전용으로 남겨두고,
// 나중에 인터넷 노출을 고민할 땐 이 화면중계 포트 하나만 신경 쓰면 되게 분리해둔다.
//
// 인증: 이 포트는 Next.js의 로그인 쿠키 검증(proxy.ts)을 거치지 않고 브라우저가 직접 접속하므로,
// 접속 직전에 Next.js 라우트(app/api/sites/[id]/screen-ticket)가 발급한 서명 티켓(lib/screenTicket.ts)을
// 쿼리스트링으로 받아 검증한다 — 쿠키를 그대로 여기까지 들고 오게 하면 워커가 나중에 다른 호스트/터널
// 뒤로 옮겨질 때 깨지거나 위험해질 수 있어서다.
//
// 직접로그인 필수 몰(manual_login_required)은 대상 밖이다 — 그 창은 CDP 연결 없는 사용자의 진짜
// 개인 크롬 프로세스라(자동화 탐지 회피 목적) 붙일 CDPSession 자체가 없다. 이 경우
// getOpenSessionPage(siteId)가 null을 돌려주므로 아래에서 자연히 접속이 거부된다 — 별도 분기 불필요.

interface ViewerClaims { username: string; role: string }

interface SiteViewSession {
  page: Page
  cdp: CDPSession
  viewers: Map<WebSocket, ViewerClaims>
  controller: WebSocket | null
  unsubscribeMainPageChange: () => void
}

const viewSessions = new Map<number, SiteViewSession>()

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(session: SiteViewSession, msg: unknown, exclude?: WebSocket) {
  const payload = JSON.stringify(msg)
  for (const ws of session.viewers.keys()) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

async function teardownSession(siteId: number, reason: string) {
  const session = viewSessions.get(siteId)
  if (!session) return
  viewSessions.delete(siteId)
  session.unsubscribeMainPageChange()
  broadcast(session, { type: 'sessionClosed', reason })
  for (const ws of session.viewers.keys()) ws.close()
  await session.cdp.send('Page.stopScreencast').catch(() => {})
  await session.cdp.detach().catch(() => {})
  console.log(`[화면중계:${siteId}] 세션 정리됨 (${reason})`)
}

/** 뷰어가 처음 붙을 때 그 siteId의 CDPSession/스크린캐스트를 새로 만든다 — 보는 사람이 있을 때만
 *  돌리고(불필요한 인코딩 비용 방지), 마지막 뷰어가 나가면 바로 멈춘다. */
async function getOrCreateSession(siteId: number): Promise<SiteViewSession | null> {
  const existing = viewSessions.get(siteId)
  if (existing) return existing

  const page = getOpenSessionPage(siteId)
  if (!page) return null

  const cdp = await page.context().newCDPSession(page)
  const session: SiteViewSession = {
    page, cdp, viewers: new Map(), controller: null,
    unsubscribeMainPageChange: () => {},
  }
  viewSessions.set(siteId, session)

  cdp.on('Page.screencastFrame', frame => {
    // CDP 스크린캐스트는 페이지 내용만 캡처한다 — 브라우저 자체의 주소창/탭 UI는 캡처 대상이 아니라
    // 원천적으로 안 보인다(사용자 질문, 2026-08-24). 대신 지금 보고 있는 URL을 프레임마다 같이 실어
    // 보내 화면 쪽에서 "가짜 주소창"으로 보여준다.
    broadcast(session, { type: 'frame', data: frame.data, metadata: frame.metadata, url: page.url() })
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 })

  // "메인 탭"이 바뀌거나(같은 로그인 창을 다른 흐름이 재사용) 창 자체가 닫히면, 지금 뷰어들이 보고
  // 있는 CDPSession은 죽은 페이지를 가리키게 된다 — 뷰어들에게 알리고 세션을 정리한다. 다시 보려면
  // 뷰어가 재접속하면 되므로(그 시점에 getOpenSessionPage가 최신 탭을 돌려줌) 여기서 자동 재연결까지
  // 시도하지 않는다 — 그 탭이 진짜 로그인 창의 메인 탭이 맞는지는 사용자가 화면에서 확인하는 게 맞다.
  session.unsubscribeMainPageChange = onMainPageChange(siteId, () => {
    teardownSession(siteId, 'main-page-changed').catch(() => {})
  })
  page.once('close', () => { teardownSession(siteId, 'page-closed').catch(() => {}) })

  return session
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
function toModifierBits(m?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }): number {
  if (!m) return 0
  return (m.alt ? MODIFIER_BITS.alt : 0) | (m.ctrl ? MODIFIER_BITS.ctrl : 0)
    | (m.meta ? MODIFIER_BITS.meta : 0) | (m.shift ? MODIFIER_BITS.shift : 0)
}

type ViewerMessage =
  | { type: 'requestControl' } | { type: 'releaseControl' }
  | { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number; button?: 'left' | 'middle' | 'right'; modifiers?: Parameters<typeof toModifierBits>[0] }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: Parameters<typeof toModifierBits>[0] }
  | { type: 'keyDown' | 'keyUp'; key: string; code: string; windowsVirtualKeyCode?: number; text?: string; modifiers?: Parameters<typeof toModifierBits>[0] }
  | { type: 'insertText'; text: string }

async function handleViewerMessage(siteId: number, ws: WebSocket, claims: ViewerClaims, msg: ViewerMessage) {
  const session = viewSessions.get(siteId)
  if (!session) return

  if (msg.type === 'requestControl') {
    if (!session.controller || session.controller === ws) {
      session.controller = ws
      send(ws, { type: 'controlGranted' })
      broadcast(session, { type: 'controlHolder', username: claims.username }, ws)
    } else {
      send(ws, { type: 'controlDenied', holder: session.viewers.get(session.controller)?.username })
    }
    return
  }
  if (msg.type === 'releaseControl') {
    if (session.controller === ws) {
      session.controller = null
      broadcast(session, { type: 'controlReleased' })
    }
    return
  }

  // 입력은 지금 컨트롤을 쥔 뷰어만 반영한다 — 컨트롤을 잃은 직후 도착한 지연 이벤트는 조용히 버린다
  // (드문 정상 상황이라 에러 응답 불필요).
  if (session.controller !== ws) return

  const cdp = session.cdp
  switch (msg.type) {
    case 'mouseMove': case 'mouseDown': case 'mouseUp': {
      const type = msg.type === 'mouseMove' ? 'mouseMoved' : msg.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased'
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: msg.x, y: msg.y, button: msg.button ?? 'left', clickCount: 1,
        modifiers: toModifierBits(msg.modifiers),
      }).catch(() => {})
      break
    }
    case 'wheel':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.deltaX, deltaY: msg.deltaY,
        modifiers: toModifierBits(msg.modifiers),
      }).catch(() => {})
      break
    case 'keyDown': case 'keyUp':
      await cdp.send('Input.dispatchKeyEvent', {
        type: msg.type === 'keyDown' ? 'keyDown' : 'keyUp', key: msg.key, code: msg.code,
        windowsVirtualKeyCode: msg.windowsVirtualKeyCode, text: msg.text,
        modifiers: toModifierBits(msg.modifiers),
      }).catch(() => {})
      break
    case 'insertText':
      // 한글 등 조합입력(IME)이나 붙여넣기는 raw key 이벤트로 흉내내면 조합이 깨진다 — CDP의
      // Input.insertText가 이런 "키 입력이 아니라 완성된 텍스트 삽입"을 위한 전용 경로다.
      await cdp.send('Input.insertText', { text: msg.text }).catch(() => {})
      break
  }
}

export function startScreenRelayServer(port: number, host: string) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({
    server, path: '/screen',
    verifyClient: (info, cb) => {
      const url = new URL(info.req.url || '', 'http://x')
      const siteId = Number(url.searchParams.get('siteId'))
      const claims = verifyScreenTicket(url.searchParams.get('ticket'), siteId)
      if (!Number.isFinite(siteId) || !siteId || !claims) { cb(false, 401, 'unauthorized'); return }
      ;(info.req as unknown as { _claims: ViewerClaims; _siteId: number })._claims = claims
      ;(info.req as unknown as { _claims: ViewerClaims; _siteId: number })._siteId = siteId
      cb(true)
    },
  })

  wss.on('connection', (ws, req) => {
    const claims = (req as unknown as { _claims: ViewerClaims })._claims
    const siteId = (req as unknown as { _siteId: number })._siteId

    // message/close 리스너는 반드시 여기서(어떤 await보다도 먼저) 동기적으로 붙인다 — 붙이기 전에
    // 도착한 이벤트는 리스너 등록 이후에도 재생되지 않고 그냥 사라진다(EventEmitter는 과거 이벤트를
    // 버퍼링하지 않음). getOrCreateSession/captureScreenshot의 await들이 끝나길 기다렸다가 등록하면,
    // 그 사이(대개 수백ms) 뷰어가 보낸 메시지(예: requestControl)를 놓친다 — 실사용 테스트로 재현
    // 확인(2026-08-24, 접속 즉시 컨트롤을 요청하면 응답이 전혀 안 왔음). handleViewerMessage 자신이
    // "세션이 아직 없으면 조용히 무시"를 이미 하므로, 세션 준비 전에 도착한 메시지는 안전하게 버려지고
    // (드문 경우 — 사람이 화면을 보기도 전에 조작을 시도하는 셈), 이후 메시지부터는 정상 처리된다.
    ws.on('message', raw => {
      let msg: ViewerMessage
      try { msg = JSON.parse(raw.toString()) as ViewerMessage } catch { return }
      handleViewerMessage(siteId, ws, claims, msg).catch(() => {})
    })
    ws.on('close', () => {
      const session = viewSessions.get(siteId)
      if (!session) return
      session.viewers.delete(ws)
      if (session.controller === ws) {
        session.controller = null
        broadcast(session, { type: 'controlReleased' })
      }
      if (session.viewers.size === 0) teardownSession(siteId, 'no-viewers').catch(() => {})
    })

    void (async () => {
      const session = await getOrCreateSession(siteId)
      if (!session) { ws.close(4004, '로그인 창이 열려있지 않습니다'); return }

      session.viewers.set(ws, claims)
      // 새 뷰어가 다음 스크린캐스트 프레임까지(몇백ms) 빈 화면을 보지 않도록, 붙는 즉시 스냅샷 한 장을
      // 먼저 보내준다 — 이후로는 스크린캐스트 브로드캐스트가 이어받는다.
      const viewport = session.page.viewportSize()
      const shot = await session.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }).catch(() => null)
      if (shot) {
        send(ws, {
          type: 'frame', data: shot.data,
          metadata: { deviceWidth: viewport?.width || 1280, deviceHeight: viewport?.height || 800, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
          url: session.page.url(),
        })
      }
    })().catch(() => { ws.close(1011, 'internal error') })
  })

  server.on('error', e => {
    console.error(`[worker] 화면중계 서버를 포트 ${port}에서 시작하지 못했습니다:`, e)
  })
  server.listen(port, host, () => {
    console.log(`[worker] 화면중계 서버 시작 — ws://${host}:${port}/screen`)
  })
  return server
}
