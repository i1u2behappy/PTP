'use client'
import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'

interface MasterDetail {
  id: number
  mall_product_id: number | null
  source_url: string | null
  mall_product_code: string | null
  name_original: string
  name_ai: string | null
  name_final: string | null
  mall_category: string
  master_category: string
  brand: string
  manufacturer: string
  origin: string
  description: string
  cost_price: number | null
  list_price: number | null
  sale_price: number | null
  shipping_fee: number | null
  other_cost: number | null
  status: string
  stock_status: string | null
  stock_qty: number | null
  thumbnail_local: string | null
  detail_image_local: string[]
}

interface NamingTemplate { id: number; name: string; is_default: boolean }

const TEXT_FIELDS: { key: 'name_final' | 'master_category' | 'brand' | 'manufacturer' | 'origin' | 'description'; label: string; type: 'text' | 'textarea' }[] = [
  { key: 'name_final', label: '최종 상품명', type: 'text' },
  { key: 'master_category', label: '카테고리', type: 'text' },
  { key: 'brand', label: '브랜드', type: 'text' },
  { key: 'manufacturer', label: '제조사', type: 'text' },
  { key: 'origin', label: '원산지', type: 'text' },
  { key: 'description', label: '설명', type: 'textarea' },
]
const NUMBER_FIELDS: { key: 'cost_price' | 'list_price' | 'sale_price' | 'shipping_fee' | 'other_cost'; label: string }[] = [
  { key: 'cost_price', label: '매입가' },
  { key: 'list_price', label: '소비자가' },
  { key: 'sale_price', label: '판매가' },
  { key: 'shipping_fee', label: '배송비' },
  { key: 'other_cost', label: '기타비용' },
]

export function MasterDetailPanel({ tabId, params }: { tabId: string; params?: Record<string, unknown> }) {
  const { openTab, closeTab, bumpRefresh } = useTabs()
  const masterId = params?.masterId as number
  const [data, setData] = useState<MasterDetail | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<NamingTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [aiLoading, setAiLoading] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/master/${masterId}`).then(r => r.json()).then((d: MasterDetail) => {
      setData(d)
      setForm({
        ...Object.fromEntries(TEXT_FIELDS.map(f => [f.key, (d[f.key] as string) ?? ''])),
        ...Object.fromEntries(NUMBER_FIELDS.map(f => [f.key, d[f.key] == null ? '' : String(d[f.key])])),
      })
    }).finally(() => setLoading(false))
  }, [masterId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/naming-templates').then(r => r.json()).then((d: NamingTemplate[]) => {
      setTemplates(Array.isArray(d) ? d : [])
      const def = d.find(t => t.is_default)
      if (def) setTemplateId(def.id)
    }).catch(() => {})
  }, [])

  const margin = data && form.sale_price !== '' ? Number(form.sale_price || 0) - Number(form.cost_price || 0) - Number(form.other_cost || 0) : null

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      for (const f of TEXT_FIELDS) body[f.key] = form[f.key]
      for (const f of NUMBER_FIELDS) body[f.key] = form[f.key].trim() === '' ? null : Number(form[f.key])
      await fetch(`/api/master/${masterId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      bumpRefresh('master')
      load()
    } finally {
      setSaving(false)
    }
  }

  async function handleGenAiName() {
    setAiLoading(true)
    try {
      const res = await fetch(`/api/master/${masterId}/ai-name`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(templateId ? { templateId } : {}),
      })
      const d = await res.json() as { name_ai: string }
      setData(v => v ? { ...v, name_ai: d.name_ai } : v)
      bumpRefresh('master')
    } finally {
      setAiLoading(false)
    }
  }

  async function handleMarkReady() {
    await fetch(`/api/master/${masterId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ready' }) })
    bumpRefresh('master')
    load()
  }

  async function handleDelete() {
    if (!confirm('이 상품마스터를 삭제할까요? (원천 스크랩 데이터는 유지됩니다)')) return
    await fetch(`/api/master/${masterId}`, { method: 'DELETE' })
    bumpRefresh('master')
    closeTab(tabId)
  }

  if (loading || !data) return <div className="text-center text-sm text-gray-400 py-12">불러오는 중...</div>

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🗂️ {data.name_final || data.name_ai || data.name_original}</h1>
          <p className="text-xs text-gray-400 mt-1">
            몰 상품코드: {data.mall_product_code || '-'} ·{' '}
            {data.status === 'ready' ? <span className="text-emerald-600 font-medium">확정됨</span> : <span>{data.status}</span>}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {data.mall_product_id && (
            <button onClick={() => openTab({ id: `product-detail:${data.mall_product_id}`, type: 'product-detail', title: data.name_original?.slice(0, 12) || '원본상품', icon: '📦', params: { mallProductId: data.mall_product_id }, closable: true })}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors">
              📦 원본 보기
            </button>
          )}
          {data.status !== 'ready' && (
            <button onClick={handleMarkReady} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors">
              ✅ 확정
            </button>
          )}
          <button onClick={handleDelete} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-xs font-semibold rounded-lg transition-colors">
            🗑 삭제
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[160px_1fr] gap-6">
        <div>
          <div className="w-full aspect-square relative rounded-xl overflow-hidden bg-gray-100 border border-gray-200">
            {data.thumbnail_local ? (
              <Image src={data.thumbnail_local} alt="" fill className="object-cover" unoptimized />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">No image</div>
            )}
          </div>
          {data.detail_image_local?.length > 0 && (
            <div className="grid grid-cols-3 gap-1 mt-2">
              {data.detail_image_local.slice(0, 6).map((src, i) => (
                <div key={i} className="aspect-square relative rounded overflow-hidden bg-gray-100">
                  <Image src={src} alt="" fill className="object-cover" unoptimized />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 bg-white border border-gray-200 rounded-lg p-3">
            <label className="block text-xs text-gray-500 mb-1">AI 작명 템플릿</label>
            <select value={templateId} onChange={e => setTemplateId(e.target.value ? Number(e.target.value) : '')}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-400">
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (기본)' : ''}</option>)}
            </select>
            <button onClick={handleGenAiName} disabled={aiLoading}
              className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors">
              {aiLoading ? '생성 중...' : '✨ AI 상품명 생성'}
            </button>
            {data.name_ai && <p className="text-[11px] text-indigo-600 mt-2 truncate">AI: {data.name_ai}</p>}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          {TEXT_FIELDS.map(f => (
            <div key={f.key}>
              <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
              {f.type === 'textarea' ? (
                <textarea value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))} rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              ) : (
                <input value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              )}
            </div>
          ))}

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-100">
            {NUMBER_FIELDS.map(f => (
              <div key={f.key}>
                <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                <input type="number" value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              </div>
            ))}
          </div>

          <div className="text-sm text-gray-600">
            예상 마진: {margin == null ? '-' : <span className={`font-semibold ${margin >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>₩{margin.toLocaleString()}</span>}
          </div>

          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : '변경사항 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
