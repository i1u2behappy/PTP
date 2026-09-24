// PTP Mall 관리에서 "크롬익스텐션-개발자모드"로 등록된 몰(PC인증 등으로 자동 로그인이 안 되는 몰)을
// 실제 로그인된 브라우저 안에서 자동으로 순회하며 스크랩한다. 특정 몰 전용이 아니라, 그렇게 등록된
// 몰이면 어디서든(도메인만 보고 PTP에 물어봐서) 그대로 동작하는 공용 확장이다.
// chrome.debugger는 --remote-debugging-* 명령줄 플래그와 달리 크롬의 "기본 프로필 금지" 제한을
// 받지 않아, 사용자가 실제로 로그인해둔 이 브라우저에서 그대로 동작한다.
//
// 사용법: 로그인된 상태로 상품 목록(카테고리) 페이지를 열고 이 확장 아이콘을 클릭하면,
// 그 페이지의 상품 링크를 전부 찾아 하나씩 방문 → 추출 → 서버로 전송 → 다음 페이지로 자동 진행한다.

importScripts('actions.js') // PTP_ACTIONS — popup.js와 공유하는 액션 이름 상수, actions.js 참고.

const PTP_ORIGIN = 'http://127.0.0.1:3000'
const INGEST_ENDPOINT = `${PTP_ORIGIN}/api/scrape/extension-ingest`
const RESOLVE_ENDPOINT = `${PTP_ORIGIN}/api/sites/resolve`
const SITE_API_BASE = `${PTP_ORIGIN}/api/sites`
const STOP_REQUESTED_ENDPOINT = `${PTP_ORIGIN}/api/scrape/stop-requested`
const PROGRESS_ENDPOINT = `${PTP_ORIGIN}/api/scrape/extension-progress`

/** "몰 구조분석"이 항상 오래 걸리는데 지금 뭘 하는지 알 방법이 없다는 지적(2026-08-22)으로, 이 확장이
 *  맡은 두 단계(카테고리 하위구조 확인/정렬 옵션 감지)의 진행 상황을 서버(lib/scraper.ts의
 *  setSiteLockDetail)에 남긴다 — PTP 화면이 이미 폴링 중인 site-lock-status가 그대로 실어보낸다. */
async function reportProfileProgress(siteId, detail) {
  await fetch(`${PTP_ORIGIN}/api/sites/${siteId}/profile-progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detail }),
  }).catch(() => {})
}
// 몰이 정한 기준이 아니라 이 확장이 세션 하나당 상품 수를 스스로 나눠 돌리던 내부 설계값이었다 — 사용자가
// 선택한 카테고리 전체를 한 번에 끝까지 스크랩하길 원해(2026-08-22) 상한을 없앤다(Infinity).
const MAX_PRODUCTS = Infinity
// collectCategoryLinks(미리보기 개수 집계 전용) 페이지 상한 — lib/scraper.ts의 AUTO_PAGINATION_CAP과
// 같은 이유로 50에서 한 번 올렸다가(2026-08-17: 걸스굽 "SOLD OUT"처럼 정말로 50페이지보다 큰 카테고리가
// 있으면 조용히 그 상한에서 잘려 실제보다 훨씬 적게 보고됨), 1000은 너무 높았다는 게 바로 재현됨
// (2026-08-17, 모자사러) — Node쪽(lib/scraper.ts)은 위젯 수식/지수+이분 탐색으로 1000이어도 몇 번만
// 열어보고 끝나지만, 이 확장은 그런 지름길이 없어 정말로 한 페이지씩 순회한다(페이지마다 throttle()로
// 1.2~2.4초씩 쉼) — 카테고리를 여러 개 선택해두면 그중 페이지가 많은 것 하나만 있어도 체감상 "멈춘 것
// 같다"는 신고로 이어질 만큼 오래 걸렸다. Node쪽 지름길이 없는 이 환경에 맞춰 훨씬 낮은 값으로 다시
// 내린다 — 원래 문제(SOLD OUT류 대형 카테고리 하한 노출)는 여전히 막아주면서, 최악의 경우에도
// 카테고리 하나당 몇 분 안에는 끝나게 한다.
const MAX_PREVIEW_PAGES = 150

let siteId = null
let extractionRules = {}
let sessionId = null
let running = false

/** 현재 탭의 도메인으로 PTP에 "이 몰이 몇 번 site냐"고 물어본다 — 몰마다 확장을 새로 만들지 않기 위함.
 * "스크랩 조정" 기능이 그 몰에 대해 학습해둔 추출 규칙(extractionRules)과, PTP 화면(일반모드와 같은 자리)
 * 의 AI모드 토글 상태(aiPreviewMode)/카테고리 불러오기 선택 목록(categoryUrls)도 같이 받아온다 — 확장은
 * PTP와 직접 연결돼 있지 않아(별도 실제 크롬 탭) 실행 시점마다 이 값들을 물어봐야 한다. */
// lib/scraper.ts의 LOGOUT_URL_RE와 반드시 같은 값을 유지한다(같은 코드를 두 곳에 두는 이유는
// NON_CATEGORY_TEXT_SRC와 동일 — Node 서버↔크롬 확장이 서로 import를 못 함). 개발자모드는 서버의
// 헤드리스 사본이 아니라 **사용자의 진짜 크롬**에서 이 URL들을 방문하므로, 로그아웃 링크가 카테고리로
// 한 번이라도 잘못 저장되면 사용자가 실제로 쓰던 로그인이 끊긴다 — 일반모드보다 피해가 크다.
// 서버 쪽은 저장 시점(scanCategoryMenu/scanCategoryMenuFromHtml)과 방문 직전
// (discoverCategoriesByVisitingLinks) 양쪽에서 거르는데, 확장에는 방문 직전 가드가 없었다.
const LOGOUT_URL_RE = /(^|[/_?&=.-])(logout|log-out|log_out|signout|sign-out|sign_out|logoff)([/_?&=.-]|$)/i

async function resolveSite(hostname) {
  const res = await fetch(`${RESOLVE_ENDPOINT}?host=${encodeURIComponent(hostname)}`)
  if (!res.ok) return null
  const data = await res.json()
  if (data.id == null) return null
  // 카테고리 목록은 받아오는 이 한 곳에서 걸러둔다 — runExpandCategories(하위구조 확인)와
  // runDetectSortOptions(정렬 감지)가 둘 다 이 목록을 그대로 방문하므로, 소비하는 쪽마다 거르면
  // 새 소비자가 생겼을 때 또 빠진다.
  const safeCategoryLinks = (data.categoryLinks || []).filter(c => {
    if (!c || !c.href || !LOGOUT_URL_RE.test(c.href)) return true
    console.warn('[PTP] 카테고리 목록에서 로그아웃 링크를 제외했습니다 — 방문하면 로그인이 끊깁니다:', c.href)
    return false
  })
  return {
    id: data.id, mode: data.mode === 'normal' ? 'normal' : 'devmode',
    extractionRules: data.extractionRules || {}, aiPreviewMode: !!data.aiPreviewMode,
    categoryUrls: (data.categoryUrls || []).filter(u => typeof u !== 'string' || !LOGOUT_URL_RE.test(u)),
    categoryLinks: safeCategoryLinks,
    categorySettings: data.categorySettings || {}, sortOptions: data.sortOptions || [],
    masterLabels: data.masterLabels || {}, masterOrder: data.masterOrder || [], previewProduct: data.previewProduct || null,
    excludeUrls: data.excludeUrls || [],
  }
}

/** PTP의 "스크래핑 중지" 버튼은 서버 인메모리 Set에 요청만 남겨둔다(일반모드는 서버 자신이 그 루프를
 * 돌고 있어 바로 확인 가능) — 개발자모드는 루프가 이 확장(사용자 브라우저) 안에서 돌고 있어, 상품마다
 * 이 엔드포인트로 직접 물어봐야 중지 요청을 알 수 있다. */
async function checkStopRequested(sid) {
  if (!sid) return false
  try {
    const res = await fetch(`${STOP_REQUESTED_ENDPOINT}?sessionId=${sid}`)
    const data = await res.json()
    return !!data.stop
  } catch {
    return false
  }
}

/** "스크랩 미리보기"(runPreview) 전용 — 위 checkStopRequested와 같은 이유·같은 구조지만, 미리보기는
 *  실제 스크랩 세션(sessionId)이 없어 siteId로 대신 묻는다(lib/devPreviewStatus.ts의
 *  isDevPreviewStopRequested 참고, 2026-09-06 — "중지를 누르면 그 순간 멈추라"는 요청). 카테고리 진행
 *  신호(preview-progress POST)에 이미 stop 필드가 같이 오므로 카테고리 경계에서는 그 값을 그대로 쓰고,
 *  카테고리 하나 안에서 여러 페이지를 도는 완전탐색/이분탐색처럼 더 자주 확인해야 하는 자리에서만
 *  이 함수로 별도 조회한다. */
async function checkDevPreviewStopRequested(siteId) {
  if (!siteId) return false
  try {
    const res = await fetch(`${SITE_API_BASE}/${siteId}/preview-progress`)
    const data = await res.json()
    return !!data.stop
  } catch {
    return false
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }
function throttle() { return delay(1200 + Math.random() * 1200) }

/** MV3 서비스워커는 idle이면 크롬이 죽였다가 재시작하는데, 그때 이 파일의 최상위 상태(pickerSessions 등)는
 *  전부 초기화돼도 브라우저가 실제로 붙여둔 디버거 연결 자체는 그대로 남는다 — 그래서 재시작 후 다시
 *  attach를 시도하면 "자기 자신의 이전 연결"을 기억 못 한 채 "Another debugger is already attached"로
 *  실패한다(실제 발견된 사례). 실패하면 한 번 detach 후 재시도해 자기 자신의 낡은 연결이면 회복하고,
 *  진짜 다른 디버거(예: F12 개발자도구)가 붙어있는 경우에만 에러를 그대로 알린다. */
// chrome.debugger의 attach/sendCommand는 자체 타임아웃이 없다 — CDP 연결이 어떤 이유로든 응답을 안 주면
// 영원히 멈춘다(콘솔에 로그 한 줄도 안 남고, navigate()의 "완료" 대기와 같은 종류의 문제였다는 게
// 실사용 중 확인됨, 2026-08-15). 매번 이 래퍼로 감싸 넉넉한 시간 안에 응답이 없으면 명확한 에러로
// 실패시킨다 — 그래야 최소한 팝업/콘솔에 "왜 멈췄는지"가 남는다.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} — ${Math.round(ms / 1000)}초 안에 응답이 없습니다`)), ms)),
  ])
}

// chrome.debugger.detach도 attach/sendCommand와 같은 이유로 자체 타임아웃이 없다 — 그리고 이게 실제
// 병목이었다: 피커("스크랩 대상 직접지정") 세션이 아직 붙어있는 탭에 미리보기가 attachDebugger의
// "already attached" 복구 경로를 타면 바로 이 detach를 부르는데, 이 detach 자체가 멈춰버리면 재시도
// attach도, 이후 어떤 콘솔 로그도 없이 통째로 멈춘다("피커 쓴 뒤 미리보기가 멈춘다" 보고, 2026-08-15).
// 모든 detach 호출을 이걸로 통일한다.
async function safeDetach(tabId) {
  await withTimeout(chrome.debugger.detach({ tabId }), 5_000, '디버거 해제').catch(() => {})
}

async function attachDebugger(tabId) {
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 10_000, '디버거 연결')
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e
    await safeDetach(tabId)
    // 방금 뗀 연결이 "스크랩 대상 직접지정"(runPicker)이 쥐고 있던 것이었을 수 있다 — 예를 들어 피커
    // 패널을 열어둔 채(종료 안 누름) 미리보기/스크랩 시작을 또 누르면 여기서 그 연결을 강제로 뗀다.
    // pickerSessions에 낡은 기록이 남아있으면 화면(패널)은 여전히 "떠 있는 것처럼" 보이는데 실제
    // CDP 연결은 끊겨 저장이 전부 조용히 실패하는 불일치가 생긴다 — 이 시점에 같이 정리한다
    // (2026-08-15, 실사용 중 "피커 쓴 뒤 미리보기가 멈춘다" 보고로 확인).
    pickerSessions.delete(tabId)
    try {
      await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 10_000, '디버거 연결(재시도)')
    } catch {
      throw new Error(`${e.message} — 이 탭에서 개발자도구(F12)가 열려있다면 닫고 다시 시도하세요.`)
    }
  }
  // lib/scraper.ts의 installDialogAutoDismiss(Playwright의 context.on('dialog', ...))와 같은 이유·같은
  // 문제를 이 확장에도 그대로 적용한다 — 몰이 alert()/confirm()으로 "로그아웃 되었습니다" 같은 네이티브
  // 다이얼로그를 띄우면 그 탭의 JS 실행 자체가 막혀 evalInTab(Runtime.evaluate)이 응답 없이 멈춘다(2026-09-08
  // 실사용 확인 — 소꿉노리, 사람이 직접 "확인"을 눌러야만 자동화가 계속됐다). Page 도메인을 켜야
  // Page.javascriptDialogOpening 이벤트를 받을 수 있어 여기서 같이 켠다 — 실제 처리(로그+자동 닫기)는
  // 아래 dialogListener(전역, chrome.debugger.onEvent)가 맡는다.
  await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.enable'), 5_000, 'Page.enable').catch(() => {})
}

async function evalInTab(tabId, expression) {
  const res = await withTimeout(
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    25_000, 'Runtime.evaluate',
  )
  if (res.exceptionDetails) {
    // exceptionDetails.text는 보통 "Uncaught" 같은 분류명일 뿐이고, 실제 메시지는 exception 쪽에 있다.
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.exception?.value || res.exceptionDetails.text || 'evaluate failed'
    throw new Error(detail)
  }
  return res.result.value
}

// runDetectSortOptions의 화면 인식 1차 수단(vision AI) 전용 — evalInTab과 같은 chrome.debugger 경로로
// CDP Page.captureScreenshot을 불러 base64 JPEG를 받는다. 이미 attachDebugger로 이 탭에 디버거가 붙어
//있어야 한다(evalInTab과 동일 전제).
async function captureScreenshot(tabId) {
  const res = await withTimeout(
    chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 }),
    15_000, 'Page.captureScreenshot',
  )
  return res.data // base64
}

async function navigate(tabId, url) {
  // chrome.tabs.update 자체엔 시간제한이 없다 — 아래 onUpdated 대기는 20초 제한을 이미 걸어뒀지만
  // (2026-08-15 발견), 이 호출 자체가 응답을 안 주고 멈추면 그 대기 시작도 못 해 똑같이 콘솔 로그
  // 한 줄 없이 영원히 멈춘다(2026-08-22, "스크랩 미리보기" 중 재발 확인 — chrome.tabs.create를 고친 것과
  // 같은 종류의 문제). withTimeout으로 감싸 이 호출부터도 넉넉한 시간 안에 응답이 없으면 명확히 실패시킨다.
  await withTimeout(chrome.tabs.update(tabId, { url }), 15_000, '탭 이동(chrome.tabs.update)')
  await new Promise(resolve => {
    let done = false
    function finish() {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      clearTimeout(timer)
      resolve()
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    // "complete" 상태가 영영 안 올 수 있다(SPA형 다음 페이지 전환, 몰의 비표준 로딩 등) — 실제로 이
    // 대기가 끝없이 멈춰(디버거가 "이 브라우저를 디버깅 중" 배너를 띄운 채) 미리보기/스크랩이 통째로
    // 안 끝나는 사례가 콘솔에 로그 한 줄도 없이 확인됐다(2026-08-15). 넉넉히 기다리되 영원히는 안
    // 기다리고, 그 시점 내용 그대로 다음 단계로 진행한다 — 그 페이지가 실제로 덜 로드됐으면 이어지는
    // evalInTab이 그 페이지 하나만 실패로 남기고 나머지는 계속 진행된다.
    const timer = setTimeout(finish, 20_000)
  })
  await delay(500) // 로딩 완료 이벤트 이후 스크립트 초기화 여유
}

// URL의 page 쿼리파라미터를 지정한 값으로 바꾼다(없으면 추가) — lib/scraper.ts의 withPageParam과 동일.
function withPageParam(url, pageNum) {
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(pageNum))
    return u.toString()
  } catch {
    return url
  }
}

// bakeSortUrl과 아래 applySortByClicking이 같은 방식으로 "지금 이 카테고리에 어떤 정렬이 선택돼
// 있는지"를 찾아야 해서 하나로 뺐다.
function findChosenSortOption(setting, sortOptions) {
  return (setting?.sortLabel && sortOptions.find(o => o.label === setting.sortLabel)) || null
}

// 카테고리별 정렬 설정을 실제 스크랩 시작 순간에만 URL에 반영한다 — site.categorySettings(원본, href
// 기준)에 정렬을 미리 구워 저장하면 다음 몰 재선택 시 체크박스/그리드 매칭이 깨지므로(ScraperPanel.tsx의
// buildCategoryUrlsAndLimits와 같은 이유), 굽는 시점을 여기 하나로 좁혀둔다.
// kind:'click'(AJAX, URL에 반영 안 됨 — 아래 applySortByClicking 참고)은 여기서 처리할 게
// 없다 — paramsToAdd 자체가 없으므로 원래 URL 그대로 돌려준다.
function bakeSortUrl(url, setting, sortOptions) {
  const chosen = findChosenSortOption(setting, sortOptions)
  if (!chosen || chosen.kind === 'click' || !chosen.paramsToAdd) return url
  try {
    const u = new URL(url)
    Object.entries(chosen.paramsToAdd).forEach(([k, v]) => u.searchParams.set(k, v))
    return u.toString()
  } catch {
    return url
  }
}

// lib/scraper.ts의 clickSortCandidateText와 같은 이유(2026-09-12, 투비즈온 실사용 확인) — kind:'click'
// 정렬 후보 중엔 텍스트가 <option>(네이티브 <select>, 값이 URL이 아닌 순수 토큰)인 경우가 있어 일반
// .click()으로는 안 열린다. 여기(개발자모드)는 Playwright locator가 아니라 CDP로 탭 안에서 JS를 그대로
// 실행하는 구조라(evalInTab) 실제 마우스 이벤트 시뮬레이션 대신, <option>이면 조상 <select>의 값을
// 직접 바꾸고 input/change 이벤트를 새로 만들어 보낸다 — 사이트가 change 리스너로 재정렬을 구현했다면
// 실제 선택과 동일하게 반응한다. <option>이 아니면 기존처럼 그냥 클릭한다.
// 실제 스크랩 시점(run())에서 카테고리당 딱 한 번만 부른다 — 이후 페이지네이션은 같은 탭 상태를 이어가므로
// (서버 collectFromListing과 같은 가정) 페이지마다 다시 적용할 필요 없다.
async function applySortByClicking(tabId, text) {
  const expr = `(() => {
    const target = ${JSON.stringify(text)}
    let found = null
    for (const el of Array.from(document.querySelectorAll('a, button, li, span, div, label, option'))) {
      const t = (el.textContent || '').trim()
      if (t !== target) continue
      const hasTextChild = Array.from(el.children).some(c => (c.textContent || '').trim() === target)
      if (hasTextChild) continue
      found = el
      break
    }
    if (!found) return false
    if (found.tagName === 'OPTION') {
      const select = found.closest('select')
      if (!select) return false
      select.value = found.value
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    found.click()
    return true
  })()`
  const clicked = await evalInTab(tabId, expr).catch(() => false)
  if (clicked) await throttle() // AJAX 재정렬이 반영될 시간(서버 confirmSortCandidatesByClicking과 같은 이유)
  return clicked
}

// 봇/과속요청 차단 인터스티셜 감지 — "로그인 필요"(비밀번호 입력창 유무로 판정하는 별도 신호)와는
// 다른 종류다. 실사용 확인(2026-08-29, 펫토리): 카페24가 "잠시 접속이 제한되었습니다" 같은 안내
// 페이지로 대신 응답하는데, 이걸 감지 못 하면 진짜 하위 카테고리가 없는 대분류로 오판해버린다.
// lib/scraper.ts에도 같은 정규식으로 isBotBlockPage를 뒀다(런타임이 달라 코드는 공유 못 함 — 문구
// 바뀌면 두 곳 다 같이 고친다).
const IS_BLOCK_PAGE_EXPR = `(() => {
  const text = document.title + ' ' + (document.body ? document.body.innerText.slice(0, 800) : '')
  return /접속\\s*(이|을)?\\s*제한|일시적으로\\s*(접속|이용)|비정상적인\\s*(접근|접속)|잠시\\s*접속|과도한\\s*요청|too many requests|access denied/i.test(text)
})()`

