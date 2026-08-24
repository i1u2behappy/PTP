import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '../../lib/db'

// sites.login_pw_encrypted(몰 로그인 비번)에 쓰는 AES-256-GCM 암복호화 — CREDENTIALS_ENCRYPTION_KEY가
// 있어야 동작하므로, 실제 운영 키와 무관한 테스트 전용 키를 여기서만 설정한다.
beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = '0'.repeat(64)
})

describe('encryptSecret/decryptSecret', () => {
  it('암호화한 값을 그대로 복호화할 수 있다', () => {
    const { encrypted, iv } = encryptSecret('my-password')
    expect(decryptSecret(encrypted, iv)).toBe('my-password')
  })

  it('같은 평문도 매번 다른 iv/암호문을 만든다', () => {
    const a = encryptSecret('same-password')
    const b = encryptSecret('same-password')
    expect(a.iv).not.toBe(b.iv)
    expect(a.encrypted).not.toBe(b.encrypted)
  })

  it('encrypted나 iv가 없으면 빈 문자열을 반환한다', () => {
    expect(decryptSecret(null, null)).toBe('')
    expect(decryptSecret('x', null)).toBe('')
    expect(decryptSecret(null, 'x')).toBe('')
  })

  it('잘못된 iv로 복호화를 시도하면 인증 태그 불일치로 예외가 난다', () => {
    const { encrypted } = encryptSecret('my-password')
    const wrongIv = Buffer.from('0'.repeat(24), 'hex').toString('base64')
    expect(() => decryptSecret(encrypted, wrongIv)).toThrow()
  })
})
