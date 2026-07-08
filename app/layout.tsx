import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ variable: '--font-geist', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'PTP — Mall 상품 수집기',
  description: 'Products Transformation Platform (PTP) — 상품 스크래핑 → 상품마스터 → 오픈마켓 엑셀 변환',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geist.variable} h-full`}>
      <head>
        {/* 국내 SaaS(플로우/두레이 등)에서 표준적으로 쓰이는 한글 웹폰트 — CDN 스타일시트, npm 의존성 추가 없음 */}
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
      </head>
      <body className="h-full">{children}</body>
    </html>
  )
}
