import crypto from 'crypto'

/**
 * 쿠팡 Open API HMAC 서명(developers.coupang.com "Creating HMAC Signature" 문서 기준, 2026-10-03 확인).
 * 서명 대상 메시지는 `datetime + method(소문자) + path + query`를 구분자 없이 그대로 이어붙인 것 —
 * query가 없으면 빈 문자열, "?"도 붙이지 않는다(실제 URL 조립 시에는 "?"를 쓰지만 서명 메시지에는 안 씀,
 * 공식 Python 예제 문서로 재확인). 이 셋(순서/구분자 없음/method 소문자)을 하나라도 틀리면 서명이 안
 * 맞아 전부 401로 실패하므로, 실제 API 문서를 읽고 작성했다(추측 아님) — 단, 실제 발급받은 키로 호출해
 * 성공 응답까지 받아본 적은 없어(이 환경에 쿠팡 벤더 키가 없음) 최종 검증은 미완료.
 */

/** "yyMMddTHHmmssZ"(GMT) — 쿠팡 문서가 요구하는 정확한 포맷. 테스트가 특정 시각을 고정할 수 있도록
 *  Date를 인자로 받는다. */
export function coupangSignedDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
}

export interface CoupangSignature { signedDate: string; signature: string }

/** method/path/query로 서명을 계산한다. query는 "key=value&key2=value2" 형태(선두 "?" 없이), 없으면 ''. */
export function signCoupangRequest(method: string, path: string, query: string, secretKey: string, now: Date): CoupangSignature {
  const signedDate = coupangSignedDate(now)
  const message = `${signedDate}${method.toLowerCase()}${path}${query}`
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex')
  return { signedDate, signature }
}

export function coupangAuthorizationHeader(accessKey: string, sig: CoupangSignature): string {
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${sig.signedDate}, signature=${sig.signature}`
}
