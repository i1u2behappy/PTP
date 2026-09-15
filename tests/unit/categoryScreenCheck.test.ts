import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { buildCategoryScreenCheck, normalizeCategoryName, resolveMissingCategoryCandidates, findApproximateMatch } from '../../lib/scraper'
import { sanitizeVisibleCategoryNames, sanitizeVisibleCategoryHierarchy } from '../../lib/ai'

// "화면으로 카테고리를 파악했으면, 최종 결과가 그 화면과 맞는지·안 맞으면 왜인지 피드백해야 한다"는
// 요구사항(2026-09-13, 투비즈온에서 메뉴에 보이는 '뷰티'/'바디/헤어'가 결과 목록에 없던 신고)을 코드로
// 고정한 것이 buildCategoryScreenCheck다. 이 대조가 틀리면 사용자는 "빠졌다"는 사실조차 알 수 없다.
describe('normalizeCategoryName', () => {
  it('"대분류 > 중분류" 경로에서 마지막 이름만 비교 대상으로 삼는다', () => {
    expect(normalizeCategoryName('패션의류/잡화/뷰티 > 바디/헤어')).toBe(normalizeCategoryName('바디/헤어'))
  })

  it('공백·구분자 차이를 무시한다', () => {
    expect(normalizeCategoryName('가방 / 잡화')).toBe(normalizeCategoryName('가방/잡화'))
    expect(normalizeCategoryName('쥬얼리·시계')).toBe(normalizeCategoryName('쥬얼리시계'))
  })
})

describe('buildCategoryScreenCheck', () => {
  const finalLinks = [
    { name: '여성의류', href: 'https://m.com/list?ctno=007' },
    { name: '가방 / 잡화', href: 'https://m.com/list?ctno=016' },
  ]

  it('화면 인식 결과가 없으면 대조 자체를 건너뛴다(null) — 근거 없이 "누락"이라 단정하지 않는다', () => {
    expect(buildCategoryScreenCheck(null, finalLinks, [])).toBeNull()
    expect(buildCategoryScreenCheck([], finalLinks, [])).toBeNull()
  })

  it('화면엔 있는데 결과에 없는 항목을 제외 사유와 함께 알려준다', () => {
    const check = buildCategoryScreenCheck(
      ['여성의류', '가방/잡화', '뷰티', '바디/헤어'], finalLinks,
      [{ name: '뷰티', href: 'https://m.com/list?ctno=050', reason: '상품 0개 + 하위메뉴 0개' }],
    )
    expect(check?.missing.map(m => m.name)).toEqual(['뷰티', '바디/헤어'])
    expect(check?.missing[0].reason).toBe('상품 0개 + 하위메뉴 0개')
    // 제외 기록이 없는 항목은 "탐지 단계에서 못 찾음"으로 구분해준다 — 어느 단계를 봐야 하는지가 달라진다.
    expect(check?.missing[1].reason).toContain('탐지 단계')
  })

  it('화면과 결과가 일치하면 missing이 비어 있다(구분자/공백 차이는 무시)', () => {
    const check = buildCategoryScreenCheck(['여성의류', '가방 / 잡화'], finalLinks, [])
    expect(check?.missing).toEqual([])
  })

  it('부모 경로만 화면에 보이는 경우 누락으로 잡지 않는다', () => {
    const check = buildCategoryScreenCheck(['패션의류'], [{ name: '패션의류 > 여성의류', href: 'https://m.com/1' }], [])
    expect(check?.missing).toEqual([])
  })
})

describe('buildCategoryScreenCheck (속성 기반)', () => {
  it('결과에 이미 있는 이름은 절대 누락으로 보고되지 않는다', () => {
    fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 20 }), (names) => {
      const links = names.map((n, i) => ({ name: n, href: `https://m.com/${i}` }))
      const check = buildCategoryScreenCheck(names, links, [])
      // 정규화 후 빈 문자열이 되는 이름(기호뿐인 경우)은 비교 대상에서 빠지므로 그것만 예외로 둔다.
      const meaningful = names.filter(n => normalizeCategoryName(n))
      if (meaningful.length) expect(check?.missing ?? []).toEqual([])
    }))
  })
})

describe('sanitizeVisibleCategoryNames', () => {
  it('배열이 아니거나 문자열이 아닌 항목은 버린다 — 비전 응답은 형태가 보장되지 않는다', () => {
    expect(sanitizeVisibleCategoryNames(null)).toEqual([])
    expect(sanitizeVisibleCategoryNames(['여성의류', 3, null, { a: 1 }])).toEqual(['여성의류'])
  })

  it('중복·공백을 정리하고 지나치게 긴 문장은 버린다', () => {
    expect(sanitizeVisibleCategoryNames([' 여성의류 ', '여성의류', '가방  잡화', 'ㄱ'.repeat(41)]))
      .toEqual(['여성의류', '가방 잡화'])
  })

  it('임의 입력에서도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      expect(() => sanitizeVisibleCategoryNames(v)).not.toThrow()
    }))
  })
})

