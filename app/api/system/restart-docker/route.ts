import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import fs from 'fs'

const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'

/** DB 연결 실패(Docker Desktop이 꺼져 로컬 Postgres 컨테이너가 죽은 경우)를 화면(DbHealthBanner)에서
 *  감지했을 때, 버튼 한 번으로 Docker Desktop을 다시 띄울 수 있게 한다. Docker Desktop 자체가 뜨는 데
 *  수십 초~1분 정도 걸리고 컨테이너(재시작 정책 unless-stopped)는 그 뒤 자동으로 따라 올라오므로, 여기서는
 *  실행만 시키고 기다리지 않는다 — 실제로 떴는지는 화면 쪽이 /api/health/db를 주기적으로 재확인한다. */
export async function POST() {
  if (!fs.existsSync(DOCKER_DESKTOP_EXE)) {
    return NextResponse.json({ error: `Docker Desktop 실행파일을 찾을 수 없습니다 (${DOCKER_DESKTOP_EXE})` }, { status: 500 })
  }
  const child = spawn(DOCKER_DESKTOP_EXE, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return NextResponse.json({ ok: true })
}
