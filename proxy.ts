import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth'

// /login 렌더링에 필요한 정적 자산(로고, 파비콘 라우트)도 로그인 전에 열려있어야 한다.
const PUBLIC_PATHS = ['/login', '/logo.jpg', '/icon.jpg']
// extension-ingest/sites/resolve: 개발자모드(크롬 확장, PC인증 등으로 자동 로그인이 안 되는 몰)용
// 크롬 확장이 chrome-extension:// 출처에서 세션 쿠키 없이 호출한다 — 로컬(127.0.0.1) 전용 단일 사용자
// 도구라는 이 앱의 기존 보안 모델과 동일하게, 외부 노출 없이 로컬에서만 닿는 브릿지 엔드포인트라
// 인증 없이 허용한다.
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/scrape/extension-ingest', '/api/sites/resolve']
// adjust/capture는 몰 id가 경로 중간에 끼어 있어(/api/sites/{id}/adjust/capture) 단순 prefix로 못 걸러
// 정규식으로 따로 둔다 — "스크랩 조정"(개발자모드 2단계)에서 확장이 세션 쿠키 없이 호출한다.
const PUBLIC_API_PATTERNS = [/^\/api\/sites\/\d+\/adjust\/capture$/]

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
    || PUBLIC_API_PATTERNS.some(re => re.test(pathname))
  const username = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)

  if (isPublic) {
    if (pathname === '/login' && username) return NextResponse.redirect(new URL('/', request.url))
    return NextResponse.next()
  }

  if (!username) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