// 상품 링크/다음페이지 링크 수집 — 페이지 이동 없이 현재 문서만 읽는다. 몰마다 플랫폼이 달라(카페24
// SEO형, 카페24 고전형, 신우 같은 구형 자체 솔루션, 고도몰 등) 여러 패턴을 다 시도한다(lib/scraper.ts의
// PLATFORM_PROFILES와 같은 패턴을 씀 — 두 구현이 갈라지지 않도록 플랫폼이 추가되면 항상 같이 반영):
// - 카페24 SEO: /product/상품명/번호/category/분류/display/순서/
// - 카페24 고전: /product/detail.html?product_no=...
// - 구형 자체 솔루션(신우 등): detail.htm?brandcode=... 처럼 detail.htm(l) + 알려진 코드 파라미터
// - 고도몰(펫투비 등, 구형): goods_view.php?goodsno=...
// - 고도몰5(신형, 도매토피아 등): /goods/view?no=... (lib/scraper.ts의 PLATFORM_PROFILES.godomall.
//   detailUrlPattern에 2026-08-19 추가 — 이쪽엔 안 옮겨져 있던 걸 2026-09-05 전수조사로 발견)
const COLLECT_LINKS_EXPR = `(() => {
  const isProductLink = (href) => {
    if (/\\/product\\/.+\\/\\d+\\/category\\/\\d+\\/display\\/\\d+/.test(href)) return true
    if (/detail\\.html?/i.test(href) && /[?&](product_no|branduid|goodsno|goods_no|brandcode)=/i.test(href)) return true
    if (/goods_view\\.php/i.test(href) && /[?&]goodsno=/i.test(href)) return true
    if (/\\/goods\\/view\\?no=\\d+/i.test(href)) return true
    // 도매의신(domesin.com) — lib/scraper.ts의 PLATFORM_PROFILES.domesin과 같은 패턴(2026-09-05
    // 전수조사로 발견: 이 확장 쪽 앵커 사전필터에 이 URL 형태가 아예 없어 상품 링크를 0개로 잡았다).
    if (/p=view\\.html/i.test(href) && /[?&]iid=/i.test(href)) return true
    return false
  }
  // "최근 본 상품"/"추천 상품" 위젯이 상품 카드와 같은 URL 패턴을 공유해 실제로는 끝난 카테고리에서
  // 계속 새 상품이 나오는 것처럼 보이는 문제 — lib/scraper.ts의 WIDGET_CLASS_EXCLUDE_SRC와 같은 기준
  // (2026-09-05 전수조사로 발견: 서버 쪽엔 이미 있는 이 제외 로직이 확장에는 아예 없었다).
  const widgetRe = /productrecent|recent-?list|recent-?view|recently-?viewed|recommend/i
  const inWidget = (el) => {
    for (let cur = el; cur; cur = cur.parentElement) {
      if (widgetRe.test(cur.className || '')) return true
    }
    return false
  }
  // 목록(카테고리) 페이지에서 "미리보기"의 나머지 목록에 쓸 상품명/썸네일도 같이 모은다 — lib/scraper.ts의
  // collectProductUrls(scanCurrentPage)와 같은 방식(썸네일 img의 alt, 없으면 링크 텍스트).
  const anchors = Array.from(document.querySelectorAll('a[href*="/product/"], a[href*="detail.htm"], a[href*="goods_view"], a[href*="/goods/view"], a[href*="view.html"]'))
    .filter(a => a.href && isProductLink(a.href) && !inWidget(a))
  const linkInfo = new Map()
  anchors.forEach(a => {
    if (linkInfo.has(a.href)) return
    const img = a.querySelector('img')
    linkInfo.set(a.href, { name: (img?.alt || a.textContent || '').trim(), thumbnail: img?.src || '' })
  })
  const uniqueLinks = [...linkInfo.keys()]

  // 다음 페이지 — 카페24 표준 페이지네이션(.ec-base-paginate, 현재 페이지 a.this 다음 번호)을 먼저
  // 시도하고, 없으면 고도몰 표준(.paginate a.next), 그래도 없으면 "다음"/"next" 글자가 들어간 링크
  // (신우 등 구형 몰은 화살표 이미지 대신 이 방식)를 찾는다.
  let nextUrl = null
  const pageNumbers = Array.from(document.querySelectorAll('.ec-base-paginate ol li a'))
  const currentIdx = pageNumbers.findIndex(a => a.classList.contains('this'))
  if (currentIdx >= 0 && currentIdx + 1 < pageNumbers.length) nextUrl = pageNumbers[currentIdx + 1].href
  // 카페24 기본 페이지네이션은 페이지 번호를 한 번에 5~10개 묶음으로만 보여주고, 그 묶음의 마지막 번호가
  // "지금 이 페이지"가 아니면(=아직 이 묶음 안에 다음 번호가 있으면) 위에서 이미 잡힌다. 그런데 지금
  // 페이지가 그 묶음의 마지막 번호 자체라면(currentIdx + 1 >= length) 다음 묶음은 번호가 아니라 별도
  // 화살표 링크(.xans-product-listpagination a.next, lib/scraper.ts의 PLATFORM_PROFILES.cafe24와 같은
  // 셀렉터)로만 이동할 수 있다 — 이 분기가 없으면 "묶음 끝"에서 다음 페이지가 있는데도 없다고 오판해
  // 카테고리 전체를 다 못 돌고 조용히 멈춘다(2026-08-22, 모자사러 "버킷햇" 654개 중 180개에서 멈춘
  // 문제로 발견 — lib/scraper.ts는 readLastPageFromNavButton 등으로 이미 해결해뒀는데 이 확장에는
  // 포팅이 안 돼 있었다).
  if (!nextUrl) {
    const cafe24Next = document.querySelector('.xans-product-listpagination a.next, .ec-base-paginate a.next')
    if (cafe24Next) nextUrl = cafe24Next.href
  }
  // 클래스명 대신 화살표를 <img alt="다음 페이지">로만 표시하는 구형/커스텀 카페24 스킨도 있다 —
  // lib/scraper.ts의 readLastPageFromNavButton(마지막 페이지 버튼)이 이미 이미지 alt 기반으로 찾는 것과
  // 같은 이유(2026-08-22, 모자사러 cate_no=45에서 실제 확인: <img alt="다음 페이지" src=".../btn_page_
  // next.gif">를 감싼 <a>였고 클래스명이 전혀 없었다 — 위 클래스 기반 셀렉터로는 못 찾음).
  if (!nextUrl) {
    const nextImgLink = document.querySelector('a:has(img[alt*="다음"])')
    if (nextImgLink) nextUrl = nextImgLink.href
  }
  if (!nextUrl) {
    const godoNext = document.querySelector('.paginate a.next')
    if (godoNext) nextUrl = godoNext.href
  }
  if (!nextUrl) {
    const nextTextLink = Array.from(document.querySelectorAll('a')).find(a => /다음|next/i.test((a.textContent || '').trim()))
    if (nextTextLink) nextUrl = nextTextLink.href
  }

  // 이 목록(카테고리) 페이지의 카테고리 경로(예: "모자 > 귀도리")를 찾는다. .xans-product-headcategory는
  // 카페24 표준 클래스인데 배너 이미지용으로도 같이 쓰여 텍스트가 비어있을 수 있어, 후보 중 텍스트가
  // 있는 걸 찾는다 — lib/scraper.ts의 detectCategoryLabel과 같은 방식.
  // 일부 몰은 공지사항/구매후기 위젯에 이 셀렉터들과 같은 제네릭 클래스명을 재사용한다(실사용 확인,
  // 2026-08-30, 소구프놀리 — 공지 제목·후기 문구가 그대로 "카테고리"로 들어감) — lib/scraper.ts의
  // detectCategoryLabel과 동일한 looksLikeNoise 필터로 확실한 신호만 걸러낸다(완벽하진 않음).
  const looksLikeNoise = (text) =>
    text.length > 60
    || /·/.test(text)
    || (text.match(/(습니다|해요|세요|어요)[.!]?/g) || []).length >= 2
    || /(공지|안내|이벤트\s|할인판매|상품문의|NOTICE)/i.test(text)
    || /\d+\s*월\s*\d+\s*일/.test(text)
  let category = ''
  let brandFromCategory = ''
  const categorySelectors = ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']
  for (const sel of categorySelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      // <li>로 계층이 명확히 나뉘어 있으면 그 경계를 그대로 쓴다 — "/" 기준으로 통째로 쪼개면
      // "SANDAL/MULE"처럼 카테고리명 자체에 "/"가 들어있는 경우까지 잘못 쪼개진다(실제 발견된 사례).
      // 각 <li> 자체가 "/ 라벨"처럼 구분자를 텍스트 안에 그대로 갖고 있는 몰도 있어(실제 발견된 사례)
      // 앞뒤의 "/"·공백은 벗겨낸다.
      const liItems = Array.from(el.querySelectorAll('li'))
        .map(li => (li.textContent || '').replace(/^[\s/]+|[\s/]+$/g, '').trim())
        .filter(Boolean)
      if (!liItems.length) {
        const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
        if (text && !looksLikeNoise(text)) { category = text; break }
        continue
      }
      const joined = liItems.join(' > ')
      if (looksLikeNoise(joined)) continue
      // "브랜드"라는 카테고리 노드 바로 아래는 상품 종류 구분이 아니라 실제 브랜드명이다(예: 브랜드 > 나이키).
      const brandIdx = liItems.findIndex(t => t === '브랜드')
      if (brandIdx !== -1 && brandIdx + 1 < liItems.length) {
        category = liItems.slice(0, brandIdx).join(' > ')
        brandFromCategory = liItems[brandIdx + 1]
      } else {
        category = joined
      }
      break
    }
    if (category || brandFromCategory) break
  }

  // 로그인 필요 판정 — lib/scraper.ts의 countProductsOnPage/isLoginPage(비밀번호 입력창 유무)와 같은
  // 신호. 위 IS_BLOCK_PAGE_EXPR(봇/과속요청 차단)과는 다른 원인이라 따로 둔다.
  // "화면에 실제로 보이는" 입력창만 센다 — lib/scraper.ts의 countProductsOnPage 주석 참고(2026-09-11,
  // 도매토피아 실사용 확인: 고도몰 계열 몰의 "비밀번호 주기적 변경" 안내 팝업이 숨겨진 채 모든 페이지에
  // 항상 존재해, 화면에 보이는지를 안 가리면 상품 0개인 정상 페이지마다 로그인 벽으로 오탐했다).
  const isLoginPage = Array.from(document.querySelectorAll('input[type="password"]'))
    .some(el => el.checkVisibility?.() ?? true)
  return { links: uniqueLinks, linkInfo: Object.fromEntries(linkInfo), nextUrl, category, brandFromCategory, isLoginPage }
})()`

// "🧭 정렬 옵션 감지"(runDetectSortOptions)가 카테고리 페이지의 모든 같은 출처 링크를 서버로 보내 AI 판정을
// 맡기기 위해 모으는 용도 — lib/scraper.ts의 collectSortCandidates(page.evaluate 안)와 완전히 같은 로직
// (같은 출처, 400개 상한, 지금 페이지/origin 자체 제외, 텍스트 또는 img alt)을 그대로 옮겼다. 상품
// 링크인지 여부는 가리지 않는다 — 정렬 링크는 카테고리 링크와 똑같은 모양(같은 pathname, 쿼리파라미터만
// 다름)이라 COLLECT_LINKS_EXPR의 상품 링크 필터로는 걸러지지 않는다.
// 2026-08-21 걸스굽 실사용 확인: 카페24 플랫폼은 정렬을 <a> 링크가 아니라 <select id="selArray"
// class="...xans-product-orderby">(옵션 value에 "?cate_no=...&sort_method=N" 같은 상대경로가 들어있음)로
// 구현해서, <a href>만 모으던 기존 방식으로는 정렬 옵션이 하나도 안 잡혔다(항상 "기본순"만 남음) — 모든
// <select>의 <option>도 같은 방식으로 후보에 포함시킨다(계좌이체 은행 선택처럼 값이 다른 출처의 전체
// URL인 것들은 origin 필터에서 자연히 걸러진다).
// lib/scraper.ts의 AI_LINK_CANDIDATE_CAP과 같은 이유·같은 값으로 낮춘다(2026-08-23, 펫투비 실측:
// 로컬 Ollama가 CPU 전용이라 400개짜리 후보 프롬프트 하나 처리하는 데만 300초 넘게 걸림 — 모델 로딩이
// 아니라 순수 프롬프트 처리 시간이었다). detectSortOptionsWithAI가 이 목록을 그대로 AI에 보낸다.
const COLLECT_ALL_LINKS_EXPR = `(() => {
  const origin = location.origin
  const current = location.href.replace(/\\/+$/, '')
  const seen = new Set()
  const result = []
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    if (result.length >= 120) break
    const href = a.href
    if (!href.startsWith(origin) || href.endsWith('#')) continue
    const norm = href.replace(/\\/+$/, '')
    if (norm === current || norm === origin || seen.has(norm)) continue
    const text = (a.textContent || '').trim() || (a.querySelector('img[alt]')?.alt || '').trim()
    if (!text) continue
    seen.add(norm)
    result.push({ text, href })
  }
  for (const opt of Array.from(document.querySelectorAll('select option'))) {
    if (result.length >= 120) break
    if (!opt.value) continue
    let href
    try { href = new URL(opt.value, location.href).href } catch { continue }
    if (!href.startsWith(origin) || href.endsWith('#')) continue
    const norm = href.replace(/\\/+$/, '')
    if (norm === current || norm === origin || seen.has(norm)) continue
    const text = (opt.textContent || '').trim()
    if (!text) continue
    seen.add(norm)
    result.push({ text, href })
  }
  return { links: result, baseUrl: location.href }
})()`

// COLLECT_ALL_LINKS_EXPR이 아무것도 못 찾았을 때(버튼 onclick, 커스텀 JS 드롭다운 등 href/select-value로
// 정적으로 읽을 수 없는 정렬 UI)의 폴백 — lib/scraper.ts의 detectSortOptionsByClicking과 완전히 같은
// 아이디어(태그 종류 상관없이 정렬 키워드와 비슷한 텍스트를 후보로 삼아 실제로 클릭해보고, 클릭 전후
// URL이 달라지면 진짜 정렬 옵션으로 인정 — 엉뚱한 걸 클릭해도 서버의 diffQueryParams가 같은 pathname인지
// 다시 확인하므로 후보를 넓게 잡아도 안전하다). 여기서는 후보 텍스트만 모으고, 실제 클릭은
// runDetectSortOptions가 evalInTab을 반복 호출해 하나씩 수행한다(클릭마다 원래 페이지로 복귀해야 해서
// 이 evaluate 하나로 전부 끝낼 수 없다).
// 최저/최고도 낮은가격/높은가격만큼 흔한 표현이다(lib/scraper.ts SORT_KEYWORD_PATTERN과 같은 이유로 추가,
// 2026-09-12 — 두 곳이 갈라지지 않도록 항상 같이 반영). 판매순/상품명순도 같은 이유로 추가(2026-09-15,
// 정글북 실사용 확인 — "판매량"/(상품명 매칭 없음)만으로는 "판매순"/"상품명순"이 후보에도 안 들어갔다).
const SORT_KEYWORD_PATTERN = '(신상|신규|최신|낮은\\s*가격|높은\\s*가격|최저|최고|인기|판매량|판매\\s*순|상품명\\s*순|조회|클릭|리뷰|추천|할인|세일|낱개판매|기본순)'

// lib/scraper.ts의 openLikelySortDropdownTrigger와 같은 이유·같은 판정(2026-09-15, 정글북 실사용 확인 —
// "판매순"/"낮은 가격순" 등은 현재 선택된 정렬(예: "최신순")을 보여주는 버튼을 먼저 클릭해야 DOM에
// 나타나는 닫힌 드롭다운이었다. 스크린샷/구조 스캔 둘 다 열기 전 상태만 봐서 이 옵션들을 놓쳤다) — 텍스트
// 자체가 이미 정렬 키워드처럼 생기고 아이콘(svg)을 동반한 버튼만 트리거로 본다(그래야 "강아지"/"고양이"
// 같은 무관한 토글을 잘못 열지 않는다). 이 트리거는 클릭마다 열림/닫힘이 토글돼, 이미 열려 있는데 또
// 부르면 도로 닫아버린다(정글북 재확인, 2026-09-15 — 스크린샷 단계가 열어둔 걸 클릭 폴백 단계가 또
// 열려다 도로 닫음) — "정렬 키워드 텍스트가 이미 2개 이상 보이면 열린 것"으로 추측했다가 실패했다
// (사이트 공통 상단 메뉴 "신상품"/"타임세일"이 닫힌 상태에서도 우연히 같은 키워드에 걸려 항상 2개 이상
// 잡혔다 — 실제 로그로 확인). 대신 클릭에 성공했을 때만 document에 표시를 남기고 다음 호출은 그 표시만
// 본다 — 같은 탭에서 페이지를 새로 불러오면(clickCandidatesAndCollectLinks가 후보마다 baseUrl로 되돌아갈
// 때) 표시가 자연히 사라져 다음 후보에서도 정확히 다시 판단한다. 두 곳이 갈라지지 않도록 항상 같이 반영한다.
const OPEN_SORT_DROPDOWN_EXPR = `(() => {
  const marker = 'data-scraper-opened-sort-dropdown'
  if (document.documentElement.hasAttribute(marker)) return true
  const re = new RegExp(${JSON.stringify(SORT_KEYWORD_PATTERN)})
  const candidate = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
    const text = (el.textContent || '').trim()
    if (!text || text.length > 12 || !re.test(text)) return false
    if (!el.querySelector('svg')) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  if (!candidate) return false
  candidate.click()
  document.documentElement.setAttribute(marker, '1')
  return true
})()`
const COLLECT_SORT_KEYWORD_TEXTS_EXPR = `(() => {
  const re = new RegExp(${JSON.stringify(SORT_KEYWORD_PATTERN)})
  const seen = new Set()
  const result = []
  for (const el of Array.from(document.querySelectorAll('a, button, li, span, div, label'))) {
    if (result.length >= 10) break
    const text = (el.textContent || '').trim()
    if (!text || text.length > 12 || !re.test(text) || seen.has(text)) continue
    const hasTextChild = Array.from(el.children).some(c => (c.textContent || '').trim() === text)
    if (hasTextChild) continue
    seen.add(text)
    result.push(text)
  }
  return result
})()`

// expandOne의 "빈 허브 배제"(2026-08-30, 도매토피아 실사용 확인) 전용 — 위 COLLECT_SORT_KEYWORD_TEXTS_EXPR은
// 클릭+URL변화 검증까지 거치는 runDetectSortOptions에서만 안전하다. 클릭 없이 텍스트만 보고 "정렬 있음"을
// 판단하면, 이 몰의 사이트 공통 헤더에 있는 "신상품"(신상 매칭)/"주문배송조회"(조회 매칭) 같은 무관한
// 전역 내비게이션 링크가 키워드에 우연히 걸려 모든 페이지에서 오탐했다(lib/scraper.ts의 diffQueryParams와
// 같은 이유) — href의 pathname이 지금 페이지와 같고(=쿼리파라미터만 다른 진짜 "같은 목록의 다른 정렬"
// 링크) 텍스트도 정렬 키워드에 맞는 것만 인정한다.
const HAS_SORT_LINK_ON_PAGE_EXPR = `(() => {
  const re = new RegExp(${JSON.stringify(SORT_KEYWORD_PATTERN)})
  const here = location.pathname
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const text = (a.textContent || '').trim()
    if (!text || text.length > 12 || !re.test(text)) continue
    let href
    try { href = new URL(a.getAttribute('href'), location.href) } catch { continue }
    if (href.pathname === here && href.href !== location.href) return true
  }
  return false
})()`

// 위에서 모은 후보 텍스트 하나를 실제로 클릭한다 — 정확히 그 텍스트를 직접 담은(자식이 아닌) 요소만
// 찾아 클릭하고, 성공 여부만 boolean으로 돌려준다(클릭 이후 페이지 이동 여부는 호출부가
// chrome.tabs.onUpdated로 별도 확인). 곧바로 못 찾으면 닫힌 드롭다운 안에 있을 수 있어(위
// OPEN_SORT_DROPDOWN_EXPR 주석 참고) 한 번 열어보고 다시 찾는다 — evalInTab이 awaitPromise:true라
// async IIFE + 짧은 대기(React 렌더 반영 시간)를 그대로 쓸 수 있다.
function buildClickTextExpr(text) {
  return `(async () => {
    const target = ${JSON.stringify(text)}
    const find = () => {
      for (const el of Array.from(document.querySelectorAll('a, button, li, span, div, label'))) {
        const t = (el.textContent || '').trim()
        if (t !== target) continue
        const hasTextChild = Array.from(el.children).some(c => (c.textContent || '').trim() === t)
        if (hasTextChild) continue
        return el
      }
      return null
    }
    let el = find()
    if (!el) {
      ${OPEN_SORT_DROPDOWN_EXPR}
      await new Promise(r => setTimeout(r, 300))
      el = find()
    }
    if (!el) return false
    el.click()
    return true
  })()`
}

// 클릭이 실제 페이지 이동으로 이어지는지 잠깐 기다린다 — navigate()와 같은 원리(chrome.tabs.onUpdated의
// "complete" 대기, 영원히 안 올 수 있어 상한 시간 뒤엔 그 시점 그대로 진행)지만, 여기선 우리가 직접
// chrome.tabs.update를 호출하지 않고 페이지 자신의 JS(클릭 핸들러)가 이동을 트리거하므로 별도로 둔다.
function waitForTabSettled(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    function finish() {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      clearTimeout(timer)
      resolve()
    }
    function onUpdated(id, info) { if (id === tabId && info.status === 'complete') finish() }
    chrome.tabs.onUpdated.addListener(onUpdated)
    const timer = setTimeout(finish, timeoutMs)
  })
}

// 카테고리를 여러 개 선택했을 때(collectCategoryLinks의 fastCountOk) 개수만 필요하면, 페이지를 하나씩
// 순회하지 않고 이 신호로 몇 번만 열어봐서 정확한 개수를 바로 얻는다 — lib/scraper.ts의
// readStatedTotalCount/readLastPageFromNavButton과 같은 원리(2026-08-17, 모자사러 실사용 확인: 이
// 지름길이 없어서 카테고리를 여러 개 선택하면 정말로 페이지 수만큼 순회해 체감상 멈춘 것처럼 보일 만큼
// 오래 걸렸다). "총 N개" 문구가 있으면 그게 최우선 정답이고(페이지를 더 열 필요조차 없음), 없으면
// 페이지네이션의 "마지막 페이지로" 이동 버튼 href에 인코딩된 번호를 읽는다 — 이 버튼은 지금 몰이 보여주는
// 페이지가 몇 번이든 항상 진짜 마지막 페이지를 가리켜야 하는 구조라 신뢰도가 높다(Node쪽에서 이미
// 여러 카페24 몰로 검증됨). 텍스트로 보이는 페이지 번호 중 최댓값을 읽는 방식(readMaxPageNumber)은
// "화면에 보이는 번호 묶음의 끝"일 뿐일 수 있어 정확도가 살짝 떨어질 수 있다는 이유로 2026-08-17엔 일부러
// 안 넣었었다 — 그런데 "총 N개" 문구도 "마지막 페이지" 버튼도 없는 몰(모자사러 실사용 확인, 2026-09-05
// — 두 지름길이 다 실패해 카테고리 하나가 150페이지 완전탐색으로 떨어져 5분 넘게 걸림)에서는 근사치라도
// 있는 게 그 최후수단보다 훨씬 낫다는 사용자 판단으로 이제 세 번째 지름길로 추가한다(아래 함수 참고).
// leafLabel(카테고리 경로의 마지막 구간)로 "총 N개" 문구 주변을 검증하는 이유: document.body 전체를
// 무작정 훑으면 이 카테고리와 무관한 사이트 전체 배지 숫자를 잘못 집을 위험이 있다 — Node쪽에서 실제로
// 겪은 문제(펫투비: 21개짜리 카테고리가 무관한 숫자 때문에 16,363개로 잘못 확정)와 같은 사고를 막는다.
function buildPaginationSignalExpr(leafLabel) {
  return `(() => {
  const leafLabel = ${JSON.stringify(leafLabel || '')}
  // leafLabel(카테고리 라벨 탐지 실패 등)이 없으면 "총 N개" 문구가 진짜 이 카테고리를 가리키는지 검증할
  // 방법이 없다 — lib/scraper.ts의 readStatedTotalCount와 같은 안전장치(2026-09-05 전수조사로 발견: 이
  // 확장 쪽엔 leafLabel이 없을 때 검증 없이 페이지의 첫 "총/전체 N개" 문구를 그냥 정답으로 채택하던
  // 구멍이 있었다 — 펫투비류 사고(무관한 배지 숫자를 카테고리 개수로 오채택)가 재현될 수 있었다).
  if (leafLabel) {
    const bodyText = document.body.innerText
    const totalRe = /(총|전체)\\s*([\\d,]+)\\s*(개|건)/g
    let m
    while ((m = totalRe.exec(bodyText))) {
      const n = Number(m[2].replace(/,/g, ''))
      if (!Number.isInteger(n) || n <= 0 || n >= 1000000) continue
      const contextStart = Math.max(0, m.index - 30)
      if (!bodyText.slice(contextStart, m.index + m[0].length).includes(leafLabel)) continue
      return { statedTotal: n, lastPage: null }
    }
  }

  const roots = Array.from(document.querySelectorAll('[class*="paging" i], [class*="pagination" i]'))
  for (const el of roots) {
    const candidates = Array.from(el.querySelectorAll('a[href]')).filter(a => {
      const cls = a.className || ''
      const alt = a.querySelector('img')?.getAttribute('alt') || ''
      return /last|마지막/i.test(cls) || /last|마지막/i.test(alt)
    })
    for (const a of candidates) {
      try {
        const u = new URL(a.href, location.href)
        const n = Number(u.searchParams.get('page'))
        if (Number.isInteger(n) && n > 0) return { statedTotal: null, lastPage: n }
      } catch {}
    }
  }
  // "총 N개" 문구도, "마지막 페이지로" 버튼도 없는 몰(2026-09-05, 모자사러 실사용 확인 — 카테고리 하나가
  // 5분 넘게 걸림: 두 지름길이 다 실패해 한 페이지씩 최대 150페이지까지 직접 세는 최후수단으로 떨어짐)을
  // 위한 세 번째 지름길 — lib/scraper.ts의 readMaxPageNumber와 같은 방식으로, 화면에 보이는 페이지 번호
  // 링크 중 가장 큰 값을 "총 페이지 수"로 본다. 스킨에 따라 "1 2 3 ... 10"처럼 번호 일부만 보여줄 수 있어
  // 100% 정확하진 않다는 걸 알면서도(원래 2026-08-17에 이 이유로 일부러 안 넣었었음), 앞의 두 지름길이
  // 전부 없는 몰에서 최후수단(150페이지 완전탐색)보다는 이쪽이 훨씬 낫다는 사용자 판단(2026-09-05)으로
  // 이제 추가한다 — 같은 필드(lastPage)로 반환해 호출부(collectCategoryLinks)는 출처를 구분할 필요 없다.
  let maxVisiblePage = 0
  for (const el of roots) {
    Array.from(el.querySelectorAll('a[href]')).forEach(a => {
      const n = Number((a.textContent || '').trim())
      if (Number.isInteger(n) && n > 0 && n < 100000 && n > maxVisiblePage) maxVisiblePage = n
    })
  }
  if (maxVisiblePage > 0) return { statedTotal: null, lastPage: maxVisiblePage }
  // 세 지름길이 다 실패했다 — 호출부가 AI(로컬 Ollama, lib/ai.ts의 detectLastPageLinkWithAI)에게 마지막
  // 판단을 맡길 수 있도록, 페이지네이션 영역 안의 링크 후보(숫자가 아닌 텍스트도 포함 — "다음"/"더보기"
  // 등 규칙 기반이 못 잡는 표현일 수 있음)를 그대로 실어 보낸다. 후보 자체가 없으면(페이지네이션 영역이
  // 아예 없는 몰) AI에 물어봐도 의미가 없으니 빈 배열.
  const candidates = []
  for (const el of roots) {
    Array.from(el.querySelectorAll('a[href]')).forEach(a => {
      const text = (a.textContent || '').trim() || (a.querySelector('img')?.getAttribute('alt') || '').trim()
      if (text && candidates.length < 60) candidates.push({ text, href: a.href })
    })
  }
  return { statedTotal: null, lastPage: null, candidates, hostname: location.hostname, currentUrl: location.href }
})()`
}

