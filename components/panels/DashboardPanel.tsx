'use client'
import { useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'
import { SearchIcon, ReviewIcon, InboxIcon, ArchiveIcon, ExportIcon } from '../shell/icons'

const MARKETS = [
  { label: '쿠팡 Wing', className: 'bg-blue-50 text-blue-600' },
  { label: '네이버 스마트스토어', className: 'bg-emerald-50 text-emerald-600' },
  { label: '11번가', className: 'bg-rose-50 text-rose-600' },
  { label: 'G마켓', className: 'bg-orange-50 text-orange-600' },
  { label: '옥션', className: 'bg-red-50 text-red-600' },
]

const STEPS = [
  '몰 로그인 유지 스크랩', '스크랩 결과 검토·병합', '재고/카테고리/코드 추출', '상품마스터로 가공',
  '이미지 정규화 + 호스팅URL', 'AI 상품명 생성', '가격/마진 관리', '마켓별 시트 분할 다운로드',
]

export function DashboardPanel() {
  const { openTab } = useTabs()
  const [productCount, setProductCount] = useState(0)
  const [masterCount, setMasterCount]   = useState(0)
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setProductCount(data.length)
    }).catch(() => {})
    fetch('/api/master?clientId=1').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setMasterCount(data.length)
    }).catch(() => {})
    fetch('/api/scrape-staging?status=pending').then(r => r.json()).then((data: unknown[]) => {
      if (Array.isArray(data)) setPendingCount(data.length)
    }).catch(() => {})
  }, [])

  const cards = [
    {
      label: '스크래핑 시작', value: '+', accent: 'bg-emerald-50 text-emerald-600', Icon: SearchIcon,
      open: () => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }),
    },
    {
      label: '검토 대기', value: pendingCount, accent: 'bg-amber-50 text-amber-600', Icon: ReviewIcon,
      open: () => openTab({ id: 'staging-review', type: 'staging-review', title: '스크랩 검토', icon: '🔎', closable: true }),
    },
    {
      label: '수집된 원천 상품', value: productCount, accent: 'bg-teal-50 text-teal-600', Icon: InboxIcon,
      open: () => openTab({ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true }),
    },
    {
      label: '상품마스터', value: masterCount, accent: 'bg-slate-100 text-slate-600', Icon: ArchiveIcon,
      open: () => openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true }),
    },
    {
      label: '엑셀 내보내기', value: '→', accent: 'bg-violet-50 text-violet-600', Icon: ExportIcon,
      open: () => openTab({ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }),
    },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-800 mb-1">대시보드</h1>
      <p className="text-sm text-slate-500 mb-8">Mall 스크래핑 → 상품마스터 → 오픈마켓 대량등록 엑셀 변환</p>

      <div className="grid grid-cols-5 gap-4 mb-6">
        {cards.map(c => (
          <button key={c.label} onClick={c.open}
            className="group bg-white rounded-2xl border border-slate-100 p-5 text-left transition-all duration-200
              hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-8px_rgba(15,23,42,0.12)] hover:border-slate-200">
            <div className="flex items-start justify-between">
              <div className={`w-11 h-11 rounded-xl ${c.accent} flex items-center justify-center p-2.5 shrink-0`}>
                <c.Icon active />
              </div>
              <span className="text-slate-300 group-hover:text-slate-400 group-hover:translate-x-0.5 transition-all">→</span>
            </div>
            <div className="text-2xl font-bold text-slate-800 mt-4">{c.value}</div>
            <div className="text-xs text-slate-400 mt-0.5">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 p-6 mb-4">
        <h2 className="text-xs font-semibold text-slate-400 tracking-wide mb-5">작업 플로우</h2>
        <div className="flex items-start overflow-x-auto pb-1 -mx-1 px-1">
          {STEPS.map((step, i) => (
            <div key={step} className="flex items-start last:flex-none">
              <div className="flex flex-col items-center gap-2 w-[104px] shrink-0 text-center">
                <div className="w-9 h-9 rounded-full bg-teal-500 text-white text-sm font-bold flex items-center justify-center shadow-[0_4px_10px_-2px_rgba(20,184,166,0.5)]">
                  {i + 1}
                </div>
                <div className="text-xs text-slate-600 leading-snug px-1">{step}</div>
              </div>
              {i < STEPS.length - 1 && <div className="h-px bg-slate-200 mt-[18px] w-6 shrink-0" />}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 p-5">
        <div className="text-xs font-semibold text-slate-400 tracking-wide mb-3">지원 마켓 — 대량등록 양식 자동 변환</div>
        <div className="flex flex-wrap gap-2">
          {MARKETS.map(m => (
            <span key={m.label} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${m.className}`}>{m.label}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
