'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { NewClientForm } from './shared/NewClientForm'
import { CLIENTS_LIST_TAB } from '../shell/menuTabs'

interface Client {
  id: number
  name: string
  code: string | null
  business_reg_no: string | null
  business_reg_doc_path: string | null
  representative_name: string | null
  business_type: string | null
  business_item: string | null
  business_address: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  memo: string | null
  created_at: string
}

export function ClientsListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [q, setQ] = useState('')
  const [loadError, setLoadError] = useState(false)

  const load = useCallback((query: string) => {
    fetch(`/api/clients?q=${encodeURIComponent(query)}`).then(r => {
      if (!r.ok) throw new Error()
      return r.json()
    }).then((d: Client[]) => {
      if (Array.isArray(d)) { setClients(d); setLoadError(false) }
    }).catch(() => setLoadError(true))
  }, [])

  useEffect(() => { load(q) }, [load, q, refreshSignals.clients])

  function openDetail(client: Client) {
    openTab({ ...CLIENTS_LIST_TAB, type: 'client-detail', params: { clientId: client.id } })
  }

  async function handleDelete(id: number) {
    if (!confirm('이 거래처를 삭제할까요? (연결된 Mall은 삭제되지 않고, 거래처 연결만 해제됩니다)')) return
    try {
      const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      load(q)
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🏢 거래처 관리</h1>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <div className="flex-[1_1_0%] min-h-0 overflow-y-auto">
          <NewClientForm onCreated={() => load(q)} />
        </div>

        <div className="flex-[2_1_0%] min-h-0 flex flex-col">
          <div className="mb-3 shrink-0">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처명, 사업자번호, 대표자, 담당자, 연락처, 메모 검색..."
              className="w-full max-w-md border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {loadError ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-rose-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
          ) : clients.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-gray-400">등록된 거래처가 없습니다.</div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-auto flex-1 min-h-0">
                <table className="text-xs border-collapse whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-3 py-2 text-left sticky left-0 bg-gray-50 z-20">거래처명</th>
                      <th className="px-3 py-2 text-left">거래처코드</th>
                      <th className="px-3 py-2 text-left">사업자등록번호</th>
                      <th className="px-3 py-2 text-left">사업자등록증</th>
                      <th className="px-3 py-2 text-left">대표자명</th>
                      <th className="px-3 py-2 text-left">업태</th>
                      <th className="px-3 py-2 text-left">종목</th>
                      <th className="px-3 py-2 text-left">사업장주소</th>
                      <th className="px-3 py-2 text-left">담당자명</th>
                      <th className="px-3 py-2 text-left">연락처</th>
                      <th className="px-3 py-2 text-left">이메일</th>
                      <th className="px-3 py-2 text-left">메모</th>
                      <th className="px-3 py-2 text-left">등록일</th>
                      <th className="px-3 py-2 text-left">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map(c => (
                      <tr key={c.id} onClick={() => openDetail(c)} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-3 py-2 text-gray-800 font-medium sticky left-0 bg-white">{c.name}</td>
                        <td className="px-3 py-2 font-mono text-teal-600">{c.code || '-'}</td>
                        <td className="px-3 py-2 text-gray-600">{c.business_reg_no || '-'}</td>
                        <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                          {c.business_reg_doc_path ? (
                            <a href={c.business_reg_doc_path} target="_blank" rel="noreferrer" className="text-teal-500 hover:underline">첨부</a>
                          ) : (
                            <span className="text-gray-300">미첨부</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{c.representative_name || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{c.business_type || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{c.business_item || '-'}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-[220px] truncate" title={c.business_address || ''}>{c.business_address || '-'}</td>
                        <td className="px-3 py-2 text-gray-600">{c.contact_name || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{c.contact_phone || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{c.contact_email || '-'}</td>
                        <td className="px-3 py-2 text-gray-400 max-w-[160px] truncate" title={c.memo || ''}>{c.memo || '-'}</td>
                        <td className="px-3 py-2 text-gray-400">{new Date(c.created_at).toLocaleDateString()}</td>
                        <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                          <button onClick={() => openDetail(c)} className="text-teal-500 hover:underline mr-2">수정</button>
                          <button onClick={() => handleDelete(c.id)} className="text-rose-500 hover:underline">삭제</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
