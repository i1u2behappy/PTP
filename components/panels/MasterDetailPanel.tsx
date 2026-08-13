'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'

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
  internal_code: string | null
  sales_code: string | null
  custom_fields: Record<string, string> | null
  thumbnail_locals: string[]
  detail_image_local: string[]
}

interface NamingTemplate { id: number; name: string; is_default: boolean }
interface FieldValue { value: string; count: string }
interface MarketplaceConfig { code: string; name: string; default_commission_rate: number; default_shipping_fee: number }
interface ChannelRow { marketplace_code: string; marketplace_name: string; channel_name: string | null; channel_url: string | null }
interface HistoryRow { stock_status: string | null; stock_qty: number | null; price: number | null; sale_price: number | null; captured_at: string }

/** 텍스트류 고정 필드의 입력 형태(텍스트/여러 줄/자동완성 목록) — 라벨은 항상 registryLabels(기준
 *  마스터테이블에서 사용자가 바꿔둔 값)를 우선하고, 이 기본값은 로딩 전/미등록 시 폴백일 뿐이다. */
const TEXT_FIELD_CONFIG: Record<string, { label: string; type: 'text' | 'textarea'; listId?: string }> = {
  name_final: { label: '최종 상품명', type: 'text' },
  master_category: { label: '카테고리', type: 'text', listId: 'category-options' },
  brand: { label: '브랜드', type: 'text', listId: 'brand-options' },
  manufacturer: { label: '제조사', type: 'text' },
  origin: { label: '원산지', type: 'text' },
  description: { label: '설명', type: 'textarea' },
}
const DEFAULT_FIELD_LABEL = new Map(FIXED_FIELD_INFO.map(f => [f.key, f.label]))
const NUMBER_FIELD_KEYS = ['cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost']
const COVERED_KEYS = new Set<string>([...Object.keys(TEXT_FIELD_CONFIG), ...NUMBER_FIELD_KEYS])
const NUMERIC_EXTRA_KEYS = new Set(['stock_qty'])

