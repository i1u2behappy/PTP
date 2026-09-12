/**
 * Next.js 개발서버(`next dev`)가 짧은 간격으로 파일을 반복 저장하면(핫리로드), 어떤 라우트가 참조하는
 * 컴파일된 모듈 청크에 실제 소스에는 멀쩡히 있는 export가 빠진 채로 캐시되는 경우가 있다 — webpack HMR
 * 캐시 불일치. 실사용 확인(2026-09-12): `lib/workerClient.ts`의 `getSiteLockStatus`는 소스에 정상적으로
 * export돼 있는데도, 짧은 시간에 여러 파일을 연속으로 고친 뒤 이 문구로 500이 반복됐다:
 *   "TypeError: (0 , _lib_workerClient__WEBPACK_IMPORTED_MODULE_1__.getSiteLockStatus) is not a function"
 *
 * 이 프로젝트는 AGENTS.md 검증 루프에 따라 커밋 전 항상 `tsc --noEmit`을 통과시킨다 — 즉 타입이 맞는
 * 채로 커밋된 코드에서 "실제로 존재하는 import가 함수가 아니다/정의되지 않았다"는 애플리케이션 버그일
 * 수 없다(정적으로 존재가 보장된 심볼이다). 이런 신호가 나타난다면 원인은 오직 이미 떠 있는 프로세스의
 * 컴파일된 상태가 소스와 어긋난 것뿐이고, 그 요청을 아무리 다시 보내도(사용자가 "다시 시도"를 눌러도)
 * 절대 풀리지 않는다 — 서버(정확히는 이 Next.js 프로세스)를 재시작해 새로 컴파일하는 것만이 유일한
 * 해법이다. instrumentation.ts의 onRequestError가 이 신호를 감지해 사람이 알아채기 전에 자동으로
 * 재시작하는 데 쓴다(사용자 지시, 2026-09-12 — "이러한 일이 반복되지 않게 해").
 *
 * `__WEBPACK_IMPORTED_MODULE_<n>__`는 webpack이 만드는 내부 변수명이라, 일반 애플리케이션 코드의 에러
 * 메시지에는 절대 등장하지 않는다 — 이 패턴 자체가 "컴파일된 모듈 참조가 깨졌다"는 신뢰도 높은 지문이다.
 */
const STALE_COMPILE_ERROR_RE = /__WEBPACK_IMPORTED_MODULE_\d+__[^\n]*?\bis not a function\b|__WEBPACK_IMPORTED_MODULE_\d+__ is not defined\b/

export function looksLikeStaleCompileError(message: string | undefined | null): boolean {
  if (!message) return false
  return STALE_COMPILE_ERROR_RE.test(message)
}
