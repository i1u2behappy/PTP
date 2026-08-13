'use client'
import { TabsProvider } from './TabsContext'
import { CurrentUserProvider } from './CurrentUserContext'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { Workspace } from './Workspace'
import { DetailModal } from './DetailModal'

export function AppShell() {
  return (
    <CurrentUserProvider>
      <TabsProvider>
        <div className="h-screen w-full flex overflow-hidden bg-slate-50">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <Workspace />
            <TabBar />
          </div>
        </div>
        <DetailModal />
      </TabsProvider>
    </CurrentUserProvider>
  )
}
