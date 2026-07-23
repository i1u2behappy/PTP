'use client'
import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'
import { MASTER_LIST_TAB } from '../shell/menuTabs'

interface MallProductDetail {
  id: number
  site_id: number
  mall_product_code: string
  source_url: string
  mall_category: string
  name_original: string
  price: number | null
  sale_price: number | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  stock_status: string | null
  stock_qty: number | null
  thumbnail_locals: string[]
  detail_image_local: string[]
  last_scraped_at: string | null
  master_product_id: number | null
}

const FIELDS: { key: keyof MallProductDetail; label: string; type: 'text' | 'number' | 'textarea' }[] = [
  { key: 'name_original', label: '상품명', type: 'text' },
  { key: 'mall_category', label: '카테고리', type: 'text' },
  { key: 'brand', label: '브랜드', type: 'text' },
  { key: 'manufacturer', label: '제조사', type: 'text' },
  { key: 'origin', label: '원산지', type: 'text' },
  { key: 'price', label: '정상가', type: 'number' },
  { key: 'sale_price', label: '판매가', type: 'number' },
  { key: 'description', label: '설명', type: 'textarea' },
]

export function ProductDetailPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, goBack, bumpRefresh } = useTabs()
  const mallProductId = params?.mallProductId as number
  const [data, setData]       = useState<MallProductDetail | null>(null)
  const [form, setForm]       = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [rescraping, setRescraping] = useState(false)
  const [migrating, setMigrating]   = useState(false)

  const load = useCallback(() => {
    fetch(`/api/products/${mallProductId}`).then(r => r.json()).then((d: MallProductDetail) => {
      setData(d)
      setForm(Object.fromEntries(FIELDS.map(f => [f.key, d[f.key] == null ? '' : String(d[f.key])])))
    }).finally(() => setLoading(false))
  }, [mallProductId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      for (const f of FIELDS) {
        body[f.key] = f.type === 'number' ? (form[f.key].trim() === '' ? null : Number(form[f.key])) : form[f.key]
      }
      await fetch(`/api/products/${mallProductId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      bumpRefresh('products')
      load()
    } finally {
      setSaving(false)
    }
  }

  async function handleRescrape() {
    setRescraping(true)
    try {
      const res = await fetch(`/api/products/${mallProductId}/rescrape`, { method: 'POST' })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`재스크랩 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { stagingId: number; isAlreadyMigrated: boolean }
      bumpRefresh('staging')
      const goReview = confirm(
        `재스크랩 결과가 검토 대기 상태로 저장되었습니다${d.isAlreadyMigrated ? ' (이미 상품마스터로 가공된 상품이라 자동 반영되지 않습니다)' : ''}.\n지금 스크랩 검토 화면으로 이동할까요?`,
      )
      if (goReview) openTab({ id: 'migration-dashboard', type: 'migration-dashboard', title: '데이터 마이그 목록', icon: '📊', closable: true })
    } finally {
      setRescraping(false)
    }
  }

  /** 그냥 새 탭으로 열면 로그인 쿠키가 없어 로그아웃 상태로 보인다 — 이 몰 전용 로그인 창(예전 로그인
   *  쿠키가 남은 프로필)에 열어 로그인된 상태로 확인할 수 있게 한다. */
  async function handleOpenSourceUrl() {
    if (!data) return
    try {
      const res = await fetch('/api/scrape/open-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: data.site_id, url: data.source_url }),
      })
      if (res.ok) return
    } catch { /* 폴백으로 진행 */ }
    window.open(data.source_url, '_blank', 'noreferrer')
  }

  async function handleMigrate() {
    setMigrating(true)
    try {
      const res = await fetch('/api/master/migrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallProductIds: [mallProductId], clientId: 1 }),
      })
      const d = await res.json() as { masterIds: number[] }
      if (!res.ok || !d.masterIds?.length) throw new Error('가공 실패')
      bumpRefresh('products')
      bumpRefresh('master')
      openTab({ ...MASTER_LIST_TAB, type: 'master-detail', params: { masterId: d.masterIds[0] } })
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setMigrating(false)
    }
  }

  async function handleDelete() {
    if (!confirm('이 상품을 삭제할까요?')) return
    await fetch(`/api/products/${mallProductId}`, { method: 'DELETE' })
    bumpRefresh('products')
    goBack()
  }

  if (loading || !data) return <div className="text-center text-sm text-gray-400 py-12">불러오는 중...</div>

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📦 {data.name_original || `상품 #${data.id}`}</h1>
          <p className="text-xs text-gray-400 mt-1">몰 상품코드: {data.mall_product_code} · 마지막 스크랩: {data.last_scraped_at ? new Date(data.last_scraped_at).toLocaleString() : '-'}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleRescrape} disabled={rescraping}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {rescraping ? '재스크랩 중...' : '🔄 재스크랩'}
          </button>
          {data.master_product_id ? (
            <button onClick={() => openTab({ ...MASTER_LIST_TAB, type: 'master-detail', params: { masterId: data.master_product_id } })}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
              🗂️ 상품마스터 보기
            </button>
          ) : (
            <button onClick={handleMigrate} disabled={migrating}
              className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
              {migrating ? '가공 중...' : '➜ 상품마스터로 가공'}
            </button>
          )}
          <button onClick={handleDelete}
            className="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 text-sm font-semibold rounded-full transition-colors mr-2">
            🗑 삭제
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : '변경사항 저장'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[160px_1fr] gap-6">
        <div>
          <div className="w-full aspect-square relative rounded-2xl overflow-hidden bg-gray-100 border border-gray-200">
            {data.thumbnail_locals?.[0] ? (
              <Image src={data.thumbnail_locals[0]} alt={data.name_original || ''} fill className="object-cover" unoptimized />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">No image</div>
            )}
          </div>
          {data.thumbnail_locals?.length > 1 && (
            <>
              <p className="text-[11px] text-gray-400 mt-2">대표이미지 ({data.thumbnail_locals.length})</p>
              <div className="grid grid-cols-3 gap-1 mt-1">
                {data.thumbnail_locals.slice(1).map((src, i) => (
                  <div key={i} className="aspect-square relative rounded overflow-hidden bg-gray-100">
                    <Image src={src} alt="" fill className="object-cover" unoptimized />
                  </div>
                ))}
              </div>
            </>
          )}
          {data.detail_image_local?.length > 0 && (
            <>
              <p className="text-[11px] text-gray-400 mt-2">상세이미지 ({data.detail_image_local.length})</p>
              <div className="grid grid-cols-3 gap-1 mt-1">
                {data.detail_image_local.slice(0, 6).map((src, i) => (
                  <div key={i} className="aspect-square relative rounded overflow-hidden bg-gray-100">
                    <Image src={src} alt="" fill className="object-cover" unoptimized />
                  </div>
                ))}
              </div>
            </>
          )}
          <button type="button" onClick={handleOpenSourceUrl} className="block mt-2 text-xs text-teal-500 hover:underline truncate text-left">원본 페이지 열기 →</button>
          <div className="mt-2 text-xs">
            재고: {data.stock_status === '품절' || data.stock_status?.startsWith('단종') ? (
              <span className="text-rose-500 font-medium">{data.stock_status}</span>
            ) : (
              <span className="text-emerald-600 font-medium">{data.stock_status || '-'}</span>
            )}
            {data.stock_qty != null && <span className="text-gray-400"> ({data.stock_qty}개)</span>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          {FIELDS.map(f => (
            <label key={f.key} className="block">
              <span className="block text-xs text-gray-500 mb-1">{f.label}</span>
              {f.type === 'textarea' ? (
                <textarea value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))} rows={3}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              ) : (
                <input type={f.type} value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              )}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
