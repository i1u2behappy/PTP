# 서버 자동재시작 후 새 프로세스의 로그가 끊기는 문제

## 배경

메모리 임계치 자동재시작(`!specifications/scrape-memory-orphan-cleanup-and-concurrency-mode.md`) 이후,
멀쩡히 떠 있던 서버가 한참 뒤 조용히 죽어있는 사고가 있었다(2026-08-10) — 원인을 보려 했지만
`.dev-server.log`가 그 재시작 시점 이후로 전혀 갱신되지 않아 아무 기록도 없었다.

## 원인

`lib/systemRestart.ts`의 `restartPtpServer()`가 재기동 스크립트 마지막 단계에서 새 서버를
`Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:clean' ... -WindowStyle Hidden`로
띄우는데, 표준출력/에러를 어디로도 리다이렉트하지 않았다 — 수동으로 `npm run dev > .dev-server.log`로
띄운 최초 프로세스는 로그가 남지만, 이후 자동재시작으로 교체된 프로세스부터는 출력이 숨겨진 콘솔
창 안에 갇혀 아무도 못 보게 된다.

## 수정

cmd.exe 자체의 리다이렉션으로 `.dev-server.log`에 이어서(`>>`) 계속 쌓도록 인자를 바꿨다 — 재시작
전후 기록이 끊기지 않는다.

```diff
- Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:clean' -WorkingDirectory '${cwd}' -WindowStyle Hidden
+ Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:clean >> ".dev-server.log" 2>&1' -WorkingDirectory '${cwd}' -WindowStyle Hidden
```

이 함수는 수동 재시작 버튼(`app/api/system/restart-server/route.ts`)과 자동재시작(`lib/scheduler.ts`)이
공유하므로, 이 한 곳만 고치면 양쪽 다 적용된다.

별개로, 매일 새벽 4시 자동재시작 스크립트(`scripts/start-dev-server.cmd`)는 원래부터 로그를 남기고
있었지만 `>`(덮어쓰기)를 써서 매일 그 전 기록이 사라진다 — 이번 수정 대상은 아니라 손대지 않았다.

## 관련 파일

- `lib/systemRestart.ts`: `restartPtpServer()`의 재기동 스크립트에 로그 리다이렉션 추가.

## 상태

**구현 완료.** tsc/eslint 클린. 실제 재시작으로는 검증하지 않았다(방금 복구된 서버를 다시 죽여서
테스트하고 싶지 않았음) — 다음 자동/수동 재시작 때 자연스럽게 확인될 예정.
