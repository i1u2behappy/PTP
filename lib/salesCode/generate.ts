import pool from '../db'
import { generateTransformColumns } from '../ai'
import { buildSourceFields, type MallProductRow } from '../transform/generate'

/** 판매관리코드(상품고유코드) 생성 레시피의 한 단계 — Power Query "적용된 단계"/OpenRefine 조작이력처럼
 *  이전 단계 결과(_prev)를 이어받아 순서대로 가공한다. 첫 단계는 sourceField로 원본 컬럼을 읽고,
 *  이후 단계는 sourceField를 비워두면 _prev(직전 결과)를 입력으로 쓴다. */
export type RecipeStepMode = 'rename' | 'combine' | 'ai'

export interface RecipeStep {
  mode: RecipeStepMode
  sourceField?: string
  /** mode='rename' — 원본값 → 변경값. 표에 없는 값은 그대로 통과 */
  entries?: { from: string; to: string }[]
  /** mode='combine' — "{_prev}-{brand}" 형태 템플릿. _prev=직전 단계 결과, 그 외는 원본 필드명 */
  template?: string
  /** mode='ai' — AI에게 주는 지시문. 원본 필드 + _prev를 함께 참고 자료로 준다 */
  instruction?: string
}

function applyRename(step: RecipeStep, prev: string, source: Record<string, unknown>): string {
  const input = step.sourceField ? String(source[step.sourceField] ?? '') : prev
  const entry = step.entries?.find(e => e.from === input)
  return entry ? entry.to : input
}

function applyCombine(step: RecipeStep, prev: string, source: Record<string, unknown>): string {
  const template = step.template || '{_prev}'
  return template.replace(/\{(\w+)\}/g, (_, key: string) => key === '_prev' ? prev : String(source[key] ?? '')).trim()
}

/** siteId×clientId의 저장된 레시피를 상품 하나에 순서대로 적용해 최종 판매관리코드 문자열을 만든다. */
export async function runRecipe(siteName: string, steps: RecipeStep[], mp: MallProductRow): Promise<string> {
  const source = buildSourceFields(mp)
  let value = ''
  for (const step of steps) {
    if (step.mode === 'rename') value = applyRename(step, value, source)
    else if (step.mode === 'combine') value = applyCombine(step, value, source)
    else if (step.mode === 'ai') {
      const result = await generateTransformColumns(siteName, [{ name: '__value__', instruction: step.instruction || '' }], [], { ...source, _prev: value })
      value = result.__value__ ?? value
    }
  }
  return value
}

export async function getRecipe(siteId: number, clientId: number): Promise<RecipeStep[]> {
  const res = await pool.query<{ steps: RecipeStep[] }>(
    'SELECT steps FROM sales_code_recipes WHERE site_id=$1 AND client_id=$2', [siteId, clientId],
  )
  return res.rows[0]?.steps ?? []
}

export async function saveRecipe(siteId: number, clientId: number, steps: RecipeStep[]): Promise<void> {
  await pool.query(
    `INSERT INTO sales_code_recipes (site_id, client_id, steps, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (site_id, client_id) DO UPDATE SET steps=$3, updated_at=NOW()`,
    [siteId, clientId, JSON.stringify(steps)],
  )
}

/** 레시피를 여러 상품에 적용해 코드 draft를 만든다(아직 저장하지 않음 — 미리보기/검토용). */
export async function previewRecipe(siteId: number, clientId: number, mallProductIds: number[]): Promise<{ mallProductId: number; code: string }[]> {
  const [steps, siteRes] = await Promise.all([
    getRecipe(siteId, clientId),
    pool.query<{ name: string | null }>('SELECT name FROM sites WHERE id=$1', [siteId]),
  ])
  const siteName = siteRes.rows[0]?.name || `site-${siteId}`
  if (!steps.length || !mallProductIds.length) return []

  const results: { mallProductId: number; code: string }[] = []
  for (const mallProductId of mallProductIds) {
    const mpRes = await pool.query<MallProductRow>(
      `SELECT id, name_original, price, sale_price, brand, manufacturer, origin, description,
              mall_category, stock_status, stock_qty, options
       FROM mall_products WHERE id = $1`,
      [mallProductId],
    )
    const mp = mpRes.rows[0]
    if (!mp) continue
    results.push({ mallProductId, code: await runRecipe(siteName, steps, mp) })
  }
  return results
}
