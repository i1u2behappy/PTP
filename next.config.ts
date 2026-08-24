import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['playwright', 'pg', 'sharp', 'exceljs'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }, { protocol: 'http', hostname: '**' }],
  },
  // dev 서버 기본값(pagesBufferLength:2)은 딱 2개 라우트만 "컴파일된 채" 메모리에 남겨두고 나머지는
  // 곧바로 버린다 — 스크래핑 한 번에 /api/scrape/status, .../log, .../preview-progress,
  // .../site-lock-status, .../current-url, /api/sites/[id] 등 훨씬 많은 라우트를 번갈아 계속 폴링하니,
  // 진행 중에도 계속 이전 라우트가 버려지고 다시 요청이 오면 그 자리에서 재컴파일된다 — 그 재컴파일이
  // 미들웨어 매니페스트를 다시 쓰는 순간과 다른 요청이 그걸 읽는 순간이 겹치면 "Manifest file is
  // empty" 500 + Fast Refresh 강제 새로고침(로고 화면)으로 이어진다(실사용 확인, 2026-08-24 — 워커
  // 분리로 Playwright/AI의 CPU 부담은 없앴지만, 이 dev 서버 자체의 on-demand 컴파일 경합은 별개 원인이라
  // 그대로 남아있었다). 이 앱이 실제로 쓰는 라우트 수를 넉넉히 덮도록 버퍼를 크게 늘리고, 한 번 컴파일된
  // 라우트가 스크래핑 진행 내내(보통 몇 분~수십 분) 버려지지 않도록 유지시간도 길게 잡는다 — dev 전용,
  // 빌드/운영에는 영향 없음.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
  // 짧은 시간에 파일 여러 개가 잇달아 저장되면 재컴파일이 겹쳐 돌면서, 그 도중 들어온 요청이 아직 다
  // 쓰이지 않은 webpack 빌드 매니페스트를 읽어 "Unexpected end of JSON input" 500이나 스타일 안 먹은
  // 화면으로 보이는 경우가 있었다(2026-08-22). aggregateTimeout을 늘려 몰린 저장을 재컴파일 1번으로
  // 묶어 그 경합 구간 자체를 줄인다 — dev 전용, 빌드/운영에는 영향 없음. 1000ms에서도 파일을 아주 많이
  // 연달아 고치는 세션(예: 크롬 확장 디버깅처럼 수십 번 연속 Edit)에서는 여전히 재현돼 3000ms로 더
  // 늘렸다(2026-08-22) — 코드 수정 후 화면 반영이 그만큼 느려지는 트레이드오프를 감수한다.
  webpack: (config, { dev }) => {
    if (dev) config.watchOptions = { ...config.watchOptions, aggregateTimeout: 3000 }
    return config
  },
}

export default nextConfig
