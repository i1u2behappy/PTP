import pool, { decryptSecret } from '../db'

export interface LoadedCredentials { id: number; fields: Record<string, string>; settings: Record<string, string> }

/**
 * 저장된 거래처별 오픈마켓 접속정보를 복호화해 반환한다 — category-meta/register 라우트가 공통으로
 * 쓰는 조회 로직이라 여기로 뺐다(app/api/marketplace/credentials/route.ts의 저장 로직과는 반대쪽).
 *
 * accountLabel: 거래처가 한 마켓에 판매계정을 여러 개 쓰는 경우를 구분하는 키(2026-10-05 사용자 확인
 * — 샵링커/플레이오토도 지원하는 패턴). 계정 선택 UI가 아직 없어 기본값 'default'만 쓰지만, 명시적으로
 * 받아두면 나중에 호출부가 계정을 고를 수 있게 돼도 이 함수는 안 바뀐다. client_id+marketplace_code만
 * 넘기면(예전처럼) 여러 계정 중 하나를 조용히 아무거나 고르는 사고를 방지하기 위해 항상 account_label도
 * 조건에 넣는다.
 */
export async function loadClientCredentials(clientId: number, marketplaceCode: string, accountLabel = 'default'): Promise<LoadedCredentials | null> {
  const res = await pool.query<{ id: number; credential_data_encrypted: string | null; credential_iv: string | null; settings: Record<string, string> | null }>(
    `SELECT id, credential_data_encrypted, credential_iv, settings FROM marketplace_credentials
     WHERE client_id=$1 AND marketplace_code=$2 AND account_label=$3 AND is_active=true`,
    [clientId, marketplaceCode, accountLabel],
  )
  const row = res.rows[0]
  if (!row) return null
  const decrypted = decryptSecret(row.credential_data_encrypted, row.credential_iv)
  if (!decrypted) return null
  return { id: row.id, fields: JSON.parse(decrypted) as Record<string, string>, settings: row.settings || {} }
}
