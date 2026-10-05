import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool, { encryptSecret, decryptSecret } from '@/lib/db'
import { getProductAdapter } from '@/lib/marketplace/registry'

/**
 * 거래처별 오픈마켓 접속정보 관리 (!specifications/marketplace-api-integration.md §2·§4 1단계).
 * 마켓마다 ID/PW·API Key 조합이 달라(경쟁사 샵링커 사례로 확인) fields를 고정 스키마 없이 통째로
 * JSON 직렬화해 암호화 저장한다 — 마켓별 어댑터(2단계 이후)가 credentialFields()로 어떤 키가
 * 필요한지 알려주기 전까지는, 사람이 키 이름을 직접 입력하는 범용 key-value 폼으로 받는다.
 */
const SaveSchema = z.object({
  clientId: z.number(),
  marketplaceCode: z.string().min(1),
  fields: z.record(z.string(), z.string()).refine(f => Object.keys(f).length > 0, { message: 'fields required' }),
  // 거래처 단위 배송/반품 정책 등 — 비밀값이 아니라 평문 저장(settingsFields()가 없는 마켓은 생략 가능).
  settings: z.record(z.string(), z.string()).optional(),
  // 거래처가 한 마켓에 판매계정을 여러 개 쓰는 경우 구분용(2026-10-05 확인). 계정 추가/선택 UI가 아직
  // 없어 기본값 'default'만 실사용되지만, 다중계정 스키마(lib/db.ts의 marketplace_credentials
  // account_label)와 맞추기 위해 받아둔다.
  accountLabel: z.string().min(1).default('default'),
})

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 })

  const res = await pool.query<{
    id: number; marketplace_code: string; marketplace_name: string; account_label: string
    credential_data_encrypted: string | null; credential_iv: string | null
    is_active: boolean; last_verified_at: string | null; verify_error: string | null
    settings: Record<string, string> | null
  }>(
    `SELECT mc.id, mc.marketplace_code, cfg.name AS marketplace_name, mc.account_label,
            mc.credential_data_encrypted, mc.credential_iv,
            mc.is_active, mc.last_verified_at, mc.verify_error, mc.settings
     FROM marketplace_credentials mc
     JOIN marketplace_configs cfg ON cfg.code = mc.marketplace_code
     WHERE mc.client_id = $1
     ORDER BY cfg.name, mc.account_label`,
    [clientId],
  )

  // 저장된 값 자체(복호화된 키/시크릿)는 응답에 절대 포함하지 않는다 — 어떤 필드가 설정돼 있는지
  // 이름만 보여준다. settings는 비밀값이 아니므로 그대로 내려준다(수정 폼에 기존값을 채우기 위해 필요).
  const rows = res.rows.map(r => {
    let fieldKeys: string[] = []
    try {
      const decrypted = decryptSecret(r.credential_data_encrypted, r.credential_iv)
      if (decrypted) fieldKeys = Object.keys(JSON.parse(decrypted) as Record<string, string>)
    } catch { /* 복호화 실패는 화면에서 "설정된 필드 없음"으로만 보이면 충분 */ }
    return {
      id: r.id, marketplaceCode: r.marketplace_code, marketplaceName: r.marketplace_name, accountLabel: r.account_label,
      fieldKeys, isActive: r.is_active, lastVerifiedAt: r.last_verified_at, verifyError: r.verify_error,
      settings: r.settings || {},
    }
  })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const parsed = SaveSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  const { clientId, marketplaceCode, fields, settings, accountLabel } = parsed.data

  const { encrypted, iv } = encryptSecret(JSON.stringify(fields))
  await pool.query(
    `INSERT INTO marketplace_credentials (client_id, marketplace_code, account_label, credential_data_encrypted, credential_iv, settings, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (client_id, marketplace_code, account_label) DO UPDATE SET
       credential_data_encrypted = $4, credential_iv = $5, settings = $6, is_active = true,
       last_verified_at = NULL, verify_error = NULL, updated_at = NOW()`,
    [clientId, marketplaceCode, accountLabel, encrypted, iv, JSON.stringify(settings || {})],
  )

  // 어댑터가 있는 마켓(지금은 쿠팡만)은 저장 직후 1회 ping으로 검증한다 — 없는 마켓은 그대로 미검증
  // 상태로 남는다(화면이 "아직 검증 안 됨"으로 표시).
  const adapter = getProductAdapter(marketplaceCode)
  let verified: { ok: boolean; error?: string } | null = null
  if (adapter) {
    verified = await adapter.verifyCredentials(fields).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    await pool.query(
      `UPDATE marketplace_credentials SET last_verified_at = $4, verify_error = $5
       WHERE client_id = $1 AND marketplace_code = $2 AND account_label = $3`,
      [clientId, marketplaceCode, accountLabel, verified.ok ? new Date() : null, verified.ok ? null : (verified.error || '알 수 없는 오류')],
    )
  }
  return NextResponse.json({ ok: true, verified })
}
