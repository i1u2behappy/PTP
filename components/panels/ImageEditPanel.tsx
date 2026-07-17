'use client'
import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface ImageRow { id: number; image_type: 'thumbnail' | 'detail'; sort_order: number; storage_path: string }
interface MasterWithImages { id: number; name_original: string; name_final: string | null; images: ImageRow[] }

function ImageTile({ img, selected, onToggle, moveLabel, onMove }: { img: ImageRow; selected: boolean; onToggle: () => void; moveLabel?: string; onMove?: () => void }) {
  return (
    <div className={`relative w-24 h-24 rounded-xl overflow-hidden border shrink-0 ${selected ? 'border-teal-400 ring-2 ring-teal-200' : 'border-gray-200'}`}>
      <Image src={img.storage_path} alt="" fill className="object-cover" unoptimized />
      <input type="checkbox" checked={selected} onChange={onToggle}
        className="absolute top-1.5 left-1.5 z-10" />
      {onMove && (
        <button onClick={onMove} title={moveLabel}
          className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] py-0.5 hover:bg-teal-600/80 transition-colors">
          {moveLabel}
        </button>
      )}
    </div>
  )
}

export function ImageEditPanel({ params }: { params?: Record<string, unknown> }) {
  const { refreshSignals, bumpRefresh } = useTabs()
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [products, setProducts] = useState<MasterWithImages[]>([])
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (scope.sessionId === '') { setProducts([]); return }
    fetch(`/api/master/images?sessionId=${scope.sessionId}`).then(r => r.json()).then((d: MasterWithImages[]) => { if (Array.isArray(d)) setProducts(d) }).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { load() }, [load, refreshSignals.master])

  function toggleSelect(id: number) {
    setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function deleteSelected() {
    if (!selectedIds.size || !confirm(`선택한 이미지 ${selectedIds.size}개를 삭제할까요?`)) return
    setBusy(true)
    try {
      await Promise.all([...selectedIds].map(id => fetch(`/api/master/images/${id}`, { method: 'DELETE' })))
      setSelectedIds(new Set())
      load()
      bumpRefresh('master')
    } finally {
      setBusy(false)
    }
  }

  async function moveImage(imageId: number, imageType: 'thumbnail' | 'detail') {
    await fetch(`/api/master/images/${imageId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageType }),
    })
    load()
    bumpRefresh('master')
  }

  const q = search.trim().toLowerCase()
  const filteredProducts = q
    ? products.filter(p => (p.name_final || p.name_original || '').toLowerCase().includes(q))
    : products

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🖼️ 이미지 편집</h1>
          <p className="text-xs text-gray-400 mt-1">상품마스터의 다운로드 이미지를 상품별로 대표/상세이미지 목록으로 조회하고, 선택 삭제·대표이미지 지정을 할 수 있습니다.</p>
        </div>
        {selectedIds.size > 0 && (
          <button onClick={deleteSelected} disabled={busy}
            className="px-4 py-2 bg-rose-50 text-rose-600 text-sm font-semibold rounded-full hover:bg-rose-100 disabled:opacity-50 transition-colors">
            🗑 선택 삭제 ({selectedIds.size})
          </button>
        )}
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
      <>
      <div className="mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명 검색..."
          className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
      </div>

      {filteredProducts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">🖼️</div>
          <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredProducts.map(p => {
            const thumbs = p.images.filter(i => i.image_type === 'thumbnail').sort((a, b) => a.sort_order - b.sort_order)
            const details = p.images.filter(i => i.image_type === 'detail').sort((a, b) => a.sort_order - b.sort_order)
            return (
              <div key={p.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 text-sm font-semibold text-gray-700 truncate">
                  {p.name_final || p.name_original || `상품 #${p.id}`}
                </div>
                <div className="p-4 flex gap-6">
                  <div className="shrink-0">
                    <p className="text-xs font-semibold text-gray-500 mb-2">대표이미지 ({thumbs.length})</p>
                    {thumbs.length === 0 ? (
                      <div className="w-24 h-24 rounded-xl bg-gray-100 flex items-center justify-center text-gray-300 text-xs">없음</div>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {thumbs.map(img => (
                          <ImageTile key={img.id} img={img} selected={selectedIds.has(img.id)} onToggle={() => toggleSelect(img.id)}
                            moveLabel="상세로 이동" onMove={() => moveImage(img.id, 'detail')} />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-500 mb-2">상세이미지 ({details.length})</p>
                    {details.length === 0 ? (
                      <p className="text-xs text-gray-300">상세이미지 없음</p>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {details.map(img => (
                          <ImageTile key={img.id} img={img} selected={selectedIds.has(img.id)} onToggle={() => toggleSelect(img.id)}
                            moveLabel="대표로 지정" onMove={() => moveImage(img.id, 'thumbnail')} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      </>
      )}
    </div>
  )
}
