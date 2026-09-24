import { describe, it, expect } from 'vitest'
import { translateAiErrorReason } from '../../lib/ai'

// AI 공급자(Anthropic/Gemini/Groq/Ollama) 실패 이유가 전부 영어 원문 그대로 화면("AI 호출 상세" 패널,
// 진행 중 표시)에 뜨는 걸 보고 지적받아(2026-09-23) 만든 번역 함수 — 실제로 겪은 4개 공급자의 원문
// 에러 메시지 그대로를 예시로 고정해 회귀를 막는다.
describe('translateAiErrorReason', () => {
  it('Anthropic 크레딧 소진 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'))
      .toBe('크레딧 잔액 부족 — 결제/충전이 필요합니다')
  })

  it('Gemini 과부하(503) 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'))
      .toBe('일시적 과부하 — 나중에 다시 시도하면 될 수 있습니다')
  })

  it('Gemini 일일 무료 한도 초과(RESOURCE_EXHAUSTED) 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('You exceeded your current quota... status":"RESOURCE_EXHAUSTED'))
      .toBe('일일 무료 요청 한도 초과 — 하루 지나야 복구됩니다')
  })

  it('Groq 일일 토큰 한도(TPD) 초과 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('Rate limit reached for model `qwen/qwen3.8-27b` ... on tokens per day (TPD): Limit 200000, Used 195250, Requested 5005.'))
      .toBe('일일 토큰 한도 초과 — 무료 등급 하루치를 다 써서 하루 지나야 복구됩니다')
  })

  it('Groq 분당 토큰 한도(ITPM) 초과 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('Rate limit reached ... on input tokens per minute (ITPM): Limit 7000, Used 4472'))
      .toBe('분당 토큰 한도 초과 — 잠시 후 재시도하면 될 수 있습니다')
  })

  it('Ollama 타임아웃 메시지를 한국어로 옮긴다', () => {
    expect(translateAiErrorReason('TimeoutError: The operation was aborted due to timeout'))
      .toBe('처리 시간 초과 — 이 PC(로컬)가 제한 시간 안에 응답을 못 만들었습니다')
  })

  it('이미 한국어인 이유(onError가 직접 채운 값)는 그대로 통과시킨다', () => {
    expect(translateAiErrorReason('API 키 없음')).toBe('API 키 없음')
    expect(translateAiErrorReason('분석할 원문이 수집되지 않음')).toBe('분석할 원문이 수집되지 않음')
  })

  it('매핑에 없는 낯선 에러는 원문을 그대로 둔다(억지 번역으로 원인을 왜곡하지 않음)', () => {
    const unknown = 'ECONNREFUSED 127.0.0.1:11434'
    expect(translateAiErrorReason(unknown)).toBe(unknown)
  })
})
