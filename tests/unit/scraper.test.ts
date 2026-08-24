import { describe, it, expect } from 'vitest'
import { diffQueryParams, looksLikeSortLabel, resetToFirstPage } from '../../lib/scraper'

// diffQueryParams는 "카테고리별 정렬기준 설정" 기능의 핵심 — 정렬 후보 링크가 baseUrl과 같은 경로에서
// 쿼리파라미터만 다른지 확인해, 다른 카테고리/상품 상세로 튀는 링크를 걸러낸다.
describe('diffQueryParams', () => {
  it('같은 pathname에서 쿼리파라미터 차이만 뽑아낸다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/list.php?cate_no=1&sort=price',
    )
    expect(diff).toEqual({ sort: 'price' })
  })

  it('pathname이 다르면(카테고리/상품 상세로 이동) null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/goods_view.php?goodsno=123',
    )
    expect(diff).toBeNull()
  })

  it('origin이 다르면 null을 반환한다', () => {
    const diff = diffQueryParams('https://mall.com/list.php', 'https://other.com/list.php?sort=price')
    expect(diff).toBeNull()
  })

  it('page 파라미터 차이만 있으면 정렬과 무관해 null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/list.php?cate_no=1&page=2',
    )
    expect(diff).toBeNull()
  })

  it('쿼리파라미터가 완전히 같으면(변화 없음) null을 반환한다', () => {
    const diff = diffQueryParams('https://mall.com/list.php?cate_no=1', 'https://mall.com/list.php?cate_no=1')
    expect(diff).toBeNull()
  })

  it('잘못된 URL이면 예외 대신 null을 반환한다', () => {
    expect(diffQueryParams('not a url', 'https://mall.com/list.php')).toBeNull()
  })
})

// looksLikeSortLabel — 2026-08-23 펫투비 실사용 중 발견한 사고(카테고리 사이드바 링크 "간식"/"배변용품"을
// 로컬 Ollama가 정렬 옵션으로 잘못 골라 그대로 저장)를 재현하지 않는지 고정해두는 회귀 테스트.
describe('looksLikeSortLabel', () => {
  it.each(['낮은가격', '높은가격순', '신상품', '인기순', '판매량순', '리뷰많은순', '할인순'])(
    '"%s"는 정렬 라벨로 인정한다', (text) => {
      expect(looksLikeSortLabel(text)).toBe(true)
    },
  )

  it.each(['간식', '배변용품', '미용용품', '목욕용품', '위생/의약부외품', '브랜드사료'])(
    '"%s"는 정렬 라벨이 아니다(카테고리명 오탐 방지)', (text) => {
      expect(looksLikeSortLabel(text)).toBe(false)
    },
  )
})

describe('resetToFirstPage', () => {
  it('page 쿼리파라미터를 제거한다', () => {
    expect(resetToFirstPage('https://mall.com/list.php?cate_no=1&page=3')).toBe('https://mall.com/list.php?cate_no=1')
  })

  it('page 파라미터가 없으면 원본 그대로 반환한다', () => {
    expect(resetToFirstPage('https://mall.com/list.php?cate_no=1')).toBe('https://mall.com/list.php?cate_no=1')
  })

  it('잘못된 URL이면 원본 문자열을 그대로 반환한다', () => {
    expect(resetToFirstPage('not a url')).toBe('not a url')
  })
})
