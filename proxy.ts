import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth'

// /login 렌더링에 필요한 정적 자산(로고, 파비콘 라우트)도 로그인 전에 열려있어야 한다.
const PUBLIC_PATHS = ['/login', '/logo.jpg', '/icon.jpg']
const PUBLIC_API_PREFIXES = ['/api/auth/']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
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
