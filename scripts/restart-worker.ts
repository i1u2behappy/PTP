// 브라우저 세션 없이 로컬에서 워커만 재시작한다 — lib/workerRestart.ts의 restartWorker()를 그대로
// 재사용한다(로직을 다시 베끼지 않음). 이 함수는 워커를 process.pid가 아니라 WORKER_PORT를 쥔 프로세스로
// 찾아서 죽이므로(Get-NetTCPConnection), 어느 프로세스에서 불러도 안전하다 — restartPtpServer()(PTP 서버
// 재시작)는 반대로 호출한 프로세스 자신의 process.pid를 죽이는 방식이라 이 스크립트처럼 별개 프로세스에서
// 부르면 엉뚱한 PID를 죽이려다 실패하고 새 서버 인스턴스만 하나 더 띄워 기존 서버와 충돌할 위험이 있어
// (app/api/system/restart-worker/route.ts가 보통 강제하는 "워커+서버 동시 재시작" 중 서버 쪽은) 여기서
// 의도적으로 부르지 않는다. 워커가 낡은 코드를 실행 중인 문제는 워커 자체만 다시 띄우면 해결되고,
// PTP 서버(Next dev)는 이미 자체 HMR로 이 코드 변경분을 알아서 반영한다.
//
// 사용법: node --env-file=.env.local --import tsx ./scripts/restart-worker.ts
// (또는 npm run restart-worker)
import { restartWorker } from '../lib/workerRestart'

restartWorker('manual')
  .then(() => {
    console.log('워커 재시작 요청 완료 — 새 워커가 실제로 뜰 때까지 10~30초(길면 1분 이상) 걸릴 수 있습니다.')
  })
  .catch(err => {
    console.error('워커 재시작 실패:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
