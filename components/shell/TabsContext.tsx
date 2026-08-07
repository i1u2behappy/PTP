'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type TabType =
  | 'dashboard' | 'clients-list' | 'client-detail' | 'sites-list' | 'site-detail' | 'scraper'
  | 'migration-dashboard' | 'master-schema'
  | 'products-list' | 'product-detail' | 'internal-codes' | 'category-mapping' | 'sales-code' | 'name-management'
  | 'option-management' | 'brand-origin-management' | 'pricing-management' | 'image-host'
  | 'master-list' | 'master-detail' | 'image-edit'
  | 'export' | 'settings' | 'transform' | 'continuous-migration'

export interface Tab {
  id: string
  type: TabType
  title: string
  icon: string
  params?: Record<string, unknown>
  closable: boolean
}

export type RefreshScope = 'sites' | 'products' | 'master' | 'staging' | 'clients'

interface TabsState {
  openTabs: Tab[]
  activeTabId: string
  openTab: (tab: Tab) => void
  closeTab: (id: string) => void
  setActive: (id: string) => void
  canGoBack: boolean
  goBack: () => void
  refreshSignals: Record<RefreshScope, number>
  bumpRefresh: (scope: RefreshScope) => void
  /** 지금 활성 탭(메뉴)이 "다음에 뭘 눌러야 하는지" 안내하는 한 줄 문구 — 각 패널이 자신의 내부 진행
   *  상태(예: 스크래핑 화면의 몰선택→로그인→몰구조파악→미리보기→시작)를 보고 직접 계산해 넣는다.
   *  탭을 벗어나면 그 패널이 언마운트되며 null로 되돌려야 한다(그렇지 않으면 안내가 다른 화면까지 따라옴). */
  guidance: string | null
  setGuidance: (text: string | null) => void
  /** 데스크톱에서 메뉴바를 아이콘만 보이는 좁은 폭으로 접어 본문을 더 크게 볼 수 있게 하는 수동 토글 —
   *  다음 방문에도 유지되도록 localStorage에 저장한다. */
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void
  /** 좁은 화면(모바일)에서 평소엔 숨겨두는 메뉴바를 햄버거 버튼으로 열고 닫는 상태 — 화면 크기에 따라
   *  달라지는 일시적 상태라 저장하지 않는다(새로고침/화면 확대 시 항상 닫힌 상태로 시작). */
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (v: boolean | ((prev: boolean) => boolean)) => void
}

const DASHBOARD_TAB: Tab = { id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }
const STORAGE_KEY = 'scrape.tabs.v1'
const SIDEBAR_COLLAPSED_KEY = 'scrape.sidebar.collapsed'
const MAX_HISTORY = 20

function sameTab(a: Tab | undefined, b: Tab | undefined): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.type === b.type && JSON.stringify(a.params || {}) === JSON.stringify(b.params || {})
}

