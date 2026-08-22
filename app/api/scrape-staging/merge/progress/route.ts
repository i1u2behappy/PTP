import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** "확정" 진행 중 화면이 폴링하는 용도 — 별도 인메모리 상태를 두지 않고 scrape_staging_items.status를
 *  직접 세어 진행률을 구한다(전달받은 ids 중 아직 'pending'이 아닌 개수 = 처리 완료). 인메모리 Map으로
 *  만들었다가, dev 서버가 파일 저장마다 lib/scrape/staging.ts 모듈을 다시 평가해 그 Map이 통째로
 *  초기화되는 문제를 실사용 중 겪었다(lib/scraper.ts의 openSessions 등 다른 인메모리 상태들이 이미
 *  globalThis로 우회해온 것과 같은 원인) — DB를 직접 조회하면 이 문제 자체가 생기지 않는다. handleMerge가
 *  항상 force:true로 호출해 처리된 항목은 성공/스킵 관계없이 'merged'로 바뀌므로(mergeStagingItems
 *  참고) 이 카운트가 실제 진행 상황과 정확히 일치한다. */
export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('ids')
  if (!idsParam) return NextResponse.json({ error: 'ids required' }, { status: 400 })
  const ids = idsParam.split(',').map(Number).filter(Number.isInteger)
  if (!ids.length) return NextResponse.json({ total: 0, done: 0 })

  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM scrape_staging_items WHERE id = ANY($1) AND status <> 'pending'`,
    [ids],
  )
  return NextResponse.json({ total: ids.length, done: Number(res.rows[0].count) })
}
