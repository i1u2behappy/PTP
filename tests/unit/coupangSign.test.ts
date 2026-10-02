import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { coupangSignedDate, signCoupangRequest, coupangAuthorizationHeader } from '../../lib/marketplace/coupangSign'

// 공식 문서(developers.coupang.com "Creating HMAC Signature")의 날짜 예시를 그대로 고정 시각으로 써서
// 포맷이 일치하는지 확인한다 — "180809T120530Z"는 2018-08-09 12:05:30 UTC.
describe('coupangSignedDate', () => {
  it('공식 문서 예시 시각과 동일한 포맷을 만든다', () => {
    expect(coupangSignedDate(new Date('2018-08-09T12:05:30Z'))).toBe('180809T120530Z')
  })

  it('월/일/시/분/초가 한 자리면 0을 채운다', () => {
    expect(coupangSignedDate(new Date('2026-01-02T03:04:05Z'))).toBe('260102T030405Z')
  })
})

describe('signCoupangRequest', () => {
  const now = new Date('2018-08-09T12:05:30Z')

  it('query가 없으면 datetime+method(소문자)+path만 이어붙여 서명한다(구분자 없음)', () => {
    const path = '/v2/providers/openapi/apis/api/v4/vendors/A00000000/returnRequests'
    const { signedDate, signature } = signCoupangRequest('GET', path, '', 'my-secret', now)
    const expectedMessage = `180809T120530Zget${path}`
    const expected = crypto.createHmac('sha256', 'my-secret').update(expectedMessage).digest('hex')
    expect(signedDate).toBe('180809T120530Z')
    expect(signature).toBe(expected)
  })

  it('query가 있으면 "?" 없이 바로 이어붙인다 — 물음표를 끼워넣으면 공식 메시지 포맷과 달라져 서명이 전부 틀린다', () => {
    const path = '/v2/providers/openapi/apis/api/v4/vendors/A00000000/returnRequests'
    const query = 'createdAtFrom=2018-08-09&createdAtTo=2018-08-09&status=UC'
    const { signature } = signCoupangRequest('GET', path, query, 'my-secret', now)
    const withQuestionMark = crypto.createHmac('sha256', 'my-secret').update(`180809T120530Zget${path}?${query}`).digest('hex')
    const withoutSeparator = crypto.createHmac('sha256', 'my-secret').update(`180809T120530Zget${path}${query}`).digest('hex')
    expect(signature).toBe(withoutSeparator)
    expect(signature).not.toBe(withQuestionMark)
  })

  it('method 대소문자와 무관하게 메시지에는 항상 소문자로 들어간다', () => {
    const a = signCoupangRequest('GET', '/x', '', 'k', now)
    const b = signCoupangRequest('get', '/x', '', 'k', now)
    expect(a.signature).toBe(b.signature)
  })
})

describe('coupangAuthorizationHeader', () => {
  it('공식 형식("CEA algorithm=...") 그대로 조립한다', () => {
    const header = coupangAuthorizationHeader('my-access-key', { signedDate: '180809T120530Z', signature: 'abcd1234' })
    expect(header).toBe('CEA algorithm=HmacSHA256, access-key=my-access-key, signed-date=180809T120530Z, signature=abcd1234')
  })
})
