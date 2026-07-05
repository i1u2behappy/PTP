import axios from 'axios'

const API_BASE = 'http://2captcha.com'

function getApiKey(): string {
  const key = process.env.TWOCAPTCHA_API_KEY
  if (!key) throw new Error('TWOCAPTCHA_API_KEY가 설정되지 않았습니다')
  return key
}

async function submit(params: Record<string, string>): Promise<string> {
  const res = await axios.get(`${API_BASE}/in.php`, { params: { key: getApiKey(), json: 1, ...params } })
  if (res.data.status !== 1) throw new Error(`2Captcha 제출 실패: ${res.data.request}`)
  return res.data.request as string
}

async function pollResult(id: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5_000))
    const res = await axios.get(`${API_BASE}/res.php`, { params: { key: getApiKey(), action: 'get', id, json: 1 } })
    if (res.data.status === 1) return res.data.request as string
    if (res.data.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha 오류: ${res.data.request}`)
  }
  throw new Error('2Captcha 풀이 시간 초과 (120초)')
}

/** reCAPTCHA v2 (체크박스) 풀이 — sitekey는 위젯의 data-sitekey 속성 */
export async function solveRecaptchaV2(sitekey: string, pageUrl: string): Promise<string> {
  const id = await submit({ method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl })
  return pollResult(id)
}

/** hCaptcha 풀이 — sitekey는 위젯의 data-sitekey 속성 */
export async function solveHCaptcha(sitekey: string, pageUrl: string): Promise<string> {
  const id = await submit({ method: 'hcaptcha', sitekey, pageurl: pageUrl })
  return pollResult(id)
}

/** 이미지 기반 텍스트 캡차 풀이 — base64Image는 데이터 URI 접두사 없는 순수 base64 */
export async function solveImageCaptcha(base64Image: string): Promise<string> {
  const id = await submit({ method: 'base64', body: base64Image })
  return pollResult(id)
}
