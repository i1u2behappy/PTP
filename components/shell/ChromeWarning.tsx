'use client'
import { useEffect, useState } from 'react'

/** 크롬은 '직접로그인 필수' 몰 스크래핑 중엔 앱이 그 프로필을 독점해야 해서(사용자의 다른 크롬 작업과
 * 충돌) PTP 자체는 다른 브라우저(엣지 등)에서 열도록 안내한다. Edge도 UA에 "Chrome/"이 포함돼 있어
 * "Edg/" 여부로 구분해야 한다. */
function isChromeBrowser(): boolean {
  const ua = navigator.userAgent
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua) && !/Brave\//.test(ua)
}

// "확인"을 눌러도 그 선택이 어디에도 안 남아, 페이지를 새로고침할 때마다(자동화 테스트로 반복
// 새로고침한 경우 포함) 매번 다시 떴다 — 사용자 지적, 2026-08-27: "이 창이 또 떠 있는데, 수정한거
// 아니야?". "확인"을 누르면 이 브라우저에서는 다시 안 띄우도록 localStorage에 남긴다.
const DISMISSED_KEY = 'ptp.chromeWarningDismissed'

/** 엣지가 설치돼 있으면 Windows가 등록해두는 microsoft-edge: 프로토콜 핸들러로 현재 페이지를 그대로
 * 엣지에서 열게 한다 (엣지 설치 시 OS가 기본 제공하는 공식 방식 — 별도 설치/확장 불필요). */
function openInEdge() {
  window.location.href = `microsoft-edge:${window.location.href}`
}

export function ChromeWarning() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    if (isChromeBrowser() && localStorage.getItem(DISMISSED_KEY) !== '1') setShow(true)
  }, [])

  if (!show) return null

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1')
    setShow(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center">
        <div className="text-3xl mb-3">🌐</div>
        <p className="text-sm font-semibold text-gray-800 mb-2">PTP는 엣지 브라우저에서 열어주세요</p>
        <p className="text-xs text-gray-500 mb-5">
          &quot;직접로그인 필수&quot; 몰은 스크래핑 중 크롬 프로필을 독점하기 때문에, 크롬은 그 몰 전용으로
          남겨두는 것이 좋습니다. PTP 자체는 엣지 등 다른 브라우저에서 사용해주세요.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button onClick={dismiss}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
            확인
          </button>
          <button onClick={openInEdge}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">
            엣지 바로가기
          </button>
        </div>
      </div>
    </div>
  )
}
