'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Client {
  id: number
  name: string
  business_reg_no: string | null
  representative_name: string | null
  contact_name: string | null
  contact_phone: string | null
}

export function ClientsListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(() => {
    fetch('/api/clients').then(r => {
      if (!r.ok) throw new Error()
      return r.json()
    }).then((d: Client[]) => {
      if (Array.isArray(d)) { setClients(d); setLoadError(false) }
    }).catch(() => setLoadError(true))
  }, [])

  useEffect(() => { load() }, [load, refreshSignals.clients])

  function openDetail(client?: Client) {
    openTab(client
      ? { id: `client-detail:${client.id}`, type: 'client-detail', title: client.name, icon: '🏢', params: { clientId: client.id }, closable: true }
      : { id: 'client-detail:new', type: 'client-detail', title: '새 거래처 등록', icon: '➕', closable: true },
    )
  }

  async function handleDelete(id: number) {
    if (!confirm('이 거래처를 삭제할까요? (연결된 Mall은 삭제되지 않고, 거래처 연결만 해제됩니다)')) return
    try {
      const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      load()
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🏢 거래처 관리</h1>
        <button onClick={() => openDetail()}
          className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">
          ➕ 새 거래처 등록
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {loadError ? (
          <div className="p-8 text-center text-sm text-rose-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
        ) : clients.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">등록된 거래처가 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {clients.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                <button onClick={() => openDetail(c)} className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium text-gray-800">{c.name}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {c.business_reg_no && `사업자번호 ${c.business_reg_no}`}
                    {c.representative_name && ` · 대표 ${c.representative_name}`}
                  </div>
                  {(c.contact_name || c.contact_phone) && (
                    <div className="text-xs text-gray-400">담당 {c.contact_name} {c.contact_phone}</div>
                  )}
                </button>
                <button onClick={() => openDetail(c)} className="text-xs text-teal-500 hover:underline shrink-0">수정</button>
                <button onClick={() => handleDelete(c.id)} className="text-xs text-rose-500 hover:underline shrink-0">삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