// 상품 상세 페이지 추출 — lib/extract.ts의 규칙기반 추출과 같은 원칙(ld+json → og 태그 →
// 화면 요소 → hidden input 순 폴백)을 그대로 따른다. 카페24 표준 마크업(#prdDetail 등) 기준.
// 상품코드는 카페24 SEO형 URL(/product/상품명/7111/category/54/display/1/)의 숫자 경로 세그먼트를
// 우선 쓴다 — 상품명(한글) 부분이 나중에 바뀌어도 이 번호로 재매칭되도록.
// 주의: 아래 문자열은 chrome.debugger로 원격 페이지에 그대로 전송되므로 한글 주석을 넣지 않는다
// (전송 과정에서 SyntaxError를 유발하는 것을 실제로 확인함 — 원인 불명, 안전하게 피함).
// rules는 "스크랩 조정" 기능이 이 몰에 대해 학습해둔 영구 추출 규칙(sites.extraction_rules, resolveSite로
// 같이 받아옴) — lib/extract.ts의 규칙 적용과 같은 방식으로 최우선(마지막에 덮어씀) 적용한다.
function buildExtractExpr(rules) {
  return `(async () => {
  let product = null
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '')
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      const found = candidates.find(c => { const t = c['@type']; return t === 'Product' || (Array.isArray(t) && t.includes('Product')) })
      if (found) { product = found; break }
    } catch {}
  }
  const ogContent = (prop) => document.querySelector('meta[property="' + prop + '"]')?.getAttribute('content') || ''

  let name = '', price = null, brand = '', description = '', mainImages = []
  if (product) {
    name = product.name || ''
    brand = (typeof product.brand === 'string' ? product.brand : product.brand?.name) || ''
    description = product.description || ''
    const imgField = product.image
    mainImages = Array.isArray(imgField) ? imgField : (imgField ? [imgField] : [])
    const offers = Array.isArray(product.offers) ? product.offers : (product.offers ? [product.offers] : [])
    if (offers[0]?.price != null) price = Number(offers[0].price)
  }
  if (!name) name = ogContent('og:title') || document.querySelector('input[name="brandname"]')?.value || document.title || ''
  if (!mainImages.length) { const ogImg = ogContent('og:image'); if (ogImg) mainImages = [ogImg] }
  if (!mainImages.length) {
    const galleryImgs = Array.from(document.querySelectorAll('.img_small .small img')).map(img => img.src).filter(Boolean)
    if (galleryImgs.length) mainImages = galleryImgs
    else {
      const bigImg = document.querySelector('#bigimage')
      if (bigImg?.src) mainImages = [bigImg.src]
    }
  }
  if (!description) description = ogContent('og:description') || document.querySelector('meta[name="description"]')?.getAttribute('content') || ''

  // 상품정보고시류 라벨-값 쌍 — 카페24는 <table>(th/td), 신우 같은 구형 자체 솔루션은 <dl><dt>/<dd>로
  // 표현하니 둘 다 본다. lib/extract.ts의 같은 스캔과 동일한 방식(dt는 다음 dt를 만나기 전 첫 dd와 짝짓기).
  const infoRows = []
  document.querySelectorAll('table tr').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th,td')).map(c => (c.textContent || '').trim())
    if (cells.length === 2 && cells[0] && cells[1]) infoRows.push([cells[0], cells[1]])
  })
  document.querySelectorAll('dl').forEach(dl => {
    Array.from(dl.querySelectorAll('dt')).forEach(dt => {
      let sib = dt.nextElementSibling
      while (sib && sib.tagName !== 'DD' && sib.tagName !== 'DT') sib = sib.nextElementSibling
      if (sib && sib.tagName === 'DD') {
        const label = (dt.textContent || '').trim()
        const value = (sib.textContent || '').trim()
        if (label && value) infoRows.push([label, value])
      }
    })
  })
  const infoValue = (labelPattern) => infoRows.find(([label]) => labelPattern.test(label))?.[1] || ''
  // "3,000 ~ 4,000원"처럼 범위로 적힌 값은 최저값을 쓴다(배송비가 흔히 이렇게 표기된다) — 범위가 아니면
  // 예전처럼 숫자 바로 뒤에 "원"이 오는 걸 찾는다. 범위 표기를 못 가려내면 "원" 바로 앞의 숫자(범위의
  // 마지막 값)만 잡혀 최저값이 아니라 최고값이 들어가는 문제가 있었다(실제 발견된 사례: 배송비 3,000~
  // 4,000원인데 4,000원이 저장됨).
  const firstNumber = (text) => {
    const range = text.match(/([\\d,]{2,})\\s*~\\s*[\\d,]{2,}\\s*(?=원)/)
    if (range) return Number(range[1].replace(/,/g, ''))
    const m = text.match(/[\\d,]{2,}(?=\\s*원)/)
    return m ? Number(m[0].replace(/,/g, '')) : null
  }
  // 배송비는 범위 자체가 실제 정보(무게/지역별 차등)라 Raw 데이터에는 원문 그대로 "3000~4000"으로
  // 남겨 사용자가 검수 화면에서 실제 페이지와 비교할 수 있게 한다 — product_master로 옮길 때만 계산
  // 가능하도록 최저값 숫자로 바뀐다(lib/master/migrate.ts).
  const firstNumberOrRange = (text) => {
    const range = text.match(/([\\d,]{2,})\\s*~\\s*([\\d,]{2,})\\s*(?=원)/)
    if (range) return range[1].replace(/,/g, '') + '~' + range[2].replace(/,/g, '')
    return firstNumber(text)
  }
  let costPrice = firstNumber(infoValue(/도매가|공급가/))
  const shippingFee = firstNumberOrRange(infoValue(/배\\s*송\\s*비/))
  const labeledRetailPrice = firstNumber(infoValue(/소비자가|시중가|오픈마켓|정상\\s*판매\\s*가|정상가/))

  // 라벨로 명시된 소비자가/정상판매가는 ld+json이 이미 값을 채워놨어도 항상 우선한다 — 사람이 페이지에
  // 직접 적어둔 라벨이 구조화 메타데이터(할인 중인 실제 판매가 등 다른 값을 가리킬 수 있음)보다 확실하다.
  if (labeledRetailPrice != null) price = labeledRetailPrice
  // 이 시스템이 스크랩하는 몰은 대부분 거래처가 사입하는 도매/공급 전용몰이다 — "소비자가/시중가/
  // 오픈마켓"이라고 명시적으로 라벨링된 값이 없다면, 화면의 다른 "price" 클래스 요소도 공급가(거래처
  // 매입가)로 봐야 한다. 오픈마켓 노출가(소비자판가)는 이후 가격이익관리 단계에서 정하는 값이다.
  if (price == null && costPrice == null) {
    const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
    for (const el of priceEls) {
      const m = (el.textContent || '').match(/([\\d,]{3,})\\s*원/)
      if (!m) continue
      costPrice = Number(m[1].replace(/,/g, ''))
      break
    }
  }

  let categoryFromDetail = ''
  let brandFromCategoryDetail = ''
  for (const sel of ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const liItems2 = Array.from(el.querySelectorAll('li'))
        .map(li => (li.textContent || '').replace(/^[\s/]+|[\s/]+$/g, '').trim())
        .filter(Boolean)
      if (!liItems2.length) {
        const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
        if (text) { categoryFromDetail = text; break }
        continue
      }
      // "브랜드"라는 카테고리 노드 바로 아래는 상품 종류 구분이 아니라 실제 브랜드명이다(예: 브랜드 > 나이키).
      const brandIdx2 = liItems2.findIndex(t => t === '브랜드')
      if (brandIdx2 !== -1 && brandIdx2 + 1 < liItems2.length) {
        categoryFromDetail = liItems2.slice(0, brandIdx2).join(' > ')
        brandFromCategoryDetail = liItems2[brandIdx2 + 1]
      } else {
        categoryFromDetail = liItems2.join(' > ')
      }
      break
    }
    if (categoryFromDetail || brandFromCategoryDetail) break
  }

  // 브레드크럼이 아예 없는 구형몰(신우 등)은 상세페이지 자체의 카테고리 표시 영역에서 상위 카테고리명을
  // 가져오고, 그 하위 목록 중 지금 이 상품의 URL과 카테고리코드(cat_code)가 정확히 일치하는 링크가
  // 있으면 그 텍스트를 하위 카테고리로 붙인다. 이름 자체에 "/"가 들어있는 경우가 있어(예: "뷰티＆샵
  // /노을,누리,아름") 위 로직처럼 계층 구분자로 잘못 쪼개지 않도록 통째로 쓴다.
  if (!categoryFromDetail) {
    const parentName = (document.querySelector('.productCategory .state h3')?.textContent || '').trim()
    if (parentName) {
      let subName = ''
      try {
        const myCode = new URL(location.href).searchParams.get('cat_code')
        if (myCode) {
          const subLink = Array.from(document.querySelectorAll('.productCategory .detailCate a[href*="cat_code="]'))
            .find(a => new URL(a.getAttribute('href') || '', location.href).searchParams.get('cat_code') === myCode)
          subName = (subLink?.textContent || '').trim()
        }
      } catch {}
      categoryFromDetail = subName ? (parentName + ' > ' + subName) : parentName
    }
  }

  const detailContainer = document.querySelector('#prdDetail') || document.querySelector('.detail_con')
  const detailImages = Array.from(detailContainer?.querySelectorAll('img') || [])
    .map(img => img.src).filter(src => src && !mainImages.includes(src) && !src.includes('/upload/appfiles/'))

  // 신우는 상품 상세페이지 안에 "추가 구성 상품(연관 상품)"이라는, 완전히 다른 상품의 미니 주문폼을
  // 그대로 끼워 넣는다(자기 코드/사이즈/색상 select까지 별도로 있음) — 이 블록은 항상 .item_option_2에,
  // 지금 보고 있는 실제 상품의 옵션은 항상 .item_option에 들어있다. 컨테이너 없이 전체 문서에서 select를
  // 찾으면 연관 상품의 옵션까지 섞여 들어와(옵션이 size/size_0처럼 중복되고 조합도 엉뚱하게 섞인다).
  const optionRoot = document.querySelector('.item_option') || document
  const selectEls = Array.from(optionRoot.querySelectorAll('select'))
  const realValues = (sel) => Array.from(sel.options).filter(o => o.value !== '').map(o => (o.textContent || '').trim()).filter(Boolean)
  const options = selectEls
    .map(sel => ({ name: sel.getAttribute('title') || sel.name || sel.id || '', values: realValues(sel) }))
    .filter(o => o.values.length > 0 && !/수량|콤보|qty/i.test(o.name))

  // 옵션1을 고르면 옵션2가 AJAX로 채워지는 몰(예: 신우) 대응 — 뒤쪽 select가 비어있는데 앞쪽엔 실값이
  // 있으면, 앞쪽 값을 하나씩 실제로 선택(change 이벤트 발생)해보고 그 결과로 채워지는 뒤쪽 옵션을 모은다.
  // 안전상 뒤쪽(둘째) select는 절대 값을 바꾸거나 change를 일으키지 않는다 — 읽기만 한다(장바구니 등
  // 실제 동작으로 이어지는 onChange가 걸려있을 수 있어서).
  let cascadeStockKnown = false
  let cascadeHasStock = false
  // 옵션1 값마다 옵션2 목록이 실제로 다른 몰(신우 등 — 색상별 구매 가능한 사이즈가 다름)을 위해, 합쳐진
  // options와 별개로 [옵션1값, 옵션2값] 쌍을 그대로 남긴다 — collected(Set)로 합치면 어느 옵션1에 어느
  // 옵션2가 실제로 딸려 나오는지 사라진다.
  let optionCombinations = []
  for (let i = 0; i < selectEls.length - 1; i++) {
    const first = selectEls[i]
    const second = selectEls[i + 1]
    const firstValues = realValues(first)
    if (firstValues.length === 0 || realValues(second).length > 0) continue
    cascadeStockKnown = true
    const collected = new Set()
    for (const val of firstValues) {
      first.value = val
      first.dispatchEvent(new Event('change', { bubbles: true }))
      const beforeCount = second.options.length
      for (let waited = 0; waited < 2000; waited += 150) {
        await new Promise(r => setTimeout(r, 150))
        if (second.options.length !== beforeCount) break
      }
      const afterValues = realValues(second)
      afterValues.forEach(v => collected.add(v))
      afterValues.forEach(v => optionCombinations.push([val, v]))
      if (afterValues.length > 0) cascadeHasStock = true
    }
    if (collected.size > 0) {
      const secondName = second.getAttribute('title') || second.name || second.id || ''
      const merged = { name: secondName, values: Array.from(collected) }
      const idx = options.findIndex(o => o.name === secondName)
      if (idx >= 0) options[idx] = merged
      else options.push(merged)
    }
    break
  }

  // 캐스케이드(옵션1→옵션2 AJAX) 재고 판정이 가능하면 그게 최우선이다 — 신우처럼 "선택(1),(2)에 옵션이
  // 없으면 품절"이라는 안내 문구 자체가 모든 상품 페이지에 고정으로 박혀있는 몰이 있어(실제 발견된 사례:
  // "상세정보에는 있으나 선택(1), (2)에 사이즈,색상 등이 선택이 되지 않는 것은 품절입니다."라는 일반
  // 안내문이 매 상품마다 "품절" 텍스트로 잡혀 실제 재고와 무관하게 전부 품절로 오판정됐다), 페이지 전체
  // 텍스트에서 "품절"을 찾는 방식은 이런 안내문과 실제 재고 배지를 구분 못 한다.
  const stockText = document.body.innerText.match(/품절|일시품절|재입고|단종/)?.[0] || ''
  let stockStatus = '판매중'
  if (cascadeStockKnown) stockStatus = cascadeHasStock ? '판매중' : '품절'
  else if (/품절/.test(stockText)) stockStatus = '품절'
  else if (/단종/.test(stockText)) stockStatus = '단종'

  const u = new URL(location.href)
  const pathMatch = location.pathname.match(/\\/product\\/[^/]+\\/(\\d+)\\/category\\//)
  const code = pathMatch?.[1] || u.searchParams.get('product_no') || u.searchParams.get('branduid') || u.searchParams.get('goodsno') || u.searchParams.get('brandcode') || location.href

  const result = {
    name, price, sale_price: price, cost_price: costPrice, shipping_fee: shippingFee,
    // "브랜드" 카테고리 노드에서 뽑은 값이 가장 확실하다 — ld+json의 brand는 상품별 브랜드를 안 채운
    // 몰이 자기 몰 이름을 기본값으로 넣어두는 경우가 흔해 그보다 우선한다.
    brand: brandFromCategoryDetail || brand, manufacturer: '', origin: '', category: categoryFromDetail || '', description,
    options, option_combinations: optionCombinations, thumbnail_urls: mainImages, thumbnail_names: [], detail_image_urls: detailImages, detail_image_names: [],
    detail_text: (detailContainer?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    // lib/extract.ts와 같은 방식(2026-09-05 전수조사로 발견: 이 확장은 infoRows를 도매가/배송비 등
    // 정해진 라벨 조회에만 쓰고 요약정보/영문상품명/그 외 라벨은 전부 빈 값으로 버리고 있었다 — 상품정보
    // 고시 표에 있는 소재/색상/치수 등 부가정보가 개발자모드 Raw 데이터에서만 통째로 빠짐).
    summary_info: infoValue(/상품요약정보/i), english_name: infoValue(/영문상품명/i),
    extra_info: infoRows.filter(([, value]) => value).map(([label, value]) => ({ label, value })),
    stock_status: stockStatus, stock_qty: null,
    stock_by_option: [], mall_product_code: code, custom_fields: {},
  }

  // 유통기한/소비기한은 라벨이 어느 몰이든 거의 항상 같아 몰별 규칙 없이도 일반화해 뽑을 수 있다(lib/
  // extract.ts와 동일). "상품필수정보" 표의 나머지 라벨(소재/색상/치수 등)도 이미 전용 필드로 뽑아낸
  // 라벨과 겹치지 않는 것만 custom_fields에 각각 담아 Raw 확인 화면에서 바로 구분해 볼 수 있게 한다.
  const expiry = infoValue(/유통기한|소비기한/i)
  if (expiry) result.custom_fields['유통기한'] = expiry
  const CLAIMED_INFO_LABEL_RE = /브랜드|제조사|제조자|원산지|제조국|상품요약정보|영문상품명|유통기한|소비기한|상품코드|정가|판매가|소비자가|시중가|정상가|공급가|도매가|배송비|택배비/i
  infoRows.forEach(([label, value]) => {
    if (value && !CLAIMED_INFO_LABEL_RE.test(label)) result.custom_fields[label] = value
  })

  // 라벨/셀렉터/고정값 규칙 하나를 실제 텍스트로 풀어낸다 — 단일 규칙과 'multi' 규칙의 각 조각이
  // 공유하는 로직(lib/extract.ts의 resolveLabelOrSelector와 같은 규칙 형식을 그대로 옮김).
  const resolvePart = (part) => {
    if (part.type === 'fixed') return part.value
    if (part.type === 'label') return infoValue(new RegExp(part.value)) || null
    const el = document.querySelector(part.value)
    if (!el) return null
    // <select>는 예외 — 옵션1~3 같은 필드를 <select> 자체에 클릭 지정하면(lib/scraper.ts의
    // selectOptionsDisplayText와 항상 같이 반영) textContent를 그대로 읽었을 때 안내문+모든 옵션이
    // 구분자 없이 뭉쳐 나온다. 실제 선택 가능한 옵션 값만 쉼표로 구분해 합친다.
    if (el.tagName === 'SELECT') {
      return Array.from(el.options).filter(o => o.value).map(o => (o.textContent || '').trim()).filter(Boolean).join(', ')
    }
    return (el.textContent || '').trim()
  }
  const extractionRules = ${JSON.stringify(rules)}
  for (const [field, rule] of Object.entries(extractionRules)) {
    // "스크랩 대상 직접지정"에서 ✕(삭제)를 누르면 규칙을 아예 없애는 대신 빈 고정값을 남겨둔다(lib/scraper.ts
    // 참고) — 사용자가 "이 필드는 값이 없어야 한다"고 명시적으로 확정한 것이므로, 위에서 이미 채워둔
    // 자동/휴리스틱 추출값을 여기서 강제로 지운다. lib/extract.ts와 동일한 분기(2026-09-05 전수조사로
    // 발견: 이 분기가 없어 그냥 continue로 넘어가버려, 규칙을 지워도 예전 자동추출 값이 계속 남아있었다).
    if (rule.type === 'fixed' && rule.value === '') {
      if (field === 'price') { result.price = null; result.sale_price = null }
      else if (field === 'cost_price') result.cost_price = null
      else if (field === 'shipping_fee') result.shipping_fee = null
      else if (field === 'stock_qty') result.stock_qty = null
      else if (field === 'thumbnail_urls') { result.thumbnail_urls = []; result.thumbnail_names = [] }
      else if (field === 'detail_image_urls') { result.detail_image_urls = []; result.detail_image_names = [] }
      else if (field === 'name' || field === 'brand' || field === 'manufacturer' || field === 'origin' || field === 'category'
        || field === 'stock_status' || field === 'english_name' || field === 'summary_info') {
        result[field] = ''
      } else {
        delete result.custom_fields[field]
      }
      continue
    }
    // 대표/상세이미지는 값 하나가 아니라 URL 배열이라 아래 텍스트 기반(resolvePart) 처리와 다르게 다룬다
    // — lib/extract.ts의 같은 분기와 동일(2026-09-05 전수조사로 발견: 이 분기가 없어 selector 규칙은
    // el.textContent가 비어 조용히 무시되고, fixed 규칙은 이미지 URL 문자열이 custom_fields에 잘못
    // 들어갔다 — 사용자가 "스크랩 대상 직접지정"으로 대표/상세이미지를 커스텀 지정해도 전혀 반영 안 됨).
    if (field === 'thumbnail_urls' || field === 'detail_image_urls') {
      let urls = []
      if (rule.type === 'fixed') {
        urls = rule.value.split(/[,\\n]/).map(s => s.trim()).filter(Boolean)
      } else if (rule.type === 'multi') {
        let parts = []
        try { parts = JSON.parse(rule.value) } catch { parts = [] }
        const collected = []
        for (const part of parts) {
          if (part.type === 'fixed') {
            collected.push(...part.value.split(/[,\\n]/).map(s => s.trim()).filter(Boolean))
          } else {
            collected.push(...Array.from(document.querySelectorAll(part.value)).map(el => el.src).filter(Boolean))
          }
        }
        urls = [...new Set(collected)]
      } else {
        urls = Array.from(document.querySelectorAll(rule.value)).map(el => el.src).filter(Boolean)
      }
      if (urls.length) {
        const names = urls.map(u => { try { return decodeURIComponent(u.split('/').pop() || '') } catch { return u } })
        if (field === 'thumbnail_urls') { result.thumbnail_urls = urls; result.thumbnail_names = names }
        else { result.detail_image_urls = urls; result.detail_image_names = names }
      }
      continue
    }
    let text = null
    if (rule.type === 'multi') {
      // "스크랩 대상 직접지정"에서 값 하나를 여러 조각(라벨+셀렉터 등)으로 나눠 저장한 규칙 —
      // lib/extract.ts와 같은 형식(JSON 배열)이라 여기도 똑같이 풀어서 공백으로 이어붙인다. 이 분기가
      // 없으면 rule.value(JSON 문자열 그대로)를 CSS 셀렉터로 오인해 querySelector가 SyntaxError를
      // 던진다(2026-08-22, 모자사러 실사용 중 발견 — name/category/cost_price/shipping_fee 규칙이
      // 전부 이 형식이라 스크랩이 대량 실패했다).
      let parts = []
      try { parts = JSON.parse(rule.value) } catch { parts = [] }
      const resolved = parts.map(resolvePart).filter(Boolean)
      text = resolved.length ? resolved.join(' ') : null
    } else {
      text = resolvePart(rule)
    }
    const trimmed = text ? text.trim() : ''
    if (!trimmed) continue

    if (field === 'price' || field === 'cost_price' || field === 'shipping_fee') {
      const m = trimmed.match(/[\\d,]{2,}/)
      if (!m) continue
      const n = Number(m[0].replace(/,/g, ''))
      if (field === 'price') { result.price = n; result.sale_price = n }
      else if (field === 'cost_price') result.cost_price = n
      else result.shipping_fee = n
    } else if (field === 'stock_qty') {
      const m = trimmed.match(/[\\d,]+/)
      if (m) result.stock_qty = Number(m[0].replace(/,/g, ''))
    } else if (field === 'name' || field === 'brand' || field === 'manufacturer' || field === 'origin' || field === 'category'
      || field === 'stock_status' || field === 'english_name' || field === 'summary_info') {
      result[field] = trimmed
    } else {
      result.custom_fields[field] = trimmed
    }
  }

  return result
})()`
}

async function report(url, product) {
  const res = await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, url, product }),
  })
  const data = await res.json()
  if (data.sessionId) sessionId = data.sessionId
  return data
}

// 추출이 실패한 상품도 PTP에 알려야, 진행상황 화면의 "수집 실패" 목록과 "실패만 재시도"가 개발자모드에서도
// 동작한다 — 예전에는 콘솔에만 찍고 끝나서 PTP는 어떤 상품이 왜 실패했는지 전혀 알 방법이 없었다.
async function reportFailure(url, errorMessage) {
  const res = await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, url, error: String(errorMessage || '알 수 없는 오류').slice(0, 500) }),
  })
  const data = await res.json().catch(() => ({}))
  if (data.sessionId) sessionId = data.sessionId
}

/** 카테고리를 하나씩 순회하기 시작할 때마다 호출 — 세션이 아직 없으면(sessionId===null) 이 호출이
 *  만들어준다(report()/reportFailure()와 같은 패턴). 이미 받은 상품이 많은 카테고리는 앞쪽 페이지를
 *  전부 건너뛰기만 하느라 상품을 하나도 저장 못 한 채 몇 분씩 지날 수 있는데, 그동안 세션 자체가 없으면
 *  PTP가 "진행 중"이라는 걸 전혀 감지 못한다(2026-08-22, 사용자 지적: "PTP 상에서는 아무런 변화가
 *  없는 상태야"). done/total은 lib/scraper.ts의 getCollectProgress와 같은 자리(카테고리 N/M)에 실린다. */
async function reportCollectProgress(done, total) {
  const res = await fetch(PROGRESS_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, done, total }),
  }).catch(() => null)
  const data = await res?.json().catch(() => null)
  if (data?.sessionId) sessionId = data.sessionId
}

async function reportDone(stopped, concurrencyLog) {
  if (!sessionId) return
  await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, done: true, stopped: !!stopped, concurrencyLog }),
  }).catch(() => {})
}

/**
 * categoryUrls(PTP "카테고리 불러오기"에서 체크해둔 목록)가 있으면 그 목록을 순서대로 각각 끝까지(다음
 * 페이지까지) 처리하고, 없으면(기존 동작 그대로) "지금 탭 위치" 하나만 다음 링크를 따라간다 — 일반모드가
 * 여러 카테고리를 한 번에 스크랩하는 것과 같은 편의를 개발자모드에도 주기 위함(2026-08-15). 카테고리
 * 사이를 옮겨 다닐 때도 여전히 같은 실제 탭(chrome.debugger)만 쓴다 — 새 브라우저 컨텍스트를 띄우지
 * 않으므로 개발자모드가 원래 존재하는 이유(자동화 감지 회피)와 충돌하지 않는다.
 */
// 목록 페이지 탐색(다음 페이지 링크 찾기)은 원래 탭 하나로 순서대로 해야 하지만(다음 페이지 URL은
// 현재 페이지를 봐야 안다), 그렇게 찾은 상품 링크들을 실제로 방문해 추출하는 부분은 서로 완전히
// 독립적이라 병렬화 대상이다 — runExpandCategories와 같은 이유(2026-08-22, 사용자 요청). 이 스크랩은
// 몇 분에서 수십 분 걸릴 수 있는 긴 작업이라, 탭을 추가로 열지 못하면(브라우저 제한 등) 원래 탭
// 하나만으로 조용히 낮은 동시 개수로 이어가고(안 그러면 몇 분 진행된 스크랩이 통째로 실패로 끝난다),
// runExpandCategories처럼 실패를 그대로 던지지 않는다.
// 일반모드(lib/scraper.ts의 scrapeCatalogPage)와 같은 최대치까지 열어두되, 실제로 동시에 일을 시키는
// 개수(activeLimit, 아래)는 적응형으로 따로 조절한다 — "일반모드처럼 8까지 올리되 문제 생기면 적응형
// 로직을 태우면 되지 않냐"는 요청(2026-08-22)으로, 무작정 8개 고정 대신 그 알고리즘(AIMD)을 그대로 옮겼다.
// 2026-09-05 전수조사로 발견: 일반모드는 2026-08-24에 리소스 실측 후 8→16으로 올렸는데(lib/scraper.ts
// resolveConcurrency 주석), 이 상수는 그때 안 따라와 8에 남아 있었다 — 여기도 16으로 맞춘다.
const SCRAPE_TAB_CONCURRENCY = 16

