import { describe, it, expect } from 'vitest'
import { shouldKeepPreviousCategoryLinks, mergeSortOptions } from '../../lib/scrape/categoryCachePolicy'

// "다시 확인"이 로그인 벽에 막힌 부실한 결과로 확장이 방금 저장해둔 좋은 카테고리 캐시를 지워버리던
// 버그(2026-08-29, 펫토리 실사용 확인)의 재발 방지 — 실제 원인은 이 판단 하나였다.
describe('shouldKeepPreviousCategoryLinks', () => {
  it('이번 크롤이 로그인 벽에 막혔고 이전 캐시가 있으면 이전 캐시를 지킨다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: true, freshCategoryLinksCount: 5,
      prevAiUsed: false, prevCategoryLinksCount: 42,
    })).toBe(true)
  })

  it('로그인 벽에 막혔어도 이전 캐시가 없으면(최초 시도) 새 결과를 그대로 쓴다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: true, freshCategoryLinksCount: 5,
      prevAiUsed: false, prevCategoryLinksCount: 0,
    })).toBe(false)
  })

  it('이번엔 AI 없이 규칙 기반으로만 찾았는데 이전 결과가 AI 채택분이고 개수도 안 늘었으면 이전 결과를 지킨다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false, freshCategoryLinksCount: 5,
      prevAiUsed: true, prevCategoryLinksCount: 10,
    })).toBe(true)
  })

  it('이번에도 AI가 성공했으면 이전이 AI 채택분이어도 새 결과로 덮어쓴다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: true, freshLoginBlockedExpansion: false, freshCategoryLinksCount: 10,
      prevAiUsed: true, prevCategoryLinksCount: 10,
    })).toBe(false)
  })

  it('막히지도 않았고 AI 우위도 없으면 새로 찾은 결과로 정상 갱신한다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false, freshCategoryLinksCount: 12,
      prevAiUsed: false, prevCategoryLinksCount: 10,
    })).toBe(false)
  })

  it('이전이 AI 채택분이라도 이번에 규칙 기반으로 찾은 개수가 이전보다 뚜렷이 많으면 새 결과로 덮어쓴다', () => {
    // 펫토리 실사용 확인(2026-09-06) — 예전 AI 결과는 겨우 3개(로그인 벽에 막혀 우연히 찾은 상품
    // 링크였을 뿐 진짜 카테고리가 아니었음)였는데, 이후 판정 버그를 고쳐 규칙 기반이 실제 대분류 17개를
    // 제대로 찾았다 — "AI 채택분 보호" 규칙이 개수 비교 없이 무조건 이전을 지켜 이 개선이 계속
    // 무효화됐다.
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false, freshCategoryLinksCount: 17,
      prevAiUsed: true, prevCategoryLinksCount: 3,
    })).toBe(false)
  })
})

// "몰 구조분석" 한 번에 서버(sampleMallProfile)와 개발자모드 확장(runDetectSortOptions)이 병렬로 각자
// 독립적으로 정렬 옵션을 찾아 같은 자리에 REPLACE로 써서 서로 덮어쓰던 버그(2026-09-09, 모자사러
// 실사용 확인 — 서버는 [낮은가격,높은가격]을, 확장은 [상품명]을 찾았는데 나중에 쓴 쪽만 남았다)의
// 재발 방지.
describe('mergeSortOptions', () => {
  it('겹치지 않는 두 부분집합을 label 기준으로 합친다', () => {
    const prev = [{ label: '상품명', paramsToAdd: { sort_method: '1' } }]
    const next = [{ label: '낮은가격', paramsToAdd: { sort_method: '3' } }, { label: '높은가격', paramsToAdd: { sort_method: '4' } }]
    expect(mergeSortOptions(prev, next)).toEqual([
      { label: '낮은가격', paramsToAdd: { sort_method: '3' } },
      { label: '높은가격', paramsToAdd: { sort_method: '4' } },
      { label: '상품명', paramsToAdd: { sort_method: '1' } },
    ])
  })

  it('같은 label이 양쪽에 있으면 next 쪽 값을 남기고 중복은 안 만든다', () => {
    const prev = [{ label: '상품명', paramsToAdd: { sort_method: '1' } }, { label: '낮은가격', paramsToAdd: { sort_method: '3' } }]
    const next = [{ label: '상품명', paramsToAdd: { sort_method: '1' } }]
    expect(mergeSortOptions(prev, next)).toEqual([
      { label: '상품명', paramsToAdd: { sort_method: '1' } },
      { label: '낮은가격', paramsToAdd: { sort_method: '3' } },
    ])
  })

  it('prev가 없으면 next를 그대로 쓴다', () => {
    const next = [{ label: '상품명', paramsToAdd: { sort_method: '1' } }]
    expect(mergeSortOptions(undefined, next)).toEqual(next)
  })

  it('next가 비어있으면(이번 실행에서 못 찾음) prev를 그대로 유지한다 — 예전 단일 가드와 같은 동작', () => {
    const prev = [{ label: '상품명', paramsToAdd: { sort_method: '1' } }]
    expect(mergeSortOptions(prev, undefined)).toEqual(prev)
    expect(mergeSortOptions(prev, [])).toEqual(prev)
  })

  it('둘 다 없으면 빈 배열을 돌려준다', () => {
    expect(mergeSortOptions(undefined, undefined)).toEqual([])
  })
})
