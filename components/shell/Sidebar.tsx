'use client'
import { useState } from 'react'
import { useTabs, type Tab } from './TabsContext'
import { BoltIcon, DashboardIcon, ClientIcon, StoreIcon, ListIcon, SearchIcon, ReviewIcon, InboxIcon, ArchiveIcon, ImageEditIcon, ExportIcon, SettingsIcon, TagIcon, MapIcon, CoinIcon } from './icons'
import { CLIENTS_LIST_TAB, SITES_LIST_TAB, MASTER_LIST_TAB, PRODUCTS_LIST_TAB } from './menuTabs'

type IconComponent = (props: { active?: boolean }) => React.ReactNode

function NavGroup({ label, icon: Icon, defaultOpen, tab, children }: { label: string; icon: IconComponent; defaultOpen?: boolean; tab?: Tab; children: React.ReactNode }) {
  const { activeTabId, openTab } = useTabs()
  const [open, setOpen] = useState(!!defaultOpen)
  const isActive = !!tab && activeTabId === tab.id
  return (
    <div>
      <button onClick={() => { if (tab) openTab(tab); setOpen(true) }} aria-expanded={open}
        className={`group w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold transition-colors
          ${isActive ? 'text-teal-700' : 'text-slate-400 hover:text-slate-600'}`}>
        <Icon active={isActive} />
        <span className="flex-1 text-left">{label}</span>
        <span onClick={e => { e.stopPropagation(); setOpen(o => !o) }} role="button" tabIndex={-1} aria-label={open ? '접기' : '펼치기'}
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
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

        <NavLeaf tab={CLIENTS_LIST_TAB} icon={ClientIcon} />

        <NavLeaf tab={SITES_LIST_TAB} icon={StoreIcon} />

        {/* 대시보드 작업 플로우 순서(스크래핑 → 수집확인 → 마이그레이션 → 상품마스터 → 엑셀 내보내기)와 동일하게 배치 */}
        <NavLeaf tab={{ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }} icon={SearchIcon} />
        <NavLeaf tab={PRODUCTS_LIST_TAB} icon={InboxIcon} />

        {/* 컬럼별 전처리/변환 작업을 단계별 하위 메뉴로 구분. 그룹명 클릭 시 하위 작업 진행현황 대시보드가 열린다 */}
        <NavGroup label="마이그레이션" icon={ReviewIcon} defaultOpen
          tab={{ id: 'migration-dashboard', type: 'migration-dashboard', title: '데이터 마이그 목록', icon: '📊', closable: true }}>
          <NavLeaf tab={{ id: 'sales-code', type: 'sales-code', title: '판매관리코드 관리', icon: '💳', closable: true }} icon={TagIcon} nested />
          <NavLeaf tab={{ id: 'category-mapping', type: 'category-mapping', title: '카테고리 관리', icon: '🗺️', closable: true }} icon={MapIcon} nested />
          <NavLeaf tab={{ id: 'internal-codes', type: 'internal-codes', title: '업체코드-상품내부코드 생성', icon: '🏷️', closable: true }} icon={TagIcon} nested />
          <NavLeaf tab={{ id: 'name-management', type: 'name-management', title: '상품명 관리', icon: '✏️', closable: true }} icon={ListIcon} nested />
          <NavLeaf tab={{ id: 'option-management', type: 'option-management', title: '옵션 관리', icon: '🎛️', closable: true }} icon={SettingsIcon} nested />
          <NavLeaf tab={{ id: 'brand-origin-management', type: 'brand-origin-management', title: '브랜드,제조사,원산지 관리', icon: '🏭', closable: true }} icon={StoreIcon} nested />
          <NavLeaf tab={{ id: 'image-edit', type: 'image-edit', title: '이미지 관리', icon: '🖼️', closable: true }} icon={ImageEditIcon} nested />
          <NavLeaf tab={{ id: 'image-host', type: 'image-host', title: '이미지 호스팅관리', icon: '🌐', closable: true }} icon={ImageEditIcon} nested />
          <NavLeaf tab={{ id: 'pricing-management', type: 'pricing-management', title: '가격및이익관리', icon: '💰', closable: true }} icon={CoinIcon} nested />
        </NavGroup>

        <NavLeaf tab={MASTER_LIST_TAB} icon={ArchiveIcon} />
        <NavLeaf tab={{ id: 'transform', type: 'transform', title: '마이그레이션2_Transform', icon: '🧬', closable: true }} icon={ReviewIcon} />
        <NavLeaf tab={{ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }} icon={ExportIcon} />
        <NavLeaf tab={{ id: 'settings', type: 'settings', title: '설정', icon: '⚙️', closable: true }} icon={SettingsIcon} />
      </nav>
    </aside>
  )
}
