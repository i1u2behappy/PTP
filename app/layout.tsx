import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ variable: '--font-geist', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Scrap Tool — 쇼핑몰 상품 수집기',
  description: '상품 스크래핑 → 상품마스터 → 오픈마켓 엑셀 변환',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geist.variable} h-full`}>
      <body className="h-full font-[family-name:var(--font-geist)]">{children}</body>
    </html>
  )
}
