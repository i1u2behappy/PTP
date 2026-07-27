import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { spawn } from 'child_process'
import { resolveScrapeFolderPath } from '@/lib/images'

/** "스크랩 Raw 확인"의 파일 컬럼에서, 그 상품이 속한 세션의 이미지 저장 폴더(대표/상세이미지 상위)를
 *  탐색기로 연다. 아직 한 건도 병합되지 않은 세션은 폴더 자체가 생성되지 않았을 수 있다. */
export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId?: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const folderPath = await resolveScrapeFolderPath(sessionId)
  if (!fs.existsSync(folderPath)) {
    return NextResponse.json({ error: '아직 다운로드된 이미지가 없습니다 (병합 전인 상품일 수 있습니다)' }, { status: 404 })
  }
  spawn('explorer', [folderPath], { detached: true, stdio: 'ignore' }).unref()
  return NextResponse.json({ ok: true })
}
