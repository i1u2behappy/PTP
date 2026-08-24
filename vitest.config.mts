import { defineConfig } from 'vitest/config'

// 순수 로직(URL 파라미터 비교, 정렬 키워드 판정, 암복호화 등)만 다루는 빠른 단위테스트 전용 — 실제
// 브라우저/DB/외부 몰 사이트가 필요한 건 tests/e2e(Playwright Test)가 다룬다. 두 러너가 서로의 테스트
// 파일을 잘못 집어가지 않도록 대상 폴더를 명확히 분리한다.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
