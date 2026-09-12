/**
 * "사용자가 화면에서 체크한 AI만 쓴다"를 **빠뜨릴 수 없게** 강제하는 관문.
 *
 * 왜 필요한가 (2026-09-12, 사용자 지적 — "저 체크 기능은 왜 만든건데?"):
 * 원래 설계는 2026-09-02부터 명확했다 — "엔트로픽/제미나이/올라마 체크해서 쓰게 해달라"(lib/ai.ts 상단
 * 주석). 그런데 구현은 `aiProviders: AiProviderId[]`를 호출 체인마다 **인자로 손수 전달하고, 각 호출부가
 * 알아서 includes()로 확인하는** 방식이었다. 그래서 새 AI 호출부를 추가할 때마다 "인자 넘기는 걸 깜빡할
 * 기회"가 같이 생겼고, 실제로 같은 사고가 네 번 났다:
 *   1) 리포트 생성(generateMallProfileReportOllama)
 *   2) 카테고리 이상탐지(detectCategoryAnomalyOllama)
 *   3) 허브 확장 폴백(expandCategoryHubs, 2026-09-03)
 *   4) 화면인식 3종(detectSortOptionsFromScreenshot / detectCategoryMenuTriggerFromScreenshot /
 *      detectVisibleCategoryGroupCount, 2026-09-12) — 공급자 인자 자체가 없어 체크를 끈 채로도 계속
 *      로컬 Ollama를 불러 CPU를 붙잡았다.
 * 네 번 다 "그 파일 하나만" 고쳤기 때문에 다섯 번째가 날 수밖에 없는 구조였다.
 *
 * 그래서 방식을 뒤집는다 — **넘길 인자를 없앤다.** 선택값은 요청 단위 컨텍스트(AsyncLocalStorage)로
 * 흐르고, 실제로 외부 AI를 호출하는 함수는 전부 isAiProviderEnabled()를 먼저 통과해야 한다. 호출 체인
 * 중간 함수들은 이 값을 알 필요도, 넘길 필요도 없으므로 "깜빡함"이라는 실패 모드 자체가 사라진다.
 * tests/unit/aiProviderGate.test.ts가 이걸 검증 루프에서 자동으로 강제한다 — lib/ai.ts에 관문을 안 거치는
 * 새 AI 호출이 생기면 테스트가 깨진다.
 *
 * AsyncLocalStorage를 globalThis에 담는 이유는 lib/onceGlobally.ts와 같다 — Next.js dev 서버가 공유 서버
 * 모듈을 같은 프로세스 안에서 여러 번 다시 평가할 수 있어, 모듈 스코프 인스턴스를 그냥 쓰면 컨텍스트를
 * 세팅한 쪽과 읽는 쪽이 서로 다른 AsyncLocalStorage를 보게 되어 선택값이 조용히 사라진다.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 화면 체크박스와 1:1로 대응하는 AI 공급자 — 순서가 그대로 체크박스 순서이자 폴백 시도 순서다.
 *  lib/ai.ts가 이 둘을 그대로 re-export하므로 기존 import 경로(`from './ai'`)는 바뀌지 않는다. */
export type AiProviderId = 'anthropic' | 'gemini' | 'groq' | 'ollama'
export const ALL_AI_PROVIDERS: AiProviderId[] = ['anthropic', 'gemini', 'groq', 'ollama']

declare global {
  var __aiProviderStore: AsyncLocalStorage<ReadonlySet<AiProviderId>> | undefined
  var __aiProviderDefault: ReadonlySet<AiProviderId> | null | undefined
  var __aiProviderRefresh: (() => void) | null | undefined
}

function store(): AsyncLocalStorage<ReadonlySet<AiProviderId>> {
  return globalThis.__aiProviderStore ?? (globalThis.__aiProviderStore = new AsyncLocalStorage())
}

/**
 * 컨텍스트가 없을 때 쓸 "저장된 사용자 선택"을 등록한다 — lib/aiProviderConfig.ts가 DB에서 읽어 채운다.
 *
 * 이게 있어야 라우트마다 runWithAiProviders를 배선하지 않아도 된다. 배선을 요구하면 "배선을 빠뜨린
 * 경로가 조용히 새는" 실패 모드를 다시 만드는 셈인데, 그게 정확히 이 파일이 없애려는 문제다. 그래서
 * 관문이 직접 저장된 값을 보게 하고, 진입점은 아무것도 기억할 필요가 없게 한다.
 *
 * 이 모듈은 DB를 직접 모른다(주입받는다) — 그래야 테스트가 DB 없이 관문 로직만 검증할 수 있다.
 * requestRefresh는 관문이 조회될 때마다 불리므로, 구현 쪽에서 TTL로 자체 제한해야 한다.
 */
export function registerAiProviderDefaultSource(
  snapshot: ReadonlySet<AiProviderId> | null,
  requestRefresh?: () => void,
): void {
  globalThis.__aiProviderDefault = snapshot
  if (requestRefresh !== undefined) globalThis.__aiProviderRefresh = requestRefresh
}

/** 현재 적용 중인 기본값(저장된 선택). 아직 안 읽혔으면 null — 그 경우 전부 허용이 기존 동작이다. */
export function currentAiProviderDefault(): ReadonlySet<AiProviderId> | null {
  return globalThis.__aiProviderDefault ?? null
}

/** 컨텍스트도 저장값도 없을 때 적용되는 집합을 돌려주고, 저장값 갱신을 비동기로 부추긴다. */
function fallbackSet(): ReadonlySet<AiProviderId> | null {
  globalThis.__aiProviderRefresh?.()
  return globalThis.__aiProviderDefault ?? null
}

/**
 * 이 작업(그리고 그 안에서 파생되는 모든 비동기 호출) 동안 쓸 수 있는 AI 공급자를 고정한다.
 * 진입점 한 곳에서만 부르면 그 아래 호출 체인 전체에 자동으로 전파된다 — 중간 함수에 인자를 넘길 필요가
 * 없다는 게 이 설계의 핵심이다.
 */
export function runWithAiProviders<T>(providers: readonly AiProviderId[], fn: () => T): T {
  return store().run(new Set(providers), fn)
}

/**
 * 이 공급자를 지금 써도 되는지 — 이 파일에서 실제로 외부 AI를 호출하는 모든 함수가 맨 앞에서 통과해야
 * 하는 관문. 판단 순서:
 *   1) runWithAiProviders로 명시된 컨텍스트가 있으면 그것(예: "몰 구조분석" 버튼이 보낸 그 실행의 선택)
 *   2) 없으면 DB에 저장된 사용자 선택(registerAiProviderDefaultSource가 채움)
 *   3) 그것도 아직 없으면 전부 허용 — 설정을 못 읽었다고 AI가 전부 꺼지면 그게 더 큰 회귀다.
 */
export function isAiProviderEnabled(id: AiProviderId): boolean {
  const enabled = store().getStore() ?? fallbackSet()
  return enabled ? enabled.has(id) : true
}

/** 지금 허용된 공급자 목록(ALL_AI_PROVIDERS 순서 유지) — 폴백 체인을 도는 쪽에서 쓴다. */
export function enabledAiProviders(): AiProviderId[] {
  const enabled = store().getStore() ?? fallbackSet()
  return enabled ? ALL_AI_PROVIDERS.filter(id => enabled.has(id)) : [...ALL_AI_PROVIDERS]
}
