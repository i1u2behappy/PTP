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
  '/api/auth/', '/api/scrape/extension-ingest', '/api/sites/resolve', '/api/scrape/stop-requested',
  '/api/health/db', '/api/health/worker-boot', '/api/system/restart-docker', '/api/system/restart-server',
  // extension-progress: 개발자모드 스크랩 진행률("카테고리 N/M") 보고 — 위와 같은 이유로 세션 쿠키 없이
  // 확장이 부른다. 여기 빠뜨렸다가 조용히 401로 매번 실패해, "진행 상황이 안 보인다"는 지적으로 뒤늦게
  // 발견됐다(2026-08-22) — 위 profile 라우트 때와 똑같은 실수라 다시 반복하지 않도록 주석을 남긴다.
  '/api/scrape/extension-progress',
  // detect-last-page: 확장의 페이지네이션 규칙 기반 지름길 3개가 다 실패했을 때 로컬 AI에게 마지막
  // 페이지를 물어보는 라우트(2026-09-06) — 위 extension-progress와 정확히 같은 이유·같은 실수 클래스라
  // 처음부터 여기 같이 넣는다. 빠뜨리면 매번 조용히 401로 실패해(background.js가 .catch(()=>null)로
  // 삼킴) AI 지름길이 있는 줄도 모른 채 항상 완전탐색으로만 폴백하는, 알아채기 아주 어려운 버그가 된다.
  '/api/scrape/detect-last-page',
]
// 몰 id가 경로 중간에 끼어 있어(/api/sites/{id}/...) 단순 prefix로 못 걸러 정규식으로 따로 둔다 — 개발자모드
// 크롬 확장이 세션 쿠키 없이 호출하는 엔드포인트들. preview-capture(스크래핑 전 단건 미리보기),
// picker/rule(스크랩 대상 직접지정, Runtime.addBinding 경유 저장), profile(팝업의 "몰 구조분석" 버튼 —
// 빠뜨렸다가 확장에서 매번 401 unauthorized로 실패하는 게 실사용 중 확인됨, 2026-08-15),
// categories/expand(팝업의 "카테고리 하위구조 자동확인" 결과 저장, 2026-08-18). current-category(팝업의
// "현재 카테고리 가져오기" 결과 저장 — GET도 같은 경로라 여기 포함되면 같이 공개되는데, PTP 자체 화면도
// 인증된 세션으로 이 GET을 부르니 문제없다, 2026-08-22).
const PUBLIC_API_PATTERNS = [
  /^\/api\/sites\/\d+\/preview-capture$/, /^\/api\/sites\/\d+\/picker\/rule$/, /^\/api\/sites\/\d+\/profile$/,
  /^\/api\/sites\/\d+\/categories\/expand$/, /^\/api\/sites\/\d+\/sort-options$/,
  /^\/api\/sites\/\d+\/current-category$/,
  // profile-progress: "몰 구조분석"의 확장 담당 단계(카테고리 하위구조/정렬 옵션) 진행률 보고 —
  // extension-progress와 같은 이유로 빠뜨렸었다(2026-08-22).
  /^\/api\/sites\/\d+\/profile-progress$/,
  // preview-progress: "스크랩 미리보기"의 확장 쪽 캡처 시작 신호(POST) — 위 profile-progress/
  // extension-progress와 같은 실수를 반복하지 않으려고 처음부터 여기 같이 넣는다(2026-09-05). GET도
  // 같은 경로라 같이 공개되는데, current-category와 같은 이유로 문제없다 — PTP 자체 화면도 인증된
  // 세션으로 이 GET을 부른다.
  /^\/api\/sites\/\d+\/preview-progress$/,
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
