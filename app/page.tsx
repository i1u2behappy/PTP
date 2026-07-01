'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function Dashboard() {
  const [productCount, setProductCount] = useState(0)

  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setProductCount(data.length)
    }).catch(() => {})
  }, [])

  const cards = [
    { label: '수집된 상품', value: productCount, color: 'bg-indigo-500', href: '/products', icon: '📦' },
    { label: '스크래핑 시작', value: '+', color: 'bg-emerald-500', href: '/scraper', icon: '🔍' },
    { label: '엑셀 내보내기', value: '→', color: 'bg-amber-500', href: '/export', icon: '📊' },
  ]

  const steps = [
    'URL + 로그인 입력', 'Playwright 렌더링', 'AI 데이터 추출',
    '이미지 로컬 백업', 'AI 상품명 생성 (20자)', '마켓 양식 변환', '엑셀 다운로드',
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-1">대시보드</h1>
      <p className="text-sm text-gray-500 mb-8">쇼핑몰 스크래핑 → 마스터 DB → 오픈마켓 대량등록 엑셀 변환</p>

      <div className="grid grid-cols-3 gap-4 mb-8">
        {cards.map(c => (
          <Link key={c.label} href={c.href}
            className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl ${c.color} flex items-center justify-center text-2xl`}>{c.icon}</div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{c.value}</div>
              <div className="text-sm text-gray-500">{c.label}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-700 mb-5">작업 플로우</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {steps.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 rounded-lg px-3 py-1.5">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">{i + 1}</span>
                <span className="font-medium">{step}</span>
              </div>
              {i < steps.length - 1 && <span className="text-gray-300 font-bold">›</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <strong>지원 마켓:</strong> 쿠팡 Wing · 네이버 스마트스토어 · 11번가 · G마켓 · 옥션 — 각 마켓 대량등록 양식으로 자동 변환
      </div>
    </div>
  )
}
