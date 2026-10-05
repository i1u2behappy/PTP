import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool from '@/lib/db'
import { isDescendantOrSelf } from '@/lib/master/categories'

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  parentId: z.number().nullable().optional(),
})

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const nodeId = Number(id)
  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  const { name, parentId } = parsed.data
  if (name === undefined && parentId === undefined) return NextResponse.json({ error: 'name 또는 parentId가 필요합니다' }, { status: 400 })

  if (parentId !== undefined) {
    // 자기 자신 또는 자기 하위 노드로 옮기면 트리에 순환참조가 생긴다 — 화면 드롭다운이 막아주지만
    // 서버에서도 한 번 더 막는다("조용한 오매핑 금지"와 같은 원칙 — 클라이언트만 믿지 않는다).
    if (parentId !== null && await isDescendantOrSelf(parentId, nodeId)) {
      return NextResponse.json({ error: '카테고리를 자기 자신이나 하위 카테고리 아래로 옮길 수 없습니다' }, { status: 400 })
    }
    const current = await pool.query<{ parent_id: number | null; depth: number }>('SELECT parent_id, depth FROM master_categories WHERE id=$1', [nodeId])
    if (!current.rows[0]) return NextResponse.json({ error: '존재하지 않는 카테고리입니다' }, { status: 404 })
    const oldDepth = current.rows[0].depth
    let newDepth = 0
    if (parentId !== null) {
      const parent = await pool.query<{ depth: number }>('SELECT depth FROM master_categories WHERE id=$1', [parentId])
      if (!parent.rows[0]) return NextResponse.json({ error: '존재하지 않는 상위 카테고리입니다' }, { status: 404 })
      newDepth = parent.rows[0].depth + 1
    }
    try {
      await pool.query('UPDATE master_categories SET parent_id=$1, depth=$2 WHERE id=$3', [parentId, newDepth, nodeId])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return NextResponse.json({ error: '옮기려는 위치에 같은 이름의 카테고리가 이미 있습니다' }, { status: 409 })
      }
      throw e
    }
    // depth는 표시/정렬용 비정규화 값이라, 이 노드를 옮기면 그 아래 하위 트리 전체의 depth도 같은 폭(delta)만큼
    // 옮겨줘야 "부모보다 1 큰 depth"라는 불변식이 유지된다(하위 노드들의 상대적 깊이는 바뀌지 않으므로 전부 같은
    // delta를 더하면 된다).
    const delta = newDepth - oldDepth
    if (delta !== 0) {
      await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM master_categories WHERE parent_id = $1
           UNION ALL
           SELECT mc.id FROM master_categories mc JOIN descendants d ON mc.parent_id = d.id
         )
         UPDATE master_categories SET depth = depth + $2 WHERE id IN (SELECT id FROM descendants)`,
        [nodeId, delta],
      )
    }
  }

  if (name !== undefined) {
    try {
      await pool.query('UPDATE master_categories SET name=$1 WHERE id=$2', [name, nodeId])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return NextResponse.json({ error: '같은 위치에 이미 이 이름의 카테고리가 있습니다' }, { status: 409 })
      }
      throw e
    }
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await pool.query('DELETE FROM master_categories WHERE id=$1', [Number(id)])
  } catch (e) {
    if ((e as { code?: string }).code === '23503') {
      return NextResponse.json(
        { error: '이 카테고리(또는 하위 카테고리)를 쓰는 상품/마켓 매핑이 있어 삭제할 수 없습니다. 먼저 해당 상품들을 다른 카테고리로 옮긴 뒤 삭제하세요.' },
        { status: 409 },
      )
    }
    throw e
  }
  return NextResponse.json({ ok: true })
}
