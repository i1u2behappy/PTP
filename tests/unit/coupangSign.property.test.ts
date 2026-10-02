import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { coupangSignedDate, signCoupangRequest } from '../../lib/marketplace/coupangSign'

describe('coupangSignedDate (속성 기반)', () => {
  it('임의의 유효한 시각에 대해 항상 "yyMMddTHHmmssZ"(14자) 포맷을 만든다', () => {
    fc.assert(fc.property(
      fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
      (d) => {
        const out = coupangSignedDate(d)
        expect(out).toMatch(/^\d{6}T\d{6}Z$/)
      },
    ))
  })
})

describe('signCoupangRequest (속성 기반)', () => {
  it('같은 입력이면 항상 같은 서명을 낸다(결정론적 — 재시도/재전송 시 서명이 흔들리면 안 됨)', () => {
    fc.assert(fc.property(
      fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'),
      fc.string({ minLength: 1 }), fc.string(), fc.string({ minLength: 1 }),
      fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
      (method, path, query, secret, now) => {
        const a = signCoupangRequest(method, path, query, secret, now)
        const b = signCoupangRequest(method, path, query, secret, now)
        expect(a).toEqual(b)
      },
    ))
  })

  it('시크릿 키가 다르면 서명도 달라진다(키가 안 섞이는 버그 방지)', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }), fc.string({ minLength: 1 }).filter(s => s !== 'fixed-secret'),
      (path, otherSecret) => {
        const now = new Date('2026-01-01T00:00:00Z')
        const a = signCoupangRequest('GET', path, '', 'fixed-secret', now)
        const b = signCoupangRequest('GET', path, '', otherSecret, now)
        expect(a.signature).not.toBe(b.signature)
      },
    ))
  })

  it('항상 64자 16진수 문자열(SHA256 hex)을 반환한다', () => {
    fc.assert(fc.property(
      fc.string(), fc.string(), fc.string({ minLength: 1 }),
      (path, query, secret) => {
        const { signature } = signCoupangRequest('GET', path, query, secret, new Date())
        expect(signature).toMatch(/^[0-9a-f]{64}$/)
      },
    ))
  })
})
