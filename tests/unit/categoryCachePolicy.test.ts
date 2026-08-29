import { describe, it, expect } from 'vitest'
import { shouldKeepPreviousCategoryLinks } from '../../lib/scrape/categoryCachePolicy'

// "다시 확인"이 로그인 벽에 막힌 부실한 결과로 확장이 방금 저장해둔 좋은 카테고리 캐시를 지워버리던
// 버그(2026-08-29, 펫토리 실사용 확인)의 재발 방지 — 실제 원인은 이 판단 하나였다.
describe('shouldKeepPreviousCategoryLinks', () => {
  it('이번 크롤이 로그인 벽에 막혔고 이전 캐시가 있으면 이전 캐시를 지킨다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: true,
      prevAiUsed: false, prevCategoryLinksCount: 42,
    })).toBe(true)
  })

  it('로그인 벽에 막혔어도 이전 캐시가 없으면(최초 시도) 새 결과를 그대로 쓴다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: true,
      prevAiUsed: false, prevCategoryLinksCount: 0,
    })).toBe(false)
  })

  it('이번엔 AI 없이 규칙 기반으로만 찾았는데 이전 결과가 AI 채택분이면 이전 결과를 지킨다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false,
      prevAiUsed: true, prevCategoryLinksCount: 10,
    })).toBe(true)
  })

  it('이번에도 AI가 성공했으면 이전이 AI 채택분이어도 새 결과로 덮어쓴다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: true, freshLoginBlockedExpansion: false,
      prevAiUsed: true, prevCategoryLinksCount: 10,
    })).toBe(false)
  })

  it('막히지도 않았고 AI 우위도 없으면 새로 찾은 결과로 정상 갱신한다', () => {
    expect(shouldKeepPreviousCategoryLinks({
      freshAiUsed: false, freshLoginBlockedExpansion: false,
      prevAiUsed: false, prevCategoryLinksCount: 10,
    })).toBe(false)
  })
})