// 화면에서 대분류→하위 카테고리 구조까지 같이 받아 "화면에서 본 구조" 카드에 보여준다(2026-09-15,
// "사람과 같이 화면 전체를 캡쳐해서 보는 형태로 대/중/소분류 구조를 파악"). missing/extra 판정에는
// 관여하지 않고 참고용으로만 실어 보내므로, buildCategoryScreenCheck가 그대로 통과시키는지만 확인한다.
describe('buildCategoryScreenCheck — screenHierarchy 전달', () => {
  const finalLinks = [{ name: '여성의류', href: 'https://m.com/1' }]

  it('screenHierarchy를 넘기면 결과에 그대로 실린다', () => {
    const hierarchy = [{ group: '여성의류', items: ['원피스', '블라우스'] }]
    const check = buildCategoryScreenCheck(['여성의류'], finalLinks, [], hierarchy)
    expect(check?.screenHierarchy).toEqual(hierarchy)
  })

  it('screenHierarchy를 안 넘기면 결과에 필드 자체가 없다', () => {
    const check = buildCategoryScreenCheck(['여성의류'], finalLinks, [])
    expect(check?.screenHierarchy).toBeUndefined()
  })

  it('빈 배열을 넘겨도 결과에 안 실린다(빈 구조는 "구조를 봤다"는 근거가 아니다)', () => {
    const check = buildCategoryScreenCheck(['여성의류'], finalLinks, [], [])
    expect(check?.screenHierarchy).toBeUndefined()
  })
})

describe('sanitizeVisibleCategoryHierarchy', () => {
  it('배열이 아니거나 group이 문자열이 아닌 항목은 버린다', () => {
    expect(sanitizeVisibleCategoryHierarchy(null)).toEqual([])
    expect(sanitizeVisibleCategoryHierarchy([{ group: '여성의류', items: ['원피스'] }, { group: 3, items: [] }, 'x']))
      .toEqual([{ group: '여성의류', items: ['원피스'] }])
  })

  it('중복 그룹명/공백을 정리하고, 하위 items도 sanitizeVisibleCategoryNames 규칙을 그대로 적용한다', () => {
    const out = sanitizeVisibleCategoryHierarchy([
      { group: ' 여성의류 ', items: [' 원피스 ', '원피스'] },
      { group: '여성의류', items: ['다른그룹같은이름'] },
    ])
    expect(out).toEqual([{ group: '여성의류', items: ['원피스'] }])
  })

  it('하위 items가 없거나 형식이 안 맞아도 그룹 이름만으로 항목을 만든다', () => {
    expect(sanitizeVisibleCategoryHierarchy([{ group: '여성의류' }])).toEqual([{ group: '여성의류', items: [] }])
  })

  it('임의 입력에서도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      expect(() => sanitizeVisibleCategoryHierarchy(v)).not.toThrow()
    }))
  })
})

// 누락 카테고리 재검증(recoverMissingCategories)은 "그 이름의 URL"을 먼저 알아내야 시작할 수 있다.
// 화면에서 이름만 읽은 카테고리(탐지 단계에서 아예 못 찾은 것)는 메뉴 화면에서 같이 모아둔 링크로만
// URL을 얻을 수 있어서, 이 매칭이 틀리면 "다른 방법으로 다시 검증" 자체가 시작되지 않는다.
describe('resolveMissingCategoryCandidates', () => {
  const menuLinks = [
    { text: '뷰티', href: 'https://m.com/list?ctno=050' },
    { text: '바디 / 헤어', href: 'https://m.com/list?ctno=051' },
    { text: '로그인', href: 'https://m.com/member/login.php' },
  ]

  it('제외 기록에 있으면 그때의 href를 그대로 쓴다(1순위)', () => {
    const out = resolveMissingCategoryCandidates(
      [{ name: '뷰티', reason: '빈 허브' }],
      [{ name: '뷰티', href: 'https://m.com/list?ctno=999', reason: '빈 허브' }],
      menuLinks,
    )
    expect(out).toEqual([{ name: '뷰티', href: 'https://m.com/list?ctno=999', reason: '빈 허브' }])
  })

  it('제외 기록이 없으면 메뉴 화면 링크에서 이름으로 찾는다(2순위, 공백/구분자 차이 무시)', () => {
    const out = resolveMissingCategoryCandidates([{ name: '바디/헤어', reason: '탐지 단계에서 못 찾음' }], [], menuLinks)
    expect(out).toEqual([{ name: '바디/헤어', href: 'https://m.com/list?ctno=051', reason: '탐지 단계에서 못 찾음' }])
  })

  it('URL을 어디서도 못 찾으면 후보에서 뺀다 — 방문할 곳을 모르면 재검증할 방법이 없다', () => {
    expect(resolveMissingCategoryCandidates([{ name: '없는카테고리', reason: 'x' }], [], menuLinks)).toEqual([])
  })

  it('같은 이름이 여러 번 들어와도 한 번만 후보가 된다', () => {
    const out = resolveMissingCategoryCandidates(
      [{ name: '뷰티', reason: 'a' }, { name: '뷰 티', reason: 'b' }], [], menuLinks)
    expect(out).toHaveLength(1)
  })
})

