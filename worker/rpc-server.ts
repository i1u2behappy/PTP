import http from 'http'

// PTP 서버(Next.js 개발서버)와 완전히 분리된 프로세스에서 Playwright/로컬 Ollama 작업을 전부 처리하는
// 워커 — 2026-08-23, 사용자 요청("로고 화면이 계속 나오는" 원인이었던 Fast Refresh 강제 새로고침을
// 근본적으로 없애기 위해 스크래핑/AI 작업을 별도 프로세스로 분리). Next.js 라우트가 이 서버에 HTTP로
// 요청을 보내고(lib/workerClient.ts), 이 서버는 lib/scraper.ts 등 기존 코드를 그대로(단 한 줄도 안 고치고)
// 이 프로세스 안에서 실행한다 — Next.js 프로세스가 더는 이 무거운 작업을 직접 하지 않으므로, 그 프로세스가
// webpack 재컴파일 중이어도 스크래핑은 전혀 영향받지 않고, 반대로 스크래핑이 CPU를 많이 써도 Next.js의
// 빌드 매니페스트 읽기/쓰기가 더는 그 경합에 노출되지 않는다.

export type RpcFn = (...args: unknown[]) => unknown

/** 이름→함수 화이트리스트 — worker/registry.ts가 채운다. 클라이언트가 임의의 이름을 보내 아무 코드나
 *  실행시키지 못하도록, 여기 등록된 이름만 호출 가능하다(외부에 노출되는 포트가 아니라 로컬호스트
 *  전용이지만, 그래도 방어적으로 화이트리스트 방식을 쓴다). */
const registry = new Map<string, RpcFn>()

export function registerRpc(name: string, fn: RpcFn) {
  if (registry.has(name)) throw new Error(`RPC 이름 중복: ${name}`)
  registry.set(name, fn)
}

/** previewCatalog/countDedupedProductUrls처럼 opts.stopSignal(또는 signal 인자)로 취소 신호를 받는
 *  함수를 등록할 때 쓴다 — 원래 함수는 그대로 두고, 이 요청 전용 AbortSignal을 만들어 지정한 인자
 *  위치에 주입하는 래퍼로 감싼다. 이 요청의 HTTP 연결이 끊기면(클라이언트가 fetch를 abort — "중지"
 *  버튼) 그 신호를 그대로 이 AbortSignal에 전달한다(REQUEST_SIGNAL 심볼로 dispatch가 채워준다). */
export const REQUEST_SIGNAL = Symbol('request-signal')

interface RpcRequestBody {
  id: string
  fn: string
  args: unknown[]
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** JSON은 Error 인스턴스를 그대로 못 실어 보내므로(message가 사라짐) 메시지 문자열만 뽑아 보낸다 —
 *  워커 쪽 원본 스택은 워커 자신의 콘솔에 그대로 남으니 디버깅엔 지장 없다. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function startRpcServer(port: number) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end()
      return
    }
    let body: RpcRequestBody
    try {
      body = JSON.parse(await readBody(req)) as RpcRequestBody
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
      return
    }
    const fn = registry.get(body.fn)
    if (!fn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, id: body.id, error: `등록되지 않은 함수: ${body.fn}` }))
      return
    }
    // 클라이언트(Next.js 라우트)가 원래 요청의 req.signal을 그대로 fetch에 넘기면, 여기서 그 연결이
    // 끊기는 걸 감지해(close 이벤트) 이 AbortSignal을 abort한다 — previewCatalog 등 opts.stopSignal을
    // 쓰는 함수를 감싸는 래퍼가 이 신호를 받아 쓴다(registry.ts 참고).
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    try {
      const args = [...body.args, { [REQUEST_SIGNAL]: controller.signal }]
      const result = await fn(...args)
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: body.id, result: result === undefined ? null : result }))
      }
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, id: body.id, error: errorMessage(e) }))
      }
    }
  })
  // http.Server의 'error' 이벤트(예: EADDRINUSE — 다른 워커가 이미 이 포트를 쥐고 있는 경우, 두
  // Next.js 프로세스가 거의 동시에 뜨며 둘 다 워커가 없다고 보고 각자 띄우려 할 때 실제로 벌어질 수
  // 있다)를 리스너 없이 두면 Node가 이 EventEmitter의 처리되지 않은 에러로 보고 프로세스를 그냥
  // 죽여버린다 — 원인을 알 수 없는 크래시 대신 명확한 로그를 남기고 종료한다.
  server.on('error', e => {
    console.error(`[worker] RPC 서버를 포트 ${port}에서 시작하지 못했습니다:`, e)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[worker] RPC 서버 시작 — http://127.0.0.1:${port}`)
  })
  return server
}