async function run(tabId, startUrl, categoryUrls, categorySettings, sortOptions, excludeUrls) {
  running = true
  let processed = 0
  let stoppedByUser = false
  const listingStarts = categoryUrls && categoryUrls.length ? categoryUrls : [null]
  // 이 몰에서 이미 성공적으로 수집한 상품(scrape_item_log 기준, resolveSite가 내려줌)은 다시 방문하지
  // 않는다 — 중지 후 "이어서 스크랩하기"나, 예전 300개 상한에 걸렸던 세션 이후 재시작할 때 이미 받은
  // 상품을 처음부터 또 여는 낭비를 없앤다(2026-08-22, 사용자 요청).
  const excludeSet = new Set(excludeUrls || [])

  const extraTabIds = []
  for (let i = 1; i < SCRAPE_TAB_CONCURRENCY; i++) {
    try {
      // chrome.tabs.create 자체엔 시간제한이 없어, 크롬이 짧은 시간에 탭을 대량으로 여는 걸 조용히
      // 늦추거나 막으면(4개에서 8개로 올린 뒤 실사용 중 확인, 2026-08-22 — 몰 탭이 아예 멈춘 것처럼
      // 보이고 에러도 없었음) 이 루프 전체가 영원히 멈춰 run()이 시작도 못 한다. attachDebugger처럼
      // withTimeout으로 감싸 시간이 오래 걸리면 그 시점까지 연 탭만으로 진행한다.
      const t = await withTimeout(chrome.tabs.create({ url: 'about:blank', active: false }), 8_000, '탭 생성')
      await attachDebugger(t.id)
      extraTabIds.push(t.id)
    } catch (e) {
      console.log(`[PTP] 병렬 처리용 탭을 여는 데 실패해 동시 ${extraTabIds.length + 1}개로 진행합니다:`, e.message)
      break
    }
  }
  const workerTabIds = [tabId, ...extraTabIds]

  // 적응형 동시성(AIMD) — lib/scraper.ts의 scrapeCatalogPage와 같은 원리: 1(가장 안전)부터 시작해 연속
  // 성공이 쌓이면 서서히 올리고, 차단으로 추정되는 응답이 나오면 즉시 1로 낮추고 잠시 쉰다. 열어둔 탭
  // 수(workerTabIds.length, 최대 8)는 그대로 두고 "몇 번째 탭까지 실제로 일을 시킬지"만 오르내린다 —
  // 탭을 매번 새로 열고 닫는 것보다 훨씬 가볍다.
  const MAX_CONCURRENCY = workerTabIds.length
  const RAMP_UP_STREAK = 5
  let activeLimit = 1
  let okStreak = 0
  const concurrencyLog = []

  // lib/scraper.ts의 scrapeOne과 같은 값(RETRY_COUNT=2) — 차단으로 추정되면 저장 전에 몇 번 더 방문해본다.
  const PRODUCT_BLOCK_RETRY_COUNT = 2

  /** 상품 1건 방문·추출·보고 — 성공/실패 모두 여기서 끝낸다(호출부는 카운터만 올리면 됨). blocked는
   *  lib/scraper.ts의 scrapeOne과 같은 휴리스틱(가격/원가/대표이미지가 전부 없으면 정상 상품 페이지가
   *  아니라 봇 차단/오류 안내 페이지일 가능성이 높음)으로 판정한다.
   *  2026-09-05 전수조사로 발견: 이 함수는 원래 blocked여도 그 "빈 상품"을 그대로 저장했다(재시도도,
   *  차단 확정 시 저장 건너뛰기도 없었음) — 서버(scrapeOne)는 최대 PRODUCT_BLOCK_RETRY_COUNT번 재시도
   *  후에도 안 풀리면 저장하지 않고 실패로만 남긴다. AI 폴백(tryAiFallback)은 서버에서만 가능한 별도
   *  기능이라(Node가 직접 AI API를 부르는 구조) 여기엔 포팅하지 않았다 — 재시도+저장보류까지만 맞춘다. */
  async function processProduct(workerTabId, link, category, brandFromCategory) {
    let lastError = null
    let blocked = false
    for (let attempt = 0; attempt <= PRODUCT_BLOCK_RETRY_COUNT; attempt++) {
      try {
        await navigate(workerTabId, link)
        const product = await evalInTab(workerTabId, buildExtractExpr(extractionRules))
        // 카테고리는 상품 상세페이지가 아니라 방금 있던 목록(카테고리) 페이지에서만 알 수 있으므로,
        // 상세페이지 추출 결과 위에 덮어씌운다.
        if (category) product.category = category
        if (brandFromCategory) product.brand = brandFromCategory
        if (product.price == null && product.cost_price == null && !product.thumbnail_urls.length) {
          blocked = true
          throw new Error('가격/이미지를 모두 찾지 못함 (차단 또는 일시 오류로 추정)')
        }
        const result = await report(link, product)
        console.log('[PTP] 저장:', product.name, result)
        return { blocked: false }
      } catch (e) {
        lastError = e
        if (attempt < PRODUCT_BLOCK_RETRY_COUNT) { await delay(2_000 * (attempt + 1) + Math.random() * 2_000); continue }
      }
    }
    console.log('[PTP] 추출 실패:', link, lastError?.message)
    await reportFailure(link, lastError?.message || '알 수 없는 오류').catch(() => {})
    return { blocked }
  }

  /** lib/scraper.ts의 worker() 안 AIMD 조정과 동일한 규칙 — 차단이면 즉시 1로 낮추고 5초 쉬며, 연속
   *  성공이 RAMP_UP_STREAK번 쌓이면 1씩 올린다. */
  async function applyConcurrencyResult(blocked) {
    if (blocked) {
      okStreak = 0
      if (activeLimit > 1) {
        activeLimit = 1
        concurrencyLog.push({ at: new Date().toISOString(), level: 1, reason: 'block_detected' })
        await delay(5_000)
      }
    } else {
      okStreak++
      if (okStreak >= RAMP_UP_STREAK && activeLimit < MAX_CONCURRENCY) {
        activeLimit++
        okStreak = 0
        concurrencyLog.push({ at: new Date().toISOString(), level: activeLimit, reason: 'ramp_up' })
      }
    }
  }

  try {
    outer:
    for (const [categoryIdx, listingStart] of listingStarts.entries()) {
      await reportCollectProgress(categoryIdx, listingStarts.length)
      // 카테고리별 정렬/상한 설정 — href 원본 그대로 저장돼 있으므로(devmode_category_settings, ScraperPanel.tsx
      // buildCategoryUrlsAndLimits와 같은 이유) 여기서 키로 그대로 조회한다. categoryProcessed/pageNum은
      // 카테고리마다 새로 시작하는 지역 카운터다(상한이 "이 카테고리 안에서 몇 개/몇 페이지"이기 때문).
      const setting = listingStart ? categorySettings?.[listingStart] : null
      let categoryProcessed = 0
      let pageNum = 1
      if (listingStart) {
        const chosenSort = findChosenSortOption(setting, sortOptions || [])
        await navigate(tabId, bakeSortUrl(listingStart, setting, sortOptions || []))
        await throttle()
        // kind:'click'(AJAX 정렬, URL에 안 실림)은 URL을 구워도 아무 효과가 없으므로 여기서 실제로
        // 선택/클릭까지 해줘야 한다(applySortByClicking 주석 참고) — bakeSortUrl은 kind:'query'만 처리한다.
        if (chosenSort?.kind === 'click') await applySortByClicking(tabId, chosenSort.clickText)
      }
      while (processed < MAX_PRODUCTS) {
        const { links, nextUrl, category, brandFromCategory } = await evalInTab(tabId, COLLECT_LINKS_EXPR)
        console.log(`[PTP] 이 페이지에서 상품 ${links.length}개 발견`)
        if (links.length === 0) {
          const diag = await evalInTab(tabId, `({
            title: document.title,
            url: location.href,
            totalLinks: document.querySelectorAll('a').length,
            totalImgs: document.querySelectorAll('img').length,
            productDetailLinks: Array.from(document.querySelectorAll('a[href*="detail.html"], a[href*="product_no"]')).map(a => a.getAttribute('href')).slice(0, 10),
            linksContainingProduct: [...new Set(Array.from(document.querySelectorAll('a[href*="/product/"]')).map(a => a.getAttribute('href')))].slice(0, 15),
            onclickWithProduct: Array.from(document.querySelectorAll('[onclick]'))
              .map(el => el.getAttribute('onclick')).filter(v => /product|detail|prdNo|prd_no/i.test(v)).slice(0, 10),
            classesLikePrd: [...new Set(Array.from(document.querySelectorAll('[class*="prd" i], [class*="item" i], [class*="goods" i]')).map(el => el.className))].slice(0, 15),
            firstPrdListItemHtml: document.querySelector('.prdList_normal li, .prdList_normal > *')?.outerHTML.slice(0, 2000) || null,
            bodyTextSample: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
          })`)
          console.log('[PTP] 진단 정보:', JSON.stringify(diag, null, 2))
        }
        // 개수 상한(count 모드)이면 이 페이지에서 남은 만큼만 처리한다 — "다음 페이지 존재 여부"(nextUrl)
        // 판정 자체는 건드리지 않는다(lib/scraper.ts의 collectFromListing과 같은 원칙: dead-end 감지는
        // 항상 전체 목록 기준).
        const countLimit = setting?.limitMode === 'count' ? setting.limitValue : null
        const freshLinks = excludeSet.size ? links.filter(l => !excludeSet.has(l)) : links
        const pageLinks = countLimit ? freshLinks.slice(0, Math.max(0, countLimit - categoryProcessed)) : freshLinks

        // report()는 sessionId가 아직 없으면(이 run() 전체에서 첫 상품) 서버가 새 세션을 만들어 응답으로
        // 돌려준다 — 그 첫 1건만은 여러 워커가 동시에 sessionId:null로 보내 세션이 여러 개로 쪼개지지
        // 않도록 혼자 먼저 처리해 sessionId를 확정한 뒤, 나머지부터 병렬로 넘긴다(2026-08-22).
        let startIdx = 0
        if (pageLinks.length && !sessionId) {
          if (await checkStopRequested(sessionId)) { stoppedByUser = true; break outer }
          const { blocked } = await processProduct(tabId, pageLinks[0], category, brandFromCategory)
          applyConcurrencyResult(blocked)
          processed++
          categoryProcessed++
          startIdx = 1
          await throttle()
        }

        const remaining = pageLinks.slice(startIdx)
        if (remaining.length) {
          let cursor = 0
          await Promise.all(workerTabIds.map(async (workerTabId, workerIndex) => {
            while (true) {
              // processed/stoppedByUser는 워커들 사이의 동기 구간(await 없는 부분)에서만 읽고 써서
              // 경쟁이 없다 — 다만 여러 워커가 "아직 상한 안 됨"을 동시에 확인한 뒤 각자 처리를 시작할
              // 수 있어(그 시점엔 서로의 완료를 모름) MAX_PRODUCTS/countLimit을 최대 동시 개수만큼
              // 살짝 넘길 수 있다 — 둘 다 원래도 정확한 하드 리밋이 아니라 "이쯤에서 배치를 끊는다"는
              // 안전장치라 여유로 둔다.
              if (processed >= MAX_PRODUCTS || stoppedByUser) return
              // 이 워커의 순번이 지금 활성 한도보다 높으면(아직 한도가 안 올라왔거나 방금 차단으로
              // 낮아졌으면) 새 탭을 열어둔 채로 대기만 한다 — lib/scraper.ts의 worker()와 동일.
              while (workerIndex >= activeLimit) {
                if (processed >= MAX_PRODUCTS || stoppedByUser) return
                if (cursor >= remaining.length) return
                await delay(500)
              }
              // PTP의 "스크래핑 중지" 버튼이 눌렸는지 상품마다 확인한다 — 다음 상품으로 넘어가기 전에 반영된다.
              if (await checkStopRequested(sessionId)) {
                console.log('[PTP] 중지 요청을 확인해 스크래핑을 멈춥니다.')
                stoppedByUser = true
                return
              }
              const i = cursor++
              if (i >= remaining.length) return
              const { blocked } = await processProduct(workerTabId, remaining[i], category, brandFromCategory)
              applyConcurrencyResult(blocked)
              processed++
              categoryProcessed++
              await throttle()
            }
          }))
        }
        if (stoppedByUser) break outer

        const reachedCountLimit = countLimit != null && categoryProcessed >= countLimit
        const reachedPageLimit = setting?.limitMode === 'pages' && setting.limitValue && pageNum >= setting.limitValue
        if (!nextUrl || reachedCountLimit || reachedPageLimit) break
        pageNum++
        await navigate(tabId, nextUrl)
        await throttle()
      }
    }
    console.log(stoppedByUser ? `[PTP] 중지됨 — 총 ${processed}개 처리` : `[PTP] 완료 — 총 ${processed}개 처리`)
  } finally {
    await reportDone(stoppedByUser, concurrencyLog)
    // 목록 페이지로 되돌려놔야 다음 클릭 때 다시 상품 페이지로 오인하지 않는다.
    if (startUrl) await navigate(tabId, startUrl).catch(() => {})
    for (const id of extraTabIds) {
      await safeDetach(id)
      await chrome.tabs.remove(id).catch(() => {})
    }
    running = false
  }
}

/** "스크랩 시작" — 팝업의 "🔄 스크랩 시작" 버튼이 메시지로 호출하는 본체. default_popup을 등록한 뒤로는
 *  아이콘 클릭이 항상 팝업을 여는 것으로 바뀌어(브라우저 자체 규칙) 예전처럼 chrome.action.onClicked로
 *  직접 시작할 수 없다 — 그래서 팝업 버튼 → 메시지 → 이 함수 순서로 바뀌었다. */
async function startScrape(tab, site) {
  if (running) { console.log('[PTP] 이미 실행 중입니다.'); return { ok: false, error: '이미 실행 중입니다' } }
  siteId = site.id
  extractionRules = site.extractionRules
  sessionId = null

  try {
    await attachDebugger(tab.id)
  } catch (e) {
    console.log('[PTP] debugger attach 실패:', e.message)
    return { ok: false, error: `디버거 연결 실패: ${e.message}` }
  }
  // run()은 상품 여러 개를 순회하며 오래 걸릴 수 있어(수 분) 완료를 기다리지 않고 백그라운드로 흘려보낸다
  // — 팝업은 "시작했다"는 응답만 받고, 진행상황은 PTP 화면의 기존 5초 폴링이 이어받는다. site.categoryUrls가
  // 있으면(PTP에서 카테고리를 체크해뒀으면) 그 목록을 전부 순회하고, 없으면 기존처럼 지금 탭 위치만 처리한다.
  run(tab.id, tab.url, site.categoryUrls, site.categorySettings, site.sortOptions, site.excludeUrls).finally(() => safeDetach(tab.id))
  // "이어서 받는 건지 처음부터인지 알 수가 없다"는 지적(2026-08-22) — 팝업이 바로 닫히지 않고 열려있는
  // 그 순간의 응답 메시지로 알려준다. skipCount는 resolveSite가 내려준 excludeUrls(이미 성공한 상품)
  // 개수 그대로다.
  return { ok: true, skipCount: (site.excludeUrls || []).length }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ptp-preview', title: 'PTP 스크랩 미리보기 실행', contexts: ['page'] }, () => void chrome.runtime.lastError)
  chrome.contextMenus.create({ id: 'ptp-picker', title: 'PTP 스크랩 대상 직접지정', contexts: ['page'] }, () => void chrome.runtime.lastError)
})

/** 지수 확장(1,2,4,8...페이지씩 건너뛰며 빈/반복 페이지를 찾음) + 그 사이를 이분탐색 — lib/scraper.ts의
 *  findRealLastPage와 같은 알고리즘의 핵심만 이식했다(2026-09-06, 사용자 요청 — AI 추측 대신 결정론적인
 *  방법이 더 낫다는 판단: "몰별로 다양한 경우가 있을 수 있는 거라, 지금 문제가 없었다고 확신할 수 없다").
 *  서버 쪽의 HTTP 경량화·현재페이지 위젯 판독 등 부가 최적화는 이식하지 않았지만, 실제 버그를 낳았던
 *  핵심 안전장치 두 가지는 그대로 가져왔다: (1) "끝처럼 보임"(개수 0 또는 반복 콘텐츠)은 반드시 같은
 *  페이지를 한 번 더 확인해야 믿는다(confirmedEnd) — 일시적 빈 응답 하나만 보고 끝으로 확정하면 실제
 *  더 있는데 일찍 멈춘다(걸스굽/진짜양말 실사용 버그). (2) 페이지 번호가 범위를 벗어나도 에러 대신 마지막
 *  유효 페이지를 그대로 반복해서 돌려주는 몰(clamp)이 있어, 콘텐츠 핑거프린트(링크 목록을 정렬해 이어붙인
 *  문자열)가 직전과 같으면 "새 페이지"가 아니라 반복으로 본다(seasonbag.co.kr 실사용 확인). 로그인 벽에
 *  걸리면 그 즉시 지금까지 확인한 값으로 멈춘다. bound까지도 끝을 못 찾으면 null — 호출부가 기존 완전
 *  탐색(느리지만 URL 파라미터 대신 실제 "다음" 링크를 따라가므로, page= 파라미터 자체가 안 먹는 몰에서도
 *  안전한 최후의 보루)으로 폴백한다. */
async function findLastPageBinarySearch(tabId, firstPageUrl, knownNonEmptyCount, bound, siteId) {
  async function probeAt(pageNum) {
    await navigate(tabId, withPageParam(firstPageUrl, pageNum))
    await throttle()
    const r = await evalInTab(tabId, COLLECT_LINKS_EXPR)
    return { count: r.links.length, fingerprint: r.links.slice().sort().join('|'), isLoginPage: !!r.isLoginPage }
  }
  async function confirmedEnd(pageNum, dupFingerprint) {
    const r = await probeAt(pageNum)
    return r.count === 0 || r.fingerprint === dupFingerprint
  }

  let lo = 1
  let loCount = knownNonEmptyCount
  let loFingerprint = null
  let hi = null
  let step = 1

  while (hi === null) {
    // "중지" 버튼 요청 — 완전탐색만큼 오래는 아니어도 이분탐색도 대형 카테고리에서는 여러 페이지를
    // 도니, 여기서도 매 probe 전에 확인해야 그 순간 멈춘다(2026-09-06).
    if (await checkDevPreviewStopRequested(siteId)) return { page: lo, count: loCount }
    const probe = lo + step
    if (probe > bound) return null
    const r = await probeAt(probe)
    if (r.isLoginPage) return { page: lo, count: loCount }
    const looksLikeEnd = r.count === 0 || r.fingerprint === loFingerprint
    if (looksLikeEnd && await confirmedEnd(probe, loFingerprint)) { hi = probe; continue }
    const next = await probeAt(probe + 1)
    if (next.isLoginPage) return { page: lo, count: loCount }
    if (next.count > 0 && next.fingerprint === r.fingerprint) { hi = probe; continue }
    lo = probe; loCount = r.count; loFingerprint = r.fingerprint; step *= 2
  }
  while (hi - lo > 1) {
    if (await checkDevPreviewStopRequested(siteId)) return { page: lo, count: loCount }
    const mid = Math.floor((lo + hi) / 2)
    const r = await probeAt(mid)
    if (r.isLoginPage) return { page: lo, count: loCount }
    const looksLikeEnd = r.count === 0 || r.fingerprint === loFingerprint
    if (looksLikeEnd && await confirmedEnd(mid, loFingerprint)) hi = mid
    else { lo = mid; loCount = r.count; loFingerprint = r.fingerprint }
  }
  return { page: lo, count: loCount }
}

/** 카테고리(목록) 페이지부터 다음 페이지까지 따라가며 상품 링크 전체를 모은다 — "스크랩 미리보기 실행"이
 *  일반모드의 previewCatalog처럼 정확한 총 개수를 보여줄 수 있게 끝까지 페이징한다. 개수만 세는 용도라
 *  run()의 MAX_PRODUCTS(실제 상세페이지를 방문·추출하는 세션 하나당 상품 수 제한, 그래서 300개씩
 *  나눠 실행하는 설계)와는 성격이 달라 그 상한을 공유하지 않는다 — 목록 페이지의 링크만 세는 건 상세
 *  추출만큼 비용이 크지 않다(2026-08-17, 걸스굽 "SOLD OUT"이 MAX_PRODUCTS(300)에서 조용히 잘려 실제보다
 *  훨씬 적게 보고된 문제 수정). 지금 페이지 자체가 이미 상품 상세 페이지라 링크가 하나도 안 잡히면
 *  빈 목록을 그대로 돌려준다 — 호출부(runPreview)가 그 경우 지금 페이지 자체를 상품 1건으로 처리한다.
 *  truncated는 "다음 페이지"가 있는데도 상한(MAX_PREVIEW_PAGES)에 걸려 멈췄다는 뜻 — 호출부가 이 값을
 *  그대로 개수와 함께 보여줘 정직하게 "이 이상"임을 알릴 수 있게 한다.
 *  fastCountOk(카테고리를 여러 개 선택했을 때만 true — 그때는 개수만 필요하고 전체 목록은 필요 없음)면
 *  1페이지에서 buildPaginationSignalExpr로 "총 N개"/"마지막 페이지" 신호를 먼저 찾아보고, 있으면
 *  최대 2페이지(1페이지 + 마지막 페이지)만 열어 정확한 개수를 곧바로 확정한다 — 못 찾으면(위젯이 없는
 *  스킨 등) 기존처럼 한 페이지씩 순회한다. */
