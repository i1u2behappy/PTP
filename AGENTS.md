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
