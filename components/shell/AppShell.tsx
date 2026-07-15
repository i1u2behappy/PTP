'use client'
import { TabsProvider } from './TabsContext'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { Workspace } from './Workspace'

export function AppShell() {
  return (
    <TabsProvider>
      <div className="h-screen w-full flex overflow-hidden bg-slate-50">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Workspace />
          <TabBar />
        </div>
      </div>
    </TabsProvider>
  )
}