async function collectCategoryLinks(tabId, fastCountOk, siteId) {
  const linkOrder = []
  const linkInfo = {}
  const categoryByUrl = {}
  const addPage = (result) => {
    result.links.forEach(href => {
      if (href in linkInfo) return
      linkOrder.push(href)
      linkInfo[href] = result.linkInfo[href] || { name: '', thumbnail: '' }
      if (result.category) categoryByUrl[href] = { category: result.category, brandFromCategory: result.brandFromCategory }
    })
  }

  const first = await evalInTab(tabId, COLLECT_LINKS_EXPR)
  addPage(first)
  const perPage = first.links.length
  // 지수+이분 탐색(아래)이 매 probe마다 이 페이지(1페이지)로 기준을 삼아 page= 파라미터를 갈아끼우므로,
  // 다른 지름길이 먼저 tab.url을 바꿔버리기 전에(예: lastPage 버튼 시도) 지금 이 시점의 URL을 미리 남겨둔다.
  const categoryFirstPageUrl = (await chrome.tabs.get(tabId)).url
  // 링크가 하나도 없는 게 "이 카테고리엔 원래 상품이 없어서"인지 "로그인이 안 돼 있어서"인지 구분한다
  // — lib/scraper.ts의 countProductsOnPage/isLoginPage와 같은 신호(2026-09-05 전수조사로 발견: 이 확장
  // 쪽 "스크랩 미리보기"는 이 구분이 아예 없어, 로그인이 끊긴 채 미리보기를 돌리면 모든 선택 카테고리가
  // 조용히 "0건"으로 보이고 categoryCounts가 통째로 비어 "미확인"만 남았다 — 개수 문제처럼 보였지만
  // 실제 원인은 로그인 상태였다).
  const needsLogin = perPage === 0 && !!first.isLoginPage

  if (fastCountOk && perPage > 0) {
    const leafLabel = (first.category || '').split(' > ').pop()?.trim() || ''
    const signal = await evalInTab(tabId, buildPaginationSignalExpr(leafLabel)).catch(() => null)
    if (signal?.statedTotal) return { links: linkOrder, linkInfo, categoryByUrl, truncated: false, count: signal.statedTotal, needsLogin }
    if (signal?.lastPage === 1) return { links: linkOrder, linkInfo, categoryByUrl, truncated: false, count: perPage, needsLogin }
    if (signal?.lastPage && signal.lastPage > 1) {
      const tab = await chrome.tabs.get(tabId)
      await navigate(tabId, withPageParam(tab.url, signal.lastPage))
      await throttle()
      const last = await evalInTab(tabId, COLLECT_LINKS_EXPR)
      addPage(last)
      return { links: linkOrder, linkInfo, categoryByUrl, truncated: false, count: perPage * (signal.lastPage - 1) + last.links.length, needsLogin }
    }
    // 규칙 기반 지름길 3개("총 N개"/"마지막 페이지" 버튼/화면 속 페이지번호 최댓값)가 다 실패했다 —
    // 150페이지 완전탐색(카테고리당 몇 분씩 걸릴 수 있음)으로 곧장 떨어지기 전에, 결정론적인 지수+이분
    // 탐색을 먼저 시도한다(2026-09-06, 사용자 요청 — "몰별로 다양한 경우가 있을 수 있는 거라, AI 추측에
    // 기대는 대신 더 나은 방법으로 개선해달라"). AI(로컬/Groq)에만 기대는 것보다 신뢰도가 높다 — 외부
    // 서비스 가용성/한도/할루시네이션에 의존하지 않고, page= 파라미터가 실제로 페이지를 넘겨주는 몰이면
    // 항상 O(log n)번 안에 정확한 답을 찾는다. bound(=MAX_PREVIEW_PAGES)까지 못 찾으면(예: page=
    // 파라미터가 이 몰에서 아예 안 먹힘) null — 그때만 AI로 한 번 더 시도해보고, 그것도 안 되면 기존
    // 완전탐색(URL 파라미터 대신 실제 "다음" 링크를 따라가므로 이 경우에도 여전히 안전한 최후 수단)으로
    // 폴백한다.
    const binarySearchResult = await findLastPageBinarySearch(tabId, categoryFirstPageUrl, perPage, MAX_PREVIEW_PAGES, siteId).catch(() => null)
    if (binarySearchResult && binarySearchResult.page > 1) {
      return { links: linkOrder, linkInfo, categoryByUrl, truncated: false, count: perPage * (binarySearchResult.page - 1) + binarySearchResult.count, needsLogin }
    }
    // 이분탐색도 실패했을 때만 AI에게 마지막으로 물어본다 — 이 호출 자체가 느리거나 실패해도(Groq/Ollama
    // 둘 다 안 됨 등) 절대 전체 흐름을 막지 않는다.
    if (signal?.candidates?.length) {
      const aiResult = await fetch(`${PTP_ORIGIN}/api/scrape/detect-last-page`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallName: signal.hostname, candidates: signal.candidates, baseUrl: signal.currentUrl }),
      }).then(r => r.json()).catch(() => null)
      const aiHref = aiResult?.href
      if (aiHref) {
        try {
          const n = Number(new URL(aiHref, signal.currentUrl).searchParams.get('page'))
          // 이분탐색과 같은 신뢰 기준을 AI 결과에도 그대로 적용한다(2026-09-06, 재검토로 발견 — AI 경로만
          // 검증 없이 결과를 그대로 믿고 있었다): (1) 상한(bound) 없이 AI가 주는 숫자를 무한정 신뢰하지
          // 않는다 — 이분탐색의 bound와 같은 기준(MAX_PREVIEW_PAGES)을 넘으면 거부한다. (2) "여기가
          // 끝"이라는 이분탐색의 confirmedEnd와 똑같이, AI가 고른 페이지 바로 다음(n+1)을 한 번 더 확인해
          // 실제로 비어있거나(정직한 종료) AI가 고른 페이지와 콘텐츠가 같아야만(clamp) 진짜로 믿는다 —
          // AI가 "마지막"을 "다음 페이지" 링크와 착각했을 경우, 이 재확인에서 n+1에 새 상품이 나와 걸러진다.
          if (Number.isInteger(n) && n > 1 && n <= MAX_PREVIEW_PAGES) {
            await navigate(tabId, aiHref)
            await throttle()
            const last = await evalInTab(tabId, COLLECT_LINKS_EXPR)
            const lastFingerprint = last.links.slice().sort().join('|')
            await navigate(tabId, withPageParam(aiHref, n + 1))
            await throttle()
            const peekNext = await evalInTab(tabId, COLLECT_LINKS_EXPR)
            const peekFingerprint = peekNext.links.slice().sort().join('|')
            const confirmedEnd = peekNext.links.length === 0 || peekFingerprint === lastFingerprint
            if (confirmedEnd) {
              addPage(last)
              return { links: linkOrder, linkInfo, categoryByUrl, truncated: false, count: perPage * (n - 1) + last.links.length, needsLogin }
            }
            console.log(`[PTP] AI가 고른 마지막 페이지(${n})가 재확인에서 끝이 아닌 것으로 나와(다음 페이지에 새 콘텐츠 있음) 신뢰하지 않고 폴백합니다.`)
          }
        } catch {}
      }
    }
  }

  let pages = 1
  let nextUrl = first.nextUrl
  while (nextUrl && pages < MAX_PREVIEW_PAGES) {
    // 최후수단(완전탐색)은 대형 카테고리에서 몇 분씩 걸릴 수 있는 만큼, 중지 요청을 가장 자주 확인해야
    // 하는 자리다(2026-09-06 — "중지를 누르면 그 순간 멈추라"는 요청이 나온 바로 그 느린 경로).
    if (await checkDevPreviewStopRequested(siteId)) break
    await navigate(tabId, nextUrl)
    await throttle()
    const result = await evalInTab(tabId, COLLECT_LINKS_EXPR)
    addPage(result)
    pages++
    nextUrl = result.nextUrl
  }
  const truncated = !!nextUrl && pages >= MAX_PREVIEW_PAGES
  return { links: linkOrder, linkInfo, categoryByUrl, truncated, count: linkOrder.length, needsLogin }
}

/** "스크랩 미리보기 실행" — 일반모드의 "스크랩 미리보기"(previewCatalog)와 같은 절차. PTP에서 카테고리를
 *  선택해뒀으면(site.categoryUrls, run()과 같은 순회 방식) 그 카테고리들을 각각 끝까지 페이징해
 *  카테고리별 개수를 구하고, 그중 첫 카테고리의 첫 상품만 실제로 열어 전체 상세를 캡처한다 — 예전엔
 *  선택한 카테고리와 무관하게 "지금 탭이 보고 있는 페이지" 하나만 봤다(사용자 지적, 2026-08-16: "선택한
 *  카테고리에 대해 미리보기가 되어야 한다"). 카테고리를 선택 안 했으면 예전처럼 지금 페이지 하나만 보고,
 *  그 목록의 나머지 상품 정보(이름/썸네일)까지 items로 채운다(카테고리를 여러 개 선택했을 때는 일반모드의
 *  previewCatalog와 같은 이유로 개수만 본다 — 실제 목록은 스크랩 시작 때 얻으므로). 링크가 하나도 안
 *  잡히면(카테고리 미선택 + 지금 페이지 자체가 이미 상품 상세) 그 페이지 하나를 상품 1건으로 캡처한다.
 *  끝나면 원래 보고 있던 페이지로 되돌아간다. */
async function runPreview(tab, site, aiMode) {
  try {
    await attachDebugger(tab.id)
  } catch (e) {
    console.log('[PTP] 미리보기 실패(디버거 연결 안 됨):', e.message)
    return { ok: false, error: `디버거 연결 실패: ${e.message}` }
  }
  // 디버거 연결에 성공한 이 시점이 "실제로 캡처를 시작함"이다 — PTP 화면이 이 신호를 폴링해 "대기 중"
  // (정적 아이콘)과 "실제로 도는 중"(스피너)을 구분해 보여준다(사용자 요청, 2026-09-05). 이 결과 자체는
  // 끝나야만 한 번에 오므로(아래 preview-capture), 그전까진 이 신호가 유일한 진행 표시다. 실패해도
  // 무시 — 순수 표시용이라 캡처 자체를 막으면 안 된다.
  fetch(`${SITE_API_BASE}/${site.id}/preview-progress`, { method: 'POST' }).catch(() => {})
  const startUrl = tab.url
  try {
    const listingStarts = site.categoryUrls && site.categoryUrls.length ? site.categoryUrls : [null]
    const categoryCounts = []
    let firstUrl = null
    let firstCat = null
    let items = []
    // 선택한 카테고리 중 하나라도 로그인 벽에 막혀 링크를 못 찾았으면 표시한다 — 개수가 0이라 그런 건지
    // 로그인이 끊겨서인지 구분 못 하면 사용자가 "왜 개수가 안 나오냐"고 매번 다시 물어야 한다(2026-09-05
    // 전수조사, 실사용 확인: 모자사러에서 로그인이 끊긴 채 46개 카테고리를 미리보기했더니 전부 0건으로
    // 나오고 categoryCounts가 통째로 비어 로그인 페이지 자체가 상품 1건인 것처럼 캡처됐다).
    let needsLogin = false

    let stoppedByUser = false
    for (const [listingIdx, listingStart] of listingStarts.entries()) {
      // "중지" — 카테고리 경계에서도 확인한다(2026-09-06). 카테고리를 하나만 볼 때(진행 신호 자체를 안
      // 보내는 경우)는 collectCategoryLinks 안쪽 루프들이 각자 확인하므로 여기선 건너뛴다.
      if (listingStarts.length > 1) {
        // 카테고리를 여러 개 선택했을 때만 의미 있는 진행 표시 — 하나만 볼 때는 어차피 몇 초 안에 끝난다.
        // 이 응답에 stop 여부도 같이 오므로(2026-09-06), 진행 신호를 보내는 김에 중지 요청도 확인한다 —
        // 별도 왕복 없이 "중지를 누르면 그 순간 멈추라"는 요청을 카테고리 경계마다 확인할 수 있다.
        const progressRes = await fetch(`${SITE_API_BASE}/${site.id}/preview-progress`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: listingIdx, total: listingStarts.length }),
        }).then(r => r.json()).catch(() => null)
        if (progressRes?.stop) { stoppedByUser = true; break }
      }
      if (listingStart) { await navigate(tab.id, listingStart); await throttle() }
      // 카테고리를 여러 개 선택했을 때만(fastCountOk) collectCategoryLinks가 "총 N개"/"마지막 페이지"
      // 지름길을 시도한다 — 하나만 볼 때는 items(나머지 목록)가 필요해 어차피 전부 순회해야 한다.
      const { links, linkInfo, categoryByUrl, truncated, count, needsLogin: catNeedsLogin } = await collectCategoryLinks(tab.id, listingStarts.length > 1, site.id)
      if (catNeedsLogin) needsLogin = true
      if (!links.length) continue
      const cat = categoryByUrl[links[0]]
      categoryCounts.push({ url: listingStart || startUrl, label: cat?.category || listingStart || startUrl, count, truncated })
      if (!firstUrl) {
        firstUrl = links[0]
        firstCat = cat
        // 카테고리를 하나만 보는 경우(미선택 포함)에만 나머지 목록을 그대로 보여준다 — 여러 카테고리를
        // 선택했을 때는 일반모드처럼 카테고리별 개수만 확인하면 충분하다.
        if (listingStarts.length === 1) items = links.slice(1).map(href => ({ url: href, name: linkInfo[href]?.name || '', thumbnail: linkInfo[href]?.thumbnail || '' }))
      }
    }
    if (stoppedByUser) console.log(`[PTP] 미리보기 중지됨 — 지금까지 확인한 ${categoryCounts.length}개 카테고리만 보고합니다.`)
    const total = categoryCounts.length ? categoryCounts.reduce((sum, c) => sum + c.count, 0) : undefined
    // 선택한 카테고리 전부에서 상품 링크를 하나도 못 찾았으면(로그인 벽이든, 진짜 상품이 없는 카테고리든,
    // 이 몰만의 다른 접근제한 문구든) 지금 탭이 보고 있는 페이지(카테고리 목록 그 자체, 심지어 회원전용
    // 안내 스크립트만 있는 빈 페이지일 수도 있음)를 "상품 1건"으로 둔갑시켜 캡처하지 않는다 — needsLogin
    // 신호(비밀번호 입력창)로 못 잡는 다른 접근제한 방식(예: 카페24 "회원만 접근권한이 있습니다" alert+
    // redirect — 화면에 보이는 텍스트가 아니라 <script> 안에만 있어 innerText 기반 판정으로도 못 잡음)이
    // 있으면 이 케이스로 빠진다(2026-09-05, 모자사러 실사용 확인 — "캡모자 캡모자"라는 뜻모를 상품명과
    // 대표이미지 자리에 alt 텍스트 문자열이 그대로 들어간 가짜 결과가 저장됐었다). 정직하게 "못 찾음"만
    // 보고하고, 화면(ScraperPanel.tsx)이 이 상황을 안내하게 한다.
    if (!firstUrl) {
      await fetch(`${SITE_API_BASE}/${site.id}/preview-capture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noProductsFound: true, total: total ?? 0, categoryCounts: categoryCounts.length ? categoryCounts : undefined, needsLogin }),
      }).catch(() => {})
      return { ok: true, preview: null }
    }

    if (firstUrl !== tab.url) await navigate(tab.id, firstUrl)
    const html = await evalInTab(tab.id, '(() => document.documentElement.outerHTML.slice(0, 200000))()')
    const res = await fetch(`${SITE_API_BASE}/${site.id}/preview-capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: firstUrl, html, aiMode: !!aiMode, total, items,
        categoryCounts: categoryCounts.length ? categoryCounts : undefined,
        category: firstCat?.category || '', brandFromCategory: firstCat?.brandFromCategory || '',
        needsLogin,
      }),
    })
    const data = await res.json()
    if (firstUrl !== startUrl) await navigate(tab.id, startUrl).catch(() => {})
    if (!res.ok) { console.log('[PTP] 미리보기 실패:', data.error || res.status); return { ok: false, error: data.error || String(res.status) } }
    console.log('[PTP] 미리보기 완료:', data.preview)
    return { ok: true, preview: data.preview }
  } catch (e) {
    console.log('[PTP] 미리보기 중 오류:', e.message)
    return { ok: false, error: e.message }
  } finally {
    await safeDetach(tab.id)
  }
}

// lib/scraper.ts의 NON_CATEGORY_TEXT_RE와 반드시 같은 값을 유지한다(같은 코드를 두 곳에 두는 이유는
// buildExtractExpr과 동일 — Node 서버↔크롬 확장이 서로 import를 못 함). 2026-09-05 전수조사에서 서버
// 쪽에 지난 2주간 추가된 8개 대안(회원정보/적립금/관심상품/최근본상품/위시리스트 계열 + wishlist)이
// 이쪽엔 반영 안 돼 있던 걸 발견 — 그대로 옮겼다.
const NON_CATEGORY_TEXT_SRC = '로그인|회원가입|로그아웃|장바구니|마이페이지|고객센터|검색어?|주문|배송조회|결제|사이트맵|관리자|촬영명령|입고대?기|입고대령|단가\\s*(인상|조정)|재진행|색상?\\s*(별)?\\s*분류|공지사항|공지\\b|납품\\s*사례|제작\\s*문의|도매\\s*인증|상품\\s*문의|회원\\s*정보|정보\\s*수정|적립금|관심\\s*상품|최근\\s*본\\s*상품|위시\\s*리스트|찜\\s*(목록)?|notice|cart|login|logout|mypage|search|sitemap|wishlist'

// lib/scraper.ts의 NON_CATEGORY_PATH_RE와 반드시 같은 값을 유지한다(같은 코드를 두 곳에 두는 이유는
// NON_CATEGORY_TEXT_SRC와 동일). 게시판/마이페이지 경로는 라벨 텍스트가 뭐라고 붙어있든(예: "1:1문의")
// 카테고리가 아니다 — 이 경로 필터가 없으면 이런 링크가 expandOne으로 그대로 넘어가 실제로 방문되고,
// 그 안의 무관한 비밀번호 입력창(비밀글 보기 등)이 isLoginPage를 오탐시켜 세션이 멀쩡한데도 "로그인
// 세션이 끊긴 것으로 보임" 경고가 매번 뜨는 원인이 됐다(2026-09-11, 도매토피아 실사용 확인 —
// /mypage/myqna_catalog).
const NON_CATEGORY_PATH_RE = /\/(board|bbs|mypage)\//i

function safePathname(href) {
  try { return new URL(href).pathname } catch { return '' }
}

// lib/scraper.ts의 canonicalizeHref와 같은 이유·같은 구현 — 같은 카테고리 페이지라도 www 유무만 다른
// 호스트로 열릴 수 있어(소꿉노리 실사용 확인, 2026-09-08: "기타 패브릭" 허브가 www 없는 호스트로
// 로드되며 그 페이지에서 다시 찾은 사이트 전체 GNB 링크의 href가 전부 www 없는 형태라 topLevelHrefs의
// www 있는 href와 문자열이 안 맞아 "진짜 하위 메뉴"로 오판됨 — 사이트 전체 메뉴가 그대로 복제돼
// 카테고리 개수가 58개에서 115개로 거의 두 배가 됐다), 문자열 그대로 비교하면 이 케이스를 놓친다.
function canonicalizeHref(href) {
  return href.replace(/^(https?:\/\/)www\./, '$1')
}

/** discoverCategoryLinks(lib/scraper.ts)의 대분류 허브 자동 펼치기(대분류 페이지에 상품이 없으면 그
 *  페이지의 하위 메뉴로 대신 펼침)와 같은 판정을 한다 — 다만 그 서버 쪽 버전은 로그인 필요 몰에서
 *  개인 크롬 프로필을 통째로 복사해도 로그인 세션이 넘어오지 않아(!specifications/
 *  manual-login-required-malls.md 2026-07-18/2026-08-18 항목, 모자사러로 직접 재현 확정) 항상
 *  로그인 페이지에 막힌다. 이 함수는 그 대신 실제 로그인된 탭에서 대분류마다 직접 방문해 확인한다.
 *  scanCategoryMenu(lib/scraper.ts)의 라이브 DOM 판정 기준(class/id에 cat/lnb/snb/ovmenu/gnb가 들어간
 *  영역, 그룹당 최소 2개 이상, href 기준 dedup)을 그대로 옮겼다 — 탭 위젯 라벨 병합/이미지전용
 *  메뉴(textlessHrefs) 폴백은 이 화면(로그인 필요 몰 한정)에서 아직 필요한 사례가 없어 포팅하지
 *  않았다(필요해지면 추가). topLevelHrefs와 겹치는 항목은 대분류 페이지에서 GNB를 다시 찾은 것일 뿐
 *  진짜 하위메뉴가 아니므로 제외한다(discoverCategoryLinks의 topLevelHrefSet 필터와 동일). */
function buildScanSubmenuExpr(topLevelHrefs) {
  return `(() => {
  const canonHref = (h) => h.replace(/^(https?:\\/\\/)www\\./, '$1')
  const excludeRe = new RegExp(${JSON.stringify(NON_CATEGORY_TEXT_SRC)}, 'i')
  // NON_CATEGORY_PATH_RE(lib/scraper.ts 상단)와 반드시 같은 값을 유지한다 — page.evaluate 콜백은
  // 브라우저에서 실행돼 바깥 모듈 상수를 그대로 참조할 수 없어 여기에 그대로 복제해둔다.
  const nonCategoryPathRe = /\\/(board|bbs|mypage)\\//i
  const safePathname = (h) => { try { return new URL(h).pathname } catch { return '' } }
  const topLevelHrefSet = new Set(${JSON.stringify(topLevelHrefs)}.map(canonHref))
  const isMeaningful = (s) => !!s && /[\\uac00-\\ud7a3a-zA-Z0-9]/.test(s)
  function ownText(li) {
    const ownAnchor = li.querySelector(':scope > a')
    if (ownAnchor) {
      const anchorText = (ownAnchor.textContent || '').trim()
      if (anchorText) return anchorText
      const img = ownAnchor.querySelector('img[alt]')
      if (img && img.alt && img.alt.trim()) return img.alt.trim()
    }
    const clone = li.cloneNode(true)
    clone.querySelectorAll('ul, ol').forEach(n => n.remove())
    return (clone.textContent || '').trim()
  }
  // 도매의신 실사용 확인(2026-08-26, lib/scraper.ts와 동일): 카테고리 메뉴가 <li onclick="location.href=
  // '...'"> 처럼 <a> 태그 없이 JS onclick만으로 이동하는 몰이 있다 — li 자신에 없으면 안쪽 자손도 한 번
  // 더 살펴본다(라벨이 span 등 다른 태그에 onclick을 다는 몰 대비).
  function hrefFromOnclick(el) {
    const raw = el.getAttribute('onclick') || el.querySelector('[onclick]')?.getAttribute('onclick') || ''
    const m = raw.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)
    if (!m) return ''
    try { return new URL(m[1], location.href).href } catch { return '' }
  }
  function ownHref(li) {
    const clone = li.cloneNode(true)
    clone.querySelectorAll('ul, ol').forEach(n => n.remove())
    const href = clone.querySelector('a[href]')?.href || ''
    // href="#"(빈 프래그먼트만 있는 장식용 링크)는 .href로 읽으면 "현재 페이지 URL + #"으로 resolve되어,
    // 그 페이지 자체가 상품 목록이기도 한 몰에서는 가짜 카테고리 하나가 다른 진짜 카테고리와 중복 집계된다
    // (가방쟁이 실사용 확인, 2026-08-25 — lib/scraper.ts와 동일 이슈, 2026-09-05 전수조사로 확장에도 이식).
    if (href) return href.endsWith('#') ? '' : href
    return hrefFromOnclick(clone)
  }
  function buildPaths(li, prefix, depth, out) {
    if (depth > 3 || out.length > 200) return
    const childLis = Array.from(li.querySelectorAll(':scope > ul > li, :scope > div > ul > li'))
    const name = ownText(li)
    if (!isMeaningful(name)) return
    if (excludeRe.test(name)) return
    const path = prefix.concat([name])
    if (childLis.length) {
      childLis.forEach(sub => buildPaths(sub, path, depth + 1, out))
    } else {
      const href = ownHref(li)
      if (href && !topLevelHrefSet.has(canonHref(href)) && !nonCategoryPathRe.test(safePathname(href))) out.push({ name: path.join(' > '), href })
    }
  }
  const SELECTOR_TIERS = [
    '[class*="cat" i], [id*="cat" i]',
    '[class*="lnb" i], [id*="lnb" i], [class*="snb" i], [id*="snb" i], [class*="ovmenu" i]',
    '[class*="gnb" i], [id*="gnb" i], nav',
  ]
  for (const tierSelector of SELECTOR_TIERS) {
    let candidates
    try { candidates = Array.from(document.querySelectorAll(tierSelector)) } catch { continue }
    const merged = []
    const seenHrefs = new Set()
    for (const root of candidates) {
      let topLis = Array.from(root.querySelectorAll(':scope > ul > li, :scope > li, :scope > div > ul > li, :scope .slick-slide > li'))
      if (!topLis.length) {
        const firstUl = root.querySelector('ul')
        if (firstUl) topLis = Array.from(firstUl.querySelectorAll(':scope > li'))
      }
      const out = []
      topLis.forEach(item => buildPaths(item, [], 0, out))
      const seenNames = new Set()
      const uniq = out.filter(o => (seenNames.has(o.name) ? false : (seenNames.add(o.name), true)))
      if (uniq.length < 2) continue
      uniq.forEach(o => { if (!seenHrefs.has(o.href)) { seenHrefs.add(o.href); merged.push(o) } })
    }
    if (merged.length) return { links: merged }
  }
  return { links: [] }
})()`
}

/** "🧭 카테고리 하위구조 자동확인" — PTP의 "카테고리 불러오기"가 이미 찾아둔 대분류 목록(site.categoryLinks)을
 *  순서대로 실제 탭에서 방문해, 상품이 있으면 그대로 두고 없으면(허브 카테고리) 그 페이지의 하위 메뉴로
 *  대신 펼친다 — discoverCategoryLinks가 로그인 필요 몰에서 하지 못하는 일을 실제 로그인된 브라우저로
 *  대신 해준다. 결과는 새 href 기준으로 합쳐(중복 제거) sites.scrape_profile.categoryLinks에 그대로
 *  덮어써, PTP에서 "카테고리 불러오기"를 다시 누르면 캐시로 바로 반영된다. */
// 대분류 개수만큼 실제 로그인 탭에서 하나씩 순서대로 열어보던 게(카테고리 사이 1.2~2.4초 대기까지
// 포함) 카테고리가 많은 몰(모자사러 17개 등)에서 몇 분씩 걸린다는 지적(2026-08-22)으로, 원래 탭 1개
// (사용자가 보고 있던 탭)에 추가로 백그라운드 탭을 더 열어 여러 카테고리를 동시에 확인하도록 바꿨다 —
// lib/scraper.ts의 discoverCategoryLinks가 서버 쪽에서 이미 쓰는 EXPAND_CONCURRENCY(여러 Playwright
// 탭 동시 확인)와 같은 발상이다. 새 탭도 같은 브라우저 프로필이라 쿠키/로그인 세션을 그대로 공유하므로
// 별도 로그인 처리가 필요 없다. 너무 많은 탭을 한꺼번에 열면 몰 서버에 부담을 주거나(작은 도매몰이
// 대상) 사용자 탭 목록이 어수선해지므로 4개로 제한한다.
const EXPAND_TAB_CONCURRENCY = 4
// 봇 차단 인터스티셜을 만났을 때 포기하기 전에 몇 번 더 재시도할지 — 매번 더 길게 쉰다(아래 expandOne).
const EXPAND_BLOCK_RETRY_COUNT = 2

