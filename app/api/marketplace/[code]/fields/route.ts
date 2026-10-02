import { NextRequest, NextResponse } from 'next/server'
import { getProductAdapter } from '@/lib/marketplace/registry'

/**
 * 화면이 마켓별 인증정보/배송·반품 설정 입력폼을 동적으로 그리기 위한 필드 정의 조회. 어댑터가 아직
 * 없는 마켓은 둘 다 빈 배열 — 화면은 이 경우 범용 key-value 폼으로 폴백한다.
 */
export async function GET(_: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const adapter = getProductAdapter(code)
  return NextResponse.json({
    credentialFields: adapter?.credentialFields() ?? [],
    settingsFields: adapter?.settingsFields() ?? [],
  })
}
