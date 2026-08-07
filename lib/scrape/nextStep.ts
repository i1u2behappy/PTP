import pool from '../db'

export interface NextStep {
  key: 'profile' | 'rules' | 'scrape' | 'confirm'
  label: string
}

/**
 * 몰 하나가 파이프라인(로그인확인 → 몰구조파악 → 추출규칙 → 스크랩 → 마이그레이션 확정)의 어느 단계까지
 * 끝냈는지 별도 상태 컬럼으로 저장하지 않고, 이미 있는 사실(scrape_profile/extraction_rules/
 * scrape_sessions/scrape_staging_items)에서 그때그때 계산한다 — 상태 컬럼을 따로 두면 다른 경로로 실제
 * 데이터가 바뀌었을 때 화면에 남은 값과 어긋나는 사고가 나기 쉽다. 순서대로 훑다가 처음 만나는 미완료
 * 항목을 "다음 할 일"로 반환하고, 전부 끝났으면 null.
 *
 * "로그인 확인"은 세션이 서버 메모리(openSessions)에만 있고 DB에 남지 않아 여기서 판단할 수 없다 — 몰구조
 * 파악 자체가 로그인 세션을 요구하므로 그 단계에 자연스럽게 포함시켰다(하지 않는 것 참고: !specifications/
 * mall-profile-baseline.md).
 */
export async function getNextStepForSite(siteId: number): Promise<NextStep | null> {
  const res = await pool.query<{
    has_profile: boolean
    has_rules: boolean
    session_count: number
    pending_count: number
  }>(
    `SELECT
       s.scrape_profile_updated_at IS NOT NULL AS has_profile,
       s.extraction_rules IS NOT NULL AND s.extraction_rules != '{}'::jsonb AS has_rules,
       (SELECT count(*) FROM scrape_sessions WHERE site_id = s.id) AS session_count,
       (SELECT count(*) FROM scrape_staging_items WHERE site_id = s.id AND status = 'pending') AS pending_count
     FROM sites s WHERE s.id = $1`,
    [siteId],
  )
  const row = res.rows[0]
  if (!row) return null

  if (!row.has_profile) return { key: 'profile', label: '스크래핑 화면에서 "몰 구조 파악" 버튼을 클릭하세요' }
  if (!row.has_rules) return { key: 'rules', label: '스크래핑 화면에서 "몰 구조 파악" 버튼을 다시 클릭하세요 (추출규칙 생성)' }
  if (Number(row.session_count) === 0) return { key: 'scrape', label: '스크래핑 화면에서 "스크래핑 시작" 버튼을 클릭하세요' }
  if (Number(row.pending_count) > 0) return { key: 'confirm', label: `"스크랩 Raw 확인" 화면에서 "확정 (스크랩검수 후)" 버튼을 클릭하세요 (${row.pending_count}건)` }
  return null
}
