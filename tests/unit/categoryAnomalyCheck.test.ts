import { describe, it, expect } from 'vitest'
import { shouldRunCategoryAnomalyCheck } from '../../lib/scrape/categoryAnomalyCheck'

// checkCategoryAnomaly가 실제로 AI를 부를 가치가 있는지 판단하는 게이트 — 비교할 과거 증거가 부족한
// 신규 몰에서 매번 헛되이 경고가 뜨는 걸 막는다(2026-08-29).
describe('shouldRunCategoryAnomalyCheck', () => {
  it('마이그레이션 확정 카테고리만으로 5개 이상이면 실행한다', () => {
    expect(shouldRunCategoryAnomalyCheck(5, 0, 10)).toBe(true)
  })

  it('사용자가 직접 확인한 URL만으로 5개 이상이어도 실행한다', () => {
    expect(shouldRunCategoryAnomalyCheck(0, 5, 10)).toBe(true)
  })

  it('두 증거를 합쳐 5개 이상이면 실행한다', () => {
    expect(shouldRunCategoryAnomalyCheck(3, 2, 10)).toBe(true)
  })

  it('증거가 4개뿐이면(문턱 미달) 건너뛴다', () => {
    expect(shouldRunCategoryAnomalyCheck(2, 2, 10)).toBe(false)
  })

  it('증거는 충분해도 새로 찾은 카테고리가 없으면 건너뛴다', () => {
    expect(shouldRunCategoryAnomalyCheck(10, 10, 0)).toBe(false)
  })

  it('증거가 하나도 없는 신규 몰은 건너뛴다', () => {
    expect(shouldRunCategoryAnomalyCheck(0, 0, 20)).toBe(false)
  })
})
