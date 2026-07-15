import { NextRequest, NextResponse } from 'next/server'
import { getLatestUpload, getGuidePairs } from '@/lib/transform/matching'

/** AS-IS/TO-BE 업로드 요약 + 코드로 매칭된 비교 쌍(마이그레이션 예시)을 반환한다. */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const [asIsUpload, toBeUpload, pairs] = await Promise.all([
    getLatestUpload(siteId, 'as_is'),
    getLatestUpload(siteId, 'to_be'),
    getGuidePairs(siteId),
  ])
  return NextResponse.json({ asIsUpload, toBeUpload, pairs })
}
