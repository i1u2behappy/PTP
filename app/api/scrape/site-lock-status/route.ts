import { NextRequest, NextResponse } from 'next/server'
import { getSiteLockStatus } from '@/lib/workerClient'

/** 화면이 이 몰이 선택된 동안 짧은 주기로 폴링해 "⏳ 다른 작업(N) 완료를 기다리는 중"을 보여준다 —
 *  withSiteLock으로 같은 몰의 스크랩 관련 기능들이 순서대로만 실행되게 하면서, 대기 중인 사용자
 *  입장에선 그게 "그냥 느린 것"과 구분이 안 됐다(실사용 중 확인된 문제). */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  const status = await getSiteLockStatus(siteId)
  return NextResponse.json(status ? { busy: true, ...status } : { busy: false })
}
