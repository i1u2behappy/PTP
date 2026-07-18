'use client'
import { useTabs } from './TabsContext'
import { DashboardPanel } from '../panels/DashboardPanel'
import { ClientsListPanel } from '../panels/ClientsListPanel'
import { ClientDetailPanel } from '../panels/ClientDetailPanel'
import { SitesListPanel } from '../panels/SitesListPanel'
import { SiteDetailPanel } from '../panels/SiteDetailPanel'
import { ScraperPanel } from '../panels/ScraperPanel'
import { MigrationDashboardPanel } from '../panels/MigrationDashboardPanel'
import { MasterSchemaPanel } from '../panels/MasterSchemaPanel'
import { ProductsListPanel } from '../panels/ProductsListPanel'
import { ProductDetailPanel } from '../panels/ProductDetailPanel'
import { InternalCodePanel } from '../panels/InternalCodePanel'
import { CategoryMappingPanel } from '../panels/CategoryMappingPanel'
import { SalesCodePanel } from '../panels/SalesCodePanel'
import { ProductNamePanel } from '../panels/ProductNamePanel'
import { OptionManagementPanel } from '../panels/OptionManagementPanel'
import { BrandOriginPanel } from '../panels/BrandOriginPanel'
import { PricingManagementPanel } from '../panels/PricingManagementPanel'
import { ImageHostPanel } from '../panels/ImageHostPanel'
import { MasterListPanel } from '../panels/MasterListPanel'
import { MasterDetailPanel } from '../panels/MasterDetailPanel'
import { ImageEditPanel } from '../panels/ImageEditPanel'
import { ExportPanel } from '../panels/ExportPanel'
import { SettingsPanel } from '../panels/SettingsPanel'
import { TransformPanel } from '../panels/TransformPanel'
import { ContinuousMigrationPanel } from '../panels/ContinuousMigrationPanel'

export function Workspace() {
  const { openTabs, activeTabId, canGoBack, goBack } = useTabs()
  const tab = openTabs.find(t => t.id === activeTabId)
  if (!tab) return null

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 px-6 pt-4 pb-1">
        <button onClick={goBack} disabled={!canGoBack} aria-label="바로 전 화면으로 돌아가기"
          className={`text-sm font-medium transition-colors ${canGoBack ? 'text-slate-500 hover:text-teal-600' : 'text-slate-300 cursor-default'}`}>
          ← 뒤로가기
        </button>
      </div>
      <div id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={0} className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 focus:outline-none">
        {(() => {
          switch (tab.type) {
          case 'dashboard':      return <DashboardPanel key={tab.id} />
          case 'clients-list':   return <ClientsListPanel key={tab.id} />
          case 'client-detail':  return <ClientDetailPanel key={tab.id} params={tab.params} />
          case 'sites-list':     return <SitesListPanel key={tab.id} />
          case 'site-detail':    return <SiteDetailPanel key={tab.id} params={tab.params} />
          case 'scraper':        return <ScraperPanel key={tab.id} params={tab.params} />
          case 'migration-dashboard': return <MigrationDashboardPanel key={tab.id} params={tab.params} />
          case 'master-schema':  return <MasterSchemaPanel key={tab.id} params={tab.params} />
          case 'internal-codes': return <InternalCodePanel key={tab.id} params={tab.params} />
          case 'category-mapping': return <CategoryMappingPanel key={tab.id} params={tab.params} />
          case 'sales-code':      return <SalesCodePanel key={tab.id} params={tab.params} />
          case 'name-management': return <ProductNamePanel key={tab.id} params={tab.params} />
          case 'option-management': return <OptionManagementPanel key={tab.id} params={tab.params} />
          case 'brand-origin-management': return <BrandOriginPanel key={tab.id} params={tab.params} />
          case 'pricing-management': return <PricingManagementPanel key={tab.id} params={tab.params} />
          case 'image-host':      return <ImageHostPanel key={tab.id} />
          case 'products-list':  return <ProductsListPanel key={tab.id} />
          case 'product-detail': return <ProductDetailPanel key={tab.id} params={tab.params} />
          case 'master-list':    return <MasterListPanel key={tab.id} />
          case 'master-detail':  return <MasterDetailPanel key={tab.id} params={tab.params} />
          case 'image-edit':     return <ImageEditPanel key={tab.id} params={tab.params} />
          case 'export':         return <ExportPanel key={tab.id} />
          case 'settings':       return <SettingsPanel key={tab.id} />
          case 'transform':      return <TransformPanel key={tab.id} params={tab.params} />
          case 'continuous-migration': return <ContinuousMigrationPanel key={tab.id} />
          default:               return null
          }
        })()}
      </div>
    </div>
  )
}