async function runExpandCategories(tab, site) {
  if (!site.categoryLinks || !site.categoryLinks.length) {
    return { ok: false, error: 'PTP 화면에서 "카테고리 불러오기"를 먼저 한 번 실행해주세요(대분류 목록이 아직 없습니다).' }
  }
  const categoryLinks = site.categoryLinks
  const topLevelHrefs = categoryLinks.map(c => c.href)
  const topLevelHrefsCanon = new Set(topLevelHrefs.map(canonicalizeHref))
  const startUrl = tab.url
  const concurrency = Math.min(EXPAND_TAB_CONCURRENCY, categoryLinks.length)

  // 워커 0은 사용자가 보고 있던 원래 탭을 그대로 재사용(새 탭을 하나라도 덜 띄움), 나머지 concurrency-1개만
  // 백그라운드(active:false)로 새로 연다 — about:blank로 열어 바로 아래 워커 루프의 첫 navigate()가
  // 실제 카테고리 페이지 로딩을 맡게 한다(이중 로딩 방지).
  const extraTabIds = []
  try {
    await attachDebugger(tab.id)
  } catch (e) {
    return { ok: false, error: `디버거 연결 실패: ${e.message}` }
  }
  try {
    for (let i = 1; i < concurrency; i++) {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false })
      extraTabIds.push(t.id)
      await attachDebugger(t.id)
    }

    const workerTabIds = [tab.id, ...extraTabIds]
    const expandedByIndex = new Array(categoryLinks.length)
    let cursor = 0
    let doneCount = 0
    let blockedCount = 0
    // 규칙 기반(buildScanSubmenuExpr)이 하위 메뉴를 못 찾았을 때 AI(Qwen)로 한 번 더 시도하는 횟수 상한 —
    // lib/scraper.ts의 MAX_HUB_AI_ATTEMPTS_PER_RUN과 같은 값·같은 이유(몰 전체에 이런 시도가 카테고리
    // 개수만큼 쌓이지 않게 억제).
    let hubAiAttempts = 0
    const MAX_HUB_AI_ATTEMPTS = 5
    // 차단이 감지되면 남은 카테고리 전체를 1탭으로 낮춰 계속 두드리지 않는다 — 이 실행 안에서는 다시
    // 안 올린다(카테고리 개수가 보통 수십 개 안팎이라, lib/scraper.ts의 상품 스크랩 AIMD처럼 서서히
    // 회복시키면 처리량 대부분이 낮은 동시성에 갇혀 정상 상황에서도 매번 느려진다 — 펫토리 실사용
    // 확인, 2026-08-29). 처음부터 1로 시작하지 않는 것도 같은 이유: 대부분의 몰은 차단이 아예 없으므로
    // 기본은 그대로 4탭 병렬로 빠르게 처리한다.
    let activeLimit = workerTabIds.length
    await reportProfileProgress(site.id, `카테고리 하위구조 확인 중 (0/${categoryLinks.length})`)

    /** 카테고리 1건 확인 — 봇 차단 인터스티셜을 만나면 포기 전에 점점 길게 쉬며 재시도한다(IS_BLOCK_PAGE_EXPR
     *  참고). 재시도 후에도 안 풀리면 원래 항목을 미확장인 채로 남기고 blocked:true를 돌려준다 — 호출부가
     *  이걸로 남은 워커들의 동시성을 낮춘다. */
    async function expandOne(workerTabId, c) {
      // NON_CATEGORY_PATH_RE(게시판/마이페이지 경로)는 애초에 카테고리 후보가 아니므로 방문조차 하지
      // 않는다 — lib/scraper.ts의 같은 이름 가드와 동일한 이유(위 NON_CATEGORY_PATH_RE 정의부 참고).
      if (NON_CATEGORY_PATH_RE.test(safePathname(c.href))) return { links: [c], blocked: false }
      for (let attempt = 0; attempt <= EXPAND_BLOCK_RETRY_COUNT; attempt++) {
        await navigate(workerTabId, c.href)
        const blocked = await evalInTab(workerTabId, IS_BLOCK_PAGE_EXPR).catch(() => false)
        if (blocked) {
          if (attempt < EXPAND_BLOCK_RETRY_COUNT) { await delay(5_000 * (attempt + 1)); continue }
          return { links: [c], blocked: true }
        }
        const probe = await evalInTab(workerTabId, COLLECT_LINKS_EXPR).catch(() => ({ links: [] }))
        // 로그인 벽(비밀번호 입력창)에 막힌 것도 "빈 허브"로 오판하면 안 된다 — lib/scraper.ts의
        // expandOne과 같은 우선순위(isLoginPage를 먼저 확인). 이 분기가 없으면(2026-09-05 전수조사로
        // 발견) 세션이 끊긴 채로 실행됐을 때 로그인 페이지를 "상품도 하위메뉴도 없는 빈 허브"로 오인해
        // 해당 카테고리를 통째로 삭제해버렸다 — 봇 차단(IS_BLOCK_PAGE_EXPR)과는 원인이 다른 별도
        // 신호라 blocked:true로 같이 표시해 호출부의 blockedCount/"접속 차단으로 하위구조를 확인 못
        // 함" 경고를 그대로 재사용한다.
        if (probe.isLoginPage) return { links: [c], blocked: true }
        // count>0(이 카테고리 자체에도 상품이 있음)이어도 예전엔 여기서 곧장 반환해 하위 메뉴 자체를
        // 아예 확인 안 했다 — "대분류만 나오고 하위 메뉴가 안 나온다"의 실제 원인이었다(lib/scraper.ts
        // 쪽과 같은 사고, 진짜양말 실사용 확인 — 2026-09-06). 하위 메뉴가 실제로 있으면 부모(이미 유효한
        // 스크랩 대상)에 얹어 같이 돌려준다(사용자 요청 — "가급적 하위 메뉴 리스트까지 리스트업").
        const hasOwnProducts = probe.links.length > 0
        const sub = await evalInTab(workerTabId, buildScanSubmenuExpr(topLevelHrefs)).catch(() => ({ links: [] }))
        if (sub.links.length) {
          const childLinks = sub.links.map(s => ({ name: `${c.name} > ${s.name}`, href: s.href }))
          return { links: hasOwnProducts ? [c, ...childLinks] : childLinks, blocked: false }
        }
        // 규칙 기반(buildScanSubmenuExpr)은 <ul>/<li> 메뉴 트리만 찾는다 — 펫토리 실사용 확인(2026-09-06):
        // 이 몰은 하위 분류가 사이드바 메뉴가 아니라 대분류 페이지 본문에 브랜드/재료별 그리드(일반
        // <div>/<table> 콘텐츠, cat/lnb/gnb류 class 없음)로 나열돼 있어 이 스캔으로는 원천적으로 못 찾는다.
        // /api/scrape/detect-sub-categories(lib/ai.ts의 detectCategoryLinksWithAI, 서버 쪽 카테고리
        // 허브확장이 이미 쓰는 것과 같은 함수)에게 이 페이지의 링크 후보를 통째로 넘겨 직접 판단시킨
        // 결과, 이런 그리드도 정확히 골라내는 것을 직접 확인했다 — 규칙 기반이 못 찾을 때만, 실행당
        // 상한(MAX_HUB_AI_ATTEMPTS) 안에서 시도한다.
        if (hubAiAttempts < MAX_HUB_AI_ATTEMPTS) {
          hubAiAttempts++
          const all = await evalInTab(workerTabId, COLLECT_ALL_LINKS_EXPR).catch(() => ({ links: [] }))
          const aiLinks = await fetch(`${PTP_ORIGIN}/api/scrape/detect-sub-categories`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mallName: site.name, parentCategoryName: c.name, candidates: all.links }),
          }).then(r => r.json()).then(d => d.links || []).catch(() => [])
          const realAi = aiLinks.filter(s => !topLevelHrefsCanon.has(canonicalizeHref(s.href)))
          if (realAi.length) {
            const childLinks = realAi.map(s => ({ name: `${c.name} > ${s.name}`, href: s.href }))
            return { links: hasOwnProducts ? [c, ...childLinks] : childLinks, blocked: false }
          }
        }
        if (hasOwnProducts) return { links: [c], blocked: false }
        // 상품도 하위 메뉴도 못 찾은 빈 허브 — lib/scraper.ts의 expandCategoryHubs와 같은 이유(2026-08-30,
        // 소꿉노리 — 공지/문의 게시판 글이 "빈 허브"로 오인돼 카테고리에 계속 남던 사고)로, 이 페이지에
        // 정렬 UI 키워드조차 하나도 안 보이면 상품 목록 페이지가 아닐 가능성이 높다고 보고 통째로 뺀다.
        // 상품이 실제로 있는 카테고리는 위(hasOwnProducts)에서 이미 걸러져 이 분기를 안 타므로, 진짜
        // 카테고리를 오탐할 위험은 "상품 0개 + 하위메뉴 0개"인 경우로 좁혀져 있다.
        const hasSort = await evalInTab(workerTabId, HAS_SORT_LINK_ON_PAGE_EXPR).catch(() => false)
        return { links: hasSort ? [c] : [], blocked: false }
      }
      return { links: [c], blocked: false } // 도달하지 않음(루프가 항상 return으로 끝남)
    }

    async function worker(workerTabId, workerIndex) {
      while (true) {
        while (workerIndex >= activeLimit) {
          if (cursor >= categoryLinks.length) return
          await delay(500)
        }
        const i = cursor++
        if (i >= categoryLinks.length) return
        const c = categoryLinks[i]
        try {
          const { links, blocked } = await expandOne(workerTabId, c)
          expandedByIndex[i] = links
          if (blocked) { blockedCount++; activeLimit = 1 }
        } catch {
          expandedByIndex[i] = [c] // 이 워커 탭에서 일시적으로 실패해도 그 카테고리 하나만 미확장으로 남기고 계속 진행
        }
        doneCount++
        // 여러 워커가 동시에 완료를 셀 수 있지만(경쟁), 진행률 표시 용도라 순서가 살짝 뒤바뀌어도 무해하다.
        reportProfileProgress(site.id, `카테고리 하위구조 확인 중 (${doneCount}/${categoryLinks.length})`)
        await throttle()
      }
    }
    await Promise.all(workerTabIds.map((id, idx) => worker(id, idx)))

    const expanded = expandedByIndex.flat()
    const seenHrefs = new Set()
    const deduped = expanded.filter(c => {
      const key = canonicalizeHref(c.href)
      return seenHrefs.has(key) ? false : (seenHrefs.add(key), true)
    })

    // blocked: 서버 쪽(app/api/scrape/categories/route.ts)의 shouldKeepPreviousCategoryLinks와 같은
    // 판단을 이 저장 라우트에도 적용하려면(2026-09-05 전수조사에서 발견 — 이 라우트만 그 보호가 빠져
    // 있었음), 이번 실행 중 접속 차단으로 하위구조를 못 펼친 카테고리가 있었는지를 서버에 같이 알려야
    // 한다 — blockedCount는 이미 계산해뒀는데 지금까지 응답(runFullMallProfile 쪽 UI 경고문)에만 쓰고
    // 정작 저장 요청 자체엔 실어 보내지 않고 있었다.
    const res = await fetch(`${SITE_API_BASE}/${site.id}/categories/expand`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: deduped, blocked: blockedCount > 0 }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || String(res.status) }
    return { ok: true, count: deduped.length, blockedCount: blockedCount || undefined }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    await navigate(tab.id, startUrl).catch(() => {})
    await safeDetach(tab.id)
    for (const id of extraTabIds) {
      await safeDetach(id)
      await chrome.tabs.remove(id).catch(() => {})
    }
  }
}

/** 대분류 하나가 정렬 옵션 감지에 안 맞는 특수 페이지일 수 있어(아래 MAX_SORT_CATEGORY_ATTEMPTS 주석
 *  참고) 최대 몇 개까지 순서대로 시도해볼지 — 몰 전체를 순회하면 느려지니 앞쪽 몇 개로 제한한다. */
const MAX_SORT_CATEGORY_ATTEMPTS = 5

// runDetectSortOptions의 두 후보 소스(비전 AI가 화면에서 읽은 라벨 / COLLECT_SORT_KEYWORD_TEXTS_EXPR의
// 키워드 기반 후보) 공용 — lib/scraper.ts의 confirmSortCandidatesByClicking과 같은 이유·같은 판정: 텍스트를
// 하나씩 실제로 클릭해보고 baseUrl과 달라진 URL만 "진짜로 이동했다"는 증거로 인정한다(진짜 정렬인지는
// 서버의 diffQueryParams가 같은 pathname인지 다시 확인하므로 여기서는 넓게 잡아도 안전하다).
async function clickCandidatesAndCollectLinks(tabId, baseUrl, texts) {
  const collected = []
  for (const text of texts) {
    const clicked = await evalInTab(tabId, buildClickTextExpr(text)).catch(() => false)
    if (clicked) {
      await waitForTabSettled(tabId, 5_000)
      const afterUrl = await evalInTab(tabId, 'location.href').catch(() => null)
      if (afterUrl && afterUrl !== baseUrl) collected.push({ text, href: afterUrl })
    }
    if ((await evalInTab(tabId, 'location.href').catch(() => null)) !== baseUrl) {
      await navigate(tabId, baseUrl).catch(() => {})
    }
  }
  return collected
}

/** "🧭 정렬 옵션 감지" — site.categoryLinks(PTP "카테고리 불러오기"가 찾아둔 대분류 목록)를 앞에서부터
 *  순서대로 실제 로그인된 탭에서 열어본다. 1차로 화면을 스크린샷으로 찍어 서버(/api/scrape/detect-sort-labels,
 *  lib/ai.ts의 detectSortOptionsFromScreenshot — Groq qwen3.6-27b 비전→로컬 Ollama vision 순)에게 "화면에
 *  보이는 정렬 라벨"을 물어보고, 그 라벨 텍스트로 clickCandidatesAndCollectLinks를 돌려 실제 클릭+URL
 *  변화까지 확인한 것만 후보로 삼는다(사용자 지시, 2026-09-08 — "정렬은 어차피 사람 눈으로 화면에서 확인
 *  가능하다, 화면을 먼저 보는 것으로 설계 기준을 바꿔라"). href/select 마크업 형태(<a>/<select>/버튼
 *  onclick/커스텀 JS 드롭다운)나 사이트 공통 내비게이션 텍스트("신상품" 등)와 정렬 키워드의 우연한 겹침
 *  때문에 반복됐던 사고(2026-09-08, 소꿉노리 다수)가 이 방식 자체로는 재현되지 않는다.
 *
 *  화면 인식이 실패했거나(비전 AI 호출 자체 실패) 클릭해도 실제로 확인된 후보가 하나도 없을 때만, 기존
 *  href/select 구조 스캔(COLLECT_ALL_LINKS_EXPR) → 정렬 키워드 텍스트 클릭 폴백(COLLECT_SORT_KEYWORD_TEXTS_EXPR)
 *  으로 이어간다(안전망으로 유지 — 이 함수를 유일한 진실로 과신하지 않는다).
 *
 *  하나라도 정렬 옵션을 찾으면 그 자리에서 멈춘다. 정렬 옵션이 진짜인지 최종 판정하는 것(detectSortOptionsWithAI,
 *  diffQueryParams)은 로그인이 필요 없으므로 서버(/api/sites/{id}/sort-options)가 맡고, 이 함수는
 *  runExpandCategories와 같은 이유(로그인 필요 몰은 서버 Playwright가 이 페이지를 볼 수 없음)로 "화면을
 *  보고 후보를 모아 보내는 것"만 대신한다. categoryLinks[0]만 확인하고 끝내면 안 되는 이유(특수 집계
 *  카테고리라 정렬 위젯이 없을 수 있음)는 MAX_SORT_CATEGORY_ATTEMPTS 주석 참고 — 서버가 sortOptions.length
 *  0이면 DB에 아예 안 써서(기존 좋은 값을 안 지움) 여러 카테고리를 순서대로 시도해도 안전하다. */
