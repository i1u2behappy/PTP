import { NextRequest, NextResponse } from 'next/server'
import { stopProfileAnalysis } from '@/lib/workerClient'

/**
 * "몰 구조분석" 진행 중 "중지" 버튼 — PTP 화면이 직접 부른다(확장이 아니라 이 화면 자체의 요청이라
 * CORS 처리 불필요). lib/scraper.ts의 profileAbortControllers에서 이 siteId의 AbortController를
 * 찾아 abort()한다 — 그 순간 진행 중이던 Ollama 호출(pickIndicesWithOllama)의 fetch가 즉시 끊겨
 * llama-server도 그 요청의 생성을 멈추고, 남은 페이지 방문(mapWithPageWorkers)도 다음 항목부터
 * 더 진행하지 않는다(2026-08-22, 사용자 요청).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const stopped = await stopProfileAnalysis(siteId)
  return NextResponse.json({ ok: true, stopped })
}
