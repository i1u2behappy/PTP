import fs from 'fs'
import path from 'path'

// 이 워커 프로세스는 tsx로 뜨고 파일 변경을 감지해 스스로 재시작하지 않는다 — lib/scraper.ts,
// lib/scrape/*, lib/ai.ts, worker/* 등을 고쳐도 워커를 수동으로 재시작하기 전까지는 예전 코드가 그대로
// 계속 실행된다. 워커의 부팅 시각(worker/rpc-server.ts의 BOOTED_AT)과 이 코드들의 최신 수정 시각을 비교해,
// 재시작 이후 바뀐 파일이 있으면 스스로 알아챈다. 원래 app/api/health/worker-freshness/route.ts에만
// 있던 로직인데, app/api/system/status/route.ts(시스템 상태 팝업)도 같은 판정이 필요해 공용 함수로 뺐다.
const WORKER_DEP_DIRS = ['lib', 'worker']
// 테스트 파일은 워커 실행에 영향이 없으니 걸러 불필요한 재시작 유도를 피한다.
const IGNORE_RE = /\.test\.ts$|\.property\.test\.ts$/

function collectTsFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !IGNORE_RE.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

export interface WorkerFreshnessInfo {
  ok: boolean
  pid?: number
  bootedAt?: number
  stale: boolean
  staleFiles: string[]
  staleFileCount: number
}

export async function checkWorkerFreshness(): Promise<WorkerFreshnessInfo> {
  const port = Number(process.env.WORKER_PORT) || 4801
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) })
    .then(r => r.json()).catch(() => null) as { ok?: boolean; bootedAt?: number; pid?: number } | null
  // 워커 자체가 응답 없음(꺼짐/재부팅 중)은 다른 화면(worker-boot 배너, 시스템 상태 팝업의 db/worker
  // 카드)이 이미 다루는 상태라 여기서는 "판단 불가"로만 보고한다 — stale:false로 조용히 넘어간다.
  if (!health?.bootedAt) return { ok: false, stale: false, staleFiles: [], staleFileCount: 0 }

  const root = process.cwd()
  const files = WORKER_DEP_DIRS.flatMap(d => collectTsFiles(path.join(root, d)))
  const staleFiles: string[] = []
  for (const file of files) {
    const mtime = fs.statSync(file).mtimeMs
    if (mtime > health.bootedAt) staleFiles.push(path.relative(root, file).replace(/\\/g, '/'))
  }
  return {
    ok: true,
    pid: health.pid,
    bootedAt: health.bootedAt,
    stale: staleFiles.length > 0,
    staleFiles: staleFiles.slice(0, 10),
    staleFileCount: staleFiles.length,
  }
}
