'use client'
import { useCallback, useEffect, useState } from 'react'

interface MemoEntry { id: number; memo_at: string; content: string }

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toLocalInputValue(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDisplay(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MemoLog({ baseUrl }: { baseUrl: string }) {
  const [memos, setMemos] = useState<MemoEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editAt, setEditAt] = useState('')
  const [editContent, setEditContent] = useState('')

  const load = useCallback(() => {
    fetch(baseUrl).then(r => r.json()).then((d: MemoEntry[]) => { if (Array.isArray(d)) setMemos(d) }).finally(() => setLoading(false))
  }, [baseUrl])

  useEffect(() => { load() }, [load])

  async function addMemo() {
    if (!newContent.trim()) return
    await fetch(baseUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    })
    setNewContent('')
    load()
  }

  function startEdit(m: MemoEntry) {
    setEditingId(m.id)
    setEditAt(toLocalInputValue(new Date(m.memo_at)))
    setEditContent(m.content)
  }

  async function saveEdit(id: number) {
    await fetch(`${baseUrl}/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoAt: new Date(editAt).toISOString(), content: editContent }),
    })
    setEditingId(null)
    load()
  }

  async function deleteMemo(id: number) {
    if (!confirm('이 메모를 삭제할까요?')) return
    await fetch(`${baseUrl}/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">일자별 메모</h2>
      <div className="flex gap-2 mb-4">
        <input value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="메모 내용"
          onKeyDown={e => e.key === 'Enter' && addMemo()}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
        <button onClick={addMemo} className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full transition-colors shrink-0">
          추가
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-gray-400">불러오는 중...</p>
      ) : memos.length === 0 ? (
        <p className="text-xs text-gray-400">등록된 메모가 없습니다.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                <th className="px-3 py-2 text-left w-36">일시</th>
                <th className="px-3 py-2 text-left">내용</th>
                <th className="px-3 py-2 text-left">관리</th>
              </tr>
            </thead>
            <tbody>
              {memos.map(m => (
                <tr key={m.id} className="border-b border-gray-100 last:border-0">
                  {editingId === m.id ? (
                    <>
                      <td className="px-3 py-2">
                        <input type="datetime-local" value={editAt} onChange={e => setEditAt(e.target.value)}
                          className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
                      </td>
                      <td className="px-3 py-2">
                        <input value={editContent} onChange={e => setEditContent(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button onClick={() => saveEdit(m.id)} className="text-teal-600 hover:underline mr-2">저장</button>
                        <button onClick={() => setEditingId(null)} className="text-gray-400 hover:underline">취소</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{formatDisplay(m.memo_at)}</td>
                      <td className="px-3 py-2 text-gray-700 whitespace-pre-wrap">{m.content}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button onClick={() => startEdit(m)} className="text-teal-500 hover:underline mr-2">수정</button>
                        <button onClick={() => deleteMemo(m.id)} className="text-rose-500 hover:underline">삭제</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
