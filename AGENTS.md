<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 검증 루프 (2026-08-23 도입)

- 코드를 고친 뒤에는 `npx tsc --noEmit` && `npm run lint` && `npm run test:unit`를 돌리고, 실패하면
  통과할 때까지 스스로 고쳐서 다시 돌린다 — 사용자가 매번 "에러났어"라고 알려주지 않아도 되게 한다.
- 외부에서 오는 데이터(API 요청 바디, 외부 몰 응답, 사용자 입력 등 이 코드가 형태를 강제할 수 없는 것)를
  다루는 새 코드에는 `as {...}` 타입 캐스팅 대신 Zod 스키마로 실제 형태를 검증한다
  (`app/api/scrape/exact-total/route.ts`가 예시 — 기존 라우트를 전부 이 방식으로 바꾸는 건 별도 작업이라
  손대는 라우트에서만 점진적으로 적용).
- 순수 함수(외부 상태에 안 의존하는 로직)를 새로 만들 때는 예시 몇 개짜리 테스트(`tests/unit/*.test.ts`)
  뿐 아니라, 지켜야 할 규칙을 정의하는 fast-check 기반 속성 테스트(`tests/unit/*.property.test.ts`)도
  함께 고려한다 — 사람이 떠올리지 못한 극단값(빈 문자열, 유니코드, 아주 큰/작은 수 등)을 기계가 대신
  찾아준다. `tests/unit/scraper.property.test.ts` 참고.
- 이 프로젝트는 같은 기능이 여러 실행 경로/모드로 나뉜 곳이 많다 — 일반모드(서버 자동화) vs
  개발자모드(브라우저 확장), PTP 서버 파이프라인 vs `extension-poc`, AI모드 vs 규칙기반 등. 버그를
  고치거나 로직을 바꿀 때는 그 함수/라우트/컴포넌트를 호출하는 다른 곳도 함께 grep해서 같은 문제가
  있는지, 이번 수정이 그쪽에도 필요한지(또는 반대로 그쪽엔 적용하면 안 되는지) 구현 전에 확인하고, 확인
  결과를 커밋 메시지나 사용자 보고에 명시한다 — "이건 A 모드만 고친 거고 B 모드는 어떻게 되나요?"를
  사용자가 매번 되물어야 하는 일이 없게 한다(2026-08-29, 카테고리 캐시 덮어쓰기 버그를 개발자모드 사례로만
  보고 고쳤다가 사용자가 "일반모드는?"이라고 재차 확인해야 했음 — 실제로는 모드 무관 공용 로직이라 이미
  둘 다 적용돼 있었지만, 그걸 스스로 먼저 확인해서 알려줬어야 했다).
- **모듈 스코프에서 "이 프로세스당 한 번만 실행돼야 하는" 부작용(`setInterval` 등록, 백그라운드 감시자
  시작 등)은 반드시 `lib/onceGlobally.ts`의 `ensureStartedOnce(key, fn)`를 쓴다 — `let started = false`
  같은 일반 모듈 변수로 직접 짜지 않는다.** 이유: Next.js dev 서버는 API 라우트를 온디맨드로 따로
  컴파일하는데, 이 과정에서 공유 서버 모듈이 같은 프로세스 안에서 여러 번 다시 평가될 수 있어, 일반
  변수 가드는 그때마다 리셋돼 `setInterval`이 계속 쌓인다(2026-09-07, `lib/scheduler.ts`의 60초
  스케줄러가 여러 개 겹쳐 돌며 DB 커넥션 풀을 소모해 무관한 쿼리까지 타임아웃 내던 사고 — 이 프로젝트에서
  같은 클래스의 사고가 이미 6번 났었다: siteLocks/keepAwake/devPreviewStatus/profileAbortControllers/
  categoryDiscoveryAbortControllers/instrumentation.ts). `tests/unit/onceGloballyGuard.test.ts`가 검증
  루프에서 이걸 자동으로 강제한다 — `setInterval`이 있는 파일에 `ensureStartedOnce`가 같이 없으면
  테스트가 실패한다(정말 예외가 필요하면 파일에 `// onceGloballyGuard: exempt` 주석과 이유를 남긴다).

# 응답 방식 (2026-09-08 도입)

- 사용자가 수정이 필요해 보이는 부분을 얘기하면, 진단 → 계획 → (코드 수정/명령 실행) → 결과 확인을
  거치는 동안 중간중간 짧은 진행 메모를 남기는 것과는 별개로, 답변 마지막에는 이번 턴에서 실제로
  무엇을 확인했고 무엇을 고쳤는지, 다음에 사용자가 뭘 하면 되는지를 전체적으로 한 번에 모아 정리해서
  보여준다 — 중간에 나온 도구 호출/코드 조각을 사용자가 일일이 따라가며 진행상황과 결과를 스스로
  재구성하지 않아도 되게 한다(2026-09-08, 중간중간 답을 추적해서 진행사항과 결과를 확인하기 어렵다는
  피드백).
