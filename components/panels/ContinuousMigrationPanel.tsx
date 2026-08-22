'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Client { id: number; name: string }
interface Site { id: number; name: string | null; url: string; client_id: number | null }

interface ChangeRow {
  mallProductId: number
  masterId: number
  clientId: number
  nameOriginal: string
  mallProductCode: string
  lastScrapedAt: string | null
  updatedAt: string
  reasons: string[]
  priceOnly: boolean
}

type RecheckField = 'code' | 'price' | 'cost_price' | 'stock' | 'options' | 'images'
const RECHECK_FIELDS: { key: RecheckField; label: string }[] = [
  { key: 'code', label: '상품코드 (품목삭제 확인)' },
  { key: 'price', label: '가격' },
  { key: 'cost_price', label: '공급가' },
  { key: 'stock', label: '재고' },
  { key: 'options', label: '옵션' },
  { key: 'images', label: '이미지' },
]
interface RecheckResultRow { mallProductId: number; mallProductCode: string; reasons: string[] }

/**
 * 마이그레이션3_연속관리 — 이미 상품마스터로 만들어져 거래처에 제공 중인 상품을, 몰에서 다시 스크랩한
 * 최신 값과 비교해 재고/옵션/이미지/가격이 바뀐 것만 골라 보여주고, 선택한 것만 다시 마이그레이션(상품
 * 마스터 갱신)한다. "1차 스크래핑 → 상품마스터" 절차를 변동분에 한해 반복하는 것과 같다 — 새 상품 자체는
 * 기존 "마이그레이션" 메뉴에서 다루고, 여기는 이미 만들어진 상품마스터의 "변동 감지 → 갱신"만 담당한다.
 */