async function runDetectSortOptions(tab, site) {
  if (!site.categoryLinks || !site.categoryLinks.length) {
    return { ok: false, error: 'PTP 화면에서 "카테고리 불러오기"를 먼저 한 번 실행해주세요(대분류 목록이 아직 없습니다).' }
  }
  try {
    await attachDebugger(tab.id)
  } catch (e) {
    return { ok: false, error: `디버거 연결 실패: ${e.message}` }
  }
  const startUrl = tab.url
  try {
    const attempts = site.categoryLinks.slice(0, MAX_SORT_CATEGORY_ATTEMPTS)
    let lastError = null
    for (let i = 0; i < attempts.length; i++) {
      const category = attempts[i]
      await reportProfileProgress(site.id, `정렬 옵션 감지 중... (${i + 1}/${attempts.length})`)
      await navigate(tab.id, category.href)
      const baseUrl = await evalInTab(tab.id, 'location.href').catch(() => category.href)

      // 1차: 화면(스크린샷)을 먼저 본다.
      let links = []
      // verified=true는 화면 인식(비전 AI)이 지목한 라벨을 실제로 클릭해 URL 변화까지 확인했다는 뜻 —
      // 서버가 이 신호를 받으면 detectSortOptionsWithAI 재분류를 건너뛰고 diffQueryParams만으로 최종
      // 판정한다(app/api/sites/[id]/sort-options/route.ts 주석 참고 — 모자사러 실사용 확인, 2026-09-09:
      // 화면+클릭으로 이미 확정한 4개 중 AI 재분류가 근거 없이 3개를 걸러버렸다. 화면 인식 실패 시의 2차
      // 폴백(href/select 원문 스캔, 최대 120개 — 상품/공지 등 무관 링크가 섞여있어 여전히 AI 분류가
      // 필요함)에서는 verified를 true로 두지 않는다).
      let verified = false
      // 닫힌 드롭다운은 화면에 지금 선택된 라벨만 보이고 나머지 옵션은 안 보인다 — 스크린샷 전에 한 번
      // 열어본다(OPEN_SORT_DROPDOWN_EXPR 주석 참고, 정글북 실사용 확인 2026-09-15). 열 게 없으면 조용히
      // 실패하고 닫힌 상태 그대로일 뿐이라 기존 동작과 같다.
      await evalInTab(tab.id, OPEN_SORT_DROPDOWN_EXPR).catch(() => false)
      const screenshotBase64 = await captureScreenshot(tab.id).catch(() => null)
      if (screenshotBase64) {
        const labels = await fetch(`${PTP_ORIGIN}/api/scrape/detect-sort-labels`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mallName: site.name, imageBase64: screenshotBase64, mimeType: 'image/jpeg' }),
        }).then(r => r.json()).then(d => d.labels || []).catch(() => [])
        if (labels.length) {
          links = await clickCandidatesAndCollectLinks(tab.id, baseUrl, labels)
          verified = links.length > 0
        }
      }

      // 1.5차: 값이 하나도 안 보이면, 트리거 자체가 "정렬방식"처럼 고정 라벨만 있고 지금 값은 화면에
      // 없는 경우일 수 있다(도매신 실사용 확인, 2026-09-16 — OPEN_SORT_DROPDOWN_EXPR은 트리거 자신의
      // 텍스트가 이미 정렬 키워드일 때만 여는데 "정렬방식"은 그 키워드 목록에 없다). 사람이 화면을 보고
      // 그 버튼을 찾아 눌러보듯, 비전으로 위치를 찾아 직접 클릭한 뒤 다시 읽는다(lib/scraper.ts의
      // detectSortOptionsByScreenshot과 같은 이유·같은 순서 — 두 곳이 갈라지지 않도록 항상 같이 반영한다).
      if (!links.length && screenshotBase64) {
        const trigger = await fetch(`${PTP_ORIGIN}/api/scrape/detect-sort-trigger`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mallName: site.name, imageBase64: screenshotBase64, mimeType: 'image/jpeg' }),
        }).then(r => r.json()).then(d => d.trigger || { found: false }).catch(() => ({ found: false }))
        if (trigger.found) {
          // 이 파일엔 좌표 클릭 헬퍼가 없어(lib/scraper.ts의 clickNearestClickableAtPoint에 해당하는
          // 것) evalInTab으로 elementFromPoint+click을 직접 실행한다 — 이 파일의 다른 모든 동작이
          // evalInTab 기반인 것과 같은 패턴.
          const viewport = await evalInTab(tab.id, '(() => ({ width: innerWidth, height: innerHeight }))()').catch(() => ({ width: 1280, height: 800 }))
          const x = viewport.width * (trigger.xPercent / 100)
          const y = viewport.height * (trigger.yPercent / 100)
          await evalInTab(tab.id, `(() => { const el = document.elementFromPoint(${x}, ${y}); if (el) { el.click(); return true } return false })()`).catch(() => false)
          await new Promise(r => setTimeout(r, 300))
          const reshotBase64 = await captureScreenshot(tab.id).catch(() => null)
          const labels2 = reshotBase64 ? await fetch(`${PTP_ORIGIN}/api/scrape/detect-sort-labels`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mallName: site.name, imageBase64: reshotBase64, mimeType: 'image/jpeg' }),
          }).then(r => r.json()).then(d => d.labels || []).catch(() => []) : []
          if (labels2.length) {
            links = await clickCandidatesAndCollectLinks(tab.id, baseUrl, labels2)
            verified = links.length > 0
          }
        }
      }

      // 2차: 화면 인식이 실패했거나 클릭해도 실제로 확인된 후보가 없을 때만 기존 href/select 구조 스캔 →
      // 키워드 기반 클릭 폴백으로 이어간다. 이 구조 스캔 결과(rawLinks, 최대 120개 — 상품/공지 등 무관한
      // 링크가 섞여있어 클릭으로 확인된 게 아님)는 verified로 안 둔다 — 클릭 폴백이 후보를 찾아내면 그건
      // 순수하게 클릭 확인된 것만 verified=true로 따로 보내고(rawLinks와 섞지 않는다 — 섞으면 그 안의
      // 무관한 링크까지 AI 필터링 없이 그대로 diffQueryParams를 통과할 위험이 있다), 못 찾으면 예전처럼
      // rawLinks 그대로(unverified) 보내 서버 AI가 걸러내게 한다.
      if (!links.length) {
        const all = await evalInTab(tab.id, COLLECT_ALL_LINKS_EXPR).catch(() => ({ links: [] }))
        const rawLinks = all.links
        const hasSortLabel = rawLinks.some(l => { const t = l.text.trim(); return t.length <= 10 && /순$/.test(t) })
        if (!hasSortLabel) {
          // 위 스크린샷 이후 clickCandidatesAndCollectLinks가 baseUrl로 되돌아가며 페이지를 다시 불러와
          // 드롭다운이 닫혔을 수 있다 — 키워드 스캔 전에도 같은 이유로 한 번 더 열어본다.
          await evalInTab(tab.id, OPEN_SORT_DROPDOWN_EXPR).catch(() => false)
          const candidateTexts = await evalInTab(tab.id, COLLECT_SORT_KEYWORD_TEXTS_EXPR).catch(() => [])
          const clickedFallback = await clickCandidatesAndCollectLinks(tab.id, baseUrl, candidateTexts)
          if (clickedFallback.length) {
            links = clickedFallback
            verified = true
          } else {
            links = rawLinks
          }
        } else {
          links = rawLinks
        }
      }

      const res = await fetch(`${SITE_API_BASE}/${site.id}/sort-options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links, baseUrl, verified }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { lastError = data.error || String(res.status); continue }
      if (data.count > 0) return { ok: true, count: data.count }
    }
    // 시도한 카테고리 전부 정렬 옵션을 못 찾음 — 그중 서버 요청 자체가 실패한 게 있었으면 그 에러를
    // 보여주고, 전부 정상 응답인데 그냥 못 찾은 것뿐이면 "정렬 없음"으로 정상 처리한다(실패 아님).
    return lastError ? { ok: false, error: lastError } : { ok: true, count: 0 }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    await navigate(tab.id, startUrl).catch(() => {})
    await safeDetach(tab.id)
  }
}

// "스크랩 대상 직접지정" — 일반모드(lib/scraper.ts의 injectElementPicker)와 완전히 같은 클릭식 피커
// UI를 몰 탭에 그대로 심는다. Playwright의 page.exposeFunction 대신 CDP의 Runtime.addBinding을 쓴다 —
// 둘 다 "페이지 안에서 부르면 확장/서버로 전달되는 함수를 심어둔다"는 점에서 동일한 메커니즘이다.
// 다만 addBinding은 편도(페이지→확장)라 페이지 쪽에서 저장 완료를 await할 수 없다 — 그래서 페이지는
// 저장을 쏘아두기만 하고(fire-and-forget), "닫기"를 누르면 별도 바인딩(ptpPickerClose)으로 신호만
// 보낸다. 실제로 "아직 저장 중인 게 다 끝날 때까지 기다렸다가 디버거를 뗀다"는 이 함수(백그라운드)가
// pickerSessions로 추적해서 대신 해준다.
const pickerSessions = new Map() // tabId -> { siteId, pendingSaves: Promise[] }

// siteId는 pickerSessions(서비스워커 메모리)가 아니라 페이지가 보내는 payload 자체에 실어 받는다 —
// 서비스워커가 유휴 상태로 재시작되면 pickerSessions는 비어버리지만(위 attachDebugger 주석 참고),
// CDP addBinding은 그대로 살아있어 페이지의 저장 클릭은 계속 이벤트를 쏜다. session이 없어도 어디에
// 저장할지(siteId)는 payload로 알 수 있어야 저장이 조용히 유실되지 않는다. session은 "닫기" 시 아직
// 끝나지 않은 저장을 기다렸다 디버거를 떼는 용도로만 best-effort로 쓴다.
function pickerBindingListener(source, method, params) {
  if (method !== 'Runtime.bindingCalled') return
  const session = pickerSessions.get(source.tabId)
  if (params.name === 'ptpSavePick') {
    const payload = JSON.parse(params.payload)
    const save = fetch(`${SITE_API_BASE}/${payload.siteId}/picker/rule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => {})
    session?.pendingSaves.push(save)
  } else if (params.name === 'ptpDeleteField') {
    // "✕(지우기)" — ptpSavePick(병합)과 달리 같은 라우트에 delete:true를 실어 규칙 자체를 jsonb에서
    // 완전히 없앤다(lib/scraper.ts의 ptpDeleteField와 항상 같이 반영).
    const payload = JSON.parse(params.payload)
    const del = fetch(`${SITE_API_BASE}/${payload.siteId}/picker/rule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: payload.field, delete: true }),
    }).catch(() => {})
    session?.pendingSaves.push(del)
  } else if (params.name === 'ptpPickerClose') {
    (async () => {
      if (session) await Promise.all(session.pendingSaves)
      pickerSessions.delete(source.tabId)
      await safeDetach(source.tabId)
    })()
  }
}
chrome.debugger.onEvent.addListener(pickerBindingListener)

/** attachDebugger의 Page.enable과 한 쌍 — 몰이 alert()/confirm()으로 띄우는 네이티브 다이얼로그(예:
 *  소꿉노리의 "로그아웃 되었습니다")를 그대로 두면 사람이 "확인"을 누를 때까지 그 탭의 자동화 전체가
 *  멈춘다. 서버로 그 순간의 URL·문구를 남겨(진단 목적 — "정확히 언제/어디서 로그아웃되는지" 파악) 자동
 *  닫아 자동화가 계속 진행되게 한다. accept:true는 Playwright dismiss()와 달리 confirm()의 "확인"을
 *  누르는 셈이지만, 이 앱이 다루는 다이얼로그는 전부 정보 전달용 alert()라 실질적 차이가 없다. */
function dialogListener(source, method, params) {
  if (method !== 'Page.javascriptDialogOpening') return
  fetch(`${PTP_ORIGIN}/api/scrape/log-diagnostic`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detail: `[다이얼로그 감지] tabId=${source.tabId} type=${params.type} url=${params.url} 문구="${params.message}"` }),
  }).catch(() => {})
  chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
}
chrome.debugger.onEvent.addListener(dialogListener)

/** 실제 몰 페이지 안에서 실행되는 함수 — lib/scraper.ts의 injectElementPicker와 같은 UI/동작을
 *  그대로 옮긴 것이다(같은 코드를 두 곳에 두는 이유: Next 서버 코드↔크롬 확장은 서로 import를 못 하는
 *  별개 런타임). 하나를 고치면 다른 하나도 맞춰야 한다. .toString()으로 그대로 문자열화해 Runtime.evaluate에
 *  실어 보내므로 이 함수 본문은 반드시 순수 JS여야 한다(TS 타입/제네릭 금지). */
function pickerPageScript(seed) {
  const w = window
  if (w.__ptpPickerActive) w.__ptpPickerTeardown?.()
  w.__ptpPickerActive = true

  const previewProduct = seed?.previewProduct || null
  const siteIdLocal = seed?.siteId
  const rulesLocal = { ...(seed?.extractionRules || {}) }
  let armedField = null
  // lib/scraper.ts의 같은 이름 변수와 반드시 같은 동작을 유지한다(사용자 요청, 2026-09-12 — 오펠트 사례:
  // 조건별로 여러 공급가를 보여주는 몰에서, 컬럼명도 화면 클릭으로 채울 수 있게 한다).
  let armingNewFieldName = false
  let newFieldNameDraft = ''
  let newFieldValueDraft = ''
  const lastValueLocal = {}
  // 기존 필드 줄에도 "새 컬럼 만들기"와 같은 [컬럼명 칸+지정 버튼]을 추가한다(lib/scraper.ts와 항상 같이
  // 반영, 사용자 지시 2026-09-17). 저장되는 규칙 자체(필드 키)에는 영향 없는 로컬 참고용 값이다.
  const columnNameLocal = {}
  let armingColumnNameField = null

  const masterLabels = seed?.masterLabels || {}
  const PICKER_TO_MASTER_KEY = {
    name: 'name_final', price: 'list_price', cost_price: 'cost_price', shipping_fee: 'shipping_fee',
    category: 'master_category', brand: 'brand', manufacturer: 'manufacturer', origin: 'origin',
    stock_status: 'stock_status', stock_qty: 'stock_qty',
    thumbnail_urls: 'top_img', detail_image_urls: 'detail_img',
  }
  const DEFAULT_CANONICAL_LABELS = [
    ['name', '상품명'], ['price', '가격(소비자가)'], ['cost_price', '공급가/원가'], ['shipping_fee', '배송비'],
    ['category', '카테고리'], ['brand', '브랜드'], ['manufacturer', '제조사'], ['origin', '원산지'],
    ['stock_status', '재고상태'], ['stock_qty', '재고수량'], ['english_name', '영문상품명'], ['summary_info', '상품요약정보'],
    ['thumbnail_urls', '대표이미지'], ['detail_image_urls', '상세이미지'],
  ]
  const relabeled = DEFAULT_CANONICAL_LABELS.map(([key, defaultLabel]) => {
    const masterKey = PICKER_TO_MASTER_KEY[key]
    const liveLabel = masterKey ? masterLabels[masterKey] : undefined
    return [key, liveLabel || defaultLabel]
  })
  const masterOrder = seed?.masterOrder || []
  // lib/scraper.ts와 같은 이유(2026-09-12, 사용자 지적) — 기준 마스터테이블관리에는 있지만 위 12개 고정
  // 매핑엔 없는 필드(몰상품코드/판매관리코드/마켓별카테고리/규제판가/소비자판가/옵션1~3/교환반품비 등)도
  // 미리 목록에 올려, 미리보기 그리드에 이미 보이는 컬럼을 여기서 바로 "지정"할 수 있게 한다.
  const coveredMasterKeys = new Set([...Object.values(PICKER_TO_MASTER_KEY), 'product_url'])
  const extraMasterFields = masterOrder
    .filter(k => !coveredMasterKeys.has(k) && masterLabels[k])
    .map(k => [k, masterLabels[k]])
  const CANONICAL_FIELDS = [...relabeled, ...extraMasterFields].sort((a, b) => {
    const masterKeyOf = k => PICKER_TO_MASTER_KEY[k] ?? k
    const idxA = masterOrder.indexOf(masterKeyOf(a[0]))
    const idxB = masterOrder.indexOf(masterKeyOf(b[0]))
    if (idxA === -1 && idxB === -1) return 0
    if (idxA === -1) return 1
    if (idxB === -1) return -1
    return idxA - idxB
  })
  const IMAGE_FIELDS = new Set(['thumbnail_urls', 'detail_image_urls'])
  // 옵션1~3은 extractOptionsFromDom이 <select>를 스캔해 자동으로 채우는 값이라(currentValue 참고, lib/scraper.ts와
  // 항상 같이 반영) 클릭 지정 자체를 막는다 — 네이티브 select 드롭다운은 열려 있어도 OS가 그리는 팝업이라
  // 페이지 스크립트가 개별 <option>을 못 잡고, 실제로 클릭해보면 매번 <select> 전체(안내문+모든 옵션 텍스트가
  // 구분자 없이 뭉친 것)만 잡혀 "여러 번 클릭 = 결합"이 될수록 오히려 더 망가진다(실사용 확인, 도매신).
  const AUTO_OPTION_FIELDS = new Set(['1_option', '2_option', '3_option'])

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function currentValue(field) {
    if (!previewProduct) return ''
    const p = previewProduct
    switch (field) {
      case 'price': return p.price != null ? `₩${Number(p.price).toLocaleString()}` : ''
      case 'cost_price': return p.cost_price != null ? `₩${Number(p.cost_price).toLocaleString()}` : ''
      case 'shipping_fee': return p.shipping_fee != null ? String(p.shipping_fee) : ''
      case 'stock_qty': return p.stock_qty != null ? String(p.stock_qty) : ''
      case 'thumbnail_urls': return Array.isArray(p.thumbnail_urls) && p.thumbnail_urls.length ? `이미지 ${p.thumbnail_urls.length}장` : ''
      case 'detail_image_urls': return Array.isArray(p.detail_image_urls) && p.detail_image_urls.length ? `이미지 ${p.detail_image_urls.length}장` : ''
      case 'name': case 'category': case 'brand': case 'manufacturer': case 'origin':
      case 'stock_status': case 'english_name': case 'summary_info':
        return p[field] || ''
      // 옵션1~3은 몰 화면에 클릭할 단일 요소가 없다 — extractOptionsFromDom이 <select>를 스캔해 자동으로
      // 채우는 값이다(lib/scraper.ts와 항상 같이 반영 — ScraperPanel.tsx 그리드 렌더링과 동일한 규칙,
      // product.options[N].values). 이 자동값을 안 보여주면 "미지정"으로만 보여 사용자가 굳이 라벨/셀렉터를
      // 손으로 지정하게 되는데, 정답 요소(<select> 값 목록)가 아닌 엉뚱한 것을 가리키면 이미 맞던 자동값을
      // 깨진 값으로 덮어써버린다(실사용 확인, 도매신).
      case '1_option': case '2_option': case '3_option': {
        const idx = { '1_option': 0, '2_option': 1, '3_option': 2 }[field]
        const opts = Array.isArray(p.options) ? p.options : []
        return opts[idx]?.values?.join(', ') || ''
      }
      default: {
        const custom = p.custom_fields
        return custom?.[field] || ''
      }
    }
  }

  let hovered = null
  const HOVER_OUTLINE = '2px solid #14b8a6'

  function onMouseOver(e) {
    if (!armedField) return
    const el = e.target
    if (el === panel || panel.contains(el)) return
    if (hovered && hovered !== el) hovered.style.outline = ''
    hovered = el
    hovered.style.outline = HOVER_OUTLINE
  }

  function detectLabel(target) {
    let el = target
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      if (el.tagName === 'DD') {
        const dt = el.previousElementSibling
        if (dt && dt.tagName === 'DT') return (dt.textContent || '').trim()
      }
      if (el.tagName === 'TD') {
        const tr = el.closest('tr')
        const th = tr?.querySelector('th')
        if (th) return (th.textContent || '').trim()
      }
    }
    return null
  }

  function computeSelector(target) {
    if (target.id) return '#' + CSS.escape(target.id)
    const parts = []
    let node = target
    let depth = 0
    while (node && node.tagName !== 'BODY' && depth < 6) {
      let sel = node.tagName.toLowerCase()
      if (node.className && typeof node.className === 'string' && node.className.trim()) {
        const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.')
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName)
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(node) + 1})`
      }
      parts.unshift(sel)
      const candidate = parts.join(' > ')
      if (document.querySelectorAll(candidate).length === 1) return candidate
      node = parent
      depth++
    }
    return parts.join(' > ')
  }

  function computeGallerySelector(target) {
    const container = target.tagName === 'IMG' ? (target.parentElement || target) : target
    return computeSelector(container) + ' img'
  }

  const panel = document.createElement('div')
  panel.id = 'ptp-picker-panel'
  panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;border:2px solid #14b8a6;'
    + 'border-radius:12px;padding:12px;width:320px;font:12px/1.4 -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);color:#333'
  panel.innerHTML = `
    <button id="ptp-picker-x" title="닫기" style="position:absolute;top:6px;right:8px;background:none;border:0;color:#999;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px">✕</button>
    <div id="ptp-picker-drag" style="margin-bottom:6px;cursor:move;user-select:none;padding-right:20px">
      <div style="font-size:12px;color:#999;letter-spacing:.02em">PTP 직접지정 패널 (개발자모드)</div>
      <div style="font-weight:600">⠿ 🎯 스크랩 대상 직접지정</div>
    </div>
    <div style="font-size:12px;color:#888;margin-bottom:6px;line-height:1.5">① 필드 선택 → ② 몰 화면에서 값 클릭 → ③ 자동 저장 — 반복하세요</div>
    <div id="ptp-picker-status" style="color:#2563eb;font-weight:600;margin-bottom:8px;display:none"></div>
    <div id="ptp-picker-fieldlist" style="max-height:320px;overflow-y:auto;border-top:1px solid #eee;border-bottom:1px solid #eee;margin:8px 0;padding:4px 0"></div>
    <div id="ptp-picker-log" style="margin-top:4px;color:#0d9488;max-height:50px;overflow:auto"></div>
    <button id="ptp-picker-close" style="margin-top:8px;width:100%;background:#14b8a6;color:#fff;border:0;border-radius:6px;padding:6px;cursor:pointer">💾 피커 저장</button>
  `
  document.body.appendChild(panel)

  // 버튼이 많고 연달아 눌러야 하는 패널이라, 클릭이 실제로 먹혔는지 안 보여 답답하다는 피드백 —
  // 패널 전체에 위임 리스너 하나만 걸어 눌린 버튼을 잠깐 눌림 상태로 보여준다. 필드 목록은
  // renderFieldList()가 매번 innerHTML을 통째로 새로 그리므로(버튼별 리스너 재부착), 패널(고정 요소)에
  // 걸어야 재렌더링 후에도 계속 살아있다.
  panel.addEventListener('click', e => {
    const btn = e.target.closest('button')
    if (!btn || !panel.contains(btn)) return
    btn.style.transition = 'transform .08s ease, opacity .08s ease'
    btn.style.transform = 'scale(0.93)'
    btn.style.opacity = '0.65'
    setTimeout(() => { btn.style.transform = ''; btn.style.opacity = '' }, 120)
  })

  const dragHandle = panel.querySelector('#ptp-picker-drag')
  let dragOffsetX = 0
  let dragOffsetY = 0
  function onDragMove(e) {
    const maxLeft = window.innerWidth - panel.offsetWidth
    const maxTop = window.innerHeight - panel.offsetHeight
    panel.style.left = Math.min(Math.max(0, e.clientX - dragOffsetX), Math.max(0, maxLeft)) + 'px'
    panel.style.top = Math.min(Math.max(0, e.clientY - dragOffsetY), Math.max(0, maxTop)) + 'px'
    panel.style.right = 'auto'
  }
  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }
  dragHandle.addEventListener('mousedown', e => {
    const rect = panel.getBoundingClientRect()
    dragOffsetX = e.clientX - rect.left
    dragOffsetY = e.clientY - rect.top
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
    e.preventDefault()
  })

  const statusEl = panel.querySelector('#ptp-picker-status')
  const logEl = panel.querySelector('#ptp-picker-log')
  const fieldListEl = panel.querySelector('#ptp-picker-fieldlist')

  function logLine(field) {
    const line = document.createElement('div')
    line.textContent = `✓ ${field}`
    logEl.prepend(line)
  }

  function updateStatus() {
    if (armingNewFieldName) {
      statusEl.textContent = '👉 새 컬럼명 지정 중 — 몰 화면에서 라벨을 클릭하세요'
      statusEl.style.display = 'block'
    } else if (armingColumnNameField) {
      const label = (CANONICAL_FIELDS.find(([k]) => k === armingColumnNameField)?.[1]) || armingColumnNameField
      statusEl.textContent = `👉 "${label}" 컬럼명 지정 중 — 몰 화면에서 라벨을 클릭하세요`
      statusEl.style.display = 'block'
    } else if (armedField) {
      const label = (CANONICAL_FIELDS.find(([k]) => k === armedField)?.[1]) || armedField
      statusEl.textContent = `👉 "${label}" 지정 중 — 몰 화면에서 값을 클릭하세요`
      statusEl.style.display = 'block'
    } else {
      statusEl.textContent = ''
      statusEl.style.display = 'none'
    }
  }

  function saveField(field, type, value, displayValue) {
    rulesLocal[field] = { type, value }
    lastValueLocal[field] = displayValue
    // Runtime.addBinding은 편도라 여기서 await할 수 없다 — 쏘아두기만 하면 백그라운드가 실제 저장을
    // 책임지고, "닫기"를 누를 때 ptpPickerClose로 그 완료를 기다린 뒤 디버거를 뗀다.
    window.ptpSavePick(JSON.stringify({ field, type, value, siteId: siteIdLocal }))
    logLine(field)
  }

  function forceEmpty(field) {
    rulesLocal[field] = { type: 'fixed', value: '' }
    lastValueLocal[field] = ''
    window.ptpSavePick(JSON.stringify({ field, type: 'fixed', value: '', siteId: siteIdLocal }))
    logLine(`🚫 ${field}`)
  }

  // "✕"(규칙 지우기) — forceEmpty와 다르다(lib/scraper.ts의 deleteField와 항상 같이 반영). "항상 빈
  // 값"으로 고정하는 게 아니라 규칙 자체를 지워 자동/AI 추출로 되돌린다. 예전엔 ✕가 forceEmpty를 그대로
  // 불러 지운 뒤에도 "값 없음 고정"에 갇혀 사용자가 "왜 안 바뀌지"를 겪었다(2026-09-17).
  function deleteField(field) {
    delete rulesLocal[field]
    delete lastValueLocal[field]
    window.ptpDeleteField(JSON.stringify({ field, siteId: siteIdLocal }))
    logLine(`🗑 ${field}`)
  }

  // 클릭(또는 직접 입력)으로 값을 (다시) 지정하면 항상 새 값으로 교체한다(lib/scraper.ts와 항상 같이
  // 반영) — 예전엔 이미 지정된 필드를 다시 지정하면 기존 값에 새 요소를 이어붙였는데("N개 결합"), 여러
  // 번 클릭할수록 값이 뭉쳐서 안내문+옵션 텍스트가 겹겹이 쌓이는 사고가 반복됐다(사용자 지시로
  // 2026-09-17에 교체 방식으로 되돌림). 대표/상세이미지는 이 대상이 아니다 — appendImagePart를 그대로 쓴다.
  function saveFieldValue(field, part, displayValue) {
    saveField(field, part.type, part.value, displayValue)
  }

  function appendImagePart(field, selector) {
    const existing = rulesLocal[field]
    let parts
    if (existing?.type === 'multi') {
      try { parts = JSON.parse(existing.value) } catch { parts = [] }
    } else if (existing) {
      parts = [{ type: existing.type, value: existing.value }]
    } else {
      parts = []
    }
    parts.push({ type: 'selector', value: selector })
    const totalCount = parts.reduce((sum, p) => sum + (p.type === 'selector' ? document.querySelectorAll(p.value).length : 0), 0)
    const display = totalCount ? `이미지 ${totalCount}장` : '(이미지를 찾지 못함)'
    if (parts.length > 1) saveField(field, 'multi', JSON.stringify(parts), display)
    else saveField(field, 'selector', selector, display)
  }

  function elementDisplayText(el) {
    const clone = el.cloneNode(true)
    clone.querySelectorAll('.layer_area, [style*="display:none" i], [style*="display: none" i], #ptp-picker-panel').forEach(n => n.remove())
    return (clone.textContent || '').trim().slice(0, 60)
  }

  // <select>를 클릭하면(네이티브 드롭다운은 옵션이 열려 있어도 OS가 그리는 팝업이라 개별 <option>이 아니라
  // 이 <select> 자체가 클릭 대상으로 잡힌다) elementDisplayText처럼 통째로 textContent를 읽으면 안내문+
  // 모든 옵션이 구분자 없이 뭉쳐 나온다(lib/scraper.ts와 항상 같이 반영 — 도매신 실사용 확인, 2026-09-17).
  // 실제 선택 가능한 <option> 값들만 쉼표로 구분해 자동값과 같은 형태로 보여준다.
  function selectOptionsDisplayText(select) {
    return Array.from(select.options).filter(o => o.value).map(o => (o.textContent || '').trim()).filter(Boolean).join(', ')
  }

  function renderFieldList() {
    const extraFields = Object.keys(rulesLocal).filter(k => !CANONICAL_FIELDS.some(([key]) => key === k))
    const allFields = [...CANONICAL_FIELDS.map(([k, l]) => ({ key: k, label: l })), ...extraFields.map(k => ({ key: k, label: k }))]
    // "새 컬럼 만들기"의 값 지정 버튼(#ptp-new-field-arm)도 다른 모든 지정 버튼(.ptp-row-arm,
    // #ptp-new-field-name-arm)과 똑같이 armed 상태를 색/문구로 보여줘야 한다(lib/scraper.ts와 항상 같이
    // 반영) — 예전엔 항상 파란 "🎯 클릭해서 지정하기"로 고정돼 있어 눌러도 지정 대기 중인지 전혀 알 수
    // 없었다(사용자 지적, 2026-09-17 — "완전히 이상하게 돼 있어").
    const newFieldTrimmedName = newFieldNameDraft.trim()
    const newFieldArmed = !!newFieldTrimmedName && armedField === newFieldTrimmedName
    const rowsHtml = allFields.map(({ key, label }) => {
      const rule = rulesLocal[key]
      const armed = armedField === key
      const columnNameArmed = armingColumnNameField === key
      const displayedColumnName = columnNameLocal[key] ?? label
      const rowBg = armed ? '#eff6ff' : rule ? '#f0fdfa' : '#fff'
      const rowBorder = armed ? '#60a5fa' : rule ? '#5eead4' : '#eee'
      const isForcedEmpty = rule?.type === 'fixed' && rule.value === ''
      let badgeText = ''
      if (rule) {
        if (isForcedEmpty) badgeText = '🚫 값 없음 고정'
        else if (rule.type === 'label') badgeText = '📋 라벨'
        else if (rule.type === 'fixed') badgeText = '✏️ 고정값'
        else if (rule.type === 'multi') {
          let partCount = 0
          try { partCount = JSON.parse(rule.value).length } catch { partCount = 0 }
          badgeText = `🧩 ${partCount}개 결합`
        } else badgeText = '🔗 셀렉터'
      }
      const badge = rule
        ? `<span style="font-size:12px;background:#fff;color:#0d9488;border:1px solid #5eead4;border-radius:8px;padding:1px 6px;white-space:nowrap">${badgeText}</span>`
        : ''
      const autoValue = !rule ? currentValue(key) : ''
      const valueBoxColor = isForcedEmpty ? '#e11d48' : rule ? '#0d9488' : '#333'
      // 값을 먼저, "미지정 · 자동값" 라벨은 옅은 글씨로 뒤에 붙인다 — 값 자체는 필드 라벨과 같은 굵기로
      // 보이게 한다(lib/scraper.ts와 항상 같이 반영, 2026-09-17).
      const valueBoxText = isForcedEmpty
        ? '항상 빈 값 (자동/AI 추출 안 함)'
        : rule
          ? (esc(lastValueLocal[key] ?? currentValue(key)) || '(값 없음)')
          : autoValue
            ? `${esc(autoValue)} <span style="font-weight:400;color:#999">(미지정 · 자동값)</span>`
            : '미지정'
      // ✕는 규칙을 완전히 지워 자동/AI 추출로 되돌린다(deleteField) — forceEmpty("항상 빈 값 고정")와는
      // 별개 버튼이다(lib/scraper.ts와 항상 같이 반영, 2026-09-17).
      const clearAutoBtn = `<button class="ptp-row-clear-auto" data-field="${esc(key)}" title="자동으로 잡힌 값을 무시하고 항상 빈 값으로 고정합니다"
              style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:12px;cursor:pointer;white-space:nowrap">🚫 항상 빈값</button>`
      const delBtn = rule
        ? `<button class="ptp-row-del" data-field="${esc(key)}" title="${isForcedEmpty ? '이 필드를 다시 자동/AI 추출이 채우도록 되돌립니다' : '지정한 규칙을 지우고 자동/AI 추출로 되돌립니다'}"
            style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:12px;cursor:pointer;white-space:nowrap">${isForcedEmpty ? '↩ 고정 해제' : '✕ 지우기'}</button>${!isForcedEmpty ? clearAutoBtn : ''}`
        : autoValue ? clearAutoBtn : ''
      // 버튼은 "새 컬럼 만들기"처럼 항상 자연폭이고(flex:1 없음), 값 표시칸(flex:1)이 남는 공간을 전부
      // 가져간다(lib/scraper.ts와 항상 같이 반영).
      const armBtnStyle = armed || !rule
        ? 'background:#2563eb;color:#fff;border:1px solid #2563eb'
        : 'background:#fff;color:#2563eb;border:1px solid #2563eb'
      // "값 직접 입력" 입력칸+저장 버튼을 "새 컬럼 만들기"처럼 접었다 펴는 링크 없이 항상 펼쳐 보여준다
      // (lib/scraper.ts와 항상 같이 반영, 사용자 지시 2026-09-17).
      const inputRow = `
          <div style="display:flex;gap:4px;margin-top:5px">
            <input class="ptp-row-input" data-field="${esc(key)}" placeholder="값 입력" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px" />
            <button class="ptp-row-save" data-field="${esc(key)}" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer">저장</button>
          </div>`
      // "새 컬럼 만들기"의 컬럼명 줄과 완전히 같은 [입력칸+지정 버튼]을 기존 필드에도 그대로 추가한다
      // (lib/scraper.ts와 항상 같이 반영, 사용자 지시 2026-09-17).
      const columnNameRow = `
          <div style="display:flex;gap:4px;margin-top:5px">
            <input class="ptp-row-name-input" data-field="${esc(key)}" value="${esc(displayedColumnName)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box" />
            <button class="ptp-row-name-arm" data-field="${esc(key)}"
              style="${columnNameArmed ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap">
              ${columnNameArmed ? '❌ 클릭 대기 취소' : '🎯 컬럼 지정'}
            </button>
          </div>`
      // "새 컬럼 만들기"와 같은 [표시칸(좌)]+[지정 버튼(우)] 형태로 통일한다(lib/scraper.ts와 항상 같이
      // 반영, 사용자 지시 2026-09-17 — "이 새컬럼 만들기 형태를 다른 컬럼도 모두 적용을 하라").
      const valueBoxStyle = `flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;font-weight:600;box-sizing:border-box;background:#f9fafb;color:${valueBoxColor};word-break:break-all`
      return `
        <div style="padding:7px 7px;margin:3px 0;border:1px solid ${rowBorder};background:${rowBg};border-radius:8px">
          <div style="display:flex;justify-content:space-between;gap:4px;align-items:baseline">
            <span style="font-size:12px">${rule ? '✅' : '⬜'} <b style="font-size:12px">${esc(label)}</b></span>
            ${badge}
          </div>
          ${columnNameRow}
          <div style="display:flex;gap:4px;margin-top:5px">
            <div style="${valueBoxStyle}">${valueBoxText}</div>
            <button class="ptp-row-arm" data-field="${esc(key)}"
                  title="${AUTO_OPTION_FIELDS.has(key) ? '색상/사이즈 등 select 옵션은 위 자동값이 이미 정확한 경우가 많습니다 — 그래도 클릭으로 다시 지정하면, 클릭한 요소가 <select>면 그 옵션 전체를 자동값과 같은 방식(쉼표로 구분)으로 읽어옵니다.' : rule && IMAGE_FIELDS.has(key) ? '이미 지정된 값에 새 요소(이미지)를 이어붙입니다' : rule ? '다시 클릭하면 지금 값을 새로 클릭한 값으로 바꿉니다' : ''}"
                  style="${armBtnStyle};border-radius:5px;padding:4px 6px;font-size:12px;cursor:pointer;white-space:nowrap">
                  ${armed ? '❌ 클릭 대기 취소' : IMAGE_FIELDS.has(key) && rule ? '🎯 이미지 추가' : '🎯 값 지정'}
                </button>
          </div>
          ${delBtn ? `<div style="display:flex;gap:4px;margin-top:4px">${delBtn}</div>` : ''}
          ${inputRow}
        </div>
      `
    }).join('') + `
      <div style="padding:7px 7px;margin:3px 0;border:1px dashed #ccc;border-radius:8px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">새 컬럼 만들기</div>
        <div style="display:flex;gap:4px;margin-bottom:4px">
          <input id="ptp-new-field-name" placeholder="컬럼명 (예: 택배사)" value="${esc(newFieldNameDraft)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box" />
          <button id="ptp-new-field-name-arm"
            style="${armingNewFieldName ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap"
            title="몰 화면에서 라벨(예: '도매가 (29개 이상)')을 클릭해 컬럼명으로 바로 채웁니다 — 조건별로 여러 공급가를 보여주는 몰에서 조건마다 새 컬럼을 만들 때 씁니다.">
            ${armingNewFieldName ? '❌ 클릭 대기 취소' : '🎯 컬럼 지정'}
          </button>
        </div>
        <div style="display:flex;gap:4px">
          <div style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box;background:#f9fafb;color:${newFieldTrimmedName && lastValueLocal[newFieldTrimmedName] ? '#0d9488' : '#bbb'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(lastValueLocal[newFieldTrimmedName] || '')}">${esc(lastValueLocal[newFieldTrimmedName] || '(지정된 값 없음)')}</div>
          <button id="ptp-new-field-arm"
            style="${newFieldArmed ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap">
            ${newFieldArmed ? '❌ 클릭 대기 취소' : '🎯 값 지정'}
          </button>
        </div>
        <div style="display:flex;gap:4px;margin-top:4px">
          <input id="ptp-new-field-value" placeholder="또는 값 직접 입력" value="${esc(newFieldValueDraft)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px" />
          <button id="ptp-new-field-add" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer">저장</button>
        </div>
      </div>
    `
    const prevScrollTop = fieldListEl.scrollTop
    fieldListEl.innerHTML = rowsHtml
    fieldListEl.scrollTop = prevScrollTop

    fieldListEl.querySelectorAll('.ptp-row-arm').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field
        armedField = armedField === field ? null : field
        armingNewFieldName = false
        armingColumnNameField = null
        if (hovered) { hovered.style.outline = ''; hovered = null }
        renderFieldList()
        updateStatus()
      })
    })
    fieldListEl.querySelectorAll('.ptp-row-name-arm').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field
        armingColumnNameField = armingColumnNameField === field ? null : field
        armedField = null
        armingNewFieldName = false
        if (hovered) { hovered.style.outline = ''; hovered = null }
        renderFieldList()
        updateStatus()
      })
    })
    fieldListEl.querySelectorAll('.ptp-row-name-input').forEach(input => {
      input.addEventListener('input', () => {
        columnNameLocal[input.dataset.field] = input.value
      })
    })
    fieldListEl.querySelectorAll('.ptp-row-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field
        const input = fieldListEl.querySelector(`.ptp-row-input[data-field="${CSS.escape(field)}"]`)
        const value = input?.value.trim()
        if (!value) return
        saveFieldValue(field, { type: 'fixed', value }, value)
        renderFieldList()
      })
    })
    fieldListEl.querySelectorAll('.ptp-row-del').forEach(btn => {
      btn.addEventListener('click', () => { deleteField(btn.dataset.field); renderFieldList() })
    })
    fieldListEl.querySelectorAll('.ptp-row-clear-auto').forEach(btn => {
      btn.addEventListener('click', () => { forceEmpty(btn.dataset.field); renderFieldList() })
    })
    fieldListEl.querySelector('#ptp-new-field-name').addEventListener('input', e => {
      newFieldNameDraft = e.target.value
    })
    fieldListEl.querySelector('#ptp-new-field-value').addEventListener('input', e => {
      newFieldValueDraft = e.target.value
    })
    fieldListEl.querySelector('#ptp-new-field-name-arm').addEventListener('click', () => {
      armingNewFieldName = !armingNewFieldName
      if (armingNewFieldName) { armedField = null; armingColumnNameField = null }
      if (hovered) { hovered.style.outline = ''; hovered = null }
      renderFieldList()
      updateStatus()
    })
    fieldListEl.querySelector('#ptp-new-field-arm').addEventListener('click', () => {
      const nameEl = fieldListEl.querySelector('#ptp-new-field-name')
      const field = nameEl.value.trim()
      if (!field) { nameEl.focus(); return }
      armedField = armedField === field ? null : field
      armingNewFieldName = false
      armingColumnNameField = null
      if (hovered) { hovered.style.outline = ''; hovered = null }
      renderFieldList()
      updateStatus()
    })
    fieldListEl.querySelector('#ptp-new-field-add').addEventListener('click', () => {
      const nameEl = fieldListEl.querySelector('#ptp-new-field-name')
      const valueEl = fieldListEl.querySelector('#ptp-new-field-value')
      const field = nameEl.value.trim()
      const value = valueEl.value.trim()
      if (!field || !value) return
      saveFieldValue(field, { type: 'fixed', value }, value)
      newFieldNameDraft = ''
      newFieldValueDraft = ''
      renderFieldList()
    })
  }
  renderFieldList()

  function onClick(e) {
    const el = e.target
    if (el === panel || panel.contains(el)) return
    if (armingNewFieldName) {
      // 값이 아니라 "새 컬럼 만들기"의 컬럼명 입력칸을 채운다 — lib/scraper.ts의 onClick과 동일 동작.
      e.preventDefault()
      e.stopPropagation()
      newFieldNameDraft = elementDisplayText(el)
      armingNewFieldName = false
      renderFieldList()
      updateStatus()
      if (hovered) { hovered.style.outline = ''; hovered = null }
      return
    }
    if (armingColumnNameField) {
      // 기존 필드의 "컬럼 지정" — lib/scraper.ts의 onClick과 동일 동작. 규칙을 저장하지 않고 그 필드의
      // columnNameLocal(로컬 참고용 컬럼명)만 클릭한 텍스트로 바꿔치기한다.
      e.preventDefault()
      e.stopPropagation()
      columnNameLocal[armingColumnNameField] = elementDisplayText(el)
      armingColumnNameField = null
      renderFieldList()
      updateStatus()
      if (hovered) { hovered.style.outline = ''; hovered = null }
      return
    }
    if (!armedField) return
    e.preventDefault()
    e.stopPropagation()

    if (IMAGE_FIELDS.has(armedField)) {
      appendImagePart(armedField, computeGallerySelector(el))
    } else if (el.tagName === 'SELECT') {
      const rule = { type: 'selector', value: computeSelector(el) }
      saveFieldValue(armedField, rule, selectOptionsDisplayText(el))
    } else {
      const label = detectLabel(el)
      const rule = label ? { type: 'label', value: label } : { type: 'selector', value: computeSelector(el) }
      saveFieldValue(armedField, rule, elementDisplayText(el))
    }
    armedField = null
    renderFieldList()
    updateStatus()
    if (hovered) { hovered.style.outline = ''; hovered = null }
  }

  panel.querySelector('#ptp-picker-close').addEventListener('click', () => w.__ptpPickerTeardown?.())
  panel.querySelector('#ptp-picker-x').addEventListener('click', () => w.__ptpPickerTeardown?.())

  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('click', onClick, true)

  w.__ptpPickerTeardown = () => {
    fieldListEl.querySelectorAll('.ptp-row-input').forEach(input => {
      const value = input.value.trim()
      if (value) saveFieldValue(input.dataset.field, { type: 'fixed', value }, value)
    })
    const newNameEl = fieldListEl.querySelector('#ptp-new-field-name')
    const newValueEl = fieldListEl.querySelector('#ptp-new-field-value')
    if (newNameEl?.value.trim() && newValueEl?.value.trim()) {
      saveFieldValue(newNameEl.value.trim(), { type: 'fixed', value: newValueEl.value.trim() }, newValueEl.value.trim())
    }
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('click', onClick, true)
    onDragEnd()
    if (hovered) hovered.style.outline = ''
    panel.remove()
    w.__ptpPickerActive = false
    w.__ptpPickerTeardown = undefined
    // 백그라운드에 "닫혔다"고 알려, 지금까지 쏘아둔 저장이 다 끝날 때까지 기다렸다가 디버거를 떼게 한다.
    window.ptpPickerClose()
  }
}

