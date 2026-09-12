import fs from 'fs'
import path from 'path'

const HISTORY_PATH = path.join(process.cwd(), '.restart-history.jsonl')
const MAX_ENTRIES = 20

export type RestartTarget = 'worker' | 'server' | 'docker'
export type RestartTrigger = 'manual' | 'auto' | 'cascade'

export interface RestartHistoryEntry {
  at: number
  target: RestartTarget
  trigger: RestartTrigger
}

/**
 * 재시작 이력을 아주 가볍게 남긴다 — 이번 세션 내내 "지금 뭐가 재시작됐지/왜 됐지"를 로그 파일 여러 개
 * (.dev-server.log, .worker.log)를 대조해가며 역추적해야 했다(시각을 서로 맞춰봐야 했음). DB 테이블을
 * 새로 두는 대신 파일 하나(JSONL)에 append만 하고, 읽을 때 최근 것만 잘라 돌려준다 — "정확한 감사
 * 로그"가 아니라 "방금 뭐가 있었는지 한눈에" 보려는 용도라 이 정도로 충분하다.
 *
 * trigger로 재시작이 사람이 누른 건지(manual), 메모리 임계치 등으로 스스로 판단한 건지(auto), 다른
 * 재시작이 유발한 연쇄재시작인지(cascade — 2026-09-11 도입, 워커/PTP서버/Docker 재시작 버튼이 서로를
 * 캐스케이드하도록 바뀐 것과 짝)를 구분해 "내가 안 눌렀는데 왜 재시작됐지"에 바로 답할 수 있게 한다.
 */
export function recordRestart(target: RestartTarget, trigger: RestartTrigger) {
  try {
    const entry: RestartHistoryEntry = { at: Date.now(), target, trigger }
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n')
  } catch {
    // 이력 기록 실패로 재시작 자체를 막을 이유는 없다 — 그냥 이번 건만 기록에서 빠진다.
  }
}

export function readRecentRestarts(limit = MAX_ENTRIES): RestartHistoryEntry[] {
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map(l => JSON.parse(l) as RestartHistoryEntry)
  } catch {
    return []
  }
}
