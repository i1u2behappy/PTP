import pool from './db'
import { englishInitialsOf } from './koreanInitials'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 거래처 코드 자동생성: {거래처명 앞 2글자 영문 이니셜}-{사업자등록번호 숫자만}.
 * 사업자등록번호가 없으면 0부터 시작하는 8자리 순번을 대신 붙인다.
 * 앞 이니셜 2자리는 다른 거래처와 겹치지 않아야 하므로, 겹치면 사용 중이지 않은 이니셜 조합을 순서대로 찾아 대체한다.
 */
export async function generateClientCode(name: string, businessRegNo?: string | null): Promise<string> {
  const existing = await pool.query<{ code: string | null }>('SELECT code FROM supply_clients WHERE code IS NOT NULL')
  const usedPrefixes = new Set(existing.rows.map(r => (r.code || '').split('-')[0]).filter(Boolean))
  const usedCodes = new Set(existing.rows.map(r => r.code).filter(Boolean))

  let prefix = englishInitialsOf(name)
  if (usedPrefixes.has(prefix)) {
    const startIdx = ALPHABET.indexOf(prefix[0])
    outer: for (let i = 0; i < ALPHABET.length; i++) {
      for (let j = 0; j < ALPHABET.length; j++) {
        const candidate = ALPHABET[(Math.max(startIdx, 0) + i) % ALPHABET.length] + ALPHABET[j]
        if (!usedPrefixes.has(candidate)) { prefix = candidate; break outer }
      }
    }
  }

  const regDigits = (businessRegNo || '').replace(/\D/g, '')
  if (regDigits) return `${prefix}-${regDigits}`

  let n = 0
  let suffix = String(n).padStart(8, '0')
  while (usedCodes.has(`${prefix}-${suffix}`)) {
    n++
    suffix = String(n).padStart(8, '0')
  }
  return `${prefix}-${suffix}`
}
