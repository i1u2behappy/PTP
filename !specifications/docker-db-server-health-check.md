# Docker/DB/PTP 서버 상태 확인 + 재시작 버튼

## 배경
Docker Desktop이 꺼져 Postgres 컨테이너가 죽으면 로그인부터 모든 기능이 원인 불명의 "확인 실패: 500"으로
실패한다(2026-07-25 실제 발생 — Docker Desktop 자체가 꺼져있었음). 사용자가 매번 원인을 추적할 필요 없이,
화면에서 바로 알아채고 버튼 한 번으로 복구할 수 있게 만들었다.

## 구성
- `app/api/health/db/route.ts` — DB 연결 확인용 공개 엔드포인트. `pg.Pool`엔 기본 타임아웃이 없어
  Docker Desktop이 아직 안정화되지 않은 상태(WSL2 네트워킹)에서 연결이 에러 없이 그냥 몇 분씩 멈추는
  경우가 실제로 있었다 — 그래서 쿼리에 3초 타임아웃을 걸어 무조건 빨리 `{ok:false}`로라도 응답한다.
- `app/api/system/restart-docker/route.ts` — Docker Desktop 실행파일을 `spawn(detached, unref)`로 띄운다.
  컨테이너는 `unless-stopped` 정책으로 Docker Desktop이 뜨면 자동으로 따라 올라온다.
- `app/api/system/restart-server/route.ts` — PTP 서버(Next dev) 자체를 강제 재시작. **반드시
  `npm run dev:clean`(.next 삭제 후 기동)으로 재기동한다** — 과거에 강제종료 방식이 `.next` 캐시를 깨뜨려
  정상 라우트가 404 나던 사고가 있었다([[dev_server_restart_corrupts_cache]] 메모 참고).
  - 이 요청을 처리 중인 프로세스 자신(`process.pid`)을 죽여야 하므로, 죽이기/재기동은 분리된 detached
    cmd 프로세스에 맡긴다: 응답을 먼저 보내고, 1초 뒤 `taskkill /PID <pid> /F`로 포트를 비운 뒤 새로 기동.
  - **`/T`(자식 프로세스까지 정리) 플래그는 쓰지 않는다.** 이 detached cmd 프로세스 자체가 지금 죽이려는
    `process.pid`의 자식으로 생성되므로(Windows는 `detached:true`로도 부모 PID 기록 자체를 못 숨긴다),
    `/T`를 쓰면 taskkill이 재시작 스크립트 자신까지 트리째 죽여버려 재기동이 실행되지 못한다 — 실제로 이
    버그로 서버가 죽은 채 복구되지 않는 것을 확인 후 `/T` 제거로 수정, 재검증 완료(요청 후 약 3초 만에
    정상 복구).
- `components/shell/DbHealthBanner.tsx` — 20초 주기로 `/api/health/db`를 폴링. `fetch` 자체가 실패(네트워크
  에러)하면 "PTP 서버 응답 없음"으로, fetch는 성공했지만 `{ok:false}`면 "DB 연결 실패"로 구분해서 배너와
  재시작 버튼을 다르게 보여준다. 재시작 중엔 폴링을 4초 간격으로 빠르게 전환.
- `proxy.ts` — 위 세 엔드포인트를 공개 경로에 추가. 로그인 화면 자체가 DB 장애로 막힌 상황에서도 배너/버튼이
  동작해야 하기 때문.

## 알려진 한계
PTP 서버가 완전히 다운되어 **새로 페이지를 열 수 없는 상태**에서는 배너 자체가 서버가 주는 페이지 위에서
동작하므로 새로고침/새 탭에서는 감지·재시작이 불가능하다. 이미 열려 있던 탭에서 서버가 중간에 죽는 경우에만
감지 및 재시작 버튼이 동작한다. 사용자가 이 한계를 인지한 상태로 "PTP 내부 배너 확장" 방식을 선택함
(대안이었던 "별도 감시자 프로세스"는 채택하지 않음).
