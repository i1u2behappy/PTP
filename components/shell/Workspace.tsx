'use client'
import { useTabs } from './TabsContext'
import { DashboardPanel } from '../panels/DashboardPanel'
import { SitesListPanel } from '../panels/SitesListPanel'
import { SiteDetailPanel } from '../panels/SiteDetailPanel'
import { ScraperPanel } from '../panels/ScraperPanel'
import { StagingReviewPanel } from '../panels/StagingReviewPanel'
import { ProductsListPanel } from '../panels/ProductsListPanel'
import { ProductDetailPanel } from '../panels/ProductDetailPanel'
import { MasterListPanel } from '../panels/MasterListPanel'
import { MasterDetailPanel } from '../panels/MasterDetailPanel'
import { ExportPanel } from '../panels/ExportPanel'
import { SettingsPanel } from '../panels/SettingsPanel'

export function Workspace() {
  const { openTabs, activeTabId } = useTabs()
  const tab = openTabs.find(t => t.id === activeTabId)
  if (!tab) return null

  return (
    <div id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={0} className="flex-1 overflow-y-auto p-6 focus:outline-none">
      {(() => {
        switch (tab.type) {
          case 'dashboard':      return <DashboardPanel key={tab.id} />
          case 'sites-list':     return <SitesListPanel key={tab.id} />
          case 'site-detail':    return <SiteDetailPanel key={tab.id} tabId={tab.id} params={tab.params} />
          case 'scraper':        return <ScraperPanel key={tab.id} />
          case 'staging-review': return <StagingReviewPanel key={tab.id} />
          case 'products-list':  return <ProductsListPanel key={tab.id} />
          case 'product-detail': return <ProductDetailPanel key={tab.id} tabId={tab.id} params={tab.params} />
          case 'master-list':    return <MasterListPanel key={tab.id} />
          case 'master-detail':  return <MasterDetailPanel key={tab.id} tabId={tab.id} params={tab.params} />
          case 'export':         return <ExportPanel key={tab.id} />
          case 'settings':       return <SettingsPanel key={tab.id} />
          default:               return null
        }
      })()}
    </div>
  )
}
