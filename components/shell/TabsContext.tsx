'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type TabType =
  | 'dashboard' | 'clients-list' | 'client-detail' | 'sites-list' | 'site-detail' | 'scraper'
  | 'migration-dashboard' | 'master-schema'
  | 'products-list' | 'internal-codes' | 'category-mapping' | 'category-tree' | 'sales-code' | 'name-management'
  | 'option-management' | 'brand-origin-management' | 'pricing-management' | 'image-host'
  | 'master-list' | 'image-edit'
  | 'export' | 'settings' | 'transform' | 'continuous-migration' | 'marketplace-register'

/** 상품/상품마스터 "상세"는 탭이 아니라 팝업으로 띄운다 — 예전엔 탭(activeTabId 재사용)으로 열어서,
 *  방금까지 "스크랩 Raw 확인" 등 메뉴 이름이던 탭이 갑자기 상품명으로 바뀌어 보여 혼란스럽다는 지적이
 *  있었다(2026-08-13). 팝업은 현재 탭을 건드리지 않고 그 위에 겹쳐 뜬다. */
export type DetailModalType = 'product-detail' | 'master-detail'
export interface DetailModalState {
  type: DetailModalType
  params: Record<string, unknown>
}

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
  /** 상품/상품마스터 상세 팝업 — null이면 안 떠 있음. 현재 활성 탭과 독립적이다. */
  detailModal: DetailModalState | null
  openDetailModal: (type: DetailModalType, params: Record<string, unknown>) => void
  closeDetailModal: () => void
}

const DASHBOARD_TAB: Tab = { id: 'dashboard', type: 'dashboard', title: '대시보드', icon: '📊', closable: false }
// sessionStorage에 저장한다(localStorage 아님) — localStorage는 같은 브라우저의 모든 탭이 공유해서,
// 다른 탭(또는 예전 세션)이 열어뒀던 탭 목록/파라미터(예: 스크래핑 탭의 siteId)가 지금 탭에 새어
// 들어올 수 있다. 개발서버의 Fast Refresh 강제 새로고침으로 화면이 통째로 다시 마운트되면서, 지금
// 보고 있던 몰과 무관한 다른 몰(예전에 다른 탭에서 열어뒀던 siteId)로 조용히 바뀌어버린 사고로 실제
// 확인됨(2026-08-17) — sessionStorage는 탭 하나에만 묶이고 그 탭을 닫기 전까진 새로고침해도 그대로
// 남아있어, "새로고침해도 열린 탭이 안 사라진다"는 기존 목적은 그대로 지키면서 다른 탭의 상태가 섞여
// 들어오는 일은 없앤다.
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
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null)
  const openDetailModal = useCallback((type: DetailModalType, params: Record<string, unknown>) => {
    setDetailModal({ type, params })
  }, [])
  const closeDetailModal = useCallback(() => setDetailModal(null), [])

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
      const raw = sessionStorage.getItem(STORAGE_KEY)
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
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ openTabs, activeTabId }))
  }, [openTabs, activeTabId, hydrated])

  const openTab = useCallback((tab: Tab) => {
    const current = openTabsRef.current.find(t => t.id === activeTabIdRef.current)
    if (!sameTab(current, tab)) recordHistory(activeTabIdRef.current)
    // 이미 열려있는 탭이면 params를 최신값으로 갈아끼운다 — 수집확인 등에서 특정 세션을 지정해 다시 열 때 반영되도록.
    setOpenTabs(prev => (prev.some(t => t.id === tab.id) ? prev.map(t => (t.id === tab.id ? tab : t)) : [...prev, tab]))
    setActiveTabId(tab.id)
  }, [])

  // 브라우저 "뒤로가기"를 눌러도 PTP 밖으로 나가지 않게 한다 — 히스토리에 더미 엔트리를 계속 채워둬
  // 뒤로가기가 실제로 이전 페이지로 넘어가기 전에 항상 이 트랩에 먼저 걸리게 한다. 대시보드로 강제
  // 전환하지는 않는다 — popstate는 의도적인 뒤로가기 버튼뿐 아니라 트랙패드 스와이프/마우스 사이드버튼
  // 등으로도 뜨는데, 스크래핑 진행 화면 등을 보다가 실수로 이게 뜨면 진행 중인 화면에서 대시보드로
  // 튕겨나가는 부작용이 있었다(2026-08-09 실사용 확인) — 그냥 지금 화면에 머무는 것으로 충분하다.
  useEffect(() => {
    window.history.pushState(null, '', location.href)
    function handlePopState() {
      window.history.pushState(null, '', location.href)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
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
    guidance, setGuidance, sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen, setMobileSidebarOpen,
    detailModal, openDetailModal, closeDetailModal,
  }), [openTabs, activeTabId, openTab, closeTab, setActive, history.length, goBack, refreshSignals, bumpRefresh, guidance,
      sidebarCollapsed, mobileSidebarOpen, detailModal, openDetailModal, closeDetailModal])

  return <TabsCtx.Provider value={value}>{children}</TabsCtx.Provider>
}

export function useTabs() {
  const ctx = useContext(TabsCtx)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