export function ContinuousMigrationPanel() {
  const { openDetailModal } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | ''>('')
  const [changes, setChanges] = useState<ChangeRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [detecting, setDetecting] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [searched, setSearched] = useState(false)
  const [structureChecking, setStructureChecking] = useState(false)
  const [structureCheckResult, setStructureCheckResult] = useState<{ diffs: string[]; isFirstTime: boolean } | null>(null)
  const [structureCheckError, setStructureCheckError] = useState('')
  const [loadingAll, setLoadingAll] = useState(false)
  const [recheckFields, setRecheckFields] = useState<Set<RecheckField>>(new Set())
  const [recheckTarget, setRecheckTarget] = useState<'all' | 'selected'>('all')
  const [rechecking, setRechecking] = useState(false)
  const [recheckResults, setRecheckResults] = useState<RecheckResultRow[] | null>(null)
  const [recheckError, setRecheckError] = useState('')

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => setSites(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)

  const detectChanges = useCallback(async () => {
    if (siteId === '') return
    setDetecting(true)
    try {
      const res = await fetch(`/api/master/changes?siteId=${siteId}`)
      const d = await res.json() as ChangeRow[]
      setChanges(Array.isArray(d) ? d : [])
      setSelected(new Set())
      setSearched(true)
    } finally {
      setDetecting(false)
    }
  }, [siteId])

  // "선택한 상품만" 재수집 대상을 고르려면 변동 여부와 무관한 전체 확정 상품 목록이 필요하다 — 기존
  // "변동 감지" 테이블/체크박스를 그대로 재사용한다(changes?all=1).
  async function loadAllConfirmed() {
    if (siteId === '') return
    setLoadingAll(true)
    try {
      const res = await fetch(`/api/master/changes?siteId=${siteId}&all=1`)
      const d = await res.json() as ChangeRow[]
      setChanges(Array.isArray(d) ? d : [])
      setSelected(new Set())
      setSearched(true)
    } finally {
      setLoadingAll(false)
    }
  }

  function toggleRecheckField(key: RecheckField) {
    setRecheckFields(s => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })
  }

  async function runRecheck() {
    if (siteId === '' || !recheckFields.size) return
    if (recheckTarget === 'selected' && !selected.size) return
    setRechecking(true)
    setRecheckError('')
    setRecheckResults(null)
    try {
      const res = await fetch('/api/master/recheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId, fields: Array.from(recheckFields),
          mallProductIds: recheckTarget === 'selected' ? Array.from(selected) : undefined,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setRecheckError(d.error || '체킹에 실패했습니다'); return }
      setRecheckResults(d.results as RecheckResultRow[])
    } catch {
      setRecheckError('체킹에 실패했습니다')
    } finally {
      setRechecking(false)
    }
  }

  async function checkMallStructure() {
    if (siteId === '') return
    setStructureChecking(true)
    setStructureCheckResult(null)
    setStructureCheckError('')
    try {
      const res = await fetch('/api/master/mall-structure-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId }),
      })
      const d = await res.json()
      if (!res.ok) { setStructureCheckError(d.error || '몰 구조 체크에 실패했습니다'); return }
      setStructureCheckResult(d as { diffs: string[]; isFirstTime: boolean })
    } catch {
      setStructureCheckError('몰 구조 체크에 실패했습니다')
    } finally {
      setStructureChecking(false)
    }
  }

  function toggleSelect(id: number) {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  function toggleSelectAll() {
    setSelected(s => s.size === changes.length ? new Set() : new Set(changes.map(c => c.mallProductId)))
  }

  async function migrateSelected() {
    if (!selected.size || siteId === '') return
    setMigrating(true)
    try {
      const rows = changes.filter(c => selected.has(c.mallProductId))
      const clientIdForCall = rows[0]?.clientId || 1
      const res = await fetch('/api/master/reapply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallProductIds: rows.map(r => r.mallProductId), clientId: clientIdForCall, siteId }),
      })
      const d = await res.json() as { failed?: { id: number; error: string }[] }
      if (d.failed?.length) alert(`${d.failed.length}건은 컬럼 규칙 반영에 실패했습니다 (상품마스터 기본 갱신은 완료됨).`)
      await detectChanges()
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🔁 마이그레이션3_연속관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          이미 상품마스터로 만들어 거래처에 제공한 몰 품목 중, 몰 쪽에서 재고·옵션·이미지·가격이 바뀐 것을 찾아
          선택적으로 다시 마이그레이션합니다. 신규 상품 자체는 기존 &quot;마이그레이션&quot; 메뉴에서 처리해주세요.
          &quot;몰 구조 체크&quot;는 이 품목들과 별개로, 몰 페이지 자체의 구조(카테고리/옵션 형태/재고 표기 방식 등)가
          바뀌었는지 확인합니다(과거 스크래핑 메뉴 &quot;로그인 확인&quot;마다 자동으로 돌던 기능을 이쪽으로 옮김).
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          거래처
          <select value={clientId} onChange={e => { setClientId(e.target.value ? Number(e.target.value) : ''); setSiteId(''); setChanges([]); setSelected(new Set()); setSearched(false) }}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          몰
          {/* 몰을 바꾸면 이전 몰의 "변동 감지" 결과(changes/selected)를 그대로 두지 않는다 — 안 그러면
              다시 감지를 누르기 전까지 화면엔 이전 몰의 행이 남아있고, 그 상태로 "선택 반영"을 누르면
              지금 고른 몰과 이전 몰의 상품 id가 섞인 요청이 나간다. */}
          <select value={siteId} onChange={e => { setSiteId(e.target.value ? Number(e.target.value) : ''); setChanges([]); setSelected(new Set()); setSearched(false); setStructureCheckResult(null); setStructureCheckError('') }}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">몰을 선택하세요</option>
            {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
        <button onClick={detectChanges} disabled={siteId === '' || detecting}
          className="px-4 py-1.5 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {detecting ? '감지 중...' : '🔍 변동 감지'}
        </button>
        <button onClick={checkMallStructure} disabled={siteId === '' || structureChecking}
          title="몰 페이지 자체의 구조(카테고리/옵션 형태/재고 표기 방식 등)가 바뀌었는지 확인합니다 — 재고·옵션·가격 값 변동과는 별개입니다."
          className="px-4 py-1.5 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {structureChecking ? '몰 구조 체크 중...' : '🔍 몰 구조 체크'}
        </button>
        {searched && changes.length > 0 && (
          <button onClick={migrateSelected} disabled={!selected.size || migrating}
            className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-semibold rounded-full hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {migrating ? '반영 중...' : `선택 재마이그레이션 (${selected.size})`}
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 shrink-0">
        <p className="text-xs text-gray-400 mb-2">
          현재 상태 체킹(재수집) — 몰에 다시 방문해 고른 컬럼만 가볍게 확인합니다(&quot;변동 감지&quot;는 저장된
          데이터끼리 비교만 하고 몰을 다시 방문하지 않습니다). &quot;상품코드&quot;를 고르면 페이지 자체가 사라진
          품목을 &quot;단종(추정)&quot;으로 표시합니다.
        </p>
        <div className="flex flex-wrap items-center gap-4 mb-3">
          {RECHECK_FIELDS.map(f => (
            <label key={f.key} className="flex items-center gap-1.5 text-sm text-gray-600">
              <input type="checkbox" checked={recheckFields.has(f.key)} onChange={() => toggleRecheckField(f.key)} />
              {f.label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 mb-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="radio" name="recheckTarget" checked={recheckTarget === 'all'} onChange={() => setRecheckTarget('all')} />
            전체 확정 상품
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="radio" name="recheckTarget" checked={recheckTarget === 'selected'} onChange={() => setRecheckTarget('selected')} />
            선택한 상품만 ({selected.size}개 선택됨)
          </label>
          {recheckTarget === 'selected' && (
            <button onClick={loadAllConfirmed} disabled={siteId === '' || loadingAll}
              className="text-xs text-teal-600 hover:underline disabled:opacity-40 disabled:cursor-not-allowed">
              {loadingAll ? '불러오는 중...' : '📋 전체 확정 상품 목록에서 고르기'}
            </button>
          )}
        </div>
        <button onClick={runRecheck}
          disabled={siteId === '' || !recheckFields.size || rechecking || (recheckTarget === 'selected' && !selected.size)}
          className="px-4 py-1.5 bg-indigo-500 text-white text-sm font-semibold rounded-full hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {rechecking ? '체킹 중...' : '🔎 현재 상태 체킹(재수집)'}
        </button>
        {recheckError && <p className="text-xs text-rose-500 mt-2">{recheckError}</p>}
        {recheckResults && (
          recheckResults.length === 0 ? (
            <p className="text-xs text-emerald-600 mt-3">✅ 확인한 항목 모두 저장된 값과 동일합니다 — 변경 없음.</p>
          ) : (
            <ul className="text-xs space-y-1 mt-3">
              {recheckResults.map(r => (
                <li key={r.mallProductId} className="text-gray-700">
                  <span className="font-semibold">{r.mallProductCode}</span>
                  {r.reasons.map((reason, i) => (
                    <span key={i} className={reason.startsWith('단종') ? 'text-rose-600' : 'text-amber-600'}> · {reason}</span>
                  ))}
                </li>
              ))}
            </ul>
          )
        )}
      </div>

      {structureCheckError && (
        <p className="text-xs text-rose-500 mb-4 shrink-0">{structureCheckError}</p>
      )}
      {structureCheckResult && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              structureCheckResult.isFirstTime ? 'bg-teal-100 text-teal-700'
                : structureCheckResult.diffs.length ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {structureCheckResult.isFirstTime ? '🔍 최초 기준정보 저장 완료'
                : structureCheckResult.diffs.length ? '⚠ 몰 구조 변경 감지' : '✅ 변경사항 없음'}
            </span>
          </div>
          {structureCheckResult.diffs.length > 0 && (
            <ul className="text-xs text-amber-600 space-y-0.5 mt-1">
              {structureCheckResult.diffs.map((d, i) => <li key={i}>• {d}</li>)}
            </ul>
          )}
        </div>
      )}

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 flex-1">
          <div className="text-4xl mb-3">🔁</div>
          <p className="text-sm">몰을 선택하고 &quot;변동 감지&quot;를 눌러주세요.</p>
        </div>
      ) : changes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 flex-1">
          <div className="text-4xl mb-3">✅</div>
          <p className="text-sm">현재 상품마스터와 몰의 최신 스크랩 값이 모두 일치합니다 — 변동된 상품이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="overflow-y-auto flex-1 min-h-0">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                  <th className="px-4 py-3 text-left w-10 sticky left-0 z-20 bg-gray-50">
                    <input type="checkbox" checked={selected.size > 0 && selected.size === changes.length} onChange={toggleSelectAll} />
                  </th>
                  <th className="px-4 py-3 text-left">몰상품코드</th>
                  <th className="px-4 py-3 text-left">상품명</th>
                  <th className="px-4 py-3 text-left">변동 내역</th>
                  <th className="px-4 py-3 text-left">최근 스크랩</th>
                  <th className="px-4 py-3 text-left">관리</th>
                </tr>
              </thead>
              <tbody>
                {changes.map(c => (
                  <tr key={c.mallProductId} className="group border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 sticky left-0 z-10 bg-white group-hover:bg-gray-50">
                      <input type="checkbox" checked={selected.has(c.mallProductId)} onChange={() => toggleSelect(c.mallProductId)} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{c.mallProductCode}</td>
                    <td className="px-4 py-2 text-xs text-gray-700 max-w-[220px] truncate" title={c.nameOriginal}>{c.nameOriginal}</td>
                    <td className="px-4 py-2 text-xs">
                      <ul className="space-y-0.5">
                        {c.reasons.map((r, i) => (
                          <li key={i} className={r.includes('참고용') ? 'text-gray-400' : 'text-amber-600'}>• {r}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                      {c.lastScrapedAt ? new Date(c.lastScrapedAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <button onClick={() => openDetailModal('master-detail', { masterId: c.masterId })}
                        className="text-teal-500 hover:underline text-xs">상세 보기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
