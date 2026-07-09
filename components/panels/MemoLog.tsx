'use client'
import { useCallback, useEffect, useState } from 'react'

interface MemoEntry { id: number; memo_date: string; content: string }

export function MemoLog({ baseUrl }: { baseUrl: string }) {
  const [memos, setMemos] = useState<MemoEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [newDate, setNewDate] = useState('')
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editContent, setEditContent] = useState('')

  const load = useCallback(() => {
    fetch(baseUrl).then(r => r.json()).then((d: MemoEntry[]) => { if (Array.isArray(d)) setMemos(d) }).finally(() => setLoading(false))
  }, [baseUrl])

  useEffect(() => { load() }, [load])

  async function addMemo() {
    if (!newContent.trim()) return
    await fetch(baseUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoDate: newDate || undefined, content: newContent }),
    })
    setNewDate('')
    setNewContent('')
    load()
  }

  function startEdit(m: MemoEntry) {
    setEditingId(m.id)
    setEditDate(m.memo_date)
    setEditContent(m.content)
  }

  async function saveEdit(id: number) {
    await fetch(`${baseUrl}/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoDate: editDate, content: editContent }),
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
        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
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
        <div className="divide-y divide-gray-100">
          {memos.map(m => (
            <div key={m.id} className="py-2">
              {editingId === m.id ? (
                <div className="flex gap-2 items-center">
                  <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                    className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  <input value={editContent} onChange={e => setEditContent(e.target.value)}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
                  <button onClick={() => saveEdit(m.id)} className="text-xs text-teal-600 hover:underline shrink-0">저장</button>
                  <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:underline shrink-0">취소</button>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="text-xs text-gray-400 shrink-0 w-24">{m.memo_date}</div>
                  <div className="flex-1 text-sm text-gray-700 whitespace-pre-wrap">{m.content}</div>
                  <button onClick={() => startEdit(m)} className="text-xs text-teal-500 hover:underline shrink-0">수정</button>
                  <button onClick={() => deleteMemo(m.id)} className="text-xs text-rose-500 hover:underline shrink-0">삭제</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
