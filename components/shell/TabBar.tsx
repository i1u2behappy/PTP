'use client'
import { useRef } from 'react'
import { useTabs } from './TabsContext'

export function TabBar() {
  const { openTabs, activeTabId, setActive, closeTab } = useTabs()
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({})

  function focusTab(id: string) {
    setActive(id)
    tabRefs.current[id]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTab(openTabs[(index + 1) % openTabs.length].id) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTab(openTabs[(index - 1 + openTabs.length) % openTabs.length].id) }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(openTabs[0].id) }
    else if (e.key === 'End') { e.preventDefault(); focusTab(openTabs[openTabs.length - 1].id) }
  }

  return (
    <div role="tablist" aria-label="열린 작업 탭" className="h-11 shrink-0 bg-white border-t border-slate-100 flex items-stretch gap-1 px-2 overflow-x-auto">
      {openTabs.map((tab, i) => {
        const isActive = tab.id === activeTabId
        return (
          // 탭 안에 별도의 닫기 버튼이 들어가는 구조라 이 요소 자체는 <button>이 될 수 없다(버튼 중첩은 유효하지 않은 HTML).
          // 대신 role="tab" + tabIndex + 키보드 핸들러로 동일한 접근성을 제공한다.
          <div key={tab.id}
            ref={el => { tabRefs.current[tab.id] = el }}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={e => {
              handleKeyDown(e, i)
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(tab.id) }
            }}
            onClick={() => setActive(tab.id)}
            className={`group flex items-center gap-2 my-1.5 px-4 rounded-full text-sm shrink-0 transition-colors select-none cursor-pointer
              ${isActive ? 'bg-teal-50 text-teal-700 font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
            <span aria-hidden="true">{tab.icon}</span>
            <span className="whitespace-nowrap max-w-[160px] truncate">{tab.title}</span>
            {tab.closable && (
              <button type="button" onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                aria-label={`${tab.title} 탭 닫기`} tabIndex={-1}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded-full text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-teal-100 hover:text-teal-700 transition-opacity">
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
