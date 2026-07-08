'use client'
import { useEffect, useState, useCallback } from 'react'

interface NamingTemplate { id: number; name: string; prompt_template: string; max_length: number; is_default: boolean }
interface MarketplaceConfig { code: string; name: string; max_batch_size: number; default_commission_rate: number; default_shipping_fee: number }
interface Client { id: number; name: string; memo: string | null }

export function SettingsPanel() {
  const [baseUrl, setBaseUrl]         = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [templates, setTemplates]     = useState<NamingTemplate[]>([])
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplatePrompt, setNewTemplatePrompt] = useState('원본 상품명: {{name}}\n\n오픈마켓 등록용 상품명을 만들어줘.')
  const [configs, setConfigs]         = useState<MarketplaceConfig[]>([])
  const [clients, setClients]         = useState<Client[]>([])
  const [newClientName, setNewClientName] = useState('')

  const load = useCallback(() => {
    fetch('/api/settings/image-host').then(r => r.json()).then((d: { baseUrl: string }) => { setBaseUrl(d.baseUrl); setBaseUrlInput(d.baseUrl) })
    fetch('/api/naming-templates').then(r => r.json()).then((d: NamingTemplate[]) => setTemplates(Array.isArray(d) ? d : []))
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: MarketplaceConfig[]) => setConfigs(Array.isArray(d) ? d : []))
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : []))
  }, [])

  useEffect(() => { load() }, [load])

  async function saveBaseUrl() {
    await fetch('/api/settings/image-host', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: baseUrlInput }),
    })
    load()
  }

  async function addTemplate() {
    if (!newTemplateName || !newTemplatePrompt) return
    await fetch('/api/naming-templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTemplateName, promptTemplate: newTemplatePrompt }),
    })
    setNewTemplateName('')
    load()
  }

  async function updateConfig(code: string, patch: Partial<MarketplaceConfig>) {
    await fetch('/api/marketplace-configs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        maxBatchSize: patch.max_batch_size,
        defaultCommissionRate: patch.default_commission_rate,
        defaultShippingFee: patch.default_shipping_fee,
      }),
    })
    load()
  }

  async function addClient() {
    if (!newClientName) return
    await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newClientName }) })
    setNewClientName('')
    load()
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">⚙️ 설정</h1>

      {/* 이미지 호스팅 base URL — 일괄 편집 도구 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">이미지 호스팅 base URL</h2>
        <p className="text-xs text-gray-400 mb-3">
          여기서 값을 바꾸면 모든 상품 이미지 URL이 즉시 새 도메인 기준으로 조립됩니다 (개별 상품/이미지 수정 불필요). 현재값: <code className="text-gray-600">{baseUrl || '(비어있음 — 상대경로 그대로 사용)'}</code>
        </p>
        <div className="flex gap-2">
          <label className="flex-1 block">
            <span className="sr-only">이미지 호스팅 base URL</span>
            <input value={baseUrlInput} onChange={e => setBaseUrlInput(e.target.value)} placeholder="https://cdn.example.com"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <button onClick={saveBaseUrl} className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">저장</button>
        </div>
      </div>

      {/* 마켓별 설정 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700">마켓별 설정 (1회 대량등록 한도 / 수수료 / 기본배송비)</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {configs.map(c => (
            <div key={c.code} className="flex items-center gap-3 px-6 py-3">
              <div className="w-32 text-sm text-gray-700 font-medium shrink-0">{c.name}</div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                한도
                <input type="number" defaultValue={c.max_batch_size} onBlur={e => updateConfig(c.code, { max_batch_size: Number(e.target.value) })}
                  className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                수수료율
                <input type="number" step={0.01} defaultValue={c.default_commission_rate} onBlur={e => updateConfig(c.code, { default_commission_rate: Number(e.target.value) })}
                  className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                기본배송비
                <input type="number" defaultValue={c.default_shipping_fee} onBlur={e => updateConfig(c.code, { default_shipping_fee: Number(e.target.value) })}
                  className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* 작명 템플릿 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">작명 템플릿 ({'{{name}}'} = 원본상품명으로 치환)</h2>
        <div className="divide-y divide-gray-100 mb-4">
          {templates.map(t => (
            <div key={t.id} className="py-2">
              <div className="text-sm text-gray-700 font-medium">{t.name} {t.is_default && <span className="text-teal-500 text-xs">(기본)</span>}</div>
              <div className="text-xs text-gray-400 whitespace-pre-wrap">{t.prompt_template}</div>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <label className="block">
            <span className="sr-only">템플릿 이름</span>
            <input value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)} placeholder="템플릿 이름"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="sr-only">작명 프롬프트</span>
            <textarea value={newTemplatePrompt} onChange={e => setNewTemplatePrompt(e.target.value)} rows={3}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <button onClick={addTemplate} className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">템플릿 추가</button>
        </div>
      </div>

      {/* 공급 거래처 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">공급 거래처</h2>
        <div className="divide-y divide-gray-100 mb-3">
          {clients.map(c => (
            <div key={c.id} className="py-2 text-sm text-gray-700">{c.name} {c.memo && <span className="text-gray-400 text-xs">— {c.memo}</span>}</div>
          ))}
        </div>
        <div className="flex gap-2">
          <label className="flex-1 block">
            <span className="sr-only">거래처명</span>
            <input value={newClientName} onChange={e => setNewClientName(e.target.value)} placeholder="거래처명"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <button onClick={addClient} className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">추가</button>
        </div>
      </div>
    </div>
  )
}
