import pool from '../db'

/**
 * 세션이 데이터 마이그 목록에서 "선택 병합"되어 있으면 같은 그룹의 모든 세션 id를, 아니면 자기 자신만
 * 담긴 배열을 반환한다. 다른 메뉴들이 sessionId 하나로 조회해도(마이그레이션 하위 메뉴, 스크랩 Raw
 * 확인 등) 병합된 세션 전체를 함께 보게 하는 근거 — 각 API 라우트는 `session_id = $1` 대신
 * `session_id = ANY($1)`로 이 함수의 반환값을 사용하면 된다.
 */
export async function resolveSessionGroup(sessionId: number): Promise<number[]> {
  const res = await pool.query<{ merge_group_id: number | null }>(
    'SELECT merge_group_id FROM scrape_sessions WHERE id=$1', [sessionId],
  )
  const groupId = res.rows[0]?.merge_group_id
  if (!groupId) return [sessionId]
  const group = await pool.query<{ id: number }>('SELECT id FROM scrape_sessions WHERE merge_group_id=$1', [groupId])
  return group.rows.map(r => r.id)
}
