'use client'
import { useEffect, useState } from 'react'
import { useTabs, type Tab } from './TabsContext'

interface Site { id: number; name: string | null; url: string }

function NavGroup({ label, defaultOpen, children }: { label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors">
        <span>{label}</span>
        <span className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && <div className="space-y-0.5 pb-1">{children}</div>}
    </div>
  )
}

function NavLeaf({ tab }: { tab: Tab }) {
  const { openTabs, activeTabId, openTab } = useTabs()
  const isActive = activeTabId === tab.id
  const isOpen = openTabs.some(t => t.id === tab.id)
  return (
    <button onClick={() => openTab(tab)}
      className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm rounded-lg transition-colors text-left
        ${isActive ? 'bg-indigo-600 text-white font-medium' : isOpen ? 'text-slate-200 bg-slate-800/60' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}`}>
      <span className="shrink-0">{tab.icon}</span>
      <span className="truncate">{tab.title}</span>
    </button>
  )
}

export function Sidebar() {
  const { openTab } = useTabs()
  const [sites, setSites] = useState<Site[]>([])

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
  }, [])

  return (
    <aside className="w-60 shrink-0 bg-slate-900 flex flex-col h-full overflow-y-auto">
      <div className="px-4 h-14 flex items-center gap-2 border-b border-slate-800/80 shrink-0">
        <span className="text-lg">⚡</span>
        <span className="font-bold text-white text-sm tracking-wide">Scrap Tool</span>
      </div>

      <nav className="flex-1 py-3 space-y-1">
        <NavLeaf tab={{ id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }} />

        <NavGroup label="🏬 쇼핑몰 관리" defaultOpen>
          <button onClick={() => openTab({ id: 'site-detail:new', type: 'site-detail', title: '새 쇼핑몰 등록', icon: '➕', closable: true })}
            className="w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm rounded-lg text-indigo-400 hover:bg-slate-800/60 hover:text-indigo-300 transition-colors text-left">
            <span>➕</span><span>새 쇼핑몰 등록</span>
          </button>
          <NavLeaf tab={{ id: 'sites-list', type: 'sites-list', title: '쇼핑몰 목록', icon: '📋', closable: true }} />
          {sites.map(s => (
            <button key={s.id}
              onClick={() => openTab({ id: `site-detail:${s.id}`, type: 'site-detail', title: s.name || s.url, icon: '🏬', params: { siteId: s.id }, closable: true })}
              className="w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-xs rounded-lg text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 transition-colors text-left truncate">
              <span className="truncate">{s.name || s.url}</span>
            </button>
          ))}
        </NavGroup>

        <NavLeaf tab={{ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }} />

        <NavGroup label="📦 상품 관리" defaultOpen>
          <NavLeaf tab={{ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true }} />
          <NavLeaf tab={{ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true }} />
        </NavGroup>

        <NavLeaf tab={{ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }} />
        <NavLeaf tab={{ id: 'settings', type: 'settings', title: '설정', icon: '⚙️', closable: true }} />
      </nav>
    </aside>
  )
}
