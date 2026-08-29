import { NextResponse } from 'next/server'
import { focusManualLoginChrome } from '@/lib/workerClient'

/** "몰 구조분석" 버튼(개발자모드)이 새 창/새 탭을 또 열지 않고, 이미 로그인해둔 개인 크롬 창을 그대로
 *  앞으로 가져오기 위한 전용 라우트 — lib/scraper.ts의 focusManualLoginChrome 참고. 워커가 이 RPC를 아직
 *  모르는 채로 떠 있으면(배포 직후 워커 재시작 전 등) callWorker가 예외를 던지는데, 그걸 그대로 흘리면
 *  버튼 클릭마다 "서버 오류(500)" 토스트가 뜬다 — 사용자에게는 "창을 못 찾음"과 똑같이 다루면 되므로
 *  여기서 잡아 ok:false로 낮춘다(2026-08-29, 실사용 확인). */
export async function POST() {
  try {
    const ok = await focusManualLoginChrome()
    return NextResponse.json({ ok })
  } catch {
    return NextResponse.json({ ok: false })
  }
}