const TabsCtx = createContext<TabsState | null>(null)

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [openTabs, setOpenTabs] = useState<Tab[]>([DASHBOARD_TAB])
  const [activeTabId, setActiveTabId] = useState(DASHBOARD_TAB.id)
  const [hydrated, setHydrated] = useState(false)
  const [refreshSignals, setRefreshSignals] = useState<Record<RefreshScope, number>>({ sites: 0, products: 0, master: 0, staging: 0, clients: 0 })
  const [guidance, setGuidance] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') setSidebarCollapsed(true)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // "뒤로가기" 히스토리 — 실제 화면 전환(탭 id/type/params 변경)이 있을 때만 이전 화면을 쌓는다.
  // setOpenTabs/setHistory의 함수형 업데이터 안에서 서로를 호출하면(중첩 setState) StrictMode 재실행 시
  // 중복 push될 수 있어, 최신값은 ref로 읽고 실제 setState 호출은 이벤트 핸들러 본문에서 한 번씩만 한다.
  const [history, setHistory] = useState<Tab[]>([])
  const openTabsRef = useRef(openTabs)
  const activeTabIdRef = useRef(activeTabId)
  const historyRef = useRef(history)
  useEffect(() => { openTabsRef.current = openTabs }, [openTabs])
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])
  useEffect(() => { historyRef.current = history }, [history])

  function recordHistory(fromId: string) {
    const current = openTabsRef.current.find(t => t.id === fromId)
    if (!current) return
    const last = historyRef.current[historyRef.current.length - 1]
    if (sameTab(last, current)) return
    setHistory(h => [...h, current].slice(-MAX_HISTORY))
  }

  // 마운트 시 이전 세션의 열린 탭 복원.
  // localStorage는 서버에 없으므로 SSR 결과와 맞추려면 기본값으로 먼저 그린 뒤 마운트 후 동기 반영이 불가피하다
  // (next-themes 등 영속 상태 하이드레이션 라이브러리들과 동일한 패턴).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as { openTabs: Tab[]; activeTabId: string }
        if (saved.openTabs?.length) {
          setOpenTabs(saved.openTabs)
          setActiveTabId(saved.activeTabId || saved.openTabs[0].id)
        }
      }
    } catch { /* 손상된 저장값은 무시하고 기본값 사용 */ }
    setHydrated(true)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ openTabs, activeTabId }))
  }, [openTabs, activeTabId, hydrated])

  const openTab = useCallback((tab: Tab) => {
    const current = openTabsRef.current.find(t => t.id === activeTabIdRef.current)
    if (!sameTab(current, tab)) recordHistory(activeTabIdRef.current)
    // 이미 열려있는 탭이면 params를 최신값으로 갈아끼운다 — 수집확인 등에서 특정 세션을 지정해 다시 열 때 반영되도록.
    setOpenTabs(prev => (prev.some(t => t.id === tab.id) ? prev.map(t => (t.id === tab.id ? tab : t)) : [...prev, tab]))
    setActiveTabId(tab.id)
  }, [])

  // 브라우저 "뒤로가기"를 눌러도 PTP 밖으로 나가지 않고 대시보드가 열리게 한다 — 히스토리에 더미 엔트리를
  // 계속 채워둬 뒤로가기가 실제로 이전 페이지로 넘어가기 전에 항상 이 트랩에 먼저 걸리게 한다.
  useEffect(() => {
    window.history.pushState(null, '', location.href)
    function handlePopState() {
      window.history.pushState(null, '', location.href)
      openTab(DASHBOARD_TAB)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [openTab])

  const setActive = useCallback((id: string) => {
    if (id !== activeTabIdRef.current) recordHistory(activeTabIdRef.current)
    setActiveTabId(id)
  }, [])

  const goBack = useCallback(() => {
    const h = historyRef.current
    if (!h.length) return
    const prevTab = h[h.length - 1]
    setHistory(h2 => h2.slice(0, -1))
    setOpenTabs(op => (op.some(t => t.id === prevTab.id) ? op.map(t => (t.id === prevTab.id ? prevTab : t)) : [...op, prevTab]))
    setActiveTabId(prevTab.id)
  }, [])

  const closeTab = useCallback((id: string) => {
    setOpenTabs(prev => {
      if (prev.length <= 1) return prev
      const idx = prev.findIndex(t => t.id === id)
      if (idx === -1) return prev
      const next = prev.filter(t => t.id !== id)
      setActiveTabId(current => {
        if (current !== id) return current
        const neighbor = next[idx] || next[idx - 1] || next[0]
        return neighbor.id
      })
      return next
    })
  }, [])

  const bumpRefresh = useCallback((scope: RefreshScope) => {
    setRefreshSignals(prev => ({ ...prev, [scope]: prev[scope] + 1 }))
  }, [])

  const value = useMemo<TabsState>(() => ({
    openTabs, activeTabId, openTab, closeTab, setActive, canGoBack: history.length > 0, goBack, refreshSignals, bumpRefresh,
    guidance, setGuidance, sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen, setMobileSidebarOpen,
  }), [openTabs, activeTabId, openTab, closeTab, setActive, history.length, goBack, refreshSignals, bumpRefresh, guidance,
      sidebarCollapsed, mobileSidebarOpen])

  return <TabsCtx.Provider value={value}>{children}</TabsCtx.Provider>
}

export function useTabs() {
  const ctx = useContext(TabsCtx)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
