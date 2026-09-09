import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * "모듈 스코프에서 프로세스당 한 번만 실행돼야 하는 부작용(setInterval 등)은 반드시
 * lib/onceGlobally.ts의 ensureStartedOnce를 거쳐야 한다"는 관례를 자동으로 강제한다 —
 * lib/onceGlobally.ts 자신의 주석 참고: Next.js dev 서버가 API 라우트를 온디맨드로 컴파일하며 공유
 * 서버 모듈을 여러 번 다시 평가할 수 있어, 이 가드 없이 그냥 `let started`로 짜면 setInterval이
 * 쌓여 DB 커넥션 풀을 소모하는 등 몇 달 뒤에야 실사용으로 발견되는 사고로 이어진다(2026-09-07,
 * lib/scheduler.ts 사고). 사람이 "새 setInterval을 짤 때마다 이 패턴을 기억하기"에 의존하는 대신,
 * 이 테스트가 검증 루프(tsc/lint/test)에서 매번 자동으로 잡아낸다.
 *
 * 검사 방식은 완벽한 정적 분석이 아니라 "파일 단위" 휴리스틱이다 — 어떤 파일이 setInterval을 등록하면
 * 그 파일 안 어딘가에 ensureStartedOnce도 같이 있어야 한다. worker/** 는 예외(별도 장기 실행
 * 프로세스라 온디맨드 재평가 자체가 없음). 정말 예외가 필요하면 그 파일에
 * `// onceGloballyGuard: exempt` 주석을 남기고 그 이유를 옆에 적는다.
 */
const SCAN_ROOTS = ['lib', 'app', 'instrumentation.ts']
const EXEMPT_MARKER = 'onceGloballyGuard: exempt'

function listTsFiles(root: string): string[] {
  const abs = path.join(process.cwd(), root)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return abs.endsWith('.ts') ? [abs] : []
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { recursive: true }) as string[]) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
    out.push(path.join(abs, entry))
  }
  return out
}

describe('모듈 스코프 setInterval은 ensureStartedOnce로 가드해야 한다', () => {
  const files = SCAN_ROOTS.flatMap(listTsFiles)
    .filter(f => !f.endsWith(`${path.sep}onceGlobally.ts`) && !f.includes(`${path.sep}worker${path.sep}`))

  it('스캔 대상 파일이 존재한다(테스트 자체가 조용히 통과만 하고 있지 않은지 확인)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = path.relative(process.cwd(), file)
    it(`${rel}`, () => {
      const src = fs.readFileSync(file, 'utf8')
      if (!/\bsetInterval\s*\(/.test(src)) return // 이 파일은 해당 없음
      if (src.includes(EXEMPT_MARKER)) return // 명시적으로 예외 처리됨
      expect(src, `${rel}에 setInterval이 있는데 ensureStartedOnce로 가드돼 있지 않습니다 — ` +
        `Next.js dev 서버가 이 모듈을 여러 번 재평가하면 setInterval이 중복 등록돼 DB 커넥션 풀을 ` +
        `소모하는 등의 사고로 이어집니다(lib/onceGlobally.ts 참고). 정말 예외가 필요하면 파일에 ` +
        `"${EXEMPT_MARKER}" 주석과 그 이유를 남기세요.`).toMatch(/\bensureStartedOnce\s*\(/)
    })
  }
})
