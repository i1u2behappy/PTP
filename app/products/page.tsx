'use client'
import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'

interface Product {
  id: number
  session_id: number | null
  name_original: string
  name_ai: string | null
  price: number | null
  sale_price: number | null
  brand: string
  category: string
  thumbnail_local: string | null
  thumbnail_url: string | null
  detail_images: { url: string; local_path: string }[]
  status: string
  created_at: string
}

interface Session {
  id: number
  url: string
  status: string
  found_count: number
  saved_count: number
  created_at: string
}

function missingFields(p: Product): string[] {
  const missing: string[] = []
  if (!p.name_original) missing.push('상품명')
  if (p.price == null && p.sale_price == null) missing.push('가격')
  if (!p.thumbnail_local) missing.push('대표이미지')
  const failedDetail = (p.detail_images || []).filter(d => d.url && !d.local_path).length
  if (failedDetail > 0) missing.push(`상세이미지 ${failedDetail}개 다운로드 실패`)
  if (!p.brand) missing.push('브랜드')
  if (!p.category) missing.push('카테고리')
  return missing
}

export default function ProductsPage() {
  const [products, setProducts]   = useState<Product[]>([])
  const [sessions, setSessions]   = useState<Session[]>([])
  const [selected, setSelected]   = useState<Set<number>>(new Set())
  const [aiLoading, setAiLoading] = useState<Set<number>>(new Set())
  const [editId, setEditId]       = useState<number | null>(null)
  const [editName, setEditName]   = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)

  const load = useCallback(() => {
    fetch('/api/products').then(r => r.json()).then((d: Product[]) => { if (Array.isArray(d)) setProducts(d) }).catch(() => {})
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => { if (Array.isArray(d)) setSessions(d) }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const visibleProducts = issuesOnly ? products.filter(p => missingFields(p).length > 0) : products

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === visibleProducts.length ? new Set() : new Set(visibleProducts.map(p => p.id)))
  }

  async function genAiName(id: number) {
    setAiLoading(s => new Set(s).add(id))
    await fetch(`/api/products/${id}/ai-name`, { method: 'POST' })
    load()
    setAiLoading(s => { const n = new Set(s); n.delete(id); return n })
  }

  async function genAllAiNames() {
    const ids = selected.size > 0 ? [...selected] : products.filter(p => !p.name_ai).map(p => p.id)
    for (const id of ids) await genAiName(id)
  }

  async function saveEdit(id: number) {
    await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name_ai: editName }),
    })
    setEditId(null)
    load()
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
          <h1 className="text-2xl font-bold text-gray-800">1️⃣ 수집 확인</h1>
          <p className="text-xs text-gray-400 mt-1">스크래핑한 상품을 그대로 조회하고, 누락된 데이터가 없는지 확인합니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={genAllAiNames}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors">
            ✨ AI 상품명 생성 {selected.size > 0 ? `(${selected.size}개 선택)` : '(미생성 전체)'}
          </button>
          {selected.size > 0 && (
            <button onClick={deleteSelected}
              className="px-4 py-2 bg-red-500 text-white text-sm rounded-lg hover:bg-red-600 transition-colors">
              🗑 삭제 ({selected.size})
            </button>
          )}
        </div>
      </div>

      {/* 세션별 수집 검증 */}
      {sessions.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
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
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 상품이 없습니다.</p>
          <a href="/scraper" className="mt-2 inline-block text-indigo-600 text-sm hover:underline">스크래핑 시작하기 →</a>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                  <th className="px-2 py-3 text-left">원본 상품명</th>
                  <th className="px-2 py-3 text-left">AI 상품명 (20자)</th>
                  <th className="w-28 px-2 py-3 text-left">판매가</th>
                  <th className="w-24 px-2 py-3 text-left">브랜드</th>
                  <th className="w-40 px-2 py-3 text-left">카테고리</th>
                  <th className="px-2 py-3 text-left">누락 데이터</th>
                  <th className="w-16 px-2 py-3 text-left">액션</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map(p => {
                  const missing = missingFields(p)
                  return (
                  <tr key={p.id}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${selected.has(p.id) ? 'bg-indigo-50' : ''}`}>
                    <td className="px-4 py-3"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} /></td>

                    {/* 이미지 */}
                    <td className="px-2 py-3">
                      <div className="w-16 h-16 relative rounded-lg overflow-hidden bg-gray-100">
                        {p.thumbnail_local ? (
                          <Image src={p.thumbnail_local} alt={p.name_original || ''} fill className="object-cover" unoptimized />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">No img</div>
                        )}
                      </div>
                    </td>

                    {/* 원본명 */}
                    <td className="px-2 py-3 text-gray-700 text-xs leading-relaxed line-clamp-2">{p.name_original}</td>

                    {/* AI 상품명 */}
                    <td className="px-2 py-3">
                      {editId === p.id ? (
                        <div className="flex gap-1">
                          <input value={editName} onChange={e => setEditName(e.target.value)} maxLength={20}
                            className="border border-indigo-300 rounded px-2 py-1 text-xs flex-1 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                          <button onClick={() => saveEdit(p.id)} className="text-xs bg-indigo-600 text-white px-2 py-1 rounded">저장</button>
                          <button onClick={() => setEditId(null)} className="text-xs text-gray-400 px-1">✕</button>
                        </div>
                      ) : p.name_ai ? (
                        <div className="flex items-center gap-1">
                          <span className="text-indigo-700 font-medium text-xs">{p.name_ai}</span>
                          <button onClick={() => { setEditId(p.id); setEditName(p.name_ai || '') }}
                            className="text-gray-300 hover:text-gray-500 text-xs">✏️</button>
                        </div>
                      ) : (
                        <button onClick={() => genAiName(p.id)} disabled={aiLoading.has(p.id)}
                          className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50">
                          {aiLoading.has(p.id) ? '생성 중...' : '✨ 생성'}
                        </button>
                      )}
                    </td>

                    {/* 판매가 */}
                    <td className="px-2 py-3 text-gray-800 font-semibold text-xs">
                      {p.sale_price ? `₩${p.sale_price.toLocaleString()}` : p.price ? `₩${p.price.toLocaleString()}` : '-'}
                    </td>

                    {/* 브랜드 */}
                    <td className="px-2 py-3 text-gray-500 text-xs">{p.brand || '-'}</td>

                    {/* 카테고리 (몰의 카테고리명) */}
                    <td className="px-2 py-3 text-gray-500 text-xs truncate max-w-[160px]" title={p.category}>{p.category || '-'}</td>

                    {/* 누락 데이터 */}
                    <td className="px-2 py-3 text-xs">
                      {missing.length === 0 ? (
                        <span className="text-emerald-600">✓ 완전</span>
                      ) : (
                        <span className="text-amber-600" title={missing.join(', ')}>⚠ {missing.join(', ')}</span>
                      )}
                    </td>

                    {/* 액션 */}
                    <td className="px-2 py-3">
                      <button onClick={() => genAiName(p.id)} disabled={aiLoading.has(p.id)}
                        title="AI 상품명 재생성"
                        className="text-xs px-2 py-1 bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 disabled:opacity-50">
                        {aiLoading.has(p.id) ? '...' : '✨'}
                      </button>
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
        <a href="/products/complete" className="text-indigo-600 hover:underline font-medium">다음: 데이터 보완 →</a>
      </div>
    </div>
  )
}
