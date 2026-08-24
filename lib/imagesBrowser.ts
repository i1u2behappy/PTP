import { withContext } from './scraper'

/** downloadProductImages(lib/images.ts)가 일반 HTTP로 이미지를 못 받았을 때(로그인 세션이 있어야만
 *  열리는 도매몰 이미지 호스트) 쓰는 폴백 — 그 몰의 저장된 로그인 프로필로 헤드리스 브라우저 컨텍스트를
 *  하나 띄워(로그인 창이 열려있으면 그걸 그대로 재사용) 실패한 URL들만 한 번에 다시 받는다. 브라우저
 *  컨텍스트의 request는 그 컨텍스트가 가진 쿠키를 자동으로 실어 보내므로, 로그인 창이 오래 전에 닫혔어도
 *  프로필 폴더에 남은 쿠키가 유효한 한 그대로 통과한다(withContext가 이미 하는 폴백 그대로 재사용).
 *
 *  2026-08-23 — 스크래핑/Playwright 작업을 전부 별도 워커 프로세스로 옮기며(Next.js 개발서버와 같은
 *  프로세스에서 돌아 Fast Refresh 강제 새로고침을 유발하던 문제) 이 함수만 별도 파일로 뺐다: lib/images.ts는
 *  Next.js 프로세스에서도 그대로 쓰이는데(순수 이미지 리사이즈/저장 로직), withContext는 워커 프로세스
 *  에서만 실행돼야 한다 — 이 파일(lib/imagesBrowser.ts)은 worker/registry.ts만 import한다. lib/images.ts는
 *  이 함수를 직접 부르지 않고 lib/workerClient.ts를 거쳐 RPC로 호출한다.
 *
 *  결과를 base64 문자열로 돌려주는 이유: HTTP(JSON)로는 Buffer를 그대로 실어 보낼 수 없다 — 호출부
 *  (lib/images.ts)가 Buffer.from(str, 'base64')로 되돌린다. */
export async function fetchImageViaBrowser(siteId: number, urls: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  await withContext({ siteId }, async (_page, context) => {
    for (const url of urls) {
      try {
        const res = await context.request.get(url, { headers: { Referer: url } })
        if (res.ok()) result[url] = (await res.body()).toString('base64')
      } catch { /* 이 URL은 포기 */ }
    }
  }, '이미지 다운로드')
  return result
}
