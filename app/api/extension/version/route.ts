import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

/**
 * 개발자모드 확장(extension-poc)의 "서버 쪽 최신 버전"을 알려준다 — extension-poc/manifest.json의
 * version 필드가 곧 그 답이다(이 저장소 안의 코드가 곧 배포본이라 별도 빌드/배포 파이프라인이 없음).
 * ScraperPanel.tsx가 이 값을 확장이 스스로 보고한 설치된 버전과 비교해, 서버 쪽이 더 새로우면 확장에
 * "새로고침(reload)"을 요청한다(2026-08-22, 사용자 요청 — 언패킹 설치는 크롬 자체 자동업데이트가
 * 없어 PTP가 대신 버전을 비교해준다).
 */
export async function GET() {
  const manifestPath = path.join(process.cwd(), 'extension-poc', 'manifest.json')
  const raw = await fs.readFile(manifestPath, 'utf-8').catch(() => null)
  if (!raw) return NextResponse.json({ error: 'manifest not found' }, { status: 500 })
  const manifest = JSON.parse(raw) as { version?: string }
  if (!manifest.version) return NextResponse.json({ error: 'version missing' }, { status: 500 })
  return NextResponse.json({ version: manifest.version })
}
