import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool from '@/lib/db'
import { getOrCreateCategoryId } from '@/lib/master/categories'

const DELIMITER = ' > '

function splitSegments(name: string): string[] {
  return name.split(DELIMITER).map(s => s.trim()).filter(Boolean)
}

/** 백필 직후 확인된 관찰(!specifications/product-master-architecture-redesign.md §9) — 기존 평문
 *  카테고리 상당수가 이미 " > " 구분자로 계층을 암시하고 있었다("강아지 > 장난감/훈련용품" 등). 전부
 *  수작업으로 나눌 필요 없이, 이 구분자를 기준으로 자동 분할 후보를 제안한다(아직 적용 전 미리보기). */
export async function GET() {
  const res = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM master_categories WHERE parent_id IS NULL AND name LIKE '%' || $1 || '%'`,
    [DELIMITER],
  )
  const candidates = res.rows
    .map(r => ({ id: r.id, name: r.name, segments: splitSegments(r.name) }))
    .filter(c => c.segments.length > 1)
  return NextResponse.json(candidates)
}

const ApplySchema = z.object({ ids: z.array(z.number()).min(1) })

export async function POST(req: NextRequest) {
  const parsed = ApplySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })

  const applied: number[] = []
  const failed: { id: number; error: string }[] = []

  // 후보마다 독립적인 트리 변경이라 하나가 실패해도 나머지는 계속 진행한다 — 동시성 문제보단 순서가
  // 중요해(같은 상위 세그먼트를 여러 후보가 공유할 수 있음, 예: "홈 > A"와 "홈 > B") 순차 처리한다.
  for (const id of parsed.data.ids) {
    try {
      const row = await pool.query<{ name: string; parent_id: number | null }>(
        'SELECT name, parent_id FROM master_categories WHERE id=$1', [id],
      )
      const node = row.rows[0]
      if (!node) { failed.push({ id, error: '존재하지 않는 카테고리입니다' }); continue }
      if (node.parent_id !== null) { failed.push({ id, error: '이미 분할 적용된 카테고리입니다' }); continue }
      const segments = splitSegments(node.name)
      if (segments.length < 2) { failed.push({ id, error: '구분자(" > ")로 나눌 수 없는 이름입니다' }); continue }

      // 마지막 세그먼트는 이 노드 자신이 된다(id를 새로 만들지 않고 재사용 — product_master 등 기존 FK가
      // 전부 그대로 이 id를 가리키고 있어, 이름/부모만 바꾸면 다른 테이블은 손댈 필요가 없다).
      let parentId: number | null = null
      for (let i = 0; i < segments.length - 1; i++) {
        parentId = await getOrCreateCategoryId(parentId, segments[i])
      }
      const leafName = segments[segments.length - 1]
      const depth = segments.length - 1
      await pool.query('UPDATE master_categories SET name=$1, parent_id=$2, depth=$3 WHERE id=$4', [leafName, parentId, depth, id])
      applied.push(id)
    } catch (e) {
      const code = (e as { code?: string }).code
      failed.push({ id, error: code === '23505' ? '같은 위치에 이미 같은 이름의 카테고리가 있습니다' : (e instanceof Error ? e.message : String(e)) })
    }
  }

  return NextResponse.json({ applied, failed })
}