function buildPickerScript(seed) {
  return `(${pickerPageScript.toString()})(${JSON.stringify(seed)})`
}

/** "스크랩 대상 직접지정" 시작 — 몰 탭에 디버거를 붙이고 ptpSavePick/ptpPickerClose 바인딩을 건 뒤
 *  클릭식 피커를 주입한다. 사용자가 패널을 닫을 때까지(ptpPickerClose) 디버거를 계속 붙여둔다 —
 *  addBinding이 살아있으려면 CDP 세션이 유지돼야 하기 때문이다(일반모드는 로그인 창이 열려있는 동안
 *  page.exposeFunction이 계속 살아있는 것과 같은 이치). */
/** "📍 보조 - 현재 카테고리 가져오기" — 지금 이 탭 URL을 그대로 PTP의 "카테고리 URL 목록"에 추가한다.
 *  일반모드의 "현재 카테고리 가져오기"(서버가 로그인 창의 현재 URL을 직접 읽음)와 같은 목적이지만,
 *  개발자모드는 서버가 이 탭에 직접 접근할 수 없다 — 다만 필요한 정보가 tab.url 하나뿐이라
 *  chrome.debugger를 붙일 필요 없이(DOM 접근 불필요) 곧바로 서버에 넘긴다(2026-08-22). PTP 화면이
 *  몇 초마다 폴링해서 목록에 반영한다. */
async function runCaptureCurrentCategory(tab, site) {
  try {
    const res = await fetch(`${SITE_API_BASE}/${site.id}/current-category`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || String(res.status) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function runPicker(tab, site) {
  // attach와 addBinding은 매번 다시 한다 — "이미 세션이 잡혀있으니 건너뛴다"는 최적화를 시도했다가
  // pickerSessions(메모리)에만 남은 낡은 기록을 보고 실제로는 없는 바인딩을 "있다"고 오판해
  // window.ptpSavePick 자체가 안 만들어지는 문제가 실제로 발생했다(패널은 뜨는데 저장은 전부 실패).
  // attachDebugger가 이미 붙어있는 경우(자기 자신의 이전 연결)를 detach 후 재시도로 알아서
  // 회복하므로, 매번 새로 attach+addBinding해도 안전하고 더 확실하다.
  try {
    await attachDebugger(tab.id)
  } catch (e) {
    console.log('[PTP] 피커 시작 실패(디버거 연결 안 됨):', e.message)
    return { ok: false, error: `디버거 연결 실패: ${e.message}` }
  }
  try {
    // evalInTab과 같은 이유로 타임아웃을 건다 — 이 두 호출도 chrome.debugger.sendCommand라 자체
    // 타임아웃이 없다(2026-08-15, 같은 종류 문제 재발 방지).
    await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.addBinding', { name: 'ptpSavePick' }), 10_000, 'Runtime.addBinding(ptpSavePick)')
    await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.addBinding', { name: 'ptpDeleteField' }), 10_000, 'Runtime.addBinding(ptpDeleteField)')
    await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.addBinding', { name: 'ptpPickerClose' }), 10_000, 'Runtime.addBinding(ptpPickerClose)')
    pickerSessions.set(tab.id, { siteId: site.id, pendingSaves: [] })
    const seed = { previewProduct: site.previewProduct, extractionRules: site.extractionRules, masterLabels: site.masterLabels, masterOrder: site.masterOrder, siteId: site.id }
    await evalInTab(tab.id, buildPickerScript(seed))
    return { ok: true }
  } catch (e) {
    pickerSessions.delete(tab.id)
    await safeDetach(tab.id)
    console.log('[PTP] 피커 시작 중 오류:', e.message)
    return { ok: false, error: e.message }
  }
}

// 우클릭 컨텍스트메뉴는 몰이 우클릭 자체를 JS로 차단하면(실제 발견된 사례 — 일부 쇼핑몰의 이미지 보호
// 스크립트) 아예 뜨지 않아 무용지물이 될 수 있다 — 그래서 이제 기본 접근 경로는 팝업(아래
// chrome.runtime.onMessage)이고, 컨텍스트메뉴는 우클릭이 정상 동작하는 몰을 위한 보조 경로로만 남긴다.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return
  if (info.menuItemId !== 'ptp-preview' && info.menuItemId !== 'ptp-picker') return

  const hostname = new URL(tab.url).hostname
  const site = await resolveSite(hostname).catch(() => null)
  if (!site) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 등록된 URL과 일치하지 않습니다.`)
    return
  }
  // 팝업 경로(chrome.runtime.onMessage)와 같은 이유로, 일반모드 몰에서는 "몰 구조분석" 외 액션을 막는다
  // — 미리보기/피커는 여기서 다루지 않으므로 사실상 이 리스너 전체가 비활성화된다.
  if (site.mode === 'normal') {
    console.log(`[PTP] "${hostname}"은 일반모드 몰입니다 — 확장에서는 몰 구조분석만 지원합니다.`)
    return
  }
  if (info.menuItemId === 'ptp-preview') await runPreview(tab, site, site.aiPreviewMode)
  else await runPicker(tab, site)
})

/** "몰 구조분석" — 일반모드가 쓰는 서버 쪽 몰 구조분석(lib/scraper.ts의 profileMallStructure, PTP
 *  화면의 "🔍 몰 구조분석"과 완전히 같은 엔드포인트)을 그대로 트리거한다. 그 함수는 withContext로
 *  브라우저 컨텍스트를 얻는데, 직접로그인 필수 몰(개발자모드로 등록된 몰)은 이미 신뢰가 쌓인 사용자의
 *  개인 크롬 프로필 사본을 서버가 스스로 헤드리스로 띄워 처리한다 — 그래서 chrome.debugger나 "지금 이
 *  탭"이 전혀 필요 없고, 그냥 요청만 쏘아두면 된다(결과는 PTP 화면이 폴링해서 보여줌). */
async function runProfile(site) {
  try {
    const res = await fetch(`${SITE_API_BASE}/${site.id}/profile`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || String(res.status) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** "다음 페이지" 감지가 이 몰에서 실제로 끝까지 통하는지 미리 검증한다 — 모자사러에서 페이지 번호
 *  묶음(1~9) 끝의 화살표를 못 찾아 실제 33페이지 중 9페이지에서 조용히 멈췄던 문제(2026-08-22)를,
 *  스크랩을 다 돌려보고 나서야 개수가 모자란 걸로 알아채는 대신 "몰 구조분석" 시점에 바로 알 수 있게
 *  한다 — "다른 몰이 다른 형태일 수 있는데 그때마다 이렇게 어려워지면 안 된다"는 사용자 요청. 정답은
 *  buildPaginationSignalExpr의 "마지막 페이지로" 버튼 신호(href가 항상 진짜 마지막 페이지를 가리키는
 *  구조라 신뢰도가 높다 — lib/scraper.ts의 readLastPageFromNavButton과 같은 근거)로 삼고, 실제 스크랩이
 *  쓰는 것과 똑같은 COLLECT_LINKS_EXPR의 "다음" 링크를 실제로 따라가며 몇 페이지까지 도달하는지 센다.
 *  전체를 다 걷지 않고 "블록 경계 하나는 넘는지"만 확인할 수 있는 만큼(최대 12페이지)만 시험해 검증
 *  자체가 "몰 구조분석"을 과하게 늦추지 않게 한다. */
async function verifyNextPageDetection(tab, categoryHref) {
  try {
    await navigate(tab.id, categoryHref)
    const signal = await evalInTab(tab.id, buildPaginationSignalExpr('')).catch(() => null)
    // "마지막 페이지" 버튼 자체를 못 찾았거나 1페이지짜리 카테고리면 검증할 게 없다 — 조용히 건너뛴다.
    if (!signal?.lastPage || signal.lastPage <= 3) return null
    const testTarget = Math.min(signal.lastPage, 12)
    let reached = 1
    while (reached < testTarget) {
      const { nextUrl } = await evalInTab(tab.id, COLLECT_LINKS_EXPR).catch(() => ({ nextUrl: null }))
      if (!nextUrl) break
      await navigate(tab.id, nextUrl)
      reached++
    }
    if (reached >= testTarget) return null // 정상 — 보고할 문제 없음
    return { statedLastPage: signal.lastPage, reachedPage: reached }
  } catch {
    return null // 검증 자체가 실패해도 "몰 구조분석" 전체를 실패로 만들지 않는다 — 이건 부가 확인일 뿐이다.
  }
}

/** "몰 구조분석" 버튼 하나로 셋을 같이 돌린다 — 예전엔 "몰 구조분석"/"카테고리 하위구조 자동확인"/
 *  "정렬 옵션 감지"가 따로 눌러야 하는 버튼 3개였는데, 사용자 입장에서 몰 하나를 처음 붙일 때 결국
 *  셋 다 순서대로 눌러야 해서 번거롭다는 지적으로 하나로 합쳤다(2026-08-22). runProfile은 서버가 알아서
 *  띄우는 별도의 헤드리스 브라우저(개인 크롬 프로필 사본)를 쓰므로 이 탭과 무관해 병렬로 같이 돌리고,
 *  카테고리 하위구조 확인과 정렬 옵션 감지는 둘 다 이 탭의 chrome.debugger를 붙였다 떼야 해서(동시에
 *  붙이면 충돌) 순서대로 실행한다. */
async function runFullMallProfile(tab, site) {
  const profilePromise = runProfile(site)
  const expandRes = await runExpandCategories(tab, site)
  const sortRes = await runDetectSortOptions(tab, site)
  const profileRes = await profilePromise

  const failures = []
  if (!profileRes.ok) failures.push(`몰 구조분석: ${profileRes.error}`)
  if (!expandRes.ok) failures.push(`카테고리 하위구조: ${expandRes.error}`)
  if (!sortRes.ok) failures.push(`정렬 옵션: ${sortRes.error}`)
  // "3개 다 실패"만 진짜 실패로 본다 — 아래 페이지네이션 경고는 이 셋과 별개(부가 확인)라 이 개수에
  // 안 섞는다. 섞으면 예컨대 핵심 2개만 실패했는데 경고까지 더해져 3개가 돼버려 "전부 실패"로
  // 잘못 보고되는 문제가 생긴다.
  const coreFailureCount = failures.length

  // 봇 차단 인터스티셜 때문에 재시도 후에도 하위구조를 못 펼친 카테고리가 있으면 알려준다 — 카테고리
  // 하위구조 확인 자체는 (남은 항목을 미확장인 채로 남기고) 성공으로 끝났으므로 coreFailureCount에는
  // 안 섞는다(페이지네이션 경고와 같은 이유).
  if (expandRes.ok && expandRes.blockedCount) {
    failures.push(`⚠ 접속 차단으로 ${expandRes.blockedCount}개 카테고리는 하위구조를 확인하지 못했습니다 — 잠시 후 "몰 구조분석"을 다시 실행해보세요.`)
  }

  // 방금 하위구조를 확인한 대분류 중 하나로 페이지네이션 "다음" 감지를 검증한다 — site.categoryLinks가
  // 비어있으면(카테고리 불러오기를 아직 안 한 몰) 건너뛴다.
  if (site.categoryLinks?.length) {
    try {
      await attachDebugger(tab.id)
      const paginationIssue = await verifyNextPageDetection(tab, site.categoryLinks[0].href)
      if (paginationIssue) {
        failures.push(`⚠ 페이지네이션 "다음" 감지 불안정 — "${site.categoryLinks[0].name}" 카테고리가 실제 ${paginationIssue.statedLastPage}페이지인데 ${paginationIssue.reachedPage}페이지에서 멈춤(실제 스크랩 시 상품이 누락될 수 있습니다 — background.js의 COLLECT_LINKS_EXPR 셀렉터를 이 몰에 맞게 보완해야 합니다)`)
      }
    } catch { /* 검증 자체의 디버거 연결 실패는 "몰 구조분석"의 나머지 결과에 영향 주지 않는다 */ }
    finally { await safeDetach(tab.id) }
  }

  if (coreFailureCount === 3) return { ok: false, error: failures.join(' / ') }
  return {
    ok: true,
    expandCount: expandRes.ok ? expandRes.count : null,
    sortCount: sortRes.ok ? sortRes.count : null,
    // 일부만 실패했거나(예: 카테고리 목록이 아직 없어 나머지 둘만 실패) 페이지네이션 경고가 있으면
    // 그래도 성공으로 보고하되 어떤 게 빠졌는지/무엇을 확인해야 하는지 같이 알려준다.
    partialErrors: failures.length ? failures : undefined,
  }
}

/** 팝업(popup.js)이 보내는 메시지 — 우클릭이 막힌 몰에서도 기능을 쓸 수 있는 기본 경로.
 *  탭 조회는 popup.js가 이미 자신이 매인 창 기준으로 끝내고 tabId/tabUrl로 넘겨준다 — 이 서비스 워커
 *  자신은 "현재 창"이라는 개념이 없어(특정 창에 매인 UI가 아니다) 여기서 다시 chrome.tabs.query를
 *  하면 어느 창 기준인지 불확실해진다. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg.tabId || !msg.tabUrl) { sendResponse({ ok: false, error: '활성 탭을 찾을 수 없습니다' }); return }
    const tab = { id: msg.tabId, url: msg.tabUrl }

    const hostname = new URL(tab.url).hostname
    const site = await resolveSite(hostname).catch(() => null)
    if (!site) { sendResponse({ ok: false, error: `"${hostname}"은 PTP Mall 관리에 등록된 URL과 일치하지 않습니다(Mall 정보의 URL을 확인하세요)` }); return }
    // 일반모드 몰은 서버가 이미 정규 스크랩 파이프라인(Playwright)을 돌리므로, 확장이 같은 몰에 별도
    // 파이프라인(scrape_staging_items)을 동시에 만들면 안 된다 — "몰 구조분석"(카테고리 하위구조/정렬
    // 옵션/페이지네이션 검증까지 포함)만 예외로 허용한다(2026-08-29, 일반모드에서도 이 검증이 필요해
    // resolve 대상을 넓히며 같이 추가한 안전장치).
    if (site.mode === 'normal' && msg.action !== PTP_ACTIONS.PROFILE) {
      sendResponse({ ok: false, error: '이 몰은 일반모드입니다 — 확장에서는 "몰 구조분석"만 지원합니다. 스크랩 시작/미리보기 등은 PTP 화면에서 진행하세요.' })
      return
    }

    if (msg.action === PTP_ACTIONS.START) sendResponse(await startScrape(tab, site))
    else if (msg.action === PTP_ACTIONS.PREVIEW) sendResponse(await runPreview(tab, site, site.aiPreviewMode))
    else if (msg.action === PTP_ACTIONS.PICKER) sendResponse(await runPicker(tab, site))
    else if (msg.action === PTP_ACTIONS.PROFILE) sendResponse(await runFullMallProfile(tab, site))
    else if (msg.action === PTP_ACTIONS.CURRENT_CATEGORY) sendResponse(await runCaptureCurrentCategory(tab, site))
    else sendResponse({ ok: false, error: `알 수 없는 action: ${msg.action}` })
  })()
  return true // 비동기 sendResponse를 쓰겠다는 표시
})
