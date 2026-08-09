import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { spawn } from 'child_process'

// PTP는 Edge 탭 안에서 돌아가므로 window.open은 항상 그 Edge에서 열린다 — 상품 원본 페이지는 Chrome이
// 설치돼 있으면 Chrome으로, 없으면 PTP를 띄운 것과 무관하게 Edge로 직접 열어달라는 요청(2026-08-10).
// 웹페이지 JS로는 "다른 브라우저 앱으로 열어라"를 지정할 방법이 없어(브라우저가 막아둠), 서버(이 앱은
// 로컬 PC에서만 돎)가 대신 OS 프로세스로 브라우저를 띄운다.
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
]
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findBrowser(candidates: string[]): string | null {
  return candidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) || null
}

export async function POST(req: NextRequest) {
  const { url } = await req.json() as { url?: string }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const browserPath = findBrowser(CHROME_CANDIDATES) || findBrowser(EDGE_CANDIDATES)
  if (!browserPath) return NextResponse.json({ error: '설치된 Chrome/Edge를 찾지 못했습니다' }, { status: 404 })

  spawn(browserPath, [url], { detached: true, stdio: 'ignore' }).unref()
  return NextResponse.json({ ok: true })
}
