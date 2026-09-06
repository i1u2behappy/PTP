import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { mergeReports } from '../../lib/scrape/mallProfile'
import type { MallStructureReport } from '../../lib/ai'

// mergeReports는 이번 세션에서 실제로 두 번 사고를 낸 함수다 — sortStructure 필드가 몇 주째 계속
// "확인 안됨"으로 남던 문제(2026-09-01)의 원인이었고, 고친 뒤에도 preferPrev 조건을 넓히면서
// (generatedBy === 'heuristic' → generatedBy !== 'ai') 다시 손을 댔다. 재발을 막기 위해 이 동작을
// 테스트로 고정해둔다.
function makeReport(overrides: Partial<MallStructureReport> = {}): MallStructureReport {
  return {
    urlHierarchy: '확인 안됨', categoryStructure: '확인 안됨', sortStructure: '확인 안됨',
    bankName: '확인 안됨', accountNumber: '확인 안됨', shippingCourier: '확인 안됨',
    shippingFeeInfo: '확인 안됨', returnAddress: '확인 안됨', stockManagementType: '확인 안됨',
    companyContact: '확인 안됨', productPageStructure: '확인 안됨', scrapingNeeds: '확인 안됨',
    generatedBy: 'heuristic',
    ...overrides,
  }
}

describe('mergeReports', () => {
  it('secondary가 없으면 primary를 그대로 돌려준다', () => {
    const primary = makeReport({ bankName: '기업은행' })
    expect(mergeReports(primary, null)).toBe(primary)
    expect(mergeReports(primary, undefined)).toBe(primary)
  })

  it('primary에 이미 실제 값이 있으면 secondary로 덮어쓰지 않는다', () => {
    const primary = makeReport({ bankName: '기업은행' })
    const secondary = makeReport({ bankName: '국민은행' })
    expect(mergeReports(primary, secondary).bankName).toBe('기업은행')
  })

  it('primary가 "확인 안됨"이고 secondary가 실제 값이면 secondary로 채운다', () => {
    const primary = makeReport({ sortStructure: '확인 안됨' })
    const secondary = makeReport({ sortStructure: '최신순, 낮은가격순' })
    expect(mergeReports(primary, secondary).sortStructure).toBe('최신순, 낮은가격순')
  })

  // 실제 재발 사고: 예전 'ai' 리포트가 sortStructure 필드 자체를 아예 가진 적이 없던(스키마에 없던
  // 시절 저장된) 경우 — Object.keys(primary)만 훑으면 이 키를 놓친다.
  it('primary가 필드 자체를 아예 갖고 있지 않아도(레거시 리포트) secondary로 채운다', () => {
    const primary = makeReport()
    delete (primary as Partial<MallStructureReport>).sortStructure
    const secondary = makeReport({ sortStructure: '최신순, 낮은가격순' })
    expect(mergeReports(primary, secondary).sortStructure).toBe('최신순, 낮은가격순')
  })

  it('secondary도 "확인 안됨"이면 primary의 "확인 안됨"을 그대로 둔다(가짜 값으로 채우지 않음)', () => {
    const primary = makeReport({ sortStructure: '확인 안됨' })
    const secondary = makeReport({ sortStructure: '확인 안됨' })
    expect(mergeReports(primary, secondary).sortStructure).toBe('확인 안됨')
  })

  it('generatedBy는 secondary가 무엇이든 항상 primary 값을 유지한다', () => {
    const primary = makeReport({ generatedBy: 'ai' })
    const secondary = makeReport({ generatedBy: 'ollama' })
    expect(mergeReports(primary, secondary).generatedBy).toBe('ai')
  })

  // 실제 재발 사고: primary가 'ai' 리포트인데 scrapingNeeds가 "확인 안됨"이고, secondary가
  // heuristic 리포트(buildHeuristicMallReport가 채운 "AI 미사용(규칙 기반)..." 경고문)일 때 이
  // 필드까지 채워지면 generatedBy는 'ai'인데 화면엔 "AI 미사용" 경고가 뜨는 자기모순이 생겼다
  // (사용자 실사용 확인, 2026-09-03, 시즌백).
  it('scrapingNeeds는 generatedBy와 마찬가지로 secondary로 채우지 않는다(리포트 출처에 묶인 메타 필드)', () => {
    const primary = makeReport({ generatedBy: 'ai', scrapingNeeds: '확인 안됨' })
    const secondary = makeReport({ generatedBy: 'heuristic', scrapingNeeds: 'AI 미사용(규칙 기반) 리포트 — 정확도가 AI 분석보다 낮을 수 있으니 실제 페이지와 대조 확인 권장' })
    const merged = mergeReports(primary, secondary)
    expect(merged.scrapingNeeds).toBe('확인 안됨')
    expect(merged.generatedBy).toBe('ai')
  })

  it('primary 원본 객체를 변형하지 않는다(항상 새 객체를 반환)', () => {
    const primary = makeReport({ sortStructure: '확인 안됨' })
    const secondary = makeReport({ sortStructure: '최신순' })
    const merged = mergeReports(primary, secondary)
    expect(merged).not.toBe(primary)
    expect(primary.sortStructure).toBe('확인 안됨')
  })
})

describe('mergeReports (속성 기반)', () => {
  const realValue = fc.string({ minLength: 1 }).filter(s => s !== '확인 안됨')

  it('primary가 실제 값을 가진 필드는 secondary가 무엇이든 절대 안 바뀐다', () => {
    fc.assert(fc.property(realValue, fc.string(), (primaryVal, secondaryVal) => {
      const primary = makeReport({ bankName: primaryVal })
      const secondary = makeReport({ bankName: secondaryVal })
      expect(mergeReports(primary, secondary).bankName).toBe(primaryVal)
    }))
  })

  it('primary가 비었고("확인 안됨") secondary가 실제 값이면 항상 secondary로 채워진다', () => {
    fc.assert(fc.property(realValue, (secondaryVal) => {
      const primary = makeReport({ accountNumber: '확인 안됨' })
      const secondary = makeReport({ accountNumber: secondaryVal })
      expect(mergeReports(primary, secondary).accountNumber).toBe(secondaryVal)
    }))
  })
})
