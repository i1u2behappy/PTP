'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type TabType =
  | 'dashboard' | 'clients-list' | 'client-detail' | 'sites-list' | 'site-detail' | 'scraper'
  | 'migration-dashboard'
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
}

const DASHBOARD_TAB: Tab = { id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }
const STORAGE_KEY = 'scrape.tabs.v1'
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
  }), [openTabs, activeTabId, openTab, closeTab, setActive, history.length, goBack, refreshSignals, bumpRefresh])

  return <TabsCtx.Provider value={value}>{children}</TabsCtx.Provider>
}

export function useTabs() {
  const ctx = useContext(TabsCtx)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
