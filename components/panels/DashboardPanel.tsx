'use client'
import { useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'

export function DashboardPanel() {
  const { openTab } = useTabs()
  const [productCount, setProductCount] = useState(0)
  const [masterCount, setMasterCount]   = useState(0)

  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setProductCount(data.length)
    }).catch(() => {})
    fetch('/api/master?clientId=1').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setMasterCount(data.length)
    }).catch(() => {})
  }, [])

  const cards = [
    { label: '스크래핑 시작', value: '+', color: 'bg-emerald-500', icon: '🔍', open: () => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }) },
    { label: '수집된 원천 상품', value: productCount, color: 'bg-teal-500', icon: '📦', open: () => openTab({ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true }) },
    { label: '상품마스터', value: masterCount, color: 'bg-slate-600', icon: '🗂️', open: () => openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true }) },
    { label: '엑셀 내보내기', value: '→', color: 'bg-amber-500', icon: '📊', open: () => openTab({ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }) },
  ]

  const steps = [
    '몰 로그인 유지 스크랩', '재고/카테고리/코드 추출', '상품마스터로 가공(참조데이터 보완)',
    '이미지 정규화+호스팅URL', 'AI 상품명 생성', '가격/마진 관리', '마켓별 시트 분할 다운로드',
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-1">대시보드</h1>
      <p className="text-sm text-gray-500 mb-8">쇼핑몰 스크래핑 → 상품마스터 → 오픈마켓 대량등록 엑셀 변환</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        {cards.map(c => (
          <button key={c.label} onClick={c.open}
            className="bg-white rounded-2xl border border-gray-200 p-5 hover:shadow-md transition-shadow flex items-center gap-4 text-left">
            <div className={`w-12 h-12 rounded-2xl ${c.color} flex items-center justify-center text-2xl shrink-0`}>{c.icon}</div>
            <div>
              <div className="text-2xl font-bold text-gray-800">{c.value}</div>
              <div className="text-sm text-gray-500">{c.label}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-700 mb-5">작업 플로우</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {steps.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-teal-50 text-teal-600 rounded-xl px-3 py-1.5">
                <span className="w-5 h-5 rounded-full bg-teal-500 text-white text-xs font-bold flex items-center justify-center">{i + 1}</span>
                <span className="font-medium">{step}</span>
              </div>
              {i < steps.length - 1 && <span className="text-gray-300 font-bold">›</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
        <strong>지원 마켓:</strong> 쿠팡 Wing · 네이버 스마트스토어 · 11번가 · G마켓 · 옥션 — 각 마켓 대량등록 양식으로 자동 변환
      </div>
    </div>
  )
}
