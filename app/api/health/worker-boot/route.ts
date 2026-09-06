import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const BOOT_STATUS_PATH = path.join(process.cwd(), '.worker-boot-status.json')

/** 워커(worker/index.ts)가 DB 연결 재시도 중일 때(재부팅 직후 최대 8분까지 걸릴 수 있음) 그 진행
 *  상황을 화면에 보여주기 위한 공개 엔드포인트 — worker/index.ts의 initDbWithRetry가 남기는 파일을
 *  그대로 읽어 전달한다. 파일이 없으면(워커가 정상 기동해 재시도 없이 바로 떴거나, 아예 안 켜진
 *  경우) 'unknown'으로 응답해 DbHealthBanner가 기존 db-down/server-down 판단으로 넘어가게 한다. */
export async function GET() {
  try {
    const raw = fs.readFileSync(BOOT_STATUS_PATH, 'utf8')
    return NextResponse.json(JSON.parse(raw))
  } catch {
    return NextResponse.json({ status: 'unknown' })
  }
}
