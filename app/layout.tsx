import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import { ChromeWarning } from '../components/shell/ChromeWarning'
import { DbHealthBanner } from '../components/shell/DbHealthBanner'
import { GlobalErrorNet } from '../components/shell/GlobalErrorNet'
import './globals.css'

const geist = Geist({ variable: '--font-geist', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'PTP — Migration tool',
  description: 'Products Transformation Platform (PTP) — 상품 스크래핑 → 상품마스터 → 오픈마켓 엑셀 변환',
}

// dev 서버가 파일 저장으로 재컴파일하는 도중 요청이 오면, 응답으로 나간 HTML이 가리키는 CSS 청크가 아직
// 안 실렸거나 깨진 채로 오는 경우가 있다(!specifications/dev-server-autostart-on-logon.md "재컴파일 경합"
// 항목) — 이때 브라우저가 CSS 없이 그냥 그려버려서 로고가 원본 크기(600x566) 그대로 화면을 뒤덮는 등
// 꾸며지지 않은 화면이 그대로 노출된다(사용자 실사용 확인, 2026-09-19). 로고 크기를 style로 고정하는
// 식의 개별 땜질(먼저 시도했다가 "그게 아니라 그 화면 자체가 안 뜨게 하라"는 지적을 받음, 2026-09-23
// 재발 — 같은 실수를 반복함)로는 다른 요소(버튼 등)까지는 못 막으므로, 화면 전체를 기본적으로 숨겨뒀다가
// 스타일시트가 실제로 다 실린(또는 실패한) 뒤에만 보여주는 방식으로 근본적으로 막는다.
//
// 세이프티넷(아래 setTimeout)을 3초→15초로 늘렸는데도 2026-09-23에 똑같이 재현됐다 — 원인이 "느리게
// 로드되는 중"이 아니라 다른 것이었다는 뜻이라 다시 짚었다: 재컴파일 경합 중엔 서버가 Next.js 자체 CSS
// 청크(/_next/static/css/...)의 <link> 태그를 **아예 안 담은** HTML을 내려줄 수 있다(빌드 매니페스트를
// 아직 다 안 쓴 상태로 읽어버림) — 이러면 "기다릴 대상" 자체가 DOM에 없어서, 타임아웃을 아무리 늘려도
// 소용없고 아래 로직이 "감시할 스타일시트가 없다 → 이미 다 됐다"고 즉시(0ms) 오판해 버린다(Pretendard
// CDN 폰트 링크는 항상 있지만 브라우저 캐시로 이미 로드된 상태라 감시 대상에서 빠지는 경우가 흔해, 이
// 오판을 못 가려낸다). 그래서 Next 자체 CSS 링크가 하나도 없으면 "이번 응답 자체가 깨졌다"고 보고,
// 새로고침 한 번으로 재요청한다 — 그 사이 재컴파일이 끝났을 가능성이 높다. 무한 새로고침을 막기 위해
// 세션당 1번만 시도하고(sessionStorage), 그마저도 안 되면(진짜 청크 404 등) 더 기다려도 소용없으니 그냥
// 보여준다 — 화면이 영원히 안 보이는 사고가, 가끔 잠깐 안 꾸며진 화면이 보이는 것보다 훨씬 나쁘다.
const FOUC_GUARD_SCRIPT = `(function() {
  var root = document.documentElement
  var revealed = false
  function reveal() { if (revealed) return; revealed = true; root.classList.add('ptp-ready') }
  var hasNextCss = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function(l) {
    return l.href.indexOf('/_next/static/css/') !== -1
  })
  if (!hasNextCss) {
    var reloadKey = 'ptp-fouc-reload'
    if (!sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, '1')
      location.reload()
      return
    }
    reveal()
    return
  }
  sessionStorage.removeItem('ptp-fouc-reload')
  var pending = 0
  function settle() { pending--; if (pending <= 0) reveal() }
  function watch(link) {
    if (link.sheet) return
    pending++
    link.addEventListener('load', settle, { once: true })
    link.addEventListener('error', settle, { once: true })
  }
  Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), watch)
  if (pending === 0) reveal()
  // Next.js가 이 스크립트 이후에 자체 CSS <link>를 head에 추가하는 순서일 수도 있어, 그 경우까지 잡는다.
  var mo = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      Array.prototype.forEach.call(m.addedNodes, function(node) {
        if (node.tagName === 'LINK' && node.rel === 'stylesheet') watch(node)
      })
    })
  })
  mo.observe(document.head, { childList: true })
  setTimeout(function() { mo.disconnect(); reveal() }, 15000)
})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // FOUC_GUARD_SCRIPT가 하이드레이션 전에 이 태그의 className에 'ptp-ready'를 직접 붙이므로, 서버가
    // 렌더링한 값과 다르다고 React가 경고하며 되돌리려 든다(next-themes 등 다크모드 라이브러리가 같은
    // 이유로 <html>에 이 옵션을 쓰는 것과 동일한 패턴) — suppressHydrationWarning으로 이 요소 한정 허용.
    <html lang="ko" className={`${geist.variable} min-h-full`} suppressHydrationWarning>
      <head>
        {/* 국내 SaaS(플로우/두레이 등)에서 표준적으로 쓰이는 한글 웹폰트 — CDN 스타일시트, npm 의존성 추가 없음 */}
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
        {/* 위 FOUC_GUARD_SCRIPT 주석 참고 — 스타일시트가 준비될 때까지 body를 숨긴다. next/script의
            beforeInteractive는 즉시 실행되는 순수 인라인 스크립트가 아니라 Next.js 런타임이 나중에 처리하는
            큐(self.__next_s)에 밀어넣는 방식이라(실사용 확인, 2026-09-19 — 3초 세이프티넷조차 안 걸릴
            정도로 전혀 안 실행됨), 여기선 그 컴포넌트를 쓰지 않고 브라우저가 HTML을 파싱하는 그 순간 바로
            실행되는 원시 <script> 태그를 직접 심는다(다크모드 깜빡임 방지에 흔히 쓰는 것과 같은 패턴). */}
        <style>{'html:not(.ptp-ready) body { visibility: hidden }'}</style>
        <script dangerouslySetInnerHTML={{ __html: FOUC_GUARD_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <DbHealthBanner />
        <ChromeWarning />
        <GlobalErrorNet />
        {children}
      </body>
    </html>
  )
}
