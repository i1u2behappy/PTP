import pool from '../db'

/** 평문 카테고리명 → master_categories 노드 id를 얻는다(없으면 만든다). parentId가 null이면 루트 노드.
 *  ON CONFLICT DO UPDATE SET name=EXCLUDED.name는 아무 값도 안 바꾸는 더미 갱신이지만, 그래야 이미 있는
 *  행과 충돌했을 때도 RETURNING으로 그 행의 id를 돌려받는다(조회를 따로 안 날리는 한 번의 왕복짜리
 *  get-or-create). lib/master/migrate.ts와 카테고리 트리 관리 API가 공유한다. */
export async function getOrCreateCategoryId(parentId: number | null, name: string): Promise<number | null> {
  if (!name) return null
  if (parentId === null) {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO master_categories (name, depth) VALUES ($1, 0)
       ON CONFLICT (name) WHERE parent_id IS NULL DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name],
    )
    return res.rows[0]?.id ?? null
  }
  const parent = await pool.query<{ depth: number }>(`SELECT depth FROM master_categories WHERE id=$1`, [parentId])
  const depth = (parent.rows[0]?.depth ?? 0) + 1
  const res = await pool.query<{ id: number }>(
    `INSERT INTO master_categories (parent_id, name, depth) VALUES ($1, $2, $3)
     ON CONFLICT (parent_id, name) WHERE parent_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [parentId, name, depth],
  )
  return res.rows[0]?.id ?? null
}

export interface CategoryNode {
  id: number
  parentId: number | null
  name: string
  depth: number
  sortOrder: number
  productCount: number
}

/** 트리 전체를 평면 배열로 반환한다(각 노드가 product_master에서 쓰이는 건수 포함) — 화면에서 parentId로
 *  부모-자식을 다시 묶어 렌더링한다. */
export async function listCategoryTree(): Promise<CategoryNode[]> {
  const res = await pool.query<{ id: number; parent_id: number | null; name: string; depth: number; sort_order: number; product_count: string }>(
    `SELECT mc.id, mc.parent_id, mc.name, mc.depth, mc.sort_order,
            COUNT(pm.id)::int AS product_count
     FROM master_categories mc
     LEFT JOIN product_master pm ON pm.master_category_id = mc.id
     GROUP BY mc.id
     ORDER BY mc.depth, mc.sort_order, mc.name`,
  )
  return res.rows.map(r => ({
    id: r.id, parentId: r.parent_id, name: r.name, depth: r.depth, sortOrder: r.sort_order,
    productCount: Number(r.product_count),
  }))
}

/** id가 targetId의 자기 자신이거나 하위 노드인지 확인한다 — 트리를 자기 자신의 하위로 옮기는 순환참조를
 *  막기 위한 용도(화면에서 "상위 카테고리" 드롭다운에 자기 하위 노드를 골라도 서버가 한 번 더 막는다). */
export async function isDescendantOrSelf(candidateParentId: number, nodeId: number): Promise<boolean> {
  if (candidateParentId === nodeId) return true
  const res = await pool.query<{ id: number }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM master_categories WHERE parent_id = $1
       UNION ALL
       SELECT mc.id FROM master_categories mc JOIN descendants d ON mc.parent_id = d.id
     )
     SELECT id FROM descendants WHERE id = $2`,
    [nodeId, candidateParentId],
  )
  return res.rows.length > 0
}
