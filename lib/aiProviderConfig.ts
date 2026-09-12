/**
 * "사용자가 체크한 AI 공급자"를 DB 한 줄로 저장/조회하고, lib/aiProviderGate.ts의 관문에 공급한다.
 *
 * 왜 DB인가 (2026-09-12, 사용자 지적 — "저 체크 기능은 왜 만든건데?"):
 * 이 선택은 원래 components/panels/ScraperPanel.tsx의 React state로만 존재해서, "몰 구조분석" 버튼이
 * 보내는 그 요청 하나에만 실려 갔다. 그래서 같은 앱 안에서도 카테고리 불러오기·정렬옵션 확인·허브
 * 펼치기·개발자모드 확장·스케줄러 자동실행은 사용자의 선택을 **알 방법 자체가 없었고**, 체크를 꺼도
 * 그 AI를 계속 불렀다. 서버에 저장해야 모든 경로가 같은 값을 본다.
 *
 * 왜 라우트마다 배선하지 않는가:
 * 진입점마다 "설정을 읽어서 넘기는" 코드를 요구하면 그걸 빠뜨린 경로가 조용히 새는 실패 모드가 다시
 * 생긴다(그게 정확히 네 번 반복된 사고다 — aiProviderGate.ts 주석). 그래서 관문이 직접 이 값을 보게 하고,
 * 진입점은 아무것도 기억하지 않아도 되게 한다. 이 모듈을 각 프로세스에서 한 번 import하기만 하면 된다
 * (워커: worker/index.ts, Next.js: instrumentation.ts).
 *
 * 관문(isAiProviderEnabled)은 동기 함수라 await를 할 수 없으므로, 값은 캐시에 들고 있고 갱신은 관문이
 * 조회될 때 백그라운드로(fire-and-forget) 일어난다 — TTL로 자체 제한하므로 호출이 아무리 잦아도 DB
 * 조회는 TTL당 한 번이다. setInterval을 쓰지 않는 이유이기도 하다(AGENTS.md의 ensureStartedOnce 규칙이
 * 요구하는 전역 가드가 필요 없어진다).
 */
import pool from './db'
import { ALL_AI_PROVIDERS, registerAiProviderDefaultSource, type AiProviderId } from './aiProviderGate'

/** 저장된 값이 이만큼 지나면 다음 조회 때 백그라운드로 다시 읽는다. 체크박스를 바꾼 뒤 다른 경로(워커
 *  등 별도 프로세스)에 반영되기까지의 최대 지연이기도 하므로 짧게 잡는다. */
const CACHE_TTL_MS = 5_000

declare global {
  var __aiProviderConfigLoadedAt: number | undefined
  var __aiProviderConfigLoading: Promise<AiProviderId[]> | undefined
}

function isValid(id: unknown): id is AiProviderId {
  return typeof id === 'string' && (ALL_AI_PROVIDERS as string[]).includes(id)
}

/** DB 값이 무엇이든(손으로 넣은 값, 예전 스키마 등) 항상 유효한 공급자 목록으로 정규화한다. */
function normalize(raw: unknown): AiProviderId[] {
  if (!Array.isArray(raw)) return [...ALL_AI_PROVIDERS]
  const seen = raw.filter(isValid)
  return ALL_AI_PROVIDERS.filter(id => seen.includes(id))
}

async function loadFromDb(): Promise<AiProviderId[]> {
  const res = await pool.query<{ providers: unknown }>(`SELECT providers FROM ai_provider_config WHERE id=1`)
  // 아직 한 번도 저장한 적이 없으면 전부 허용 — 기존 동작(체크박스 도입 전)과 같다.
  const providers = res.rows.length ? normalize(res.rows[0].providers) : [...ALL_AI_PROVIDERS]
  registerAiProviderDefaultSource(new Set(providers), requestRefresh)
  globalThis.__aiProviderConfigLoadedAt = Date.now()
  return providers
}

function isStale(): boolean {
  const at = globalThis.__aiProviderConfigLoadedAt
  return at === undefined || Date.now() - at > CACHE_TTL_MS
}

/** 관문이 조회될 때마다 불린다 — 캐시가 신선하거나 이미 읽는 중이면 아무것도 안 한다(동기, 즉시 반환). */
function requestRefresh(): void {
  if (!isStale() || globalThis.__aiProviderConfigLoading) return
  globalThis.__aiProviderConfigLoading = loadFromDb()
    // DB가 잠깐 안 될 때 관문이 터지면 안 된다 — 실패하면 직전 캐시(없으면 전부 허용)를 그대로 쓴다.
    .catch(() => globalThis.__aiProviderDefault ? [...globalThis.__aiProviderDefault] : [...ALL_AI_PROVIDERS])
    .finally(() => { globalThis.__aiProviderConfigLoading = undefined })
}

/** 저장된 선택을 읽는다(필요하면 DB까지 기다린다) — 화면/라우트가 현재 설정을 보여줄 때 쓴다. */
export async function getEnabledAiProviders(): Promise<AiProviderId[]> {
  if (!isStale() && globalThis.__aiProviderDefault) return ALL_AI_PROVIDERS.filter(id => globalThis.__aiProviderDefault!.has(id))
  return (await (globalThis.__aiProviderConfigLoading ?? loadFromDb())).slice()
}

/** 사용자가 체크박스를 바꿨을 때 저장한다 — 저장 즉시 이 프로세스의 캐시도 갱신한다(다른 프로세스는
 *  CACHE_TTL_MS 안에 따라온다). */
export async function setEnabledAiProviders(providers: readonly AiProviderId[]): Promise<AiProviderId[]> {
  const normalized = normalize([...providers])
  await pool.query(
    `INSERT INTO ai_provider_config (id, providers, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET providers = EXCLUDED.providers, updated_at = NOW()`,
    [JSON.stringify(normalized)],
  )
  registerAiProviderDefaultSource(new Set(normalized), requestRefresh)
  globalThis.__aiProviderConfigLoadedAt = Date.now()
  return normalized
}

/**
 * 이 프로세스의 관문에 "저장된 선택"을 공급하기 시작한다 — 프로세스 시작 파일에서 한 번 부르면 된다.
 * 첫 조회를 기다리지 않는다(부팅을 막지 않기 위해) — 첫 DB 조회가 끝나기 전까지는 전부 허용이다.
 */
export function startAiProviderConfigSync(): void {
  registerAiProviderDefaultSource(globalThis.__aiProviderDefault ?? null, requestRefresh)
  requestRefresh()
}
