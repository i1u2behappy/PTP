'use client'
import { useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'
import { useCurrentUser } from '../shell/CurrentUserContext'
import { SITES_LIST_TAB } from '../shell/menuTabs'

const MEMO_TEMPLATE = '택배사: \n배송비: \n배송/반품 주소지: \n연락처: \n은행: \n계좌번호: '

interface Props {
  params?: Record<string, unknown>
}

interface ClientOption { id: number; name: string }

/** lib/ai.ts의 MallStructureReport 중 SiteDetailPanel에서 참고용으로 보여줄 6개 거래정보 항목. */
interface MallReport {
  shippingCourier: string
  shippingFeeInfo: string
  returnAddress: string
  companyContact: string
  bankName: string
  accountNumber: string
}

function formatMallReport(r: MallReport): string {
  return [
    `택배사: ${r.shippingCourier}`,
    `배송비: ${r.shippingFeeInfo}`,
    `배송/반품 주소지: ${r.returnAddress}`,
    `연락처: ${r.companyContact}`,
    `은행: ${r.bankName}`,
    `계좌번호: ${r.accountNumber}`,
  ].join('\n')
}

function pad(n: number) { return String(n).padStart(2, '0') }
function formatDateTime(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SiteDetailPanel({ params }: Props) {
  const { bumpRefresh, openTab } = useTabs()
  const { isAdmin } = useCurrentUser()
  const siteId = params?.siteId as number | undefined
  const isNew = siteId == null

  function backToList() { openTab(SITES_LIST_TAB) }

  const [name, setName] = useState('')
  const [mainItems, setMainItems] = useState('')
  const [url, setUrl] = useState('')
  const [loginUrl, setLoginUrl] = useState('')
  const [loginId, setLoginId] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [clientId, setClientId] = useState<number | ''>((params?.clientId as number | undefined) ?? '')
  const [clients, setClients] = useState<ClientOption[]>([])
  const [nameSelector, setNameSelector] = useState('')
  const [priceSelector, setPriceSelector] = useState('')
  const [thumbnailSelector, setThumbnailSelector] = useState('')
  const [autoScrapeEnabled, setAutoScrapeEnabled] = useState(false)
  const [autoScrapeHour, setAutoScrapeHour] = useState(3)
  const [manualLoginRequired, setManualLoginRequired] = useState<boolean | null>(isNew ? null : false)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [mallReport, setMallReport] = useState<MallReport | null>(null)
  const [mallReportUpdatedAt, setMallReportUpdatedAt] = useState<string | null>(null)
  const [memo, setMemo] = useState('')

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: ClientOption[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (isNew) return
    fetch(`/api/sites/${siteId}`).then(r => r.json()).then((d: {
      name: string | null; url: string; login_url: string | null; login_id: string | null; login_pw: string | null; client_id: number | null
      custom_name_selector: string | null; custom_price_selector: string | null; custom_thumbnail_selector: string | null
      auto_scrape_enabled: boolean; auto_scrape_hour: number | null; manual_login_required: boolean | null; main_items: string | null
      mall_report: MallReport | null; mall_report_updated_at: string | null; memo: string | null
    }) => {
      setName(d.name || ''); setMainItems(d.main_items || ''); setUrl(d.url); setLoginUrl(d.login_url || ''); setLoginId(d.login_id || ''); setLoginPw(d.login_pw || '')
      setClientId(d.client_id ?? '')
      setNameSelector(d.custom_name_selector || ''); setPriceSelector(d.custom_price_selector || '')
      setThumbnailSelector(d.custom_thumbnail_selector || '')
      setAutoScrapeEnabled(!!d.auto_scrape_enabled); setAutoScrapeHour(d.auto_scrape_hour ?? 3)
      setManualLoginRequired(d.manual_login_required)
      setMallReport(d.mall_report); setMallReportUpdatedAt(d.mall_report_updated_at)
      setMemo(d.memo || '')
    }).finally(() => setLoading(false))
  }, [siteId, isNew])

  async function handleSave() {
    if (!name) return alert('Mall 이름을 입력하세요.')
    if (!url) return alert('URL을 입력하세요.')
    setSaving(true)
    const body = JSON.stringify({
      name, mainItems: mainItems || undefined, url, loginUrl: loginUrl || undefined, loginId, loginPw, clientId: clientId === '' ? null : clientId,
      customNameSelector: nameSelector || undefined, customPriceSelector: priceSelector || undefined,
      customThumbnailSelector: thumbnailSelector || undefined,
      autoScrapeEnabled: manualLoginRequired ? false : autoScrapeEnabled,
      autoScrapeHour: !manualLoginRequired && autoScrapeEnabled ? autoScrapeHour : null,
      manualLoginRequired,
      memo: memo || undefined,
    })
    try {
      const res = isNew
        ? await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch(`/api/sites/${siteId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('sites')
      if (isNew) {
        backToList()
      } else {
        // 새로 등록할 때와 달리 수정은 저장 후에도 같은 화면(수정 완료된 상태)에 남는다 — 탭을 닫으면
        // 옆에 열려있던 다른 탭(예: 새 Mall 등록)으로 튀어버려 방금 수정한 결과를 확인할 수 없었다.
        setJustSaved(true)
        setTimeout(() => setJustSaved(false), 2000)
      }
    } catch (e) {
      alert(`저장에 실패했습니다: ${e instanceof Error ? e.message : e}\nDB 연결 상태를 확인해주세요.`)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (isNew || !confirm('이 Mall 등록 정보를 삭제할까요?')) return
    try {
      const res = await fetch(`/api/sites/${siteId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('sites')
      backToList()
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (loading) return <div className="text-center text-sm text-gray-400 py-12">불러오는 중...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">{isNew ? '➕ 새 Mall 등록' : `🏬 ${name || url} 수정`}</h1>
        <div className="flex items-center gap-2 shrink-0">
          {!isNew && isAdmin && (
            <button onClick={handleDelete}
              className="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 text-sm font-semibold rounded-full transition-colors mr-2">
              🗑 삭제
            </button>
          )}
          <button onClick={backToList} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
            취소
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : justSaved ? '✓ 저장됨' : isNew ? '등록' : '수정 저장'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">거래처 (선택 · 하나의 거래처에 여러 Mall을 등록할 수 있습니다)</span>
            <select value={clientId} onChange={e => setClientId(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
              <option value="">(선택 안 함)</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Mall 이름 *</span>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">메인 품목 (선택 · 이 몰의 주요 판매 품목)</span>
            <input value={mainItems} onChange={e => setMainItems(e.target.value)} placeholder="예: 여성 신발, 스니커즈"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">URL *</span>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://shop.example.com"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">로그인 URL (선택 · 위 대표 URL과 로그인 페이지가 다른 경우에만 입력 — &quot;로그인창 열기&quot;가 이 URL로 바로 이동합니다)</span>
            <input type="url" value={loginUrl} onChange={e => setLoginUrl(e.target.value)} placeholder="https://shop.example.com/member/login.html"
              autoComplete="off"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">아이디 / 이메일</span>
            {/* 이 몰의 로그인 아이디이지, PTP 자체 로그인 계정과 무관하다 — 브라우저가 저장된 다른
                아이디를 자동으로 채워 넣지 않도록 autoComplete를 끈다. */}
            <input value={loginId} onChange={e => setLoginId(e.target.value)}
              autoComplete="off"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">비밀번호</span>
            <input type="password" value={loginPw} onChange={e => setLoginPw(e.target.value)}
              autoComplete="new-password"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
        </div>

        <div className="mb-3">
          <span className="block text-xs text-gray-500 mb-1">스크랩 방식</span>
          <div className="flex gap-2">
            {([
              { v: null, label: '❔ 아직 모름' },
              { v: false, label: '🤖 일반모드' },
              { v: true, label: '🧩 개발자모드' },
            ] as const).map(opt => (
              <button key={String(opt.v)} type="button" onClick={() => setManualLoginRequired(opt.v)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  manualLoginRequired === opt.v ? 'bg-teal-500 text-white border-teal-500' : 'bg-white text-gray-600 border-gray-300 hover:border-teal-400'}`}>
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {manualLoginRequired === null && '처음 스크랩을 시도할 때 스크래핑 화면에서 한 번 선택하면 됩니다 — 어떤 몰인지 미리 알 수 없어 기본값입니다.'}
            {manualLoginRequired === false && 'PTP가 자동으로 로그인하고 스크랩합니다. 대부분의 몰은 이 방식이면 충분합니다.'}
            {manualLoginRequired === true && 'Windows Hello/WebAuthn(PC인증) 등으로 자동 로그인이 근본적으로 안 되는 몰입니다. 스크래핑 화면에서 자동 실행 대신, 사용자가 실제 브라우저에서 직접 로그인한 상태로 크롬 확장을 이용해 스크랩하는 방법을 안내합니다. 사람이 직접 브라우저를 열고 클릭해야 하는 방식이라 매일 자동 재스크랩은 지원하지 않습니다.'}
          </p>
        </div>

        <details className="mb-3">
          <summary className="text-xs text-gray-500 cursor-pointer select-none mb-2">고급 설정: 수동 추출 셀렉터{!manualLoginRequired && ' · 자동 재스크랩'}</summary>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">상품명 CSS 셀렉터 (선택)</span>
              <input value={nameSelector} onChange={e => setNameSelector(e.target.value)} placeholder=".product-title"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">가격 CSS 셀렉터 (선택)</span>
              <input value={priceSelector} onChange={e => setPriceSelector(e.target.value)} placeholder=".price"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">이미지 CSS 셀렉터 (선택)</span>
              <input value={thumbnailSelector} onChange={e => setThumbnailSelector(e.target.value)} placeholder=".product-image img"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
          </div>
          <p className="text-xs text-gray-400 mb-3">자동 추출(구조화 데이터/메타태그)이 이 몰에서 실패할 때만 채워주세요. 지정하면 자동 추출 결과보다 우선합니다.</p>

          {!manualLoginRequired && (
            <>
              <label className="flex items-center gap-2 text-sm text-gray-600 mb-2">
                <input type="checkbox" checked={autoScrapeEnabled} onChange={e => setAutoScrapeEnabled(e.target.checked)} />
                매일 자동 재스크랩 (증분)
              </label>
              {autoScrapeEnabled && (
                <label className="block max-w-[160px]">
                  <span className="block text-xs text-gray-500 mb-1">실행 시각</span>
                  <select value={autoScrapeHour} onChange={e => setAutoScrapeHour(Number(e.target.value))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </label>
              )}
              <p className="text-xs text-gray-400 mt-2">스크래핑 화면에서 최소 한 번 스크랩을 실행해야(그 설정이 저장돼야) 자동 재스크랩이 동작합니다.</p>
            </>
          )}
        </details>
      </div>

      {!isNew && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">운영 메모</h2>
          <p className="text-xs text-gray-400 mb-3">
            스크래핑 작업 시 파악해두어야 하는 이 몰만의 거래 정보입니다 — 택배사, 배송비, 배송/반품 주소지, 연락처, 은행, 계좌번호 등을 항목별로 구분해 적어주세요.
            아래 &apos;몰 구조 분석&apos; 참고 내용을 보고 직접 옮겨 적으시면 됩니다. 여기 적은 내용은 위 &quot;수정 저장&quot; 버튼으로 저장되고, Mall 목록의 &quot;메모&quot; 컬럼에 그대로 노출됩니다.
          </p>
          <div className="flex justify-end mb-1">
            <button onClick={() => (!memo.trim() || confirm('입력 중이던 내용을 템플릿으로 덮어쓸까요?')) && setMemo(MEMO_TEMPLATE)}
              className="text-xs text-teal-600 hover:underline">📋 템플릿 채우기</button>
          </div>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="메모 내용" rows={6}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
        </div>
      )}

      {!isNew && mallReport && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mt-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">🔍 몰 구조 분석 (참고용, 최근 1건)</h2>
          <p className="text-xs text-gray-400 mb-3">
            {mallReportUpdatedAt ? `${formatDateTime(mallReportUpdatedAt)} 기준 — ` : ''}
            스크래핑 화면의 &quot;몰 구조 파악&quot;으로 자동 분석된 내용입니다. 정확하다고 확인되면 위 운영 메모에 직접 옮겨 적어주세요.
          </p>
          <pre className="text-xs text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg px-3 py-2 font-sans">{formatMallReport(mallReport)}</pre>
        </div>
      )}
    </div>
  )
}
