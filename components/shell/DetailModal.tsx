'use client'
import { useTabs } from './TabsContext'
import { ProductDetailPanel } from '../panels/ProductDetailPanel'
import { MasterDetailPanel } from '../panels/MasterDetailPanel'

/** 상품/상품마스터 상세를 탭이 아니라 이 팝업으로 띄운다 — 현재 활성 탭을 건드리지 않고 그 위에
 *  겹쳐 뜨므로, 하단 탭 바의 이름이 상품명으로 바뀌어 보이던 문제(2026-08-13)가 없다. AppShell
 *  최상단에 한 번만 렌더링해 어떤 탭이 활성화돼 있어도 항상 그 위에 뜬다. */
export function DetailModal() {
  const { detailModal, closeDetailModal } = useTabs()
  if (!detailModal) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={closeDetailModal}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto relative"
        onClick={e => e.stopPropagation()}>
        <button onClick={closeDetailModal} aria-label="닫기"
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors">
          ×
        </button>
        <div className="p-6">
          {detailModal.type === 'product-detail'
            ? <ProductDetailPanel key={JSON.stringify(detailModal.params)} params={detailModal.params} />
            : <MasterDetailPanel key={JSON.stringify(detailModal.params)} params={detailModal.params} />}
        </div>
      </div>
    </div>
  )
}
