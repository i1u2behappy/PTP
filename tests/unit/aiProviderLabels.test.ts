import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 화면에 적힌 AI 모델명이 실제로 쓰이는 모델과 어긋나지 않게 하는 테스트.
 *
 * 배경(2026-09-12): Groq 도입 당시 쓰려던 llama-3.3-70b-versatile이 같은 날 404 model_not_found로 확인돼
 * qwen으로 교체됐는데, 교체 사실이 lib/ai.ts 주석에만 남고 **화면 문구 3곳(ScraperPanel 체크박스 툴팁,
 * ScraperPanel 결과 배지, SiteDetailPanel 결과 배지)엔 옛 이름이 그대로 남아** 사용자에게 존재하지도 않는
 * 모델을 열흘 넘게 안내하고 있었다. 서버 전용 SDK를 클라이언트 번들에 안 실으려고 화면 쪽이 모델명을
 * 문자열로 따로 들고 있는 구조라 drift가 구조적으로 불가피하므로, 사람 주의력 대신 이 테스트로 막는다.
 *
 * 새 모델로 교체할 때 이 테스트가 깨지면: lib/ai.ts의 상수를 바꿨으니 화면 문구도 같이 바꾸라는 뜻이다.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

const AI_SOURCE = read('lib', 'ai.ts')
const SCRAPER_PANEL = read('components', 'panels', 'ScraperPanel.tsx')
const SITE_DETAIL_PANEL = read('components', 'panels', 'SiteDetailPanel.tsx')

/** lib/ai.ts에서 `const NAME = process.env.X || 'model'` 또는 `const NAME = 'model'` 형태의 값을 뽑는다. */
function constValue(name: string): string {
  const m = AI_SOURCE.match(new RegExp(`const ${name} = (?:process\\.env\\.\\w+ \\|\\| )?'([^']+)'`))
  if (!m) throw new Error(`lib/ai.ts에서 ${name} 상수를 찾지 못했습니다 — 이름이 바뀌었다면 이 테스트도 같이 고쳐야 합니다.`)
  return m[1]
}

describe('화면에 표기된 AI 모델명', () => {
  const models = {
    GROQ_MODEL: constValue('GROQ_MODEL'),
    GROQ_VISION_MODEL: constValue('GROQ_VISION_MODEL'),
    OLLAMA_MODEL: constValue('OLLAMA_MODEL'),
    OLLAMA_VISION_MODEL: constValue('OLLAMA_VISION_MODEL'),
    GEMINI_MODEL: constValue('GEMINI_MODEL'),
  }

  it.each(Object.entries(models))('%s(%s)가 공급자 체크박스 설명에 그대로 적혀 있다', (_name, value) => {
    expect(SCRAPER_PANEL).toContain(value)
  })

  it('Anthropic 모델명이 체크박스 설명과 실제 호출 모델에서 일치한다', () => {
    const called = AI_SOURCE.match(/model: '(claude-[^']+)'/)?.[1]
    expect(called).toBeTruthy()
    expect(SCRAPER_PANEL).toContain(called!)
  })

  it('결과 배지 툴팁이 이미 교체된 옛 모델명을 안내하지 않는다', () => {
    // 실제로 났던 사고를 그대로 못 박아 둔다 — 이 이름들은 이 계정에서 쓸 수 없는 것으로 확인된 모델이다.
    for (const stale of ['Llama 3.3 70B', 'llama-3.3-70b-versatile', 'qwen3:8b']) {
      expect(SCRAPER_PANEL).not.toContain(stale)
      expect(SITE_DETAIL_PANEL).not.toContain(stale)
    }
  })

  it('Groq 결과 배지가 실제 리포트 생성 모델(GROQ_MODEL)을 안내한다', () => {
    // GROQ_MODEL은 'qwen/qwen3.8-27b'처럼 공급자 접두어가 붙어 있어, 배지엔 접두어 없는 형태로 적는다.
    const bare = models.GROQ_MODEL.replace(/^[^/]+\//, '')
    expect(SCRAPER_PANEL).toContain(bare)
    expect(SITE_DETAIL_PANEL).toContain(bare)
  })
})
