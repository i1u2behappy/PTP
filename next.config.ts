import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['playwright', 'pg', 'sharp', 'exceljs'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }, { protocol: 'http', hostname: '**' }],
  },
  // 짧은 시간에 파일 여러 개가 잇달아 저장되면 재컴파일이 겹쳐 돌면서, 그 도중 들어온 요청이 아직 다
  // 쓰이지 않은 webpack 빌드 매니페스트를 읽어 "Unexpected end of JSON input" 500이나 스타일 안 먹은
  // 화면으로 보이는 경우가 있었다(2026-08-22). aggregateTimeout을 늘려 몰린 저장을 재컴파일 1번으로
  // 묶어 그 경합 구간 자체를 줄인다 — dev 전용, 빌드/운영에는 영향 없음.
  webpack: (config, { dev }) => {
    if (dev) config.watchOptions = { ...config.watchOptions, aggregateTimeout: 1000 }
    return config
  },
}

export default nextConfig