// 비전(OCR)은 글자를 종종 잘못 읽는다 — 실사용에서 확인된 오독: "천구/커튼"=침구/커튼,
// "유아동류"=유아동의류, "주얼리/시계"=쥬얼리/시계, "취미/니스/수영"=휘트니스/수영(2026-09-13, 투비즈온).
// 이걸 그대로 "누락"이라 보고하면 이미 있는 카테고리를 없다고 알리는 오보가 되고 재검증까지 헛돈다.
describe('findApproximateMatch (비전 오독 흡수)', () => {
  const finalKeys = ['침구커튼', '유아동의류', '쥬얼리시계', '휘트니스수영', '신발'].map(normalizeCategoryName)

  it('실제 오독 사례를 같은 카테고리로 인정한다', () => {
    expect(findApproximateMatch(normalizeCategoryName('천구/커튼'), finalKeys)).toBe('침구커튼')
    expect(findApproximateMatch(normalizeCategoryName('유아동류'), finalKeys)).toBe('유아동의류')
    expect(findApproximateMatch(normalizeCategoryName('주얼리/시계'), finalKeys)).toBe('쥬얼리시계')
    expect(findApproximateMatch(normalizeCategoryName('취미/니스/수영'), finalKeys)).toBe('휘트니스수영')
  })

  it('짧은 이름은 한 글자만 달라도 다른 카테고리로 본다 — 과하게 흡수하면 진짜 누락을 놓친다', () => {
    expect(findApproximateMatch(normalizeCategoryName('실발'), ['신발'])).toBeNull()
    expect(findApproximateMatch(normalizeCategoryName('가방'), ['가구'])).toBeNull()
  })

  it('전혀 다른 이름은 매칭하지 않는다', () => {
    expect(findApproximateMatch(normalizeCategoryName('자동차용품'), finalKeys)).toBeNull()
  })

  it('임의 입력에서도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.string(), fc.array(fc.string(), { maxLength: 10 }), (k, keys) => {
      expect(() => findApproximateMatch(k, keys)).not.toThrow()
    }))
  })
})

describe('buildCategoryScreenCheck — 오독 흡수 반영', () => {
  it('한두 글자 오독은 누락으로 보고하지 않는다', () => {
    const check = buildCategoryScreenCheck(['침구/커튼', '유아동의류'],
      [{ name: '천구/커튼', href: 'https://m.com/1' }, { name: '유아동류', href: 'https://m.com/2' }], [])
    expect(check?.missing).toEqual([])
  })
})

// 같은 몰의 같은 페이지가 실행마다 "상품 0개"로 보이기도 해서, 결과가 51 → 49 → 46으로 계속 깎여나갔다
// (투비즈온 실사용, 2026-09-13). 화면 인식(비전)은 실패할 수 있으므로 "직전 결과"라는 두 번째 기준선이
// 필요하다 — 여기서는 그 기준선을 만드는 규칙(사라진 항목 골라내기)을 고정한다.
describe('직전 결과 기준선 — 사라진 카테고리 골라내기', () => {
  const prev = [
    { name: '여성의류', href: 'https://www.m.com/list?ctno=007' },
    { name: 'PC주변기기', href: 'https://www.m.com/list?ctno=002' },
    { name: '주방용품', href: 'https://m.com/list?ctno=064' },
  ]
  const dropped = (current: { name: string; href: string }[]) => {
    const cur = new Set(current.map(c => c.href.replace(/^(https?:\/\/)www\./, '$1')))
    return prev.filter(p => !cur.has(p.href.replace(/^(https?:\/\/)www\./, '$1')))
  }

  it('이번 결과에 없는 직전 카테고리를 골라낸다', () => {
    expect(dropped([prev[0]]).map(p => p.name)).toEqual(['PC주변기기', '주방용품'])
  })

  it('www 유무만 다른 같은 URL은 사라진 것으로 보지 않는다 — 같은 페이지다', () => {
    expect(dropped([{ name: '주방용품', href: 'https://www.m.com/list?ctno=064' }]).map(p => p.name))
      .toEqual(['여성의류', 'PC주변기기'])
  })
})
