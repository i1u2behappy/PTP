import { NextResponse } from 'next/server'
import { checkWorkerFreshness } from '@/lib/workerFreshness'

/** 워커(worker/index.ts)가 최신 코드를 반영했는지 화면(DbHealthBanner)에 알려주는 공개 엔드포인트 —
 *  판정 로직 자체는 lib/workerFreshness.ts에 있다(app/api/system/status/route.ts와 공용). */
export async function GET() {
  const info = await checkWorkerFreshness()
  return NextResponse.json({
    stale: info.stale,
    bootedAt: info.bootedAt,
    staleFiles: info.staleFiles,
    staleFileCount: info.staleFileCount,
  })
}
