'use client'
import { useState } from 'react'
import Image from 'next/image'
import { useTabs, type Tab } from './TabsContext'
import { useCurrentUser } from './CurrentUserContext'
import { DashboardIcon, ClientIcon, StoreIcon, ListIcon, SearchIcon, ReviewIcon, InboxIcon, ArchiveIcon, ImageEditIcon, ExportIcon, SettingsIcon, TagIcon, MapIcon, CoinIcon, RefreshIcon } from './icons'
import { CLIENTS_LIST_TAB, SITES_LIST_TAB, MASTER_LIST_TAB, PRODUCTS_LIST_TAB } from './menuTabs'
import { SystemStatus } from './SystemStatus'

type IconComponent = (props: { active?: boolean }) => React.ReactNode

const DASHBOARD_TAB: Tab = { id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }

function NavGroup({ label, icon: Icon, defaultOpen, tab, children }: { label: string; icon: IconComponent; defaultOpen?: boolean; tab?: Tab; children: React.ReactNode }) {
  const { activeTabId, openTab, sidebarCollapsed, setMobileSidebarOpen } = useTabs()
  const [open, setOpen] = useState(!!defaultOpen)
  const isActive = !!tab && activeTabId === tab.id
  // 접힌 상태(아이콘만)에서는 하위 메뉴를 펼칠 자리가 없다 — 그룹 버튼 자체가 대표 탭으로 바로 이동하는
  // 링크 역할만 한다(다른 하위 메뉴는 펼친 뒤에 접근).
  return (
    <div>
      <button onClick={() => { if (tab) openTab(tab); if (!sidebarCollapsed) setOpen(true); setMobileSidebarOpen(false) }}
        aria-expanded={sidebarCollapsed ? undefined : open} title={sidebarCollapsed ? label : undefined}
        className={`group w-full flex items-center gap-2 py-2 text-sm font-semibold transition-colors
          ${sidebarCollapsed ? 'justify-center px-0' : 'px-3'}
          ${isActive ? 'text-teal-700' : 'text-slate-400 hover:text-slate-600'}`}>
        <Icon active={isActive} />
        {!sidebarCollapsed && (
          <>
            <span className="flex-1 text-left">{label}</span>
            <span onClick={e => { e.stopPropagation(); setOpen(o => !o) }} role="button" tabIndex={-1} aria-label={open ? '접기' : '펼치기'}
              className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden="true">›</span>
          </>
        )}
      </button>
      {open && !sidebarCollapsed && <div className="space-y-0.5 pb-1">{children}</div>}
    </div>
  )
}

