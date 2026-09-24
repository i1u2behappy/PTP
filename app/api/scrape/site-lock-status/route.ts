import { NextRequest, NextResponse } from 'next/server'
import { getSiteLockStatus, getSiteLastRunSignals } from '@/lib/workerClient'

/** 화면이 이 몰이 선택된 동안 짧은 주기로 폴링해 "⏳ 다른 작업(N) 완료를 기다리는 중"을 보여준다 —
 *  withSiteLock으로 같은 몰의 스크랩 관련 기능들이 순서대로만 실행되게 하면서, 대기 중인 사용자
 *  입장에선 그게 "그냥 느린 것"과 구분이 안 됐다(실사용 중 확인된 문제).
 *
 *  busy:false일 때 lastRunSignals(lib/scraper.ts의 getSiteLastRunSignals 주석 참고)를 같이 실어 보낸다 —
 *  개발자모드는 "몰 구조분석" 응답을 확장이 직접 받고 PTP 탭은 못 받으므로, 이미 항상 돌고 있던 이
 *  폴링의 busy→false 전이에서 PTP 탭이 그 값을 대신 주워가게 한다(사용자 지적, 2026-09-24 — "개발자모드에서
 *  몰구조분석 중인데 왜 어떤 llm이 사용되는지 안보이지?"). in-memory 맵 조회라 폴링 주기(3초)에 얹어도
 *  비용이 없다. */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  const status = await getSiteLockStatus(siteId)
  if (status) return NextResponse.json({ busy: true, ...status })
  const lastRunSignals = await getSiteLastRunSignals(siteId).catch(() => null)
  return NextResponse.json({ busy: false, ...(lastRunSignals ? { lastRunSignals } : {}) })
}
