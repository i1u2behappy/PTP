import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { shortenCategoryUrlForDisplay } from '../../lib/urlDisplay'

// 카테고리 URL 표에서 행을 구분해주는 정보(?ctno=001 등)는 URL 뒤쪽에 있는데 CSS truncate는 뒤를 자른다 —
// 그래서 모든 행이 똑같아 보였고 "현재 카테고리를 제대로 못 불러온다"는 오해로 이어졌다(2026-09-13).
describe('shortenCategoryUrlForDisplay', () => {
  it('도메인을 떼고 경로+쿼리를 보여준다 — 행을 구분하는 건 쿼리다', () => {
    expect(shortenCategoryUrlForDisplay('https://www.tobizon.co.kr/mall/goods/goods_list.php?ctno=001'))
      .toBe('/mall/goods/goods_list.php?ctno=001')
  })

  it('해시까지 유지한다(이 몰은 #page=1&category=001로 카테고리를 구분하기도 한다)', () => {
    expect(shortenCategoryUrlForDisplay('https://m.com/list.php?ctno=1#page=1&category=001'))
      .toContain('#page=1&category=001')
  })

  it('너무 길면 앞쪽을 줄이고 뒤(구분 정보)를 남긴다', () => {
    const long = `https://m.com/${'a'.repeat(80)}/list.php?ctno=777`
    const out = shortenCategoryUrlForDisplay(long, 30)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('?ctno=777')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(30)
  })

  it('URL 형태가 아니어도 예외 없이 처리한다', () => {
    fc.assert(fc.property(fc.string(), fc.integer({ min: 5, max: 200 }), (s, max) => {
      expect(() => shortenCategoryUrlForDisplay(s, max)).not.toThrow()
      expect(shortenCategoryUrlForDisplay(s, max).length).toBeLessThanOrEqual(Math.max(max, s.length))
    }))
  })
})
