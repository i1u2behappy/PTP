import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { diffQueryParams, resetToFirstPage, looksLikeSortLabel, deriveCategoryUrlPattern } from '../../lib/scraper'

// 사람이 떠올리는 예시 몇 개(scraper.test.ts)와 달리, 여기는 "이 함수가 어떤 입력에서도 지켜야 할 규칙"을
// 정의해두고 fast-check가 극단값(빈 문자열, 유니코드, 아주 긴 문자열 등)을 대량으로 생성해 대신 검증한다.
const safeToken = fc.string({ unit: 'grapheme-ascii', minLength: 1 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s))

describe('resetToFirstPage (속성 기반)', () => {
  it('임의 문자열에 대해 절대 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(() => resetToFirstPage(s)).not.toThrow()
    }))
  })

  it('한 번 적용한 결과에 다시 적용해도 똑같다(멱등성) — page를 두 번 지워도 한 번 지운 것과 같아야 한다', () => {
    fc.assert(fc.property(fc.webUrl(), (url) => {
      const once = resetToFirstPage(url)
      expect(resetToFirstPage(once)).toBe(once)
    }))
  })
})

describe('diffQueryParams (속성 기반)', () => {
  it('같은 URL을 자기 자신과 비교하면 항상 null이다(무엇을 넣어도 "차이 없음")', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(diffQueryParams(s, s)).toBeNull()
    }))
  })

  it('base에 page 아닌 쿼리파라미터 하나를 추가한 변형 URL과 diff하면, 그 파라미터를 그대로 복원한다', () => {
    fc.assert(fc.property(fc.webUrl(), safeToken.filter(k => k !== 'page'), safeToken, (base, key, value) => {
      const variant = new URL(base)
      variant.searchParams.set(key, value)
      expect(diffQueryParams(base, variant.toString())).toEqual({ [key]: value })
    }))
  })

  it('page 파라미터만 다르면 항상 null이다(정렬과 무관한 페이지 이동이라 걸러내야 함)', () => {
    fc.assert(fc.property(fc.webUrl(), fc.nat({ max: 9999 }), (base, pageNum) => {
      const variant = new URL(base)
      variant.searchParams.set('page', String(pageNum))
      expect(diffQueryParams(base, variant.toString())).toBeNull()
    }))
  })
})

describe('looksLikeSortLabel (속성 기반)', () => {
  it('임의 문자열에 대해 절대 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(() => looksLikeSortLabel(s)).not.toThrow()
    }))
  })
})

describe('deriveCategoryUrlPattern (속성 기반)', () => {
  it('임의 문자열 배열에 대해 절대 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.array(fc.string()), (urls) => {
      expect(() => deriveCategoryUrlPattern(urls)).not.toThrow()
    }))
  })

  it('URL이 2개 미만이면 항상 null이다', () => {
    fc.assert(fc.property(fc.array(fc.webUrl(), { maxLength: 1 }), (urls) => {
      expect(deriveCategoryUrlPattern(urls)).toBeNull()
    }))
  })

  it('모든 URL이 같은 쿼리파라미터 키를 공유하면, 역산된 패턴이 그 URL들을 전부 매칭한다', () => {
    fc.assert(fc.property(
      fc.webUrl(), safeToken, fc.array(safeToken, { minLength: 2, maxLength: 10 }),
      (base, key, values) => {
        const urls = values.map(v => {
          const u = new URL(base)
          u.searchParams.set(key, v)
          return u.toString()
        })
        const pattern = deriveCategoryUrlPattern(urls)
        expect(pattern).not.toBeNull()
        const re = new RegExp(pattern!)
        urls.forEach(u => expect(re.test(u)).toBe(true))
      },
    ))
  })
})
