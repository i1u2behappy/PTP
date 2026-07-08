'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type TabType =
  | 'dashboard' | 'sites-list' | 'site-detail' | 'scraper'
  | 'products-list' | 'product-detail' | 'master-list' | 'master-detail'
  | 'export' | 'settings'

export interface Tab {
  id: string
  type: TabType
  title: string
  icon: string
  params?: Record<string, unknown>
  closable: boolean
}

export type RefreshScope = 'sites' | 'products' | 'master'

interface TabsState {
  openTabs: Tab[]
  activeTabId: string
  openTab: (tab: Tab) => void
  closeTab: (id: string) => void
  setActive: (id: string) => void
  refreshSignals: Record<RefreshScope, number>
  bumpRefresh: (scope: RefreshScope) => void
}

const DASHBOARD_TAB: Tab = { id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }
const STORAGE_KEY = 'scrap.tabs.v1'

const TabsCtx = createContext<TabsState | null>(null)

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [openTabs, setOpenTabs] = useState<Tab[]>([DASHBOARD_TAB])
  const [activeTabId, setActiveTabId] = useState(DASHBOARD_TAB.id)
  const [hydrated, setHydrated] = useState(false)
  const [refreshSignals, setRefreshSignals] = useState<Record<RefreshScope, number>>({ sites: 0, products: 0, master: 0 })

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
    setOpenTabs(prev => (prev.some(t => t.id === tab.id) ? prev : [...prev, tab]))
    setActiveTabId(tab.id)
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
    openTabs, activeTabId, openTab, closeTab, setActive: setActiveTabId, refreshSignals, bumpRefresh,
  }), [openTabs, activeTabId, openTab, closeTab, refreshSignals, bumpRefresh])

  return <TabsCtx.Provider value={value}>{children}</TabsCtx.Provider>
}

export function useTabs() {
  const ctx = useContext(TabsCtx)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