function NavLeaf({ tab, icon: Icon, nested }: { tab: Tab; icon: IconComponent; nested?: boolean }) {
  const { openTabs, activeTabId, openTab, sidebarCollapsed, setMobileSidebarOpen } = useTabs()
  const isActive = activeTabId === tab.id
  const isOpen = openTabs.some(t => t.id === tab.id)
  return (
    <button onClick={() => { openTab(tab); setMobileSidebarOpen(false) }} aria-current={isActive ? 'page' : undefined}
      title={sidebarCollapsed ? tab.title : undefined}
      className={`group w-full flex items-center gap-2 py-1.5 text-sm rounded-full transition-colors text-left
        ${sidebarCollapsed ? 'justify-center px-0' : nested ? 'pl-6 pr-3' : 'px-3'}
        ${isActive ? 'bg-teal-50 text-teal-700 font-semibold' : isOpen ? 'text-slate-600 bg-slate-50' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
      <Icon active={isActive} />
      {!sidebarCollapsed && <span className="truncate">{tab.title}</span>}
    </button>
  )
}

export function Sidebar() {
  const { openTab, sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen, setMobileSidebarOpen } = useTabs()
  const { isAdmin } = useCurrentUser()
  return (
    <>
      {/* 좁은 화면에서 메뉴바가 열려있을 때만 뒤에 반투명 배경을 깔아, 바깥을 탭하면 닫히게 한다.
          md 이상에서는 메뉴바가 항상 레이아웃에 포함돼 있어(오버레이가 아님) 필요 없다. */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 bg-black/30 z-30 md:hidden" onClick={() => setMobileSidebarOpen(false)} aria-hidden="true" />
      )}
      <aside className={`fixed md:static inset-y-0 left-0 z-40 md:z-auto h-full bg-white border-r border-slate-100 flex flex-col overflow-y-auto
          transition-transform duration-200 md:transition-[width] md:duration-200
          ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0
          ${sidebarCollapsed ? 'md:w-16' : 'md:w-64'} w-64 shrink-0`}>
        <div className={`h-16 flex items-center shrink-0 ${sidebarCollapsed ? 'justify-center px-0' : 'justify-between px-5'}`}>
          <button onClick={() => { openTab(DASHBOARD_TAB); setMobileSidebarOpen(false) }} aria-label="첫페이지로 이동" title="첫페이지로 이동"
            className="flex items-center h-full text-left hover:opacity-80 active:opacity-70 transition-opacity cursor-pointer">
            {/* 이 이미지만 인라인 style로 땜질하는 시도는 이미 한 번 했다가 반려된 방식이다(app/layout.tsx의
                FOUC_GUARD_SCRIPT 주석 참고 — "그게 아니라 그 화면 자체가 안 뜨게 하라"). 근본 수정은
                그쪽에 있다 — 여기는 원래대로 className만 쓴다. */}
            <Image src="/logo.jpg" alt="ILDA:Bridge" width={600} height={566} className="h-10 w-auto" priority />
          </button>
          {/* 데스크톱 전용 접기/펼치기 토글 — 모바일은 바깥 탭/햄버거로 여닫으므로 이 버튼이 필요 없다. */}
          {!sidebarCollapsed && (
            <button onClick={() => setSidebarCollapsed(true)} aria-label="메뉴 접기" title="메뉴 접기"
              className="hidden md:flex p-1.5 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors shrink-0">
              «
            </button>
          )}
        </div>
        {sidebarCollapsed && (
          <button onClick={() => setSidebarCollapsed(false)} aria-label="메뉴 펼치기" title="메뉴 펼치기"
            className="hidden md:flex justify-center py-1.5 mx-2 mb-1 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors shrink-0">
            »
          </button>
        )}

        <nav className="flex-1 px-2 pb-3 space-y-1" aria-label="주 메뉴">
          <NavLeaf tab={DASHBOARD_TAB} icon={DashboardIcon} />

          <NavLeaf tab={CLIENTS_LIST_TAB} icon={ClientIcon} />

          <NavLeaf tab={SITES_LIST_TAB} icon={StoreIcon} />

          {/* 대시보드 작업 플로우 순서(스크래핑 → 수집확인 → 마이그레이션 → 상품마스터 → 엑셀 내보내기)와 동일하게 배치 */}
          <NavLeaf tab={{ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true }} icon={SearchIcon} />
          <NavLeaf tab={PRODUCTS_LIST_TAB} icon={InboxIcon} />

          {/* 컬럼별 전처리/변환 작업을 단계별 하위 메뉴로 구분. 그룹명 클릭 시 하위 작업 진행현황 대시보드가 열린다 */}
          <NavGroup label="마이그레이션" icon={ReviewIcon} defaultOpen
            tab={{ id: 'migration-dashboard', type: 'migration-dashboard', title: '데이터 마이그 목록', icon: '📊', closable: true }}>
            <NavLeaf tab={{ id: 'sales-code', type: 'sales-code', title: '판매관리코드 관리', icon: '💳', closable: true }} icon={TagIcon} nested />
            <NavLeaf tab={{ id: 'category-mapping', type: 'category-mapping', title: '카테고리 매핑', icon: '🗺️', closable: true }} icon={MapIcon} nested />
            <NavLeaf tab={{ id: 'internal-codes', type: 'internal-codes', title: '관리코드 생성', icon: '🏷️', closable: true }} icon={TagIcon} nested />
            <NavLeaf tab={{ id: 'name-management', type: 'name-management', title: '상품명 관리', icon: '✏️', closable: true }} icon={ListIcon} nested />
            <NavLeaf tab={{ id: 'option-management', type: 'option-management', title: '옵션 관리', icon: '🎛️', closable: true }} icon={SettingsIcon} nested />
            <NavLeaf tab={{ id: 'brand-origin-management', type: 'brand-origin-management', title: '브랜드·제조사·원산지 관리', icon: '🏭', closable: true }} icon={StoreIcon} nested />
            <NavLeaf tab={{ id: 'image-edit', type: 'image-edit', title: '이미지 편집', icon: '🖼️', closable: true }} icon={ImageEditIcon} nested />
            <NavLeaf tab={{ id: 'image-host', type: 'image-host', title: '이미지 호스팅 관리', icon: '🌐', closable: true }} icon={ImageEditIcon} nested />
            <NavLeaf tab={{ id: 'pricing-management', type: 'pricing-management', title: '가격 및 이익 관리', icon: '💰', closable: true }} icon={CoinIcon} nested />
            {/* 거래처 구분 없는 시스템 전체 공용 기준 테이블이라 admin만 접근하게 한다(2026-08) — 실제 차단은
                /api/master/schema가 서버에서 한다, 여기는 메뉴 노출만 맞춘다. */}
            {isAdmin && (
              <NavLeaf tab={{ id: 'master-schema', type: 'master-schema', title: '>기준 마스터테이블 관리', icon: '🧱', closable: true }} icon={ArchiveIcon} nested />
            )}
          </NavGroup>

          <NavLeaf tab={MASTER_LIST_TAB} icon={ArchiveIcon} />
          <NavLeaf tab={{ id: 'transform', type: 'transform', title: '마이그레이션2_Transform', icon: '🧬', closable: true }} icon={ReviewIcon} />
          <NavLeaf tab={{ id: 'continuous-migration', type: 'continuous-migration', title: '마이그레이션3_연속관리', icon: '🔁', closable: true }} icon={RefreshIcon} />
          <NavLeaf tab={{ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true }} icon={ExportIcon} />
          <NavLeaf tab={{ id: 'marketplace-register', type: 'marketplace-register', title: '오픈마켓 등록', icon: '🛒', closable: true }} icon={StoreIcon} />
          <NavLeaf tab={{ id: 'settings', type: 'settings', title: '시스템관리', icon: '⚙️', closable: true }} icon={SettingsIcon} />
        </nav>

        <div className="px-2 pb-3 shrink-0 border-t border-slate-100 pt-2">
          <SystemStatus />
          <button onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login' }}
            title={sidebarCollapsed ? '로그아웃' : undefined}
            className={`w-full flex items-center gap-2 py-1.5 text-sm rounded-full text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors text-left
              ${sidebarCollapsed ? 'justify-center px-0' : 'px-3'}`}>
            <span aria-hidden="true">🚪</span>
            {!sidebarCollapsed && <span>로그아웃</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
