'use client'
import { useEffect, useRef, useState } from 'react'
import { useTabs } from './TabsContext'
import { TAB_ICONS } from './icons'

const TAB_WIDTH = 117
const MORE_WIDTH = 40
const GAP = 4

export function TabBar() {
  const { openTabs, activeTabId, setActive, closeTab } = useTabs()
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [overflowOpen, setOverflowOpen] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setContainerWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!overflowOpen) return
    function onClickOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [overflowOpen])

  const fitsAll = containerWidth === 0 || openTabs.length * (TAB_WIDTH + GAP) <= containerWidth
  const visibleCount = fitsAll ? openTabs.length : Math.max(1, Math.floor((containerWidth - MORE_WIDTH - GAP) / (TAB_WIDTH + GAP)))
  const visibleTabs = fitsAll ? openTabs : openTabs.slice(0, visibleCount)
  const overflowTabs = fitsAll ? [] : openTabs.slice(visibleCount)
  const activeInOverflow = overflowTabs.some(t => t.id === activeTabId)

  function focusTab(id: string) {
    setActive(id)
    tabRefs.current[id]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTab(visibleTabs[(index + 1) % visibleTabs.length].id) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTab(visibleTabs[(index - 1 + visibleTabs.length) % visibleTabs.length].id) }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(visibleTabs[0].id) }
    else if (e.key === 'End') { e.preventDefault(); focusTab(visibleTabs[visibleTabs.length - 1].id) }
  }

  return (
    <div ref={containerRef} className="h-11 w-full shrink-0 bg-white border-t border-slate-100 flex items-stretch px-2">
      <div role="tablist" aria-label="열린 작업 탭" className="flex-1 min-w-0 flex items-stretch gap-1 overflow-hidden">
        {visibleTabs.map((tab, i) => {
          const isActive = tab.id === activeTabId
          const Icon = TAB_ICONS[tab.id]
          return (
            // 탭 안에 별도의 닫기 버튼이 들어가는 구조라 이 요소 자체는 <button>이 될 수 없다(버튼 중첩은 유효하지 않은 HTML).
            // 대신 role="tab" + tabIndex + 키보드 핸들러로 동일한 접근성을 제공한다.
            <div key={tab.id}
              ref={el => { tabRefs.current[tab.id] = el }}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              title={tab.title}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={e => {
                handleKeyDown(e, i)
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(tab.id) }
              }}
              onClick={() => setActive(tab.id)}
              style={{ width: TAB_WIDTH }}
              className={`group flex items-center gap-1.5 my-1.5 px-3 rounded-full text-sm shrink-0 transition-colors select-none cursor-pointer
                ${isActive ? 'bg-teal-50 text-teal-700 font-semibold' : 'text-slate-600 font-medium hover:bg-slate-50 hover:text-slate-900'}`}>
              <span aria-hidden="true" className="shrink-0">{Icon ? <Icon active={isActive} /> : tab.icon}</span>
              <span className="whitespace-nowrap truncate min-w-0 flex-1">{tab.title}</span>
              {tab.closable && (
                <button type="button" onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  aria-label={`${tab.title} 탭 닫기`} tabIndex={-1}
                  className="shrink-0 ml-1 w-4 h-4 flex items-center justify-center rounded-full text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-teal-100 hover:text-teal-700 transition-opacity">
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>

      {overflowTabs.length > 0 && (
        <div ref={moreRef} className="relative shrink-0 my-1.5 ml-1">
          <button type="button" onClick={() => setOverflowOpen(o => !o)} aria-label={`숨겨진 탭 더보기 (${overflowTabs.length}개)`} aria-expanded={overflowOpen}
            className={`h-full w-10 flex flex-col items-center justify-center gap-[3px] rounded-full transition-colors
              ${activeInOverflow ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
            <span className={`block w-4 h-0.5 rounded-full ${activeInOverflow ? 'bg-teal-700' : 'bg-slate-500'}`} />
            <span className={`block w-4 h-0.5 rounded-full ${activeInOverflow ? 'bg-teal-700' : 'bg-slate-500'}`} />
            <span className={`block w-4 h-0.5 rounded-full ${activeInOverflow ? 'bg-teal-700' : 'bg-slate-500'}`} />
          </button>
          {overflowOpen && (
            <div role="menu" className="absolute bottom-full right-0 mb-1 w-56 max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-30">
              {overflowTabs.map(tab => {
                const isActive = tab.id === activeTabId
                const Icon = TAB_ICONS[tab.id]
                return (
                  <div key={tab.id} role="menuitem"
                    onClick={() => { setActive(tab.id); setOverflowOpen(false) }}
                    className={`group flex items-center gap-2 px-3 py-2 text-sm cursor-pointer select-none
                      ${isActive ? 'bg-teal-50 text-teal-700 font-semibold' : 'text-slate-700 hover:bg-slate-50'}`}>
                    <span aria-hidden="true" className="shrink-0">{Icon ? <Icon active={isActive} /> : tab.icon}</span>
                    <span className="truncate flex-1 min-w-0">{tab.title}</span>
                    {tab.closable && (
                      <button type="button" onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                        aria-label={`${tab.title} 탭 닫기`}
                        className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-slate-400 hover:bg-teal-100 hover:text-teal-700">
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
