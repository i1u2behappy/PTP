import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWithAiProviders, isAiProviderEnabled, enabledAiProviders, ALL_AI_PROVIDERS, registerAiProviderDefaultSource, currentAiProviderDefault } from '../../lib/aiProviderGate'

const AI_SOURCE = readFileSync(join(process.cwd(), 'lib', 'ai.ts'), 'utf8')

/**
 * "사용자가 체크한 AI만 쓴다"가 코드 리뷰어의 주의력이 아니라 검증 루프로 지켜지게 하는 테스트.
 *
 * 배경: 이 규칙을 호출부가 인자를 넘겨서 지키던 시절, 인자를 빠뜨린 경로가 체크 해제된 공급자를 계속
 * 부르는 사고가 네 번 났다(lib/aiProviderGate.ts 주석에 목록). 네 번 다 사고가 난 뒤에야 그 파일 하나를
 * 고쳤기 때문에 다섯 번째가 예정돼 있었다. 그래서 "새 AI 호출부가 관문을 안 거치면 테스트가 깨진다"로
 * 바꾼다 — 사람이 기억하지 않아도 되게.
 */
describe('AI 공급자 관문', () => {
  it('컨텍스트가 없으면 전부 허용한다(관문을 안 깐 진입점의 기존 동작 유지)', () => {
    expect(isAiProviderEnabled('ollama')).toBe(true)
    expect(isAiProviderEnabled('groq')).toBe(true)
    expect(enabledAiProviders()).toEqual(ALL_AI_PROVIDERS)
  })

  it('컨텍스트 안에서는 체크된 공급자만 허용한다', () => {
    runWithAiProviders(['anthropic', 'gemini', 'groq'], () => {
      expect(isAiProviderEnabled('groq')).toBe(true)
      expect(isAiProviderEnabled('ollama')).toBe(false)
      expect(enabledAiProviders()).toEqual(['anthropic', 'gemini', 'groq'])
    })
  })

  it('전부 끄면 아무 공급자도 허용하지 않는다', () => {
    runWithAiProviders([], () => {
      for (const id of ALL_AI_PROVIDERS) expect(isAiProviderEnabled(id)).toBe(false)
      expect(enabledAiProviders()).toEqual([])
    })
  })

  it('컨텍스트가 await 경계를 넘어서도 유지된다(화면인식처럼 깊은 비동기 체인에서 새지 않는지)', async () => {
    await runWithAiProviders(['groq'], async () => {
      await new Promise(r => setTimeout(r, 0))
      expect(isAiProviderEnabled('ollama')).toBe(false)
      await new Promise(r => setTimeout(r, 0))
      expect(isAiProviderEnabled('groq')).toBe(true)
    })
  })

  it('컨텍스트를 빠져나오면 원래대로 전부 허용으로 돌아간다', () => {
    runWithAiProviders([], () => expect(isAiProviderEnabled('ollama')).toBe(false))
    expect(isAiProviderEnabled('ollama')).toBe(true)
  })

  it('저장된 선택(DB)이 등록돼 있으면 컨텍스트가 없어도 그 값을 따른다', () => {
    // 라우트마다 runWithAiProviders를 배선하지 않아도 되게 하는 핵심 동작 — 이게 없으면 배선을 빠뜨린
    // 경로가 다시 조용히 새게 된다.
    try {
      registerAiProviderDefaultSource(new Set(['groq']))
      expect(currentAiProviderDefault()?.has('groq')).toBe(true)
      expect(isAiProviderEnabled('groq')).toBe(true)
      expect(isAiProviderEnabled('ollama')).toBe(false)
      expect(enabledAiProviders()).toEqual(['groq'])
    } finally {
      registerAiProviderDefaultSource(null)
    }
  })

  it('명시된 컨텍스트가 저장된 선택보다 우선한다', () => {
    try {
      registerAiProviderDefaultSource(new Set(['groq']))
      runWithAiProviders(['ollama'], () => {
        expect(isAiProviderEnabled('ollama')).toBe(true)
        expect(isAiProviderEnabled('groq')).toBe(false)
      })
    } finally {
      registerAiProviderDefaultSource(null)
    }
  })

  it('저장된 선택을 못 읽었으면(null) 전부 허용으로 남는다', () => {
    registerAiProviderDefaultSource(null)
    expect(isAiProviderEnabled('ollama')).toBe(true)
    expect(enabledAiProviders()).toEqual(ALL_AI_PROVIDERS)
  })

  // 아래 두 개가 이 파일의 핵심 — 새 AI 호출부가 관문을 우회하면 여기서 깨진다.

  it('lib/ai.ts의 모든 Groq 호출이 관문을 거친다', () => {
    const callCount = (AI_SOURCE.match(/fetch\(`\$\{GROQ_BASE_URL\}/g) ?? []).length
    const gateCount = (AI_SOURCE.match(/isAiProviderEnabled\('groq'\)/g) ?? []).length
    expect(callCount).toBeGreaterThan(0)
    expect(gateCount).toBeGreaterThanOrEqual(callCount)
  })

  it('lib/ai.ts의 모든 Ollama 호출이 관문을 거친다', () => {
    const callCount = (AI_SOURCE.match(/fetch\(`\$\{OLLAMA_BASE_URL\}/g) ?? []).length
    const gateCount = (AI_SOURCE.match(/isAiProviderEnabled\('ollama'\)/g) ?? []).length
    expect(callCount).toBeGreaterThan(0)
    expect(gateCount).toBeGreaterThanOrEqual(callCount)
  })
})
