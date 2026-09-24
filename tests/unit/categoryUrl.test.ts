import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { looksLikeMallHomeUrl, isSamePageUrl, buildCategoryTree, countCategoryTreeEntries } from '../../lib/categoryUrl'

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

// "카테고리 구조" 카드가 "카테고리(51) → 합계 57개"처럼 대분류 이름+개수로만 뭉뚱그리던 걸 대체하는
// 함수라(2026-09-15), 실제로 대분류별 개별 항목까지 다 담는지가 핵심이다.
describe('buildCategoryTree (카테고리 구조 카드의 대/중/소분류 중첩 그룹핑)', () => {
  it('빈 배열/undefined는 빈 배열을 돌려준다', () => {
    expect(buildCategoryTree(undefined)).toEqual([])
    expect(buildCategoryTree([])).toEqual([])
  })

  it('" > " 경로를 단계 그대로 중첩시키고, 등장 순서를 유지한다', () => {
    const links = [
      { name: '카테고리 > 여성의류', href: '/a' },
      { name: '홈 > 신상품', href: '/b' },
      { name: '카테고리 > 신발', href: '/c' },
    ]
    expect(buildCategoryTree(links)).toEqual([
      { name: '카테고리', children: [
        { name: '여성의류', href: '/a', children: [] },
        { name: '신발', href: '/c', children: [] },
      ] },
      { name: '홈', children: [{ name: '신상품', href: '/b', children: [] }] },
    ])
  })

  it('구분자가 없는 이름은 그 자체로 깊이 1짜리 리프 노드가 된다', () => {
    const links = [{ name: '여성의류', href: '/a' }]
    expect(buildCategoryTree(links)).toEqual([{ name: '여성의류', href: '/a', children: [] }])
  })

  it('3단(대/중/소분류)까지 실제로 중첩시킨다', () => {
    const links = [{ name: 'WOMEN SHOES > 부츠/털신발 > 첼시부츠', href: '/a' }]
    expect(buildCategoryTree(links)).toEqual([
      { name: 'WOMEN SHOES', children: [
        { name: '부츠/털신발', children: [
          { name: '첼시부츠', href: '/a', children: [] },
        ] },
      ] },
    ])
  })

  it('같은 이름이 자기 자신의 링크이면서 동시에 하위 분류의 부모이기도 한 경우를 둘 다 보존한다', () => {
    const links = [
      { name: 'WOMEN SHOES', href: '/all' },
      { name: 'WOMEN SHOES > 부츠/털신발', href: '/boots' },
    ]
    const tree = buildCategoryTree(links)
    expect(tree).toEqual([{
      name: 'WOMEN SHOES', href: '/all',
      children: [{ name: '부츠/털신발', href: '/boots', children: [] }],
    }])
    expect(countCategoryTreeEntries(tree[0])).toBe(2)
  })

  it('트리 전체의 항목 수 합이 입력 개수와 항상 같다(속성 테스트, 공백 아닌 겹치지 않는 이름일 때)', () => {
    // buildCategoryTree는 각 경로 조각을 trim()해서 키로 쓰므로, 원본 문자열이 달라도(예: " $c" vs "$c")
    // trim 후 같으면 같은 노드로 합쳐진다 — uniqueArray의 유일성도 trim 후 값 기준으로 맞춰야 이 정당한
    // 병합을 "버그"로 오탐하지 않는다(fast-check가 실제로 이 반례를 찾아냈다, 2026-09-18).
    fc.assert(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1 }).filter(s => s.trim().length > 0), { maxLength: 30, selector: s => s.trim() })
        .map(names => names.map((n, i) => ({ name: n, href: `/${i}` }))),
      links => {
        const tree = buildCategoryTree(links)
        const total = tree.reduce((sum, g) => sum + countCategoryTreeEntries(g), 0)
        expect(total).toBe(links.length)
      },
    ))
  })
})
