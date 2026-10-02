import { NextRequest, NextResponse } from 'next/server'
import { getProductAdapter } from '@/lib/marketplace/registry'
import { loadClientCredentials } from '@/lib/marketplace/credentialStore'

/**
 * "오픈마켓 등록" 화면이 카테고리 코드 입력 직후 호출 — 필수 구매옵션 속성/고시정보 목록을 미리 보여줘
 * 등록 전에 고시정보 내용을 입력받을 수 있게 한다(!specifications/marketplace-api-integration.md).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const clientId = req.nextUrl.searchParams.get('clientId')
  const categoryCode = req.nextUrl.searchParams.get('categoryCode')
  if (!clientId || !categoryCode) return NextResponse.json({ error: 'clientId/categoryCode required' }, { status: 400 })

  const adapter = getProductAdapter(code)
  if (!adapter) return NextResponse.json({ error: `${code}는 아직 API 등록을 지원하지 않습니다` }, { status: 400 })

  const cred = await loadClientCredentials(Number(clientId), code)
  if (!cred) return NextResponse.json({ error: '이 거래처에 저장된 접속정보가 없습니다 — 거래처 상세에서 먼저 연동하세요' }, { status: 400 })

  try {
    const meta = await adapter.fetchCategoryMeta(categoryCode, cred.fields)
    return NextResponse.json(meta)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
