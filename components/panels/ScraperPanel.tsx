'use client'
import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'
import { PRODUCTS_LIST_TAB } from '../shell/menuTabs'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'
import RemoteScreenViewer from './RemoteScreenViewer'
import { shortenCategoryUrlForDisplay } from '../../lib/urlDisplay'
import { looksLikeMallHomeUrl, buildCategoryTree, countCategoryTreeEntries, type CategoryTreeNode } from '../../lib/categoryUrl'
import { LoginModeBadgeEditor } from './shared/LoginModeBadgeEditor'

// lib/extract.ts의 CLAIMED_INFO_LABEL_RE와 같은 목록 — 이 파일은 Playwright 등 서버 전용 코드를 담고
// 있어 클라이언트 컴포넌트에서 직접 import하지 않고 그대로 복제해 둔다(둘 중 하나를 고치면 같이 맞출 것).
const CLAIMED_INFO_LABEL_RE = /브랜드|제조사|제조자|원산지|제조국|상품요약정보|영문상품명|유통기한|소비기한|상품코드|정가|판매가|소비자가|시중가|정상가|공급가|도매가|배송비|택배비/i

// 기준 Master 테이블 관리 화면과 같은 라벨을 쓰기 위해 거기서 쓰는 이름을 그대로 가져온다 — 예전엔 이 표만
// "소비자판가"/"공급가"라고 따로 부르고 있어서 기준 테이블의 "정상가"/"원가"와 같은 값인데 다르게 보였다.
// FIXED_FIELD_INFO는 로딩 전/미등록 키의 기본값일 뿐, 사용자가 기준 마스터테이블관리에서 라벨을 직접
// 바꿔둔 경우(예: "원가"→"공급가") 실제로는 useRegisteredFieldKeys가 돌려주는 DB 값이 우선해야 한다.
const DEFAULT_FIELD_LABEL = new Map(FIXED_FIELD_INFO.map(f => [f.key, f.label]))

// 한글 등 비ASCII 문자가 들어간 URL은 퍼센트 인코딩(%ED%94%84...)된 채로 저장/전달되는 게 맞다(URL 표준) —
// 다만 사람이 읽기엔 원래 글자로 보여주는 게 낫다(브라우저 주소창도 그렇게 보여준다). 실제 이동/클릭은
// 원본 인코딩 문자열을 그대로 쓰고, 화면 표시에만 디코딩한다. 디코딩 실패(잘못된 %-시퀀스)는 원본 그대로.
function decodeUrlForDisplay(url: string): string {
  try { return decodeURIComponent(url) } catch { return url }
}

// PTP 페이지가 개발자모드 확장에 chrome.runtime.sendMessage(externally_connectable)로 직접 메시지를
// 보내 몰 탭의 기능(미리보기/피커/스크랩 시작 등)을 대신 실행시키던 sendExtensionAction 함수는 제거했다
// (2026-09-05) — extension-poc/manifest.json에 이미 externally_connectable/key가 없어(다른 이유로
// 빠진 뒤 안 되돌려짐) 항상 조용히 실패하고 있었다. 모든 호출부를 "🔍 몰 구조분석"과 같은 focus + 안내
// 방식으로 옮겼다(각 호출부 주석 참고).

type Status = 'idle' | 'running' | 'done' | 'error' | 'stopped'
type LoginStep = 'none' | 'opened' | 'confirmed'

interface Site {
  id: number
  name: string | null
  url: string
  login_url: string | null
  login_id: string | null
  manual_login_required?: boolean | null
  profile_dir?: string
  client_id?: number | null
  client_name?: string | null
  main_items?: string | null
  last_login_confirmed_at?: string | null
  has_completed_scrape?: boolean
}

interface Client { id: number; name: string }

interface SitePickerColumnDef {
  key: string
  label: string
  getValue: (s: Site) => string
  render: (s: Site) => React.ReactNode
  className?: string
}

// Mall 관리(SitesListPanel) 그리드와 같은 정렬/필터/너비조절/순서변경을 이 Mall 선택 그리드에도 맞춰
// 넣은 것 — 컬럼 구성만 다르고 나머지 로직은 그대로 포팅.
const SITE_PICKER_COLUMNS: SitePickerColumnDef[] = [
  { key: 'name', label: 'Mall 이름', getValue: s => s.name || '', className: 'text-gray-800 font-medium whitespace-nowrap', render: s => (
    <>
      {s.name || '(이름 없음)'}
      {/* 원래 이 "몰 선택 그리드"에 넣어달라던 요청이었다(사용자 지적, 2026-09-20 — "스크래핑 설정에
          몰 선택 그리드에 구현하라고 한건데, 어디다가 했다는거야?") — 처음엔 Mall 상세관리 목록에만
          넣었다가 뒤늦게 옮겨왔다. Mall 상세관리와 같은 컴포넌트(LoginModeBadgeEditor)를 그대로 써서
          클릭 한 번으로 일반모드/개발자모드/미정을 바로 바꿀 수 있다 — 읽기 전용 배지가 아니다. */}
      <LoginModeBadgeEditor site={s} className="ml-1.5" />
    </>
  ) },
  { key: 'main_items', label: '메인 품목', getValue: s => s.main_items || '', render: s => s.main_items || '-', className: 'text-gray-500' },
  { key: 'client_name', label: '거래처', getValue: s => s.client_name || '', render: s => s.client_name || '-', className: 'text-teal-600 whitespace-nowrap' },
  { key: 'url', label: 'URL', getValue: s => s.url, render: s => s.url, className: 'text-gray-500' },
]

const SITE_PICKER_DEFAULT_COL_WIDTH: Record<string, number> = { name: 160, main_items: 140, client_name: 110, url: 260 }
const SITE_PICKER_MIN_COL_WIDTH = 50
function sitePickerWidthFor(key: string): number {
  return SITE_PICKER_DEFAULT_COL_WIDTH[key] ?? 120
}
function compareSitePickerValues(a: string, b: string): number {
  return a.localeCompare(b, 'ko')
}
type SitePickerSortDir = 'asc' | 'desc'
interface SitePickerSortKey { key: string; dir: SitePickerSortDir }

const PLATFORM_LABELS: Record<string, string> = {
  cafe24: '카페24', makeshop: '메이크샵', godomall: '고도몰', unknown: '알 수 없음 (범용 방식 사용)',
}

// 스크랩 검토 탭으로 넘어갔다 돌아와도(탭 전환 시 이 패널은 언마운트된다) 방금 진행/완료한 세션 정보가
// 유지되도록 site+sessionId만 남겨두고, 되돌아왔을 때 서버에서 최신 상태를 다시 조회해 복원한다.
// sessionStorage에 저장한다(localStorage 아님) — localStorage는 같은 브라우저의 모든 탭이 공유해서,
// 다른 탭(또는 예전 세션)이 저장해둔 다른 몰 정보가 지금 탭에 새어 들어올 수 있다. 개발서버의 Fast
// Refresh 강제 새로고침으로 화면이 통째로 다시 마운트되면서, 지금 보고 있던 몰과 무관한 다른 몰로
// 조용히 바뀌어버린 사고로 실제 확인됨(2026-08-17) — sessionStorage는 탭 하나에만 묶이고 그 탭을 닫기
// 전까진 새로고침해도 그대로 남아있어, "새로고침해도 안 사라진다"는 기존 목적은 그대로 지키면서 다른
// 탭의 상태가 섞여 들어오는 일은 없앤다.
const LAST_SESSION_KEY = 'scrape.scraper.lastSession'

// 스크랩을 아직 시작하지 않은 단계(몰 선택/시작 URL/카테고리 목록 입력, 미리보기 전)도 다른 메뉴에 갔다
// 오면 언마운트로 사라지는 건 마찬가지다(사용자 실측 발견) — LAST_SESSION_KEY는 "스크랩이 실제로
// 시작된 뒤"에만 채워지므로 그 전 단계는 별도로 남겨둔다. 미리보기 결과도 다른 메뉴 갔다 돌아오면
// 사라져 있다는 지적으로(재조회하려면 다시 몰 페이지에 접속해야 해 느리다) 폼 값과 함께 그대로 남겨둔다.
// LAST_SESSION_KEY와 같은 이유로 sessionStorage를 쓴다(탭 간 공유 방지).
const FORM_STATE_KEY = 'scrape.scraper.formState'
// 몰(site)과 무관하게 항상 같은 값을 쓰는 전역 선호값이라 FORM_STATE_KEY(몰별 작업 상태)와 분리한다.
// 2026-08-20 PC 업그레이드(8코어16스레드/28GB)로 저사양 대응용 수동/2 기본값을 원래의 자동/8로
// 되돌리면서 키 이름도 바꿨다(.v3) — 안 바꾸면 예전에 이미 저장된 수동/2 값이 그대로 읽혀 새 기본값이
// 적용되지 않는다(로컬 도구라 기존 저장값을 서버에서 강제로 덮어쓸 방법이 없음).
const CONCURRENCY_PREF_KEY = 'scrape.scraper.concurrencyPref.v3'
function readConcurrencyPref(): { mode: 'auto' | 'manual'; value: number } {
  if (typeof window === 'undefined') return { mode: 'auto', value: 8 }
  try {
    const saved = JSON.parse(localStorage.getItem(CONCURRENCY_PREF_KEY) || '{}') as { mode?: 'auto' | 'manual'; value?: number }
    return { mode: saved.mode === 'manual' ? 'manual' : 'auto', value: saved.value ? Math.max(1, Math.min(16, saved.value)) : 8 }
  } catch {
    return { mode: 'auto', value: 8 }
  }
}

// "카테고리별 상품 개수" 표의 컬럼 폭 — 브라우저 기본 드래그 손잡이(CSS resize)로 바뀐 폭을
// RemoteScreenViewer.tsx의 화면 크기 조절과 같은 방식(ResizeObserver로 결과만 뒤따라가며 저장)으로
// 기억해둔다(사용자 요청, 2026-09-05). 몰마다 카테고리 이름 길이가 달라 선호 폭도 달라질 수 있어 몰별이
// 아니라 전역(localStorage) 선호값으로 둔다.
const CATEGORY_COUNT_COL_WIDTHS_KEY = 'scrape.scraper.categoryCountColWidths'
interface CategoryCountColWidths { category: number; count: number; duplicate: number }
const DEFAULT_CATEGORY_COUNT_COL_WIDTHS: CategoryCountColWidths = { category: 220, count: 80, duplicate: 112 }
function readSavedCategoryCountColWidths(): CategoryCountColWidths {
  if (typeof window === 'undefined') return DEFAULT_CATEGORY_COUNT_COL_WIDTHS
  try {
    const saved = JSON.parse(localStorage.getItem(CATEGORY_COUNT_COL_WIDTHS_KEY) || '{}') as Partial<CategoryCountColWidths>
    return {
      category: saved.category && saved.category > 0 ? saved.category : DEFAULT_CATEGORY_COUNT_COL_WIDTHS.category,
      count: saved.count && saved.count > 0 ? saved.count : DEFAULT_CATEGORY_COUNT_COL_WIDTHS.count,
      duplicate: saved.duplicate && saved.duplicate > 0 ? saved.duplicate : DEFAULT_CATEGORY_COUNT_COL_WIDTHS.duplicate,
    }
  } catch {
    return DEFAULT_CATEGORY_COUNT_COL_WIDTHS
  }
}

interface ItemLogRow {
  id: number
  url: string
  status: 'success' | 'failed'
  error: string | null
}

interface PreviewProduct {
  name: string
  category: string
  price: number | null
  sale_price: number | null
  cost_price: number | null
  shipping_fee: number | string | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  thumbnail_urls: string[]
  thumbnail_names: string[]
  detail_image_urls: string[]
  detail_image_names: string[]
  detail_text: string
  summary_info: string
  english_name: string
  stock_status: string
  stock_qty: number | null
  stock_by_option: { option: string; qty: number }[]
  extra_info: { label: string; value: string }[]
  custom_fields: Record<string, string>
}

interface PreviewItem {
  url: string
  name: string
  thumbnail: string
}

interface CategoryCountItem {
  url: string
  label: string
  count: number
  /** true면 이 개수는 정확한 총합이 아니라 최소치다 — 위젯/탐색이 다 실패해 상한(lib/scraper.ts의
   *  AUTO_PAGINATION_CAP)까지 직접 세다 멈췄는데 그때까지도 새 상품이 계속 나온 경우(CategoryCount 참고). */
  truncated?: boolean
}

/** 카테고리 체크리스트의 "상품개수"/"확인일시"/"최근 스크랩"/"업체" 컬럼용 — href를 키로 한다.
 *  count~checkedAt은 previewCatalog가 저장해둔 값(href 기준), lastScrapedAt/clientName은 그 라벨로
 *  매칭한 실제 스크랩/마이그레이션 이력(사용자 요청, 2026-08-17). */
interface CategoryInfoEntry {
  count?: number
  truncated?: boolean
  label?: string
  checkedAt?: string
  lastScrapedAt?: string | null
  clientName?: string | null
}

function elapsedMinutesBetween(createdAt: string, finishedAt: string): number {
  return Math.round((new Date(finishedAt).getTime() - new Date(createdAt).getTime()) / 60_000)
}

/** "몰 구조분석"은 몇 초~몇 분까지 편차가 커서(펫투비는 10분 넘게 걸린 적도 있음), elapsedMinutesBetween처럼
 *  분 단위로만 보여주면 짧게 끝난 경우 전부 "0분"으로 뭉개진다 — 초 단위까지 보여준다. */
function formatElapsedSeconds(sec: number): string {
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return rest ? `${min}분 ${rest}초` : `${min}분`
}

/** discoverCategoryLinks의 중분류 허브 펼치기(lib/scraper.ts, 2026-08-17)가 고쳐지기 전에 이미
 *  sites.scrape_profile에 저장돼버린 카테고리 목록은 같은 href가 두 번 들어있을 수 있다 — href를
 *  React key로 그대로 쓰는 체크리스트가 이걸 그대로 렌더링하면 key 중복 경고/오동작이 난다(모자사러
 *  실사용 확인, 2026-08-18). 먼저 나온 항목을 남기고 뒤에 나온 중복만 제거한다. */
function dedupeCategoryLinks<T extends { href: string }>(links: T[]): T[] {
  const seen = new Set<string>()
  return links.filter(c => (seen.has(c.href) ? false : (seen.add(c.href), true)))
}

/** href 기준 개수(countsByHref, previewCatalog가 저장해둔 값)와 라벨 기준 스크랩/마이그레이션 이력
 *  (historyByLabel)을 합쳐 체크리스트가 바로 쓸 수 있는 href 기준 맵으로 만든다. */
function mergeCategoryInfo(
  countsByHref: Record<string, { count: number; truncated?: boolean; label: string; checkedAt: string }>,
  historyByLabel: Record<string, { lastScrapedAt: string | null; clientName: string | null }>,
): Record<string, CategoryInfoEntry> {
  const next: Record<string, CategoryInfoEntry> = {}
  for (const [href, c] of Object.entries(countsByHref)) {
    const hist = historyByLabel[c.label]
    next[href] = {
      count: c.count, truncated: c.truncated, label: c.label, checkedAt: c.checkedAt,
      lastScrapedAt: hist?.lastScrapedAt ?? null, clientName: hist?.clientName ?? null,
    }
  }
  return next
}

/** 체크리스트 컬럼용 짧은 날짜 표시 — 전체 값은 title(툴팁)로 볼 수 있다. */
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 기준 마스터테이블 필드 키 하나를 미리보기의 실제 스크랩 값으로 풀어낸다 — 표에 보여줄 값이 없는
 *  컬럼(내부관리코드/판매관리코드/마켓별카테고리 등, 스크랩 시점엔 절대 채워지지 않고 후속 절차에서
 *  채워지는 값)은 '-'로 비워둔다(사용자 정책: "값이 없는 컬럼은 비워둘 것"). */
function previewValueFor(product: PreviewProduct, sourceUrl: string, fieldKey: string, registryLabels: Map<string, string>): string {
  const money = (n: number | string | null) => n == null ? '-' : typeof n === 'number' ? `₩${n.toLocaleString()}` : n
  switch (fieldKey) {
    case 'name_final': return product.name || '-'
    case 'product_url': return sourceUrl || '-'
    case 'master_category': return product.category || '-'
    case 'cost_price': return money(product.cost_price)
    case 'list_price': return money(product.price)
    case 'sale_price': return money(product.sale_price)
    case 'brand': return product.brand || '-'
    case 'manufacturer': return product.manufacturer || '-'
    case 'origin': return product.origin || '-'
    case '1_option': return product.options[0]?.values.join(', ') || '-'
    case '2_option': return product.options[1]?.values.join(', ') || '-'
    case '3_option': return product.options[2]?.values.join(', ') || '-'
    case 'top_img': return product.thumbnail_urls.length ? `${product.thumbnail_urls.length}장 — ${product.thumbnail_names.join(', ')}` : '-'
    case 'detail_img': return product.detail_image_urls.length ? `${product.detail_image_urls.length}장 — ${product.detail_image_names.join(', ')}` : '-'
    case 'description': return product.description || '-'
    case 'shipping_fee': return money(product.shipping_fee)
    case 'stock_status': return product.stock_status || '-'
    case 'stock_qty': return product.stock_qty != null ? `${product.stock_qty}개` : '-'
    // 내부관리코드/판매관리코드/마켓별카테고리 등은 스크랩 시점엔 값이 없는 후속 절차용 컬럼 — 기본값 '-'로 빠진다.
    default: {
      const label = registryLabels.get(fieldKey) || fieldKey
      return product.custom_fields?.[fieldKey] ?? product.custom_fields?.[label] ?? '-'
    }
  }
}

/** lib/ai.ts의 AiProviderId/ALL_AI_PROVIDERS와 같은 목록 — 서버 전용 SDK(Anthropic/GoogleGenAI)를 문 채로
 *  가져오는 lib/ai.ts를 클라이언트 컴포넌트에서 직접 import하면 그 SDK까지 브라우저 번들에 실리므로,
 *  이 작은 목록만 따로 들고 있는다(이 파일의 다른 lib/scraper.ts 타입 중복과 같은 이유). 새 AI 공급자를
 *  추가하려면 lib/ai.ts의 ALL_AI_PROVIDERS/generateMallProfileReport와 이 목록을 같이 맞춰야 한다. */
type AiProviderId = 'anthropic' | 'groq' | 'gemini' | 'ollama'
// 라벨엔 공급자 이름만 적지 않고 **실제로 도는 모델명**까지 적는다(2026-09-12 사용자 지시) — "Groq"만
// 봐서는 그게 웹인지 로컬인지, 어떤 모델인지 알 수 없어 "지금 qwen 14b로 도는 것 같은데 Ollama는 왜
// 꺼져 있냐" 같은 혼동이 실제로 있었다. 괄호는 "모델·실행위치" 한 축으로 통일한다 — 예전엔 Groq만
// '(무료)', Ollama만 '(로컬)'이라 서로 다른 축을 나란히 붙여놔 "Ollama는 유료인가?"로 읽혔다.
// title에는 텍스트/화면인식 모델을 나눠 적는다 — 이 둘이 서로 다르다(화면인식은 멀티모달 전용 모델).
// **모델명은 lib/ai.ts의 상수와 반드시 일치해야 한다** — tests/unit/aiProviderLabels.test.ts가 검증
// 루프에서 이걸 강제한다(예전에 Groq 툴팁이 이미 교체된 옛 모델명을 열흘 넘게 계속 안내하던 사고).
const AI_PROVIDER_OPTIONS: { id: AiProviderId; label: string; title: string }[] = [
  { id: 'anthropic', label: 'Anthropic(Haiku 4.5)', title: 'claude-haiku-4-5-20251001 — 유료 API(크레딧 필요), 웹.' },
  { id: 'groq', label: 'Groq(qwen 27b·웹)', title: '텍스트/화면인식 모두 qwen/qwen3.8-27b — 무료 등급(분당·일일 토큰 한도 있음), 웹.' },
  // 카테고리/정렬 화면인식에서 Groq 다음 2차로 시도되는 순서 그대로 Groq 바로 다음에 배치(사용자 지시,
  // 2026-09-25 — "gemini 버전이 다른 게 들어왔으니, 이 버전도 groq 다음에 위치에 맞게 표시해줘").
  // "몰 구조분석 리포트" 생성에서는 이 순서와 무관하게 Gemini가 Groq보다 먼저 시도된다(자체 목록,
  // lib/ai.ts의 generateMallProfileReport 참고) — 체크박스 하나가 두 기능을 같이 켜고 끄므로 순서는
  // 화면인식(비전) 쪽 기준으로 통일한다.
  { id: 'gemini', label: 'Gemini(Flash)', title: '텍스트 gemini-flash-latest, 화면인식 gemini-3.6-flash(Groq 실패 시 2차) — 무료 티어(모델별 일일 한도 있음), 웹.' },
  { id: 'ollama', label: 'Ollama(qwen 14b/8b·로컬)', title: '텍스트 qwen3:14b(후보 선별)·qwen3:8b(몰 구조분석 리포트), 화면인식 qwen2.5vl:7b — 이 PC에서 직접 실행(요금 없음, CPU 사용).' },
]

/** lib/ai.ts의 MallStructureReport와 같은 모양. */
interface MallStructureReport {
  urlHierarchy: string
  categoryStructure: string
  sortStructure: string
  bankName: string
  accountNumber: string
  shippingCourier: string
  shippingFeeInfo: string
  returnAddress: string
  stockManagementType: string
  companyContact: string
  productPageStructure: string
  scrapingNeeds: string
  generatedBy: 'ai' | 'heuristic' | 'ollama' | 'groq'
}

/** lib/scraper.ts의 MallProfileSignals와 같은 모양 — "몰 구조분석" 버튼 결과 표시용. */
interface MallProfileSignals {
  sampleCount: number
  platform: string
  sampleProductUrl: string
  hasMainImages: boolean
  hasDetailImages: boolean
  optionUiTypes: string[]
  hasCascadingOptions: boolean
  hasStockQty: boolean
  hasStockStatusText: boolean
  hasStockByOption: boolean
  hasDetailText: boolean
  infoLabels: string[]
  categoryPaths: string[]
  categoryMaxDepth: number
  categoryMenuNames: string[]
  categoryLinks?: { name: string; href: string }[]
  /** categoryLinks를 찾을 때 AI가 실제로 기여했는지 — 사용자 요청으로 체크리스트에 작게 표시(2026-08-18). */
  categoryLinksAiUsed?: boolean
  /** "카테고리별 정렬기준 설정" 기능용 — 이 몰의 목록 페이지가 지원하는 정렬 옵션(표준 라벨)과, 그 정렬을
   *  실제로 적용하는 방법(사용자 요청, 2026-08-19). 대부분은 `paramsToAdd`(카테고리 URL에 추가할
   *  쿼리파라미터)로 충분하지만, 정렬이 URL에 전혀 반영되지 않는 AJAX 방식 몰(펫투비 등)은 `kind:'click'`
   *  + `clickText`(목록 페이지에서 실제로 클릭할 텍스트)로 표현한다 — lib/scraper.ts의 MallSortOption과
   *  같은 모양(서버 전용 모듈이라 여기서 import 불가, 타입만 그대로 옮겨 적음). */
  sortOptions?: (
    | { label: string; kind?: 'query'; paramsToAdd: Record<string, string> }
    | { label: string; kind: 'click'; clickText: string }
  )[]
  excludedCategoryHrefs?: string[]
  hasPaginationWidget: boolean
  report: MallStructureReport | null
  /** lib/scraper.ts의 MallProfileSignals.lastRunReportSource와 같은 모양 — 개발자모드가 siteLockStatus
   *  전이 감지 후 다시 GET할 때 이 값으로 thisRunReportSource를 재구성한다(아래 devmode 전용 useEffect 참고). */
  lastRunReportSource?: 'ai' | 'heuristic' | 'ollama' | 'groq' | null
  /** lib/scraper.ts의 MallProfileSignals.aiAnalysisElapsedSec와 같은 모양 — "AI로 결제/배송/업체정보
   *  분석 중..." 단계가 실제로 걸린 시간(초, 사용자 요청 2026-09-05). */
  aiAnalysisElapsedSec?: number
  /** lib/scraper.ts의 MallProfileSignals.totalElapsedSec와 같은 모양 — "몰 구조분석" 전체가 걸린 시간(초).
   *  aiAnalysisElapsedSec는 마지막 AI 리포트 단계 하나만 잰 값이라 화면에 그것만 보이면 "몰 구조분석
   *  전체"로 오해하기 쉬워(사용자 지적, 2026-09-09) 같이 보여준다. */
  totalElapsedSec?: number
  /** lib/scraper.ts의 MallProfileSignals.stepTimings와 같은 모양 — "몰 구조분석"의 각 단계(목록 페이지
   *  확인/카테고리 구조 확인/카테고리 하위구조 확인/정렬 옵션 확인/회사정보 확인/샘플 상품 확인/AI 분석
   *  등)가 각각 몇 초 걸렸는지. totalElapsedSec·aiAnalysisElapsedSec 둘만으론 "AI 아닌 나머지가 어디서
   *  오래 걸렸는지" 알 수 없어(사용자 지적, 2026-09-26) 추가. */
  stepTimings?: { label: string; elapsedSec: number }[]
  /** 몰 구조분석 도중/직후 로그인 세션이 끊긴 것으로 보이면 true — lib/scraper.ts의
   *  MallProfileSignals.sessionLostDuringAnalysis 주석 참고. */
  sessionLostDuringAnalysis?: boolean
  /** 위 경고와 같은 검사가 false였지만 분석 시작 시점부터 이미 그랬던 경우(=이 몰은 로그인 여부를 화면에
   *  드러내지 않는 몰) — lib/scraper.ts의 MallProfileSignals.loginSignalUnavailable 주석 참고. */
  loginSignalUnavailable?: boolean
  /** lib/scraper.ts의 MallProfileSignals.categoryScreenCheck와 같은 모양 — 화면(비전)으로 읽은 카테고리와
   *  최종 결과의 대조 결과. 화면 인식을 안 탔거나 실패한 실행에서는 없다(그땐 아무것도 표시하지 않는다). */
  categoryScreenCheck?: {
    screenNames: string[]
    /** 재검증으로 되살려 최종 목록에 다시 넣은 카테고리(lib/scraper.ts의 recoverMissingCategories) */
    recovered?: { name: string; href: string; evidence: string }[]
    missing: { name: string; reason: string }[]
    extra: string[]
    /** 같은 화면에서 같이 받아온 "대분류→하위 카테고리" 구조(lib/scraper.ts의
     *  detectVisibleCategoryHierarchy) — 사용자에게 "화면에서 본 구조"를 참고로 보여주는 용도(2026-09-15). */
    screenHierarchy?: { group: string; items: string[] }[]
    checkedAt: string
  } | null
  /** 카테고리 체크리스트 컬럼용 — previewCatalog가 저장해둔 카테고리별 개수(href 기준, 사용자 요청 2026-08-17) */
  categoryCounts?: Record<string, { count: number; truncated?: boolean; label: string; checkedAt: string }>
  /** 지난번 categoryLinks 갱신 때 새로 나타난 href 목록 — "발견된 카테고리 N개" 배지의 "새 카테고리 M개"용
   *  (사용자 요청, 2026-09-05, lib/scraper.ts의 MallProfileSignals와 같은 모양). */
  newCategoryHrefs?: string[]
  /** lib/scraper.ts의 MallProfileSignals.visionProviderLog와 같은 모양 — 카테고리/정렬 화면인식이 이번
   *  실행에서 실제로 Groq/Gemini/로컬 Ollama 중 뭘 썼는지(사용자 지시, 2026-09-22). */
  visionProviderLog?: { task: string; provider: 'groq' | 'gemini' | 'ollama' }[]
  /** lib/scraper.ts의 MallProfileSignals.aiReportAttempts와 같은 모양 — "몰 구조분석" AI 리포트가
   *  Anthropic→Gemini→Groq→Ollama 순으로 폴백하며 이번 실행에서 실제로 시도한 각 공급자의 결과
   *  (성공/실패·원인·걸린 시간, 사용자 지시 2026-09-23). */
  aiReportAttempts?: { provider: AiProviderId; model: string; elapsedMs: number; success: boolean; error?: string }[]
}

/** /api/scrape/site-lock-status의 응답 모양 — lastRunSignals는 busy:false일 때만 실려 온다(lib/scraper.ts의
 *  getSiteLastRunSignals 주석 참고: 개발자모드는 "몰 구조분석" HTTP 응답을 확장이 직접 받아가 PTP 탭이
 *  못 보므로, 이 폴링의 busy→false 전이에서 대신 가져가는 용도). */
interface SiteLockStatusInfo {
  busy: boolean
  label?: string
  sinceMs?: number
  detail?: string
  lastRunSignals?: { aiReportAttempts?: MallProfileSignals['aiReportAttempts']; visionProviderLog?: MallProfileSignals['visionProviderLog'] }
}

interface ProfileCheckResult {
  signals: MallProfileSignals
  diffs: string[]
  isFirstTime: boolean
  autoRuleFields: string[]
  thisRunReportSource: 'ai' | 'heuristic' | 'ollama' | 'groq' | null
  /** 서버 API가 채우는 필드가 아니라, 이 화면(handleSelectSite)이 sites.scrape_profile 캐시를 그대로
   *  되살릴 때만 클라이언트에서 직접 표시하는 값 — true면 diffs/isFirstTime이 이번에 실제로 비교/실행해서
   *  나온 값이 아니라 그냥 하드코딩된 빈 값([]/false)이라는 뜻이다. "몰 구조분석"/"구조 변화 감지"를
   *  방금 진짜로 돌린 결과는 이 필드 자체가 없다(undefined — 진짜 비교 결과이므로 배지를 그대로 믿어도
   *  된다). MallProfileResultDisplay 배지 로직이 이 값으로 "✓ 이전과 구조 동일"(방금 확인해서 안 바뀜)과
   *  "저장된 이전 결과"(이번엔 아무 확인도 안 하고 옛날 결과를 그냥 보여주는 중)를 구분해 보여준다
   *  (사용자 지적, 2026-09-02 — "이전과 구조 동일"이라는 문구가 캐시를 그냥 보여줄 때도 항상 떠서
   *  이번에 실제로 확인한 건지 옛날 결과인지 구분이 안 됐다). */
  isCachedRestore?: boolean
}

/** 개발자모드(크롬 확장) 몰의 새 세션 감지용 — /api/sessions?siteId= 응답 중 필요한 필드만. */
interface DevModeSession {
  id: number
  url: string
  status: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
}

/** "스크랩 대상" 카드의 "URL 불러오기"/"카테고리 불러오기" — 둘 다 같은 레벨의 대체 선택지라 같은
 *  틀(설명 + 버튼)을 강제로 공유하게 한다(따로 두면 스타일이 조금씩 어긋나기 쉽다는 게 실제로 확인된
 *  문제). 색(진한 teal → 흰 테두리형+✓)은 "스크랩 대상이 정해졌는지"라는 두 버튼 공통의 신호
 *  (`colorDone`)로 함께 바뀌게 하고, 라벨 텍스트만 각자 실제로 그 버튼을 눌러 성공했는지(`done`)로
 *  따로 바뀐다 — 하나만 성공했다고 색까지 서로 달라지던 문제(둘이 다른 버튼처럼 보임)를 막으면서도,
 *  누르지도 않은 버튼에 "불러옴"이라고 거짓 라벨을 붙이지 않는다. */
function ScrapeStepBox({ description, primary, secondary, onStop, children }: {
  description: string
  primary: {
    label: string; doneLabel: string; icon: string; loading?: boolean; loadingLabel?: string; done: boolean; colorDone?: boolean; onClick: () => void; disabled?: boolean
    /** devmode 전용 — 실제 작업이 몰 탭의 확장에 맡겨져 이 화면은 결과를 기다리기만 하는 동안(사용자가
     *  아직 확장을 안 눌렀을 수 있음) 버튼을 amber로 강조 + 글로우한다 — "🔍 몰 구조분석"/"🔍 스크랩
     *  미리보기" 버튼과 같은 패턴(사용자 요청, 2026-09-05). loading/done과 배타적으로, 이 화면이 결과를
     *  실제로 받으면(awaiting을 꺼주는 쪽 책임) 사라진다. */
    awaiting?: boolean
    /** awaiting 중 보여줄 라벨 — "🔍 스크랩 미리보기" 버튼처럼 "로그인한 몰에서 PTP 확장 실행" 같은
     *  안내문으로 바꿔야 색만 바뀌고 문구는 그대로인 반쪽짜리 통일이 되지 않는다(사용자 지적,
     *  2026-09-05: "현재 카테고리 가져오기 버튼도 같이 수정해줘"). 생략하면 기존 label을 그대로 쓴다. */
    awaitingLabel?: string
    /** devmode 전용 — "🔍 스크랩 미리보기"/"🎯 스크랩 대상 직접지정" 버튼처럼, 몰 탭 확장 아이콘도
     *  빨간 바탕에 흰 글자로 "PTP"라 같은 색 배지로 "이 버튼 = 저 아이콘"을 시각적으로 연결시킨다
     *  (2026-08-22 원본, 사용자 요청 2026-09-05로 이 버튼에도 확장). awaiting/loading 중엔(그 두 버튼과
     *  같은 이유로) 안 보여준다. */
    showPtpBadge?: boolean
  }
  secondary?: { label: string; title?: string; onClick: () => void; disabled?: boolean }
  /** 로딩 중일 때만 옆에 "⏹ 중지" 버튼을 보여준다(오래 걸리는 카테고리 불러오기 전용, 사용자 요청
   *  2026-08-26) — handleStopProfileMall의 "몰 구조분석 중지" 버튼과 같은 자리 배치. */
  onStop?: () => void
  children?: React.ReactNode
}) {
  const showDoneColor = primary.colorDone ?? primary.done
  return (
    <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-teal-700">{description}</p>
        <div className="flex items-center gap-2 shrink-0">
          {secondary && (
            <button type="button" onClick={secondary.onClick} disabled={secondary.disabled} title={secondary.title}
              className="px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-600 text-xs font-semibold rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {secondary.label}
            </button>
          )}
          {primary.loading && onStop && (
            <button type="button" onClick={onStop}
              className="px-3 py-1.5 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-xs font-semibold rounded-full transition-colors">
              ⏹ 중지
            </button>
          )}
          <button type="button" onClick={primary.onClick} disabled={primary.disabled}
            className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-colors shrink-0 flex items-center gap-1 disabled:cursor-not-allowed ${
              primary.awaiting
                ? 'bg-amber-50 border border-amber-400 text-amber-700 hover:bg-amber-100 animate-pulse-glow-amber disabled:opacity-100'
                : `disabled:opacity-50 ${showDoneColor
                  ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                  : 'bg-teal-500 hover:bg-teal-600 text-white'}`}`}>
            <span aria-hidden="true">{showDoneColor ? '✓' : primary.icon}</span>
            {primary.awaiting ? (primary.awaitingLabel || primary.label)
              : primary.loading ? (primary.loadingLabel || '처리 중...') : primary.done ? primary.doneLabel : primary.label}
            {primary.showPtpBadge && !primary.awaiting && !primary.loading && (
              <span className="ml-1 text-red-600 text-[10px] font-extrabold align-super">PTP</span>
            )}
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

/** 개발자모드 안내에서 각 단계를 어디서 하는지(PTP 화면 vs 실제 몰 탭) 한눈에 구분되게 하는 배지 —
 *  사용자 지적으로 안내를 다시 정리하며 추가(2026-08-15, "위치부터 먼저 표시해달라"). */
function DevModeLocationBadge({ where }: { where: 'ptp' | 'mall' }) {
  return (
    <span className={`inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold align-middle whitespace-nowrap ${
      where === 'ptp' ? 'bg-teal-100 text-teal-700' : 'bg-indigo-100 text-indigo-700'
    }`}>
      {where === 'ptp' ? 'PTP 화면' : '몰 탭'}
    </span>
  )
}

/** "몰 구조분석" 결과 표시 — 일반모드(로그인 카드)/개발자모드(개발자모드 안내 카드) 둘 다에서 공유한다
 *  (2026-08-15, 개발자모드도 몰 구조분석을 쓸 수 있게 되며 중복을 피하려고 추출). */
// "몰 구조분석"(deep=true)이 lib/scraper.ts의 sampleMallProfile에서 순서대로 거치는 단계 이름 —
// setSiteLockDetail이 남기는 detail 텍스트와 접두어로 매칭해 "지금 몇 단계째"를 보여주는 데 쓴다.
// 카테고리를 하나도 못 찾은 몰은 3/4번(하위구조·정렬 옵션)을 건너뛰므로 번호가 2→5로 비연속적으로
// 뛸 수 있는데, 그래도 "이번엔 몇 번째 단계"라는 정보 자체는 정확하다 — 몰마다 매번 정확히 7단계를
// 다 거친다고 보장할 순 없어(카테고리 유무에 따라 갈림) 억지로 채우지 않는다.
const MALL_PROFILE_STEP_ORDER = [
  '목록 페이지 확인 중', '카테고리 구조 확인 중', '카테고리 하위구조 확인 중', '정렬 옵션 확인 중',
  '회사정보/이용안내 페이지 확인 중', '샘플 상품', 'AI로 결제/배송/업체정보 분석 중',
]
// 위 MALL_PROFILE_STEP_ORDER와 같은 순서 — 진행 중 화면에 "지금 몇 단계째"뿐 아니라 7단계 전체가
// 각각 무엇인지도 같이 보여주기 위한 사람이 읽는 설명(사용자 지적, 2026-09-26 — "총 7단계 중 몇단계
// 표시만 되지 실지 무슨 작업 중인지를 알 수가 없다"). 3번 항목엔 4번(정렬 옵션 확인)을 같이 적어둔다 —
// 2026-09-26부터 정렬 옵션 확인이 카테고리 하위구조 확인과 병행 처리로 바뀌어(lib/scraper.ts의
// tryDetectSortDuringExpansion 주석 참고) 대부분 실행에서 4번은 화면에 아예 안 뜨고 3번 안에서 같이
// 끝난다 — 그 사실을 안내하지 않으면 "정렬 옵션은 언제 확인하나" 오해가 생긴다. 화면 인식이 전부
// 실패했을 때만 드물게 4번이 별도로 뜬다.
const MALL_PROFILE_STEP_LABELS = [
  '목록 페이지 확인',
  '카테고리 구조 확인',
  '카테고리 하위구조 확인 (정렬 옵션도 함께 확인)',
  '정렬 옵션 확인(보조) — 화면 인식이 전부 실패했을 때만 별도로 표시됨',
  '회사정보/이용안내 페이지 확인',
  '샘플 상품 확인',
  'AI 리포트 생성(결제/배송/업체정보 분석)',
]

/** 몰구조분석 리포트의 "카테고리 구조" 문장은 AI가 간결하게 요약한 텍스트라 정확한 개수를 안 담는다
 *  (Groq 출력 토큰 예산 때문에 항목마다 대표 몇 개만 들고 "등"으로 줄이도록 일부러 지시해둠) — "카테고리
 *  불러오기" 체크리스트가 보여주는 숫자(발견된 카테고리 N개)와 눈으로 비교하기 어렵다는 지적(2026-09-08,
 *  소꿉노리 실사용 확인 — 58개인데 리포트 문장만 봐서는 일치하는지 알 수 없었음)으로, AI 요약 문장 대신
 *  실제 categoryLinks(같은 몰구조분석이 방금 찾아 저장한 것)를 대분류별로 개별 항목까지 그대로 보여준다.
 *  예전엔 대분류별 "이름(개수)"만 한 줄로 뭉뚱그렸는데, 그러면 "카테고리(51)"처럼 몰의 최상위 메뉴 탭
 *  이름(실제 대분류가 아니라 "카테고리 전체보기" 같은 포괄 탭 라벨인 경우가 흔함) 밑에 실제로 어떤
 *  대/중/소분류 51개가 있는지 전혀 구분이 안 됐다(사용자 지적, 2026-09-15 — "합계로 요약하지 말고 개별
 *  내역을 구분해서 볼 수 있게 표시해"). buildCategoryTree(lib/categoryUrl.ts)로 대/중/소분류 단계 그대로
 *  중첩시켜 하위 항목 이름까지 나열한다 — AI가 "설명"한 게 아니라 실제 저장된 배열을 그대로 나열하는
 *  것이라 항상 categoryLinks 총 개수와 일치한다. */
function FieldTile({ icon, label, value }: { icon: string; label: string; value: string }) {
  const notFound = !value || value === '확인 안됨'
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100">
      <p className="text-[11px] font-semibold text-gray-500 tracking-wide mb-0.5">{icon} {label}</p>
      <p className={`text-xs leading-relaxed ${notFound ? 'text-gray-400 italic' : 'text-gray-700'}`}>{value || '확인 안됨'}</p>
    </div>
  )
}

/** "카테고리 구조" 타일 — AI 요약 문장(report.categoryStructure) 대신 이번 몰구조분석이 실제로 찾은
 *  categoryLinks를 대분류별로 묶어 개별 항목까지 **전부** 보여준다(사용자 지적, 2026-09-15 — "카테고리(51)
 *  → 합계 57개"처럼 뭉뚱그리면 실제로 어떤 대/중/소분류 57개인지 구분이 안 됨. 이후 "…외 N개"로 일부만
 *  보여준 것도 재지적 — "분석된 모든 카테고리를 확인 가능하게 모두 표시해": 개수 상한 없이 전부 나열한다).
 *  categoryLinks가 아직 없는 몰(카테고리를 못 찾은 경우)만 기존 AI 요약 문장으로 대체한다. */
// "대분류/중분류/소분류" 단계 이름에 집착하지 말고, 순전히 트리 구조(자식이 있는지)만으로 규칙을 정하라는
// 지시로 최종 확정(사용자 지시, 2026-09-24 — "대중소 분류에 집착하지말고, 중분류더라도 마지막 위치의
// 카테고리면 가로로 나열을 해. 다음 중분류면 다음 줄부터 시작을 해서 표시를 해. 그래야 실제 몰과 ptp
// 정렬을 쉽게 비교해서 맞는지 확인을 하기 쉬워"). 이전엔 "대분류/중분류는 몇 단이든 항상 자기 줄, 그
// 아래만 가로로" 식으로 단(레벨) 번호에 규칙을 고정해뒀는데, 그러면 실제 몰 메뉴 순서와 화면 표시 순서가
// 어긋나 보여(리프를 레벨별로 다시 묶어 재배치했으므로) 실제 몰과 나란히 비교하기 어려웠다.
// 새 규칙(각 형제 목록 안에서 원래 순서 그대로 훑으며): 자식이 없는(리프) 형제가 연달아 나오면 그만큼
// 한 줄에 "/"로 이어붙이고, 자식이 있는(브랜치) 형제를 만나면 그 지점에서 줄을 새로 잡아 자기 이름을
// 쓰고 그 아래에 같은 규칙을 재귀 적용한다 — 어느 깊이에서든 완전히 같은 규칙 하나만 적용되므로 "이건
// 중분류라서/소분류라서"를 따로 구분할 필요가 없다. 예전에 "리프를 아무 깊이에서나 가로로 묶는 방식"이
// 한 번 반려된 적이 있는데(주석 기록상 대분류 자체가 리프인 몰에서 서로 다른 부모의 리프가 한 줄에
// 섞여버림), 이번엔 항상 "같은 부모의 형제끼리만" 묶어(CategoryTreeRows가 한 번에 한 부모의 자식
// 목록만 받아 재귀) 그 문제를 재현하지 않는다.
/** nodes(같은 부모를 공유하는 형제 목록) 하나를 원래 순서 그대로 훑으며 그린다 — 연속된 리프는 한 줄에
 *  "/"로 묶고, 브랜치를 만나면 새 줄로 끊어 자기 이름 + 재귀 렌더링. 자식 목록을 받을 때마다 새로
 *  호출되므로 서로 다른 부모의 항목이 한 줄에 섞이는 일은 구조적으로 없다. */
function CategoryTreeRows({ nodes }: { nodes: CategoryTreeNode[] }) {
  const rows: React.ReactNode[] = []
  let pendingLeaves: CategoryTreeNode[] = []
  const flushLeaves = () => {
    if (!pendingLeaves.length) return
    const leaves = pendingLeaves
    rows.push(
      <p key={`leaves-${rows.length}`} className="text-gray-700">
        {leaves.map((g, i) => (
          <span key={i}>{g.name}{i < leaves.length - 1 ? <span className="text-gray-300"> / </span> : null}</span>
        ))}
      </p>,
    )
    pendingLeaves = []
  }
  nodes.forEach(node => {
    if (!node.children.length) {
      pendingLeaves.push(node)
      return
    }
    flushLeaves()
    rows.push(
      <div key={`branch-${rows.length}`}>
        <span className="font-medium text-gray-700">{node.name}</span>
        <span className="font-normal text-gray-400"> ({countCategoryTreeEntries(node)})</span>
        <div className="pl-3 mt-0.5 border-l border-gray-200 space-y-0.5">
          <CategoryTreeRows nodes={node.children} />
        </div>
      </div>,
    )
  })
  flushLeaves()
  return <>{rows}</>
}

/** 몰구조분석의 화면인식(카테고리/정렬)이 이번 실행에서 실제로 Groq/Gemini/로컬 Ollama 중 뭘 썼는지
 *  배지로 보여준다(사용자 지시, 2026-09-22 — "Groq 토큰 문제가 생기면 로컬로 넘어가는 건데, 어느 걸 쓰고
 *  있는지 화면에 표시해줄 수 있어?"). visionProviderLog는 화면인식 함수별로 성공한 공급자를 담은
 *  기록이라(MallProfileSignals.visionProviderLog 주석 참고), 이 타일과 관련된 task 이름들만 걸러
 *  요약한다 — 관련 화면인식이 하나도 성공 못 했으면(전부 실패해 AI 텍스트/DOM 폴백으로 처리됨) 배지
 *  없이 조용히 넘어간다(성공하지도 않은 걸 지어내지 않는다). Gemini는 Groq가 하루 한도에 걸렸을 때의
 *  2차 폴백으로 2026-09-25 추가(lib/ai.ts의 GEMINI_VISION_MODEL 주석 참고). */
// 라벨에 모델명까지 적는 건 AI_PROVIDER_OPTIONS/"AI 호출 상세" 패널과 같은 이유(2026-09-12 사용자
// 지시) — "Gemini"만 보이면 리포트용(gemini-flash-latest)인지 화면인식 전용(gemini-3.6-flash)인지
// 구분이 안 된다(사용자 지적, 2026-09-25 — "버전도 표시해줘"). 화면인식 4종은 공급자별로 모델이 고정
// (작업마다 안 바뀜)이라 AiReportAttempt처럼 실행마다 값을 들고 다닐 필요 없이 정적 표로 충분하다.
// 모델명은 lib/ai.ts의 GROQ_VISION_MODEL/GEMINI_VISION_MODEL/OLLAMA_VISION_MODEL과 반드시 일치해야
// 한다 — tests/unit/aiProviderLabels.test.ts가 검증 루프에서 이걸 강제한다.
const VISION_PROVIDER_BADGE: Record<'groq' | 'gemini' | 'ollama', { label: string; cls: string }> = {
  groq: { label: 'Groq(qwen3.8-27b)', cls: 'bg-emerald-100 text-emerald-700' },
  gemini: { label: 'Gemini(3.6-flash)', cls: 'bg-indigo-100 text-indigo-700' },
  ollama: { label: '로컬(qwen2.5vl:7b)', cls: 'bg-amber-100 text-amber-700' },
}
function VisionProviderBadge({ log, tasks }: { log?: { task: string; provider: 'groq' | 'gemini' | 'ollama' }[]; tasks: string[] }) {
  const matched = log?.filter(e => tasks.includes(e.task)) ?? []
  if (!matched.length) return null
  const used = [...new Set(matched.map(e => e.provider))]
  const label = used.map(p => VISION_PROVIDER_BADGE[p].label).join('+')
  const cls = used.length === 1 ? VISION_PROVIDER_BADGE[used[0]].cls : 'bg-sky-100 text-sky-700'
  return (
    <span className={`ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${cls}`}
      title="이번 몰구조분석에서 이 화면인식에 실제로 성공한 AI 공급자 — Groq가 한도 초과 등으로 실패하면 Gemini로, 그마저 안 되면 자동으로 로컬 Ollama로 넘어간다.">
      {label}
    </span>
  )
}

function CategoryStructureTile({ categoryLinks, fallback, visionProviderLog }: {
  categoryLinks: { name: string; href: string }[] | undefined; fallback: string
  visionProviderLog?: { task: string; provider: 'groq' | 'gemini' | 'ollama' }[]
}) {
  const tree = buildCategoryTree(categoryLinks)
  // 총 몇 개인지가 안 보이면 안 된다는 지적(사용자, 2026-09-15) — 대분류별 개수 옆에, 제목에도 전체
  // 합계를 같이 보여준다(categoryLinks.length와 항상 일치 — buildCategoryTree는 항목을 빠뜨리지 않고
  // 트리로만 재배치하므로).
  const totalCount = categoryLinks?.length ?? 0
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100 sm:col-span-2">
      <p className="text-[11px] font-semibold text-gray-500 tracking-wide mb-1">
        🗂️ 카테고리 구조{tree.length ? <span className="font-normal text-gray-400"> (총 {totalCount}개)</span> : null}
        <VisionProviderBadge log={visionProviderLog} tasks={['카테고리 계층', '카테고리 메뉴 트리거', '카테고리 후보 선별']} />
      </p>
      {tree.length ? (
        <div className="text-[11px] text-gray-600 leading-relaxed space-y-1.5 max-h-56 overflow-y-auto pr-1"
          title='AI 요약이 아니라, 이 몰구조분석이 방금 찾아 저장한 categoryLinks를 원래 순서 그대로 펼친 것입니다(하위가 없는 항목은 "/"로 가로로 이어붙이고, 하위가 있는 항목만 자기 줄을 받아 그 아래를 같은 규칙으로 펼침) — "카테고리 불러오기"의 목록과 항상 일치해야 정상입니다.'>
          <CategoryTreeRows nodes={tree} />
        </div>
      ) : (
        <p className={`text-xs leading-relaxed ${!fallback || fallback === '확인 안됨' ? 'text-gray-400 italic' : 'text-gray-700'}`}>{fallback || '확인 안됨'}</p>
      )}
    </div>
  )
}

/** "정렬 구조" 타일 — 이미 클릭/URL 검증까지 거친 sortOptions 배열이 있으면 그걸 그대로 나열한다(AI가
 *  20,000자 원문을 다시 문장으로 요약한 report.sortStructure보다 구조적으로 더 정확 — buildMallReportPrompt
 *  주석 참고, sortHints 자체가 이미 "구조적으로 확정된 값"이라고 명시함). 없을 때만 그 문장으로 대체한다
 *  (카테고리 구조 타일과 같은 원칙, 사용자 지시 2026-09-15). */
function SortStructureTile({ sortOptions, fallback, visionProviderLog }: {
  sortOptions?: ({ label: string; kind?: 'query'; paramsToAdd: Record<string, string> } | { label: string; kind: 'click'; clickText: string })[]
  fallback: string
  visionProviderLog?: { task: string; provider: 'groq' | 'gemini' | 'ollama' }[]
}) {
  // 카테고리 구조 타일과 같은 이유로 세로 목록 대신 한 줄로 흘려보낸다(사용자 지시, 2026-09-15 — "정렬구조도
  // 가로로 이어서 표시해줘") — 항목 사이는 " · "로만 구분한다(대분류가 없어 "//" 구분은 필요 없음).
  const flat = sortOptions?.length
    ? sortOptions.map(o => o.kind === 'click' ? `${o.label}(클릭: ${o.clickText})` : o.label).join(' · ')
    : ''
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100">
      <p className="text-[11px] font-semibold text-gray-500 tracking-wide mb-0.5">
        ↕️ 정렬 구조
        <VisionProviderBadge log={visionProviderLog} tasks={['정렬 라벨', '정렬 트리거']} />
      </p>
      {sortOptions?.length ? (
        <p className="text-[11px] text-gray-600 leading-relaxed break-words"
          title="AI 요약 문장이 아니라, 실제로 클릭/URL 검증까지 거쳐 확인된 정렬 옵션 목록입니다.">
          {flat}
        </p>
      ) : (
        <p className={`text-xs leading-relaxed ${!fallback || fallback === '확인 안됨' ? 'text-gray-400 italic' : 'text-gray-700'}`}>{fallback || '확인 안됨'}</p>
      )}
    </div>
  )
}

function MallProfileResultDisplay({ error, result, loading, detail, elapsedSec, sinceMs }: { error: string; result: ProfileCheckResult | null; loading?: boolean; detail?: string; elapsedSec?: number | null; sinceMs?: number }) {
  if (!error && !result && !loading) return null
  const mallProfileStepIndex = detail ? MALL_PROFILE_STEP_ORDER.findIndex(s => detail.startsWith(s)) : -1
  // 로딩 중엔 결과가 나올 자리에 같은 모양(그리드)의 스켈레톤을 먼저 보여주고, 도착하면 그 자리에 실제
  // 값이 그대로 채워지는 형태로 바꿨다 — 예전엔 버튼 글자만 "분석 중..."으로 바뀌고 화면엔 아무것도 안
  // 나타나 몇 분씩 걸리는 이 작업이 멈춘 것처럼 보였다(사용자 지적, 2026-08-16). 카드 자체를 구분선이
  // 아니라 완전히 독립된 박스로 둬서 바로 아래 "카테고리 불러오기"와 확실히 나뉘어 보이게 한다.
  if (loading) {
    return (
      <div className="mt-4 bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-base leading-none animate-spin">🔄</span>
          <span className="text-xs font-semibold text-gray-500">
            {/* 항상 오래 걸리는데 지금 뭘 하는지 알 방법이 없다는 지적(2026-08-22)으로, 서버/확장이
                lib/scraper.ts의 setSiteLockDetail에 남긴 세부 단계를 그대로 보여준다 — 아직 안 왔으면
                (락이 아직 안 잡혔거나 단계 전환 사이의 짧은 틈) 기존 문구로 대체한다. 몇 단계 중 몇
                번째인지도 같이 보여달라는 요청(2026-09-02)으로, 알려진 단계 순서(MALL_PROFILE_STEP_ORDER)에
                매칭되면 "(N/7단계)"를 앞에 붙인다 — 카테고리가 없는 몰은 일부 단계를 건너뛰어 번호가
                비연속적으로 뛸 수 있지만, "지금 몇 번째 단계"라는 정보 자체는 정확하다. */}
            {mallProfileStepIndex >= 0 && `(${mallProfileStepIndex + 1}/${MALL_PROFILE_STEP_ORDER.length}단계) `}
            {detail || '몰 구조를 분석하는 중입니다 — 몰 상태에 따라 몇 분 정도 걸릴 수 있습니다.'}
            {/* elapsedSec(클라이언트가 직접 fetch를 걸어 startedAt을 아는 PTP 버튼 경로)는 확장이 시작한
                실행에서는 항상 null이라 개발자모드에선 여기 소요시간이 전혀 안 보였다(사용자 지적,
                2026-08-29) — 서버 락 자체가 age(sinceMs)를 이미 들고 있으므로(siteLockStatus 폴링,
                2026-08-11 도입) 트리거 경로와 무관하게 이걸로 표시한다. */}
            {sinceMs != null && ` · ${formatElapsedSeconds(Math.round(sinceMs / 1000))}째`}
          </span>
        </div>
        {mallProfileStepIndex >= 0 && (
          <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-teal-400 transition-all duration-500"
              style={{ width: `${Math.round(((mallProfileStepIndex + 1) / MALL_PROFILE_STEP_ORDER.length) * 100)}%` }}
            />
          </div>
        )}
        {/* 진행률 바(위)는 "몇 %인지"는 보여줘도 "그 7단계가 각각 뭘 하는 단계인지"는 안 보여준다 —
            사용자 지적(2026-09-26): "총 7단계 중 몇단계 표시만 되지 실지 무슨 작업 중인지를 알 수가
            없다." mallProfileStepIndex가 안 잡힌 동안(락이 막 걸렸거나 단계 전환 사이의 짧은 틈)은
            아직 어느 단계인지 확정할 수 없으니 목록 자체를 숨긴다. */}
        {mallProfileStepIndex >= 0 && (
          <ol className="mb-3 space-y-1">
            {MALL_PROFILE_STEP_LABELS.map((label, i) => (
              <li key={label} className={`text-[11px] leading-relaxed flex gap-1.5 ${
                i < mallProfileStepIndex ? 'text-gray-400'
                : i === mallProfileStepIndex ? 'text-teal-700 font-semibold' : 'text-gray-300'
              }`}>
                <span className="shrink-0">{i < mallProfileStepIndex ? '✓' : i === mallProfileStepIndex ? '▶' : `${i + 1}.`}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {Array.from({ length: 11 }).map((_, i) => (
            <div key={i} className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100 animate-pulse">
              <div className="h-2.5 w-20 bg-gray-200 rounded mb-2" />
              <div className="h-2.5 w-full bg-gray-200 rounded" />
              <div className="h-2.5 w-2/3 bg-gray-200 rounded mt-1.5" />
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <>
      {error && <p className="text-xs text-rose-500 mt-3">{error}</p>}
      {result && (
        <div className="mt-4 bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            {/* isCachedRestore(ProfileCheckResult 주석 참고)면 diffs/isFirstTime이 이번에 실제로 비교해서
                나온 값이 아니라 그냥 저장된 옛날 결과를 보여주는 것뿐이다 — "이전과 구조 동일"이라고 하면
                "방금 확인해보니 안 바뀌었다"는 뜻으로 오해하기 쉬워(사용자 지적, 2026-09-02) 아예 다른
                문구("저장된 이전 분석 결과 표시 중")로 구분한다. */}
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              result.isCachedRestore ? 'bg-sky-100 text-sky-700'
              : result.isFirstTime ? 'bg-teal-100 text-teal-700'
              : result.diffs.length ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
            }`}
              title={result.isCachedRestore ? '방금 새로 분석/확인한 게 아니라, 저장돼 있던 이전 "몰 구조분석" 결과를 그대로 보여주고 있습니다 — 최신 상태인지 확인하려면 "몰 구조분석"을 다시 눌러주세요.' : undefined}>
              {result.isCachedRestore ? '📋 저장된 이전 분석 결과 표시 중'
                : result.isFirstTime ? '🔍 몰 구조분석 완료' : result.diffs.length ? '⚠ 이전과 구조가 달라짐' : '✓ 이전과 구조 동일(방금 확인함)'}
            </span>
            <span className="text-xs text-gray-400">상품 {result.signals.sampleCount}건 샘플 기준</span>
            {elapsedSec != null && <span className="text-xs text-gray-400">· 소요시간 {formatElapsedSeconds(elapsedSec)}</span>}
            {/* result.signals.report.generatedBy는 "최종 화면에 보이는 리포트의 출처"일 뿐, "이번 실행이
                직접 만들었는지"와는 다르다 — AI 호출이 실패하면 lib/scrape/mallProfile.ts가 예전에 성공한
                (클라우드) AI 리포트를 그대로 이어받도록 짜여있어(안전장치), generatedBy만 보면 이번에도
                성공한 것처럼 보인다. thisRunReportSource === 'heuristic'(이번 실행에서 켜둔 AI 공급자가
                전부 진짜로 실패해 최후의 규칙 기반까지 떨어졌다는 뜻)만 "AI 호출 실패"로 본다 — null(캐시
                복원, handleSelectSite 참고)까지 이 경고로 묶으면 실패하지도 않았는데 실패했다고 잘못
                알리게 된다(2026-09-01, Anthropic 크레딧 소진+Gemini 과부하가 겹쳤을 때 화면엔 아무 신호
                없이 예전 리포트가 계속 보여 원인을 알 방법이 없었다는 지적).
                thisRunReportSource가 'groq'/'ollama'는 다르다 — 이건 "이번 실행 자체는 AI 호출에
                성공"했다는 뜻이라 실패가 아니다. 다만 preferPrev(mallProfile.ts)가 그 결과보다 예전
                클라우드 AI 리포트를 더 신뢰해 그대로 유지했을 수 있어, generatedBy만 보면 이번에도 그
                예전 AI가 성공한 것처럼 보인다 — "AI 호출 실패"가 아니라 "이번엔 성공했지만 더 믿을만한
                예전 결과를 그대로 쓰는 중"이라고 정확히 구분해 알린다(2026-09-03 실사용 확인 — Groq가
                분명히 성공(thisRunReportSource: groq)했는데도 화면엔 "AI 호출 실패"로 잘못 떴었음 —
                이 조건이 heuristic과 groq/ollama를 구분 없이 한 묶음으로 처리했던 게 원인).
                배지 문구의 "이전 결과 유지 중"만으로는 "이번 몰 구조분석 자체가 잘못됐다"는 뜻으로 오해할
                수 있어(사용자 지적, 2026-09-03) "AI 분석 성공"을 앞에 붙였다 — 이번 실행은 정상 성공했고,
                단지 그 결과 대신 더 신뢰도 높은 예전 리포트를 화면에 쓴다는 것만 전달한다. */}
            {result.signals.report && (() => {
              // 전체 소요시간(totalElapsedSec)·AI 리포트 단계 소요시간(aiAnalysisElapsedSec)은 generatedBy
              // 분기와 무관하게 항상 같은 실행에서 나온 값이라, 배지 종류에 상관없이 공통으로 붙인다 —
              // 예전엔 "AI 분석 성공(이전 리포트 유지 중)" 배지에만 붙어 있어서, 훨씬 흔한 "🤖 AI 분석"
              // (이번 실행이 직접 성공한 경우) 배지엔 아예 안 보였다(사용자 지적, 2026-09-09 — "총 걸린
              // 시간과 AI가 사용한 시간을 적기로 했는데 왜 안 보이지").
              const elapsedSuffix = <>
                {result.signals.totalElapsedSec != null && ` · ${formatElapsedSeconds(Math.round(result.signals.totalElapsedSec))}`}
                {result.signals.aiAnalysisElapsedSec != null && `(AI ${formatElapsedSeconds(Math.round(result.signals.aiAnalysisElapsedSec))})`}
              </>
              return result.thisRunReportSource === 'heuristic' && result.signals.report.generatedBy === 'ai' ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700"
                  title="이번 분석에서는 켜둔 AI 공급자가 모두 실패해(크레딧 부족·일시 과부하 등) 새로 만들지 못했습니다 — 예전에 성공했던 AI 리포트를 그대로 보여주고 있어 최신 상태가 아닐 수 있습니다. 잠시 후 다시 시도해보세요.">
                  ⚠ AI 호출 실패 — 이전 리포트 표시 중{elapsedSuffix}
                </span>
              ) : (result.thisRunReportSource === 'groq' || result.thisRunReportSource === 'ollama') && result.signals.report.generatedBy === 'ai' ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-teal-100 text-teal-700"
                  title={`이번 실행은 ${result.thisRunReportSource === 'groq' ? 'Groq' : 'Ollama'}로 성공했지만, 예전에 더 신뢰할 만한 클라우드 AI(Anthropic/Gemini) 리포트가 있어 그걸 그대로 보여주고 있습니다 — 실패가 아닙니다.`}>
                  🤖 AI 분석 성공(이전 리포트 유지 중){elapsedSuffix}
                </span>
              ) : result.signals.report.generatedBy === 'ai' ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-teal-100 text-teal-700">🤖 AI 분석{elapsedSuffix}</span>
              ) : result.signals.report.generatedBy === 'groq' ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-100 text-violet-700"
                  /* 모델명은 lib/ai.ts의 GROQ_MODEL과 같이 맞춘다 — 클라이언트 번들에 lib/ai.ts를 못 들여와 문자열로 중복한다.
                     예전엔 여기에 이미 교체된 옛 모델명이 남아 있었다(2026-09-12 수정, tests/unit/aiProviderLabels.test.ts가 재발을 막는다). */
                  title="Anthropic/Gemini 호출이 모두 실패해 무료 Groq(qwen3.8-27b)로 대신 분석했습니다 — 도입 초기라 이 추출 작업의 정확도가 아직 충분히 검증되지 않았습니다.">
                  🚀 Groq 분석{elapsedSuffix}
                </span>
              ) : result.signals.report.generatedBy === 'ollama' ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-sky-100 text-sky-700"
                  title="Anthropic/Gemini/Groq 호출이 모두 실패해 로컬 Ollama(qwen3:8b)로 대신 분석했습니다 — 클라우드 AI보다 이런 종합 추출 정확도가 낮을 수 있습니다.">
                  🖥️ 로컬 AI(Ollama) 분석{elapsedSuffix}
                </span>
              ) : (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700"
                  title="AI 호출이 전부 실패해(크레딧 부족·Ollama 미실행 등) 정규식/키워드 매칭으로 대신 채운 결과입니다 — AI 분석보다 정확도가 낮을 수 있습니다.">
                  ⚠ 규칙 기반 (AI 아님){elapsedSuffix}
                </span>
              )
            })()}
          </div>
          {/* totalElapsedSec·aiAnalysisElapsedSec 둘만으론 "AI 아닌 나머지 단계 중 어디가 오래 걸렸는지"
              전혀 알 수 없다는 지적(사용자, 2026-09-26 — "실제 몰구조분석 시간이 훨씬 오래 걸렸어. 왜
              저렇게밖에 안나오지? AI뿐만이 아니라 전체적으로 어떤 내용으로 얼마나 시간이 걸린 건지를
              파악할 수 있게"). 로딩 중 진행 표시(MALL_PROFILE_STEP_ORDER)와 같은 단계 이름으로, 완료 뒤엔
              각 단계가 실제로 몇 초/전체의 몇 %였는지 펼쳐볼 수 있게 한다 — 가장 오래 걸린 단계를 굵게
              표시해 "왜 오래 걸렸는지"에 바로 답한다. */}
          {result.signals.stepTimings && result.signals.stepTimings.length > 0 && (
            <details className="mb-3 text-xs bg-gray-50 rounded-lg px-3 py-2">
              <summary className="cursor-pointer font-semibold text-gray-500">단계별 소요시간 ({result.signals.stepTimings.length}단계)</summary>
              <ul className="mt-1.5 space-y-0.5">
                {(() => {
                  const timings = result.signals.stepTimings!
                  const total = result.signals.totalElapsedSec ?? timings.reduce((sum, t) => sum + t.elapsedSec, 0)
                  const maxSec = Math.max(...timings.map(t => t.elapsedSec))
                  return timings.map((t, i) => {
                    const pct = total > 0 ? Math.round((t.elapsedSec / total) * 100) : null
                    const isSlowest = maxSec > 0 && t.elapsedSec === maxSec
                    return (
                      <li key={i} className={isSlowest ? 'text-amber-700 font-semibold' : 'text-gray-600'}>
                        {t.label} · {formatElapsedSeconds(Math.round(t.elapsedSec))}{pct != null ? ` (전체의 ${pct}%)` : ''}
                      </li>
                    )
                  })
                })()}
              </ul>
            </details>
          )}
          {/* "AI 호출 실패"/"AI 분석 성공(이전 리포트 유지 중)" 배지만 봐서는 어느 공급자가 왜 실패했는지
              (크레딧 부족/레이트리밋/타임아웃 등) 알 수 없다는 지적(사용자 지시, 2026-09-23)으로, 이번
              실행에서 실제로 시도한 공급자별 결과를 펼쳐볼 수 있게 한다 — 시도가 하나도 없으면(aiProviders를
              전부 꺼둔 채 곧장 규칙 기반으로 간 경우) 아무것도 안 보인다. */}
          {result.signals.aiReportAttempts && result.signals.aiReportAttempts.length > 0 && (
            <details className="mb-3 text-xs bg-gray-50 rounded-lg px-3 py-2">
              <summary className="cursor-pointer font-semibold text-gray-500">AI 호출 상세 ({result.signals.aiReportAttempts.length}개 공급자 시도)</summary>
              <ul className="mt-1.5 space-y-0.5">
                {result.signals.aiReportAttempts.map((a, i) => {
                  // 공급자 라벨(AI_PROVIDER_OPTIONS)엔 Ollama처럼 작업에 따라 모델이 갈리는 경우가 있어
                  // (14b는 후보 선별, 8b는 이 리포트 생성) 라벨의 괄호 설명 대신 이번 시도가 실제로 쓴
                  // 모델(a.model)을 직접 붙인다 — "Ollama(qwen3:8b)"처럼 어느 모델이 쓰였는지 헷갈리지 않게.
                  const providerName = AI_PROVIDER_OPTIONS.find(o => o.id === a.provider)?.label.split('(')[0].trim() ?? a.provider
                  return (
                    <li key={i} className={a.success ? 'text-teal-700' : 'text-rose-600'}>
                      {a.success ? '✓' : '✗'} {providerName}({a.model})
                      {' · '}{(a.elapsedMs / 1000).toFixed(1)}초{!a.success && a.error ? ` · ${a.error}` : ''}
                    </li>
                  )
                })}
              </ul>
            </details>
          )}
          {/* 분석 도중/직후 로그인 세션이 끊긴 것으로 보이는 경우 — lib/scraper.ts의
              MallProfileSignals.sessionLostDuringAnalysis 주석 참고. 원인은 아직 정확히 확정되지 않았고
              (걸스굽 실사용 확인, 2026-09-01) 이 경고 자체가 약한 신호(로그아웃 링크를 못 찾음)라 확정
              문구 대신 "로 보입니다"로 표현한다 — 리포트 결과는 그대로 보여주되(로그인 안 된 상태로
              수집된 정보라 부정확할 수 있음), 사용자가 화면만 봐서는 알 수 없던 걸 바로 알려준다. */}
          {result.signals.sessionLostDuringAnalysis && (
            <p className="mb-3 text-xs text-rose-700 bg-rose-50 rounded-lg px-3 py-2">
              ⚠ 분석 도중 로그인 세션이 끊긴 것으로 보입니다 — 로그인 창을 다시 확인해주세요. 위/아래 결과 중 일부는 로그인 안 된 상태로 수집됐을 수 있습니다.
            </p>
          )}
          {/* sessionLostDuringAnalysis와 같은 검사(로그아웃 문구/아이콘 못 찾음)가 걸렸지만, 분석을
              시작하기도 전인 시점부터 이미 그랬던 경우 — "분석 도중 끊겼다"가 아니라 이 몰이 애초에
              로그인 여부를 화면에 드러내지 않는 몰이라는 뜻이다(lib/scraper.ts의
              classifySessionLossSignal/loginSignalUnavailable 주석 참고, 2026-09-15 사용자 지적 — "이런
              몰의 경우 메시지를 수정해. 몰 특성 때문에 그렇다는 내용으로"). 경고가 아니라 안내라 rose 대신
              중립 색을 쓴다. */}
          {result.signals.loginSignalUnavailable && (
            <p className="mb-3 text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
              ℹ️ 이 몰은 로그인 여부를 화면에서 확인할 수 있는 신호가 없어, 실제 로그인 상태와 무관하게 이 안내가 표시될 수 있습니다(몰 특성) — 결과 품질에는 영향이 없을 수 있습니다.
            </p>
          )}
          {result.diffs.length > 0 && (
            <ul className="mb-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
              {result.diffs.map(d => <li key={d}>· {d}</li>)}
            </ul>
          )}
          {/* 화면 대조 — 카테고리를 "사람이 보는 화면" 기준으로 찾았으면, 최종 결과가 그 화면과 맞는지까지
              되짚어 보여준다(사용자 지시, 2026-09-13: "화면을 통해 카테고리를 파악했으면, 마지막 결과가
              그 화면의 카테고리와 맞는지, 안 맞는 건 어떤 건지 왜 그런지 피드백을 줄 수 있게 해야지").
              화면 인식을 안 탔거나 실패한 실행에서는 categoryScreenCheck 자체가 없어 아무것도 안 보인다. */}
          {result.signals.categoryScreenCheck && (() => {
            // "화면의 대분류 탭(그룹 제목)일 뿐 링크가 없어 저장 안 함(정상)"은 buildCategoryScreenCheck가
            // 이미 확정적으로 "문제 없음"이라고 판정해준 것이다 — 그런데도 ⚠ 경고 스타일로 항목까지 일일이
            // 늘어놓으면, 열어볼 때마다 "확인할 게 없는데 확인하라"는 걸로 보인다(사용자 지적, 2026-09-23 —
            // "이 내용은 특별히 확인할 내용이 없어... 제거해"). 진짜 원인 불명(탐지 실패) 또는 excluded 사유가
            // 붙은 항목만 "확인이 필요한 missing"으로 걸러 보여주고, 전부 (정상)뿐이면 다 담긴 것과 똑같이
            // 취급한다 — recovered(재검증으로 되살린 카테고리)는 반대로 "1차 탐지가 실제로 놓쳤다"는 신호라
            // 그대로 둔다(정상 판정이 없다).
            const realMissing = result.signals.categoryScreenCheck.missing.filter(m => !m.reason.endsWith('(정상)'))
            const recovered = result.signals.categoryScreenCheck.recovered ?? []
            // 문제/조치가 하나도 없으면(재검증으로 되살린 것도, 진짜 missing도 없음) "✓ 다 담겼습니다"라는
            // 안심 문구조차 안 보여준다 — 그 문구도 확인할 게 없는데 매번 보게 되는 내용이라는 지적(사용자
            // 지시, 2026-09-23)과 같은 이유. 실제로 뭔가 있을 때만(되살림 또는 진짜 누락) 이 박스 자체가 뜬다.
            if (!recovered.length && !realMissing.length) return null
            return (
              <div className={`mb-3 text-xs rounded-lg px-3 py-2 ${realMissing.length ? 'text-amber-800 bg-amber-50' : 'text-emerald-800 bg-emerald-50'}`}>
                {/* 재검증으로 되살린 카테고리 — "화면엔 보이는데 결과에 없으면 다른 방법으로 다시 확인하라"는
                    지시(2026-09-13)에 따라 추가된 단계의 결과다. 무엇을 근거로 되살렸는지까지 보여준다.
                    노이즈는 아니지만(1차 탐지가 실행마다 다르게 나온다는 실제 신호) 매번 펼쳐진 채로 항목을
                    다 늘어놓으면 화면을 많이 차지한다는 지적(사용자 지시, 2026-09-23 — "펼치면 보는 형태로
                    해")으로, 개수만 항상 보이고 목록은 기본 접어둔다. */}
                {!!recovered.length && (
                  <details className={`${realMissing.length ? 'mb-2 pb-2 border-b border-current/20' : ''}`}>
                    <summary className="font-medium cursor-pointer select-none">🛟 화면에는 있는데 빠졌던 카테고리 {recovered.length}개를 재검증으로 되살렸습니다</summary>
                    <ul className="mt-0.5 space-y-0.5">
                      {recovered.slice(0, 12).map(r => (
                        <li key={r.href}>· <span className="font-medium">{r.name}</span> — {r.evidence}</li>
                      ))}
                    </ul>
                    {recovered.length > 12 && (
                      <p className="mt-0.5">…외 {recovered.length - 12}개</p>
                    )}
                  </details>
                )}
                {!!realMissing.length && (
                  <>
                    <p className="font-medium mb-1">
                      ⚠ 화면에는 보이는데 결과에 없는 카테고리 {realMissing.length}개
                      <span className="font-normal text-amber-700"> (화면에서 읽은 {result.signals.categoryScreenCheck.screenNames.length}개 기준)</span>
                    </p>
                    <ul className="space-y-0.5">
                      {realMissing.slice(0, 12).map(m => (
                        <li key={m.name}>· <span className="font-medium">{m.name}</span> — {m.reason}</li>
                      ))}
                    </ul>
                    {realMissing.length > 12 && (
                      <p className="mt-1 text-amber-700">…외 {realMissing.length - 12}개</p>
                    )}
                  </>
                )}
              </div>
            )
          })()}
          {result.autoRuleFields.length > 0 && (
            <p className="mb-3 text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2">
              ✓ 이 결과로 추출규칙 자동 생성됨: {result.autoRuleFields.join(', ')} — 이후 미리보기/스크랩부터 바로 적용됩니다.
            </p>
          )}
          {result.signals.report ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <FieldTile icon="🔗" label="URL 계층" value={result.signals.report.urlHierarchy} />
              <CategoryStructureTile categoryLinks={result.signals.categoryLinks} fallback={result.signals.report.categoryStructure} visionProviderLog={result.signals.visionProviderLog} />
              <SortStructureTile sortOptions={result.signals.sortOptions} fallback={result.signals.report.sortStructure} visionProviderLog={result.signals.visionProviderLog} />
              {([
                ['🏦', '은행명', result.signals.report.bankName],
                ['🔢', '계좌번호', result.signals.report.accountNumber],
                ['🚚', '배송 택배사', result.signals.report.shippingCourier],
                ['💰', '택배비/배송비', result.signals.report.shippingFeeInfo],
                ['📮', '배송/반품 주소지', result.signals.report.returnAddress],
                ['📦', '재고 관리 형태', result.signals.report.stockManagementType],
                ['☎️', '업체 연락처', result.signals.report.companyContact],
                ['🧩', '상품페이지 구조', result.signals.report.productPageStructure],
                ['⚠️', '스크래핑 유의사항', result.signals.report.scrapingNeeds],
              ] as const).map(([icon, label, value]) => (
                <FieldTile key={label} icon={icon} label={label} value={value} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-amber-600">AI 리포트를 만들지 못했습니다 (ANTHROPIC_API_KEY 미설정·크레딧 부족 등 API 호출 실패이거나 홈/게시판 원문을 못 모았습니다 — 서버 콘솔 로그 확인) — 아래 참고정보만 확인됩니다.</p>
          )}
          <div className="flex flex-wrap gap-1.5 mt-3">
            <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">플랫폼 {result.signals.platform}</span>
            {result.signals.optionUiTypes.length > 0 && (
              <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">
                옵션 UI {result.signals.optionUiTypes.join('/')}{result.signals.hasCascadingOptions && ' (연쇄옵션)'}
              </span>
            )}
            {!result.signals.report && result.signals.categoryMenuNames.length > 0 && (
              <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">
                카테고리 메뉴 {result.signals.categoryMenuNames.length}개: {result.signals.categoryMenuNames.join(', ')}
              </span>
            )}
            {!result.signals.hasPaginationWidget && (
              <span className="text-[11px] bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-2 py-0.5">
                페이지네이션 위젯 없음 — 미리보기 카테고리 개수 확인 시 지수 탐색으로 바로 진행
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export function ScraperPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, bumpRefresh, setGuidance, refreshSignals } = useTabs()
  const { labels: registryLabels } = useRegisteredFieldKeys()
  const fixedFieldLabel = useMemo(() => {
    const m = new Map(DEFAULT_FIELD_LABEL)
    registryLabels.forEach((v, k) => m.set(k, v))
    return m
  }, [registryLabels])
  // 미리보기 표의 컬럼 구성/순서는 기준 마스터테이블관리(master_schema_fields)를 그대로 따라간다 —
  // 등록 순서(sort_order)대로 보여주고, 아직 레지스트리가 안 불러와졌으면 기본 15개 순서로 잠깐 대체한다.
  const masterOrderedKeys = useMemo(
    () => registryLabels.size > 0 ? Array.from(registryLabels.keys()) : FIXED_FIELD_INFO.map(f => f.key),
    [registryLabels],
  )
  const initialSiteId = params?.siteId as number | undefined
  const initialClientId = params?.clientId as number | undefined
  const [sites, setSites]         = useState<Site[]>([])
  const [clients, setClients]     = useState<Client[]>([])
  const [clientFilter, setClientFilter] = useState<number | ''>(initialClientId ?? '')
  const [siteQuery, setSiteQuery] = useState('')
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [siteSortKeys, setSiteSortKeys] = useState<SitePickerSortKey[]>([])
  const [siteColFilters, setSiteColFilters] = useState<Record<string, string>>({})
  const [siteShowFilters, setSiteShowFilters] = useState(false)
  const [mallSelectCollapsed, setMallSelectCollapsed] = useState(false)
  const [devModeGuideCollapsed, setDevModeGuideCollapsed] = useState(false)
  // 위 단계를 끝내고 아래 단계로 넘어갈 때, 끝난 위 카드들을 접어서 지금 진행 중인 아래 내용이 화면에
  // 더 잘 보이게 한다(Mall 선택/개발자모드 안내와 같은 패턴) — 순차 작업 중 스크롤을 덜 하게 하려는 것.
  const [loginCardCollapsed, setLoginCardCollapsed] = useState(false)
  const [scrapeTargetCollapsed, setScrapeTargetCollapsed] = useState(false)
  // 개발자모드 "카테고리 URL 목록 만들기" — 수동(로그인 창에서 하나씩)/자동(전체 한 번에) 두 방법은
  // 서로 대체 관계인 선택이라 결과 화면(텍스트박스 vs 체크리스트)까지 완전히 다르다 — 둘을 나란히
  // 동시에 보여주면 "지금 어느 방법을 쓰고 있는지" 헷갈린다는 지적(2026-08-22)으로, 명시적인 모드
  // 전환(탭)으로 바꿔 한 번에 한 흐름만 보이게 한다.
  const [categorySourceMode, setCategorySourceMode] = useState<'auto' | 'manual'>('auto')
  const [previewCardCollapsed, setPreviewCardCollapsed] = useState(false)
  const [siteColWidths, setSiteColWidths] = useState<Record<string, number>>({})
  const [siteColOrder, setSiteColOrder] = useState<string[]>([])
  const [siteDragKey, setSiteDragKey] = useState<string | null>(null)

  const [loginId, setLoginId]     = useState('')
  const [loginPw, setLoginPw]     = useState('')
  const [loginStep, setLoginStep] = useState<LoginStep>('none')
  const [loginBusy, setLoginBusy] = useState(false)

  const [profileResult, setProfileResult] = useState<ProfileCheckResult | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  // "몰 구조분석"이 완료됐을 때 걸린 시간(초) — 항상 오래 걸리는 작업인데 정확히 몇 분/초 걸렸는지
  // 화면에서 알 방법이 없었다(사용자 요청, 2026-08-23). handleProfileMall(PTP 버튼으로 직접 시작한
  // 경우)만 측정한다 — 개발자모드 확장 팝업에서 트리거된 실행은 PTP가 시작 시각을 모르므로 잴 수 없다.
  const [profileElapsedSec, setProfileElapsedSec] = useState<number | null>(null)
  // "몰 구조분석 시 어떤 AI 공급자를 쓸지" — 기본은 Ollama만 빼고 전체 켜짐(Anthropic → Gemini → Groq
  // 순으로 결제/택배 리포트를 시도하고 전부 실패하면 규칙 기반으로 대체). 원래 단일 "AI 사용" 켬/끔이었는데,
  // Anthropic/Gemini가 동시에 막혔을 때(크레딧 소진 등) 굳이 그 둘을 기다리지 않고 곧장 다른 공급자만
  // 쓸 수 있게 공급자별 체크로 확장했다(사용자 요청, 2026-09-02 — "엔트로픽/제미나이 빼고 Ollama로 하면
  // 되잖아", "나중에 다른 AI도 더 붙여서 쓸 수 있게").
  // Ollama만 기본 꺼둔 이유(2026-09-02, 같은 날 뒤이어 실사용 확인): 이 PC에서 Ollama는 CPU 전용
  // 추론이라 리포트 하나에 5~8분씩 걸릴 뿐 아니라(다른 공급자는 실패해도 몇 초 안에 끝남), 그동안 CPU를
  // 오래 붙잡아 같은 PC에서 도는 Next.js dev 서버까지 응답이 느려지고 "로고 화면(강제 새로고침)"으로
  // 이어지는 게 실측으로 확인됐다 — Anthropic/Gemini/Groq가 다 막혀 있던 어느 날 밤, 사용자가 화면을
  // 쓰는 도중 몰 구조분석이 자동으로 Ollama까지 넘어가면서 dev 서버 요청들이 4초 이상 걸리고 일부는
  // 응답이 끊기기까지 했다(.dev-server.log의 application-code 지연, SyntaxError 다수 확인). 필요하면
  // 사용자가 직접 체크해서 켤 수 있고, 그때는 "몰 구조분석이 오래 걸리고 그동안 화면이 느려질 수 있다"는
  // 걸 감수하는 선택이 된다 — 자동으로는 그 대가를 치르지 않는다.
  const [profileAiProviders, setProfileAiProviders] = useState<Set<AiProviderId>>(new Set(AI_PROVIDER_OPTIONS.filter(p => p.id !== 'ollama').map(p => p.id)))
  // 이 선택은 화면 state로만 두지 않고 서버(ai_provider_config)에 저장한다 — 예전엔 state로만 있어서 이
  // 버튼이 보내는 요청 하나에만 실려 갔고, 카테고리 불러오기·개발자모드 확장·스케줄러는 사용자의 선택을
  // 알 방법이 없어 체크를 꺼도 그 AI를 계속 불렀다(2026-09-12 사용자 지적). 저장해두면 lib/aiProviderGate.ts의
  // 관문이 모든 경로에서 같은 값을 읽는다.
  useEffect(() => {
    let alive = true
    fetch('/api/settings/ai-providers')
      .then(r => r.json())
      .then((d: { providers?: AiProviderId[] | null }) => {
        // providers가 null이면 서버가 설정을 못 읽은 것 — 화면 기본값을 그대로 둔다(덮어쓰지 않는다).
        if (alive && Array.isArray(d.providers)) setProfileAiProviders(new Set(d.providers))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const toggleProfileAiProvider = (id: AiProviderId) => {
    setProfileAiProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      // 저장 실패해도 화면 조작은 막지 않는다 — 이번 실행엔 아래 body의 aiProviders로 그대로 반영되고,
      // 저장은 다음 토글에서 다시 시도된다.
      fetch('/api/settings/ai-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [...next] }),
      }).catch(() => {})
      return next
    })
  }

  const [pickerActive, setPickerActive] = useState(false)
  // 개발자모드 버튼을 눌렀을 때 "몰 탭/확장에서 이어서 하세요" 안내 — alert()는 사용자가 직접 확인을
  // 눌러야만 닫혀 흐름을 막는다는 지적(2026-08-22)으로, 저절로 사라지는 토스트로 바꿨다. 처음엔 5초로
  // 뒀는데, 몰 탭으로 직접 가서 확장을 실행해야 한다는(자동 실행이 안 되는 지금 상태에서는 매번 필요한)
  // 안내를 5초 안에 못 보고 놓쳤다는 지적(2026-08-22)으로 8초로 늘렸다.
  const [devHint, setDevHint] = useState<string | null>(null)
  // Mall 선택 그리드에서 지금 선택된 행을 찾아 스크롤·하이라이트해주기 위한 참조(선택이 드롭다운/다른
  // 화면에서의 이동 등 그리드 클릭이 아닌 경로로 바뀌어도, 그리드 안에서 어떤 행인지 눈에 보이게 한다).
  const selectedSiteRowRef = useRef<HTMLTableRowElement | null>(null)
  const devHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showDevHint(text: string) {
    setDevHint(text)
    if (devHintTimerRef.current) clearTimeout(devHintTimerRef.current)
    devHintTimerRef.current = setTimeout(() => setDevHint(null), 8_000)
  }
  useEffect(() => () => { if (devHintTimerRef.current) clearTimeout(devHintTimerRef.current) }, [])
  // "몰 구조분석"(개발자모드)의 안내는 화면 하단 고정 토스트(devHint, 다른 액션들과 공용)로 띄우면 정작
  // 방금 누른 버튼과 멀리 떨어져 눈에 안 띈다는 지적(2026-08-29)으로, 이 액션만 버튼 바로 위에 뜨는
  // 별도 인라인 안내로 뺐다.
  const [profileFocusHint, setProfileFocusHint] = useState<string | null>(null)
  const profileFocusHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showProfileFocusHint(text: string) {
    setProfileFocusHint(text)
    if (profileFocusHintTimerRef.current) clearTimeout(profileFocusHintTimerRef.current)
    profileFocusHintTimerRef.current = setTimeout(() => setProfileFocusHint(null), 5_000)
  }
  useEffect(() => () => { if (profileFocusHintTimerRef.current) clearTimeout(profileFocusHintTimerRef.current) }, [])
  // "스크랩 미리보기" 버튼도 profileFocusHint와 같은 이유로 화면 하단 공용 토스트(devHint) 대신 버튼
  // 바로 위 인라인 팝오버로 뺀다(사용자 지적, 2026-09-09 — "다른 버튼의 알림 위치처럼, 해당 버튼 바로
  // 위에 뜨게").
  const [previewFocusHint, setPreviewFocusHint] = useState<string | null>(null)
  const previewFocusHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showPreviewFocusHint(text: string) {
    setPreviewFocusHint(text)
    if (previewFocusHintTimerRef.current) clearTimeout(previewFocusHintTimerRef.current)
    previewFocusHintTimerRef.current = setTimeout(() => setPreviewFocusHint(null), 5_000)
  }
  useEffect(() => () => { if (previewFocusHintTimerRef.current) clearTimeout(previewFocusHintTimerRef.current) }, [])
  // "스크랩 대상 직접지정" 버튼도 같은 이유로 같은 패턴(사용자 지적, 2026-09-09).
  const [pickerFocusHint, setPickerFocusHint] = useState<string | null>(null)
  const pickerFocusHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showPickerFocusHint(text: string) {
    setPickerFocusHint(text)
    if (pickerFocusHintTimerRef.current) clearTimeout(pickerFocusHintTimerRef.current)
    pickerFocusHintTimerRef.current = setTimeout(() => setPickerFocusHint(null), 5_000)
  }
  useEffect(() => () => { if (pickerFocusHintTimerRef.current) clearTimeout(pickerFocusHintTimerRef.current) }, [])
  // 위 profileFocusHint 팝오버는 5초면 사라지는데, 실제로 사용자가 할 일(몰 창으로 건너가 확장 아이콘을
  // 찾아 누르는 것)은 그보다 오래 걸리는 게 보통이라 "뭘 눌러야 했더라"를 잊기 쉽다는 지적(2026-09-05)
  // — 팝오버 문구 대신/추가로 "🔍 몰 구조분석" 버튼 자체를 계속 강조해, 창을 오가다 돌아와도 뭘 눌렀는지
  // 바로 보이게 한다. mallProfileRunning(확장이 실제로 서버에 분석을 요청해 락이 잡힌 상태)이 되면 이미
  // "⏹ 중지" 버튼과 로딩 표시가 대신 그 역할을 하므로 그때 꺼진다(아래 mallProfileRunning 이펙트 참고).
  // 안전장치로 3분 뒤엔 스스로 꺼진다 — 사용자가 결국 안 갔거나 이미 다른 방식으로 끝냈는데도 영원히
  // 깜빡이는 걸 막기 위함.
  const [awaitingDevProfileAction, setAwaitingDevProfileAction] = useState(false)
  const awaitingDevProfileActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function startAwaitingDevProfileAction() {
    setAwaitingDevProfileAction(true)
    if (awaitingDevProfileActionTimerRef.current) clearTimeout(awaitingDevProfileActionTimerRef.current)
    awaitingDevProfileActionTimerRef.current = setTimeout(() => setAwaitingDevProfileAction(false), 180_000)
  }
  useEffect(() => () => { if (awaitingDevProfileActionTimerRef.current) clearTimeout(awaitingDevProfileActionTimerRef.current) }, [])
  // "📍 현재 카테고리 가져오기" 버튼용 — awaitingDevProfileAction과 같은 패턴(사용자 요청, 2026-09-05 —
  // 몰구조분석/스크랩미리보기와 달리 이 버튼은 예전에 sendExtensionAction(외부 메시징)으로 "자동 실행"을
  // 시도했었는데, extension-poc/manifest.json에 externally_connectable이 없어(다른 이유로 빠진 뒤 안
  // 되돌림) 지금은 항상 조용히 실패해 매번 수동 안내로만 폴백하고 있었다 — 실제로 하는 일이 없었으니
  // 나머지 두 버튼과 같은 "안내 + 강조" 방식으로 통일한다). 완료(진짜로 새 URL이 큐에 쌓임)는 아래
  // 현재 카테고리 폴링 이펙트가 감지해서 꺼준다.
  const [awaitingDevCategoryAction, setAwaitingDevCategoryAction] = useState(false)
  const awaitingDevCategoryActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function startAwaitingDevCategoryAction() {
    setAwaitingDevCategoryAction(true)
    if (awaitingDevCategoryActionTimerRef.current) clearTimeout(awaitingDevCategoryActionTimerRef.current)
    awaitingDevCategoryActionTimerRef.current = setTimeout(() => setAwaitingDevCategoryAction(false), 180_000)
  }
  useEffect(() => () => { if (awaitingDevCategoryActionTimerRef.current) clearTimeout(awaitingDevCategoryActionTimerRef.current) }, [])
  // "🔄 스크랩 시작" 버튼(devmode)용 — 같은 패턴(사용자 요청, 2026-09-05). 완료(진짜로 세션이 만들어져
  // status가 'running'이 됨)는 위 checkForRunningSession 폴링(1329행 근처)이 감지해서 꺼준다.
  const [awaitingDevScrapeStart, setAwaitingDevScrapeStart] = useState(false)
  const awaitingDevScrapeStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function startAwaitingDevScrapeStart() {
    setAwaitingDevScrapeStart(true)
    if (awaitingDevScrapeStartTimerRef.current) clearTimeout(awaitingDevScrapeStartTimerRef.current)
    awaitingDevScrapeStartTimerRef.current = setTimeout(() => setAwaitingDevScrapeStart(false), 180_000)
  }
  useEffect(() => () => { if (awaitingDevScrapeStartTimerRef.current) clearTimeout(awaitingDevScrapeStartTimerRef.current) }, [])
  // "확장 버전이 뒤처졌으면 알려주는" 기능(sendExtensionAction('ping', ...) 기반)은 제거했다 —
  // extension-poc/manifest.json에 externally_connectable이 없어 항상 조용히 실패해 한 번도 알림이 뜬 적이
  // 없었다(다른 sendExtensionAction 호출부와 같은 이유, 2026-09-05). 이건 다른 호출부(current-category/
  // picker/start 등)처럼 "사용자가 대신 몰 탭에서 눌러달라"로 대체할 수 있는 종류가 아니라(확인이 필요한
  // 건 PTP 자신이지 사용자가 할 수 있는 일이 아님) — 다시 살리려면 확장이 자기 버전을 주기적으로
  // 서버에 보고하는 폴링 방식(current-category 큐와 같은 패턴)을 새로 만들어야 한다. 필요해지면 별도로
  // 추가한다.
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerRules, setPickerRules] = useState<Record<string, { type: string; value: string }>>({})

  const [targetUrl, setTargetUrl]           = useState('')
  const [categoryUrlsText, setCategoryUrlsText] = useState('')
  // "몰 카테고리 선택 가져오기(반복)" 탭 전용 — categoryUrlsText(실제 스크랩 대상, "전체 가져오기" 탭의
  // 체크리스트도 같이 씀)와 공유하면 그쪽에서 이미 체크해둔 것까지 이 탭에 섞여 보여 "내가 여기서
  // 가져온 것"이라는 감이 없어진다는 지적(2026-08-22)으로 분리했다 — 이 상태는 항상 빈 값에서
  // 시작하고, "현재 카테고리 가져오기"로 쌓거나 직접 타이핑한 것만 담는다. 아래 activateAutoMode/
  // activateManualMode 주석 참고 — 두 목록은 서로 절대 자동으로 안 섞이고, "지금 실제로 스크랩 대상인
  // 쪽"은 categorySourceMode로만 판단한다(바로 아래 activeCategoryUrlsText).
  const [manualCategoryUrlsText, setManualCategoryUrlsText] = useState('')
  // "지금 실제로 스크랩/미리보기 대상인 목록이 뭔지" 판단하는 단 하나의 기준 — buildCategoryUrlsAndLimits/
  // canPreview/devmode_category_urls 동기화 등 여러 곳에서 각자 같은 삼항연산자를 반복해서 쓰다가 그중
  // 한 곳(devmode_category_urls 동기화)이 "선택 가져오기" 모드를 깜빡 빠뜨린 채로 한동안 방치돼 있었다
  // (사용자 지적, 2026-09-05 — "확인을 제대로 안 하고 다 됐다고 한다"). 앞으로 이 값이 필요한 곳은
  // 전부 여기 하나만 참조하게 해서, 같은 종류의 버그가 또 새로 생길 자리를 없앤다.
  const activeCategoryUrlsText = categorySourceMode === 'manual' ? manualCategoryUrlsText : categoryUrlsText
  /** 좌우 카드(자동/선택) 중 실제로 만지는 쪽으로 자동 전환한다 — 라디오를 깜빡 잊고 안 눌러도 "방금
   *  건드린 쪽"이 곧 실제 스크랩 대상이 되게 한다(사용자 요청, 2026-08-27: "체크한 쪽만 동작하도록 하고,
   *  아래쪽 그리드부분을 조작하면 자동으로 전환되게 해줘"). 전환되는 그 순간에만(이미 그 모드였으면
   *  아무 일도 안 함) 반대쪽의 선택값을 비워 기본값으로 되돌린다 — "선택 가져오기에서 고른 카테고리가
   *  왼쪽 체크리스트에도 같이 체크됐다"는 실사용 버그의 근본 원인이 두 목록을 자동으로 합치던 낡은
   *  useEffect(manualCategoryUrlsText → categoryUrlsText 병합, 2026-08-22 도입)였다 — categorySourceMode로
   *  둘을 완전히 분리하게 된(2026-08-24) 뒤로는 그 병합이 필요 없어졌는데도 안 지워져 있었다. 지금은
   *  그 병합 로직 자체를 없애 두 목록이 서로 절대 안 섞이게 했다. */
  function activateAutoMode() {
    if (categorySourceMode === 'auto') return
    setCategorySourceMode('auto')
    setManualCategoryUrlsText('')
  }
  function activateManualMode() {
    if (categorySourceMode === 'manual') return
    setCategorySourceMode('manual')
    setCategoryUrlsText('')
  }
  // "하위 카테고리 있음" 체크(href 기준) — categorySettings(정렬/상한, 스크랩 시 그대로 서버로 나가는
  // 설정값)와는 성격이 달라(순수 UI 로컬 상태, 펼쳐보고 나면 의미가 없어짐) 별도로 둔다. expandingHref는
  // 지금 하위구조를 가져오는 중인 href 하나(동시에 여러 개를 누르면 헷갈리므로 한 번에 하나만 허용).
  const [manualHasSubcategory, setManualHasSubcategory] = useState<Record<string, boolean>>({})
  const [expandingHref, setExpandingHref] = useState<string | null>(null)
  // "↳ 가져오기" 결과/실패 안내 — 예전엔 alert()로 띄워서 사용자가 직접 "확인"을 눌러야만 다음으로
  // 넘어갔다(사용자 지적, 2026-09-26 — "확인 처리 전에는 멈추는데, 몇초 후 자동으로 닫히게 해": alert()는
  // 브라우저 네이티브 블로킹 모달이라 프로그램적으로 자동 닫기가 불가능하다). 화면 안에 표시되는 배너로
  // 바꾸고 몇 초 뒤 스스로 사라지게 한다.
  const [expandSubcategoryNotice, setExpandSubcategoryNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!expandSubcategoryNotice) return
    const t = setTimeout(() => setExpandSubcategoryNotice(null), 4_000)
    return () => clearTimeout(t)
  }, [expandSubcategoryNotice])
  // "몰 카테고리 선택 가져오기(반복)"로 카테고리를 가져오면 그 즉시 "정렬" 드롭다운이 쓰이도록, 몰
  // 구조분석 없이도 그 카테고리 페이지에서 바로 정렬 옵션을 확인해 둔다(사용자 요청, 2026-08-26 —
  // "카테고리를 가져오기 하면 그 즉시 정렬/스크랩 상한 작업이 가능하도록"). gridSortOptions가
  // profileResult 쪽에 아직 없을 때만 이걸로 대신 채운다 — 서버에도 scrape_profile.sortOptions로 같이
  // 저장되므로(app/api/scrape/categories/sort-options), 몰을 다시 선택해도 캐시로 복원된다.
  const [manualSortOptions, setManualSortOptions] = useState<MallProfileSignals['sortOptions']>([])
  const [currentUrlLoading, setCurrentUrlLoading] = useState(false)
  // "URL 불러오기"를 한 번이라도 성공하면 true — "카테고리 불러오기"와 같은 레벨의 액션이라 완료
  // 여부를 같은 방식(✓ + 옅은 테두리)으로 보여준다. 시작 URL을 직접 고치면(로그인/카테고리와 같은
  // 패턴) 다시 안 가져온 상태로 되돌린다.
  const [currentUrlFetched, setCurrentUrlFetched] = useState(false)

  const [categories, setCategories]         = useState<{ href: string; text: string }[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  // 몰 구조분석이 이미 찾아둔 카테고리 목록을 재사용했으면(cached) 즉시 뜨고, 한 번도 분석 안 한 몰이라
  // 지금 막 새로 훑었으면(false) 시간이 걸린다 — 사용자가 그 차이를 알 수 있도록 상태만 같이 보여준다.
  const [categoriesCached, setCategoriesCached] = useState<{ cached: boolean; updatedAt: string | null } | null>(null)
  // discoverCategoryLinks가 하위 카테고리 확인차 대분류 페이지를 열었다가 로그인 페이지로 튕긴 적이
  // 있으면 true — 회원전용 도매몰(모자사러 등)은 개인 크롬 프로필을 통째로 복사해도 로그인 세션 자체가
  // 넘어오지 않는다는 게 이미 확인된 구조적 한계라(!specifications/manual-login-required-malls.md
  // 2026-07-18 항목), "다시 확인"을 몇 번을 눌러도 하위 카테고리가 펼쳐지지 않는 이유를 화면에서 바로
  // 알려준다(사용자 실사용 확인, 2026-08-18 — 크롬을 완전히 닫고 새로 복사해도 로그인이 반영 안 됨을
  // 직접 재현해 확정).
  const [loginBlockedExpansion, setLoginBlockedExpansion] = useState(false)
  // checkCategoryAnomaly(lib/scrape/categoryAnomalyCheck.ts)가 이 카테고리 구조를 검증된 과거 카테고리와
  // 비교해 터무니없다고 판단했을 때만 채워진다(2026-08-29, 봇 차단 페이지 링크가 카테고리로 잘못
  // 저장됐던 사고의 재발 감지용 안전망 — 사용자 요청).
  const [categoryAnomalyWarning, setCategoryAnomalyWarning] = useState<{ reason: string; source: 'anthropic' | 'gemini' | 'ollama' } | null>(null)
  // 지난번 categoryLinks 갱신(몰 구조분석/"다시 확인") 때 새로 나타난 href 목록 — "발견된 카테고리 N개"
  // 배지 옆에 "새 카테고리 M개"를 보여주는 용도(사용자 요청, 2026-09-05, app/api/scrape/categories/route.ts
  // 참고). "이번 로드에서 새로 생긴 것"이 아니라 "직전 categoryLinks 갱신 시점 이후 새로 생긴 것"이라 —
  // 몰 구조분석 없이 그냥 "카테고리 불러오기"만 반복 눌러도 다음 몰 구조분석 전까지는 같은 값을 유지한다.
  const [newCategoryHrefs, setNewCategoryHrefs] = useState<string[]>([])
  // 카테고리 목록을 찾을 때 AI(Gemini)가 실제로 기여했는지 — 사용자 요청으로 체크리스트에 작게
  // 표시한다(2026-08-18). GEMINI_API_KEY가 없거나 AI가 매번 빈 결과를 줘 기존 셀렉터 히스틱으로만
  // 채워졌으면 false.
  const [categoryAiUsed, setCategoryAiUsed] = useState(false)
  // "카테고리별 정렬기준 설정" 기능(사용자 요청, 2026-08-19) — 카테고리 href를 키로, 사용자가 그리드에서
  // 고른 정렬 라벨/상한을 담는다. categoryUrlsText(선택 상태)와 같은 이유로 서버에 영구 저장하지 않고
  // 세션(sessionStorage) 로컬 상태로만 둔다 — 매번 다시 고르는 게 맞는 값이라 DB 스키마 없이 간단하게.
  const [categorySettings, setCategorySettings] = useState<Record<string, { sortLabel?: string; limitMode?: 'count' | 'pages'; limitValue?: number }>>({})
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)
  // 카테고리를 나눠서(오늘 일부, 나중에 나머지) 스크랩하는 경우가 있어, 이 몰의 과거 완료 세션들을 훑어
  // "이미 스크랩해본 카테고리"를 체크박스 목록에 표시한다(app/api/scrape/categories가 계산해 내려줌).
  // allCategoriesScraped=true면 몰 전체 스크랩을 완료한 적이 있다는 뜻이라 개별 목록과 무관하게 전부 완료로 본다.
  const [scrapedCategoryHrefs, setScrapedCategoryHrefs] = useState<string[]>([])
  const [allCategoriesScraped, setAllCategoriesScraped] = useState(false)
  // 메뉴 구조상 카테고리처럼 보이지만 실제 상품이 없는 항목(안내/문의 페이지 등)은 자동 판별만으로 완전히
  // 걸러낼 수 없어(몰마다 메뉴 구조가 제각각), 사용자가 직접 "제외"로 표시해둘 수 있게 한다(사이트별로
  // 서버에 저장돼 다음에 카테고리를 다시 불러와도 유지됨).
  const [excludedCategoryHrefs, setExcludedCategoryHrefs] = useState<string[]>([])

  const [previewResult, setPreviewResult]   = useState<{ sourceUrl: string; product: PreviewProduct } | null>(null)
  // refreshPickerRules(피커 폴링 콜백)가 최신 previewResult를 읽기 위한 용도 — 그 콜백은 setInterval에
  // pickerActive/selectedSite가 바뀔 때만 다시 등록되므로, previewResult를 직접 클로저로 참조하면 그
  // 사이에 바뀐 값을 못 본다(다른 폴링에서 갱신되는 등). ref로 항상 최신값을 따로 들고 있는다.
  const previewResultRef = useRef(previewResult)
  useEffect(() => { previewResultRef.current = previewResult }, [previewResult])
  // refreshPickerRules가 "이번 폴링에서 규칙이 실제로 바뀌었는지"를 비교하는 용도 — 렌더마다 새로 만들어지는
  // 클로저와 무관하게 이 ref 하나로 호출들 사이에서 계속 이어서 비교한다.
  const lastPickerRulesJsonRef = useRef<string>('{}')
  // 미리보기 결과가 로그인 세션이 끊긴 상태로 얻어진 것 같을 때(창을 닫은 뒤 세션 만료 등) — 자동으로
  // 로그인 창을 다시 띄우고 이 배너로 재확인을 안내한다.
  const [sessionExpiredWarning, setSessionExpiredWarning] = useState(false)
  // 개발자모드 미리보기가 선택한 카테고리에서 상품 링크를 하나도 못 찾았을 때(runPreview의 noProductsFound,
  // 2026-09-05) — 로그인 문제는 아니지만(needsLogin과는 별개 신호) 뭔가 잘못됐다는 걸 명확히 알려야,
  // 예전처럼 카테고리 목록 페이지 자체가 가짜 상품으로 둔갑해 캡처됐을 때와 헷갈리지 않는다.
  const [noProductsFoundWarning, setNoProductsFoundWarning] = useState(false)
  // "로그인 확인" 버튼이 실제로 로그인됐는지 점검한 결과(lib/scraper.ts의 detectLoggedInSignal) —
  // false는 "로그아웃 링크를 못 찾음"이라는 약한 신호일 뿐이라 흐름을 막지 않고 경고만 보여준다.
  // null(점검 불가)/true(찾음)는 경고를 안 띄운다.
  const [loginVerified, setLoginVerified] = useState<boolean | null>(null)
  const [previewTotal, setPreviewTotal]     = useState<number | null>(null)
  // "정확한 총 개수 확인" — previewTotal(카테고리별 빠른 합계, 카테고리 간 상품이 겹치면 중복 포함될 수
  // 있음)과 별개로, 버튼을 눌렀을 때만 실제 스크랩과 같은 방식으로 중복 제거된 정확한 개수를 구한다
  // (사용자 요청, 2026-08-17 — lib/scraper.ts의 countDedupedProductUrls 참고). categories는 그 총합이
  // "어느 카테고리가 몇 개 중복이라 몇 개만 새로 스크랩되는지"까지 카테고리별로 보여주는 후속 요청
  // (2026-08-25 — countCategoryOverlap 참고)에 쓰인다.
  const [exactTotal, setExactTotal] = useState<{
    total: number; needsLogin: boolean
    categories?: { url: string; count: number; uniqueCount: number; duplicateCount: number }[]
  } | null>(null)
  const [exactTotalLoading, setExactTotalLoading] = useState(false)
  const exactTotalAbortRef = useRef<AbortController | null>(null)
  const [previewItems, setPreviewItems]     = useState<PreviewItem[]>([])
  /** 미리보기 1건을 어느 목록에서·어떤 정렬로 뽑았는지(lib/scraper.ts의 CatalogPreviewResult.previewSource) */
  const [previewSource, setPreviewSource] = useState<{ url: string; requestedUrl: string; switchedReason?: string; sortClick?: { clickText: string; applied: boolean } } | null>(null)
  // 일반모드 카탈로그 미리보기 전용 — 카테고리별 상품 개수만(이름/썸네일 없이). 개발자모드는 이 필드를
  // 채우지 않으므로(확장이 previewItems 쪽만 보냄) 항상 빈 배열로 남아 기존 표시와 자연히 구분된다.
  const [categoryCounts, setCategoryCounts] = useState<CategoryCountItem[]>([])
  // 카테고리 체크리스트 컬럼용(위 CategoryInfoEntry 참고) — href를 키로 한다.
  const [categoryInfo, setCategoryInfo] = useState<Record<string, CategoryInfoEntry>>({})
  // 카테고리별 개수 표를 최상위 카테고리 단위로 묶어 개별 접기/펴기 — 하위 카테고리가 많은 몰(예: 익스테리어몰딩
  // 하위 수십 개)에서 한 화면에 다 펼쳐두면 스크롤이 길어지니, 안 볼 그룹은 접어두고 볼 그룹만 펼친다.
  const [collapsedCategoryGroups, setCollapsedCategoryGroups] = useState<Set<string>>(new Set())
  // 컬럼 가로 폭 조절(사용자 요청, 2026-09-05) — 브라우저 기본 CSS resize(셀 우측 하단 대각선 손잡이)로
  // 처음 만들었더니 잡을 자리가 애매하고 셀 안 텍스트와 겹쳐 "이상하다"는 지적을 받았다 — 엑셀/다른
  // 그리드들처럼 헤더 오른쪽 경계 전체를 세로로 드래그하는 표준 방식으로 바꿨다. 마우스를 누른 시점의
  // 폭+이동거리로 계산하며, 실시간으로 반영하다가(드래그 중) 뗄 때만 localStorage에 저장한다.
  const [categoryCountColWidths, setCategoryCountColWidths] = useState(readSavedCategoryCountColWidths)
  const CATEGORY_COUNT_COL_MIN_WIDTH = 48
  function startCategoryCountColResize(key: keyof CategoryCountColWidths) {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = categoryCountColWidths[key]
      function onMove(ev: MouseEvent) {
        const w = Math.max(CATEGORY_COUNT_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX)))
        setCategoryCountColWidths(prev => (prev[key] === w ? prev : { ...prev, [key]: w }))
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        setCategoryCountColWidths(prev => {
          localStorage.setItem(CATEGORY_COUNT_COL_WIDTHS_KEY, JSON.stringify(prev))
          return prev
        })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }
  const [previewLoading, setPreviewLoading] = useState(false)
  // devmode 전용 — 확장이 chrome.debugger를 실제로 붙여 캡처를 시작했는지(preview-progress 폴링 결과).
  // previewLoading은 "PTP 버튼을 눌러 대기 중"부터 이미 true라 그것만으로는 "정말 지금 도는 중"인지 알 수
  // 없다(아래 devLastPreviewKeyRef 폴링 근처 주석 참고, 사용자 요청 2026-09-05).
  const [devPreviewCapturing, setDevPreviewCapturing] = useState(false)
  // devmode가 카테고리를 여러 개 선택해 미리보기할 때 "카테고리 N/M 확인 중"을 보여주기 위한 값 —
  // 일반모드의 previewProgress와 같은 목적(2026-09-05, 실사용 확인: 46개 카테고리를 미리보기하는 동안
  // 진행 정보가 전혀 없어 "진행 중인 게 맞냐"는 문의로 이어짐).
  const [devPreviewProgress, setDevPreviewProgress] = useState<{ done: number; total: number } | null>(null)
  // devmode "스크랩 미리보기"가 걸린 시간 — 진행 중 표시(devPreviewProgress)는 화면을 보고 있어야만 보이는
  // 실시간 값이라, 화면을 안 보던 사이에 이미 끝났으면 "몇 분 걸렸는지" 알 방법이 없었다(사용자 지적,
  // 2026-09-06: "안 보고 있었어도 완료가 됐다면, 완료까지 걸린 시간도 표시를 해줘야지"). 결과(last_
  // adjustment_preview)에 서버가 같이 저장해둔 devPreviewElapsedSec을 그대로 보여준다 — 진행 중이었는지와
  // 무관하게 결과가 있으면 항상 확인 가능하다.
  const [devPreviewElapsedSec, setDevPreviewElapsedSec] = useState<number | null>(null)
  // "미리보기 중지" — fetch를 abort하면 서버(previewCatalog)도 opts.stopSignal로 같은 신호를 받아
  // 카테고리 개수 집계를 스스로 멈춘다(lib/scraper.ts 참고). 일반모드 전용(개발자모드는 서버가 아니라
  // 사용자 브라우저의 확장이 도는 것이라 이 fetch로 막을 수 있는 작업이 없다).
  const previewAbortRef = useRef<AbortController | null>(null)
  // 카테고리가 많거나 큰 몰은 미리보기가 몇 분씩 걸릴 수 있어, 진행 중임을 알 수 있게 서버가 세는
  // "카테고리 N/M" 진행 상황을 짧은 주기로 폴링해 보여준다(끝없이 도는 것처럼 보인다는 피드백).
  const [previewProgress, setPreviewProgress] = useState<{ done: number; total: number } | null>(null)
  const previewProgressPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // earlyPreview는 한 번 도착하면 그 실행 동안 값이 바뀌지 않으므로, 이미 반영했으면 매 폴링(1초)마다
  // 같은 값으로 다시 리렌더하지 않게 막는다.
  const earlyPreviewAppliedRef = useRef(false)
  // dev 서버가 불안정해 화면이 강제로 새로고침되면(Fast Refresh, 실사용 중 확인된 문제) 미리보기가
  // "그냥 멈춘 것"처럼 보이지만 서버는 계속 돌고 있을 수 있다 — 화면이 다시 뜰 때 이 몰에 아직 도는
  // 미리보기가 있으면 로딩 상태를 이어서 보여주고, 그 사이 끝나면 이 안내를 띄운다(원래 요청의 결과는
  // 새로고침으로 끊긴 그 브라우저 탭 안에서만 받을 수 있어 그대로 복구할 방법은 없다 — 다시 눌러야 함).
  const [previewResumeNotice, setPreviewResumeNotice] = useState<string | null>(null)

  // 이 몰의 로그인 창 탭/프로필을 다른 스크랩 작업(스크래핑 시작/몰 구조분석/미리보기 등)이 지금 쓰고
  // 있으면, 여기서 누르는 버튼도 그게 끝날 때까지 순서를 기다린다(lib/scraper.ts의 withSiteLock 참고) —
  // 예전엔 이걸 알 방법이 없어 "왜 이렇게 오래 걸리냐"는 질문으로 매번 서버 로그를 뒤져야 했다. 몰을
  // 선택해두는 동안 짧은 주기로 폴링해, 대기 중이면 화면에 바로 보여준다.
  const [siteLockStatus, setSiteLockStatus] = useState<SiteLockStatusInfo | null>(null)
  // "스크래핑 시작"/"미리보기"를 누른 시각 — 그 뒤 이 몰의 락이 그 시각 이후에 잡혔으면 그건 방금 내가
  // 시작한 그 작업 자신이 쥔 락이다(아래 배너가 "다른 작업이 진행 중"이라고 스스로를 가리키며 혼란을
  // 주지 않게 구분하는 용도, 2026-08-11 실사용 확인 — 내 작업이 실제로 잘 돌고 있는데도 계속 "다른
  // 작업 대기 중" 배너가 떠 있어서 아무 진행도 안 되는 것처럼 보였다).
  const myLockClickAtRef = useRef<number | null>(null)

  // 개발자모드 "상품 페이지 미리보기"/"스크랩 대상 직접지정" — 일반모드와 같은 카드/상태(previewResult 등)를
  // 그대로 쓰지만, PTP가 그 몰 탭에 직접 접근할 방법이 없어(chrome.debugger 확장 전용 구조) 실제 캡처는
  // 사용자가 몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 일어난다 — 그래서 즉시 fetch 대신 폴링으로
  // 기다리는 방식을 쓴다. 이 폴링은 "스크랩 미리보기" 버튼을 누르는 것과 무관하게 이 몰이 선택돼 있는
  // 동안 항상 돌아간다(아래 useEffect) — PTP 버튼을 먼저 누르지 않고 몰 탭에서 확장의 "스크랩 미리보기
  // 실행"만 눌러도 결과가 그대로 반영되게 하기 위함(2026-08, 순서를 강제하던 예전 설계는 오히려 먼저
  // 캡처해둔 결과를 "스크랩 미리보기"의 초기화(preview-arm)가 지워버리는 부작용이 있었다).
  const devPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const progressSectionRef = useRef<HTMLDivElement>(null)
  const previewSectionRef = useRef<HTMLDivElement>(null)
  const profileResultRef = useRef<HTMLDivElement>(null)
  const categoryResultRef = useRef<HTMLDivElement>(null)

  const [aiMode, setAiMode]       = useState(true)
  // 카테고리/상품 목록을 동시에 몇 개까지 열지 — 'auto'는 기존 동작(스크래핑은 1~16 적응형, 미리보기/카테고리
  // 목록 수집은 16 고정 — 8이던 상한을 2026-08-24에 리소스 실측 후 올림, lib/scraper.ts의
  // resolveConcurrency 주석 참고), 'manual'이면 concurrency 값으로 항상 고정한다. 열린 탭이 많을수록
  // (이미지까지 로드) 메모리를 더 쓰므로, 메모리 이슈를 진단/완화할 때 1로 낮춰볼 수 있게 한다.
  const [concurrencyMode, setConcurrencyMode] = useState<'auto' | 'manual'>(() => readConcurrencyPref().mode)
  const [concurrency, setConcurrency] = useState<number>(() => readConcurrencyPref().value)
  // "로컬 창"(서버 PC 화면에 실제로 뜨는 크롬 창, 기존 방식) / "원격으로 보기"(CDP 화면중계, 신규) —
  // 개인 UI 습관이라 몰 DB 값이 아니라 localStorage에만 저장한다. 백엔드는 이 값과 무관하게 항상 같은
  // headless:false 창을 띄운다(handleOpenLogin 등 기존 로직 그대로) — 이 토글은 "그 창을 어떻게
  // 보여줄지"만 바꾼다(2026-08-24, 원격 다중 사용자 지원의 1단계).
  const [viewMode, setViewMode] = useState<'local' | 'remote'>(() => {
    if (typeof window === 'undefined') return 'local'
    return localStorage.getItem('scrape.scraper.viewMode') === 'remote' ? 'remote' : 'local'
  })
  useEffect(() => { localStorage.setItem('scrape.scraper.viewMode', viewMode) }, [viewMode])
  // "스크래핑 시작"이 위에서 선택한 카테고리 전체를 대상으로 하되, mall_products에 source_url로 이미
  // 있는 상품까지 다시 스크랩할지 — 기본값 true(포함)로 바꿈(사용자 지시, 2026-08-23: "전체 카테고리
  // 기준이건 일부 선택한 카테고리 기준이건... '이미 스크랩한 상품 포함' 옵션을 디폴트로"). 예전엔 항상
  // 이미 있는 상품을 조용히 건너뛰어서(runScraping의 excludeUrls), 몰 전체를 다시 받고 싶어도 신상품만
  // 받아지는 게 "버그"처럼 보였다 — 끄면 예전 동작(건너뛰기)으로 되돌릴 수 있다.
  const [includeAlreadyScraped, setIncludeAlreadyScraped] = useState(true)
  const [status, setStatus]       = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [progress, setProgress]   = useState<{ saved: number; total: number; error?: string; successCount: number; failedCount: number }>({ saved: 0, total: 0, successCount: 0, failedCount: 0 })
  // 완료(status='done')까지 걸린 시간(분) — scrape_sessions.created_at~finished_at 차이. 진행 중/중지/오류일 땐 안 보여준다.
  const [elapsedMinutes, setElapsedMinutes] = useState<number | null>(null)
  // 진행 중일 때도 "지금까지 얼마나 걸리고 있는지" 보여달라는 요청(2026-08-22, "소요시간 등을 표시해
  // 줘야지") — created_at만 기억해두면 나머지는 렌더링 시점에 계산한다(2초 폴링이 어차피 계속 리렌더를
  // 일으키므로 별도 타이머 없이도 저절로 갱신된다).
  const [sessionCreatedAt, setSessionCreatedAt] = useState<string | null>(null)
  // 상품 URL 수집(카테고리 목록 순회) 단계는 progress.total이 아직 0이라 위 progress만으로는 "카테고리 몇 개
  // 중 몇 번째"를 보여줄 수 없다 — 미리보기의 previewProgress와 같은 이유·같은 해법(2026-08-11).
  const [collectProgress, setCollectProgress] = useState<{ done: number; total: number } | null>(null)
  const [stopping, setStopping]   = useState(false)
  const [itemLog, setItemLog]     = useState<ItemLogRow[]>([])
  // 적응형 동시성이 이번 회차에 언제 올리고(연속 성공) 언제 차단 감지로 다시 낮췄는지 — 스크래핑 후 간략히 확인용
  const [concurrencyLog, setConcurrencyLog] = useState<{ at: string; level: number; reason: 'ramp_up' | 'block_detected' }[]>([])
  const [concurrencyLogOpen, setConcurrencyLogOpen] = useState(false)
  const [retrying, setRetrying]   = useState(false)
  const [modeSaving, setModeSaving] = useState(false)
  const [credCopied, setCredCopied] = useState<'id' | 'pw' | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [])

  // 동시 처리 자동/수동 선호값 — 몰별 상태(FORM_STATE_KEY)와 무관하게 하나만 저장해 몰을 바꿔도 유지한다.
  useEffect(() => {
    localStorage.setItem(CONCURRENCY_PREF_KEY, JSON.stringify({ mode: concurrencyMode, value: concurrency }))
  }, [concurrencyMode, concurrency])

  // LAST_SESSION_KEY(스크랩 진행/완료 상태)와 FORM_STATE_KEY(몰 선택/카테고리 목록 등)는 서로 독립적으로
  // 복원돼야 한다 — 아래 마운트 effect에서 둘 다 적용한다.
  interface ScraperFormSavedState {
    siteId: number; targetUrl: string; categoryUrlsText: string; manualCategoryUrlsText?: string
    categorySourceMode?: 'auto' | 'manual'
    previewResult?: { sourceUrl: string; product: PreviewProduct } | null
    previewTotal?: number | null
    previewItems?: PreviewItem[]
    categoryCounts?: CategoryCountItem[]
    detectedPlatform?: string | null
    loginStep?: LoginStep
    categories?: { href: string; text: string }[]
    categoriesCached?: { cached: boolean; updatedAt: string | null } | null
    profileResult?: ProfileCheckResult | null
    scrapedCategoryHrefs?: string[]
    allCategoriesScraped?: boolean
    excludedCategoryHrefs?: string[]
    categorySettings?: Record<string, { sortLabel?: string; limitMode?: 'count' | 'pages'; limitValue?: number }>
  }

  // isDevmode: 개발자모드는 previewResult/previewItems/categoryCounts의 진짜 최신 값을 이미
  // 3초 폴링(위 devLastPreviewKeyRef 이펙트)이 last_adjustment_preview에서 직접 가져오고, selectSite도
  // 그 자리를 방금 깨끗한 값(null/[])으로 맞춰뒀다 — 그 직후 이 세션스토리지 복원이 예전 스냅샷으로 다시
  // 덮어써버리면, 서버 쪽 값이 그 사이(다른 탭 작업, DB 직접 수정 등)에 이미 지워지거나 바뀌었어도 이
  // 탭은 그 사실을 영영 모른 채 낡은 미리보기(심지어 로그인 페이지를 상품으로 잘못 캡처했던 결과)를 계속
  // 보여준다(2026-09-05, 실사용 확인 — DB에서 지워도 이 탭을 새로고침만 해서는 안 사라짐). 일반모드는
  // 이 복원이 dev 서버 Fast Refresh 중 진행 중이던 미리보기를 잃지 않게 하는 유일한 수단이라 그대로 둔다.
  function applyFormState(saved: ScraperFormSavedState, isDevmode: boolean) {
    setTargetUrl(saved.targetUrl)
    setCategoryUrlsText(saved.categoryUrlsText)
    // categorySourceMode(자동/선택 중 실제로 스크랩에 쓸 쪽)를 안 되살리면 항상 기본값('auto')으로
    // 돌아간다 — dev 서버 Fast Refresh 강제 새로고침(위 955줄 주석 참고) 등으로 이 화면이 다시 마운트될
    // 때, manualCategoryUrlsText(선택 가져오기 목록)는 그대로 복원돼 화면엔 멀쩡해 보이는데 정작
    // "어느 쪽을 쓸지" 표시만 조용히 auto로 되돌아가, 사용자가 눈치 못 채고 "선택 가져오기"로 공들여
    // 고른 카테고리 대신 예전 자동탐지 결과로 미리보기/스크랩이 도는 문제가 실제로 있었다(사용자 실사용
    // 확인, 2026-08-27 — 오토카필: "카테고리도 개수도 안 맞는다").
    if (saved.categorySourceMode) setCategorySourceMode(saved.categorySourceMode)
    if (saved.manualCategoryUrlsText) setManualCategoryUrlsText(saved.manualCategoryUrlsText)
    if (!isDevmode) {
      if (saved.previewResult) setPreviewResult(saved.previewResult)
      if (saved.previewTotal != null) setPreviewTotal(saved.previewTotal)
      if (saved.previewItems?.length) setPreviewItems(saved.previewItems)
      if (saved.categoryCounts?.length) setCategoryCounts(saved.categoryCounts)
      if (saved.detectedPlatform) setDetectedPlatform(saved.detectedPlatform)
    }
    // 로그인 확인 상태/발견된 카테고리/몰 구조분석 결과는 dev 서버가 Fast Refresh로 화면을 강제
    // 새로고침시켜도(실사용 중 확인된 문제) 사라진 것처럼 보이지 않게 여기서 되살린다. openSessions
    // (로그인 창)는 브라우저만 새로고침됐을 뿐인 같은 서버 프로세스에 그대로 남아있어 loginStep 복원이
    // 실제 상태와 어긋나지 않는다.
    if (saved.loginStep) setLoginStep(saved.loginStep)
    if (saved.categories?.length) setCategories(saved.categories)
    if (saved.categoriesCached) setCategoriesCached(saved.categoriesCached)
    if (saved.profileResult) setProfileResult(saved.profileResult)
    if (saved.scrapedCategoryHrefs?.length) setScrapedCategoryHrefs(saved.scrapedCategoryHrefs)
    if (saved.allCategoriesScraped) setAllCategoriesScraped(true)
    if (saved.excludedCategoryHrefs?.length) setExcludedCategoryHrefs(saved.excludedCategoryHrefs)
    if (saved.categorySettings) setCategorySettings(saved.categorySettings)
  }

  useEffect(() => {
    // Mall 목록/거래처 목록에서 특정 몰(또는 거래처)을 지정해 들어온 경우 그 선택이 우선이지만, 마침
    // 그 몰의 마지막 세션이 저장돼 있으면(같은 몰이라 사용자 의도와 어긋나지 않는다) 빈 폼 대신 그대로
    // 복원한다 — 안 그러면 스크랩이 끝난 몰을 목록에서 다시 클릭할 때마다 완료 상태가 사라지고 빈
    // 폼부터 다시 보였다(2026-08-13 실사용 확인: 세션은 done+1448건으로 정상 완료돼 있었는데도 화면은
    // 매번 초기화됨).
    const raw = sessionStorage.getItem(LAST_SESSION_KEY)
    let savedSession: { site: Site; sessionId: number } | null = null
    if (raw) {
      try { savedSession = JSON.parse(raw) as { site: Site; sessionId: number } } catch { /* 손상된 저장값은 무시 */ }
    }
    const formRaw = sessionStorage.getItem(FORM_STATE_KEY)
    let savedForm: ScraperFormSavedState | null = null
    if (formRaw) {
      try { savedForm = JSON.parse(formRaw) as ScraperFormSavedState } catch { /* 손상된 저장값은 무시 */ }
    }
    // 미리보기 진행 상황 복원 — 두 복원 경로(아래 initialSiteId 분기, 그리고 더 아래 savedForm-only 분기)가
    // 완전히 같은 패턴을 쓰므로 헬퍼로 공유한다.
    function resumePreviewIfRunning(siteId: number) {
      fetch(`/api/scrape/preview-progress?siteId=${siteId}`).then(r => r.json()).then((d: {
        done: number; total: number
        result?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; noProductsFound?: boolean }
      }) => {
        // 마운트되는 바로 그 순간 이미 완료돼 있었으면(폴링 시작 전) 1초 기다리지 않고 바로 반영한다.
        if (d.result) { applyCatalogPreview(d.result); return }
        if (!d.total) return
        setPreviewLoading(true)
        setPreviewProgress(d)
        resumePreviewProgressPolling(siteId)
      }).catch(() => {})
    }
    if (initialSiteId) {
      if (!savedSession || savedSession.site.id !== initialSiteId) {
        // 이 몰에 아직 시작한 스크랩 세션은 없지만("몰 구조분석"/카테고리 불러오기/미리보기만 해둔 상태),
        // selectSite()가 sites.scrape_profile "캐시"로 되살린 결과보다 방금 이 브라우저 세션에서 실제로
        // 받은 값(FORM_STATE_KEY에 저장된 savedForm.profileResult 등)이 더 최신이다 — 예전엔 여기서
        // selectSite() 후 바로 return해버려 이 복원을 완전히 건너뛰었다. 그래서 "몰 구조분석"을 실제로
        // 막 성공시킨 직후 dev 서버 Fast Refresh(강제 새로고침, 이 세션 내내 겪은 문제)로 화면이
        // 리마운트되면, 방금 받은 결과 대신 "📋 저장된 이전 분석 결과 표시 중"(캐시 복원) 배지가 잘못
        // 뜨는 문제가 있었다(사용자 실사용 확인, 2026-09-03).
        const siteId = initialSiteId
        selectSite(siteId).then(site => {
          if (savedForm && savedForm.siteId === siteId) applyFormState(savedForm, site?.manual_login_required === true)
          resumePreviewIfRunning(siteId)
        })
        return
      }
    } else if (initialClientId) {
      return
    }

    if (savedSession) {
      const saved = savedSession
      fetch(`/api/scrape/status?sessionId=${saved.sessionId}`).then(async r => ({ ok: r.ok, d: await r.json() as { status: string; product_count: number; saved_count: number; success_count: number; failed_count: number; error?: string; created_at: string; finished_at: string | null } })).then(({ ok, d }) => {
        setSelectedSite(saved.site)
        // 이 몰의 "스크랩 Raw 확인" 화면에서 세션을 삭제(처음부터 다시 스크랩하려고)한 뒤 이 화면을
        // 새로고침하면, 저장해둔 sessionId가 더 이상 존재하지 않아 404가 온다 — 죽은 sessionId를 그대로
        // 붙들지 않고 대기 상태로 되돌린다(2026-08-22, 위 status 폴링 effect의 같은 처리와 동일한 이유).
        setSessionId(ok ? saved.sessionId : null)
        setStatus(ok ? (d.status as Status) : 'idle')
        setProgress({
          saved: ok ? (Number(d.saved_count) || 0) : 0, total: ok ? (Number(d.product_count) || 0) : 0, error: ok ? d.error : undefined,
          successCount: ok ? (Number(d.success_count) || 0) : 0, failedCount: ok ? (Number(d.failed_count) || 0) : 0,
        })
        if (!ok) sessionStorage.removeItem(LAST_SESSION_KEY)
        setElapsedMinutes(ok && d.status === 'done' && d.finished_at ? elapsedMinutesBetween(d.created_at, d.finished_at) : null)
        setSessionCreatedAt(ok ? d.created_at : null)
        // 세션 복원과 별개로, 같은 몰의 카테고리 목록 등 폼 상태도 함께 복원한다 — 예전엔 여기서 그대로
        // return해버려 "스크랩 완료" 상태는 보이는데 그 위 카테고리 선택 목록은 사라져 보이는 문제가
        // 있었다(2026-08-10 실사용 확인). selectSite()는 카테고리/진행상황을 전부 초기화하는 함수라
        // (사용자가 다른 몰을 새로 고를 때 쓰는 용도) 여기서 그대로 쓰면 방금 복원한 세션까지 같이
        // 지워버리므로 쓰지 않고, 저장해둔 값을 직접 적용한다.
        if (savedForm && savedForm.siteId === saved.site.id) applyFormState(savedForm, saved.site.manual_login_required === true)
      }).catch(() => {})
      // 진행 로그(URL별 성공/실패)는 탭 전환으로 언마운트됐다 돌아와도 그대로 보여야 하므로 같이 복원한다.
      fetch(`/api/scrape/log?sessionId=${saved.sessionId}`).then(r => r.json()).then((rows: ItemLogRow[]) => {
        if (Array.isArray(rows)) setItemLog(rows)
      }).catch(() => {})
      return
    }
    // 아직 스크랩을 시작하지 않은 단계(위 세션 복원 대상이 없음)라도, 몰 선택/시작 URL/카테고리 목록만은
    // 그대로 이어서 볼 수 있도록 복원한다. selectSite가 site.url로 targetUrl을 기본값으로 초기화해버리므로,
    // 그 뒤에 저장해둔 실제 값으로 다시 덮어쓴다.
    if (!savedForm) return
    const siteId = savedForm.siteId
    selectSite(siteId).then(site => {
      applyFormState(savedForm!, site?.manual_login_required === true)
      // dev 서버 불안정으로 화면이 강제 새로고침되면(Fast Refresh) 미리보기가 서버에서는 계속 돌고
      // 있는데 화면만 "아무 일도 없었던 것"처럼 보인다 — 마운트 시점에 이 몰에 아직 도는 미리보기가
      // 있는지 한 번 확인해, 있으면 로딩 상태를 이어서 보여준다(resumePreviewProgressPolling 참고).
      resumePreviewIfRunning(siteId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만: initialSiteId는 탭 생성 시 고정되는 값
  }, [])

  // 위 복원의 짝 — 몰을 고르거나 시작 URL/카테고리 목록을 입력할 때, 그리고 미리보기 결과가 나올 때마다 저장해둔다.
  useEffect(() => {
    if (!selectedSite) return
    sessionStorage.setItem(FORM_STATE_KEY, JSON.stringify({
      siteId: selectedSite.id, targetUrl, categoryUrlsText, manualCategoryUrlsText, categorySourceMode,
      previewResult, previewTotal, previewItems, categoryCounts, detectedPlatform,
      loginStep, categories, categoriesCached, profileResult, scrapedCategoryHrefs, allCategoriesScraped, excludedCategoryHrefs,
      categorySettings,
    }))
  }, [selectedSite, targetUrl, categoryUrlsText, manualCategoryUrlsText, categorySourceMode, previewResult, previewTotal, previewItems, categoryCounts, detectedPlatform,
    loginStep, categories, categoriesCached, profileResult, scrapedCategoryHrefs, allCategoriesScraped, excludedCategoryHrefs,
    categorySettings])

  const filteredSites = useMemo(() => {
    const q = siteQuery.trim().toLowerCase()
    return sites.filter(s => {
      if (clientFilter !== '' && s.client_id !== clientFilter) return false
      if (!q) return true
      // 검색창 placeholder("Mall 이름·메인 품목·URL 검색...")가 그리드에 실제로 보이는 컬럼 중 "거래처"를
      // 빠뜨리고 있었다 — SITE_PICKER_COLUMNS(그리드가 쓰는 것과 같은 getValue)를 그대로 재사용해 지금
      // 보이는 컬럼 전부를 검색 대상으로 삼는다(사용자 지적, 2026-08-17). 컬럼이 나중에 추가/변경돼도
      // 이 검색이 자동으로 같이 따라간다.
      return SITE_PICKER_COLUMNS.some(col => col.getValue(s).toLowerCase().includes(q))
    })
  }, [sites, siteQuery, clientFilter])

  // 컬럼 구성은 고정이지만, 렌더링 시점에 "기존 순서 + 아직 안 담긴 새 키"를 계산해 useEffect로 state를
  // 동기화하지 않는다 (state-sync 이펙트 없이 항상 최신 컬럼 목록과 일치시키기 위함).
  const siteEffectiveOrder = useMemo(() => {
    const keys = SITE_PICKER_COLUMNS.map(c => c.key)
    const known = siteColOrder.filter(k => keys.includes(k))
    const missing = keys.filter(k => !known.includes(k))
    return [...known, ...missing]
  }, [siteColOrder])
  const siteOrderedColumns = siteEffectiveOrder.map(k => SITE_PICKER_COLUMNS.find(c => c.key === k)).filter((c): c is SitePickerColumnDef => !!c)

  function handleSiteColDrop(targetKey: string) {
    if (!siteDragKey || siteDragKey === targetKey) return
    const next = siteEffectiveOrder.filter(k => k !== siteDragKey)
    next.splice(next.indexOf(targetKey), 0, siteDragKey)
    setSiteColOrder(next)
    setSiteDragKey(null)
  }

  function startSiteResize(key: string, e: { clientX: number; preventDefault: () => void }) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = siteColWidths[key] ?? sitePickerWidthFor(key)
    function onMove(ev: MouseEvent) {
      setSiteColWidths(w => ({ ...w, [key]: Math.max(SITE_PICKER_MIN_COL_WIDTH, startWidth + (ev.clientX - startX)) }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function handleSiteSort(key: string, e: { shiftKey: boolean }) {
    setSiteSortKeys(prev => {
      const idx = prev.findIndex(s => s.key === key)
      if (e.shiftKey) {
        if (idx === -1) return [...prev, { key, dir: 'asc' }]
        const next = [...prev]
        next[idx] = { key, dir: next[idx].dir === 'asc' ? 'desc' : 'asc' }
        return next
      }
      if (prev.length === 1 && prev[0].key === key) {
        return [{ key, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }]
      }
      return [{ key, dir: 'asc' }]
    })
  }

  const siteHasColFilters = Object.values(siteColFilters).some(Boolean)
  const colFilteredSites = filteredSites.filter(s => SITE_PICKER_COLUMNS.every(col => {
    const f = siteColFilters[col.key]
    if (!f) return true
    return col.getValue(s).toLowerCase().includes(f.toLowerCase())
  }))
  const visibleSites = siteSortKeys.length
    ? [...colFilteredSites].sort((a, b) => {
        for (const { key, dir } of siteSortKeys) {
          const col = SITE_PICKER_COLUMNS.find(c => c.key === key)
          if (!col) continue
          const cmp = compareSitePickerValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : colFilteredSites
  const siteTableWidth = siteOrderedColumns.reduce((sum, col) => sum + (siteColWidths[col.key] ?? sitePickerWidthFor(col.key)), 0)

  useEffect(() => {
    if (!sessionId || status !== 'running') return
    pollRef.current = setInterval(async () => {
      const r = await fetch(`/api/scrape/status?sessionId=${sessionId}`)
      // "스크랩 Raw 확인" 화면에서 이 세션을 삭제(처음부터 다시 스크랩하려고)하면, 여기(스크래핑 화면)는
      // 그 사실을 모른 채 이미 없어진 sessionId를 계속 2초마다 물어본다 — 404 응답엔 status 필드 자체가
      // 없어 위 "done/error/stopped 확정" 분기를 절대 못 타므로, 진행 상황 카드가 어중간한 상태로 남아
      // "보였다 사라졌다"처럼 보였다(2026-08-22, 사용자가 직접 데이터를 지운 뒤 재현 확인). 404를 곧바로
      // "이 세션은 더 이상 없다"로 확정해 화면을 대기 상태로 깨끗이 되돌린다.
      if (r.status === 404) {
        setStatus('idle')
        setSessionId(null)
        setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 })
        setItemLog([]); setConcurrencyLog([]); setCollectProgress(null)
        setSessionCreatedAt(null)
        sessionStorage.removeItem(LAST_SESSION_KEY)
        if (pollRef.current) clearInterval(pollRef.current)
        return
      }
      const d = await r.json() as { status: string; product_count: number; saved_count: number; success_count: number; failed_count: number; error?: string; created_at: string; finished_at: string | null; concurrency_log?: { at: string; level: number; reason: 'ramp_up' | 'block_detected' }[]; collect_progress?: { done: number; total: number } | null }
      setProgress({
        saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error,
        successCount: Number(d.success_count) || 0, failedCount: Number(d.failed_count) || 0,
      })
      setCollectProgress(d.collect_progress ?? null)
      setSessionCreatedAt(d.created_at)
      if (Array.isArray(d.concurrency_log)) setConcurrencyLog(d.concurrency_log)
      fetch(`/api/scrape/log?sessionId=${sessionId}`).then(r => r.json()).then((rows: ItemLogRow[]) => {
        if (Array.isArray(rows)) setItemLog(rows)
      }).catch(() => {})
      if (d.status === 'done' || d.status === 'error' || d.status === 'stopped') {
        setStatus(d.status as Status)
        setStopping(false)
        if (pollRef.current) clearInterval(pollRef.current)
        if (d.status === 'done') {
          bumpRefresh('staging')
          if (d.finished_at) setElapsedMinutes(elapsedMinutesBetween(d.created_at, d.finished_at))
        }
      }
    }, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [sessionId, status, bumpRefresh])

  // 개발자모드(크롬 확장) 몰은 PTP가 아니라 사용자의 실제 브라우저에서 확장이 직접 세션을 만들고 채운다
  // (POST /api/scrape/extension-ingest) — "스크래핑 시작" 버튼이 없으니, 이 몰이 선택된 동안 새로 생긴
  // 세션이 있는지 주기적으로 확인하다가 발견되면 sessionId/status에 그대로 편입시킨다. 이후로는 위
  // 표준 진행상황 폴링(직접 시작했을 때와 동일한 로직)이 이어받아 진행률을 갱신하고 완료 시 "→ 스크랩
  // Raw 확인" 버튼까지 똑같이 띄운다.
  useEffect(() => {
    if (selectedSite?.manual_login_required !== true) return
    const site = selectedSite
    function checkForRunningSession() {
      fetch(`/api/sessions?siteId=${site.id}`).then(r => r.json()).then((d: DevModeSession[]) => {
        const latest = Array.isArray(d) ? d[0] : undefined
        if (!latest || latest.status !== 'running') return
        setSessionId(latest.id)
        setStatus('running')
        setAwaitingDevScrapeStart(false)
        setProgress({ saved: Number(latest.staged_count) || 0, total: Number(latest.found_count) || 0, successCount: 0, failedCount: 0 })
        setSessionCreatedAt(latest.created_at)
        sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site, sessionId: latest.id }))
      }).catch(() => {})
    }
    checkForRunningSession()
    const timer = setInterval(checkForRunningSession, 5000)
    return () => clearInterval(timer)
  }, [selectedSite])

  // 이 몰의 로그인 창/프로필을 지금 다른 스크랩 작업이 쓰고 있어 순서를 기다리는 중인지(withSiteLock)
  // 화면에 보여준다 — 몰이 선택돼 있는 동안 항상 가볍게 폴링한다(버튼을 누르기 전에도 "이 몰은 지금
  // 바쁩니다"를 미리 알 수 있게).
  useEffect(() => {
    // selectedSite가 없으면 그냥 폴링을 안 시작한다 — 아래 배너는 selectedSite도 같이 확인하니
    // stale한 이전 값이 남아있어도 안 보인다(여기서 굳이 setSiteLockStatus(null)로 지울 필요 없음).
    if (!selectedSite) return
    const siteId = selectedSite.id
    function poll() {
      fetch(`/api/scrape/site-lock-status?siteId=${siteId}`).then(r => r.json())
        .then((d: SiteLockStatusInfo) => {
          setSiteLockStatus(d)
          // 확장이 실제로 분석 요청을 서버에 보내 락이 잡히면(=사용자가 몰 창에서 확장 아이콘을 찾아
          // 눌렀다는 뜻) "🔍 몰 구조분석" 버튼의 대기 강조(awaitingDevProfileAction)는 더 이상 필요
          // 없다 — 이제부턴 이 락 자체가 "⏹ 중지" 버튼/로딩 표시로 진행 상황을 보여준다.
          if (d.busy && d.label === '몰 구조분석') setAwaitingDevProfileAction(false)
        })
        .catch(() => {})
    }
    poll()
    // 1.5초였던 걸 3초로 늘림(2026-08-31) — Next.js dev 서버의 on-demand-entries 내부 점검 주기가
    // maxInactiveAge 설정과 무관하게 5초로 상한이 걸려있어(node_modules/next/dist/server/dev/
    // on-demand-entry-handler.js의 pingIntervalTime = Math.max(1000, Math.min(5000, maxInactiveAge))),
    // 그 점검이 매니페스트를 다시 쓰는 순간과 이 폴링이 겹치면 "Manifest file is empty"/JSON 파싱 에러
    // + 로고 화면(강제 새로고침)으로 이어진다는 걸 실측으로 확인했다 — 매니페스트 재작성 시각과 이
    // 라우트(site-lock-status)의 에러 시각이 정확히 일치했다. 이 몰이 선택돼 있는 동안 항상(작업 중이든
    // 아니든) 도는 가장 빈번한 폴링이라 충돌 확률에 가장 크게 기여한다 — dev 전용 Next.js 내부 타이머
    // 자체를 건드릴 순 없으니(패치는 업그레이드마다 깨질 위험), 요청 빈도를 낮춰 겹칠 확률을 줄인다.
    // "다른 작업 대기 중" 표시가 1.5초 늦게 갱신되는 건 체감상 문제 없는 트레이드오프.
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [selectedSite])

  // 몰 선택이 그리드 클릭이 아닌 경로(위 "몰" 드롭다운, 다른 화면에서 특정 몰을 지정해 들어온 경우 등)로
  // 바뀌어도, 그리드 안에서 지금 선택된 행이 어디인지 스크롤해서 보여준다(사용자 요청, 2026-08-31).
  // mallSelectCollapsed도 의존성에 넣는 이유: 접힌 상태에서 선택이 바뀌면 행 자체가 안 그려져 있어(ref가
  // null) 그때는 스크롤할 수 없고, 나중에 펼쳤을 때 다시 시도해야 한다.
  // sites.length도 의존성에 넣는 이유: initialSiteId로 들어온 경우 selectSite(단건 조회)가 sites 목록
  // 조회(854행, 그리드 전체 데이터)보다 먼저 끝날 수 있다 — 그러면 이 효과가 selectedSite.id 갱신 시점에
  // 한 번 실행되는데 그때 그리드에 아직 행 자체가 없어(ref가 null) 스크롤이 조용히 아무 효과 없이
  // 끝나버리고, 이후 그리드가 다 채워져도 selectedSite.id는 더 안 바뀌니 다시 시도되지 않는 문제가
  // 실사용에서 확인됐다(2026-08-31 — 걸스굽으로 재현). sites가 비어있다가 채워지는 전이 시점에도
  // 다시 한번 스크롤을 시도하게 한다.
  useEffect(() => {
    if (!selectedSite || mallSelectCollapsed) return
    selectedSiteRowRef.current?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedSite 객체 자체가 갱신마다 새로 생성돼도 siteId만 같으면 다시 스크롤할 필요 없음
  }, [selectedSite?.id, mallSelectCollapsed, sites.length])

  const failedItems = itemLog.filter(r => r.status === 'failed')
  const successItems = itemLog.filter(r => r.status === 'success')

  // 이 몰이 "일반모드"(PTP 자동화) / "개발자모드"(크롬 확장) 중 무엇인지 — 아직 정해지지 않았으면(null)
  // 미리 고르게 하지 않고 곧바로 일반모드로 취급한다. PC인증 등으로 자동 로그인이 근본적으로 안 되는
  // 몰인지는 실제로 겪어보기 전엔 알 수 없으니(이미 여러 번 확인된 사실), 미리 묻는 대신 일단 로그인·
  // 스크랩을 시도해보게 하고, 실제로 차단이 반복 감지되면(아래 concurrencyLog 기반 배너) 그때 개발자모드
  // 전환을 제안한다(사용자 결정, 2026-08-15).
  const mallMode = !selectedSite ? null
    : selectedSite.manual_login_required ? 'devmode' : 'normal'

  // 개발자모드 "몰 구조분석"은 확장(extension-poc/background.js의 runProfile)이 이 서버 라우트를 직접
  // POST하고, 그 응답을 PTP 화면으로 돌려주지 않는다 — 그래서 handleProfileMall의 일반모드 성공 경로
  // (setProfileResult(d), 위 site-lock-status 폴링 useEffect와 별개)가 devmode에선 아예 안 불린다.
  // 화면은 siteLockStatus 폴링으로 "지금 도는 중"만 알 뿐, 끝난 뒤엔 계속 selectSite가 만든 캐시-복원
  // 상태(profileResult.isCachedRestore=true, thisRunReportSource=null)에 머물러 있어, 방금 막 성공한
  // 분석도 "📋 저장된 이전 분석 결과 표시 중"으로, AI 성공/실패 배지도 항상 표시 안 됨으로 잘못 보였다
  // (사용자 지적, 2026-09-04: "일반모드와 같이 성공 시 메시지도 맞춰서 조정해"). siteLockStatus.busy가
  // '몰 구조분석' 라벨로 켜져 있다가 꺼지는 바로 그 순간만 감지해(계속 폴링하는 게 아니라 전이 시점 1회)
  // 사이트 정보를 다시 가져와 lastRunReportSource(MallProfileSignals 주석 참고)로 정확한 배지를
  // 보여준다. 일반모드는 handleProfileMall이 이미 직접 응답을 받아 처리하므로 devmode에서만 돈다 —
  // 안 그러면 같은 전이에 두 경로가 동시에 profileResult를 써서 서로 덮어쓸 수 있다.
  // 시작 시점에도 일반모드(handleProfileMall의 즉시 scrollIntoView)와 똑같이 결과 영역으로 포커싱한다 —
  // 개발자모드는 확장 팝업에서 누르므로 이 화면엔 "누른 순간"이 없어, siteLockStatus가 busy로 바뀌는
  // 순간을 그 "누른 순간" 대신으로 쓴다(사용자 요청, 2026-09-04: "몰구조분석을 하면 포커스가 진행중인
  // 곳으로 포커싱 되게 해줘 — 다른 기능도 마찬가지로").
  const prevMallProfileBusyRef = useRef(false)
  useEffect(() => {
    if (mallMode !== 'devmode' || !selectedSite) { prevMallProfileBusyRef.current = false; return }
    const busyNow = !!(siteLockStatus?.busy && siteLockStatus.label === '몰 구조분석')
    const wasBusy = prevMallProfileBusyRef.current
    prevMallProfileBusyRef.current = busyNow
    if (wasBusy === busyNow) return
    if (busyNow) {
      requestAnimationFrame(() => profileResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      return
    }
    const siteId = selectedSite.id
    fetch(`/api/sites/${siteId}`).then(r => r.json()).then((full: { scrape_profile?: MallProfileSignals | null }) => {
      // 일반모드 handleProfileMall의 성공 경로가 하는 카테고리 그리드 리셋(위 handleProfileMall 주석
      // 참고 — "카테고리 불러오기"로 다시 확인해야 최신 목록이 반영됨을 명확히 함)을 devmode도 여기서
      // 똑같이 한다 — 이 useEffect가 devmode의 유일한 "몰 구조분석이 방금 끝났다"는 신호라, 여기서 안
      // 하면 devmode는 몰 구조분석을 몇 번을 다시 돌려도 예전 카테고리 목록(전체/선택 둘 다)이 그대로
      // 남아있었다(사용자 지적, 2026-09-05 — "몰 카테고리 선택 가져오기" 표에 이전 세션의 URL이 계속
      // 보임). fetch의 .then 콜백 안이라 effect 본문에서 곧바로 setState하는 게 아니다.
      setCategories([])
      setCategoriesCached(null)
      setCategoryUrlsText('')
      setManualCategoryUrlsText('')
      const p = full.scrape_profile
      if (!p || !p.sampleCount) return
      // aiReportAttempts/visionProviderLog는 이번 실행 전용 신호라 DB(scrape_profile)엔 없다 — 방금
      // busy→false로 바뀐 이 폴링 응답에 같이 실려온 lastRunSignals(site-lock-status 라우트 주석 참고)로
      // 보충한다(사용자 지적, 2026-09-24 — "개발자모드에서... 왜 어떤 llm이 사용되는지 안보이지?").
      setProfileResult({
        signals: { ...p, ...siteLockStatus?.lastRunSignals }, diffs: [], isFirstTime: false, autoRuleFields: [],
        thisRunReportSource: p.lastRunReportSource ?? null, isCachedRestore: false,
      })
      setProfileElapsedSec(null)
    }).catch(() => {})
  }, [siteLockStatus, mallMode, selectedSite])

  // 개발자모드 "스크랩 시작"도 확장이 만든 세션을 위 폴링(checkForRunningSession)이 뒤늦게 주워오는
  // 구조라 마찬가지로 이 화면엔 "누른 순간"이 없다 — 같은 세션을 두 번 스크롤하지 않도록 이미 스크롤한
  // sessionId를 기억해뒀다가, 처음 보는 running 세션을 발견한 순간에만 진행상황 영역으로 포커싱한다
  // (일반모드 handleStart의 progressSectionRef.scrollIntoView와 같은 목적지).
  const scrolledDevmodeSessionIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (mallMode !== 'devmode') return
    if (status !== 'running' || sessionId == null) return
    if (scrolledDevmodeSessionIdRef.current === sessionId) return
    scrolledDevmodeSessionIdRef.current = sessionId
    requestAnimationFrame(() => progressSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [mallMode, status, sessionId])

  // 개발자모드는 카테고리 선택을 서버(sites.devmode_category_urls)에 저장해둬야 확장이 "스크랩 시작"/
  // "스크랩 미리보기" 때 읽어갈 수 있다(팝업/백그라운드는 이 화면과 실시간으로 연결돼 있지 않은 별도
  // 실제 크롬 탭이라, DB를 거쳐야 한다, 2026-08-15) — 체크할 때마다 바로 쏘지 않고 살짝 묶어서(500ms)
  // 보낸다. buildCategoryUrlsAndLimits(실제 스크랩 요청 만들 때 쓰는 함수)와 반드시 같은 기준
  // (categorySourceMode)을 써야 한다 — 예전엔 categoryUrlsText("전체 가져오기")만 보고 있어서,
  // "선택 가져오기(반복)"로 전환하면(activateManualMode가 categoryUrlsText를 비움) 확장에는 빈 목록이
  // 저장돼 카테고리를 아무리 모아도 확장이 그 사실을 전혀 모르는 채로 남아있었다(사용자 지적,
  // 2026-09-05 — "선택 가져오기"에 카테고리를 모아도 스크랩 미리보기에서 개수가 계속 안 나옴).
  useEffect(() => {
    if (mallMode !== 'devmode' || !selectedSite) return
    const siteId = selectedSite.id
    const urls = activeCategoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    const timer = setTimeout(() => {
      fetch(`/api/sites/${siteId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        // categorySettings는 href 원본 그대로(정렬을 URL에 굽지 않고) 저장한다 — 확장의 run()이 스크랩
        // 시작 순간에만 정렬을 반영한다(devmode_category_urls와 분리해둔 이유는 lib/db.ts 컬럼 주석 참고).
        body: JSON.stringify({ devmodeCategoryUrls: urls, devmodeCategorySettings: categorySettings }),
      }).catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [mallMode, selectedSite, activeCategoryUrlsText, categorySettings])

  /** 로그인확인 이후 단계(몰구조파악/추출규칙/스크랩)의 안내 문구를 정하는 데 쓰는 서버 판정 —
   *  undefined=조회 전, null=이 화면에서 더 안내할 게 없음(스크랩까지 이미 끝남), 그 외엔
   *  lib/scrape/nextStep.ts의 key('profile'|'rules'|'scrape'|'confirm'). */
  const [dbStepKey, setDbStepKey] = useState<string | null | undefined>(undefined)
  /* eslint-disable react-hooks/set-state-in-effect -- siteId 변경 시 이전 안내를 즉시 지워야 함(비동기 fetch 응답 전까지 낡은 안내가 남는 것 방지) */
  useEffect(() => {
    const siteId = selectedSite?.id
    if (!siteId) { setDbStepKey(undefined); return }
    setDbStepKey(undefined)
    fetch(`/api/sites/${siteId}/next-step`).then(r => r.json()).then(d => setDbStepKey(d.nextStep?.key ?? null)).catch(() => setDbStepKey(null))
  }, [selectedSite, refreshSignals.sites])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 지금 이 화면(스크래핑)에서 "다음에 뭘 눌러야 하는지"를 전체 과정 순서대로 안내한다 — 몰 선택 →
  // (기본 일반모드: 로그인 창 열기 → 로그인 확인 → 몰 구조분석 → 스크랩 미리보기 → 스크래핑 시작 /
  // 개발자모드: 브라우저에서 열기+로그인 → 확장으로 미리보기 → 확장으로 스크랩 시작) → 진행 중 대기 →
  // 완료 후 스크랩 Raw 확인으로 이동, 또는 실패/중지 시 이어서 진행. 로그인 창을 열었는데 실제로 로그인이
  // 안 되면(자동화 브라우저를 막는 몰) 로그인 카드의 "개발자모드로 전환" 링크로 바로 갈아탈 수 있다.
  //
  // status/progress는 개발자모드도 확장이 실제 세션을 만들면(위 checkForRunningSession 폴링) 일반모드와
  // 완전히 같은 값으로 채워지므로, 스크랩이 실제로 시작된 뒤부터는 두 모드가 같은 안내를 그대로 쓴다.
  // 시작 전 단계만 모드별로 갈린다 — 개발자모드는 로그인/몰구조파악처럼 PTP가 직접 감지하는 단계가 없어
  // (사용자가 크롬 확장으로 진행) previewResult 유무 정도로만 두 단계(로그인+열기 / 확장으로 시작)를
  // 구분한다. 탭을 벗어나면(언마운트) 안내를 지워 다른 화면까지 따라오지 않게 한다.
  useEffect(() => {
    let text: string | null = null
    if (!selectedSite) text = '"Mall 선택" - 먼저 스크랩할 몰을 선택합니다.'
    else if (status === 'running') text = '스크래핑 진행 중 - 완료될 때까지 기다립니다. (중지하려면 "스크래핑 중지" 버튼을 클릭합니다.)'
    else if (status === 'done') text = '"스크랩 Raw 확인" - 수집된 상품을 확인하러 이동합니다.'
    else if (status === 'error' || status === 'stopped') {
      text = mallMode === 'normal'
        ? '"이어서 스크랩하기" - 실패/중지된 지점부터 이어서 스크랩합니다.'
        : '몰 탭 확장 아이콘에서 "🔄 스크랩 시작"을 다시 눌러 이어서 진행합니다.'
    } else if (mallMode === 'normal') {
      if (loginStep === 'none') text = '"로그인 창 열기" - 몰 로그인 창에서 로그인합니다.'
      else if (loginStep === 'opened') text = '"로그인 확인" - 몰에서 로그인하셨다면 로그인확인 버튼을 클릭합니다.'
      else if (dbStepKey === 'profile') text = '"몰 구조분석" - 몰 구조분석 버튼을 클릭합니다.'
      else if (dbStepKey === 'rules') text = '"몰 구조분석" - 다시 클릭해 추출규칙을 생성합니다.'
      else if (dbStepKey === 'scrape') {
        text = previewResult
          ? '"스크래핑 시작" - 확인이 끝났다면 스크래핑 시작 버튼을 클릭합니다.'
          : '"스크랩 미리보기" - 스크랩 미리보기 버튼을 클릭해 수집 결과를 확인합니다.'
      }
    } else if (mallMode === 'devmode') {
      text = previewResult
        ? '몰 탭 확장 아이콘에서 "🔄 스크랩 시작"을 눌러 스크랩을 시작합니다.'
        : '"브라우저에서 바로 열기" - 몰을 열어 로그인한 뒤, 몰 탭 확장 아이콘에서 "🔍 스크랩 미리보기 - (카테선택)"을 누릅니다.'
    }
    setGuidance(text)
    return () => setGuidance(null)
  }, [selectedSite, mallMode, loginStep, dbStepKey, status, previewResult, setGuidance])

  /** 개발자모드 몰 URL을 실제로 열어준다 — CDP(원격 디버깅) 연결이 전혀 없는 진짜 크롬이라("로그인
   *  확인"의 openManualLoginWindow와 동일한 방식) 개발자모드 몰의 자동화 감지에 걸리지 않는다. ID/PW는
   *  이 방식으로는 자동 입력할 수 없다 — 입력하려면 CDP가 있어야 하는데, 그게 바로 이 몰들이 차단하는
   *  신호라 "자동 로그인까지"는 이 방식과 모순된다. 대신 아래에 복사 버튼으로만 제공한다. */
  async function handleOpenMallUrlDirect(url: string) {
    if (!selectedSite) return
    await fetch('/api/scrape/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: selectedSite.id, url, manualLogin: true }),
    })
    // 개발자모드는 이 호출마다 실제 크롬 창을 새로 하나씩 띄운다(재사용 안 함, openManualLoginWindow
    // 참고) — "스크랩 미리보기"/"스크랩 대상 직접지정"이 이 함수를 대신 호출하게 되면서(2026-08-16),
    // 그 버튼을 여러 번 눌러도 매번 새 창이 쌓이지 않도록 "이번 몰 선택 동안 이미 열었다"는 표시가
    // 필요해졌다 — loginStep은 selectSite/몰 변경마다 초기화되므로 이 용도로 그대로 재사용한다.
    setLoginStep('opened')
  }

  async function handleCopyCred(which: 'id' | 'pw', value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCredCopied(which)
      setTimeout(() => setCredCopied(null), 1500)
    } catch { /* 클립보드 권한이 없으면 조용히 무시 */ }
  }

  async function handleChooseScrapeMode(devMode: boolean) {
    if (!selectedSite) return
    setModeSaving(true)
    try {
      await fetch(`/api/sites/${selectedSite.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualLoginRequired: devMode }),
      })
      setSelectedSite(prev => prev && { ...prev, manual_login_required: devMode })
      bumpRefresh('sites')
    } finally {
      setModeSaving(false)
    }
  }

  async function selectSite(siteId: number) {
    const res = await fetch(`/api/sites/${siteId}`)
    if (!res.ok) { alert(`Mall 정보를 불러오지 못했습니다 (${res.status})`); return }
    const full = await res.json() as Site & {
      login_pw: string | null
      extraction_rules?: Record<string, { type: string; value: string }>
      devmode_ai_preview?: boolean
      devmode_category_urls?: string[]
      devmode_category_settings?: Record<string, { sortLabel?: string; limitMode?: 'count' | 'pages'; limitValue?: number }>
      scrape_profile?: MallProfileSignals | null
      mall_report_updated_at?: string | null
      category_scrape_history?: Record<string, { lastScrapedAt: string | null; clientName: string | null }>
    }
    setSelectedSite({
      id: full.id, name: full.name, url: full.url, login_url: full.login_url, login_id: full.login_id,
      manual_login_required: full.manual_login_required, profile_dir: full.profile_dir,
      last_login_confirmed_at: full.last_login_confirmed_at, has_completed_scrape: full.has_completed_scrape,
    })
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
    setLoginStep('none')
    setLoginVerified(null)
    // 이 몰에 예전에 "스크랩 대상 직접지정"으로 등록해둔 컬럼이 있으면, 피커를 켜지 않은 채 바로 미리보기만
    // 해도 그리드에 컬럼으로 나오도록 미리 채워둔다(그리드는 이 목록에 있는 필드만 컬럼으로 보여준다).
    setPickerRules(full.extraction_rules || {})
    setSiteQuery('')
    setTargetUrl(full.url)
    // 개발자모드는 카테고리 선택이 서버에 저장돼 있다(확장이 "스크랩 시작" 시 읽어가야 하므로) — 그 값을
    // 그대로 복원한다. 일반모드는 이전 사이트의 카테고리 목록이 남아 시작 URL을 무시하는 걸 막기 위해 비운다.
    setCategoryUrlsText(full.manual_login_required === true ? (full.devmode_category_urls || []).join('\n') : '')
    setManualCategoryUrlsText('')
    // "선택 가져오기(반복)" 탭을 켜둔 채로 다른 몰로 넘어가면, 방금 위에서 복원한 이 몰의 진짜
    // categoryUrlsText 대신 activeCategoryUrlsText가 (방금 비운) manualCategoryUrlsText를 가리켜 빈
    // 목록으로 보이고, 그 상태로 잠시 후 devmode_category_urls 동기화 이펙트가 서버에 빈 배열을 그대로
    // 덮어써버린다(전수조사로 발견, 2026-09-05 — activateAutoMode/activateManualMode가 탭 "전환"
    // 시점에는 반대쪽을 비우지만, 몰 "전환" 시점엔 이 값 자체를 안 건드리고 있었다). 몰을 바꾸면 항상
    // "전체 가져오기"로 되돌린다 — 다른 몰의 selection-mode 취향까지 넘어올 이유가 없다.
    setCategorySourceMode('auto')
    // 이전 몰의 몰구조분석/카테고리 결과가 화면에 그대로 남아있으면 안 된다 — 다른 몰을 선택했는데 방금
    // 전 몰의 분석 결과·완료/제외 표시가 계속 보이는 문제가 있었다(사용자 지적, 2026-08-16: "몰을
    // 변경하면 기존 작업내역은 없어져야 하는게 맞지").
    setCategories([])
    setCategoriesCached(null)
    setLoginBlockedExpansion(false)
    setCategoryAnomalyWarning(null)
    setCategoryAiUsed(false)
    // 개발자모드는 카테고리별 정렬/상한 그리드 설정도 서버에 저장돼 있다(위 devmode_category_urls와 같은
    // 이유) — 그대로 복원한다. 일반모드는 이전 몰의 설정이 남지 않도록 비운다.
    setCategorySettings(full.manual_login_required === true ? (full.devmode_category_settings || {}) : {})
    setDetectedPlatform(null)
    setProfileResult(null)
    setManualSortOptions([])
    setProfileError('')
    setProfileElapsedSec(null)
    setScrapedCategoryHrefs([])
    setAllCategoriesScraped(false)
    setExcludedCategoryHrefs([])
    setCategoryInfo({})
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([]); setPreviewSource(null)
    setSessionExpiredWarning(false)
    // 반대로, 이 몰이 이전에 몰 구조분석/카테고리 불러오기를 이미 성공적으로 마쳐뒀다면(sites.scrape_profile
    // 캐시) 그 결과를 곧바로 되살려, 두 단계를 또 거칠 필요 없이 카테고리 선택→스크래핑으로 바로 넘어갈
    // 수 있게 한다 — 일반모드/개발자모드가 이 상태(categories/categoryChecklistBox/MallProfileResultDisplay)를
    // 그대로 공유해서 별도 분기 없이 양쪽에 동일하게 적용된다(사용자 요청, 2026-08-16).
    const cachedProfile = full.scrape_profile
    if (cachedProfile && cachedProfile.sampleCount > 0) {
      // thisRunReportSource: null — 방금 실행이 아니라 예전에 저장해둔 캐시를 그냥 화면에 되살리는
      // 것뿐이라 "이번 실행이 성공/실패했는지"를 말할 수 없다(MallProfileResultDisplay 배지 로직 참고).
      // isCachedRestore: true — diffs/isFirstTime이 진짜 비교 결과가 아니라는 걸 배지 로직에 알린다
      // (ProfileCheckResult.isCachedRestore 주석 참고).
      setProfileResult({ signals: cachedProfile, diffs: [], isFirstTime: false, autoRuleFields: [], thisRunReportSource: null, isCachedRestore: true })
    }
    // sortOptions는 몰 구조분석(sampleCount>0)과 무관하게 "선택 가져오기"만으로도 저장될 수 있다
    // (app/api/scrape/categories/sort-options) — categoryLinks 유무와 별개로 항상 복원한다.
    if (cachedProfile?.sortOptions?.length) setManualSortOptions(cachedProfile.sortOptions)
    if (cachedProfile?.categoryLinks?.length) {
      setCategories(dedupeCategoryLinks(cachedProfile.categoryLinks.map(c => ({ href: c.href, text: c.name }))))
      setDetectedPlatform(cachedProfile.platform || null)
      setCategoriesCached({ cached: true, updatedAt: full.mall_report_updated_at ?? null })
      setCategoryAiUsed(!!cachedProfile.categoryLinksAiUsed)
      // "제외"로 표시해둔 카테고리는 몰을 다시 선택했을 때도(카테고리 불러오기를 새로 누르지 않아도)
      // 그대로 유지돼야 한다 — 서버(sites.scrape_profile.excludedCategoryHrefs)에는 이미 저장돼 있었지만,
      // 캐시 복원 경로가 이 필드를 안 읽어와 화면에서는 매번 비어 보이던 문제(사용자 지적, 2026-08-16).
      setExcludedCategoryHrefs(cachedProfile.excludedCategoryHrefs || [])
      // "새 카테고리 M개" 배지도 캐시 복원 시(탭 재진입 등) 그대로 살아있어야 한다 — 위 excludedCategoryHrefs와
      // 같은 이유(사용자 요청, 2026-09-05).
      setNewCategoryHrefs(cachedProfile.newCategoryHrefs || [])
      // 카테고리 체크리스트의 상품개수/확인일시/최근 스크랩/업체 컬럼 복원(사용자 요청, 2026-08-17).
      if (cachedProfile.categoryCounts) {
        setCategoryInfo(mergeCategoryInfo(cachedProfile.categoryCounts, full.category_scrape_history || {}))
      }
    }
    // AI모드는 일반모드에선 그냥 로컬 상태(기본 켜짐)지만, 개발자모드는 확장이 실행 시점마다 서버에서
    // 값을 물어봐야 해서 DB에 저장해둔 값을 그대로 복원한다.
    setAiMode(full.manual_login_required === true ? !!full.devmode_ai_preview : true)
    setPickerActive(false)
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    // 다른 몰을 새로 고르는 것이므로, 이전 몰의 진행 상황("수집완료" 등)이 화면에 그대로 남아있으면 안
    // 된다 — LAST_SESSION_KEY 복원(마운트 시 1회)과 별개로, 몰을 바꿀 때마다 항상 초기화한다.
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([]); setCollectProgress(null)
    setSessionCreatedAt(null)
    setItemLog([])
    setStopping(false)
    setRetrying(false)
    sessionStorage.removeItem(LAST_SESSION_KEY)
    // 탭 전환 등으로 이 화면이 다시 마운트돼도, 로그인 창이 서버에 실제로 열려있으면 그 상태를 그대로 복원한다
    // (loginStep은 이 컴포넌트의 로컬 상태라 마운트될 때마다 초기화되지만, 실제 브라우저 세션은 서버에 계속 살아있을 수 있다).
    // 반대로 서버에 열려있는 게 없으면 명시적으로 'none'으로 되돌린다 — 안 그러면 아래 FORM_STATE_KEY
    // 복원(localStorage에 남아있던 예전 loginStep='confirmed')이 이 값을 덮어써도 아무도 고쳐주지 않아,
    // PTP 서버를 재시작해 실제 로그인 창이 사라진 뒤에도 화면은 계속 "확인됨"으로 남는 문제가 있었다.
    fetch(`/api/scrape/current-url?siteId=${siteId}`).then(r => r.json()).then((d: { url: string | null }) => {
      setLoginStep(d.url ? 'confirmed' : 'none')
    }).catch(() => {})
    return full
  }

  async function handleOpenLogin() {
    if (!selectedSite) return
    setLoginBusy(true)
    try {
      await fetch('/api/scrape/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: selectedSite.id, url: selectedSite.login_url || selectedSite.url, loginId, loginPw,
          manualLogin: selectedSite.manual_login_required,
        }),
      })
      setLoginStep('opened')
      setLoginVerified(null)
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleConfirmLogin() {
    if (!selectedSite) return
    setLoginBusy(true)
    try {
      const res = await fetch('/api/scrape/login-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id }),
      })
      const d = await res.json() as { ok: boolean; currentUrl: string | null; loggedIn: boolean | null }
      if (d.currentUrl) { setTargetUrl(d.currentUrl); setCategoryUrlsText(''); setManualCategoryUrlsText('') }
      setLoginVerified(d.loggedIn)
      setLoginStep('confirmed')
      // 이번 세션 안에서 로그인 창을 다시 열었다가 또 "확인 대기 중"이 될 수 있는데, 그때 PC인증 힌트가
      // (방금 이 몰의 로그인이 실제로 성공했음에도) 다시 뜨지 않도록 로컬 상태도 같이 갱신해둔다 — 서버
      // 값은 login-confirm 라우트가 이미 갱신했으니, 다음에 몰을 다시 선택하면 거기서도 그대로 반영된다.
      setSelectedSite(prev => prev && { ...prev, last_login_confirmed_at: new Date().toISOString() })
      // 예전엔(몰구조분석 캐시 복원이 생기기 전) 로그인 확인마다 profileResult를 비웠는데, 지금은
      // selectSite가 캐시된 분석 결과를 이미 복원해서 보여주고 있어 그걸 로그인 확인 한 번으로 지워버리면
      // 방금 보이던 내용이 사라지는 것처럼 보인다(사용자 지적, 2026-08-17). 로그인 확인 자체는 몰 구조가
      // 바뀌었는지와 무관하니 건드리지 않는다 — "몰 구조분석"을 다시 누르면 그때 새 결과로 덮어써진다.
      setProfileError('')
      setPickerActive(false)
      setSessionExpiredWarning(false)
      await refreshPickerRules()
    } finally {
      setLoginBusy(false)
    }
  }

  /** "몰 구조분석" — 결제계좌/택배사 등 거래정보를 AI로 분석해(app/api/sites/[id]/profile →
   *  runMallStructureReport) 그 자리에서 즉시 결과를 보여준다. 몰 구조 "변경 감지"는 이 메뉴가 아니라
   *  '마이그레이션3_연속관리'에서 한다(2026-08 이전). */
  async function handleProfileMall() {
    if (!selectedSite) return
    // 개발자모드 몰은 애초에 "서버 자동화(헤드리스 크롬)가 이 몰에서 안 먹혀서" 등록한 예외 경로다 —
    // 그런데 이 버튼이 여전히 서버 헤드리스(개인 크롬 프로필 사본)로 곧장 분석해버리면, 자동화가 막히는
    // 바로 그 몰에서 신뢰할 수 없는 결과를 "성공"으로 돌려줄 수 있다. 그래서 개발자모드에서는 이 버튼을
    // 새 창/새 탭을 여는 대신, 이미 로그인해둔 그 개인 크롬 창을 그대로 앞으로 가져오기만 하고, 실제
    // 분석은 그 창의 확장(chrome.debugger는 사용자 제스처가 있어야 붙는 물리적 제약이라 서버가 대신할 수
    // 없음)에 맡긴다 — handleOpenMallUrlDirect(새 탭이 매번 쌓임)는 여기선 안 쓴다(사용자 지적,
    // 2026-08-29: "다른 창 띄우지 말고 이미 로그인한 창으로 포커싱되게").
    if (mallMode === 'devmode') {
      const focused = await fetch('/api/scrape/login/focus', { method: 'POST' })
        .then(r => r.json()).then(d => !!d.ok).catch(() => false)
      showProfileFocusHint(focused
        ? '로그인한 몰에서 PTP 확장 아이콘 → "🧭 보조 - 몰 구조분석"을 눌러 실행하세요.'
        : '열려있는 몰 로그인 창을 찾지 못했습니다 — 먼저 "브라우저에서 바로 열기"로 로그인 창을 연 뒤, 로그인한 몰에서 PTP 확장 아이콘 → "🧭 보조 - 몰 구조분석"을 눌러 실행하세요.')
      startAwaitingDevProfileAction()
      return
    }
    setProfileLoading(true)
    setProfileError('')
    setProfileElapsedSec(null)
    const startedAt = Date.now()
    // handlePreview와 같은 이유로, 결과(또는 로딩 스켈레톤)가 나올 자리로 화면을 스크롤한다(사용자 요청, 2026-08-17).
    requestAnimationFrame(() => profileResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    try {
      const res = await fetch(`/api/sites/${selectedSite.id}/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiProviders: [...profileAiProviders] }),
      })
      const d = await res.json()
      if (!res.ok) { setProfileError(d.error || '몰 구조분석에 실패했습니다'); return }
      setProfileResult(d as ProfileCheckResult)
      setProfileElapsedSec(Math.round((Date.now() - startedAt) / 1000))
      // "몰 구조분석"이 방금 찾아낸 카테고리(d.signals.categoryLinks)가 위 결과 카드엔 바로 반영되지만,
      // 그 아래 "스크랩 대상" 그리드(categories)는 이 함수가 안 건드려 예전에 "카테고리 불러오기"로
      // 채워뒀던 목록이 그대로 남아있었다 — 몰 구조분석으로 카테고리 판별 로직 자체가 고쳐진 경우(사용자
      // 실사용 확인, 2026-09-03: 상품 링크가 카테고리로 잘못 섞여 있던 걸 고친 뒤 몰 구조분석을 다시
      // 돌렸는데도 그 아래 그리드엔 오염된 옛 목록이 그대로 보여 "안 고쳐진 줄 알았다"), 위 결과와 아래
      // 그리드가 서로 다른 카테고리 목록을 보여주는 것처럼 보여 혼란스럽다. 자동으로 다시 채우는 대신
      // 비워서, "카테고리 불러오기"를 다시 눌러야 최신 목록이 반영된다는 걸 명확히 한다(둘을 자동 동기화
      // 하면 사용자가 손으로 골라둔 선택/체크 상태까지 조용히 사라져 더 헷갈릴 수 있어, 명시적 재조회를
      // 요구하는 쪽을 택함 — "카테고리 불러오기"로 다시 확인해 정상 동작을 확인했다는 사용자 워크플로와
      // 동일).
      setCategories([])
      setCategoriesCached(null)
      setCategoryUrlsText('')
      setManualCategoryUrlsText('')
      bumpRefresh('sites')
    } catch {
      setProfileError('몰 구조분석에 실패했습니다')
    } finally {
      setProfileLoading(false)
    }
  }

  /** "몰 구조분석 중지" — 서버 쪽(카테고리/정렬 분류에 쓰는 로컬 AI 호출 포함)은 /profile/stop이 직접
   *  끊는다. 개발자모드가 몰 탭에서 도는 카테고리 하위구조 확인/정렬 옵션 감지까지 원격으로 멈추려던
   *  sendExtensionAction('stop-profile', ...) 시도는 제거했다 — extension-poc/manifest.json에
   *  externally_connectable이 없어 항상 조용히 실패하고 있었다(다른 sendExtensionAction 호출부와 같은
   *  이유, 2026-09-05). 이 확장 쪽 단계는 보통 몇~십여 초 안에 스스로 끝나는 짧은 작업이라(실사용 로그
   *  기준), 원격으로 못 끊어도 실질적 불편은 적다고 판단해 그대로 둔다 — 화면은 서버 쪽 중지만으로도
   *  바로 초기 상태로 돌아간다. */
  async function handleStopProfileMall() {
    if (!selectedSite) return
    await fetch(`/api/sites/${selectedSite.id}/profile/stop`, { method: 'POST' }).catch(() => {})
    showDevHint('몰 구조분석을 중지했습니다.')
  }

  /** "몰 카테고리 전체 가져오기" 중지 — handleStopProfileMall과 같은 패턴. 서버 쪽 abort만 신호로
   *  보내고, 화면 로딩 상태는 원래 handleLoadCategories의 await fetch(...)가 부분 결과로 정상 응답할
   *  때 스스로 정리된다(사용자 요청, 2026-08-26). */
  async function handleStopCategories() {
    if (!selectedSite) return
    await fetch('/api/scrape/categories/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: selectedSite.id }),
    }).catch(() => {})
  }

  /** "스크랩 대상 직접지정" — 로그인 창에 클릭식 엘리먼트 피커를 주입한다. 사용자가 실제 몰 페이지에서 값을 클릭하고
   *  컬럼명을 입력하면 그 자리에서 sites.extraction_rules에 저장되므로, 여기서는 시작/종료와 "지금까지
   *  지정된 컬럼" 목록 표시만 맡는다(폴링으로 갱신 — 몰 페이지 안에서 저장하는 거라 이 화면과 직접 연결돼
   *  있지 않음). 미리보기를 이미 돌려본 상태면, 그 미리보기가 열어본 바로 그 상품 페이지를 로그인 창에
   *  먼저 띄운다 — 화면에 보이는 미리보기 값과 로그인 창에서 클릭할 요소가 같은 상품이어야 의미가 있다. */
  async function handleStartPicker() {
    if (!selectedSite) return
    setPickerBusy(true)
    try {
      // 미리보기 상품 페이지로 이동하는 것까지 서버 쪽(startElementPicker)에서 같은 탭에 대해 한 번에
      // 처리한다 — 예전엔 여기서 새 탭을 먼저 열고 서버가 "마지막 탭"을 다시 골랐는데, 이 버튼을 다시
      // 누를 때마다(예: 다른 메뉴 갔다 돌아와서) 매번 탭이 하나씩 쌓이며 예전 탭의 피커가 안 닫힌 채
      // 방치돼 최신 탭과 서로 저장을 경쟁하는 문제가 있었다.
      const res = await fetch(`/api/sites/${selectedSite.id}/picker/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewProduct: previewResult?.product ?? null, targetUrl: previewResult?.sourceUrl ?? null }),
      })
      const d = await res.json()
      if (!res.ok) { alert(d.error || '스크랩 대상 직접지정을 시작하지 못했습니다'); return }
      setPickerActive(true)
      await refreshPickerRules()
    } finally {
      setPickerBusy(false)
    }
  }

  async function refreshPickerRules() {
    if (!selectedSite) return
    const res = await fetch(`/api/sites/${selectedSite.id}`)
    const d = await res.json() as { extraction_rules?: Record<string, { type: string; value: string }> }
    const nextRules = d.extraction_rules || {}
    setPickerRules(nextRules)
    // 규칙이 실제로 바뀌었을 때만(2초마다 매번은 아니고) 미리보기 상품 1건을 가볍게 다시 추출해 그리드에
    // 곧바로 반영한다 — 안 그러면 픽커로 새 컬럼을 지정해도 "스크랩 미리보기"를 수동으로 다시 눌러야만
    // 보였다(사용자 지적, 2026-09-12 — "직접지정에서 새로 컬럼을 만든 것은 미리보기 그리드에 표시되어야
    // 하는 거 아니야?"). 전체 미리보기(카테고리 개수 재집계 포함, 몰에 따라 몇 분씩 걸림)를 다시 도는
    // 대신 lib/scraper.ts의 reExtractPreviewProduct로 상품 1건만 가볍게 다시 읽는다.
    const nextRulesJson = JSON.stringify(nextRules)
    const changed = nextRulesJson !== lastPickerRulesJsonRef.current
    lastPickerRulesJsonRef.current = nextRulesJson
    const preview = previewResultRef.current
    if (changed && preview) {
      const refreshRes = await fetch(`/api/sites/${selectedSite.id}/preview-refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: preview.sourceUrl }),
      }).catch(() => null)
      const refreshData = await refreshRes?.json().catch(() => null) as
        { preview?: { sourceUrl: string; product: PreviewProduct } | null } | null
      if (refreshData?.preview) setPreviewResult(refreshData.preview)
    }
  }

  // 피커가 켜져있는 동안 몰 페이지에서 저장한 컬럼이 이 화면에도 곧바로 보이도록 짧게 폴링한다.
  useEffect(() => {
    if (!pickerActive) return
    const id = setInterval(refreshPickerRules, 2_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshPickerRules는 selectedSite를 클로저로 참조, 매번 새로 만들어도 되는 인터벌 콜백이라 의존성 경고는 무시
  }, [pickerActive, selectedSite])

  /** 로그인 창의 "지금 보고 있는 페이지" URL을 카테고리 URL 목록에 한 줄 추가한다 — 예전엔 targetUrl
   *  (단일 URL)을 덮어썼는데, 카테고리를 하나씩 옮겨다니며 여러 개 모아야 하는 경우가 많다는 지적
   *  (2026-08-22)으로 반복해서 눌러 계속 쌓이도록 바꿨다. 이미 목록에 있는 URL이면 중복 추가하지 않는다. */
  async function handleRefreshCurrentUrl() {
    if (!selectedSite) return
    activateManualMode()
    setCurrentUrlLoading(true)
    try {
      const res = await fetch(`/api/scrape/current-url?siteId=${selectedSite.id}`)
      const d = await res.json() as { url: string | null }
      // 몰 홈(첫 화면)은 카테고리가 아니다 — 목록에 들어가면 그 줄이 미리보기/스크랩의 첫 대상이 돼
      // "몰 홈페이지 자체가 상품 1건"으로 나오는 사고로 이어진다(2026-09-13, 투비즈온 실사용 확인:
      // 상품명이 몰 타이틀, 공급가 ₩2,640). 쿼리가 붙은 URL은 카테고리일 수 있어 막지 않는다.
      if (d.url && looksLikeMallHomeUrl(d.url)) {
        alert('지금 로그인 창이 보고 있는 화면이 몰 첫 화면(홈)입니다 — 카테고리가 아니라 목록에 넣지 않았습니다.\n\n로그인 창에서 원하는 카테고리 페이지로 이동한 뒤 다시 눌러주세요. (카테고리 링크가 새 탭으로 열렸다면 그 탭에서 한 번 더 이동하거나 새로고침한 뒤 눌러주세요.)')
        return
      }
      if (d.url) {
        const isNew = !manualCategoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean).includes(d.url)
        setManualCategoryUrlsText(prev => {
          const lines = prev.split('\n').map(s => s.trim()).filter(Boolean)
          return lines.includes(d.url!) ? prev : [...lines, d.url].join('\n')
        })
        setCurrentUrlFetched(true)
        // 사용자가 직접 확인한 카테고리를 서버에도 "기억"시켜, 다음번 자동 탐지(규칙 기반의 URL 패턴
        // 재확인/AI의 근거 예시)가 이 확인 내역을 그대로 참고하게 한다(사용자 요청, 2026-08-26 — "수동
        // 선택 작업한 내용을 참고하여서... 룰 방식이건 AI가 참고해서 분석이 가능하도록"). 화면 흐름을
        // 막지 않는 조용한 백그라운드 작업이라 실패해도 알리지 않는다.
        if (isNew) {
          fetch('/api/scrape/categories/sample', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteId: selectedSite.id, url: d.url }),
          }).catch(() => {})
        }
        // 카테고리를 가져온 즉시 "정렬"을 쓸 수 있게, 아직 이 몰의 정렬 옵션을 모르면(몰 구조분석도 안
        // 돌렸고 이전에 이 자리에서도 못 찾았으면) 방금 가져온 카테고리 페이지로 바로 확인해둔다 — 몰
        // 전체가 같은 정렬 메커니즘을 쓴다고 보므로 한 번 찾으면 충분하다(사용자 요청, 2026-08-26).
        // "스크랩 상한"은 이 확인과 무관하게 이미 항상 바로 쓸 수 있다.
        if (isNew && !gridSortOptions.length) {
          try {
            const sortRes = await fetch('/api/scrape/categories/sort-options', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ siteId: selectedSite.id, url: d.url }),
            })
            const sortData = await sortRes.json() as { sortOptions?: MallProfileSignals['sortOptions'] }
            if (sortRes.ok && sortData.sortOptions?.length) setManualSortOptions(sortData.sortOptions)
          } catch { /* 정렬 옵션을 못 찾아도 카테고리 자체는 이미 정상 추가됐으니 조용히 넘어간다 */ }
        }
      }
    } finally {
      setCurrentUrlLoading(false)
    }
  }

  /** 로그인 창에 새 탭으로 열어 로그인된 상태로 보여준다. 로그인 창이 닫혀있으면 서버가 저장된 로그인
   * 쿠키로 새 창을 띄운다 — 그것도 안 되면 Chrome(없으면 Edge)으로 열고, 그마저 안 되면(설치된 브라우저를
   * 못 찾음 등) 일반 새 탭(=PTP를 띄운 브라우저)으로 최후 폴백한다. */
  async function handleOpenItem(url: string) {
    if (selectedSite) {
      try {
        const res = await fetch('/api/scrape/open-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: selectedSite.id, url }),
        })
        if (res.ok) {
          // 개발자모드는 실제 개인 크롬에 새 탭으로 열렸을 뿐(open-url 라우트 참고) 그 자체로는 아무것도
          // 안 되니, 이어서 "스크랩 대상 직접지정"으로 바로 넘어갈 수 있다는 걸 알려준다(사용자 요청,
          // 2026-09-09 — "그 열린 상품을 기준으로 스크랩 직접지정을 할 수 있게 해줘"). 그 탭이 이미
          // 포그라운드로 열렸으므로(크롬이 URL 인자를 새 탭으로 바로 여는 표준 동작) 사용자는 바로 확장
          // 아이콘만 누르면 된다.
          if (mallMode === 'devmode') {
            showPickerFocusHint('실제 브라우저 창에 새 탭으로 열었습니다 — 이어서 그 탭에서 확장 아이콘 → "🎯 보조 - 스크랩 대상 직접지정"을 누르면 이 상품 기준으로 지정할 수 있습니다.')
          }
          return
        }
      } catch { /* 폴백으로 진행 */ }
    }
    try {
      const res = await fetch('/api/system/open-in-browser', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) return
    } catch { /* 폴백으로 진행 */ }
    window.open(url, '_blank', 'noreferrer')
  }

  async function handleLoadCategories(force = false) {
    if (!selectedSite || !targetUrl) return
    activateAutoMode()
    // 카테고리를 새로 불러오면(또는 "다시 확인") 그 아래 "스크랩 미리보기" 결과는 방금 전 카테고리
    // 선택 기준으로 나온 낡은 값이다 — selectSite(몰 변경 시)와 같은 원칙("몰을 변경하면 기존 작업내역은
    // 없어져야 하는게 맞지", 2026-08-16 사용자 요청)을 카테고리 재조회에도 그대로 적용한다(사용자 지적,
    // 2026-08-23: "새로 카테고리를 위에서 결정하고... 새로 하는 것이기에 아래의 스크래핑 미리보기
    // 내용은 없어야 된다"). previewLoading 중이면 그 fetch까지 취소한다(handleStopPreview와 같은 방식).
    if (previewAbortRef.current) { previewAbortRef.current.abort(); previewAbortRef.current = null }
    setPreviewLoading(false)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([]); setPreviewSource(null)
    exactTotalAbortRef.current?.abort(); setExactTotal(null); setExactTotalLoading(false)
    // "전체 가져오기" 체크 상태(categoryUrlsText)도 같은 이유로 비운다 — 예전엔 목록만 새로 불러오고
    // 체크는 그대로 남겨뒀는데(선택 보존이 의도였음), 몰 구조분석을 다른 경로(예: 워커에 직접 재분석
    // 요청)로 갱신한 뒤 이 화면에서 "카테고리 불러오기"만 누르면 예전 체크가 그대로 남아있어 "새로
    // 불러왔는데 왜 이미 선택돼 있냐"는 혼란을 줬다(사용자 지적, 2026-09-05). 카테고리 목록이 최신
    // 몰 구조 기준으로 다시 나온 것이니 선택도 항상 새로 하게 한다 — "선택 가져오기" 탭 전용인
    // manualCategoryUrlsText는 이 액션과 무관해 건드리지 않는다.
    setCategoryUrlsText('')
    setCategoriesLoading(true)
    // handlePreview와 같은 이유로, 결과(또는 로딩 스켈레톤)가 나올 자리로 화면을 스크롤한다(사용자 요청, 2026-08-17).
    requestAnimationFrame(() => categoryResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    try {
      const res = await fetch('/api/scrape/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, url: targetUrl, loginId, loginPw, force }),
      })
      const d = await res.json() as {
        links: { href: string; text: string }[]; platform: string; cached: boolean; updatedAt: string | null
        scrapedHrefs?: string[]; allScraped?: boolean; excludedCategoryHrefs?: string[]
        categoryCounts?: Record<string, { count: number; truncated?: boolean; label: string; checkedAt: string }>
        categoryScrapeHistory?: Record<string, { lastScrapedAt: string | null; clientName: string | null }>
        loginBlockedExpansion?: boolean
        aiUsed?: boolean
        categoryAnomalyWarning?: { reason: string; source: 'anthropic' | 'gemini' | 'ollama' } | null
        newCategoryHrefs?: string[]
      }
      setCategories(dedupeCategoryLinks(d.links || []))
      setDetectedPlatform(d.platform || null)
      setCategoryAiUsed(!!d.aiUsed)
      setCategoriesCached({ cached: d.cached, updatedAt: d.updatedAt ?? null })
      setLoginBlockedExpansion(!!d.loginBlockedExpansion)
      setCategoryAnomalyWarning(d.categoryAnomalyWarning || null)
      setScrapedCategoryHrefs(d.scrapedHrefs || [])
      setAllCategoriesScraped(!!d.allScraped)
      setExcludedCategoryHrefs(d.excludedCategoryHrefs || [])
      setNewCategoryHrefs(d.newCategoryHrefs || [])
      // 카테고리 체크리스트의 상품개수/확인일시/최근 스크랩/업체 컬럼(사용자 요청, 2026-08-17).
      setCategoryInfo(mergeCategoryInfo(d.categoryCounts || {}, d.categoryScrapeHistory || {}))
    } finally {
      setCategoriesLoading(false)
    }
  }

  function isCategorySelected(href: string) {
    return categoryUrlsText.split('\n').map(s => s.trim()).includes(href)
  }
  function isCategoryScraped(href: string) {
    return allCategoriesScraped || scrapedCategoryHrefs.includes(href)
  }
  function isCategoryExcluded(href: string) {
    return excludedCategoryHrefs.includes(href)
  }
  // "제외" 표시한 카테고리는 전체선택 체크박스(상태 판정 + 클릭 시 대상)에서 뺀다 — toggleAllCategories와
  // 아래 헤더 체크박스 렌더링이 같은 기준을 쓴다.
  const selectableCategories = categories.filter(c => !isCategoryExcluded(c.href))
  // 스크랩 미리보기로 확인된 카테고리별 개수(categoryCounts)를 href 기준으로 찾아, 카테고리 불러오기
  // 체크리스트에도 같이 보여준다 — url이 곧 categories의 href와 같은 값(둘 다 카테고리 링크)이다.
  const categoryCountByHref = new Map(categoryCounts.map(c => [c.url, c]))
  /** 실제 상품이 없는 카테고리(안내/문의 페이지 등)를 사용자가 직접 열어보고 "이건 아니다"로 표시한다 —
   *  화면엔 바로 반영하고(목록 맨 아래로 정리), 서버에도 남겨 다음에 카테고리를 다시 불러와도 유지되게
   *  한다. 서버 저장이 실패해도 화면 표시는 그대로 두고 조용히 넘어간다 — 실패해도 이번 화면에서 목록을
   *  정리하는 데는 지장이 없고, 다음에 다시 불러오면 서버 값 기준으로 다시 맞춰진다. */
  async function toggleCategoryExcluded(href: string) {
    if (!selectedSite) return
    const nextExcluded = !isCategoryExcluded(href)
    setExcludedCategoryHrefs(prev => (nextExcluded ? [...prev, href] : prev.filter(h => h !== href)))
    try {
      await fetch('/api/scrape/categories/exclude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, href, excluded: nextExcluded }),
      })
    } catch { /* 화면 표시는 이미 반영했으니 조용히 넘어간다 */ }
  }
  function toggleCategory(href: string) {
    activateAutoMode()
    const lines = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    const next = new Set(lines)
    if (next.has(href)) next.delete(href); else next.add(href)
    // 체크리스트에 있는 항목은 클릭한 순서가 아니라 체크리스트가 보여주는 순서(발견 순서) 그대로
    // 정렬해서 넣는다 — 예전엔 클릭한 순서 그대로 뒤에 붙여서, 아래 "카테고리별 상품 개수" 표(이
    // 목록 순서를 그대로 따름)가 체크리스트와 순서가 안 맞았다(사용자 지적, 2026-08-17). 체크리스트에
    // 없는 직접 입력 URL은 원래 있던 순서를 그대로 유지해 뒤에 붙인다.
    const known = categories.filter(c => next.has(c.href)).map(c => c.href)
    const manual = lines.filter(h => next.has(h) && !categories.some(c => c.href === h))
    setCategoryUrlsText([...known, ...manual].join('\n'))
  }
  /** "카테고리별 정렬기준 설정" 그리드 컬럼(정렬/제한)이 값을 바꿀 때마다 얕은 병합으로 저장한다. */
  function updateCategorySetting(href: string, patch: Partial<{ sortLabel?: string; limitMode?: 'count' | 'pages'; limitValue?: number }>) {
    setCategorySettings(prev => ({ ...prev, [href]: { ...prev[href], ...patch } }))
  }
  /** "전체 가져오기" 그리드에서 체크박스가 아닌 다른 컬럼(정렬/스크랩 상한)을 조작하면 그 행을 자동으로
   *  스크랩 대상에 포함시킨다 — 예전엔 체크박스를 따로 눌러야만 선택됐는데, 정렬/상한부터 먼저 만지고
   *  체크를 깜빡하면 방금 고른 설정이 "스크랩 시작" 때 조용히 무시됐다(사용자 지적, 2026-09-03: "제외
   *  이외의 컬럼을 조작하면 자동으로 해당 행이 선택 체크되게"). toggleCategory와 달리 이미 선택돼 있으면
   *  건드리지 않는다(다시 꺼버리면 안 됨). */
  function selectCategory(href: string) {
    if (!isCategorySelected(href)) toggleCategory(href)
  }
  /** href에 그리드에서 고른 정렬(kind:'query')을 적용하면 실제로 어떤 URL이 되는지 계산한다 —
   *  buildCategoryUrlsAndLimits가 미리보기/스크랩 요청을 만들 때 쓰는 것과 정확히 같은 계산을, 화면에
   *  카테고리별 개수를 찾아 보여줄 때도 써야 한다(사용자 지적, 2026-09-06 — 정렬을 지정한 카테고리는
   *  서버가 실제로 이 정렬-적용 URL을 키로 개수를 응답(categoryCounts[].url)하는데, 화면은 여전히 정렬
   *  적용 "전"의 원래 href로 그 응답을 찾으려 해서 방금 확인한 개수인데도 "미확인"으로 보였다). kind:'click'
   *  (AJAX 정렬)은 URL 자체가 안 바뀌므로 href를 그대로 돌려준다. */
  function sortedCategoryUrl(href: string): string {
    const setting = categorySettings[href]
    const sortOptions = profileResult?.signals.sortOptions || []
    const chosen = setting?.sortLabel ? sortOptions.find(o => o.label === setting.sortLabel) : undefined
    if (!chosen || chosen.kind === 'click') return href
    try {
      const u = new URL(href)
      Object.entries(chosen.paramsToAdd).forEach(([k, v]) => u.searchParams.set(k, v))
      return u.toString()
    } catch {
      return href // 잘못된 URL이면 원본 그대로 둔다
    }
  }
  /** categoryUrlsText(선택된 href, 순수 원본)는 체크박스/카테고리목록 매칭에 그대로 쓰이므로 절대 손대지
   *  않는다 — 대신 미리보기/정확한개수/스크랩시작 요청을 만드는 이 시점에만, 사용자가 그리드에서 고른
   *  정렬을 적용한다. 두 가지 방식이 있다(kind:'click' 추가, 2026-08-23 — 펫투비처럼 정렬이 URL에 전혀
   *  반영되지 않는 AJAX 몰 대응):
   *  - kind:'query'(기본): 카테고리 URL에 쿼리파라미터로 구워 넣는다(같은 사이트 어느 카테고리든 base
   *    쿼리파라미터가 달라도 diffQueryParams로 뽑아둔 "차이"만 얹으므로 그대로 적용된다) — sortedCategoryUrl.
   *  - kind:'click': URL은 그대로 두고, 그 최종 URL을 키로 "클릭할 텍스트"를 별도 맵(categorySortClicks)에
   *    담는다 — 서버(collectFromListing)가 그 목록 페이지에 들어간 직후 실제로 한 번 클릭해 정렬을 적용한다.
   *  개수/페이지 상한도 그 최종 URL을 키로 하는 별도 맵(categoryLimits)에 담는다(lib/scraper.ts의
   *  ScrapeOptions.categoryLimits/categorySortClicks와 같은 모양 — collectFromListing이 이 맵들로만
   *  적용한다). 서버 전용 모듈(lib/scraper.ts)은 여기서 import할 수 없어(Playwright 등 서버 전용
   *  의존성 포함) 브라우저 내장 URL/URLSearchParams만 쓴다. */
  function buildCategoryUrlsAndLimits(): {
    categoryUrls: string[]
    categoryLimits: Record<string, { mode: 'count' | 'pages'; value: number }>
    categorySortClicks: Record<string, string>
  } {
    // categoryUrlsText는 "전체 가져오기" 탭의 체크리스트가 누적해서 채우는 진짜 선택 상태이고,
    // manualCategoryUrlsText가 새로 추가하는 줄은 위 useEffect(784줄)로 한쪽 방향으로만 거기에 합쳐진다
    // (지운다고 다시 빠지진 않음) — 그래서 예전에 "전체 가져오기"에서 여러 개를 체크해둔 뒤 탭을
    // "선택 가져오기"로 바꿔 몇 개만 새로 모으면, categoryUrlsText에는 예전 체크 항목이 화면엔 안 보인
    // 채로 그대로 남아있어 미리보기/스크랩이 지금 탭에서 고른 것보다 훨씬 많은 카테고리를 대상으로
    // 돌았다(실사용 확인, 2026-08-24 — "선택 가져오기 3개만 골랐는데 20개를 확인하고 있다"). 지금
    // 활성 탭이 "선택 가져오기"면 그 탭에 실제로 보이는 목록(manualCategoryUrlsText)만 대상으로 쓴다 —
    // "전체 가져오기" 탭에서 골라둔 것은 그 탭으로 돌아가야만 다시 대상이 된다.
    const hrefs = activeCategoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    const sortOptions = profileResult?.signals.sortOptions || []
    const categoryLimits: Record<string, { mode: 'count' | 'pages'; value: number }> = {}
    const categorySortClicks: Record<string, string> = {}
    const categoryUrls = hrefs.map(href => {
      const setting = categorySettings[href]
      const chosen = setting?.sortLabel ? sortOptions.find(o => o.label === setting.sortLabel) : undefined
      const url = sortedCategoryUrl(href)
      if (chosen?.kind === 'click') categorySortClicks[url] = chosen.clickText
      if (setting?.limitMode && setting.limitValue) categoryLimits[url] = { mode: setting.limitMode, value: setting.limitValue }
      return url
    })
    return { categoryUrls, categoryLimits, categorySortClicks }
  }
  // "제외"로 표시해둔 카테고리(상품이 없는 안내/게시판 페이지 등)는 전체선택 대상에서 뺀다 — 안 그러면
  // 전체선택을 누를 때마다 방금 제외해둔 카테고리까지 다시 스크랩 대상으로 딸려 들어간다(실사용 확인,
  // 2026-08-13).
  function toggleAllCategories() {
    activateAutoMode()
    const allSelected = selectableCategories.length > 0 && selectableCategories.every(c => isCategorySelected(c.href))
    setCategoryUrlsText(allSelected ? '' : selectableCategories.map(c => c.href).join('\n'))
  }

  // buildCategoryUrlsAndLimits와 같은 기준(categorySourceMode) — "선택 가져오기"만 채워두고 "전체
  // 가져오기"는 한 번도 안 돌린 몰에서 이 값이 항상 categoryUrlsText만 봐서 미리보기 버튼이 잘못
  // 비활성화될 수 있었다(2026-08-27, 카테고리별 상품 개수 표와 같이 발견된 문제).
  const canPreview = !!targetUrl.trim() || activeCategoryUrlsText.trim().length > 0

  function applyCatalogPreview(d: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; noProductsFound?: boolean; devPreviewElapsedSec?: number | null; previewSource?: { url: string; requestedUrl: string; switchedReason?: string; sortClick?: { clickText: string; applied: boolean } } | null }) {
    setPreviewTotal(d.total)
    setDetectedPlatform(d.platform || null)
    setPreviewSource(d.previewSource ?? null)
    setPreviewItems((d.items || []).slice(d.preview ? 1 : 0)) // 첫 상품은 위 상세 카드에 이미 나오니 그리드에서는 제외
    setCategoryCounts(d.categoryCounts || [])
    // 체크리스트의 상품개수/확인일시 컬럼도 곧바로 갱신한다 — 서버(lib/scraper.ts의 persistCategoryCounts)에도
    // 저장은 되지만, 이 탭이 그 값을 다시 받으려면 새로고침해야 하니 방금 받은 결과를 바로 반영한다.
    // 최근 스크랩/업체는 이 응답에 없어(DB 조회가 더 필요함) 기존 값을 그대로 둔다(사용자 요청, 2026-08-17).
    if (d.categoryCounts?.length) {
      const checkedAt = new Date().toISOString()
      setCategoryInfo(prev => {
        const next = { ...prev }
        for (const c of d.categoryCounts!) {
          next[c.url] = { ...next[c.url], count: c.count, truncated: c.truncated, label: c.label, checkedAt }
        }
        return next
      })
    }
    // d.preview가 null이면(로그인 벽이든, 상품을 하나도 못 찾았든) 예전 결과를 그대로 남겨두지 않고
    // 같이 지운다 — 안 그러면 이번 실행이 실패했는데도 화면엔 이전(어쩌면 몇 번 전) 성공 결과가 마치
    // 방금 확인한 것처럼 계속 남아있는다(2026-09-05, "캡모자 캡모자" 가짜 결과 이후 재현 확인).
    setPreviewResult(d.preview)
    setSessionExpiredWarning(!!d.needsLogin)
    setNoProductsFoundWarning(!!d.noProductsFound)
    setDevPreviewElapsedSec(d.devPreviewElapsedSec ?? null)
    if (d.needsLogin) handleOpenLogin()
  }

  // 개발자모드 미리보기 결과 폴링 — 이 몰이 선택돼 devmode인 동안 항상 돌아간다("스크랩 미리보기" 버튼과
  // 무관). 몰 탭에서 확장의 "스크랩 미리보기 실행"만 눌러도(PTP 버튼을 먼저 누르지 않아도) 몇 초 안에
  // 여기서 그 결과를 발견해 반영한다. last_adjustment_preview는 이제 일반모드의 previewCatalog와 같은
  // 모양(total/platform/preview/items)이라 applyCatalogPreview를 그대로 재사용한다 — 카테고리 페이지를
  // 캡처했으면 첫 상품 상세+나머지 목록이, 상품 상세 페이지 하나만 캡처했으면 그 1건만 채워진다. 값이
  // 실제로 바뀐 경우만 반영해 불필요한 리렌더를 피한다.
  const devLastPreviewKeyRef = useRef<string | null>(null)
  // "중지" 버튼을 눌러도 몰 탭의 실제 캡처는 계속 돌 수 있다(원격으로 못 끊는 구조적 한계,
  // handleStopDevPreview 주석 참고) — 그 뒤늦은 결과가 이 폴링에 걸려 마치 중지가 무시된 것처럼 화면에
  // 다시 나타나는 걸 막는다(사용자 지적, 2026-09-05). true인 동안은 새 결과가 와도 "이미 본 것"으로만
  // 표시하고 화면에는 반영하지 않는다 — 다음 handleDevPreview(재시작)가 다시 false로 되돌린다.
  const devPreviewStoppedRef = useRef(false)
  useEffect(() => {
    if (mallMode !== 'devmode' || !selectedSite) return
    const siteId = selectedSite.id
    const id = setInterval(async () => {
      // 확장이 chrome.debugger를 붙여 실제로 캡처를 시작했는지(preview-progress) — 결과(last_adjustment_
      // preview)와 별개의 가벼운 신호라 같은 3초 주기에 얹어 같이 확인한다(사용자 요청, 2026-09-05).
      fetch(`/api/sites/${siteId}/preview-progress`).then(r => r.json())
        .then((p: { started?: boolean; done?: number; total?: number }) => {
          setDevPreviewCapturing(!!p.started)
          setDevPreviewProgress(p.total ? { done: p.done ?? 0, total: p.total } : null)
          // PTP의 "🔍 스크랩 미리보기" 버튼을 먼저 안 누르고 몰 탭 확장에서 바로 실행해도(권장 워크플로 —
          // 위 노란 안내문 참고) 이 폴링이 캡처 시작을 감지하면 진행률 표시 영역이 뜨게 한다 — previewLoading이
          // handleDevPreview에서만 켜져서, 그 버튼을 안 누르면 서버에 진행 데이터(done/total)가 실제로
          // 쌓이고 있어도 화면엔 그 자리 자체가 그려지지 않았다(2026-09-05 실사용 확인: "지금 미리보기
          // 중인데 아무것도 안 나온다"). "중지"를 눌러 일부러 숨긴 상태(devPreviewStoppedRef)는 다시
          // 켜지 않는다.
          if (p.started && !devPreviewStoppedRef.current) setPreviewLoading(true)
        }).catch(() => {})
      const res = await fetch(`/api/sites/${siteId}`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as {
        last_adjustment_preview?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; noProductsFound?: boolean; devPreviewElapsedSec?: number | null } | null
      }
      const captured = d.last_adjustment_preview
      if (!captured) return
      const key = JSON.stringify(captured)
      if (key === devLastPreviewKeyRef.current) return
      devLastPreviewKeyRef.current = key
      if (devPreviewStoppedRef.current) return
      applyCatalogPreview(captured)
      setPreviewLoading(false)
      setDevPreviewCapturing(false)
      if (devPreviewTimeoutRef.current) { clearTimeout(devPreviewTimeoutRef.current); devPreviewTimeoutRef.current = null }
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedSite 객체 자체가 갱신마다 새로 생성돼도 siteId만 같으면 재구독할 필요 없음
  }, [mallMode, selectedSite?.id])

  /** 개발자모드의 "현재 카테고리 가져오기" — 일반모드(로그인 창의 현재 URL을 서버가 직접 읽음)와 달리
   *  개발자모드는 서버가 몰 탭에 직접 접근할 수 없어, 확장이 지금 탭 URL을 sites.scrape_profile.
   *  categoryQueue에 대신 쌓아두면(app/api/sites/[id]/current-category POST) 여기서 몇 초마다
   *  가져오면서(GET이 가져가는 즉시 서버 쪽 큐를 비움) manualCategoryUrlsText("선택 가져오기" 탭 전용
   *  목록)에 이어붙인다 — 여러 번 눌러도 중복 없이 계속 쌓이도록 이미 목록에 있는 URL은 건너뛴다
   *  (2026-08-22). 실제 스크랩 대상(categoryUrlsText)에는 별도 useEffect가 자동으로 반영한다. */
  useEffect(() => {
    if (mallMode !== 'devmode' || !selectedSite) return
    const siteId = selectedSite.id
    const id = setInterval(async () => {
      const res = await fetch(`/api/sites/${siteId}/current-category`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as { urls?: string[] }
      if (!d.urls?.length) return
      setManualCategoryUrlsText(prev => {
        const lines = prev.split('\n').map(s => s.trim()).filter(Boolean)
        const seen = new Set(lines)
        let added = 0
        for (const url of d.urls!) { if (!seen.has(url)) { lines.push(url); seen.add(url); added++ } }
        // 몰 탭 확장에서 실제로 "현재 카테고리 가져오기"를 눌러 여기 반영되는 순간은 사용자가 "선택
        // 가져오기" 쪽을 쓰겠다고 방금 행동으로 보여준 것이다 — handleRefreshCurrentUrl(일반모드 버전)과
        // 위 체크박스/정렬 조작들이 이미 하는 "실제로 만지는 쪽으로 자동 전환"을 여기도 똑같이 적용한다
        // (사용자 지적, 2026-09-05: "전체가져오기에 있던 포커스가 선택 가져오기로 전환되어야지?").
        if (added) { showDevHint(`카테고리 URL ${added}개를 목록에 추가했습니다.`); setAwaitingDevCategoryAction(false); activateManualMode() }
        return lines.join('\n')
      })
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedSite 객체 자체가 갱신마다 새로 생성돼도 siteId만 같으면 재구독할 필요 없음
  }, [mallMode, selectedSite?.id])

  /** "스크랩 미리보기" 버튼 — 이전 결과를 비우고 "대기 중" 표시를 켠다. 실제 결과 반영은 위 폴링이
   *  전담한다(이 버튼을 누르지 않고 몰 탭에서 확장만 실행해도 동일하게 반영됨) — 여기서는 예전 결과를
   *  지워 헷갈리지 않게 하고, 2분 안에 응답이 없으면 "대기 중" 표시만 스스로 풀어준다. */
  async function handleDevPreview() {
    if (!selectedSite) return
    // "브라우저에서 바로 열기"를 따로 먼저 누르지 않고, 몰구조분석/카테고리가 이미 캐시로 보이는 상태에서
    // 바로 카테고리를 고르고 이 버튼을 눌러도 되도록 — 몰 탭을 아직 안 열었으면 이 버튼이 대신 열어준다
    // (사용자 요청, 2026-08-16). 이미 열어둔 뒤(loginStep!=='none')라면 매번 새 창을 또 띄우지 않는다.
    // 실제 캡처는 몰 탭의 확장이 해야 하므로(로그인까지는 자동화할 수 없음) — 로그인 전이면 여전히
    // 사용자가 확장에서 직접 눌러야 하지만, 로그인 후에는 sendExtensionAction으로 몰 탭의 확장을 PTP가
    // 직접 실행시켜본다(2026-08-22, 사용자 요청: "PTP에서 누르면 몰에 자동으로 확장기능이 실행되게").
    // 실패하면(확장 미설치, 몰 탭 안 열림 등) 기존 수동 안내로 폴백한다.
    if (loginStep === 'none') {
      await handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)
      showPreviewFocusHint('몰 탭을 열었습니다 — 로그인 후 확장 아이콘 → 팝업의 "🔍 스크랩 미리보기 - (카테선택)"을 클릭하세요.')
    } else {
      // sendExtensionAction(externally_connectable)으로 몰 탭에 직접 명령을 보내 자동 실행하던 방식은
      // 확장이 원인불명으로 사라지는 문제와 시점이 겹쳐 되돌렸다(위 경고문 3342행 근처 주석 참고, 지금은
      // 항상 실패해 수동 안내로만 폴백함) — handleProfileMall(2026-08-29)과 같은 이유로, 새 탭를 또 열지
      // 않고 이미 로그인해둔 그 창을 앞으로 가져오기만 하고 실제 실행은 사용자가 그 창의 확장 아이콘을
      // 직접 누르게 한다(사용자 요청, 2026-08-30: "위에서처럼 동일하게 몰 브라우저 창으로 이동시켜줘").
      const focused = await fetch('/api/scrape/login/focus', { method: 'POST' })
        .then(r => r.json()).then(d => !!d.ok).catch(() => false)
      showPreviewFocusHint(focused
        ? '몰 탭으로 전환했습니다 — 그 창 상단의 확장 아이콘(PTP) → "🔍 스크랩 미리보기 - (카테선택)"을 눌러 실행하세요.'
        : '열려있는 몰 탭을 찾지 못했습니다 — 몰 탭에서 확장 아이콘 → 팝업의 "🔍 스크랩 미리보기 - (카테선택)"을 클릭하세요.')
    }
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([]); setPreviewSource(null)
    setPreviewLoading(true)
    setSessionExpiredWarning(false)
    setNoProductsFoundWarning(false)
    setDevPreviewCapturing(false) // 서버(preview-arm)도 같이 지우지만, 다음 폴링 전까지 화면에 지난 실행의 "캡처 중" 표시가 잠깐 남지 않게 즉시 반영
    setDevPreviewProgress(null)
    setDevPreviewElapsedSec(null) // 지난 실행의 소요시간이 이번 실행 완료 전까지 화면에 잘못 남아있지 않도록
    // 스크랩 대상이 다시 정해지는 시점이므로, 이전 선택 기준으로 구한 "정확한 총 개수"는 더 이상 안
    // 맞을 수 있어 같이 지운다(선택이 안 바뀌었으면 그냥 다시 눌러 확인).
    exactTotalAbortRef.current?.abort(); setExactTotal(null); setExactTotalLoading(false)
    // handleStart와 같은 이유로, 미리보기 시작 시 결과가 나올 카드로 화면을 스크롤해 버튼만 누르고 아래
    // 결과를 못 보는 일이 없게 한다(사용자 요청, 2026-08-17).
    requestAnimationFrame(() => previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    devLastPreviewKeyRef.current = null // 재캡처 결과가 이전과 완전히 같아도 새 결과로 인식해 반영하도록
    devPreviewStoppedRef.current = false // 이전 실행을 중지했었더라도 이번 새 실행의 결과는 다시 보여준다
    await fetch(`/api/sites/${selectedSite.id}/preview-arm`, { method: 'POST' })
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    devPreviewTimeoutRef.current = setTimeout(() => setPreviewLoading(false), 120_000)
  }

  useEffect(() => {
    return () => {
      if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    }
  }, [])

  /** 화면이 새로고침돼 이 몰에 이미 진행 중인 미리보기가 있는 걸 뒤늦게 발견했을 때만 쓴다(아래 마운트
   *  복원 로직 참고) — 그 요청을 이 탭이 다시 받을 방법은 없으니, 끝날 때까지 진행률만 이어서 보여주다가
   *  끝나면 다시 눌러달라고 안내한다. */
  function resumePreviewProgressPolling(siteId: number) {
    if (previewProgressPollRef.current) clearInterval(previewProgressPollRef.current)
    previewProgressPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/scrape/preview-progress?siteId=${siteId}`).catch(() => null)
      const d = await res?.json().catch(() => null) as {
        done: number; total: number
        result?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; noProductsFound?: boolean }
        earlyPreview?: { sourceUrl: string; product: PreviewProduct } | null
      } | null
      // 서버(lib/scraper.ts의 endPreviewRun)가 정상 완료된 결과를 잠시 남겨두므로, 있으면 그대로
      // 받아 적용한다 — 새로고침으로 끊긴 원래 요청의 결과를 이 탭이 자동으로 이어받는 경로.
      if (d?.result) {
        if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
        applyCatalogPreview(d.result)
        setPreviewLoading(false)
        setPreviewProgress(null)
        return
      }
      // 카테고리 개수 집계가 끝나기 전에 서버가 먼저 뽑아둔 상품 1건(earlyPreview) — 아직 완료된
      // result는 아니지만, 새로고침으로 관찰만 하는 이 경로에서도 먼저 보여줄 수 있으면 보여준다.
      if (d?.earlyPreview && !earlyPreviewAppliedRef.current) {
        earlyPreviewAppliedRef.current = true
        setPreviewResult(d.earlyPreview)
      }
      if (d?.total) { setPreviewProgress(d); return }
      // total도 result도 없다는 건 중지/밀려남/에러 등으로 남길 결과 없이 끝났다는 뜻 — 자동으로
      // 이어받을 게 없으니 다시 눌러달라고 안내한다.
      if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
      setPreviewLoading(false)
      setPreviewProgress(null)
      setPreviewResumeNotice('새로고침 전 진행 중이던 미리보기가 결과 없이 끝난 것 같습니다 — "🔍 스크랩 미리보기"를 다시 눌러 확인해주세요.')
    }, 1000)
  }

  /** 목록에서 상품 개수를 세는 것과 첫 상품 미리보기를 한 번의 요청(한 브라우저 세션)으로 같이 처리한다
   * — 예전에는 "테스트 실행"과 "미리보기"가 별도 버튼/요청이라 세션을 두 번 열어야 해서 느렸다. 개수는
   * 페이징 끝까지 따라가 실제 전체 개수를 보여주고, 나머지 상품은 (열어보지 않고) 목록 정보만 그리드로
   * 함께 보여준다. 시작 URL이 목록이 아니라 상품 페이지 하나뿐이어도 scrapeCatalogPage가 그 페이지 자체를
   * 상품 1건으로 처리해 그대로 동작한다. */
  async function handlePreview() {
    if (!selectedSite || !canPreview) return
    myLockClickAtRef.current = Date.now()
    setPreviewResumeNotice(null)
    setPreviewLoading(true)
    setPreviewResult(null)
    earlyPreviewAppliedRef.current = false
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([]); setPreviewSource(null)
    setPreviewProgress(null)
    // 스크랩 대상이 다시 정해지는 시점이므로, 이전 선택 기준으로 구한 "정확한 총 개수"는 더 이상 안
    // 맞을 수 있어 같이 지운다(선택이 안 바뀌었으면 그냥 다시 눌러 확인).
    exactTotalAbortRef.current?.abort(); setExactTotal(null); setExactTotalLoading(false)
    // handleStart와 같은 이유로, 미리보기 시작 시 결과가 나올 카드로 화면을 스크롤해 버튼만 누르고 아래
    // 결과를 못 보는 일이 없게 한다(사용자 요청, 2026-08-17).
    requestAnimationFrame(() => previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    // 새 미리보기는 새 스크랩 대상을 정하는 것이므로, 아래 "진행 상황"에 이전 스크랩의 "완료" 기록이
    // 그대로 남아있으면 새로 스크래핑을 시작하려는 건지 이전 결과를 보는 건지 헷갈린다 — handleBackToSettings와
    // 같은 방식으로 초기화한다.
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([]); setCollectProgress(null)
    sessionStorage.removeItem(LAST_SESSION_KEY)
    const controller = new AbortController()
    previewAbortRef.current = controller
    // 카테고리가 많은/큰 몰은 몇 분씩 걸릴 수 있어 진행 중임을 보여준다 — 서버(previewCatalog)가
    // 세는 "카테고리 N/M"을 짧은 주기로 폴링한다. 새로고침 복구 중 관찰용 폴링(resumePreviewProgressPolling)이
    // 이미 돌고 있었을 수 있어(사용자가 그 안내를 기다리지 않고 바로 다시 누른 경우) 먼저 정리한다 —
    // 안 그러면 그 인터벌이 ref에서 밀려나 멈출 방법 없이 계속 도는(누수) 채로 남는다.
    if (previewProgressPollRef.current) clearInterval(previewProgressPollRef.current)
    const siteId = selectedSite.id
    previewProgressPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/scrape/preview-progress?siteId=${siteId}`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as { done: number; total: number; earlyPreview?: { sourceUrl: string; product: PreviewProduct } | null }
      // 카테고리 개수 집계가 끝나기 전에 서버가 먼저 뽑아둔 상품 1건 — 개수 집계보다 상품 미리보기를
      // 먼저 보여달라는 요청(2026-08-14)에 따라, 전체 응답을 기다리지 않고 도착하는 대로 바로 보여준다.
      if (d.earlyPreview && !earlyPreviewAppliedRef.current) {
        earlyPreviewAppliedRef.current = true
        setPreviewResult(d.earlyPreview)
      }
      if (d.total > 0) setPreviewProgress(d)
    }, 1000)
    try {
      // 정렬(query 방식)은 URL에 이미 구워 넣어 그대로 반영되지만, 상한(categoryLimits)은 안 보낸다 —
      // 미리보기의 총개수는 실제 수집이 아니라 별도의 지수+이분 탐색 추정이라 상한을 봐도 반영되지
      // 않는다("정확한 총 개수 확인"/실제 스크랩 시작에만 의미가 있음). AJAX(click) 방식 정렬은 URL에
      // 반영할 수 없어 categorySortClicks를 그대로 같이 보낸다.
      const { categoryUrls, categorySortClicks } = buildCategoryUrlsAndLimits()
      const res = await fetch('/api/scrape/preview-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          url: categoryUrls.length ? undefined : (targetUrl || undefined),
          categoryUrls: categoryUrls.length ? categoryUrls : undefined,
          categorySortClicks: Object.keys(categorySortClicks).length ? categorySortClicks : undefined,
          loginId: loginId || undefined, loginPw: loginPw || undefined,
          siteId: selectedSite.id, aiMode, concurrencyMode, concurrency,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확인 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; noProductsFound?: boolean; superseded?: boolean; previewSource?: { url: string; requestedUrl: string; switchedReason?: string; sortClick?: { clickText: string; applied: boolean } } | null }
      // 같은 몰에 대해 다른 탭/요청이 더 뒤에 미리보기를 시작해 이 실행이 서버에서 중간에 밀려난
      // 경우(lib/scraper.ts의 beginPreviewRun 참고) — 이 응답은 불완전하니 화면에 반영하지 않는다.
      // 밀어낸 쪽(진짜 최신 요청)의 응답이 곧 따로 온다.
      if (d.superseded) return
      applyCatalogPreview(d)
    } catch (err) {
      // 사용자가 "중지"를 눌러 스스로 취소한 요청은 에러로 취급하지 않는다(handleStopPreview 참고).
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
    } finally {
      setPreviewLoading(false)
      previewAbortRef.current = null
      if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
      setPreviewProgress(null)
    }
  }

  /** "🔍 스크랩 미리보기"가 도는 동안(일반모드) 누르면 그 fetch를 abort한다 — 서버(previewCatalog)도
   *  같은 신호를 받아 진행 중이던 카테고리 개수 집계를 멈추므로, 중지 후 위 스크랩 대상을 다시 조정해
   *  바로 새 미리보기를 시작할 수 있다(같은 로그인 세션/탭을 그대로 재사용, 별도 정리 불필요). */
  function handleStopPreview() {
    if (previewAbortRef.current) { previewAbortRef.current.abort(); return }
    // 새로고침 뒤 서버에 아직 도는 미리보기를 관찰만 하던 중이면(resumePreviewProgressPolling) 이
    // 탭엔 취소할 실제 요청이 없다 — 폴링만 멈추고 화면을 초기 상태로 되돌린다(서버 쪽 작업 자체는
    // 계속 돈다 — 그 요청을 시작한 예전 탭이 없어졌을 뿐).
    if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
    setPreviewLoading(false)
    setPreviewProgress(null)
  }

  /** "🔍 스크랩 미리보기"가 도는 동안(개발자모드) 누르면 화면을 바로 초기 상태로 되돌리는 것과 별개로,
   *  이제 실제 순회도 멈춘다(2026-09-06, 사용자 요청 — "중지를 클릭하면 그 순간 중지하라고": 화면만
   *  멈추고 몰 탭에서는 계속 도는 게 몇 번이나 혼란을 줘서, 몰 탭을 강제로 닫아야만 진짜로 멈췄었다).
   *  서버가 몰 탭(확장)을 직접 끊을 방법은 여전히 없지만(sendExtensionAction은 externally_connectable이
   *  없어 항상 실패해 제거함, 2026-09-05), run()의 중지 버튼과 같은 폴링 방식으로 신호만 남겨두면
   *  확장이 카테고리/페이지를 확인할 때마다 스스로 물어봐서 다음 확인 지점에서 멈춘다(lib/devPreviewStatus.ts의
   *  requestDevPreviewStop 참고) — 완전탐색/이분탐색처럼 페이지 단위로 도는 안쪽 루프도 매 페이지마다
   *  확인하므로 카테고리 중간에서도 몇 초 안에 멈춘다. devPreviewStoppedRef는 그 신호가 도착하기 전
   *  잠깐 사이 뒤늦게 도착하는 결과가 화면에 다시 나타나지 않게 막는 기존 안전장치로 그대로 둔다. */
  function handleStopDevPreview() {
    if (devPreviewTimeoutRef.current) { clearTimeout(devPreviewTimeoutRef.current); devPreviewTimeoutRef.current = null }
    setPreviewLoading(false)
    setDevPreviewCapturing(false)
    devPreviewStoppedRef.current = true
    if (selectedSite) fetch(`/api/sites/${selectedSite.id}/preview-stop`, { method: 'POST' }).catch(() => {})
  }

  /** "정확한 총 개수 확인" — previewTotal(카테고리별 빠른 합계)이 카테고리 간 중복을 포함할 수 있어,
   *  실제로 스크랩될 상품이 몇 개인지 궁금할 때만 누르는 버튼. 실제 스크랩(collectProductUrls)과 같은
   *  방식으로 선택된 카테고리 전체의 상품 URL을 모아 중복 제거한 개수를 구하므로, 카테고리별 집계보다
   *  느릴 수 있다 — 그래서 항상 자동으로 하지 않고 버튼으로 둔다(사용자 요청, 2026-08-17).
   *  category-overlap 엔드포인트는 exact-total과 똑같은(느린) 실제 수집을 하되 총합과 함께 카테고리별
   *  breakdown도 돌려주므로, 굳이 두 번 수집하지 않도록 exact-total 대신 이걸 호출한다(2026-08-25). */
  async function handleCheckExactTotal() {
    if (!selectedSite) return
    setExactTotalLoading(true)
    setExactTotal(null)
    const controller = new AbortController()
    exactTotalAbortRef.current = controller
    try {
      const { categoryUrls, categoryLimits, categorySortClicks } = buildCategoryUrlsAndLimits()
      const res = await fetch('/api/scrape/category-overlap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          url: categoryUrls.length ? undefined : (targetUrl || undefined),
          categoryUrls: categoryUrls.length ? categoryUrls : undefined,
          categoryLimits: Object.keys(categoryLimits).length ? categoryLimits : undefined,
          categorySortClicks: Object.keys(categorySortClicks).length ? categorySortClicks : undefined,
          loginId: loginId || undefined, loginPw: loginPw || undefined,
          siteId: selectedSite.id, concurrencyMode, concurrency,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확인 실패: ${e.error || res.status}`); return }
      const d = await res.json() as {
        total: number; needsLogin: boolean; stopped: boolean
        categories: { url: string; count: number; uniqueCount: number; duplicateCount: number }[]
      }
      setExactTotal({ total: d.total, needsLogin: d.needsLogin, categories: d.categories })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
    } finally {
      setExactTotalLoading(false)
      exactTotalAbortRef.current = null
    }
  }

  function handleStopExactTotal() {
    exactTotalAbortRef.current?.abort()
  }

  const needsLogin = !!loginId
  const canStart = !!selectedSite && (!needsLogin || loginStep === 'confirmed')

  function handleBackToSettings() {
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([]); setCollectProgress(null)
    setElapsedMinutes(null)
    sessionStorage.removeItem(LAST_SESSION_KEY)
  }

  // "이어서 하기"/"처음부터 다시 하기" 버튼은 체크박스(includeAlreadyScraped)를 거치지 않고 그 자리에서
  // 바로 의도를 확정하고 싶다는 요청(2026-08-25, "이어서 하기 외에 처음부터 다시 하기 기능도") — 인자로
  // 넘기면 그 값이 체크박스 상태보다 우선한다(체크박스는 그대로 첫 시작(status==='idle')에만 남겨둠).
  async function handleStart(overrideIncludeAlreadyScraped?: boolean) {
    if (!selectedSite || !canStart) return
    myLockClickAtRef.current = Date.now()
    const effectiveIncludeAlreadyScraped = overrideIncludeAlreadyScraped ?? includeAlreadyScraped
    const { categoryUrls, categoryLimits, categorySortClicks } = buildCategoryUrlsAndLimits()
    setStatus('running')
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([]); setCollectProgress(null)
    setSessionCreatedAt(null)
    setItemLog([]); setElapsedMinutes(null)
    // 시작 버튼을 누르면 그 아래 "진행 상황" 섹션으로 자동 스크롤해, 화면을 따로 내리지 않아도 바로 보이게 한다.
    // 이 시점엔 아직 리렌더 전이라 섹션이 DOM에 없을 수 있어(status는 방금 막 바뀜) 다음 페인트 이후로 미룬다.
    requestAnimationFrame(() => progressSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: categoryUrls.length ? undefined : (targetUrl || undefined),
        categoryUrls: categoryUrls.length ? categoryUrls : undefined,
        categoryLimits: Object.keys(categoryLimits).length ? categoryLimits : undefined,
        categorySortClicks: Object.keys(categorySortClicks).length ? categorySortClicks : undefined,
        // 페이지당 지연은 몰 차단 방지를 위한 안전값을 그대로 유지한다(사용자가 조절할 필요가 없어 UI에서
        // 제거) — 다음페이지 셀렉터/최대 페이지 수는 플랫폼별 자동 감지(cafe24 등)로 대체된다. 동시 처리
        // 개수는 기본적으로 scrapeCatalogPage가 몰의 반응을 보며 스스로 조절한다(적응형 동시성) — 아래
        // concurrencyMode가 'manual'이면 그 대신 concurrency 값으로 고정한다(메모리 이슈 진단/완화용).
        delayMs: 1000,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode: 'catalog', siteId: selectedSite.id, concurrencyMode, concurrency,
        includeAlreadyScraped: effectiveIncludeAlreadyScraped,
      }),
    })
    // 이 몰에 이미 진행 중인 세션이 있으면(app/api/scrape/route.ts) 새로 시작하는 대신 그 세션에
    // 그대로 연결한다 — 아무 설명 없이 "실행 중"만 뜬 채 멈춰있는 것처럼 보이지 않게 한다.
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: string; sessionId?: number }
      if (e.sessionId) {
        alert(e.error || '이미 진행 중인 스크래핑에 연결합니다.')
        setSessionId(e.sessionId)
        sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: e.sessionId }))
      } else {
        alert(e.error || '스크래핑 시작에 실패했습니다')
        setStatus('idle')
      }
      return
    }
    const data = await res.json() as { sessionId: number }
    setSessionId(data.sessionId)
    sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: data.sessionId }))
  }

  /** /api/scrape/log는 화면 표시용이라 200건으로 잘려 있어(성능 목적, 실패 건이 그 200건을 우선
   *  채우도록 돼 있음) — 실패가 200건을 넘는 세션(몰 탭이 닫혀 나머지 전부가 실패한 경우 등)은
   *  failedUrls(itemLog 기반)로 재시도하면 앞쪽 200건만 재시도하고 나머지는 조용히 빠진다(사용자 지적,
   *  2026-09-06 — "실패 1835개인데 왜 재시도는 200개라고 나오냐"). 재시도 직전에 상한 없는 전용
   *  엔드포인트(/api/scrape/failed-urls)로 진짜 전체 목록을 다시 받아온다. */
  async function handleRetryFailed() {
    if (!selectedSite || !sessionId || progress.failedCount === 0) return
    setRetrying(true)
    try {
      const urlsRes = await fetch(`/api/scrape/failed-urls?sessionId=${sessionId}`)
      const allFailedUrls = await urlsRes.json() as string[]
      if (!Array.isArray(allFailedUrls) || !allFailedUrls.length) return
      setStatus('running')
      setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([]); setCollectProgress(null)
      setSessionCreatedAt(null)
      setItemLog([]); setElapsedMinutes(null)
      const res = await fetch('/api/scrape', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productUrls: allFailedUrls, mode: 'catalog', scrapeMode: 'incremental',
          loginId: loginId || undefined, loginPw: loginPw || undefined, siteId: selectedSite.id,
        }),
      })
      const data = await res.json() as { sessionId: number }
      setSessionId(data.sessionId)
      sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: data.sessionId }))
    } finally {
      setRetrying(false)
    }
  }

  async function handleStop() {
    if (!sessionId) return
    setStopping(true)
    await fetch('/api/scrape/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  }

  const statusColor = { idle: 'text-gray-500', running: 'text-teal-500', done: 'text-emerald-600', error: 'text-rose-600', stopped: 'text-amber-600' }
  const statusLabel = { idle: '대기 중', running: '스크래핑 중...', done: '완료', error: '오류 발생', stopped: '중지됨' }

  // "카테고리별 정렬기준 설정" 그리드 컬럼용(사용자 요청, 2026-08-19). 정렬 옵션은 몰 단위로 몰 구조분석이
  // (일반모드) 또는 확장의 "🧭 정렬 옵션 감지"(개발자모드, runDetectSortOptions)가 찾아둔 값을 그대로 쓴다
  // (카테고리마다 다시 탐지하지 않음 — 실사용상 몰 전체가 같은 정렬 메커니즘을 씀). 세 경로 모두 같은
  // 자리(scrape_profile.sortOptions)에 저장되므로, "선택 가져오기"가 즉석에서 찾아둔 manualSortOptions는
  // profileResult 쪽에 아직 없을 때만 대신 쓴다(2026-08-26).
  const gridSortOptions = profileResult?.signals.sortOptions?.length ? profileResult.signals.sortOptions : (manualSortOptions || [])
  // "새 카테고리 M개" 배지용 — newCategoryHrefs(지난번 갱신 시점 기준)를 지금 실제로 화면에 보이는
  // categories 목록과 교집합해, 혹시 그 사이 카테고리가 사라진 경우까지 대비한다(사용자 요청, 2026-09-05).
  const newCategoryCount = categories.filter(c => newCategoryHrefs.includes(c.href)).length

  // 카테고리 불러오기 결과(캐시 안내/감지된 플랫폼/체크리스트) — 일반모드의 "스크랩 대상" 카드와
  // 개발자모드 안내 카드가 그대로 같이 쓴다(2026-08-15, 개발자모드도 카테고리를 선택해 그것만 스크랩할
  // 수 있게 되며 중복을 피하려고 미리 뽑아둠). "몰 구조분석"과 같은 패턴으로, 로딩 중엔 결과가 나올
  // 자리에 같은 모양(목록 행)의 스켈레톤을 먼저 보여준다(사용자 지적, 2026-08-16: "카테고리불러오기도
  // 마찬가지로 로딩 중을 위와 같이 표시").
  const categoryChecklistBox = categoriesLoading ? (
    <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base leading-none animate-spin">🔄</span>
        <span className="text-xs font-semibold text-teal-700">카테고리를 불러오는 중입니다...</span>
      </div>
      <div className="border border-teal-200 bg-white rounded-xl overflow-hidden divide-y divide-gray-100">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2 animate-pulse">
            <div className="h-3 w-3 bg-gray-200 rounded shrink-0" />
            <div className="h-2.5 bg-gray-200 rounded" style={{ width: `${45 + (i % 3) * 15}%` }} />
          </div>
        ))}
      </div>
    </div>
  ) : (categoriesCached?.cached || detectedPlatform || categories.length > 0) && (
    <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-3">
      {/* "발견된 카테고리 N개"를 맨 위, 눈에 띄는 배지로 — 예전엔 아래쪽 안내 문장 끝에 조용히 붙어있어
          찾기 어려웠다(사용자 요청, 2026-08-27: "이걸 맨 위로 올려서, 조금 더 시인성있게"). */}
      {categories.length > 0 && (
        <p className="text-sm font-bold text-teal-800 bg-teal-100 rounded-lg px-3 py-1.5 mb-2 inline-block">
          🔍 발견된 카테고리 {categories.length}개
          {categories.some(c => isCategoryScraped(c.href)) &&
            ` (완료 ${categories.filter(c => isCategoryScraped(c.href)).length}개)`}
          {categories.some(c => isCategoryExcluded(c.href)) &&
            ` · 제외 ${categories.filter(c => isCategoryExcluded(c.href)).length}개`}
          {` · 선택 ${categories.filter(c => isCategorySelected(c.href)).length}개`}
          {/* 몰 구조분석 이후 새로 나타난 카테고리 개수(사용자 요청, 2026-09-05) — newCategoryCount 참고. */}
          {newCategoryCount > 0 && ` (새 카테고리: ${newCategoryCount}개)`}
        </p>
      )}
      {/* "몰 구조분석"이 이미 찾아둔 목록을 재사용했으면 즉시 뜨고 그 사실을 알려준다 — 지금 실제로 몰에
          접속해서 확인한 게 아니라 예전 결과라는 걸 놓치기 쉽다는 지적(2026-08-22: "실지 작업이 되고
          있는지를 사용자에게 알려줘야지")으로, 작은 회색 각주 대신 눈에 띄는 배지로 키웠다. */}
      {categoriesCached?.cached && (
        <p className="text-xs font-semibold text-teal-700 bg-teal-100 rounded-lg px-3 py-1.5 mb-2"
          title={categoriesCached.updatedAt ? new Date(categoriesCached.updatedAt).toLocaleString() : undefined}>
          📋 지금 몰에 접속하지 않고, {categoriesCached.updatedAt ? `${new Date(categoriesCached.updatedAt).toLocaleString()}에` : '예전에'} 저장해둔 몰 구조 결과를 그대로 불러왔습니다 —
          몰 메뉴가 바뀐 것 같으면 &quot;다시 확인&quot;을 눌러주세요.
        </p>
      )}

      {/* 이 카테고리 목록을 찾을 때 AI(Gemini)가 실제로 기여했는지 작게 표시 — 사용자 요청, 2026-08-18.
          detectCategoryLinksWithAI(lib/ai.ts)가 최상위 탐지나 허브 하위메뉴 탐지 중 하나라도 결과를
          채택했으면 discoverCategoryLinks가 aiUsed:true를 내려주고, sites.scrape_profile에도 같이
          저장돼 캐시로 다시 불러와도 표시가 유지된다. */}
      {categoryAiUsed && (
        <p className="text-[11px] text-sky-600 mt-1">
          🤖 AI가 이 카테고리 구조를 확인했습니다.
        </p>
      )}

      {/* 회원전용 몰(개발자모드)은 개인 크롬 프로필을 통째로 복사해도 로그인 세션 자체가 넘어오지
          않는다는 게 이미 확인된 구조적 한계라(!specifications/manual-login-required-malls.md
          2026-07-18 항목 — 모자사러로 직접 재현 확정, 2026-08-18), 하위 카테고리 자동 펼치기가 로그인
          페이지에 막혀 몇 번을 "다시 확인"해도 그대로일 수 있다 — 크롬을 닫아도 소용없다는 게 핵심이라
          "닫고 다시 시도하라"고 안내하지 않는다. loginBlockedExpansion은 로그인 벽뿐 아니라 봇/과속요청
          차단 인터스티셜(예: 카페24 "잠시 접속이 제한되었습니다")도 같은 신호로 취급한다(lib/scraper.ts의
          isBotBlockPage, 2026-08-29 추가 — 실제 서버 자동화는 이 상황도 세션 복사와 마찬가지로 뚫을 수
          없어 결국 같은 안내로 이어진다). 대신 실제 로그인된 탭에서 대신 확인해주는 확장 버튼
          (extension-poc/background.js의 runExpandCategories, 2026-08-18 추가, 2026-08-29 재시도/감속
          보강)으로 안내한다. "다시 확인"은 이제(shouldKeepPreviousCategoryLinks, 2026-08-29) 확장이
          저장해둔 좋은 결과를 덮어쓰지 않으므로 안전하게 눌러도 된다. */}
      {loginBlockedExpansion && (
        <p className="text-[11px] text-amber-600 mt-1">
          ⚠ 로그인이 필요하거나 접속이 차단된 페이지가 있어 일부 카테고리의 하위 구조를 자동으로 확인하지
          못했습니다(이 몰은 서버 자동화로는 뚫을 수 없는 구조라 크롬을 닫고 다시 해도 동일합니다).
          몰 탭에서 확장 팝업의 &quot;🧭 보조 - 몰 구조분석&quot;을 실행한 뒤 여기서
          &quot;다시 확인&quot;을 눌러주세요.
        </p>
      )}

      {/* checkCategoryAnomaly(서버, AI)가 이번 카테고리 구조를 검증된 과거 카테고리(마이그레이션
          확정분/사용자가 직접 확인한 URL)와 비교해 터무니없다고 판단했을 때만 뜬다 — 봇 차단 페이지
          링크가 카테고리로 잘못 저장됐던 사고(2026-08-29, 펫토리)의 재발을 사람이 매번 눈으로 확인하지
          않아도 알아챌 수 있게 하는 안전망(사용자 요청). loginBlockedExpansion과 달리 "왜 막혔는지"가
          아니라 "결과 자체가 이상해 보인다"는 다른 종류의 경고라 별도 블록으로 둔다. source==='ollama'면
          "(참고용)" 딱지를 붙인다 — 로컬 소형 모델은 실측(2026-08-29)으로 이 비교 판단을 거꾸로 하는
          경우가 확인돼 Anthropic/Gemini보다 신뢰도가 낮다(사용자 요청으로 구분 표시). */}
      {categoryAnomalyWarning && (
        <div className="mt-1.5 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-rose-700">
            ⚠ AI가 이 카테고리 구조가 실제로 확정됐던 과거 카테고리와 많이 달라 보인다고 판단했습니다
            {categoryAnomalyWarning.source === 'ollama' && (
              <span className="font-semibold" title="로컬 AI(Ollama)는 클라우드 AI보다 이런 비교 판단의 정확도가 낮을 수 있습니다 — 참고만 하세요.">
                {' '}(참고용, 로컬 AI 판단)
              </span>
            )}
            {' '}({categoryAnomalyWarning.reason}) — 아래 &quot;🖱 몰 카테고리 선택 가져오기(반복)&quot;로
            직접 확인해보시는 걸 권장합니다.
          </p>
          <button type="button" onClick={activateManualMode}
            className="px-3 py-1 bg-rose-500 hover:bg-rose-600 text-white text-xs font-semibold rounded-full transition-colors shrink-0">
            🖱 직접 가져오기로 전환
          </button>
        </div>
      )}

      {detectedPlatform && (
        <p className="text-xs text-teal-600 mt-1">
          감지된 몰 유형: <span className="font-medium">{PLATFORM_LABELS[detectedPlatform] || detectedPlatform}</span>
          {detectedPlatform !== 'unknown' && ' — 해당 플랫폼에 맞는 상품 링크/다음 페이지 방식이 자동으로 적용됩니다.'}
        </p>
      )}

      {categories.length > 0 && (
        <>
          <p className="text-xs text-teal-700 mt-1">
            💡 아래에서 여러 카테고리를 체크하면, 체크한 카테고리들을 한 번에 스크랩 대상으로 지정할 수 있습니다.
          </p>
          <div className="mt-1.5 border border-teal-200 bg-white rounded-xl overflow-hidden">
            <div className="h-40 min-h-[80px] max-h-[70vh] resize-y overflow-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  {/* 전체선택 체크박스를 우측 텍스트 링크 대신 아래 행 체크박스와 같은 왼쪽 칸에
                      둔다 — 실제 <thead>/<tbody>로 같은 표에 넣어야 폭이 항상 정확히 맞는다. 예전엔
                      카테고리명/URL/제외 3칸을 "발견된 카테고리 N개..." 한 문구로 묶어 보여줬는데, 상품개수/
                      확인일시/최근 스크랩/업체 컬럼이 추가되며 각자 라벨이 있는 게 명확해 위 문단으로
                      옮기고 컬럼마다 이름을 붙였다(사용자 요청, 2026-08-17). */}
                  <tr className="sticky top-0 z-[2] bg-teal-50 border-b border-teal-100">
                    <th className="px-3 py-1.5 w-6 sticky left-0 z-[1] bg-teal-50 font-normal text-left">
                      <input type="checkbox" title="전체 선택/해제 (몰 전체상품, 제외 표시한 카테고리는 빠짐)"
                        checked={selectableCategories.length > 0 && selectableCategories.every(c => isCategorySelected(c.href))}
                        ref={el => { if (el) el.indeterminate = selectableCategories.some(c => isCategorySelected(c.href)) && !selectableCategories.every(c => isCategorySelected(c.href)) }}
                        onChange={toggleAllCategories} />
                    </th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="이 카테고리를 스크랩할 때 적용할 정렬 순서">정렬</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="이 카테고리에서 몇 개/몇 페이지까지만 스크랩할지 상한을 둡니다(비워두면 무제한)">스크랩 상한</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap">카테고리</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-right whitespace-nowrap" title="스크랩 미리보기로 확인된 상품 개수">상품개수</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="상품개수를 마지막으로 확인한 시각">확인일시</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="이 카테고리 상품이 실제로 스크랩된 가장 최근 시각">최근 스크랩</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="가장 최근에 이 카테고리 상품을 마이그레이션한 업체">업체</th>
                    <th className="px-3 py-1.5 text-gray-500 font-normal text-left">URL</th>
                    <th className="px-3 py-1.5 w-12 sticky right-0 bg-teal-50" />
                  </tr>
                </thead>
                <tbody>
                  {/* 실제 상품이 없는 항목(안내/문의 페이지 등)을 "제외"로 표시해두면 눈에 잘 안 띄게
                      맨 아래로 정리한다 — Array.sort는 안정 정렬이라 같은 그룹(제외/비제외) 안에서는
                      원래 발견 순서가 그대로 유지된다. */}
                  {[...categories].sort((a, b) => Number(isCategoryExcluded(a.href)) - Number(isCategoryExcluded(b.href))).map(c => {
                    // 이번 세션에 방금 미리보기를 돌렸으면(categoryCountByHref) 그 값이 가장 최신이고,
                    // 아직 안 돌렸으면 저장돼 있던 값(categoryInfo, 몰 선택 시 또는 카테고리 불러오기 시
                    // 복원됨)을 보여준다(사용자 요청, 2026-08-17 — 예전엔 이 정보가 카테고리명 옆 배지로만
                    // 있었는데 컬럼으로 분리했다).
                    // categoryInfo/categoryCountByHref는 실제로 요청에 쓰인 URL(정렬 적용 후) 기준으로
                    // 쌓이므로, 이 카테고리에 정렬을 지정해뒀으면 원래 href가 아니라 sortedCategoryUrl로
                    // 찾아야 방금 확인한 개수를 놓치지 않는다.
                    const resolvedUrl = sortedCategoryUrl(c.href)
                    const info = categoryInfo[resolvedUrl]
                    const live = categoryCountByHref.get(resolvedUrl)
                    const count = live ?? (info?.count != null ? { count: info.count, truncated: info.truncated } : undefined)
                    const truncatedTitle = '확인 상한에 도달할 때까지도 새 상품이 계속 나와 멈췄습니다 — 실제로는 더 많을 수 있습니다.'
                    const setting = categorySettings[c.href]
                    return (
                    <tr key={c.href} onClick={() => toggleCategory(c.href)}
                      className={`group border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer ${isCategoryExcluded(c.href) ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-1.5 w-6 sticky left-0 z-[1] bg-white group-hover:bg-gray-50">
                        <input type="checkbox" checked={isCategorySelected(c.href)} onChange={() => toggleCategory(c.href)} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                        <select
                          className="border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100 disabled:text-gray-400"
                          value={setting?.sortLabel ?? ''}
                          onChange={e => { activateAutoMode(); selectCategory(c.href); updateCategorySetting(c.href, { sortLabel: e.target.value || undefined }) }}
                          disabled={!gridSortOptions.length}
                          title={!gridSortOptions.length ? '몰 구조분석(또는 개발자모드 확장의 "정렬 옵션 감지")에서 정렬 옵션을 찾지 못했습니다' : undefined}>
                          <option value="">기본순</option>
                          {gridSortOptions.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <select
                            className="border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100 disabled:text-gray-400"
                            value={setting?.limitMode ?? ''}
                            onChange={e => { activateAutoMode(); selectCategory(c.href); updateCategorySetting(c.href, { limitMode: (e.target.value || undefined) as 'count' | 'pages' | undefined }) }}>
                            <option value="">무제한</option>
                            <option value="count">개까지</option>
                            <option value="pages">페이지까지</option>
                          </select>
                          {setting?.limitMode && (
                            <input type="number" min={1} placeholder="숫자"
                              className="w-14 border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100"
                              value={setting.limitValue ?? ''}
                              onChange={e => { activateAutoMode(); selectCategory(c.href); updateCategorySetting(c.href, { limitValue: e.target.value ? Number(e.target.value) : undefined }) }} />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                        <button type="button" onClick={e => { e.stopPropagation(); handleOpenItem(c.href) }}
                          title={`${c.href} — 클릭하면 이 카테고리 페이지를 엽니다`}
                          className={`hover:text-teal-600 hover:underline ${isCategoryExcluded(c.href) ? 'line-through' : ''}`}>
                          {c.text}
                        </button>
                        {isCategoryScraped(c.href) && (
                          <span className="ml-1.5 text-[10px] font-semibold text-teal-600" title="이 카테고리는 이전에 스크래핑을 완료한 적이 있습니다">✓ 완료</span>
                        )}
                        {isCategoryExcluded(c.href) && (
                          <span className="ml-1.5 text-[10px] font-semibold text-gray-400" title="상품 카테고리가 아닌 것으로 표시해뒀습니다">제외됨</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600 whitespace-nowrap" title={count?.truncated ? truncatedTitle : undefined}>
                        {count ? `${count.count.toLocaleString()}${count.truncated ? '개 이상' : '개'}` : '-'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap" title={info?.checkedAt ? new Date(info.checkedAt).toLocaleString() : undefined}>
                        {info?.checkedAt ? formatShortDate(info.checkedAt) : '-'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap" title={info?.lastScrapedAt ? new Date(info.lastScrapedAt).toLocaleString() : undefined}>
                        {info?.lastScrapedAt ? formatShortDate(info.lastScrapedAt) : '-'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap truncate max-w-[120px]" title={info?.clientName || undefined}>
                        {info?.clientName || '-'}
                      </td>
                      <td className="px-3 py-1.5 max-w-[320px] truncate">
                        <button type="button" onClick={e => { e.stopPropagation(); handleOpenItem(c.href) }}
                          title={`${c.href} — 클릭하면 이 카테고리 페이지를 엽니다`}
                          className="text-gray-400 hover:text-teal-600 hover:underline truncate max-w-full">
                          {c.href}
                        </button>
                      </td>
                      <td className="px-3 py-1.5 w-12 text-right sticky right-0 bg-white group-hover:bg-gray-50">
                        <button type="button" onClick={e => { e.stopPropagation(); toggleCategoryExcluded(c.href) }}
                          title={isCategoryExcluded(c.href) ? '다시 카테고리로 복원합니다' : '상품이 없는 카테고리라 목록 아래로 정리합니다'}
                          className="text-[10px] text-gray-400 hover:text-rose-500 hover:underline whitespace-nowrap">
                          {isCategoryExcluded(c.href) ? '복원' : '제외'}
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )

  // "몰 카테고리 선택 가져오기(반복)" 탭용 — "전체 가져오기"의 체크리스트(categoryChecklistBox)와 똑같이
  // 카테고리별 정렬/스크랩 상한을 설정할 수 있게 해달라는 요청(2026-08-23, "선택 가져오기 한 url을
  // 가져오고, 그 카테고리 기준 정렬/스크랩상한을 설정한 다음에 스크래핑 시작을 할 수 있게 해줘"). 백엔드
  // (categorySettings/buildCategoryUrlsAndLimits)는 href를 키로 쓰는 이미 범용적인 구조라 손댈 필요가
  // 없다 — manualCategoryUrlsText의 각 줄도 이미 useEffect(784줄)로 categoryUrlsText에 합쳐지므로,
  // 여기서 categorySettings만 채워주면 "스크랩 시작"이 그대로 반영한다. 상품개수/확인일시/최근 스크랩/
  // 업체/제외 컬럼은 "전체 가져오기"가 discoverCategoryLinks로 몰 전체를 훑어야만 알 수 있는 정보라
  // 이 탭(사용자가 직접 골라온 URL 하나씩)에는 해당 데이터 자체가 없어 넣지 않는다.
  const manualCategoryUrls = manualCategoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
  /** 잘못 가져왔거나 더는 필요 없는 카테고리를 목록에서 뺀다(사용자 요청, 2026-08-24) — 지금까지는
   *  텍스트박스를 직접 고쳐써야 했다. manualCategoryUrlsText에서만 지우면 되고 categoryUrlsText는
   *  건드리지 않는다 — 건드려도 안전하지만(그 값은 원래 지워지지 않는 누적 상태), 지금 활성 탭(선택
   *  가져오기)의 스크랩 대상은 buildCategoryUrlsAndLimits가 이미 manualCategoryUrlsText만 보므로
   *  이거 하나만 지우면 대상에서도 바로 빠진다. 그 카테고리에 설정해둔 정렬/상한도 같이 지운다 —
   *  안 지우면 같은 URL을 나중에 다시 가져왔을 때 예전 설정이 뜻하지 않게 되살아난다. */
  function removeManualCategoryUrl(href: string) {
    activateManualMode()
    setManualCategoryUrlsText(prev => prev.split('\n').map(s => s.trim()).filter(Boolean).filter(u => u !== href).join('\n'))
    setCategorySettings(prev => {
      if (!(href in prev)) return prev
      const next = { ...prev }
      delete next[href]
      return next
    })
  }
  /** "하위 카테고리 있음" 체크 후 누르는 버튼 — 이 카테고리 페이지만 열어(자동 최상위 탐지 없이) 하위
   *  메뉴를 찾아 목록에 이어붙인다(lib/scraper.ts의 expandCategoryChildren 참고). 이 대분류 자신은
   *  상품이 없는 허브일 수도, 있을 수도 있어 자동으로 지우지 않는다 — 필요 없으면 "제거"로 직접 뺀다.
   */
  async function handleExpandSubcategory(href: string) {
    if (!selectedSite) return
    activateManualMode()
    setExpandingHref(href)
    try {
      // 이 대분류의 이름을 안 넘기면 서버(detectCategoryLinksWithAI)가 "지금 보고 있는 카테고리"라는
      // 빈 이름으로 AI에게 물어야 해서, AI가 어느 대분류의 하위 메뉴를 골라야 하는지 전혀 구분하지
      // 못한다 — 몰 전체 메가메뉴가 모든 페이지에 다 실려 있는 몰(도매신)에서, MEN SHOES 페이지를
      // 확장했는데 WOMEN SHOES의 하위 카테고리(부츠/털신발·펌프스/힐)가 섞여 들어온 사고로 발견됨
      // (사용자 지적, 2026-09-17). 서버(expandCategoryChildren)는 이 이름이 scrape_profile.categoryLinks의
      // "이름 > " 접두사와 정확히 문자열이 같아야만 몰구조분석 캐시를 찾아 쓰므로, categories(몰구조분석/
      // "전체 가져오기"가 채운 상태 — categoryLinks와 1:1로 항상 같은 텍스트)를 최우선으로 쓴다.
      // categoryInfo.label은 "카테고리별 상품 개수 확인"(previewCatalog) 때 별도로 저장된 값이라 살짝
      // 다르게 포맷됐거나(그 기능을 아직 안 돌렸으면 아예 없거나) 오래된 몰구조분석 실행의 라벨일 수
      // 있어, categories에 없는 href(사용자가 직접 입력한 URL 등)에 대한 보조 수단으로만 쓴다.
      // countCategoryProductsOnce(lib/scraper.ts)가 화면에서 카테고리명을 못 읽으면 label을 통째로
      // categoryUrl(그 URL 자체)로 채워 저장해두는 경우가 있어(2026-09-26 도매창고 실사용 확인 — MD추천
      // 칸에 이름 대신 URL이 그대로 표시됨), 그 URL-그대로인 값은 "이름을 안다"고 보지 않는다.
      const knownLabel = categoryInfo[sortedCategoryUrl(href)]?.label
      const label = categories.find(c => c.href === href)?.text || (knownLabel && knownLabel !== sortedCategoryUrl(href) ? knownLabel : '') || ''
      const res = await fetch('/api/scrape/categories/expand', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, url: href, name: label || undefined }),
      })
      const d = await res.json() as { links?: { href: string; text: string }[]; error?: string }
      if (!res.ok) { setExpandSubcategoryNotice(`하위 카테고리 확인 실패: ${d.error || res.status}`); return }
      if (!d.links?.length) { setExpandSubcategoryNotice('하위 카테고리를 찾지 못했습니다.'); return }
      setManualCategoryUrlsText(prev => {
        const lines = new Set(prev.split('\n').map(s => s.trim()).filter(Boolean))
        d.links!.forEach(l => lines.add(l.href))
        return [...lines].join('\n')
      })
      // d.links가 들고 온 하위 카테고리 이름(text)을 여기서 버리면, 아래 표의 "카테고리" 칸이 이 새
      // href들을 categories에서 못 찾아 계속 "-"로만 보인다(사용자 지적, 2026-09-26 — "하위카테고리명도
      // 넣어지게 해"). "전체 가져오기"/몰구조분석이 채우는 것과 같은 categories 상태에 그대로 합쳐서,
      // 표의 카테고리명 조회(3419행 근처, categories.find)가 이 하위 카테고리도 그대로 찾게 한다.
      // 기존 항목이 있으면(같은 href를 몰구조분석이 이미 알고 있었으면) 그 값을 그대로 지키고, 새 href만
      // 추가한다(dedupeCategoryLinks가 먼저 나온 것을 우선하므로 prev를 앞에 둔다).
      setCategories(prev => dedupeCategoryLinks([...prev, ...d.links!]))
    } catch {
      setExpandSubcategoryNotice('하위 카테고리 확인에 실패했습니다.')
    } finally {
      setExpandingHref(null)
    }
  }
  const manualCategoryTableBox = (
    <div className="mt-2 border border-teal-200 bg-white rounded-xl overflow-hidden">
      <p className="text-xs text-teal-700 px-3 pt-2">
        💡 카테고리마다 정렬 순서/스크랩 상한을 다르게 설정할 수 있습니다. 대분류 페이지 안에 하위(중분류)
        메뉴가 더 있으면 &quot;하위 카테고리&quot;를 체크하고 &quot;↳ 가져오기&quot;를 눌러 그 하위 목록을 이어서 담을 수 있습니다.
      </p>
      {expandSubcategoryNotice && (
        <p className="text-xs text-amber-700 bg-amber-50 border-t border-amber-100 px-3 py-1.5">
          ⚠ {expandSubcategoryNotice}
        </p>
      )}
      {manualCategoryUrls.length === 0 ? (
        <p className="text-xs text-gray-400 px-3 py-3">위 &quot;현재 카테고리 가져오기&quot;로 모으면 여기에 나타납니다.</p>
      ) : (
      <div className="mt-1 h-40 min-h-[80px] max-h-[70vh] resize-y overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="sticky top-0 z-[2] bg-teal-50 border-b border-teal-100">
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="이 카테고리를 스크랩할 때 적용할 정렬 순서">정렬</th>
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="이 카테고리에서 몇 개/몇 페이지까지만 스크랩할지 상한을 둡니다(비워두면 무제한)">스크랩 상한</th>
              {/* "전체 가져오기" 그리드와 같은 자리(정렬/스크랩 상한 다음, URL 앞) — URL만 보고는(특히
                  잘려서 표시되면) 어느 카테고리인지 바로 알기 어렵다는 지적(사용자, 2026-09-25 — "여기에도
                  카테고리명을 확인해야해"). 이 표는 URL만 손으로 모으는 곳이라 이름을 직접 캡처해두지
                  않으므로, handleExpandSubcategory와 같은 방식으로 이미 아는 이름(몰구조분석/"전체
                  가져오기"가 채운 categories, 없으면 "카테고리별 상품 개수 확인"이 남긴 categoryInfo.label)
                  중에서 찾아 보여준다 — 아직 아무 이름도 모르면(직접 입력한 URL 등) "-"로 표시. */}
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap">카테고리</th>
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left">URL</th>
              {/* "전체 가져오기" 그리드와 같은 자리/모양 — 이 표엔 원래 없어서 "스크랩 미리보기"로 개수를
                  확인해도 볼 방법이 없었다(사용자 지적, 2026-09-05: "왜 개수를 체크하지 못하지?"). */}
              <th className="px-3 py-1.5 text-gray-500 font-normal text-right whitespace-nowrap" title="스크랩 미리보기로 확인된 상품 개수">상품개수</th>
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="상품개수를 마지막으로 확인한 시각">확인일시</th>
              <th className="px-3 py-1.5 text-gray-500 font-normal text-left whitespace-nowrap" title="체크하면 이 카테고리 페이지 안의 하위(중분류) 메뉴를 찾아 목록에 추가할 수 있습니다">하위 카테고리</th>
              <th className="px-3 py-1.5 w-12 sticky right-0 bg-teal-50" />
            </tr>
          </thead>
          <tbody>
            {manualCategoryUrls.map(href => {
              const setting = categorySettings[href]
              // "전체 가져오기" 그리드와 같은 계산(2680행 근처 주석 참고, sortedCategoryUrl 참고) —
              // 이번 세션에 미리보기를 방금 돌렸으면 그 값이 최신이고, 아니면 저장돼 있던 값을 보여준다.
              const resolvedUrl = sortedCategoryUrl(href)
              const info = categoryInfo[resolvedUrl]
              const live = categoryCountByHref.get(resolvedUrl)
              const count = live ?? (info?.count != null ? { count: info.count, truncated: info.truncated } : undefined)
              const truncatedTitle = '확인 상한에 도달할 때까지도 새 상품이 계속 나와 멈췄습니다 — 실제로는 더 많을 수 있습니다.'
              // handleExpandSubcategory와 같은 두 단계 조회(3356행 근처 주석 참고) — 몰구조분석/"전체
              // 가져오기"가 채운 categories를 최우선으로, 없으면 "카테고리별 상품 개수 확인"이 남긴
              // categoryInfo.label을 보조로 쓴다. 둘 다 없으면(직접 입력한 URL 등) 이름을 모른다는 뜻.
              // info.label이 URL 그 자체와 같으면(countCategoryProductsOnce가 화면에서 이름을 못 읽어
              // categoryUrl로 대신 채운 경우, handleExpandSubcategory의 knownLabel 주석 참고) 이름을
              // 안다고 보지 않는다 — URL을 "카테고리명"인 척 보여주면 컬럼이 URL 컬럼과 똑같아져 무의미하다.
              const categoryName = categories.find(c => c.href === href)?.text
                || (info?.label && info.label !== resolvedUrl ? info.label : '') || ''
              return (
                <tr key={href} className="group border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-1.5">
                    <select
                      className="border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100 disabled:text-gray-400"
                      value={setting?.sortLabel ?? ''}
                      onChange={e => { activateManualMode(); updateCategorySetting(href, { sortLabel: e.target.value || undefined }) }}
                      disabled={!gridSortOptions.length}
                      title={!gridSortOptions.length ? '몰 구조분석(또는 개발자모드 확장의 "정렬 옵션 감지")에서 정렬 옵션을 찾지 못했습니다' : undefined}>
                      <option value="">기본순</option>
                      {gridSortOptions.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      <select
                        className="border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100 disabled:text-gray-400"
                        value={setting?.limitMode ?? ''}
                        onChange={e => { activateManualMode(); updateCategorySetting(href, { limitMode: (e.target.value || undefined) as 'count' | 'pages' | undefined }) }}>
                        <option value="">무제한</option>
                        <option value="count">개까지</option>
                        <option value="pages">페이지까지</option>
                      </select>
                      {setting?.limitMode && (
                        <input type="number" min={1} placeholder="숫자"
                          className="w-14 border border-gray-200 rounded px-1 py-0.5 text-[11px] bg-white disabled:bg-gray-100"
                          value={setting.limitValue ?? ''}
                          onChange={e => { activateManualMode(); updateCategorySetting(href, { limitValue: e.target.value ? Number(e.target.value) : undefined }) }} />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 max-w-[200px] text-gray-700">
                    <span className={`block truncate ${categoryName ? '' : 'text-gray-400 italic'}`}
                      title={categoryName || '이 URL의 카테고리명을 아직 모릅니다 — 몰구조분석/"전체 가져오기"로 찾아지거나 "카테고리별 상품 개수 확인"을 돌리면 채워집니다.'}>
                      {categoryName || '-'}
                    </span>
                  </td>
                  {/* URL은 길어서 잘리는데, 하필 카테고리를 구분하는 부분(?ctno=001 등)이 **뒤쪽**에 있어
                      앞에서 자르면 모든 행이 똑같아 보인다 — 사용자가 "현재 카테고리를 제대로 못 불러온다"고
                      본 것도 실제로는 이 표시 때문이었다(2026-09-13, 투비즈온: 저장된 값엔 ?ctno=001이
                      멀쩡히 있었다). 도메인/경로 앞부분은 줄이고 파일명+쿼리를 그대로 보여준다. */}
                  <td className="px-3 py-1.5 max-w-[320px]">
                    <button type="button" onClick={() => handleOpenItem(href)}
                      title={`${href} — 클릭하면 이 카테고리 페이지를 엽니다`}
                      className="text-gray-400 hover:text-teal-600 hover:underline block max-w-full truncate text-left">
                      {shortenCategoryUrlForDisplay(href)}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-600 whitespace-nowrap" title={count?.truncated ? truncatedTitle : undefined}>
                    {count ? `${count.count.toLocaleString()}${count.truncated ? '개 이상' : '개'}` : '-'}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap" title={info?.checkedAt ? new Date(info.checkedAt).toLocaleString() : undefined}>
                    {info?.checkedAt ? formatShortDate(info.checkedAt) : '-'}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {/* 체크는 "하위 카테고리가 있다는 걸 이미 아는 경우"가 아니라 "혹시 있을지도
                          모르니 찾아서 같이 스크랩해달라"는 용도다(사용자 설계 의도, 2026-08-27) — 그래서
                          체크하는 순간 바로 handleExpandSubcategory를 실행한다. 수동 재시도 버튼("다시
                          찾기")은 체크할 때마다 요청이 쌓여 몰별 락 때문에 순서대로 처리되며 몇 분씩
                          걸리는 문제(실사용 확인, 2026-08-27)와 혼동을 줄이려고 없앴다 — 다시 찾고
                          싶으면 체크를 껐다 다시 켜면 된다. */}
                      <input type="checkbox" checked={!!manualHasSubcategory[href]}
                        onChange={e => {
                          activateManualMode()
                          setManualHasSubcategory(prev => ({ ...prev, [href]: e.target.checked }))
                          if (e.target.checked) handleExpandSubcategory(href)
                        }}
                        className="w-3.5 h-3.5 accent-teal-500" />
                      {expandingHref === href && (
                        <span className="text-[10px] text-teal-600 whitespace-nowrap">가져오는 중...</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-12 text-right sticky right-0 bg-white group-hover:bg-gray-50">
                    <button type="button" onClick={() => removeManualCategoryUrl(href)}
                      title="이 카테고리를 목록에서 뺍니다"
                      className="text-[10px] text-gray-400 hover:text-rose-500 hover:underline whitespace-nowrap">
                      제거
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )

  // "몰 구조분석 중지" 버튼을 언제 보여줄지 — profileLoading만 보면 개발자모드에서 확장 팝업의 "🧭 보조 -
  // 몰 구조분석"으로 트리거된 경우(PTP의 handleProfileMall을 거치지 않음)를 못 잡는다. withSiteLock이
  // 어느 경로든 이 몰의 profileMallStructure(deep) 실행 중엔 항상 label='몰 구조분석'으로 잠기므로,
  // 이미 폴링 중인 siteLockStatus를 같이 봐서 두 경로 모두 커버한다(2026-08-22).
  const mallProfileRunning = profileLoading || (siteLockStatus?.busy && siteLockStatus.label === '몰 구조분석')

  // 진행 중(running)일 때의 실시간 경과 시간 — sessionCreatedAt만 있으면 되고, 2초 폴링이 어차피 계속
  // 리렌더를 일으켜 저절로 갱신된다(2026-08-22, "지금 진행 중인... 소요시간 등을 표시해 줘야지" 요청).
  const liveElapsedMinutes = status === 'running' && sessionCreatedAt
    ? Math.max(0, Math.round((Date.now() - new Date(sessionCreatedAt).getTime()) / 60_000))
    : null

  return (
    <div>
      {devHint && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] max-w-md bg-teal-600 text-white text-sm rounded-xl shadow-lg px-4 py-3 flex items-start gap-3">
          <p className="flex-1">{devHint}</p>
          <button onClick={() => setDevHint(null)} aria-label="닫기" className="text-teal-200 hover:text-white shrink-0">✕</button>
        </div>
      )}
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🔍 스크래핑 설정</h1>

      {/* Mall 선택 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="flex items-center justify-between mb-2 gap-3">
          <div className="text-sm font-semibold text-gray-700">
            Mall 선택 *
            {mallSelectCollapsed && (
              <span className="ml-2 font-normal text-gray-400">
                {selectedSite ? `— ${selectedSite.name || selectedSite.url}` : '— 선택 안 됨'}
              </span>
            )}
          </div>
          <button onClick={() => setMallSelectCollapsed(v => !v)}
            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
            {mallSelectCollapsed ? '▼ 펼치기' : '▲ 접기'}
          </button>
        </div>
        {!mallSelectCollapsed && (sites.length === 0 ? (
          <div className="text-sm text-gray-400">
            등록된 Mall이 없습니다.{' '}
            <button onClick={() => openTab({ id: 'sites-list', type: 'sites-list', title: 'Mall 상세관리', icon: '📋', closable: true })}
              className="text-teal-500 hover:underline">Mall 등록관리에서 추가하기 →</button>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                거래처
                <select value={clientFilter} onChange={e => setClientFilter(e.target.value ? Number(e.target.value) : '')}
                  className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
                  <option value="">전체</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                몰
                <select value={selectedSite?.id ?? ''}
                  onChange={e => { if (e.target.value) selectSite(Number(e.target.value)); else { setSelectedSite(null); setLoginStep('none') } }}
                  className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 min-w-[180px]">
                  <option value="">몰을 선택하세요</option>
                  {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
                </select>
              </label>
              <label className="flex-1 min-w-[200px] block">
                <span className="sr-only">Mall 이름 · 메인 품목 · 거래처 · URL 검색</span>
                <input value={siteQuery} onChange={e => setSiteQuery(e.target.value)} placeholder="Mall 이름·메인 품목·거래처·URL 검색..."
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
            </div>
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50">
                {/* 보조 기능 토글(켜짐/꺼짐)은 클릭 한 번짜리 액션 버튼(rounded-full 알약 모양)과 모양부터
                    다르게 — 사각형에 가까운 rounded-md로 "체크박스형 스위치"라는 걸 한눈에 구분되게 한다. */}
                <button onClick={() => setSiteShowFilters(v => !v)}
                  className={`px-3 py-0.5 text-xs font-semibold rounded-md transition-colors ${siteShowFilters ? 'bg-teal-100 text-teal-700 hover:bg-teal-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  🔍 필터
                </button>
                {(siteHasColFilters || siteSortKeys.length > 0) && (
                  <button onClick={() => { setSiteColFilters({}); setSiteSortKeys([]) }}
                    className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
                    필터/정렬 초기화
                  </button>
                )}
              </div>
              {/* 세로로 드래그해서 원하는 높이만큼 늘려볼 수 있게(resize-y) — "카테고리별 상품 개수" 표 등
                  다른 그리드와 같은 패턴(사용자 요청, 2026-08-27). */}
              <div className="h-48 min-h-[80px] max-h-[70vh] resize-y overflow-y-auto">
                {visibleSites.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400 text-center">검색 결과가 없습니다.</div>
                ) : (
                  <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: siteTableWidth }}>
                    <colgroup>
                      {siteOrderedColumns.map(col => <col key={col.key} style={{ width: siteColWidths[col.key] ?? sitePickerWidthFor(col.key) }} />)}
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                        {siteOrderedColumns.map((col, colIdx) => {
                          const idx = siteSortKeys.findIndex(s => s.key === col.key)
                          const active = idx !== -1
                          return (
                            <th key={col.key} draggable
                              onDragStart={() => setSiteDragKey(col.key)}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => handleSiteColDrop(col.key)}
                              onDragEnd={() => setSiteDragKey(null)}
                              className={`relative px-3 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${siteDragKey === col.key ? 'opacity-40' : ''} ${colIdx === 0 ? 'sticky left-0 z-20 bg-gray-50' : ''}`}
                              onClick={e => handleSiteSort(col.key, e)} title="드래그: 컬럼 순서 이동 · 클릭: 정렬 · Shift+클릭: 복합 정렬 추가">
                              <span className={active ? 'text-gray-800' : ''}>{col.label}</span>
                              {active && <span className="ml-1 text-teal-500">{siteSortKeys[idx].dir === 'asc' ? '▲' : '▼'}{siteSortKeys.length > 1 ? idx + 1 : ''}</span>}
                              <div onMouseDown={e => { e.stopPropagation(); startSiteResize(col.key, e) }} onClick={e => e.stopPropagation()} draggable={false}
                                className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-400 active:bg-teal-500" />
                            </th>
                          )
                        })}
                      </tr>
                      {siteShowFilters && (
                        <tr className="border-b border-gray-200 bg-white">
                          {siteOrderedColumns.map((col, colIdx) => (
                            <th key={col.key} className={`px-2 py-1.5 font-normal ${colIdx === 0 ? 'sticky left-0 z-20 bg-white' : ''}`}>
                              <input value={siteColFilters[col.key] || ''} onChange={e => setSiteColFilters(f => ({ ...f, [col.key]: e.target.value }))}
                                placeholder="필터..." onClick={e => e.stopPropagation()}
                                className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-normal focus:outline-none focus:ring-1 focus:ring-teal-300" />
                            </th>
                          ))}
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {visibleSites.map(s => {
                        const isSelected = s.id === selectedSite?.id
                        return (
                          <tr key={s.id} ref={isSelected ? selectedSiteRowRef : undefined} onClick={() => selectSite(s.id)}
                            className={`group border-b border-gray-100 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                            {siteOrderedColumns.map((col, colIdx) => (
                              <td key={col.key} className={`px-3 py-2 truncate ${col.className ?? ''} ${colIdx === 0 ? `sticky left-0 z-10 ${isSelected ? 'bg-teal-50' : 'bg-white group-hover:bg-gray-50'}` : ''}`} title={col.key === 'url' || col.key === 'main_items' ? col.getValue(s) : undefined}>
                                {col.render(s)}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedSite && (
        <div className="mb-4 bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 flex items-center gap-3">
          <span aria-hidden="true" className="shrink-0 w-6 h-6 rounded-full bg-teal-500 text-white text-xs font-bold flex items-center justify-center">✓</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800 truncate flex items-center gap-1.5">
              <span className="truncate">{selectedSite.name || selectedSite.url}</span>
              {selectedSite.manual_login_required === true && (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold whitespace-nowrap" title="Windows Hello/WebAuthn(PC인증) 등으로 자동 로그인이 안 되는 몰 — 크롬 확장(개발자모드)으로 스크랩">
                  🧩 개발자모드
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate">{selectedSite.url}</div>
          </div>
        </div>
      )}

      {/* 이 몰의 로그인 창/프로필을 다른 스크랩 작업이 쓰고 있어 순서를 기다리는 중이면 알려준다
          (withSiteLock 참고) — 안 그러면 지금 누른 버튼이 왜 응답이 없는지 알 방법이 없다.
          busy=true라고 항상 "다른" 작업이라 단정하면 안 된다 — 대기가 풀려 방금 누른 내 작업이 실제로
          시작되면 그 순간부터는 내가 락을 쥔 것인데도 계속 "다른 작업 진행 중"으로 보여, 내 작업이 잘
          도는 동안 아무 진행도 없는 것처럼 보이는 문제가 있었다(2026-08-11 실사용 확인). 락의 나이
          (sinceMs)가 내가 버튼을 누른 뒤 지난 시간보다 길 때만(=이 락이 내 클릭보다 먼저 생겼을 때만)
          "다른 작업"으로 본다. */}
      {selectedSite && siteLockStatus?.busy &&
        (myLockClickAtRef.current == null || (siteLockStatus.sinceMs ?? 0) > Date.now() - myLockClickAtRef.current) && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-700 flex items-center gap-2">
          <span>⏳</span>
          <span>
            이 몰은 지금 다른 작업(<b>{siteLockStatus.label}</b>)이 진행 중입니다
            {siteLockStatus.sinceMs != null && ` — ${Math.round(siteLockStatus.sinceMs / 1000)}초째`} —
            끝나면 방금 누른 작업이 이어서 진행됩니다.
          </span>
        </div>
      )}

      {/* 로그인 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <div className="text-sm font-semibold text-gray-700">
              로그인 정보
              {loginCardCollapsed && (
                <span className="ml-2 font-normal text-gray-400">
                  {loginStep === 'confirmed' ? '— ✓ 확인됨' : loginStep === 'opened' ? '— 확인 대기 중' : '— 아직 확인 안 함'}
                </span>
              )}
            </div>
            <button onClick={() => setLoginCardCollapsed(v => !v)}
              className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
              {loginCardCollapsed ? '▼ 펼치기' : '▲ 접기'}
            </button>
          </div>
          {!loginCardCollapsed && <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">아이디 / 이메일</span>
              {/* 이 몰의 로그인 아이디이지 PTP 자체 로그인 계정과 무관하다 — SiteDetailPanel과 같은 이유로
                  autoComplete를 꺼서, 크롬이 저장해둔 무관한 아이디를 자동으로 채워 넣지 못하게 한다
                  (실사용 확인, 2026-08-23: 이 속성이 빠져있어 Mall 상세관리엔 없는 "admin"이 여기만
                  자동으로 채워짐). */}
              <input type="text" value={loginId} onChange={e => { setLoginId(e.target.value); setLoginStep('none') }}
                autoComplete="off"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">비밀번호</span>
              <input type="password" value={loginPw} onChange={e => { setLoginPw(e.target.value); setLoginStep('none') }}
                autoComplete="new-password"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* 한 번이라도 눌러 완료된 단계는 진한 색(누르세요) 대신 옅은 테두리형 + 앞에 체크(✓)를 붙여,
                이미 지나온 단계와 다음에 눌러야 할 단계가 (색 대비만으론 헷갈릴 수 있어) 아이콘으로도 확실히
                구분되게 한다(보조 버튼인 몰 구조파악/직접지정 등은 그대로 둔다). */}
            <button onClick={handleOpenLogin} disabled={loginBusy}
              className={`px-4 py-2 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors ${
                loginStep === 'opened' || loginStep === 'confirmed'
                  ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                  : 'bg-teal-500 hover:bg-teal-600 text-white'}`}>
              {needsLogin
                ? (loginStep === 'opened' || loginStep === 'confirmed' ? '✓ 로그인 창 다시 열기' : '로그인 창 열기')
                : (loginStep === 'opened' || loginStep === 'confirmed' ? '✓ 몰 페이지 다시 열기' : '몰 페이지 열기')}
            </button>
            <button onClick={handleConfirmLogin} disabled={loginBusy || loginStep === 'none'}
              className={`px-4 py-2 text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                loginStep === 'confirmed'
                  ? 'bg-white border-2 border-emerald-500 text-emerald-600 hover:bg-emerald-50'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}>
              {loginStep === 'confirmed' ? '✓ 확인됨' : needsLogin ? '로그인 확인' : '확인'}
            </button>
            {/* "로컬 창"(서버 PC 화면에 실제로 뜨는 창)과 "원격으로 보기"(이 화면 안에서 실시간으로
                보고 조작) 둘 다 유지하고 고르게 한다(사용자 요청, 2026-08-24) — 백엔드는 이 값과 무관하게
                항상 같은 창을 띄우므로, 여기서 눌러도 handleOpenLogin 등 기존 로직은 그대로다. */}
            {(loginStep === 'opened' || loginStep === 'confirmed') && (
              <div className="flex border border-gray-300 rounded-full overflow-hidden text-xs font-semibold">
                <button type="button" onClick={() => setViewMode('local')}
                  className={`px-3 py-1.5 transition-colors ${viewMode === 'local' ? 'bg-gray-700 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                  로컬 창
                </button>
                <button type="button" onClick={() => setViewMode('remote')}
                  className={`px-3 py-1.5 transition-colors ${viewMode === 'remote' ? 'bg-gray-700 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                  🖥 원격으로 보기
                </button>
              </div>
            )}
            {loginStep === 'confirmed' && (
              <div className="flex items-center gap-2.5 text-xs text-gray-500">
                {AI_PROVIDER_OPTIONS.map(p => (
                  <label key={p.id} className="flex items-center gap-1 cursor-pointer select-none"
                    title={`${p.title}\n\n체크한 공급자만, 왼쪽부터 순서대로 하나씩 시도해 처음 성공한 결과를 씁니다 — 전부 끄면 AI 시도 없이 곧장 규칙 기반으로 분석합니다. 결과가 부실하면 체크를 바꿔 재시도해보세요.`}>
                    <input type="checkbox" checked={profileAiProviders.has(p.id)} onChange={() => toggleProfileAiProvider(p.id)}
                      className="w-3.5 h-3.5 accent-teal-500" />
                    {p.label}
                  </label>
                ))}
              </div>
            )}
            {loginStep === 'confirmed' && (
              // 이 인스턴스(일반모드)의 버튼엔 devmode-extension-icon("PTP" 배지)을 안 붙인다 — 바로 아래
              // 주석대로 여기는 서버 헤드리스 분석만 하고 확장과는 전혀 무관한데, 아이콘이 있으면 "이것도
              // 확장이 있어야 되는 건가?" 하고 헷갈린다(개발자모드 아닌 몰에서 이 아이콘이 왜 있냐는 사용자
              // 지적, 2026-08-31). 개발자모드 인스턴스(아래, handleProfileMall 두 번째 버튼)는 실제로 확장
              // 실행과 관련 있으므로 그대로 유지.
              <button onClick={handleProfileMall} disabled={profileLoading}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                {profileLoading ? '몰 구조분석 중...' : '🔍 몰 구조분석'}
              </button>
            )}
            {/* 이 버튼(handleProfileMall)은 서버가 헤드리스로 얻는 결제/구조 신호만 분석한다 — 카테고리
                하위구조/정렬옵션/페이지네이션 "다음" 감지까지 검증하려면 실제 몰 탭에서 확장을 거쳐야
                한다(chrome.debugger는 사용자 제스처가 있어야 붙는 물리적 제약이라 이 버튼이 대신할 수
                없음). 개발자모드 안내(위 details, 3013행 근처)와 같은 이유로 안내만 추가하고 이 버튼은
                그대로 둔다(사용자 요청, 2026-08-29 — 페이지네이션이 조용히 멈춰 상품이 누락되는 문제를
                이 버튼만으로는 잡을 수 없었던 사례). */}
            {loginStep === 'confirmed' && (
              <details className="w-full mt-1 text-xs text-gray-500">
                <summary className="cursor-pointer select-none hover:text-gray-700">
                  💡 카테고리 하위구조·정렬옵션·페이지네이션까지 함께 검증하려면
                </summary>
                <p className="mt-1.5">
                  이 몰의 로그인 창이 아직 열려 있다면, 그 창에서 확장 아이콘 → 팝업의{' '}
                  <b className="text-gray-700">&quot;🧭 보조 - 몰 구조분석&quot;</b>을 실행하세요 — 이 버튼과
                  같은 결과에 더해 카테고리 하위구조 · 정렬 옵션 · &quot;다음 페이지&quot; 감지까지 함께
                  검증되어 아래에 그대로 반영됩니다.
                </p>
              </details>
            )}
            {loginStep === 'confirmed' && mallProfileRunning && (
              <button onClick={handleStopProfileMall}
                className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full transition-colors">
                ⏹ 중지
              </button>
            )}
            {loginStep === 'confirmed' && (
              <span className="text-xs text-emerald-600 font-medium">
                {needsLogin
                  ? '✓ 로그인 확인됨 (이 창을 열어두면 스크래핑도 이 창에서 이어서 진행되고, 닫으면 백그라운드에서 진행됩니다)'
                  : '✓ 확인됨 (이 창을 열어두면 스크래핑도 이 창에서 이어서 진행되고, 닫으면 백그라운드에서 진행됩니다)'}
              </span>
            )}
            {/* "로그아웃" 링크를 못 찾았다는 약한 신호일 뿐(몰마다 문구가 다를 수 있음) — 그래서 확정
                문구("로그인 안 됨")가 아니라 "확인해달라"는 경고로만 보여주고 흐름은 막지 않는다
                (사용자 요청, 2026-08-31). */}
            {loginStep === 'confirmed' && loginVerified === false && (
              <span className="text-xs text-amber-600 font-medium" title="이 페이지에서 '로그아웃' 링크를 찾지 못했습니다 — 몰 UI에 따라 오탐일 수 있으니, 실제로 로그인이 완료됐는지 창에서 직접 확인해주세요.">
                ⚠ 로그인 여부를 확인해주세요 (로그아웃 링크를 못 찾음)
              </span>
            )}
            {loginStep === 'opened' && (
              <span className="text-xs text-gray-500">
                {needsLogin ? '브라우저 창에서 로그인을 완료한 뒤 확인을 눌러주세요.' : '브라우저 창이 열리면 확인을 눌러주세요.'}
              </span>
            )}
            {/* 이 창은 자동화 제어가 붙은 채로만 "화면에 보이는" 것일 뿐이라(launchVisibleWindow), Windows
                Hello/WebAuthn(PC인증)로 자동화 브라우저 자체를 막는 몰에서는 아이디/비번을 아무리 정확히
                입력해도 로그인이 안 된다 — 그런 몰은 사용자의 진짜 개인 크롬(개발자모드)이어야 통과된다.
                "로그인 확인"을 눌러도 실제로는 로그인이 안 된 채로 다음 단계가 전부 실패하는 대신, 여기서
                바로 전환할 수 있게 한다(사용자 지적으로 추가, 2026-08-15). last_login_confirmed_at 또는
                완료된 스크랩 세션이 이미 있는 몰은 일반모드가 실제로 동작함이 이미 증명됐다는 뜻이라, 이
                힌트가 더 이상 필요 없다 — 세션 만료 등으로 다시 "확인 대기 중"이 돼도 안 보이게 한다
                (사용자 지적, 2026-08-16). last_login_confirmed_at만 보면 안 되는 이유: 실제 스크랩은
                withContext가 저장된 아이디/비번으로 자동 로그인해 돌 때도 있어(예: 예약 재스크랩), 이
                화면의 "로그인 창 열기 → 확인" UI를 한 번도 안 거치고도 정상 완료된 몰이 있다(걸스굽
                실사용 확인 — 완료 세션 4건인데 로그인 확인 기록은 없어 이 힌트가 계속 떴음). */}
            {needsLogin && loginStep === 'opened' && !selectedSite.last_login_confirmed_at && !selectedSite.has_completed_scrape && (
              <p className="w-full text-xs text-amber-600">
                {/* 깜빡임은 문구에만 건다 — 버튼까지 같이 깜빡이면 마우스를 가져다 대도 옅어지는 순간엔
                    누르려는 대상이 잘 안 보이니, 버튼은 항상 또렷하게 두고 호버 시 배경을 채워 확실히
                    인지시킨다(사용자 지적으로 추가, 2026-08-15). */}
                <span className="animate-[pulse_1s_ease-in-out_infinite]">
                  ⚠ Windows 보안(PC인증) 창이 뜨거나 로그인이 계속 안 풀리시나요?
                </span>{' '}
                <button type="button" onClick={() => handleChooseScrapeMode(true)} disabled={modeSaving}
                  className="font-semibold underline hover:no-underline hover:bg-amber-100 hover:text-amber-900 rounded px-1 -mx-1 transition-colors disabled:opacity-50">
                  개발자모드로 전환
                </button>
              </p>
            )}
          </div>
          {viewMode === 'remote' && (loginStep === 'opened' || loginStep === 'confirmed') && (
            <div className="mt-3">
              <RemoteScreenViewer siteId={selectedSite.id} />
            </div>
          )}
          {!needsLogin && (
            <p className="text-xs text-gray-400 mt-2">아이디를 입력하지 않으면 로그인 없이 바로 스크래핑을 시작할 수 있습니다. 몰 구조분석을 쓰려면 위에서 몰 페이지를 먼저 열고 확인을 눌러주세요.</p>
          )}

          <div ref={profileResultRef}>
            {/* loading은 profileLoading(PTP 버튼으로 직접 시작한 경우)만이 아니라 mallProfileRunning
                (확장 팝업에서 시작해 siteLockStatus로만 감지되는 경우까지)을 써야 두 경로 모두에서
                이 스켈레톤/진행 문구가 보인다 — "중지" 버튼 표시와 같은 이유(2026-08-22). */}
            <MallProfileResultDisplay error={profileError} result={profileResult} loading={mallProfileRunning} detail={siteLockStatus?.detail} elapsedSec={profileElapsedSec} sinceMs={siteLockStatus?.sinceMs} />
          </div>
          </>}
        </div>
      )}

      {/* 스크랩 대상 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2 gap-3">
            <div className="text-sm font-semibold text-gray-700">
              스크랩 대상
              {scrapeTargetCollapsed && (() => {
                // 실제로 스크랩에 쓰일 목록(buildCategoryUrlsAndLimits와 같은 기준, categorySourceMode)을
                // 보여준다 — 예전엔 항상 categoryUrlsText(자동 탭)만 봐서, "선택 가져오기"를 쓰는 중에도
                // 접힌 요약이 실제 대상과 다르게 보였다(사용자 실사용 확인, 2026-08-27).
                const activeHrefs = activeCategoryUrlsText.trim()
                const modeLabel = categorySourceMode === 'manual' ? '선택 가져오기' : '전체 가져오기'
                return (
                  <span className="ml-2 font-normal text-gray-400">
                    {activeHrefs ? `— [${modeLabel}] 카테고리 ${activeHrefs.split('\n').filter(Boolean).length}개` : targetUrl ? `— ${targetUrl}` : '— 미지정'}
                  </span>
                )
              })()}
            </div>
            <button onClick={() => setScrapeTargetCollapsed(v => !v)}
              className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
              {scrapeTargetCollapsed ? '▼ 펼치기' : '▲ 접기'}
            </button>
          </div>
          {!scrapeTargetCollapsed && <>
          {/* 예전엔 탭으로 하나만 보여줬는데(2026-08-22 — 둘을 나란히 보이면 "지금 뭘 보고 있는지"
              헷갈린다는 이유), 이번엔 반대로 "탭을 오가는 게 오히려 헷갈린다"는 지적(2026-08-26)으로
              좌우 카드로 항상 둘 다 펼쳐두고, 각 카드 제목의 라디오로만 "실제로 스크랩에 쓸 쪽"을
              고르게 한다 — 라디오가 선택 표시를 명확히 대신하므로 둘을 동시에 보여줘도 헷갈리지 않는다.
              두 카드 다 항상 조작 가능하다(예: auto가 선택된 상태에서도 manual 쪽 목록을 미리 모아둘 수
              있음) — 실제로 미리보기/스크랩이 쓰는 목록만 라디오 선택 기준(buildCategoryUrlsAndLimits). */}
          <p className="text-xs text-gray-400 mb-2">카테고리 URL 목록을 만드는 방법 — 왼쪽/오른쪽 아무 쪽이나 미리 준비해두고, 실제로 스크랩에 쓸 쪽만 라디오로 고르세요.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className={`rounded-xl border-2 p-3 transition-colors ${categorySourceMode === 'auto' ? 'border-teal-400 bg-teal-50/30' : 'border-gray-200'}`}>
              <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                <input type="radio" name="categorySourceMode" checked={categorySourceMode === 'auto'}
                  onChange={() => setCategorySourceMode('auto')} className="w-4 h-4 accent-teal-500" />
                <span className="text-sm font-semibold text-gray-700">⚡ 몰 카테고리 전체 가져오기</span>
              </label>
              <ScrapeStepBox
                description="💡 몰에 있는 카테고리들을 자동으로 찾아옵니다 — 시작 URL을 하나하나 알아낼 필요 없이 원하는 카테고리를 바로 불러올 수 있습니다. 결과는 아래 체크리스트에 나타납니다."
                primary={{
                  label: '모든 카테고리 불러오기', doneLabel: '카테고리 불러옴', icon: '↻',
                  loading: categoriesLoading, loadingLabel: '불러오는 중...',
                  done: categories.length > 0, colorDone: !!previewResult, disabled: categoriesLoading || !targetUrl,
                  onClick: () => handleLoadCategories(false),
                }}
                secondary={categories.length > 0 ? {
                  label: '↻ 다시 확인', title: '몰 메뉴가 바뀌었을 수 있으면 직접 다시 훑어서 최신 목록으로 갱신합니다',
                  disabled: categoriesLoading || !targetUrl, onClick: () => handleLoadCategories(true),
                } : undefined}
                onStop={handleStopCategories} />
              {/* 카테고리 불러오기 결과(캐시 안내/감지된 플랫폼/체크리스트) */}
              <div ref={categoryResultRef}>{categoryChecklistBox}</div>
            </div>
            <div className={`rounded-xl border-2 p-3 transition-colors ${categorySourceMode === 'manual' ? 'border-teal-400 bg-teal-50/30' : 'border-gray-200'}`}>
              <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                <input type="radio" name="categorySourceMode" checked={categorySourceMode === 'manual'}
                  onChange={() => setCategorySourceMode('manual')} className="w-4 h-4 accent-teal-500" />
                <span className="text-sm font-semibold text-gray-700">🖱 몰 카테고리 선택 가져오기(반복)</span>
              </label>
              <ScrapeStepBox
                description="💡 로그인 창에서 원하는 카테고리 페이지로 이동했다면, 그 페이지를 아래 목록에 하나씩 추가합니다 — 여러 번 눌러 여러 개를 모을 수 있습니다."
                primary={{
                  label: '현재 카테고리 가져오기', doneLabel: '현재 카테고리 가져옴', icon: '↻',
                  loading: currentUrlLoading, loadingLabel: '가져오는 중...',
                  done: currentUrlFetched, colorDone: !!previewResult, disabled: loginStep === 'none',
                  onClick: handleRefreshCurrentUrl,
                }} />
              {manualCategoryTableBox}
            </div>
          </div>
          </>}
        </div>
      )}

      {/* 개발자모드 안내 — 일반모드의 "로그인 정보"/"스크랩 대상" 카드에 대응하는, 개발자모드가 실제로
          해야 하는 1단계(자기 브라우저를 직접 열고 로그인)다. 아래 "상품 페이지 미리보기"의 미리보기/피커
          버튼은 이 단계를 먼저 마쳐야 의미가 있어 작업 순서대로 이 카드를 위에 둔다 — 예전엔 이 안내가
          맨 아래 "스크래핑 Start" 버튼을 눌러야만 나타나서, 먼저 해야 할 일(브라우저 열기)이 나중에,
          나중에 눌러야 할 버튼(미리보기)이 먼저 보이는 순서로 헷갈렸다(사용자 피드백으로 재설계). */}
      {selectedSite && mallMode === 'devmode' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between mb-3 pb-3 border-b border-gray-100 flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-gray-700">🧩 개발자모드 스크랩 방법</div>
              <button onClick={() => setDevModeGuideCollapsed(v => !v)}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                {devModeGuideCollapsed ? '▼ 펼치기' : '▲ 접기'}
              </button>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {/* relative + absolute로 떠서 버튼 위에 겹치게 뜨는 팝오버 — flow에 얹으면(기존 방식) 뜰
                  때마다 아래 버튼 줄이 밀렸다가 사라질 때 다시 당겨져, 5초짜리 안내치고 화면이 계속
                  들썩였다(사용자 지적, 2026-08-29: "모달 창 형태로 떴다가 사라지게"). */}
              <div className="relative">
                {profileFocusHint && (
                  <div className="absolute bottom-full right-0 mb-2 w-72 z-20 text-right bg-teal-600 text-white text-xs rounded-xl shadow-lg px-3 py-2.5 flex items-start gap-2">
                    <p className="flex-1 text-left">{profileFocusHint}</p>
                    <button onClick={() => setProfileFocusHint(null)} aria-label="닫기" className="text-teal-200 hover:text-white shrink-0">✕</button>
                  </div>
                )}
                <div className="flex items-center gap-2">
                <button onClick={() => handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)}
                  className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors shrink-0">
                  🌐 브라우저에서 바로 열기
                </button>
                {/* 이 버튼은 왼쪽 "브라우저에서 바로 열기"와 사실상 같은 동작(몰 창 열고 앞으로 가져오기)
                    + 확장 실행 안내다 — 개발자모드는 서버 헤드리스(개인 크롬 프로필 사본) 분석을 신뢰할 수
                    없어(자동화가 막혀서 devmode로 등록된 몰이니까) 실제 분석은 항상 그 창의 확장에 맡긴다
                    (handleProfileMall 참고, 2026-08-29). AI 공급자 체크박스는 이제 여기(개발자모드)선 안
                    쓰인다 — 확장의 runProfile은 body 없이 호출해 서버가 항상 공급자 전체(aiProviders 기본값)로
                    처리한다 — 그래서 이 인스턴스에서는 뺐다(일반모드 로그인 카드의 체크박스는 그대로 동작). */}
                {/* awaitingDevProfileAction(위 useState 근처 주석 참고): 이 버튼을 누른 뒤 몰 창으로
                    포커스가 넘어가버려 팝오버(5초)를 놓치기 쉽다는 지적(2026-09-05)으로, 확장이 실제로
                    분석을 시작하기 전까지는 버튼 자체를 amber로 강조 + 글로우(animate-pulse-glow-amber,
                    app/globals.css)로 계속 눈에 띄게 한다. */}
                <button onClick={handleProfileMall}
                  className={`px-4 py-2 border text-sm font-semibold rounded-full transition-colors shrink-0 ${
                    awaitingDevProfileAction
                      ? 'bg-amber-50 border-amber-400 text-amber-700 hover:bg-amber-100 animate-pulse-glow-amber'
                      : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}>
                  <Image src="/devmode-extension-icon.png" alt="PTP" width={16} height={16} unoptimized
                    className="inline-block align-text-bottom rounded-sm mr-1" />
                  🔍 몰 구조분석
                </button>
                {mallProfileRunning && (
                  <button onClick={handleStopProfileMall}
                    className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full transition-colors shrink-0">
                    ⏹ 중지
                  </button>
                )}
                </div>
              </div>
              {/* profileFocusHint(5초 팝오버)/awaitingDevProfileAction(버튼 amber 강조)만으로는 "지금 정말
                  진행 중인지"가 잘 안 보인다는 지적(2026-09-06) — 팝오버는 금방 사라지고, 실제 진행 상황
                  (MallProfileResultDisplay의 스켈레톤+단계 텍스트)은 아래로 스크롤해야 보여서 다른 몰을
                  보거나 화면을 벗어나면 놓치기 쉬웠다. 버튼 바로 옆에 항상 눈에 보이는 한 줄 상태를 둔다 —
                  siteLockStatus가 아직 busy가 아니면(사용자가 몰 창의 확장 버튼을 누르기 전) "시작 전"임을,
                  busy면 지금 몇 단계인지(siteLockStatus.detail)를 그대로 보여준다. */}
              {(awaitingDevProfileAction || mallProfileRunning) && (
                <div className={`text-xs rounded-lg px-3 py-1.5 max-w-[18rem] text-right ${
                  mallProfileRunning ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700'
                }`}>
                  {mallProfileRunning
                    ? <>🔄 {siteLockStatus?.detail || '몰 구조분석 진행 중...'}
                        {siteLockStatus?.sinceMs != null && ` (${formatElapsedSeconds(Math.round(siteLockStatus.sinceMs / 1000))}째)`}</>
                    : '⏳ 아직 시작 전 — 몰 창에서 확장 아이콘 → "🧭 보조 - 몰 구조분석"을 눌러주세요.'}
                </div>
              )}
              {(loginId || loginPw) && (
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {loginId && (
                    <span>아이디: <b className="text-gray-700">{loginId}</b>{' '}
                      <button onClick={() => handleCopyCred('id', loginId)} className="text-teal-500 hover:underline">
                        {credCopied === 'id' ? '✓ 복사됨' : '복사'}
                      </button>
                    </span>
                  )}
                  {loginPw && (
                    <span>비밀번호: <b className="text-gray-700">{'•'.repeat(Math.min(loginPw.length, 10))}</b>{' '}
                      <button onClick={() => handleCopyCred('pw', loginPw)} className="text-teal-500 hover:underline">
                        {credCopied === 'pw' ? '✓ 복사됨' : '복사'}
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {!devModeGuideCollapsed && (
          <>
          {/* 1순위 흐름만 번호 목록으로 — 몰 구조분석/미리보기/컬럼 직접지정은 이 기본 흐름에 필수가
              아닌 보조 기능이라 아래 <details>(보조 설명)로 내렸다(사용자 지적, 2026-08-15: "핵심 흐름부터
              보이고 나머지는 보조설명으로"). */}
          <ol className="list-decimal list-inside text-sm text-gray-600 space-y-3">
            <li>
              <DevModeLocationBadge where="ptp" /><b className="text-gray-700">&quot;🌐 브라우저에서 바로 열기&quot;</b>로 몰 탭을 열고, <DevModeLocationBadge where="mall" />복사해둔 아이디/비밀번호를 <b className="text-gray-700">직접 입력</b>해 로그인합니다(자동입력 안 됨).
            </li>
            <li>
              <DevModeLocationBadge where="ptp" />전체 상품을 스크랩할 거면 그냥 다음 단계로 — 특정 카테고리만 스크랩하려면 아래 &quot;카테고리 불러오기&quot;에서 원하는 것만 체크해두세요.
            </li>
            <li>
              <DevModeLocationBadge where="mall" />목록(카테고리) 페이지가 열린 상태에서{' '}
              <Image src="/devmode-extension-icon.png" alt="PTP 확장 아이콘" width={16} height={16} unoptimized
                className="inline-block align-text-bottom rounded-sm mx-0.5" />
              확장 아이콘 → 팝업의 <b className="text-gray-700">&quot;🔄 스크랩 시작&quot;</b>을 클릭합니다.{' '}
              <DevModeLocationBadge where="ptp" />진행 상황은 아래에 자동으로 나타나며, 완료되면 &quot;스크랩 Raw 확인&quot;으로 이동할 수 있습니다.
            </li>
          </ol>
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none hover:text-gray-700">보조 설명 — 몰 구조분석 · 상품 1건만 미리보기 · 컬럼 직접지정</summary>
            <ul className="list-disc list-inside mt-2 space-y-1.5">
              <li><DevModeLocationBadge where="mall" />(선택, 로그인 전에도 가능) 확장 아이콘 → 팝업의 <b className="text-gray-700">&quot;🧭 보조 - 몰 구조분석&quot;</b> 하나로 몰 구조분석 · 카테고리 하위구조 · 정렬 옵션 · &quot;다음 페이지&quot; 감지까지 한 번에 확인됩니다 — 결과는 <DevModeLocationBadge where="ptp" />PTP 화면에 나타납니다.</li>
              <li><DevModeLocationBadge where="mall" />상품 1건만 먼저 확인하려면 → 확장 아이콘 → 팝업의 <b className="text-gray-700">&quot;🔍 스크랩 미리보기 - (카테선택)&quot;</b> (PTP의 &quot;스크랩 미리보기&quot;는 안 눌러도 자동 반영됩니다)</li>
              <li>원하는 카테고리를 직접 돌아다니며 하나씩 모으려면 → <DevModeLocationBadge where="mall" />로그인한 상태에서 원하는 카테고리로 이동한 뒤 확장 아이콘 → 팝업의 <b className="text-gray-700">&quot;📍 보조 - 현재 카테고리 가져오기&quot;</b> — 여러 번 눌러 계속 추가할 수 있고, <DevModeLocationBadge where="ptp" />몇 초 안에 아래 카테고리 목록에 자동 반영됩니다.</li>
              <li>컬럼을 직접 지정하려면 → 먼저 <DevModeLocationBadge where="ptp" />에서 &quot;스크랩 대상 직접지정&quot; 클릭 → <DevModeLocationBadge where="mall" />팝업의 <b className="text-gray-700">&quot;🎯 보조 - 스크랩 대상 직접지정&quot;</b></li>
              <li>확장 아이콘이 안 보이면 퍼즐조각(🧩) 아이콘을 먼저 눌러 목록에서 찾으세요(자주 쓰면 그 옆 핀으로 고정).</li>
            </ul>
            {/* unoptimized — 이 dev 환경의 Next 이미지 최적화가 PNG를 처리 못해(실측: 새로 만든 PNG도
                전부 400, JPG는 정상) /_next/image 경유 없이 public 정적 파일을 그대로 서빙한다. */}
            <div className="mt-2 inline-block border border-gray-200 rounded-lg overflow-hidden">
              <Image src="/devmode-extension-popup.png" alt="실제 확장 프로그램 팝업 화면 — 몰 구조분석/스크랩 미리보기 실행/스크랩 시작/스크랩 대상 직접지정 버튼"
                width={304} height={211} unoptimized className="block" />
            </div>
          </details>
          </>
          )}
          {/* 일반모드의 "카테고리 불러오기"와 같은 기능 — 여러 카테고리를 체크해두면 "스크랩 시작"이 지금
              탭 위치와 무관하게 그 카테고리들만 순서대로 처리한다(background.js의 run() 참고, 2026-08-15).
              targetUrl은 selectSite에서 이미 site.url로 채워져 있어 로그인 여부와 무관하게 바로 쓸 수 있다. */}
          {/* 몰 구조분석 결과 → 카테고리 불러오기 순서로 — 몰 구조를 먼저 파악하고 그 다음 카테고리를
              고르는 게 자연스러운 흐름이라, 위아래로 붙어 하나처럼 보이던 두 결과를 각자 독립된 박스로
              완전히 분리했다(사용자 지적, 2026-08-16: "몰구조분석 결과물 아래에 카테고리가져오기가 있어야
              자연스러움" / "줄로 구분하지 말고 완전히 분리시켜줘" — 구분선 한 줄로는 부족하다고 재지적). */}
          <div ref={profileResultRef}>
            {/* loading은 profileLoading(PTP 버튼으로 직접 시작한 경우)만이 아니라 mallProfileRunning
                (확장 팝업에서 시작해 siteLockStatus로만 감지되는 경우까지)을 써야 두 경로 모두에서
                이 스켈레톤/진행 문구가 보인다 — "중지" 버튼 표시와 같은 이유(2026-08-22). */}
            <MallProfileResultDisplay error={profileError} result={profileResult} loading={mallProfileRunning} detail={siteLockStatus?.detail} elapsedSec={profileElapsedSec} sinceMs={siteLockStatus?.sinceMs} />
          </div>
          {/* 일반모드의 "모든 카테고리 불러오기"와 같은 ScrapeStepBox를 그대로 써서 버튼 두 개(주 버튼의
              완료 표시 + "다시 확인")가 항상 같이 보이게 맞췄다 — 예전엔 버튼 하나가 라벨만 바꿔가며
              "다시 확인"으로 완전히 대체돼, 카테고리를 이미 불러온 뒤엔 "카테고리 불러오기"가 안 보이는
              것처럼 보였다(사용자 지적, 2026-08-16: "다시 확인 버튼만 보이는데 일반모드 UI와 맞춰줘").
              탭(categorySourceMode)도 일반모드와 같은 상태를 공유한다 — "몰 카테고리 선택 가져오기(반복)"는
              개발자모드에선 PTP가 직접 못 하고 몰 탭의 확장이 대신 하므로, 버튼을 누르면 다른 devmode
              버튼들과 같은 패턴(몰 탭 열기 + showDevHint 안내)으로 동작한다 — 실제 결과는 위쪽
              "현재 카테고리 가져오기" 큐 폴링이 카테고리 URL 목록에 자동으로 채워준다(2026-08-22,
              사용자 지적: "개발자모드에는 이 기능이 반영 안 돼 있다"). */}
          {/* 일반모드와 같은 이유(2026-08-26)로 탭 대신 좌우 카드 + 라디오 선택으로 바꿨다 —
              components/panels/ScraperPanel.tsx의 일반모드 "스크랩 대상" 카드 주석 참고. */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className={`bg-white border-2 rounded-xl p-4 transition-colors ${categorySourceMode === 'auto' ? 'border-teal-400 bg-teal-50/30' : 'border-gray-200'}`}>
              <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                <input type="radio" name="categorySourceMode" checked={categorySourceMode === 'auto'}
                  onChange={() => setCategorySourceMode('auto')} className="w-4 h-4 accent-teal-500" />
                <span className="text-sm font-semibold text-gray-700">⚡ 몰 카테고리 전체 가져오기</span>
              </label>
              <ScrapeStepBox
                description="💡 카테고리를 불러와 원하는 것만 체크하면, &quot;스크랩 시작&quot;이 그 카테고리들만 순서대로 처리합니다(선택사항)."
                primary={{
                  label: '모든 카테고리 불러오기', doneLabel: '카테고리 불러옴', icon: '↻',
                  loading: categoriesLoading, loadingLabel: '불러오는 중...',
                  done: categories.length > 0, colorDone: !!previewResult, disabled: categoriesLoading || !targetUrl,
                  onClick: () => handleLoadCategories(false),
                }}
                secondary={categories.length > 0 ? {
                  label: '↻ 다시 확인', title: '몰 메뉴가 바뀌었을 수 있으면 직접 다시 훑어서 최신 목록으로 갱신합니다',
                  disabled: categoriesLoading || !targetUrl, onClick: () => handleLoadCategories(true),
                } : undefined}
                onStop={handleStopCategories} />
              <div ref={categoryResultRef}>{categoryChecklistBox}</div>
            </div>
            <div className={`bg-white border-2 rounded-xl p-4 transition-colors ${categorySourceMode === 'manual' ? 'border-teal-400 bg-teal-50/30' : 'border-gray-200'}`}>
              <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                <input type="radio" name="categorySourceMode" checked={categorySourceMode === 'manual'}
                  onChange={() => setCategorySourceMode('manual')} className="w-4 h-4 accent-teal-500" />
                <span className="text-sm font-semibold text-gray-700">🖱 몰 카테고리 선택 가져오기(반복)</span>
              </label>
              <ScrapeStepBox
                description="💡 몰 탭에서 원하는 카테고리 페이지로 이동했다면, 그 페이지를 아래 목록에 하나씩 추가합니다 — 여러 번 눌러 여러 개를 모을 수 있습니다."
                primary={{
                  label: '현재 카테고리 가져오기', doneLabel: '현재 카테고리 가져옴', icon: '↻',
                  loading: false, done: false, awaiting: awaitingDevCategoryAction,
                  awaitingLabel: '로그인한 몰에서 PTP 확장 실행', showPtpBadge: true,
                  // sendExtensionAction('current-category', ...) 자동실행 시도는 제거했다 — extension-poc/
                  // manifest.json에 externally_connectable이 없어 지금은 항상 조용히 실패해 매번 이 아래
                  // 수동 안내로만 폴백하고 있었다(위 awaitingDevCategoryAction 주석 참고). "🔍 몰 구조분석"/
                  // "🔍 스크랩 미리보기"와 같은 방식(focus + 안내 + 강조)으로 통일한다(사용자 요청, 2026-09-05).
                  onClick: async () => {
                    if (loginStep === 'none' && selectedSite) {
                      await handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)
                      showDevHint('몰 탭을 열었습니다 — 로그인 후 원하는 카테고리로 이동한 뒤 확장 아이콘 → 팝업의 "📍 보조 - 현재 카테고리 가져오기"를 클릭하세요.')
                    } else if (selectedSite) {
                      const focused = await fetch('/api/scrape/login/focus', { method: 'POST' })
                        .then(r => r.json()).then(d => !!d.ok).catch(() => false)
                      showDevHint(focused
                        ? '로그인한 몰에서 PTP 확장 아이콘 → "📍 보조 - 현재 카테고리 가져오기"를 눌러 실행하세요.'
                        : '열려있는 몰 탭을 찾지 못했습니다 — 몰 탭에서 확장 아이콘 → 팝업의 "📍 보조 - 현재 카테고리 가져오기"를 클릭하세요.')
                    }
                    startAwaitingDevCategoryAction()
                  },
                }} />
              {manualCategoryTableBox}
            </div>
          </div>
        </div>
      )}

      {/* 상품 페이지 미리보기 — 일반모드/개발자모드 공용 카드(2026-07-27 통합). 개발자모드는 PTP가 그 몰
          탭에 직접 접근할 수 없어(chrome.debugger 확장 전용 구조) 버튼을 눌러도 즉시 결과가 나오지 않고,
          사용자가 몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 채워진다 — 그 차이만 빼면 이 카드를 그대로
          공유해 두 모드를 한 곳에서 관리한다. */}
      {selectedSite && (mallMode === 'normal' || mallMode === 'devmode') && (
        <div ref={previewSectionRef} className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <label className="block text-sm font-semibold text-gray-700">스크래핑 미리보기</label>
            <div className="flex items-center gap-2 shrink-0">
              {/* 미리보기(카테고리별 개수 집계)와 아래 "스크래핑 시작" 둘 다 이 값을 그대로 쓴다(handlePreview/
                  handleStart) — 여기 한 곳에서만 조절하면 된다. 열린 탭 수가 메모리 사용량에 직결되므로
                  (각 탭이 이미지까지 로드) 메모리가 부족하면 수동으로 낮춰본다. */}
              <div className="flex items-center gap-1 shrink-0"
                title="카테고리/상품 페이지를 동시에 몇 개까지 열지 정합니다. 자동은 몰 반응을 보며 스스로 조절하고(스크래핑 시작 시 1~16, 미리보기는 16), 수동은 지정한 개수로 항상 고정합니다 — 메모리가 부족하면 수동으로 1~2개까지 낮춰보세요.">
                {/* 보조 기능(켜짐/꺼짐) 토글은 옆의 주 액션 버튼(rounded-full 알약 모양)과 모양부터 다르게
                    — rounded-md의 각진 "체크박스형 스위치"로 둬서 누르면 바로 실행되는 버튼이 아니라는 걸
                    형태만으로도 구분되게 한다. */}
                <button type="button" onClick={() => setConcurrencyMode(m => m === 'manual' ? 'auto' : 'manual')}
                  aria-pressed={concurrencyMode === 'manual'}
                  className={`px-3 py-1 rounded-md text-sm font-medium border transition-colors ${concurrencyMode === 'manual' ? 'bg-amber-100 text-amber-700 border-amber-300' : 'bg-white text-gray-500 border-gray-300 hover:border-amber-300'}`}>
                  {concurrencyMode === 'manual' ? '☑ 동시 처리 수동' : '☐ 동시 처리 자동'}
                </button>
                {concurrencyMode === 'manual' && (
                  <input type="number" min={1} max={16} value={concurrency}
                    onChange={e => setConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                    className="w-14 px-2 py-1 border border-gray-300 rounded-lg text-sm text-center" />
                )}
              </div>
              <button type="button"
                onClick={() => {
                  const next = !aiMode
                  setAiMode(next)
                  if (mallMode === 'devmode' && selectedSite) {
                    fetch(`/api/sites/${selectedSite.id}`, {
                      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ devmodeAiPreview: next }),
                    })
                  }
                }}
                aria-pressed={aiMode}
                title="켜두면 미리보기 시점에 AI가 이 몰의 상품 페이지 구조를 분석해 컬럼별 추출 규칙을 자동으로 만들어 저장합니다. 미리보기로 결과를 확인하고, 부족한 부분은 '스크랩 대상 직접지정'으로 보완하세요."
                className={`px-3 py-1 rounded-md text-sm font-medium border transition-colors ${aiMode ? 'bg-violet-100 text-violet-700 border-violet-300' : 'bg-white text-gray-500 border-gray-300 hover:border-violet-300'}`}>
                {aiMode ? '☑ 🪄 AI모드 켜짐' : '☐ AI모드 꺼짐'}
              </button>
              {/* devmode에서 이 버튼을 누르면 실제 캡처는 몰 탭의 확장이 해야 해서(로그인 자동화 불가 —
                  handleDevPreview 주석 참고) 사용자가 그 창으로 건너가 확장 아이콘을 직접 눌러야 한다 —
                  "🔍 몰 구조분석" 버튼과 같은 이유로, 그동안 이 버튼 자체를 amber 강조 + 글로우로 계속
                  눈에 띄게 한다(사용자 요청, 2026-09-05 — 아래 결과 자리에 따로 떠 있던 깜빡이는 안내
                  문구는 버튼 쪽으로 옮기며 제거). previewLoading이 실제 결과 도착/타임아웃으로 꺼지면
                  자동으로 강조도 꺼진다(별도 상태 없이 previewLoading 자체가 "대기 중" 신호). */}
              {/* previewFocusHint 팝오버 — profileFocusHint(🔍 몰 구조분석 버튼)와 같은 이유·같은 패턴
                  (relative + absolute로 떠서 버튼 위에 겹치게, flow에 얹으면 뜰 때마다 화면이 들썩임). */}
              <div className="relative">
                {previewFocusHint && (
                  <div className="absolute bottom-full right-0 mb-2 w-72 z-20 text-right bg-teal-600 text-white text-xs rounded-xl shadow-lg px-3 py-2.5 flex items-start gap-2">
                    <p className="flex-1 text-left">{previewFocusHint}</p>
                    <button onClick={() => setPreviewFocusHint(null)} aria-label="닫기" className="text-teal-200 hover:text-white shrink-0">✕</button>
                  </div>
                )}
                <button type="button" onClick={mallMode === 'devmode' ? handleDevPreview : handlePreview}
                  disabled={previewLoading || (mallMode === 'normal' && !canPreview)}
                  className={`px-4 py-2 text-sm font-semibold rounded-full disabled:cursor-not-allowed transition-colors ${
                    mallMode === 'devmode' && previewLoading
                      ? 'bg-amber-50 border border-amber-400 text-amber-700 animate-pulse-glow-amber disabled:opacity-100'
                      : `disabled:opacity-50 ${previewResult
                        ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                        : 'bg-teal-500 hover:bg-teal-600 text-white'}`}`}>
                  {previewLoading
                    ? (mallMode === 'devmode' ? '로그인한 몰에서 PTP 확장 실행' : previewProgress ? `카테고리 확인 중... (${previewProgress.done}/${previewProgress.total})` : aiMode ? 'AI 분석 중...' : '확인 중...')
                    : previewResult ? '✓ 스크랩 미리보기' : '🔍 스크랩 미리보기'}
                  {/* 몰 탭에서 찾아야 할 확장 아이콘이 빨간 배경에 흰 글자로 "PTP"라 — 같은 색으로 작게
                      표시해 "이 버튼 = 저 아이콘"이라는 걸 시각적으로 바로 연결시킨다(2026-08-22). */}
                  {mallMode === 'devmode' && !previewLoading && (
                    <span className="ml-1 text-red-600 text-[10px] font-extrabold align-super">PTP</span>
                  )}
                </button>
              </div>
              {/* 진행 중이라는 걸 알 수 있게(일반모드는) 서버가 세는 카테고리 개수 기준 진행률도 폴링해서
                  같이 보여준다(끝없이 도는 것처럼 보인다는 피드백 — lib/scraper.ts의 getPreviewProgress
                  참고). 개발자모드는 확장에 'stop-preview'를 보내 몰 탭의 순회를 멈춘다(2026-08-22). */}
              {previewLoading && (
                <button type="button" onClick={mallMode === 'devmode' ? handleStopDevPreview : handleStopPreview}
                  className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full transition-colors">
                  ⏹ 중지
                </button>
              )}
              {(mallMode === 'devmode' || loginStep === 'confirmed') && (
                <div className="relative">
                  {/* pickerFocusHint 팝오버 — previewFocusHint/profileFocusHint와 같은 이유·같은 패턴. */}
                  {pickerFocusHint && (
                    <div className="absolute bottom-full right-0 mb-2 w-72 z-20 text-right bg-teal-600 text-white text-xs rounded-xl shadow-lg px-3 py-2.5 flex items-start gap-2">
                      <p className="flex-1 text-left">{pickerFocusHint}</p>
                      <button onClick={() => setPickerFocusHint(null)} aria-label="닫기" className="text-teal-200 hover:text-white shrink-0">✕</button>
                    </div>
                  )}
                  {mallMode === 'devmode' ? (
                    pickerActive ? (
                      <button onClick={() => setPickerActive(false)} disabled={pickerBusy}
                        className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                        🎯 스크랩 대상 직접지정 종료
                      </button>
                    ) : (
                      // 이 버튼은 PTP 쪽 안내 배너만 켤 뿐 실제 피커는 몰 탭의 확장이 띄운다 — 눌러도 여기서
                      // 아무 일도 안 일어나는 것처럼 보인다는 지적으로, 클릭 즉시 어디서 실행해야 하는지
                      // 바로 알려준다(2026-08-15). 몰 탭을 아직 안 열었으면 "스크랩 미리보기"와 같은 이유로
                      // 이 버튼이 대신 열어준다(2026-08-16). sendExtensionAction('picker', ...) 자동실행
                      // 시도는 제거했다 — extension-poc/manifest.json에 externally_connectable이 없어
                      // 항상 조용히 실패하고 있었다(다른 sendExtensionAction 호출부와 같은 이유, 2026-09-05) —
                      // "🔍 몰 구조분석"과 같은 focus + 안내 방식으로 통일한다. 버튼이 이미 "종료"로 바뀌는
                      // 것 자체가 클릭이 인식됐다는 표시라(setPickerActive(true)), 별도 강조(glow)는 안 둔다.
                      <button onClick={async () => {
                        setPickerActive(true)
                        if (loginStep === 'none' && selectedSite) {
                          await handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)
                          showPickerFocusHint('몰 탭을 열었습니다 — 로그인 후 확장 아이콘 → 팝업의 "🎯 보조 - 스크랩 대상 직접지정"을 클릭하세요.')
                        } else if (selectedSite) {
                          const focused = await fetch('/api/scrape/login/focus', { method: 'POST' })
                            .then(r => r.json()).then(d => !!d.ok).catch(() => false)
                          showPickerFocusHint(focused
                            ? '로그인한 몰에서 PTP 확장 아이콘 → "🎯 보조 - 스크랩 대상 직접지정"을 눌러 실행하세요.'
                            : '열려있는 몰 탭을 찾지 못했습니다 — 몰 탭에서 확장 아이콘 → 팝업의 "🎯 보조 - 스크랩 대상 직접지정"을 클릭하세요.')
                        }
                      }} disabled={pickerBusy}
                        className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                        🎯 스크랩 대상 직접지정
                        <span className="ml-1 text-red-600 text-[10px] font-extrabold align-super">PTP</span>
                      </button>
                    )
                  ) : (
                    // 창을 닫으면(패널의 ✕) 다시 저절로 뜨지 않는다 — 다시 지정하려면 이 버튼을 다시 눌러야
                    // 한다(자동 재주입을 없앤 것과 맞물린 설계, lib/scraper.ts 참고). 그래서 "종료" 버튼이
                    // 따로 없고, 이 버튼 하나로 몇 번이든 다시 열 수 있다.
                    <button onClick={handleStartPicker} disabled={pickerBusy}
                      className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                      🎯 스크랩 대상 직접지정
                    </button>
                  )}
                </div>
              )}
              {/* 위 버튼들(AI모드/미리보기/직접지정)은 항상 눌러야 하니 그대로 두고, 아래 결과 내용만
                  접는다 — Mall 선택 등과 달리 이 카드는 "실행"과 "결과 보기"가 한 카드에 같이 있다. */}
              <button onClick={() => setPreviewCardCollapsed(v => !v)}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                {previewCardCollapsed ? '▼ 펼치기' : '▲ 접기'}
              </button>
            </div>
          </div>

          {previewResumeNotice && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">⚠ {previewResumeNotice}</p>
          )}

          {!previewCardCollapsed && <>
          {mallMode === 'devmode' && (
            // 예전엔 "이 버튼들이 결과를 바로 가져오지 않는다"고 4개 버튼을 뭉뚱그려 경고했는데, 실제로는
            // 동시 처리/AI모드는 진짜 설정값이라 이 화면에서 누르는 즉시 저장·적용된다 — 몰 탭 확장이
            // 필요한 건 미리보기/직접지정 결과를 "채우는" 것뿐이다. 뭉뚱그린 경고가 설정 버튼까지 "여기선
            // 안 되는 것"처럼 보이게 해 헷갈린다는 지적(2026-08-22)으로, 그 둘만 콕 집어 경고하게 좁혔다.
            // 한때 sendExtensionAction(externally_connectable)으로 몰 탭이 열려있으면 자동 실행되기도
            // 했는데, 그 기능을 만든 버전이 크롬에서 확장이 원인 불명으로 사라지는 문제와 시점이 겹쳐
            // 되돌렸다(!specifications/manual-login-required-malls.md 참고) — 지금은 자동 실행이 전혀
            // 안 되므로, "될 수도 있다"는 문구 대신 항상 수동으로 진행해야 한다고 명확히 안내한다
            // (2026-08-22, 자동 실행을 기대했다가 아무 반응이 없어 헷갈린다는 지적으로 재수정).
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ <DevModeLocationBadge where="mall" />&quot;🔍 스크랩 미리보기&quot;와 &quot;🎯 스크랩 대상 직접지정&quot;은 여기서
              눌러도 자동으로 실행되지 않습니다 — 몰 탭에서 PTP 확장프로그램을 직접 실행해야 합니다
              (확장 아이콘 클릭 → 실제 실행 버튼, 위 &quot;🧩 개발자모드 스크랩 방법&quot; 참고). 여기 버튼은
              몰 탭이 없으면 새로 열어주는 것과 진행 상태 표시만 맡습니다.
            </p>
          )}

          {sessionExpiredWarning && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ 로그인 세션이 끊긴 상태로 미리보기가 된 것 같습니다 — 로그인 창을 다시 열었으니, 그 창에서
              로그인 후 &quot;로그인 확인&quot;을 누르고 미리보기를 다시 시도해주세요.
            </p>
          )}

          {noProductsFoundWarning && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ 선택한 카테고리에서 상품을 하나도 찾지 못했습니다 — 로그인 세션 문제는 아닌 것 같지만, 이
              몰만의 다른 접근 제한(예: 회원 등급별 카테고리 제한)이거나 실제로 상품이 없는 카테고리일 수
              있습니다. 몰 탭에서 그 카테고리가 정상적으로 보이는지 직접 확인해보세요.
            </p>
          )}

          {mallMode === 'devmode' && previewLoading && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              🔍 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭의 상품 상세 페이지에서 확장 아이콘(팝업의 &quot;🔍 스크랩 미리보기 - (카테선택)&quot;)
              또는 우클릭 메뉴를 눌러주세요. 실행하면 몇 초 안에 아래에 결과가 나타납니다.
            </p>
          )}

          {pickerActive && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              {mallMode === 'devmode'
                ? <>🎯 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭에서 확장 아이콘(팝업의 &quot;🎯 보조 - 스크랩 대상 직접지정&quot; 또는
                    우클릭 &quot;PTP 스크랩 대상 직접지정&quot;)을 눌러 그 탭에 뜨는 패널에서 값을 클릭해 지정하세요.</>
                : <>🎯 로그인 창에 뜬 &quot;PTP 스크랩 대상 직접지정&quot; 패널에서 값을 클릭하거나, 패널의 목록에서
                    바로 값을 입력해 지정하세요.</>}
              {Object.keys(pickerRules).length > 0 && ` — 지금까지 ${Object.keys(pickerRules).length}개 지정됨`}.
              다 되면 (몰 탭에 뜬) 패널의 ✕로 닫으면 되고, 지정한 값은 그대로 저장됩니다. 다시 열려면 위
              &quot;스크랩 대상 직접지정&quot; 버튼을 다시 누르세요.
            </p>
          )}

          {mallMode === 'normal' && !canPreview && (
            <p className="text-xs text-gray-400">시작 URL 또는 카테고리 목록을 입력하면 카테고리 내 상품 개수와 첫 상품 페이지를 바로 확인할 수 있습니다.</p>
          )}

          {/* 몰 구조분석/카테고리 불러오기와 같은 패턴 — 결과가 나올 자리에 같은 모양의 스켈레톤을 먼저
              보여주고, 도착하면 그 자리에 그대로 채워진다(사용자 요청, 2026-08-16). previewResult가 이미
              (일반모드의 "먼저 뽑아둔 상품 1건" 조기 표시처럼) 도착해있으면 로딩 중이어도 스켈레톤 대신
              그 결과를 바로 보여준다 — 카테고리 개수 집계만 아직 도는 중일 수 있어서다. */}
          {previewLoading && !previewResult && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                {/* devmode는 previewLoading 중이라도 확장이 실제로 chrome.debugger를 붙여 캡처를 시작하기
                    (devPreviewCapturing, preview-progress 폴링) 전까지는 "실제로 뭔가 도는 중"이 아니다 —
                    사용자가 몰 탭에서 확장을 눌러야만 그때부터 작업이 시작된다. 뱅뱅 도는 스피너가 대기
                    중에도 계속 보여 "지금 작업 중"으로 오해시킨다는 지적(2026-09-05)으로, 실제로 시작된
                    뒤에만 스피너를 돌린다. */}
                <span className={`text-sm leading-none ${mallMode === 'devmode' && !devPreviewCapturing ? '' : 'animate-spin'}`}>
                  {mallMode === 'devmode' && !devPreviewCapturing ? '⏳' : '🔄'}
                </span>
                <span className="text-xs font-semibold text-gray-500">
                  {mallMode === 'devmode'
                    ? (devPreviewCapturing
                      ? (devPreviewProgress ? `카테고리 확인 중입니다... (${devPreviewProgress.done}/${devPreviewProgress.total})` : '몰 탭에서 상품 페이지를 캡처하는 중입니다...')
                      : '로그인한 몰에서 PTP 확장 아이콘 → "🔍 스크랩 미리보기 - (카테선택)"을 눌러 실행하세요.')
                    : previewProgress ? `카테고리 확인 중입니다... (${previewProgress.done}/${previewProgress.total})` : '상품 페이지를 확인하는 중입니다...'}
                </span>
              </div>
              <div className="p-3 flex gap-3 border-b border-gray-100 animate-pulse">
                <div className="w-20 h-20 rounded-xl bg-gray-100 shrink-0" />
                <div className="flex-1 min-w-0 space-y-2 py-1">
                  <div className="h-3 w-2/5 bg-gray-100 rounded" />
                  <div className="h-2.5 w-4/5 bg-gray-100 rounded" />
                  <div className="h-2.5 w-3/5 bg-gray-100 rounded" />
                </div>
              </div>
              <div className="p-3 flex gap-4 animate-pulse">
                {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-2.5 flex-1 bg-gray-100 rounded" />)}
              </div>
            </div>
          )}

          {/* 상품 개수를 문장 안에 묻어두지 않고 "발견된 카테고리 N개" 배지와 같은 방식으로 눈에 띄게
              — 사용자 요청, 2026-08-29. */}
          {previewTotal !== null && (
            <div className="mb-2">
              {/* "발견된 카테고리 N개" 배지와 완전히 같은 디자인으로 맞춘다(사용자 요청, 2026-08-29) —
                  0개일 때의 경고는 배지 색을 따로 바꾸는 대신, 옆/아래 보조문구(rose 텍스트)가 전담한다.
                  중복제거 안내는 배지 오른쪽에 나란히 둔다(사용자 요청, 2026-08-29). */}
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-bold text-teal-800 bg-teal-100 rounded-lg px-3 py-1.5 inline-block">
                  🔍 스크랩 대상 상품 {previewTotal}개{categoryCounts.some(c => c.truncated) && ' 이상'}
                </p>
                {/* devmode 미리보기는 화면을 안 보고 있어도(몰 탭 확장에서 바로 실행) 끝날 수 있어, 진행
                    중 표시(devPreviewProgress)를 못 봤을 수 있다 — 결과에 서버가 같이 저장해둔 소요시간을
                    보여줘 "실제로 얼마나 걸렸는지"는 항상 확인 가능하게 한다(사용자 요청, 2026-09-06). */}
                {mallMode === 'devmode' && devPreviewElapsedSec != null && (
                  <span className="text-xs text-gray-400">⏱ 완료까지 {formatElapsedSeconds(devPreviewElapsedSec)} 걸림</span>
                )}
                {/* 이 총계는 카테고리별로 각자 센 값을 그냥 더한 것이라, 대분류와 그 하위 카테고리를 함께
                    선택한 경우처럼 서로 겹치는 카테고리가 있으면 같은 상품이 중복으로 더해진다 — 실제
                    스크랩 개수(URL 기준 중복 제거)보다 크게 나올 수 있다는 걸 바로 옆에서 알려준다(사용자
                    실사용 확인, 2026-08-29 — 미리보기 21,752개 vs 실제 스크랩 목표 6,225개). 카테고리가
                    하나뿐이면 겹칠 대상 자체가 없어 표시하지 않는다("정확한 총 개수 확인" 버튼과 같은 조건). */}
                {categoryCounts.length > 1 && (
                  <p className="text-xs text-amber-600">
                    ⚠ 미리보기한 상품개수는 중복제거 전입니다. 아래 &quot;정확한 총 개수 확인(중복 제거)&quot;으로 실수량을 확인하세요.
                  </p>
                )}
              </div>
              {(previewTotal === 0 || categoryCounts.some(c => c.truncated)) && (
                <p className="text-xs text-gray-600 mt-1">
                  {previewTotal === 0 && <span className="text-rose-500">(매칭되는 상품 링크가 없습니다. 셀렉터나 시작 URL을 확인해주세요.)</span>}
                  {categoryCounts.some(c => c.truncated) && (
                    <span className="text-amber-600"> (일부 카테고리는 확인 상한에 도달해 최소치만 확인됨 — 아래 개수별 &quot;이상&quot; 표시 참고)</span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* 위 총계는 카테고리별로 각자 세서 더한 값이라, "가격대별"처럼 서로 겹치는 분류를 여러 개
              선택하면 실제보다 많게 나올 수 있다 — 정확히 몇 개가 스크랩될지는 실제 스크랩과 같은 방식
              (URL을 모아 중복 제거)으로만 알 수 있어 느릴 수 있으므로 자동으로 하지 않고 버튼으로 둔다
              (사용자 요청, 2026-08-17). 원래는 "카테고리 간 중복 제거"가 목적이라 카테고리 2개 이상일
              때만 노출했는데, 카테고리 1개만 선택해도 그 미리보기 개수 자체가 확인 상한(PREVIEW_PAGE_BUDGET)에
              걸려 "N개 이상"으로만 나올 수 있어 실제 개수가 궁금할 수 있다(사용자 요청, 2026-09-16) —
              중복 제거 여부와 무관하게 카테고리가 1개 이상이면 항상 노출한다. */}
          {categoryCounts.length >= 1 && (
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <button type="button" onClick={handleCheckExactTotal} disabled={exactTotalLoading}
                className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-sm font-bold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {exactTotalLoading ? '정확히 세는 중...' : categoryCounts.length > 1 ? '🎯 정확한 총 개수 확인(중복 제거)' : '🎯 정확한 개수 확인'}
              </button>
              {exactTotalLoading && (
                <button type="button" onClick={handleStopExactTotal}
                  className="px-3 py-1 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-xs font-semibold rounded-full transition-colors">
                  ⏹ 중지
                </button>
              )}
              {exactTotal && (
                <span className="text-xs text-gray-600">
                  → 실제로는 정확히 <strong>{exactTotal.total.toLocaleString()}</strong>개
                  {categoryCounts.length > 1 && '(중복 제거)'}
                  {exactTotal.needsLogin && <span className="text-amber-600"> ⚠ 로그인 세션이 끊긴 상태로 확인된 것 같습니다</span>}
                </span>
              )}
            </div>
          )}

          {/* 이 상품을 **어느 카테고리에서, 어떤 정렬로** 뽑았는지 — 없으면 사용자는 자기가 고른
              카테고리의 상품을 보고 있다고 오해한다(사용자 지적, 2026-09-13: "왜 다른 카테고리를
              봤는지"). 첫 카테고리가 비어 조용히 갈아탄 경우와 정렬 클릭이 실패한 경우를 분명히 알린다. */}
          {previewResult && previewSource && mallMode === 'normal' && (
            <div className={`mt-2 text-xs rounded-lg px-3 py-2 ${previewSource.switchedReason || previewSource.sortClick?.applied === false ? 'text-amber-800 bg-amber-50' : 'text-gray-600 bg-gray-50'}`}>
              <p>
                <span className="font-medium">표본 출처</span> —{' '}
                <span title={previewSource.url}>{shortenCategoryUrlForDisplay(previewSource.url)}</span>
                {previewSource.sortClick && (
                  previewSource.sortClick.applied
                    ? <span className="text-emerald-700">{` · 정렬 "${previewSource.sortClick.clickText}" 적용됨`}</span>
                    : <span className="text-amber-700">{` · ⚠ 정렬 "${previewSource.sortClick.clickText}"을 화면에서 못 찾아 기본 정렬로 뽑음`}</span>
                )}
              </p>
              {previewSource.switchedReason && (
                <p className="mt-0.5">
                  ⚠ {previewSource.switchedReason} (고른 카테고리: <span title={previewSource.requestedUrl}>{shortenCategoryUrlForDisplay(previewSource.requestedUrl)}</span>)
                </p>
              )}
            </div>
          )}
          {previewResult && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              {mallMode === 'normal' && (
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500 flex items-center justify-between gap-2">
                  <span className="truncate" title={previewResult.sourceUrl}>{decodeUrlForDisplay(previewResult.sourceUrl)}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => handleOpenItem(previewResult.sourceUrl)} className="text-teal-500 hover:underline">
                      열기 ↗
                    </button>
                  </div>
                </div>
              )}
              <div className="p-3 flex gap-3 border-b border-gray-100">
                {previewResult.product.thumbnail_urls.length > 0 && (
                  <div className="flex gap-1 shrink-0 max-w-[280px] overflow-x-auto">
                    {previewResult.product.thumbnail_urls.map((src, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={src} alt="" className="w-20 h-20 object-cover rounded-xl border border-gray-100" />
                    ))}
                  </div>
                )}
                <div className="flex-1 min-w-0 text-xs space-y-1">
                  <div className="font-semibold text-gray-800 text-sm truncate">
                    {previewResult.product.name || <span className="text-rose-500">상품명을 찾지 못했습니다</span>}
                  </div>
                  {previewResult.product.description && (
                    <div className="text-gray-400 line-clamp-2">{previewResult.product.description}</div>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse whitespace-nowrap">
                  {(() => {
                    // 옵션1~3은 기준 테이블 컬럼으로 이미 다뤄지니(위 masterOrderedKeys), 그 뒤에 남는
                    // 옵션(4번째부터)만 별도 컬럼으로 덧붙인다.
                    const extraOptions = previewResult.product.options.slice(3)
                    const registeredLabelSet = new Set(masterOrderedKeys.map(k => registryLabels.get(k)).filter(Boolean))
                    const extraCustom = Object.entries(previewResult.product.custom_fields || {})
                      .filter(([label]) => label in pickerRules && !masterOrderedKeys.includes(label) && !registeredLabelSet.has(label))
                    return (
                      <>
                        <thead className="bg-gray-50">
                          <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                            {masterOrderedKeys.map((key, i) => (
                              <th key={key} className={`px-3 py-2 text-left ${i === 0 ? 'sticky left-0 z-10 bg-gray-50' : ''}`}>
                                {registryLabels.get(key) || fixedFieldLabel.get(key) || key}
                              </th>
                            ))}
                            {extraOptions.map((o, i) => <th key={`opt-${i}`} className="px-3 py-2 text-left">{o.name}</th>)}
                            <th className="px-3 py-2 text-left">상품요약정보</th>
                            <th className="px-3 py-2 text-left">영문상품명</th>
                            {extraCustom.map(([label]) => <th key={label} className="px-3 py-2 text-left">🎯 {label}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            {masterOrderedKeys.map((key, i) => {
                              const value = previewValueFor(previewResult.product, previewResult.sourceUrl, key, registryLabels)
                              return (
                                <td key={key}
                                  className={`px-3 py-2 text-gray-700 max-w-[200px] truncate ${i === 0 ? 'sticky left-0 z-[1] bg-white' : ''}`}
                                  title={value}>
                                  {/* product_url만 클릭 가능하게 — 나머지 컬럼은 평문 값이라 여기 값이 진짜
                                      URL임을 확신할 수 있는 유일한 필드다(사용자 요청, 2026-09-09). 일반
                                      <a href target="_blank">로 새 탭에 열면 로그인 안 된 브라우저 프로필로
                                      열려 이 몰(로그인 필수)은 무용지물이다 — 아래 "열기 ↗" 링크와 같은
                                      handleOpenItem을 그대로 써서, 개발자모드는 이미 로그인해둔 실제
                                      크롬 창에 새 탭으로 열리게 한다(사용자 요청, 2026-09-09 — "여기도
                                      로그인한 창에서 열리게 해"). */}
                                  {key === 'product_url' && value !== '-'
                                    ? <button type="button" onClick={() => handleOpenItem(value)} className="text-teal-500 hover:underline text-left">{value}</button>
                                    : value}
                                </td>
                              )
                            })}
                            {extraOptions.map((o, i) => (
                              <td key={`opt-${i}`} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={o.values.join(', ')}>
                                {o.values.join(', ')}
                              </td>
                            ))}
                            <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={previewResult.product.summary_info}>
                              {previewResult.product.summary_info || '-'}
                            </td>
                            <td className="px-3 py-2 text-gray-700 max-w-[160px] truncate" title={previewResult.product.english_name}>
                              {previewResult.product.english_name || '-'}
                            </td>
                            {extraCustom.map(([label, value]) => (
                              <td key={label} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={value}>
                                {value}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </>
                    )
                  })()}
                </table>
              </div>
              {previewResult.product.detail_text && (
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="text-gray-400">상세페이지 텍스트: </span>
                  <span className="line-clamp-3">{previewResult.product.detail_text}</span>
                </div>
              )}
              {(() => {
                // 위 컬럼(기준 마스터테이블 순서로 이미 보여준 것들)에 이미 나온 라벨은 여기서 또
                // 보여주지 않는다 — 라벨 문구가 완전히 같은 경우(카테고리/상품명 등)뿐 아니라, 몰 페이지
                // 원문 라벨이 컬럼 라벨과 다르게 적혀 있어도(예: "판매가" vs "규제판가") 같은 개념이면
                // CLAIMED_INFO_LABEL_RE로 함께 걸러낸다.
                const shownColumnLabels = new Set([
                  ...masterOrderedKeys.map(k => registryLabels.get(k) ?? fixedFieldLabel.get(k)).filter(Boolean),
                  '상품요약정보', '영문상품명',
                ])
                const remainingInfo = previewResult.product.extra_info
                  .filter(({ label }) => !shownColumnLabels.has(label) && !CLAIMED_INFO_LABEL_RE.test(label))
                return remainingInfo.length > 0 && (
                  <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                    <span className="text-gray-400">상품정보고시 전체: </span>
                    {remainingInfo.map(({ label, value }) => `${label}: ${value}`).join(' / ')}
                  </div>
                )
              })()}
              {(() => {
                // "상품정보고시 전체"가 이미 모든 라벨:값을 보여주므로, 거기 없는 라벨만 여기 추가로 보여준다
                // (안 그러면 커스텀 필드로 자동 저장된 값이 위 전체 목록과 그대로 겹쳐 중복 표시됐다).
                const extraInfoLabels = new Set(previewResult.product.extra_info.map(e => e.label))
                const otherCustom = Object.entries(previewResult.product.custom_fields || {})
                  .filter(([label]) => !(label in pickerRules) && !extraInfoLabels.has(label))
                return otherCustom.length > 0 && (
                  <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                    <span className="text-gray-400">그 외 자동 스캔된 정보: </span>
                    {otherCustom.map(([label, value]) => `${label}: ${value}`).join(' / ')}
                  </div>
                )
              })()}
            </div>
          )}

          {previewItems.length > 0 && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                나머지 {previewItems.length}개 (목록 페이지 기준 정보만 — 직접 열어보지 않아 빠릅니다)
              </div>
              {/* 아래 내용(상세 정보 등)이 더 잘 보이도록 목록은 2개 높이만 보여주고 나머지는 스크롤 처리 */}
              <div className="max-h-[124px] overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-2 py-2 text-left w-14 sticky left-0 z-20 bg-gray-50">이미지</th>
                      <th className="px-2 py-2 text-left">상품명</th>
                      <th className="px-2 py-2 text-left w-20">링크</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewItems.map(item => (
                      <tr key={item.url} className="group border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-2 py-1.5 sticky left-0 z-10 bg-white group-hover:bg-gray-50">
                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-gray-100">
                            {item.thumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-300">-</div>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-gray-700 truncate max-w-[320px]" title={item.name}>{item.name || '-'}</td>
                        <td className="px-2 py-1.5">
                          <button type="button" onClick={() => handleOpenItem(item.url)} className="text-teal-500 hover:underline">열기 ↗</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          </>}

          {(() => {
            // 이 표는 예전엔 마지막 미리보기 응답(categoryCounts)만 그렸는데, 그러면 (1) 위 체크리스트에서
            // 선택했지만 아직 그 회차에 포함 안 된(또는 개발자모드에서 부분적으로만 확인된) 카테고리는
            // 행 자체가 안 보이고, (2) 순서도 응답 순서를 그대로 따라 체크리스트 순서와 어긋날 수 있었다
            // (사용자 지적, 2026-08-17: "위 카테고리불러오기에는 있는데 아래엔 없는 게 있다" + "순서도
            // 맞춰야지"). 지금 선택된 카테고리 전체를 기준으로 그리고, 개수를 아직 모르면 "미확인"으로
            // 행만 보여준다 — buildCategoryUrlsAndLimits와 반드시 같은 기준(categorySourceMode)을 써야
            // 한다: 이 표는 처음(2026-08-17) 체크리스트가 하나뿐이던 시절 categoryUrlsText만 보고 만들어진
            // 채로, "선택 가져오기(반복)" 모드가 생기고 좌우 카드로 나뉜(2026-08-26) 뒤에도 안 고쳐져
            // 있었다 — "선택 가져오기"로 실제 스크랩할 카테고리를 골라도, 이 표는 여전히 "전체 가져오기"
            // 탭에 예전에 남아있던(지금은 화면에 안 보이는) 목록을 그대로 보여줘 카테고리도 개수도 전혀
            // 안 맞는 것처럼 보였다(실사용 확인, 2026-08-27 — 오토카필: 실제로 고른 카테고리 대신 예전
            // 자동탐지 결과가 "미확인"인 채로 표시됨).
            const selectedHrefs = activeCategoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
            if (!selectedHrefs.length) return null
            const categoryTextByHref = new Map(categories.map(c => [c.href, c.text]))
            // "정확한 총 개수 확인(중복 제거)"를 눌러야만 채워진다 — categoryCountByHref와 같은 키(href)로
            // 매칭한다(2026-08-25, 미리보기 총합과 실제 스크랩 개수가 다른 이유를 카테고리별로 보여달라는
            // 요청 — lib/scraper.ts의 countCategoryOverlap 참고).
            const exactOverlapByUrl = new Map((exactTotal?.categories || []).map(c => [c.url, c]))
            type Row = { url: string; label: string; count: number | null; truncated: boolean; duplicateCount: number | null }
            const rows: Row[] = selectedHrefs.map(href => {
              // 개수/절단 여부는 이번 세션에 방금 미리보기를 돌린 값(categoryCountByHref)만 쓴다 — 서버에
              // 저장된 예전 기록(categoryInfo)을 값으로 대신 채우면, 미리보기를 아직 안 돌렸는데도 마치
              // 방금 돌린 결과처럼 보여 혼동을 준다는 지적(2026-08-22)으로 뺐다. 라벨(카테고리 이름)만은
              // 예전 기록에서 가져와도 괜찮다 — 아직 미확인이어도 이름 정도는 미리 보여주는 게 유용하다.
              // categoryCountByHref/categoryInfo/exactOverlapByUrl은 전부 실제 요청 URL(정렬 적용 후)
              // 기준으로 쌓이므로, 이 카테고리에 정렬을 지정해뒀으면 sortedCategoryUrl로 찾아야 방금
              // 확인한 값을 "미확인"으로 놓치지 않는다(사용자 지적, 2026-09-06).
              const resolvedUrl = sortedCategoryUrl(href)
              const live = categoryCountByHref.get(resolvedUrl)
              const info = categoryInfo[resolvedUrl]
              // live/info의 label이 URL 그 자체와 같으면(countCategoryProductsOnce가 화면에서 카테고리명을
              // 못 읽어 categoryUrl로 대신 채운 경우 — "몰 카테고리 선택 가져오기" 표의 categoryName 주석
              // 참고, 2026-09-26 도매창고 실사용 확인) 진짜 이름으로 보지 않는다 — categories(몰구조분석/
              // "전체 가져오기")가 이미 아는 진짜 이름(categoryTextByHref)이 있는데도 URL이 그걸 가려버렸다.
              const isRealLabel = (l: string | undefined) => !!l && l !== resolvedUrl && l !== href
              return {
                url: href,
                label: (isRealLabel(live?.label) ? live!.label : undefined)
                  || (isRealLabel(info?.label) ? info!.label : undefined)
                  || categoryTextByHref.get(href) || href,
                count: live?.count ?? null,
                truncated: live?.truncated ?? false,
                duplicateCount: exactOverlapByUrl.get(resolvedUrl)?.duplicateCount ?? null,
              }
            })
            // 전부 미확인(아직 "스크랩 미리보기"를 한 번도 안 돌림)이면 표 자체를 숨긴다 — 개수 확인 전엔
            // "미확인"만 잔뜩 나열해봐야 어차피 미리보기를 돌려야 채워지는 자리라 노이즈일 뿐이라는 지적
            // (2026-09-05, 사용자 요청). 하나라도 실제 개수가 있으면(부분적으로만 돌렸어도) 계속 보여줘
            // 나머지 미확인 행과 비교해볼 수 있게 한다.
            if (rows.every(r => r.count == null)) return null
            // label은 "최상위 > 하위" 형태(lib/scraper.ts가 path.join(' > ')로 만듦) — 최상위 기준으로
            // 묶는다. 아직 미확인이라 label이 체크리스트 텍스트(하위 구분 없음)뿐인 행은 그 텍스트 전체를
            // 최상위로 본다. 최상위 하나에 하위가 1개뿐이면 굳이 접을 필요 없어 그대로 보여준다.
            const groups: {
              key: string; total: number; truncated: boolean; unknownCount: number; items: Row[]
              duplicateTotal: number; duplicateUnknownCount: number
            }[] = []
            const groupIndexByKey = new Map<string, number>()
            for (const r of rows) {
              const top = r.label.split(' > ')[0]
              let idx = groupIndexByKey.get(top)
              if (idx === undefined) {
                idx = groups.length
                groupIndexByKey.set(top, idx)
                groups.push({ key: top, total: 0, truncated: false, unknownCount: 0, items: [], duplicateTotal: 0, duplicateUnknownCount: 0 })
              }
              if (r.count == null) groups[idx].unknownCount++
              else groups[idx].total += r.count
              if (r.duplicateCount == null) groups[idx].duplicateUnknownCount++
              else groups[idx].duplicateTotal += r.duplicateCount
              groups[idx].truncated = groups[idx].truncated || !!r.truncated
              groups[idx].items.push(r)
            }
            // truncated면 상한(lib/scraper.ts의 AUTO_PAGINATION_CAP)에 도달할 때까지도 새 상품이
            // 계속 나와 멈춘 것이라 count가 정확한 총합이 아니라 최소치다(CategoryCount.truncated
            // 참고) — "N개 이상"으로 정직하게 표시한다.
            const countLabel = (r: { count: number | null; truncated?: boolean }) =>
              r.count == null ? '미확인' : `${r.count.toLocaleString()}개${r.truncated ? ' 이상' : ''}`
            const duplicateLabel = (n: number | null) => n == null ? '-' : n === 0 ? '없음' : `${n.toLocaleString()}개 중복`
            const truncatedTitle = '확인 상한에 도달할 때까지도 새 상품이 계속 나와 멈췄습니다 — 실제로는 더 많을 수 있습니다.'
            const unconfirmedTitle = '아직 이 카테고리로 "스크랩 미리보기"를 돌리지 않아 개수를 모릅니다.'
            const duplicateUnknownTitle = '"정확한 총 개수 확인(중복 제거)"를 눌러야 이 카테고리의 중복 개수를 알 수 있습니다.'
            const duplicateTitle = '다른 선택 카테고리에도 이미 있는 상품 수 — 실제 스크랩 때 이만큼은 새로 추가되지 않습니다.'
            return (
              <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                  카테고리별 상품 개수 (목록 페이지 기준 — 상세페이지는 열어보지 않아 빠릅니다) — 위 체크리스트에서 선택한 카테고리 전체를 같은 순서로 보여줍니다.
                  &quot;중복&quot; 열은 &quot;🎯 정확한 총 개수 확인(중복 제거)&quot;을 눌러야 채워집니다 — 다른 선택 카테고리와 겹쳐 실제로는 새로 스크랩되지 않는 상품 수입니다.
                </div>
                {/* 세로로 드래그해서 원하는 높이만큼 늘려볼 수 있게(resize-y) — 행이 많은 몰에서 고정
                    높이/스크롤만으론 답답하다는 피드백. */}
                <div className="h-[200px] min-h-[80px] max-h-[70vh] resize-y overflow-y-auto">
                  <table className="w-full text-xs border-collapse table-fixed">
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      {/* 헤더 오른쪽 경계를 세로로 드래그해 폭을 조절한다(엑셀 등 다른 그리드와 같은
                          방식, 사용자 요청 2026-09-05) — table-fixed라 이 헤더 폭이 그대로 컬럼 폭이
                          된다. 마지막 컬럼(중복)은 오른쪽에 더 늘릴 이웃 컬럼이 없어 손잡이를 안 둔다. */}
                      <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                        <th className="relative px-3 py-2 text-left" style={{ width: categoryCountColWidths.category }}>
                          카테고리
                          <div onMouseDown={startCategoryCountColResize('category')}
                            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-teal-400/70 active:bg-teal-500" />
                        </th>
                        <th className="relative px-3 py-2 text-right" style={{ width: categoryCountColWidths.count }}>
                          개수
                          <div onMouseDown={startCategoryCountColResize('count')}
                            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-teal-400/70 active:bg-teal-500" />
                        </th>
                        <th className="px-3 py-2 text-right" style={{ width: categoryCountColWidths.duplicate }}>중복</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map(g => {
                        if (g.items.length === 1) {
                          const r = g.items[0]
                          return (
                            <tr key={r.url} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                              <td className="px-3 py-1.5 truncate max-w-[320px]" title={r.url}>
                                <button type="button" onClick={() => handleOpenItem(r.url)} className="text-teal-500 hover:underline text-left">{r.label}</button>
                              </td>
                              <td className={`px-3 py-1.5 text-right ${r.count == null ? 'text-gray-400' : 'text-gray-700'}`}
                                title={r.count == null ? unconfirmedTitle : r.truncated ? truncatedTitle : undefined}>
                                {countLabel(r)}
                              </td>
                              <td className={`px-3 py-1.5 text-right ${!r.duplicateCount ? 'text-gray-400' : 'text-amber-600 font-semibold'}`}
                                title={r.duplicateCount == null ? duplicateUnknownTitle : duplicateTitle}>
                                {duplicateLabel(r.duplicateCount)}
                              </td>
                            </tr>
                          )
                        }
                        const collapsed = collapsedCategoryGroups.has(g.key)
                        return (
                          <Fragment key={g.key}>
                            <tr className="border-b border-gray-100 bg-gray-50/60 hover:bg-gray-100">
                              <td className="px-3 py-1.5 font-semibold text-gray-700">
                                <button type="button" onClick={() => setCollapsedCategoryGroups(prev => {
                                  const next = new Set(prev)
                                  if (next.has(g.key)) next.delete(g.key); else next.add(g.key)
                                  return next
                                })} className="hover:underline text-left">
                                  {collapsed ? '▸' : '▾'} {g.key} ({g.items.length}개 카테고리)
                                </button>
                              </td>
                              <td className="px-3 py-1.5 text-right text-gray-700 font-semibold" title={g.truncated ? truncatedTitle : undefined}>
                                {g.total.toLocaleString()}개{g.truncated ? ' 이상' : ''}{g.unknownCount > 0 && ` (+미확인 ${g.unknownCount}개)`}
                              </td>
                              <td className={`px-3 py-1.5 text-right font-semibold ${!g.duplicateTotal ? 'text-gray-400' : 'text-amber-600'}`}
                                title={g.duplicateUnknownCount > 0 ? duplicateUnknownTitle : duplicateTitle}>
                                {g.duplicateUnknownCount === g.items.length ? '-' : `${duplicateLabel(g.duplicateTotal)}${g.duplicateUnknownCount > 0 ? ` (+미확인 ${g.duplicateUnknownCount}개)` : ''}`}
                              </td>
                            </tr>
                            {!collapsed && g.items.map(r => (
                              <tr key={r.url} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                                <td className="pl-6 pr-3 py-1.5 truncate max-w-[320px]" title={r.url}>
                                  <button type="button" onClick={() => handleOpenItem(r.url)} className="text-teal-500 hover:underline text-left">
                                    {r.label.slice(g.key.length).replace(/^ > /, '') || r.label}
                                  </button>
                                </td>
                                <td className={`px-3 py-1.5 text-right ${r.count == null ? 'text-gray-400' : 'text-gray-700'}`}
                                  title={r.count == null ? unconfirmedTitle : r.truncated ? truncatedTitle : undefined}>
                                  {countLabel(r)}
                                </td>
                                <td className={`px-3 py-1.5 text-right ${!r.duplicateCount ? 'text-gray-400' : 'text-amber-600 font-semibold'}`}
                                  title={r.duplicateCount == null ? duplicateUnknownTitle : duplicateTitle}>
                                  {duplicateLabel(r.duplicateCount)}
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* 실행 버튼 — 개발자모드는 위 안내대로 사용자가 직접 브라우저/확장으로 시작하므로 "시작" 버튼이
          없고, 진행 중일 때 "중지"만 제공한다(일반모드와 동일한 버튼을 공유). */}
      {selectedSite && status === 'running' ? (
        <button onClick={handleStop} disabled={stopping}
          className="w-full py-3 rounded-2xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600 disabled:opacity-50 transition-colors">
          {stopping ? '중지 처리 중...' : '⏸ 스크래핑 중지'}
        </button>
      ) : mallMode === 'normal' ? (
        <>
          {/* canStart가 false인 이유(로그인 미확인)를 버튼 비활성화만으로 두면 "눌러도 반응이 없다"로만
              보인다 — 특히 loginStep은 이 컴포넌트가 새로 마운트될 때마다(탭 전환, 서버 재시작 등)
              초기화되는 로컬 상태라, 이전에 실제로 로그인해뒀어도 다시 확인 없이는 버튼이 계속 막혀있다.
              카테고리/미리보기까지는 로그인 없이도 동작해(withContext가 필요하면 알아서 헤드리스로 새
              세션을 연다) 여기까지 온 뒤에야 막히는 경우가 흔해, 버튼 바로 위에 이유를 명시한다. */}
          {!canStart && needsLogin && (
            <p className="text-xs text-amber-600 text-center mb-2">
              ⚠ 로그인 확인이 필요합니다 — 위 &quot;로그인 창 열기&quot; → &quot;로그인 확인&quot;을 먼저 진행해주세요.
            </p>
          )}
          {status === 'idle' ? (
            <>
              <label className="flex items-center gap-2 mb-2 text-xs text-gray-500 cursor-pointer select-none"
                title="꺼두면 예전 동작대로 이미 상품마스터에 있는 상품(source_url 기준)은 건너뛴다 — 신상품만 빠르게 받고 싶을 때 유용하다.">
                <input type="checkbox" checked={includeAlreadyScraped} onChange={e => setIncludeAlreadyScraped(e.target.checked)}
                  className="w-3.5 h-3.5 accent-teal-500" />
                이미 스크랩한 상품 포함 (위에서 선택한 카테고리 전체를 대상으로 다시 수집)
              </label>
              <button onClick={() => handleStart()} disabled={!canStart}
                title={!canStart && needsLogin ? '로그인 확인이 필요합니다' : undefined}
                className="w-full py-3 rounded-2xl font-semibold text-sm bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                스크래핑 시작
              </button>
            </>
          ) : (
            // 중지됨/오류/완료 뒤에는 "이어서"와 "처음부터"의 의도가 갈리므로, 체크박스 하나로 뭉뚱그리지
            // 않고 버튼 두 개로 바로 확정한다(사용자 요청, 2026-08-25 — "이어서 하기 외에 처음부터 다시
            // 하기 기능도"). 각 버튼이 includeAlreadyScraped를 명시적으로 override해서 보낸다.
            <div className="flex gap-2">
              <button onClick={() => handleStart(false)} disabled={!canStart}
                title={!canStart && needsLogin ? '로그인 확인이 필요합니다' : '이미 상품마스터에 있는 상품(source_url 기준)은 건너뛰고, 남은 것만 이어서 받습니다.'}
                className="flex-1 py-3 rounded-2xl font-semibold text-sm bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                ▶ 이어서 하기 (기존 상품 제외)
              </button>
              <button onClick={() => handleStart(true)} disabled={!canStart}
                title={!canStart && needsLogin ? '로그인 확인이 필요합니다' : '위에서 선택한 카테고리 전체를 이미 스크랩한 상품까지 포함해 처음부터 다시 수집합니다.'}
                className="flex-1 py-3 rounded-2xl font-semibold text-sm bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                🔄 처음부터 다시 하기
              </button>
            </div>
          )}
        </>
      ) : (
        // 개발자모드는 실제 스크랩을 PTP가 아니라 사용자의 개인 크롬 확장이 몰 탭에서 직접 실행한다
        // (자동화 감지 회피) — 그래서 버튼이 있어야 할 자리를 통째로 비워두면 "버튼이 없어졌다/고장났다"로
        // 보인다는 지적(2026-08-17)이 있었다. 처음엔 안내 문구만 남겼는데, 일반모드와 똑같은 자리에
        // 똑같은 모양의 "스크래핑 시작" 버튼을 두고 — 미리보기/직접지정 버튼과 같은 방식으로 누르면
        // 실행하는 대신 어디서 눌러야 하는지 안내만 하도록 다시 바꿨다(2026-08-17 재지적). 진행 중
        // 표시는 이 버튼과 별개로 아래 "진행 상황" 카드가 이미 맡는다 — 개발자모드도 확장이 세션을 만들면
        // 5초 간격 폴링(checkForRunningSession)이 감지해 status를 'running'으로 바꾸고, 그 순간 이
        // 자리 자체가 위 "⏸ 스크래핑 중지" 버튼으로 자동 교체되며 그 카드의 롤링 아이콘(🔄)이 뜬다 —
        // 그때 awaitingDevScrapeStart도 같이 꺼진다(checkForRunningSession 근처 주석 참고). 자동실행을
        // 시도하던 sendExtensionAction('start', ...)은 제거했다 — extension-poc/manifest.json에
        // externally_connectable이 없어 항상 조용히 실패하고 있었다(다른 sendExtensionAction 호출부와
        // 같은 이유, 2026-09-05) — "🔍 몰 구조분석"과 같은 focus + 안내 + 강조 방식으로 통일한다.
        <button onClick={async () => {
          if (loginStep === 'none' && selectedSite) {
            await handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)
            showDevHint('몰 탭을 열었습니다 — 로그인 후 확장 아이콘 → 팝업의 "🔄 스크랩 시작"을 클릭하세요.')
          } else if (selectedSite) {
            const focused = await fetch('/api/scrape/login/focus', { method: 'POST' })
              .then(r => r.json()).then(d => !!d.ok).catch(() => false)
            showDevHint(focused
              ? '로그인한 몰에서 PTP 확장 아이콘 → "🔄 스크랩 시작"을 눌러 실행하세요.'
              : '열려있는 몰 탭을 찾지 못했습니다 — 몰 탭에서 확장 아이콘 → 팝업의 "🔄 스크랩 시작"을 클릭하세요.')
          }
          startAwaitingDevScrapeStart()
        }} className={`w-full py-3 rounded-2xl font-semibold text-sm transition-colors ${
          awaitingDevScrapeStart
            ? 'bg-amber-50 border border-amber-400 text-amber-700 hover:bg-amber-100 animate-pulse-glow-amber'
            : 'bg-teal-500 text-white hover:bg-teal-600'}`}>
          {/* 확장이 resolveSite에서 받은 excludeUrls로 이미 성공한 상품은 알아서 건너뛰므로(2026-08-22),
              이 라벨은 일반모드와 같은 문구로 그 사실을 알려준다 — 실제 "건너뛰기"는 클릭 하나로
              동일하게 동작하고 문구만 상황에 맞게 바뀐다. */}
          {awaitingDevScrapeStart ? '로그인한 몰에서 PTP 확장 실행'
            : status === 'stopped' || status === 'error' ? '이어서 스크랩하기 (기존 상품 제외)' : status === 'done' ? '✓ 스크래핑 완료 (다시 시작)' : '스크래핑 시작'}
        </button>
      )}

      {/* 진행 상황 */}
      {status !== 'idle' && (
        <div ref={progressSectionRef} className="mt-4 bg-white rounded-2xl border border-gray-200 p-5">
          <div className="grid grid-cols-3 items-center mb-3">
            <span className="text-sm font-semibold text-gray-700">진행 상황</span>
            {/* 상태 배지(특히 진행 중 스피너)는 가운데 열에 둬 항상 카드 정중앙에 오게 한다(사용자 요청,
                2026-08-25) — 옆 두 열(라벨/버튼) 폭이 서로 달라도 배지 위치가 한쪽으로 쏠리지 않는다. */}
            <span className={`text-sm font-semibold inline-flex items-center justify-center gap-1.5 ${statusColor[status]}`}>
              {status === 'running' && <span className="animate-spin leading-none" aria-hidden="true">🔄</span>}
              {statusLabel[status]}
            </span>
            <div className="flex items-center justify-end gap-3">
              {/* 중지된 세션도 그때까지 수집한 상품은 이미 저장돼 있으니, "완료"와 마찬가지로 바로 Raw
                  확인으로 넘어갈 수 있어야 한다 — 이어서 스크랩할지 여기서 끝낼지는 사용자 선택이라,
                  중지 상태에서도 이 버튼을 숨길 이유가 없다(2026-08-22, 사용자 요청). */}
              {(status === 'done' || status === 'stopped') && (
                <button onClick={() => openTab(PRODUCTS_LIST_TAB)}
                  className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full transition-colors">
                  → 스크랩 Raw 확인
                </button>
              )}
            </div>
          </div>
          {status === 'running' && (
            <div className="relative w-full bg-gray-100 rounded-full h-5 mb-3 overflow-hidden">
              <div className="bg-teal-500 h-5 rounded-full transition-all"
                style={{ width: progress.total > 0 ? `${Math.round(progress.saved / progress.total * 100)}%` : '10%' }} />
              {/* 개발자모드는 목록을 미리 다 세지 않고 그때그때 순회하며 저장하므로 progress.total(product_count)
                  이 끝까지 0으로 남는다 — 그렇다고 이 자리를 비워두면 실시간으로 늘어나는 saved 개수 자체가
                  화면 어디에도 안 보인다는 지적(2026-08-22: "PTP 상에서는 아무런 변화가 없는 상태야")으로,
                  total을 모를 때도 지금까지 저장된 개수만이라도 보여준다. */}
              {progress.total > 0 ? (
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-gray-700">
                  상품 {progress.saved} / {progress.total}개
                </span>
              ) : progress.saved > 0 && (
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-gray-700">
                  {/* 진짜 total(product_count)은 개발자모드에서 끝까지 0이라(위 주석), "스크랩 미리보기"가
                      미리 세어둔 previewTotal을 대신 참고값으로 보여준다 — 카테고리가 겹치면 중복이 포함돼
                      실제보다 클 수 있는 것도 그 배지와 같은 한계(사용자 요청, 2026-09-06). */}
                  상품 {progress.saved}개 수집됨{previewTotal != null && ` / 총 ${previewTotal}개`}
                </span>
              )}
            </div>
          )}
          {/* 상품 URL 수집(카테고리 목록 순회) 단계는 progress.total이 아직 0이라 막대 안에 보여줄 수량이
              없다 — collectProgress가 있으면(그 단계가 진행 중이라는 뜻) 그걸 먼저 보여준다. 수집완료/총
              수량은 이제 막대 안에 표시하므로, running 중엔 실패 건수만 아래에 별도로 보여준다. 완료 후
              (running이 아닐 때)는 막대가 사라지므로 최종 요약 문구를 그대로 유지한다. */}
          {status === 'running' && progress.total === 0 && collectProgress && collectProgress.total > 1 ? (
            <p className="text-sm text-gray-600">
              카테고리 목록 수집 중... <strong>{collectProgress.done}</strong> / {collectProgress.total}개 카테고리
              {liveElapsedMinutes !== null && <span className="text-gray-400"> · 진행 {liveElapsedMinutes}분째</span>}
            </p>
          ) : status !== 'running' ? (
            <p className="text-sm text-gray-600">
              상품 수집 완료: <strong>{progress.saved}</strong>개 {progress.total > 0 && `/ ${progress.total}개`}
              {progress.failedCount > 0 && <span className="text-rose-500"> · 실패 {progress.failedCount}개</span>}
              {/* "완료"뿐 아니라 "중지됨"에서도 재시도할 수 있어야 한다 — 카테고리가 많은 몰(예: 118개)은
                  한 번에 몇 시간씩 걸릴 수 있어, 그 전에 사용자가 직접 중지했을 때도 그때까지 쌓인 실패
                  건만 따로 재시도할 수 있어야 매번 처음부터 다시 돌릴 필요가 없다(사용자 요청,
                  2026-09-06). 실패 개수 바로 옆에 둬 한눈에 보이게 한다(사용자 요청 — 아래 성공목록 뒤에
                  있으니 안 보인다는 지적). running 중에는 안 보여준다 — 이 화면이 세션을 하나만 추적하는
                  구조라, 지금 도는 세션이 있는 채로 재시도를 누르면 그 결과로 받은 새 sessionId가 화면을
                  덮어써 원래 진행 상황을 잃는다. */}
              {(status === 'done' || status === 'stopped') && progress.failedCount > 0 && (
                <button onClick={handleRetryFailed} disabled={retrying}
                  title="목록에는 최근 200건까지만 보이지만, 재시도는 실패한 전체를 대상으로 합니다."
                  className="ml-2 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                  {retrying ? '재시도 중...' : `실패 ${progress.failedCount}개 재시도`}
                </button>
              )}
              {status === 'done' && elapsedMinutes !== null && <span className="text-gray-400"> · 소요시간 {elapsedMinutes}분</span>}
            </p>
          ) : progress.failedCount > 0 ? (
            <p className="text-sm text-rose-500">
              실패 {progress.failedCount}개
              {liveElapsedMinutes !== null && <span className="text-gray-400"> · 진행 {liveElapsedMinutes}분째</span>}
            </p>
          ) : liveElapsedMinutes !== null ? (
            <p className="text-sm text-gray-400">진행 {liveElapsedMinutes}분째</p>
          ) : null}

          {/* 적응형 동시성이 실제로 조정된 적이 있을 때만 보여준다 — 계속 1로 순차 처리됐다면(가장 흔한 경우)
              보여줄 내용이 없어 아예 렌더링하지 않는다("간략히" 확인 목적이라 평소엔 화면을 차지하지 않음). */}
          {concurrencyLog.length > 0 && (
            <div className="mt-2 text-xs text-gray-500">
              <button type="button" onClick={() => setConcurrencyLogOpen(v => !v)} className="hover:underline">
                ⚡ 동시 처리 최고 {Math.max(1, ...concurrencyLog.filter(e => e.reason === 'ramp_up').map(e => e.level))}개까지 사용
                {concurrencyLog.some(e => e.reason === 'block_detected') &&
                  ` · 차단 감지로 ${concurrencyLog.filter(e => e.reason === 'block_detected').length}회 낮춤`}
                {' '}{concurrencyLogOpen ? '▲' : '▼'}
              </button>
              {concurrencyLogOpen && (
                <ul className="mt-1 pl-4 space-y-0.5 max-h-32 overflow-y-auto">
                  {concurrencyLog.map((e, i) => (
                    <li key={i} className={e.reason === 'block_detected' ? 'text-amber-600' : 'text-gray-400'}>
                      {new Date(e.at).toLocaleTimeString()} — {e.reason === 'block_detected' ? `차단 감지 → 1개로 낮춤` : `${e.level}개로 상향`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 일반모드(PTP 자동화)인데 차단이 반복 감지되면(2회 이상) — 이 몰이 자동화 브라우저 자체를
              걸러내는 몰일 가능성이 높다는 뜻이라, 미리 묻는 대신 여기서 개발자모드 전환을 제안한다
              (mallMode 주석 참고, 2026-08-15). */}
          {mallMode === 'normal' && concurrencyLog.filter(e => e.reason === 'block_detected').length >= 2 && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
              <p className="text-xs text-amber-700">
                ⚠ 차단이 반복 감지됐습니다 — 이 몰이 자동화 브라우저를 걸러내는 몰일 수 있습니다. 개발자모드(크롬 확장)로 전환해보시겠어요?
              </p>
              <button type="button" onClick={() => handleChooseScrapeMode(true)} disabled={modeSaving}
                className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors shrink-0">
                🧩 개발자모드로 전환
              </button>
            </div>
          )}

          {/* 실패한 상품만 따로 모아, 실패 사유가 (마우스를 올려야 보이는 툴팁이 아니라) 바로 눈에 보이게 표시한다.
              개수(progress.failedCount)는 /api/scrape/status의 정확한 COUNT — 목록(failedItems)은
              /api/scrape/log가 최대 200건까지만 돌려주므로(성능), 총량이 그보다 많으면 개수만 맞고 목록은
              일부만 보일 수 있다(실패 건은 그 200건 안에 항상 먼저 채워지도록 이미 우선순위를 둠). */}
          {progress.failedCount > 0 && (
            <div className="mt-3 border border-rose-200 bg-rose-50 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-rose-600 border-b border-rose-200">
                ❌ 수집 실패 ({progress.failedCount}개) — 사유
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-rose-100">
                {failedItems.map(row => (
                  <div key={row.id} className="px-3 py-1.5 text-xs">
                    <p className="text-gray-600 truncate">{row.url}</p>
                    <p className="text-rose-500 truncate">{row.error || '알 수 없는 오류'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.successCount > 0 && (
            <div className="mt-3 border border-gray-100 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100">
                ✓ 수집 성공 ({progress.successCount}개{progress.successCount > successItems.length && `, 최근 스크래핑된 ${successItems.length}건만 아래에 표시함`})
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-gray-100">
                {successItems.map(row => (
                  <div key={row.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="text-emerald-600">✓</span>
                    <span className="text-gray-500 truncate flex-1">{row.url}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(status === 'error' || status === 'stopped') && (
            <>
              {progress.error && <p className="mt-2 text-xs text-rose-500 break-all">{progress.error}</p>}
              <button onClick={handleBackToSettings}
                className="mt-3 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
                ← 설정 화면으로 돌아가기
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
