'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

interface NamingTemplate { id: number; name: string; prompt_template: string; max_length: number; is_default: boolean }
interface MarketplaceConfig { code: string; name: string; max_batch_size: number; default_commission_rate: number; default_shipping_fee: number }
interface Client { id: number; name: string; business_reg_no: string | null; memo: string | null; created_at: string }

export function SettingsPanel() {
  const { openTab } = useTabs()
  const [templates, setTemplates]     = useState<NamingTemplate[]>([])
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplatePrompt, setNewTemplatePrompt] = useState('원본 상품명: {{name}}\n\n오픈마켓 등록용 상품명을 만들어줘.')
  const [configs, setConfigs]         = useState<MarketplaceConfig[]>([])
  const [clients, setClients]         = useState<Client[]>([])

  const load = useCallback(() => {
    fetch('/api/naming-templates').then(r => r.json()).then((d: NamingTemplate[]) => setTemplates(Array.isArray(d) ? d : []))
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: MarketplaceConfig[]) => setConfigs(Array.isArray(d) ? d : []))
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : []))
  }, [])

  useEffect(() => { load() }, [load])

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

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">⚙️ 설정</h1>

      {/* 마켓별 설정 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700">마켓별 설정 (1회 대량등록 한도 / 수수료 / 기본배송비)</h2>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                <th className="px-4 py-2 text-left">마켓명</th>
                <th className="px-4 py-2 text-left">코드</th>
                <th className="px-4 py-2 text-left">한도</th>
                <th className="px-4 py-2 text-left">수수료율</th>
                <th className="px-4 py-2 text-left">기본배송비</th>
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.code} className="border-b border-gray-100">
                  <td className="px-4 py-2 text-gray-700 font-medium">{c.name}</td>
                  <td className="px-4 py-2 text-gray-400 font-mono">{c.code}</td>
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={c.max_batch_size} onBlur={e => updateConfig(c.code, { max_batch_size: Number(e.target.value) })}
                      className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" step={0.01} defaultValue={c.default_commission_rate} onBlur={e => updateConfig(c.code, { default_commission_rate: Number(e.target.value) })}
                      className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={c.default_shipping_fee} onBlur={e => updateConfig(c.code, { default_shipping_fee: Number(e.target.value) })}
                      className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 작명 템플릿 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700">작명 템플릿 ({'{{name}}'} = 원본상품명으로 치환)</h2>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                <th className="px-4 py-2 text-left w-40">이름</th>
                <th className="px-4 py-2 text-left w-20">기본</th>
                <th className="px-4 py-2 text-left w-20">최대길이</th>
                <th className="px-4 py-2 text-left">프롬프트</th>
              </tr>
            </thead>
            <tbody>
              {templates.map(t => (
                <tr key={t.id} className="border-b border-gray-100">
                  <td className="px-4 py-2 text-gray-700 font-medium">{t.name}</td>
                  <td className="px-4 py-2">{t.is_default && <span className="text-teal-500 font-semibold">기본</span>}</td>
                  <td className="px-4 py-2 text-gray-500">{t.max_length}</td>
                  <td className="px-4 py-2 text-gray-400 whitespace-pre-wrap">{t.prompt_template}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-6 space-y-2 border-t border-gray-100">
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
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">공급 거래처</h2>
          <button onClick={() => openTab({ id: 'clients-list', type: 'clients-list', title: '거래처 관리', icon: '🏢', closable: true })}
            className="text-xs text-teal-600 hover:underline">➕ 거래처 관리에서 추가</button>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                <th className="px-4 py-2 text-left">거래처명</th>
                <th className="px-4 py-2 text-left">사업자등록번호</th>
                <th className="px-4 py-2 text-left">메모</th>
                <th className="px-4 py-2 text-left">등록일</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id} className="border-b border-gray-100">
                  <td className="px-4 py-2 text-gray-700 font-medium">{c.name}</td>
                  <td className="px-4 py-2 text-gray-500">{c.business_reg_no || '-'}</td>
                  <td className="px-4 py-2 text-gray-400">{c.memo || '-'}</td>
                  <td className="px-4 py-2 text-gray-400">{new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
