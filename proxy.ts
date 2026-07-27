import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE, REQUEST_USERNAME_HEADER, REQUEST_ROLE_HEADER } from '@/lib/auth'

// /login 렌더링에 필요한 정적 자산(로고, 파비콘 라우트)도 로그인 전에 열려있어야 한다.
const PUBLIC_PATHS = ['/login', '/logo.jpg', '/icon.jpg']
// extension-ingest/sites/resolve: 개발자모드(크롬 확장, PC인증 등으로 자동 로그인이 안 되는 몰)용
// 크롬 확장이 chrome-extension:// 출처에서 세션 쿠키 없이 호출한다 — 로컬(127.0.0.1) 전용 단일 사용자
// 도구라는 이 앱의 기존 보안 모델과 동일하게, 외부 노출 없이 로컬에서만 닿는 브릿지 엔드포인트라
// 인증 없이 허용한다.
// health/db, system/restart-docker: DB(Docker)가 죽으면 로그인 자체가 500으로 실패하므로, 로그인 화면
// 단계에서도 DbHealthBanner가 이 두 엔드포인트를 써야 한다 — 세션 쿠키가 있어야만 닿을 수 있으면 정작
// 로그인이 막힌 상황에서 배너/재시작 버튼이 무용지물이 된다.
const PUBLIC_API_PREFIXES = [
  '/api/auth/', '/api/scrape/extension-ingest', '/api/sites/resolve', '/api/scrape/stop-requested', '/api/scrape/failed-urls',
  '/api/health/db', '/api/system/restart-docker', '/api/system/restart-server',
]
// adjust/capture는 몰 id가 경로 중간에 끼어 있어(/api/sites/{id}/adjust/capture) 단순 prefix로 못 걸러
// 정규식으로 따로 둔다 — "스크랩 조정"(개발자모드 2단계)에서 확장이 세션 쿠키 없이 호출한다.
// preview-capture도 같은 이유(개발자모드 "스크래핑 전 단건 미리보기") — 확장이 세션 쿠키 없이 호출.
const PUBLIC_API_PATTERNS = [
  /^\/api\/sites\/\d+\/adjust\/capture$/, /^\/api\/sites\/\d+\/adjust\/target$/, /^\/api\/sites\/\d+\/preview-capture$/,
]

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
    || PUBLIC_API_PATTERNS.some(re => re.test(pathname))
  const user = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)

  if (!isPublic && !user) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    return NextResponse.redirect(new URL('/login', request.url))
  }
  if (pathname === '/login' && user) return NextResponse.redirect(new URL('/', request.url))

  // "공개 경로"는 "로그아웃 상태에서도 닿을 수 있어야 한다"는 뜻이지 "로그인했을 때도 신원을 숨긴다"는
  // 뜻이 아니다 — /api/auth/me처럼 로그인 상태에서 자신의 신원을 되묻는 공개 경로도 있어서, 세션이
  // 유효하면 공개/비공개 구분 없이 항상 헤더를 실어 넘긴다(권한관리 도입, 2026-07-27). 이 헤더는
  // 클라이언트가 직접 못 만든다 — 여기(proxy)를 거쳐야만 요청이 API 라우트에 닿을 수 있어, 사용자가
  // 헤더를 조작해도 매 요청마다 이 검증을 다시 거친다.
  if (!user) return NextResponse.next()
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(REQUEST_USERNAME_HEADER, user.username)
  requestHeaders.set(REQUEST_ROLE_HEADER, user.role)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
