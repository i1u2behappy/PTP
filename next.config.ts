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
  // 위 두 설정(onDemandEntries/aggregateTimeout)은 "소스 코드가 많이/자주 바뀌는" 경합만 다룬다 —
  // 그런데 "몰 구조분석"/스크랩이 도는 동안엔 소스 코드가 전혀 안 바뀌어도 로고 화면(Fast Refresh 강제
  // 새로고침)이 계속 떴다(2026-08-30 실사용 확인). 원인은 watchOptions.ignored가 아예 없어서(webpack
  // 기본값은 node_modules/.git/.next만 제외) — Playwright가 띄우는 실제 크롬(.playwright-profiles/,
  // syncManualLoginProfileCopy의 프로필 사본)이 자동화 도중 캐시/IndexedDB 파일을 초당 수십~수백 개씩
  // 계속 쓰고, 상품 이미지 다운로드(lib/images.ts의 public/scraped/)도 같은 방식으로 파일을 쏟아낸다 —
  // 둘 다 이 프로젝트 폴더 "안"이라 watcher가 전부 "소스 변경"으로 착각해 재컴파일을 계속 유발한다.
  // .gitignore에 이미 있는 경로들이지만 .gitignore는 watcher와 무관하다(별개 메커니즘) — 여기서
  // 명시적으로 빼줘야 한다. dev 전용, 빌드/운영에는 영향 없음.
  //
  // 위 목록에 없던 재발원인 하나를 2026-08-31에 추가로 찾았다: .dev-server.log/.worker.log(모든 요청마다
  // 로그 한 줄씩 계속 추가됨, scripts/start-dev-server.cmd가 dev 서버 stdout 전체를 리다이렉트)와
  // tsconfig.tsbuildinfo(tsc 실행마다 갱신)도 프로젝트 루트 "안"의 파일이라 watcher가 계속 "소스 변경"으로
  // 착각한다 — 특히 로그 파일은 요청이 있을 때마다 계속 바뀌므로, "recompile → 응답 지연/reload → 재요청
  // → 로그 갱신 → 다시 recompile"로 스스로 되먹임될 소지가 있었다. 사용자가 "아무것도 안 하고 있는데도
  // 로고 화면(강제 새로고침)이 계속 뜬다"고 보고한 시점의 실제 로그(GET / 가 반복적으로 3.5~3.7초씩 걸림)를
  // 근거로 추가.
  //
  // 같은 날 바로 이어서 더 넓게 재점검 — "이 프로젝트 폴더 안에서 소스 아닌데 실행 중 계속 쓰기가
  // 일어나는 경로"를 빠짐없이 잡으려면 이 목록을 매번 따로 유지하는 대신 .gitignore를 참고하는 게
  // 맞다(그쪽이 이미 "런타임 데이터라 커밋 대상 아님"의 기준 목록 역할을 하고 있다 — 위 주석들도 실제로
  // 그렇게 하나씩 찾아왔다). .gitignore를 다시 훑어 아직 안 빠져있던 나머지를 마저 추가한다:
  // public/client-docs(거래처 사업자등록증 업로드, public/scraped와 같은 성격), test-results/
  // playwright-report/blob-report(Playwright E2E 테스트 산출물 — 실사용 확인: VS Code Playwright
  // 확장이 띄워두는 test-server 프로세스가 떠 있으면 test-results/.last-run.json이 수시로 갱신됨),
  // coverage(테스트 커버리지 산출물), .claude/settings.local.json(세션 중 권한 허용목록이 바뀌면 갱신).
  // *.tsbuildinfo도 기존엔 tsconfig.tsbuildinfo 파일명만 정확히 매칭했는데 .gitignore는 더 넓은 글롭이라
  // 맞춰 넓혔다. (반대로 .next/는 여기 없어도 된다 — webpack 자체 기본값이 이미 제외한다.)
  // 앞으로 이 프로젝트에 새로운 런타임 쓰기 경로가 생기면, 먼저 .gitignore에 추가하는 게 관례이니(커밋
  // 방지 목적) 그때 이 목록도 같이 훑어보면 이 종류의 재발을 막을 수 있다.
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        aggregateTimeout: 3000,
        ignored: [
          '**/node_modules/**', '**/.git/**', '**/.playwright-profiles/**', '**/public/scraped/**', '**/.playwright-mcp/**',
          '**/.dev-server.log', '**/.worker.log', '**/*.tsbuildinfo',
          '**/public/client-docs/**', '**/test-results/**', '**/playwright-report/**', '**/blob-report/**', '**/coverage/**',
          '**/.claude/settings.local.json',
        ],
      }
    }
    return config
  },
}

export default nextConfig
