import { registerRpc, REQUEST_SIGNAL, type RpcFn } from './rpc-server'
import * as scraper from '../lib/scraper'
import { runScraping } from '../lib/scrape/run'
import { runMallStructureReport, runMallProfileCheckForScrape } from '../lib/scrape/mallProfile'
import { reExtractStagingItems } from '../lib/scrape/reextract'
import { fetchImageViaBrowser } from '../lib/imagesBrowser'

// lib/scraper.ts 등 기존 코드는 한 글자도 안 바꾼다 — 이 파일은 그 함수들을 이름으로 등록해 RPC로
// 노출하는 얇은 매핑표일 뿐이다. 함수 목록/분류는 마이그레이션 조사(2026-08-23) 결과를 그대로 따른다.

function reg(name: string, fn: (...args: never[]) => unknown) {
  registerRpc(name, fn as RpcFn)
}

/** previewCatalog/countDedupedProductUrls는 opts.stopSignal(AbortSignal)로 "중지" 신호를 받는다 —
 *  이 요청의 HTTP 연결이 끊기면(클라이언트가 fetch를 abort) rpc-server가 만들어준 신호를 opts에 얹어
 *  넘긴다. dispatch가 실제 인자들 뒤에 { [REQUEST_SIGNAL]: signal } 객체를 하나 더 붙여서 부르므로,
 *  마지막 인자에서 그 신호를 꺼내 opts.stopSignal로 병합한다. */
function withStopSignal<T extends { stopSignal?: AbortSignal }>(fn: (opts: T) => unknown) {
  return (...args: unknown[]) => {
    const ctx = args[args.length - 1] as { [REQUEST_SIGNAL]?: AbortSignal } | undefined
    const opts = args[0] as T
    return fn({ ...opts, stopSignal: ctx?.[REQUEST_SIGNAL] })
  }
}

export function registerAll() {
  // 상태 조회/기록 — 순수 Map 읽기/쓰기라 취소 신호가 필요 없다.
  reg('getOpenPageUrl', scraper.getOpenPageUrl)
  reg('navigateOpenPageTo', scraper.navigateOpenPageTo)
  reg('requestStop', scraper.requestStop)
  reg('isStopRequested', scraper.isStopRequested)
  reg('clearStopRequest', scraper.clearStopRequest)
  reg('getCollectProgress', scraper.getCollectProgress)
  reg('setCollectProgress', scraper.setCollectProgress)
  reg('getSiteLockStatus', scraper.getSiteLockStatus)
  reg('setSiteLockDetail', scraper.setSiteLockDetail)
  reg('getSiteLastRunSignals', scraper.getSiteLastRunSignals)
  reg('isAnySiteBusy', scraper.isAnySiteBusy)
  // scripts/restart-dev-server.ps1이 워커를 강제종료하기 전에 이 RPC로 먼저 불러 열린 로그인 세션을
  // 정상 종료시킨다(2026-09-01) — lib/workerRestart.ts의 restartWorker()는 이미 이 함수를 같은 프로세스
  // 안에서 직접 호출하지만, 외부 PowerShell 스크립트는 그 경로를 안 타므로 RPC로 노출해야 닿을 수 있다.
  // dispatch가 실제 인자들 뒤에 REQUEST_SIGNAL 객체를 하나 더 붙여 부르는데(rpc-server.ts 참고), 이
  // 스크립트는 args를 빈 배열로 보내므로 그 객체가 그대로 timeoutMs 자리로 들어가 버린다(숫자가 아닌
  // 객체가 setTimeout 지연시간으로 쓰여 사실상 유예시간 없이 즉시 닫힘) — 인자를 받지 않는 얇은
  // 래퍼로 감싸 항상 함수 자신의 기본값(3초)을 쓰게 한다.
  reg('closeAllOpenSessionsGracefully', () => scraper.closeAllOpenSessionsGracefully())
  reg('getPreviewProgress', scraper.getPreviewProgress)
  reg('stopProfileAnalysis', scraper.stopProfileAnalysis)
  reg('stopCategoryDiscovery', scraper.stopCategoryDiscovery)

  // 로그인 창 — 실제 개인 브라우저를 띄우는 것이라 취소 개념이 없다.
  reg('openLoginWindow', scraper.openLoginWindow)
  reg('openManualLoginWindow', scraper.openManualLoginWindow)
  reg('openUrlInLoginWindow', scraper.openUrlInLoginWindow)
  reg('focusManualLoginChrome', scraper.focusManualLoginChrome)
  reg('openUrlInManualLoginChrome', scraper.openUrlInManualLoginChrome)

  // 단발 스크랩/추출 — 상품 1건 단위라 중지 개념이 없다(금방 끝남).
  reg('scrapeSingleProduct', scraper.scrapeSingleProduct)
  reg('fetchPageText', scraper.fetchPageText)
  reg('extractFromHtml', scraper.extractFromHtml)
  reg('startElementPicker', scraper.startElementPicker)
  reg('reExtractPreviewProduct', scraper.reExtractPreviewProduct)

  // "몰 구조분석" — 취소는 stopProfileAnalysis(siteId)로 별도 처리(위에 이미 등록).
  reg('runMallStructureReport', runMallStructureReport)
  reg('runMallProfileCheckForScrape', runMallProfileCheckForScrape)

  // 카테고리/재확인 — discoverCategoryLinks 자체는 stopCategoryDiscovery(siteId)로 별도 취소(위에
  // 이미 등록, 2026-08-26). 나머지는 opts.sessionId+isStopRequested로 중지(기존 방식 그대로).
  reg('discoverCategoryLinks', scraper.discoverCategoryLinks)
  reg('expandCategoryChildren', scraper.expandCategoryChildren)
  reg('detectSortOptionsForCategory', scraper.detectSortOptionsForCategory)
  reg('recheckMallProducts', scraper.recheckMallProducts)
  reg('reExtractStagingItems', reExtractStagingItems)

  // 실제 스크랩 시작 — Next.js 라우트가 세션 row를 만든 뒤 완료를 기다리지 않고(fire-and-forget) 바로
  // sessionId를 응답하던 기존 방식 그대로, 이 RPC 호출도 워커 쪽에서 오래 걸리는 채로 남아있고 Next.js
  // 쪽은 await 없이 흘려보낸다(lib/workerClient.ts 참고).
  reg('runScraping', runScraping)

  // opts.stopSignal(브라우저의 "중지" 버튼 → fetch abort)로 취소되는 것들만 별도 래핑.
  reg('previewCatalog', withStopSignal(scraper.previewCatalog))
  reg('countDedupedProductUrls', withStopSignal(scraper.countDedupedProductUrls))
  reg('countCategoryOverlap', withStopSignal(scraper.countCategoryOverlap))

  // lib/scrape/staging.ts의 mergeStagingItems가 이미지 다운로드 실패 시(로그인 쿠키가 필요한 이미지
  // 호스트) 로그인된 브라우저로 재시도하는 경로 — withContext를 통째로 RPC할 수 없어 이 전용 함수로
  // 좁혀서 노출한다(lib/images.ts 참고).
  reg('fetchImageViaBrowser', fetchImageViaBrowser)
}
