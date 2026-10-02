import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { resolveOptionCombinations } from '../../lib/marketplace/optionCombinations'

const optionName = fc.string({ minLength: 1, maxLength: 5 }).filter(s => s.trim().length > 0)
const optionValue = fc.string({ minLength: 1, maxLength: 5 }).filter(s => s.trim().length > 0)
const option = fc.record({
  name: optionName,
  values: fc.uniqueArray(optionValue, { minLength: 1, maxLength: 4 }),
})
// 옵션명이 중복되면 조합 결과에서 키가 겹쳐 사라지므로(객체 키 특성), 옵션 개수를 세는 속성 테스트는
// 이름이 서로 다른 옵션 목록으로만 검증한다.
const uniqueOptions = (min: number, max: number) => fc.uniqueArray(option, { minLength: min, maxLength: max, selector: o => o.name })

describe('resolveOptionCombinations (속성 기반)', () => {
  it('임의 입력에 대해 절대 예외를 던지지 않는다', () => {
    fc.assert(fc.property(
      fc.array(option, { maxLength: 4 }),
      fc.array(fc.tuple(fc.string(), fc.string()), { maxLength: 10 }),
      (options, combos) => {
        expect(() => resolveOptionCombinations(options, combos.map(([a, b]) => [a, b]))).not.toThrow()
      },
    ))
  })

  it('결과로 나온 모든 조합은 값이 있는 옵션 개수만큼의 키를 가진다', () => {
    fc.assert(fc.property(
      uniqueOptions(1, 4),
      (options) => {
        const usableCount = options.filter(o => o.values.length > 0).length
        const { combinations } = resolveOptionCombinations(options, [])
        for (const c of combinations) expect(Object.keys(c)).toHaveLength(usableCount)
      },
    ))
  })

  it('옵션이 비어있지 않으면 결과도 항상 비어있지 않다(값이 있는 한)', () => {
    fc.assert(fc.property(
      uniqueOptions(1, 3),
      (options) => {
        const { combinations } = resolveOptionCombinations(options, [])
        expect(combinations.length).toBeGreaterThan(0)
      },
    ))
  })

  it('옵션이 1개뿐이면 조합 개수가 그 옵션의 값 개수와 정확히 같다(근사 아님)', () => {
    fc.assert(fc.property(option, (opt) => {
      const r = resolveOptionCombinations([opt], [])
      expect(r.approximated).toBe(false)
      expect(r.combinations).toHaveLength(opt.values.length)
    }))
  })

  it('옵션이 3개 이상이면 조합 개수는 항상 각 옵션 값 개수의 곱과 같다(카티전 곱 근사)', () => {
    fc.assert(fc.property(
      uniqueOptions(3, 4),
      (options) => {
        const r = resolveOptionCombinations(options, [])
        expect(r.approximated).toBe(true)
        const expected = options.reduce((acc, o) => acc * o.values.length, 1)
        expect(r.combinations).toHaveLength(expected)
      },
    ))
  })
})
