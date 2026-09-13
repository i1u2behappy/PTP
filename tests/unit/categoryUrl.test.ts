import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { looksLikeMallHomeUrl, isSamePageUrl } from '../../lib/categoryUrl'

// 몰 홈이 카테고리 목록 첫 줄에 들어가면 미리보기/스크랩이 그걸 기준으로 표본을 뽑아 "몰 홈페이지
// 자체가 상품 1건"으로 나온다(2026-09-13, 투비즈온 실사용: 상품명=몰 타이틀, 공급가 ₩2,640).
describe('looksLikeMallHomeUrl', () => {
  it('루트/index.* 는 홈으로 본다', () => {
    expect(looksLikeMallHomeUrl('https://www.tobizon.co.kr/index.php')).toBe(true)
    expect(looksLikeMallHomeUrl('https://m.com/')).toBe(true)
    expect(looksLikeMallHomeUrl('https://m.com')).toBe(true)
    expect(looksLikeMallHomeUrl('https://m.com/index.html')).toBe(true)
  })

  it('쿼리가 붙어 있으면 카테고리일 수 있으므로 홈으로 보지 않는다', () => {
    expect(looksLikeMallHomeUrl('https://m.com/index.php?cate=12')).toBe(false)
    expect(looksLikeMallHomeUrl('https://www.tobizon.co.kr/index.php#page=1')).toBe(false)
  })

  it('실제 카테고리 URL은 당연히 홈이 아니다', () => {
    expect(looksLikeMallHomeUrl('https://www.tobizon.co.kr/mall/goods/goods_list.php?ctno=001')).toBe(false)
  })

  it('URL이 아니어도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.string(), s => { expect(() => looksLikeMallHomeUrl(s)).not.toThrow() }))
  })
})

describe('isSamePageUrl (미리보기 표본이 목록 자신이 되는 것 방지)', () => {
  it('www 유무·끝 슬래시·해시 차이는 같은 페이지로 본다', () => {
    expect(isSamePageUrl('https://www.m.com/list.php?ctno=1', 'https://m.com/list.php?ctno=1')).toBe(true)
    expect(isSamePageUrl('https://m.com/list/', 'https://m.com/list')).toBe(true)
    expect(isSamePageUrl('https://m.com/list?a=1#x', 'https://m.com/list?a=1')).toBe(true)
  })

  it('쿼리가 다르면 다른 페이지다 — 카테고리는 쿼리로 구분된다', () => {
    expect(isSamePageUrl('https://m.com/list.php?ctno=1', 'https://m.com/list.php?ctno=2')).toBe(false)
  })
})
