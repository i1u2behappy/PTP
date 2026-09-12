import { describe, it, expect } from 'vitest'
import { looksLikeStaleCompileError } from '../../lib/staleCompileError'

// 실사용 확인(2026-09-12, /api/scrape/site-lock-status): getSiteLockStatus는 lib/workerClient.ts에
// 정상적으로 export돼 있는데도 dev 서버 핫리로드로 컴파일된 청크가 깨져 이 문구로 500이 반복됐다.
// instrumentation.ts의 onRequestError가 이 신호로 자동 재시작을 트리거하므로, 오탐/누락 둘 다 실사용에
// 영향이 크다(오탐 — 진짜 버그를 재시작으로 덮어버림 / 누락 — 사용자가 계속 에러를 봄).
describe('looksLikeStaleCompileError', () => {
  it('실제로 겪은 webpack 모듈 참조 깨짐 메시지를 감지한다', () => {
    expect(looksLikeStaleCompileError(
      '(0 , _lib_workerClient__WEBPACK_IMPORTED_MODULE_1__.getSiteLockStatus) is not a function',
    )).toBe(true)
  })

  it('"is not defined" 형태의 변형도 감지한다', () => {
    expect(looksLikeStaleCompileError('_lib_scraper__WEBPACK_IMPORTED_MODULE_3__ is not defined')).toBe(true)
  })

  it('webpack 내부 변수명이 없는 일반 애플리케이션 에러는 오탐하지 않는다', () => {
    expect(looksLikeStaleCompileError('TypeError: Cannot read properties of undefined (reading \'foo\')')).toBe(false)
    expect(looksLikeStaleCompileError('siteId is not defined')).toBe(false)
    expect(looksLikeStaleCompileError('helper is not a function')).toBe(false)
  })

  it('null/undefined/빈 문자열은 안전하게 false', () => {
    expect(looksLikeStaleCompileError(null)).toBe(false)
    expect(looksLikeStaleCompileError(undefined)).toBe(false)
    expect(looksLikeStaleCompileError('')).toBe(false)
  })
})