export function MasterDetailPanel({ params }: { params?: Record<string, unknown> }) {
  const { openDetailModal, closeDetailModal, bumpRefresh } = useTabs()
  const { keys: registeredKeys, customKeys: registeredCustomKeys, labels: registryLabels } = useRegisteredFieldKeys()
  const masterId = params?.masterId as number
  // 기준 마스터테이블관리에 등록된 필드 중, 위 TEXT_FIELDS/NUMBER_FIELDS로 이미 다루지 않는 것들 — 다른
  // 화면(스크랩 검토 그리드 등)과 마찬가지로 이 화면도 기준 테이블을 그대로 따라가도록, 등록된 필드는
  // 빠짐없이 여기서 보고 수정할 수 있어야 한다(등록만 해두고 관리할 곳이 없는 컬럼이 없도록).
  // 고정 컬럼(재고상태/재고수량/몰상품코드/판매관리코드 등)은 product_master 전용 컬럼에, 나머지
  // 커스텀 필드(옵션/이미지/기타)는 custom_fields JSONB에 저장된다.
  const extraFixedKeys = useMemo(
    () => Array.from(registeredKeys).filter(k => !COVERED_KEYS.has(k) && !registeredCustomKeys.has(k)),
    [registeredKeys, registeredCustomKeys],
  )
  const customFieldKeys = useMemo(() => Array.from(registeredCustomKeys), [registeredCustomKeys])
  // 필드를 어떤 순서로 보여줄지도 기준 마스터테이블관리(master_schema_fields)의 sort_order를 그대로
  // 따라간다 — 고정/커스텀 구분 없이 등록된 순서대로 섞여 나온다. 등록 안 된 필드(other_cost 등)만
  // 정렬 기준이 없어 맨 뒤로 밀린다.
  const orderedFieldKeys = useMemo(() => {
    const all = [...Object.keys(TEXT_FIELD_CONFIG), ...NUMBER_FIELD_KEYS, ...extraFixedKeys, ...customFieldKeys]
    const order = Array.from(registryLabels.keys())
    return all.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
  }, [registryLabels, extraFixedKeys, customFieldKeys])

  function backToList() { closeDetailModal() }
  function openProductDetail(mallProductId: number) {
    openDetailModal('product-detail', { mallProductId })
  }
  const [data, setData] = useState<MasterDetail | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [customForm, setCustomForm] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<NamingTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [aiLoading, setAiLoading] = useState(false)
  const [targetMarginPct, setTargetMarginPct] = useState('')
  const [brandOptions, setBrandOptions] = useState<FieldValue[]>([])
  const [categoryOptions, setCategoryOptions] = useState<FieldValue[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceConfig[]>([])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [channelForm, setChannelForm] = useState<Record<string, { channel_name: string; channel_url: string }>>({})
  const [history, setHistory] = useState<HistoryRow[]>([])

  const load = useCallback(() => {
    fetch(`/api/master/${masterId}`).then(r => r.json()).then((d: MasterDetail & { target_margin_rate: number | null }) => {
      setData(d)
      const dAny = d as unknown as Record<string, unknown>
      setForm({
        ...Object.fromEntries(Object.keys(TEXT_FIELD_CONFIG).map(k => [k, (dAny[k] as string) ?? ''])),
        ...Object.fromEntries(NUMBER_FIELD_KEYS.map(k => [k, dAny[k] == null ? '' : String(dAny[k])])),
        ...Object.fromEntries(extraFixedKeys.map(k => [k, dAny[k] == null ? '' : String(dAny[k])])),
      })
      setCustomForm(Object.fromEntries(customFieldKeys.map(k => [k, d.custom_fields?.[k] ?? ''])))
      setTargetMarginPct(d.target_margin_rate == null ? '' : String(Math.round(d.target_margin_rate * 100)))
    }).finally(() => setLoading(false))
  }, [masterId, extraFixedKeys, customFieldKeys])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/naming-templates').then(r => r.json()).then((d: NamingTemplate[]) => {
      setTemplates(Array.isArray(d) ? d : [])
      const def = d.find(t => t.is_default)
      if (def) setTemplateId(def.id)
    }).catch(() => {})
    fetch('/api/master/field-values?field=brand').then(r => r.json()).then((d: FieldValue[]) => setBrandOptions(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/master/field-values?field=master_category').then(r => r.json()).then((d: FieldValue[]) => setCategoryOptions(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: MarketplaceConfig[]) => setMarketplaces(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  useEffect(() => {
    fetch(`/api/master/${masterId}/channels`).then(r => r.json()).then((d: ChannelRow[]) => {
      setChannels(Array.isArray(d) ? d : [])
      setChannelForm(Object.fromEntries((d || []).map(ch => [ch.marketplace_code, { channel_name: ch.channel_name || '', channel_url: ch.channel_url || '' }])))
    }).catch(() => {})
    fetch(`/api/master/${masterId}/history`).then(r => r.json()).then((d: HistoryRow[]) => setHistory(Array.isArray(d) ? d : [])).catch(() => {})
  }, [masterId])

  const margin = data && form.sale_price !== '' ? Number(form.sale_price || 0) - Number(form.cost_price || 0) - Number(form.other_cost || 0) : null

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      for (const key of Object.keys(TEXT_FIELD_CONFIG)) body[key] = form[key]
      for (const key of NUMBER_FIELD_KEYS) body[key] = form[key].trim() === '' ? null : Number(form[key])
      for (const k of extraFixedKeys) body[k] = NUMERIC_EXTRA_KEYS.has(k) ? (form[k]?.trim() === '' ? null : Number(form[k])) : (form[k] ?? '')
      if (customFieldKeys.length) body.custom_fields = Object.fromEntries(customFieldKeys.map(k => [k, customForm[k] ?? '']))
      body.target_margin_rate = targetMarginPct.trim() === '' ? null : Number(targetMarginPct) / 100
      await fetch(`/api/master/${masterId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      bumpRefresh('master')
      load()
    } finally {
      setSaving(false)
    }
  }

  function applyTargetMargin() {
    const rate = Number(targetMarginPct) / 100
    if (!targetMarginPct || rate <= 0 || rate >= 1) return
    const cost = Number(form.cost_price || 0) + Number(form.other_cost || 0)
    const salePrice = Math.round(cost / (1 - rate))
    setForm(v => ({ ...v, sale_price: String(salePrice) }))
  }

  async function saveChannel(marketplaceCode: string) {
    const ch = channelForm[marketplaceCode]
    if (!ch) return
    await fetch(`/api/master/${masterId}/channels`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplaceCode, channelName: ch.channel_name, channelUrl: ch.channel_url }),
    })
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
    backToList()
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
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={backToList} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
            ← 목록
          </button>
          {data.mall_product_id && (
            <button onClick={() => openProductDetail(data.mall_product_id!)}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
              📦 원본 보기
            </button>
          )}
          {data.status !== 'ready' && (
            <button onClick={handleMarkReady} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-full transition-colors">
              ✅ 확정
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
              <Image src={data.thumbnail_locals[0]} alt="" fill className="object-cover" unoptimized />
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
          <div className="mt-3 bg-white border border-gray-200 rounded-xl p-3">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">AI 작명 템플릿</span>
              <select value={templateId} onChange={e => setTemplateId(e.target.value ? Number(e.target.value) : '')}
                className="w-full border border-gray-300 rounded-xl px-2 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-teal-400">
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (기본)' : ''}</option>)}
              </select>
            </label>
            <button onClick={handleGenAiName} disabled={aiLoading}
              className="w-full py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
              {aiLoading ? '생성 중...' : '✨ AI 상품명 생성'}
            </button>
            {data.name_ai && <p className="text-[11px] text-teal-500 mt-2 truncate">AI: {data.name_ai}</p>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {orderedFieldKeys.map(key => {
              const textConfig = TEXT_FIELD_CONFIG[key]
              const isCustom = customFieldKeys.includes(key)
              const isNumber = NUMBER_FIELD_KEYS.includes(key) || (!textConfig && !isCustom && NUMERIC_EXTRA_KEYS.has(key))
              const label = registryLabels.get(key) ?? textConfig?.label ?? DEFAULT_FIELD_LABEL.get(key) ?? key
              const value = isCustom ? (customForm[key] ?? '') : (form[key] ?? '')
              const onChange = (v: string) => isCustom ? setCustomForm(m => ({ ...m, [key]: v })) : setForm(m => ({ ...m, [key]: v }))
              return (
                <label key={key} className={`block ${textConfig?.type === 'textarea' ? 'col-span-2' : ''}`}>
                  <span className="block text-xs text-gray-500 mb-1">{label}</span>
                  {textConfig?.type === 'textarea' ? (
                    <textarea value={value} onChange={e => onChange(e.target.value)} rows={3}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  ) : (
                    <input type={isNumber ? 'number' : 'text'} value={value} onChange={e => onChange(e.target.value)} list={textConfig?.listId}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  )}
                </label>
              )
            })}
          </div>
          <datalist id="brand-options">{brandOptions.map(o => <option key={o.value} value={o.value} />)}</datalist>
          <datalist id="category-options">{categoryOptions.map(o => <option key={o.value} value={o.value} />)}</datalist>

          <div className="text-sm text-gray-600">
            예상 마진 (수수료 제외): {margin == null ? '-' : <span className={`font-semibold ${margin >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>₩{margin.toLocaleString()}</span>}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
              목표 마진율
              <input type="number" value={targetMarginPct} onChange={e => setTargetMarginPct(e.target.value)} placeholder="예: 30"
                className="w-16 border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
              %
            </label>
            <button onClick={applyTargetMargin} type="button"
              className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors">
              이 마진율로 판매가 계산
            </button>
          </div>

          {marketplaces.length > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs text-gray-500 mb-2">마켓별 예상 마진 (입력 중인 판매가 기준)</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-400 text-left">
                      <th className="py-1 pr-2 sticky left-0 z-10 bg-white">마켓</th>
                      <th className="py-1 pr-2">수수료</th>
                      <th className="py-1 pr-2">공급가</th>
                      <th className="py-1 pr-2">마진</th>
                      <th className="py-1">마진율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {marketplaces.map(mc => {
                      const salePrice = Number(form.sale_price || 0)
                      const commissionAmount = Math.round(salePrice * (mc.default_commission_rate || 0))
                      const supplyPrice = salePrice - commissionAmount
                      const marginAmount = salePrice - Number(form.cost_price || 0) - commissionAmount - Number(form.other_cost || 0)
                      const marginRate = salePrice > 0 ? (marginAmount / salePrice) * 100 : 0
                      return (
                        <tr key={mc.code} className="border-t border-gray-100">
                          <td className="py-1.5 pr-2 text-gray-700 sticky left-0 z-[1] bg-white">{mc.name}</td>
                          <td className="py-1.5 pr-2 text-gray-500">₩{commissionAmount.toLocaleString()} ({Math.round((mc.default_commission_rate || 0) * 100)}%)</td>
                          <td className="py-1.5 pr-2 text-gray-500">₩{supplyPrice.toLocaleString()}</td>
                          <td className={`py-1.5 pr-2 font-medium ${marginAmount >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>₩{marginAmount.toLocaleString()}</td>
                          <td className={marginAmount >= 0 ? 'text-emerald-600' : 'text-rose-500'}>{marginRate.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-700 mb-3">채널별 등록정보</p>
          <div className="space-y-2">
            {channels.map(ch => (
              <div key={ch.marketplace_code} className="border border-gray-100 rounded-xl p-2.5">
                <p className="text-xs font-medium text-gray-600 mb-1.5">{ch.marketplace_name}</p>
                <input value={channelForm[ch.marketplace_code]?.channel_name ?? ''} placeholder="채널 등록용 상품명"
                  onChange={e => setChannelForm(v => ({ ...v, [ch.marketplace_code]: { ...v[ch.marketplace_code], channel_name: e.target.value } }))}
                  onBlur={() => saveChannel(ch.marketplace_code)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs mb-1 focus:outline-none focus:ring-1 focus:ring-teal-300" />
                <input value={channelForm[ch.marketplace_code]?.channel_url ?? ''} placeholder="채널 등록 URL"
                  onChange={e => setChannelForm(v => ({ ...v, [ch.marketplace_code]: { ...v[ch.marketplace_code], channel_url: e.target.value } }))}
                  onBlur={() => saveChannel(ch.marketplace_code)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-700 mb-3">가격/재고 변경 이력</p>
          {history.length === 0 ? (
            <p className="text-xs text-gray-300">이력 없음</p>
          ) : (
            <div className="overflow-y-auto max-h-64">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="py-1 pr-2 sticky left-0 z-10 bg-white">일시</th>
                    <th className="py-1 pr-2">판매가</th>
                    <th className="py-1">재고</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="py-1.5 pr-2 text-gray-500 sticky left-0 z-[1] bg-white">{new Date(h.captured_at).toLocaleString()}</td>
                      <td className="py-1.5 pr-2 text-gray-700">{h.sale_price ? `₩${h.sale_price.toLocaleString()}` : '-'}</td>
                      <td className="py-1.5 text-gray-500">{h.stock_status || '-'}{h.stock_qty != null && ` (${h.stock_qty})`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
