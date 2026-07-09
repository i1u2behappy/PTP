'use client'
import { useEffect, useState } from 'react'
import { useTabs, type Tab } from './TabsContext'
import { BoltIcon, DashboardIcon, ClientIcon, StoreIcon, PlusIcon, ListIcon, SearchIcon, ReviewIcon, InboxIcon, ArchiveIcon, ExportIcon, SettingsIcon } from './icons'

interface Client { id: number; name: string }
type IconComponent = (props: { active?: boolean }) => React.ReactNode

function NavGroup({ label, icon: Icon, defaultOpen, children }: { label: string; icon: IconComponent; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="group w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-600 transition-colors">
        <Icon />
        <span className="flex-1 text-left">{label}</span>
        <span className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
      </button>
      {open && <div className="space-y-0.5 pb-1">{children}</div>}
    </div>
  )
}

function NavLeaf({ tab, icon: Icon, nested }: { tab: Tab; icon: IconComponent; nested?: boolean }) {
  const { openTabs, activeTabId, openTab } = useTabs()
  const isActive = activeTabId === tab.id
  const isOpen = openTabs.some(t => t.id === tab.id)
  return (
    <button onClick={() => openTab(tab)} aria-current={isActive ? 'page' : undefined}
      className={`group w-full flex items-center gap-2 ${nested ? 'pl-6 pr-3' : 'px-3'} py-1.5 text-sm rounded-full transition-colors text-left
        ${isActive ? 'bg-teal-50 text-teal-700 font-semibold' : isOpen ? 'text-slate-600 bg-slate-50' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
      <Icon active={isActive} />
      <span className="truncate">{tab.title}</span>
    </button>
  )
}

export function Sidebar() {
  const { openTab, refreshSignals } = useTabs()
  const [clients, setClients] = useState<Client[]>([])

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [refreshSignals.clients])

  return (
    <aside className="w-64 shrink-0 bg-white border-r border-slate-100 flex flex-col h-full overflow-y-auto">
      <div className="px-5 h-16 flex items-center gap-2 shrink-0">
        <span className="w-8 h-8 rounded-xl bg-teal-500 text-white flex items-center justify-center p-1.5 shrink-0" aria-hidden="true">
          <BoltIcon className="w-full h-full" />
        </span>
        <span className="font-bold text-slate-800 text-sm tracking-wide">PTP</span>
      </div>

      <nav className="flex-1 px-2 pb-3 space-y-1" aria-label="주 메뉴">
        <NavLeaf tab={{ id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }} icon={DashboardIcon} />

        <NavGroup label="거래처 관리" icon={ClientIcon}>
          <button onClick={() => openTab({ id: 'client-detail:new', type: 'client-detail', title: '새 거래처 등록', icon: '➕', closable: true })}
            className="group w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm rounded-full text-teal-600 hover:bg-teal-50 transition-colors text-left">
            <PlusIcon />
            <span>새 거래처 등록</span>
          </button>
          <NavLeaf tab={{ id: 'clients-list', type: 'clients-list', title: '거래처 목록', icon: '📋', closable: true }} icon={ListIcon} nested />
          {clients.map(c => (
            <button key={c.id}
              onClick={() => openTab({ id: `client-detail:${c.id}`, type: 'client-detail', title: c.name, icon: '🏢', params: { clientId: c.id }, closable: true })}
              className="w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-xs rounded-full text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors text-left truncate">
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </NavGroup>

        <NavLeaf tab={{ id: 'sites-list', type: 'sites-list', title: 'Mall 상세관리', icon: '📋', closable: true }} icon={StoreIcon} />

        {/* 대시보드 작업 플로우 순서(스크래핑 → 스크랩 검토 → 수집확인 → 상품마스터 → 엑셀 내보내기)와 동일하게 배치 */}
        <NavLeaf tab={{ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }} icon={SearchIcon} />
        <NavLeaf tab={{ id: 'staging-review', type: 'staging-review', title: '스크랩 검토', icon: '🔎', closable: true }} icon={ReviewIcon} />
        <NavLeaf tab={{ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true }} icon={InboxIcon} />
        <NavLeaf tab={{ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true }} icon={ArchiveIcon} />
        <NavLeaf tab={{ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }} icon={ExportIcon} />
        <NavLeaf tab={{ id: 'settings', type: 'settings', title: '설정', icon: '⚙️', closable: true }} icon={SettingsIcon} />
      </nav>
    </aside>
  )
}
