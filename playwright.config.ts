import { defineConfig, devices } from '@playwright/test'

// PTP 앱 자체의 UI 스모크 테스트용 — lib/scraper.ts가 몰 스크래핑에 쓰는 Playwright(별도 용도, 실제
// 로그인된 브라우저를 흉내내야 해서 channel:'chrome'/persistent context 등을 쓴다)와는 완전히 별개다.
// 여기는 그냥 PTP 화면이 정상적으로 뜨는지만 확인하면 되므로 훨씬 단순하다.
// 번들 Chromium 대신 channel:'chrome'을 쓰는 이유: 이 PC는 스크래핑용으로 이미 실제 Chrome을 쓰고 있어
// (lib/scraper.ts 참고) 별도로 수백MB짜리 번들 브라우저를 새로 받지 않아도 된다.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PTP_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  // dev 서버가 이미 떠 있으면(평소 작업 중 흔한 상태) 그걸 그대로 쓰고, 없으면 이 커맨드로 띄운다.
  webServer: {
    command: 'npm run dev',
    url: process.env.PTP_BASE_URL || 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
