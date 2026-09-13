import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fitOllamaPrompt } from '../../lib/ai'

// Ollama는 num_ctx(기본 4096, 이 프로젝트는 8192로 지정)를 넘는 입력을 에러 없이 **앞에서부터 잘라** 넣는다.
// 그러면 프롬프트 앞머리의 지시문과 도구 설명이 통째로 사라져 모델이 도구 호출 대신 일반 텍스트로 답하고,
// 호출부는 그걸 "AI 호출 실패"로만 보게 된다(2026-09-13 투비즈온 실사용 — 1만8천 자 프롬프트를 보냈더니
// 실제 처리된 입력이 2,050토큰뿐이었고 도구 호출이 아예 없었다). fitOllamaPrompt는 "자를 거면 우리가
// 뒤쪽(수집 원문)을 자른다"는 규칙을 코드로 고정한 것이라, 그 규칙 자체를 여기서 지킨다.
const LIMIT = Number(process.env.OLLAMA_PROMPT_CHAR_LIMIT) || 6_000

describe('fitOllamaPrompt', () => {
  it('한도 안쪽 프롬프트는 한 글자도 건드리지 않는다', () => {
    const prompt = '지시문\n\n[수집한 원문]\n' + '가'.repeat(100)
    expect(fitOllamaPrompt(prompt)).toBe(prompt)
  })

  it('한도를 넘으면 앞머리(지시문)를 남기고 뒤쪽을 버린다', () => {
    const head = '반드시 set_mall_report 도구로 답하라.\n'
    const long = head + '나'.repeat(LIMIT * 2)
    const fitted = fitOllamaPrompt(long)
    expect(fitted.startsWith(head)).toBe(true)
    expect(fitted.length).toBeLessThan(long.length)
  })
})

describe('fitOllamaPrompt (속성 기반)', () => {
  it('어떤 입력이든 결과는 한도 + 생략 표시 길이를 넘지 않는다', () => {
    fc.assert(fc.property(fc.string({ maxLength: 20_000 }), (s) => {
      // 잘린 경우에도 "…(원문 이하 생략 — 컨텍스트 한도)" 한 줄만 덧붙는다 — 그 여유(64자)까지 포함해
      // 상한을 넘지 않아야 num_ctx 안에 들어간다는 이 함수의 존재 이유가 성립한다.
      expect(fitOllamaPrompt(s).length).toBeLessThanOrEqual(LIMIT + 64)
    }))
  })

  it('결과는 항상 원본의 앞부분으로 시작한다(도구 설명이 살아남는다)', () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 20_000 }), (s) => {
      const fitted = fitOllamaPrompt(s)
      const keptLength = Math.min(s.length, LIMIT)
      expect(fitted.startsWith(s.slice(0, keptLength))).toBe(true)
    }))
  })
})
