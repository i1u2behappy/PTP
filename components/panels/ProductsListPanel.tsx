'use client'
import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'

interface MallProduct {
  id: number
  site_id: number
  mall_product_code: string
  name_original: string
  price: number | null
  sale_price: number | null
  brand: string
  mall_category: string
  thumbnail_local: string | null
  detail_image_urls: { url: string }[]
  stock_status: string | null
  stock_qty: number | null
  last_scraped_at: string
  master_product_id: number | null
}

interface Session {
  id: number
  url: string
  status: string
  found_count: number
  saved_count: number
  created_at: string
}

function missingFields(p: MallProduct): string[] {
  const missing: string[] = []
  if (!p.name_original) missing.push('상품명')
  if (p.price == null && p.sale_price == null) missing.push('가격')
  if (!p.thumbnail_local) missing.push('대표이미지')
  if (!p.brand) missing.push('브랜드')
  if (!p.mall_category) missing.push('카테고리')
  return missing
}

export function ProductsListPanel() {
  const { openTab, refreshSignals, bumpRefresh } = useTabs()
  const [products, setProducts]   = useState<MallProduct[]>([])
  const [sessions, setSessions]   = useState<Session[]>([])
  const [selected, setSelected]   = useState<Set<number>>(new Set())
  const [migrating, setMigrating] = useState(false)
  const [issuesOnly, setIssuesOnly] = useState(false)

  const load = useCallback(() => {
    fetch('/api/products').then(r => r.json()).then((d: MallProduct[]) => { if (Array.isArray(d)) setProducts(d) }).catch(() => {})
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => { if (Array.isArray(d)) setSessions(d) }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load, refreshSignals.products])

  const visibleProducts = issuesOnly ? products.filter(p => missingFields(p).length > 0) : products

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === visibleProducts.length ? new Set() : new Set(visibleProducts.map(p => p.id)))
  }

  function openDetail(p: MallProduct) {
    openTab({ id: `product-detail:${p.id}`, type: 'product-detail', title: p.name_original?.slice(0, 14) || `상품 #${p.id}`, icon: '📦', params: { mallProductId: p.id }, closable: true })
  }

  async function migrateSelected() {
    const ids = selected.size > 0 ? [...selected] : products.map(p => p.id)
    if (!ids.length) return
    setMigrating(true)
    try {
      const res = await fetch('/api/master/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallProductIds: ids, clientId: 1 }),
      })
      if (!res.ok) throw new Error('마이그레이션 실패')
      bumpRefresh('products')
      bumpRefresh('master')
      openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true })
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setMigrating(false)
    }
  }

  async function deleteSelected() {
    if (!selected.size || !confirm(`${selected.size}개 상품을 삭제할까요?`)) return
    await Promise.all([...selected].map(id => fetch(`/api/products/${id}`, { method: 'DELETE' })))
    setSelected(new Set())
    load()
  }

  const totalIssues = products.filter(p => missingFields(p).length > 0).length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📥 수집 확인</h1>
          <p className="text-xs text-gray-400 mt-1">스크래핑한 원천 데이터를 조회하고, 행을 클릭하면 상세/수정/재스크랩으로 이어집니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={migrateSelected} disabled={migrating}
            className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 transition-colors">
            {migrating ? '처리 중...' : `➜ 상품마스터로 가공 ${selected.size > 0 ? `(${selected.size}개 선택)` : '(전체)'}`}
          </button>
          {selected.size > 0 && (
            <button onClick={deleteSelected}
              className="px-4 py-2 bg-rose-50 text-rose-600 text-sm font-semibold rounded-full hover:bg-rose-100 transition-colors">
              🗑 삭제 ({selected.size})
            </button>
          )}
        </div>
      </div>

      {/* 세션별 수집 검증 */}
      {sessions.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
            세션별 수집 검증 — 원 상품페이지에서 찾은 개수 대비 실제 저장 개수
          </div>
          <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
            {sessions.map(s => {
              const matched = s.status === 'done' && Number(s.found_count) === Number(s.saved_count)
              return (
                <div key={s.id} className="flex items-center justify-between px-4 py-2 text-xs">
                  <span className="text-gray-500 truncate flex-1">{s.url}</span>
                  <span className="text-gray-400 shrink-0 mx-3">{s.status}</span>
                  <span className={`font-medium shrink-0 ${matched ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {matched ? '✓' : '⚠'} 발견 {s.found_count}개 / 저장 {s.saved_count}개
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {products.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 상품이 없습니다.</p>
          <button onClick={() => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true })}
            className="mt-2 inline-block text-teal-500 text-sm hover:underline">스크래핑 시작하기 →</button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50">
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={issuesOnly} onChange={e => setIssuesOnly(e.target.checked)} />
              누락된 데이터가 있는 상품만 보기 {totalIssues > 0 && `(${totalIssues}개)`}
            </label>
          </div>
          <div className="overflow-y-auto max-h-[70vh]">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500">
                  <th className="w-10 px-4 py-3 text-left"><input type="checkbox" checked={selected.size === visibleProducts.length && visibleProducts.length > 0} onChange={selectAll} /></th>
                  <th className="w-20 px-2 py-3 text-left">이미지</th>
                  <th className="px-2 py-3 text-left">상품명</th>
                  <th className="w-28 px-2 py-3 text-left">판매가</th>
                  <th className="w-24 px-2 py-3 text-left">브랜드</th>
                  <th className="w-40 px-2 py-3 text-left">카테고리</th>
                  <th className="w-24 px-2 py-3 text-left">재고상태</th>
                  <th className="px-2 py-3 text-left">누락 데이터</th>
                  <th className="w-24 px-2 py-3 text-left">가공 상태</th>
                  <th className="w-10 px-2 py-3 text-left">상세</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map(p => {
                  const missing = missingFields(p)
                  return (
                  <tr key={p.id} onClick={() => openDetail(p)}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${selected.has(p.id) ? 'bg-teal-50' : ''}`}>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} />
                    </td>

                    <td className="px-2 py-3">
                      <div className="w-16 h-16 relative rounded-xl overflow-hidden bg-gray-100">
                        {p.thumbnail_local ? (
                          <Image src={p.thumbnail_local} alt={p.name_original || ''} fill className="object-cover" unoptimized />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">No img</div>
                        )}
                      </div>
                    </td>

                    <td className="px-2 py-3 text-gray-700 text-xs leading-relaxed line-clamp-2">{p.name_original}</td>

                    <td className="px-2 py-3 text-gray-800 font-semibold text-xs">
                      {p.sale_price ? `₩${p.sale_price.toLocaleString()}` : p.price ? `₩${p.price.toLocaleString()}` : '-'}
                    </td>

                    <td className="px-2 py-3 text-gray-500 text-xs">{p.brand || '-'}</td>

                    <td className="px-2 py-3 text-gray-500 text-xs truncate max-w-[160px]" title={p.mall_category}>{p.mall_category || '-'}</td>

                    <td className="px-2 py-3 text-xs">
                      {p.stock_status === '품절' || p.stock_status?.startsWith('단종') ? (
                        <span className="text-rose-500">{p.stock_status}</span>
                      ) : (
                        <span className="text-emerald-600">{p.stock_status || '-'}</span>
                      )}
                      {p.stock_qty != null && <span className="text-gray-400"> ({p.stock_qty})</span>}
                    </td>

                    <td className="px-2 py-3 text-xs">
                      {missing.length === 0 ? (
                        <span className="text-emerald-600">✓ 완전</span>
                      ) : (
                        <span className="text-amber-600" title={missing.join(', ')}>⚠ {missing.join(', ')}</span>
                      )}
                    </td>

                    <td className="px-2 py-3 text-xs">
                      {p.master_product_id ? <span className="text-teal-500">✓ 가공됨</span> : <span className="text-gray-400">미가공</span>}
                    </td>
                    <td className="px-2 py-3" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openDetail(p)} aria-label={`${p.name_original || '상품'} 상세 보기`} title="상세 보기" className="text-teal-500 hover:text-teal-600">🔍</button>
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <p>전체 {products.length}개 상품 · 선택 {selected.size}개 {totalIssues > 0 && `· 누락 데이터 있음 ${totalIssues}개`}</p>
        <button onClick={() => openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true })}
          className="text-teal-500 hover:underline font-medium">다음: 상품마스터 →</button>
      </div>
    </div>
  )
}
