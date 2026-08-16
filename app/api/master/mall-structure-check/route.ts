import { NextRequest, NextResponse } from 'next/server'
import pool, { decryptSecret } from '@/lib/db'
import { runMallProfileCheckForScrape } from '@/lib/scrape/mallProfile'

interface SiteRow {
  url: string
  login_id: string | null
  login_pw_encrypted: string | null
  login_pw_iv: string | null
}

/** 마이그레이션3_연속관리 전용 몰 구조("상품페이지 구조") 변경 감지 — 원래 스크래핑 메뉴의 "로그인 확인"
 *  클릭마다 자동으로 돌던 기능인데, 사용자가 재고/옵션/이미지/가격 변동 감지와 같은 화면에서 함께 확인하고
 *  싶다고 해 이쪽으로 옮겼다(2026-08). 로그인 창을 열어둘 필요 없이 저장된 계정정보로 브라우저 컨텍스트를
 *  새로 열어 확인한다 — 결과는 site_memos에도 남아 Mall 상세관리 화면에서 이력으로 볼 수 있다. */
export async function POST(req: NextRequest) {
  const { siteId } = await req.json() as { siteId: number }
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const res = await pool.query<SiteRow>(
    `SELECT url, login_id, login_pw_encrypted, login_pw_iv FROM sites WHERE id = $1`, [siteId],
  )
  const site = res.rows[0]
  if (!site?.url) return NextResponse.json({ error: '이 몰에 등록된 URL이 없습니다' }, { status: 400 })

  // allowStaleManualLoginProfile: 이 라우트는 "직접로그인 필수 몰(개발자모드)도 포함해 모든 몰 유형에서
  // 동작한다"고 문서화돼 있는데, 그 몰은 실제 크롬을 켜둔 채 쓰는 게 정상 상태라 세션 파일이 잠긴 채
  // 복사돼도(robocopy 일부 실패) 이 가벼운 구조 확인은 그냥 진행해야 한다 — 안 그러면 개발자모드
  // 몰에서는 이 기능이 사실상 항상 실패한다(몰 구조분석/카테고리 불러오기에 이미 적용한 것과 동일,
  // 2026-08-16).
  const result = await runMallProfileCheckForScrape({
    url: site.url,
    siteId,
    loginId: site.login_id || undefined,
    loginPw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined,
    allowStaleManualLoginProfile: true,
  })

  if (!result) return NextResponse.json({ error: '몰 구조를 확인하지 못했습니다 (접속 실패 등)' }, { status: 500 })
  return NextResponse.json(result)
}
