import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth'

const PUBLIC_PATHS = ['/login']
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
