import pool, { decryptSecret } from '../db'

export interface LoadedCredentials { fields: Record<string, string>; settings: Record<string, string> }

/**
 * 저장된 거래처별 오픈마켓 접속정보를 복호화해 반환한다 — category-meta/register 라우트가 공통으로
 * 쓰는 조회 로직이라 여기로 뺐다(app/api/marketplace/credentials/route.ts의 저장 로직과는 반대쪽).
 */
export async function loadClientCredentials(clientId: number, marketplaceCode: string): Promise<LoadedCredentials | null> {
  const res = await pool.query<{ credential_data_encrypted: string | null; credential_iv: string | null; settings: Record<string, string> | null }>(
    `SELECT credential_data_encrypted, credential_iv, settings FROM marketplace_credentials
     WHERE client_id=$1 AND marketplace_code=$2 AND is_active=true`,
    [clientId, marketplaceCode],
  )
  const row = res.rows[0]
  if (!row) return null
  const decrypted = decryptSecret(row.credential_data_encrypted, row.credential_iv)
  if (!decrypted) return null
  return { fields: JSON.parse(decrypted) as Record<string, string>, settings: row.settings || {} }
}
