'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface CategoryNode {
  id: number
  parentId: number | null
  name: string
  depth: number
  sortOrder: number
  productCount: number
}

interface SplitCandidate {
  id: number
  name: string
  segments: string[]
}

/** master_categories(계층 트리)를 직접 보고/고치는 화면. 평문 카테고리 하나였던 PTP 상품마스터 분류를
 *  계층형으로 바꾸는 재설계(!specifications/product-master-architecture-redesign.md §2.1)의 짝 화면 —
 *  마이그레이션 백필은 전부 "루트 노드"로만 만들어두므로, 실제 계층화(상/하위로 재배치)는 여기서 사람이
 *  진행한다. "카테고리 매핑"(master_category × 마켓)과 달리 세션/거래처 스코프가 없다 — 이 트리는 시스템
 *  전체가 공유하는 단일 기준이라 global(카테고리 매핑 화면도 같은 전제로 동작 중).
 */
export function CategoryTreePanel() {
  const [nodes, setNodes] = useState<CategoryNode[]>([])
  const [candidates, setCandidates] = useState<SplitCandidate[]>([])
  const [selectedCandidates, setSelectedCandidates] = useState<Set<number>>(new Set())
  const [applyingCandidates, setApplyingCandidates] = useState(false)
  const [newRootName, setNewRootName] = useState('')
  const [addingChildTo, setAddingChildTo] = useState<number | null>(null)
  const [newChildName, setNewChildName] = useState('')
  const [error, setError] = useState('')

  const loadTree = useCallback(() => {
    fetch('/api/master/categories').then(r => r.json()).then((d: CategoryNode[]) => setNodes(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const loadCandidates = useCallback(() => {
    fetch('/api/master/categories/auto-split').then(r => r.json()).then((d: SplitCandidate[]) => {
      if (!Array.isArray(d)) return
      setCandidates(d)
      setSelectedCandidates(new Set(d.map(c => c.id)))
    }).catch(() => {})
  }, [])

  useEffect(() => { loadTree(); loadCandidates() }, [loadTree, loadCandidates])

  const childrenByParent = useMemo(() => {
    const map = new Map<number | null, CategoryNode[]>()
    for (const n of nodes) {
      const key = n.parentId
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(n)
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    return map
  }, [nodes])

  async function applyCandidates() {
    if (!selectedCandidates.size) return
    setApplyingCandidates(true)
    setError('')
    try {
      const res = await fetch('/api/master/categories/auto-split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedCandidates] }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '적용 실패'); return }
      if (data.failed?.length) setError(`${data.failed.length}건 실패: ${data.failed.map((f: { error: string }) => f.error).join(', ')}`)
      loadTree()
      loadCandidates()
    } finally {
      setApplyingCandidates(false)
    }
  }

  async function addRoot() {
    if (!newRootName.trim()) return
    const res = await fetch('/api/master/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newRootName.trim(), parentId: null }),
    })
    if (!res.ok) { setError((await res.json()).error || '추가 실패'); return }
    setNewRootName('')
    loadTree()
  }

  async function addChild(parentId: number) {
    if (!newChildName.trim()) return
    const res = await fetch('/api/master/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newChildName.trim(), parentId }),
    })
    if (!res.ok) { setError((await res.json()).error || '추가 실패'); return }
    setNewChildName('')
    setAddingChildTo(null)
    loadTree()
  }

  async function renameNode(id: number, name: string) {
    const res = await fetch(`/api/master/categories/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    })
    if (!res.ok) { setError((await res.json()).error || '이름변경 실패'); loadTree(); return }
  }

  async function moveNode(id: number, parentId: number | null) {
    const res = await fetch(`/api/master/categories/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId }),
    })
    if (!res.ok) { setError((await res.json()).error || '이동 실패') }
    loadTree()
  }

  async function deleteNode(id: number) {
    if (!window.confirm('이 카테고리를 삭제할까요? (하위 카테고리도 함께 삭제됩니다)')) return
    const res = await fetch(`/api/master/categories/${id}`, { method: 'DELETE' })
    if (!res.ok) { setError((await res.json()).error || '삭제 실패'); return }
    loadTree()
  }

  function renderNode(node: CategoryNode): React.ReactNode {
    const children = childrenByParent.get(node.id) || []
    return (
      <div key={node.id}>
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 last:border-0 hover:bg-gray-50"
          style={{ paddingLeft: `${12 + node.depth * 20}px` }}>
          <input
            defaultValue={node.name}
            onBlur={e => { if (e.target.value.trim() && e.target.value !== node.name) renameNode(node.id, e.target.value.trim()) }}
            className="flex-1 min-w-0 border border-transparent hover:border-gray-200 focus:border-teal-300 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-teal-300"
          />
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-600">{node.productCount}개 상품</span>
          <select
            value={node.parentId ?? ''}
            onChange={e => moveNode(node.id, e.target.value === '' ? null : Number(e.target.value))}
            className="shrink-0 border border-gray-200 rounded px-1.5 py-0.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-teal-300"
          >
            <option value="">(최상위)</option>
            {nodes.filter(n => n.id !== node.id).map(n => (
              <option key={n.id} value={n.id}>{'　'.repeat(n.depth)}{n.name}</option>
            ))}
          </select>
          <button onClick={() => { setAddingChildTo(node.id); setNewChildName('') }}
            className="shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-600">+ 하위</button>
          <button onClick={() => deleteNode(node.id)} className="shrink-0 text-xs text-rose-500 hover:underline">삭제</button>
        </div>
        {addingChildTo === node.id && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-teal-50/50" style={{ paddingLeft: `${12 + (node.depth + 1) * 20}px` }}>
            <input autoFocus value={newChildName} onChange={e => setNewChildName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addChild(node.id); if (e.key === 'Escape') setAddingChildTo(null) }}
              placeholder="새 하위 카테고리 이름"
              className="flex-1 min-w-0 border border-teal-300 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-teal-400" />
            <button onClick={() => addChild(node.id)} className="shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold bg-teal-500 hover:bg-teal-600 text-white">추가</button>
            <button onClick={() => setAddingChildTo(null)} className="shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-600">취소</button>
          </div>
        )}
        {children.map(renderNode)}
      </div>
    )
  }

  const roots = childrenByParent.get(null) || []

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🌳 카테고리 트리 관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          상품마스터의 내부 카테고리를 대/중/소 계층으로 정리합니다. 처음엔 전부 &quot;최상위&quot; 노드로 시작하니,
          아래에서 하위로 옮기거나 새 하위 카테고리를 추가해 정리하세요.
        </p>
      </div>

      {error && (
        <div className="mb-4 shrink-0 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2 text-xs text-rose-600 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-rose-400 hover:text-rose-600">✕</button>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mb-4 shrink-0 bg-violet-50 border border-violet-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-violet-700">✨ 자동 분할 제안 — {candidates.length}건</p>
            <button onClick={applyCandidates} disabled={applyingCandidates || !selectedCandidates.size}
              className="px-4 py-1.5 rounded-full text-xs font-semibold bg-violet-500 hover:bg-violet-600 text-white disabled:opacity-50">
              선택 {selectedCandidates.size}개 적용
            </button>
          </div>
          <p className="text-xs text-violet-500 mb-3">이름에 &quot; &gt; &quot; 구분자가 있는 카테고리를 찾았습니다 — 이대로 계층으로 나눠드릴까요?</p>
          <div className="space-y-1.5 max-h-48 overflow-auto">
            {candidates.map(c => (
              <label key={c.id} className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-violet-100 text-xs">
                <input type="checkbox" checked={selectedCandidates.has(c.id)}
                  onChange={e => setSelectedCandidates(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(c.id); else next.delete(c.id)
                    return next
                  })} />
                <span className="text-gray-400">{c.name}</span>
                <span>→</span>
                <span className="text-gray-700 font-medium">{c.segments.join(' / ')}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 shrink-0">
        <input value={newRootName} onChange={e => setNewRootName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addRoot() }}
          placeholder="새 최상위 카테고리 이름"
          className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
        <button onClick={addRoot} className="shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-teal-500 hover:bg-teal-600 text-white">
          + 최상위 카테고리 추가
        </button>
      </div>

      {nodes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">🌳</div>
          <p className="text-sm">아직 카테고리가 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="overflow-auto flex-1 min-h-0">
            {roots.map(renderNode)}
          </div>
        </div>
      )}
    </div>
  )
}
