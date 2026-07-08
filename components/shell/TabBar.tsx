'use client'
import { useTabs } from './TabsContext'

export function TabBar() {
  const { openTabs, activeTabId, setActive, closeTab } = useTabs()

  return (
    <div className="h-10 shrink-0 bg-white border-t border-slate-200 flex items-stretch overflow-x-auto">
      {openTabs.map(tab => {
        const isActive = tab.id === activeTabId
        return (
          <div key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`group flex items-center gap-2 px-4 border-t-2 cursor-pointer text-sm shrink-0 transition-colors select-none
              ${isActive ? 'border-indigo-500 bg-slate-50 text-slate-900 font-medium' : 'border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
            <span>{tab.icon}</span>
            <span className="whitespace-nowrap max-w-[160px] truncate">{tab.title}</span>
            {tab.closable && (
              <button onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 hover:text-slate-700 transition-opacity">
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
