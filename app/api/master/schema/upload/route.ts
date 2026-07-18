import { NextRequest, NextResponse } from 'next/server'
import { parseReferenceWorkbook } from '@/lib/transform/matching'
import { guessFixedFieldMapping } from '@/lib/master/schema'

/** "기준 Master DB" 엑셀의 헤더 행만 읽어 고정 컬럼 매칭 초안을 만든다 — 저장은 하지 않고, 사용자가
 * 확인/수정한 뒤 PUT /api/master/schema로 확정한다. */
export async function POST(req: NextRequest) {
  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const { headers } = await parseReferenceWorkbook(buffer)
  if (!headers.length) return NextResponse.json({ error: '엑셀 헤더를 읽지 못했습니다.' }, { status: 400 })

  const guessed = guessFixedFieldMapping(headers)
  let customCounter = 0
  const fields = headers.map(label => {
    const fixed = guessed.get(label)
    if (fixed) return { field_key: fixed, field_label: label, is_custom: false }
    customCounter += 1
    return { field_key: `custom_${customCounter}`, field_label: label, is_custom: true }
  })

  return NextResponse.json({ fields })
}
