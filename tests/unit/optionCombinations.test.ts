import { describe, it, expect } from 'vitest'
import { resolveOptionCombinations } from '../../lib/marketplace/optionCombinations'

describe('resolveOptionCombinations', () => {
  it('옵션이 없으면 빈 조합을 반환한다', () => {
    expect(resolveOptionCombinations([], [])).toEqual({ combinations: [], approximated: false })
  })

  it('옵션이 1개면 값 각각이 그대로 실제 조합이다(근사 아님)', () => {
    const r = resolveOptionCombinations([{ name: '색상', values: ['빨강', '파랑'] }], [])
    expect(r).toEqual({ combinations: [{ 색상: '빨강' }, { 색상: '파랑' }], approximated: false })
  })

  it('옵션 2개 + 실제 조합 데이터가 있으면 그대로 쓴다(근사 아님) — 빨강은 100/105, 파랑은 100만', () => {
    const r = resolveOptionCombinations(
      [{ name: '색상', values: ['빨강', '파랑'] }, { name: '사이즈', values: ['100', '105'] }],
      [['빨강', '100'], ['빨강', '105'], ['파랑', '100']],
    )
    expect(r.approximated).toBe(false)
    expect(r.combinations).toEqual([
      { 색상: '빨강', 사이즈: '100' },
      { 색상: '빨강', 사이즈: '105' },
      { 색상: '파랑', 사이즈: '100' },
    ])
  })

  it('옵션 2개인데 조합 데이터가 없으면 카티전 곱으로 근사한다(approximated=true) — 실제로 없는 "파랑-105"도 포함될 수 있다', () => {
    const r = resolveOptionCombinations(
      [{ name: '색상', values: ['빨강', '파랑'] }, { name: '사이즈', values: ['100', '105'] }],
      [],
    )
    expect(r.approximated).toBe(true)
    expect(r.combinations).toHaveLength(4)
    expect(r.combinations).toContainEqual({ 색상: '파랑', 사이즈: '105' })
  })

  it('옵션이 3개 이상이면 조합 데이터 유무와 무관하게 항상 근사한다(캐스케이드는 1단계까지만 지원)', () => {
    const r = resolveOptionCombinations(
      [{ name: 'A', values: ['1'] }, { name: 'B', values: ['2'] }, { name: 'C', values: ['3', '4'] }],
      [['1', '2']],
    )
    expect(r.approximated).toBe(true)
    expect(r.combinations).toHaveLength(2)
  })

  it('값이 빈 옵션은 무시한다', () => {
    const r = resolveOptionCombinations([{ name: '색상', values: [] }, { name: '사이즈', values: ['100'] }], [])
    expect(r).toEqual({ combinations: [{ 사이즈: '100' }], approximated: false })
  })
})
