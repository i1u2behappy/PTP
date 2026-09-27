import { describe, it, expect } from 'vitest'
import { shouldKeepPreviousCategoryLinks, mergeSortOptions, hasMoreCategoryHierarchy } from '../../lib/scrape/categoryCachePolicy'

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

  it('이전이 AI 채택분이고 개수는 안 늘었어도, 이번 규칙 기반 결과가 계층(대분류>중분류)까지 잡았으면 새 결과로 덮어쓴다', () => {
    // 걸스굽 실사용 확인(2026-09-27) — scanCategoryMenu가 "여성화 > BASIC HEEL LINE > 1 ~ 3cm"까지
    // 정확히 계층을 잡았는데, 몇 달 전 AI가 한 번 채택된 뒤로 categoryLinksAiUsed=true가 계속 이어받아져
    // "이번엔 AI를 안 썼다"는 이유만으로 매번 옛 평평한 66개 캐시로 되돌아갔다.
    const prev = Array.from({ length: 66 }, (_, i) => ({ name: `카테고리${i}` }))
    const next = [{ name: '여성화 > BASIC HEEL LINE > 1 ~ 3cm' }, { name: '여성화 > FLAT & LOAFER' }]
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false, freshCategoryLinksCount: next.length,
      prevAiUsed: true, prevCategoryLinksCount: prev.length,
      freshCategoryLinks: next, prevCategoryLinks: prev,
    })).toBe(false)
  })

  it('계층 정보를 안 넘기는 호출부는 기존과 동일하게(개수/AI 여부만으로) 판단한다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false, freshCategoryLinksCount: 5,
      prevAiUsed: true, prevCategoryLinksCount: 10,
    })).toBe(true)
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

// mallProfile.ts의 "개수가 줄면 이전 결과를 지킨다" 가드가 "개수는 줄었지만 실제로는 더 정교해졌다"를
// 구분 못 해 되돌려버리던 버그(2026-09-24, 걸스굽 실사용 확인)의 재발 방지 — 화면 인식이 "여성화 >
// 가격대별 > 0 - 9,900"까지 계층을 잡았는데, 예전에 계층 없이 저장해둔 개수가 더 많다는 이유만으로
// 그 평평한 결과로 되돌아갔다.
describe('hasMoreCategoryHierarchy', () => {
  it('계층 이름(">" 포함) 개수가 이번이 더 많으면 true', () => {
    const prev = [{ name: '여성화' }, { name: 'FLAT & LOAFER' }, { name: 'SNEAKERS' }]
    const next = [{ name: '여성화 > FLAT & LOAFER' }, { name: '여성화 > SNEAKERS' }]
    expect(hasMoreCategoryHierarchy(prev, next)).toBe(true)
  })

  it('둘 다 계층이 없으면(진짜 개수 축소일 수 있음) false', () => {
    const prev = [{ name: '여성화' }, { name: '남성화' }, { name: '아동화' }]
    const next = [{ name: '여성화' }, { name: '남성화' }]
    expect(hasMoreCategoryHierarchy(prev, next)).toBe(false)
  })

  it('이전에도 계층이 있었고 이번엔 그보다 적으면 false(진짜 축소로 본다)', () => {
    const prev = [{ name: '여성화 > FLAT & LOAFER' }, { name: '여성화 > SNEAKERS' }, { name: '남성화 > LOAFER' }]
    const next = [{ name: '여성화 > FLAT & LOAFER' }]
    expect(hasMoreCategoryHierarchy(prev, next)).toBe(false)
  })

  it('prev/next가 없어도(undefined) 에러 없이 처리한다', () => {
    expect(hasMoreCategoryHierarchy(undefined, [{ name: '여성화 > FLAT & LOAFER' }])).toBe(true)
    expect(hasMoreCategoryHierarchy([{ name: '여성화 > FLAT & LOAFER' }], undefined)).toBe(false)
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

  // 도매의신 실사용 확인(2026-09-18): diffQueryParams가 페이지 식별자 값(.html 등)을 걸러내는 규칙이
  // 생기기 전에 저장된 낡은 sortOptions("인기1TV100197" 등 상품 링크가 정렬로 잘못 저장된 값)가, 그
  // 뒤로 몇 번을 다시 실행해도 label이 안 겹친다는 이유만으로 이 merge에서 절대 안 빠져 "정렬구조가
  // 그대로다"라는 혼란을 냈다 — prev/next 양쪽에서 이 모양의 값을 항상 걸러내야 한다.
  it('페이지 식별자 값(.html 등)을 가진 낡은 오탐은 label이 안 겹쳐도 prev에서 걸러낸다', () => {
    const prev = [
      { label: '인기1TV100197', kind: 'query', paramsToAdd: { p: 'search4_itemdetail.html', q: 'TV100197' } },
      { label: '상품명', kind: 'query', paramsToAdd: { sort_method: '1' } },
    ]
    const next: typeof prev = []
    expect(mergeSortOptions(prev, next)).toEqual([{ label: '상품명', kind: 'query', paramsToAdd: { sort_method: '1' } }])
  })

  it('같은 모양의 오탐이 next에 새로 섞여 들어와도 걸러낸다', () => {
    const prev: { label: string; kind: string; paramsToAdd: Record<string, string> }[] = []
    const next: typeof prev = [
      { label: '최신상품순', kind: 'query', paramsToAdd: { sort: 'new' } },
      { label: '인기2TV100460', kind: 'query', paramsToAdd: { p: 'search4_itemdetail.html', q: 'TV100460' } },
    ]
    expect(mergeSortOptions(prev, next)).toEqual([{ label: '최신상품순', kind: 'query', paramsToAdd: { sort: 'new' } }])
  })
})
