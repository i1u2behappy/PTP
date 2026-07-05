import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import './globals.css'

const geist = Geist({ variable: '--font-geist', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Scrap Tool — 쇼핑몰 상품 수집기',
  description: '상품 스크래핑 → 마스터 DB → 오픈마켓 엑셀 변환',
}

const NAV = [
  { href: '/',                  label: '대시보드' },
  { href: '/sites',             label: '🏬 쇼핑몰 관리' },
  { href: '/scraper',           label: '🔍 스크래핑' },
  { href: '/products',          label: '1️⃣ 수집 확인' },
  { href: '/products/complete', label: '2️⃣ 데이터 보완' },
  { href: '/products/finalize', label: '3️⃣ 최종 완성' },
  { href: '/export',            label: '📊 엑셀 내보내기' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geist.variable} h-full`}>
      <body className="min-h-full bg-gray-50 font-[family-name:var(--font-geist)]">
        {/* 상단 네비게이션 */}
        <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-1">
            <span className="font-bold text-indigo-600 mr-6 text-sm">⚡ Scrap Tool</span>
            {NAV.map(n => (
              <Link key={n.href} href={n.href}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
                {n.label}
              </Link>
            ))}
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  )
}
