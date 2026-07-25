import { NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 로컬 Docker(Postgres 컨테이너)가 죽어있을 때(Docker Desktop이 꺼진 경우 등) 화면에서 바로 알아채고
 *  재시작을 유도할 수 있도록 두는 가벼운 연결 확인용 엔드포인트. 로그인 화면에서도 봐야 하므로(DB가
 *  죽으면 로그인 자체가 500으로 실패한다) proxy.ts의 공개 경로에 포함돼 있다.
 *
 *  실제로 Docker Desktop을 재시작한 직후 확인해보니(WSL2 네트워킹이 아직 안정화되지 않은 상태), 연결이
 *  에러로 바로 실패하지 않고 그냥 응답 없이 몇 분씩 멈춰있는 경우가 있었다 — pg Pool엔 기본 타임아웃이
 *  없어 그대로 두면 이 엔드포인트도 같이 멈춰 배너가 "죽었는지 아직 확인 중인지" 구분이 안 된다. 그래서
 *  쿼리 자체에 짧은 타임아웃을 걸어 무조건 몇 초 안에 ok:false로라도 응답하게 한다. */
const HEALTH_CHECK_TIMEOUT_MS = 3_000

export async function GET() {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB 응답 없음(타임아웃)')), HEALTH_CHECK_TIMEOUT_MS)),
    ])
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
