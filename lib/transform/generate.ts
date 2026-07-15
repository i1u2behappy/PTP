import pool from '../db'
import { generateTransformColumns, type TransformFewShotExample } from '../ai'
import { migrateToMaster } from '../master/migrate'
import { getGuidePairs } from './matching'

/** product_master 컬럼 중 이 기능이 덮어써도 되는 필드만 허용 (target_field를 그대로 SQL에 꽂아 넣으므로 반드시 화이트리스트를 거친다) */
export const ALLOWED_TARGET_FIELDS = new Set([
  'name_final', 'master_category', 'brand', 'manufacturer', 'origin', 'description',
  'cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost',
  'stock_status', 'stock_qty', 'internal_code', 'sales_code',
])
const NUMERIC_TARGET_FIELDS = new Set(['cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost', 'stock_qty'])

export type RuleMode = 'ai' | 'lookup' | 'copy' | 'composite'

export interface CompositeConfig {
  fields?: string[]
  template?: string
  op?: 'concat' | 'multiply' | 'add'
  factor?: number
}

interface ColumnRule {
  id: number
  column_name: string
  target_field: string | null
  mode: RuleMode
  ai_instruction: string | null
  source_field: string | null
  composite_config: CompositeConfig
}

const SOURCE_FIELD_KEYS = [
  'name_original', 'price', 'sale_price', 'brand', 'manufacturer', 'origin',
  'description', 'mall_category', 'stock_status', 'stock_qty',
] as const

interface MallProductRow {
  id: number
  name_original: string | null
  price: number | null
  sale_price: number | null
  brand: string | null
  manufacturer: string | null
  origin: string | null
  description: string | null
  mall_category: string | null
  stock_status: string | null
  stock_qty: number | null
  options: unknown
}

function buildSourceFields(mp: MallProductRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SOURCE_FIELD_KEYS) out[key] = mp[key]
  out.options = mp.options
  return out
}

async function getColumnRules(siteId: number): Promise<ColumnRule[]> {
  const res = await pool.query<ColumnRule>(
    `SELECT id, column_name, target_field, mode, ai_instruction, source_field, composite_config
     FROM transform_column_rules WHERE site_id = $1 ORDER BY sort_order, id`,
    [siteId],
  )
  return res.rows
}

/** rule_id → (source_value → target_value) */
async function getLookupMap(ruleId: number): Promise<Map<string, string>> {
  const res = await pool.query<{ source_value: string; target_value: string | null }>(
    'SELECT source_value, target_value FROM transform_lookup_entries WHERE rule_id = $1',
    [ruleId],
  )
  return new Map(res.rows.map(r => [r.source_value, r.target_value ?? '']))
}

/** AS-IS/TO-BE 업로드를 몰상품코드로 매칭한 쌍을 few-shot 예시(원본 데이터 → 완성값)로 변환한다. */
async function getFewShotExamples(siteId: number, limit = 8): Promise<TransformFewShotExample[]> {
  const pairs = await getGuidePairs(siteId)
  return pairs.slice(0, limit).map(pair => ({ sourceFields: pair.asIs, targetValues: pair.toBe }))
}

function applyComposite(cfg: CompositeConfig, source: Record<string, unknown>): string {
  const fields = cfg.fields || []
  if (cfg.op === 'multiply' || cfg.op === 'add') {
    const base = Number(source[fields[0]]) || 0
    const factor = cfg.factor ?? 1
    const result = cfg.op === 'multiply' ? base * factor : base + factor
    return String(Math.round(result))
  }
  const template = cfg.template || fields.map(f => `{${f}}`).join(' ')
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(source[key] ?? '')).trim()
}

export interface GenerateResult {
  mallProductId: number
  values: Record<string, string>
}

/** siteId의 컬럼 규칙을 신규 상품들(mallProductIds)에 적용해 값을 생성하고 draft로 저장한다. */
export async function generateForProducts(siteId: number, mallProductIds: number[]): Promise<GenerateResult[]> {
  const [rules, siteRes] = await Promise.all([
    getColumnRules(siteId),
    pool.query<{ name: string | null }>('SELECT name FROM sites WHERE id = $1', [siteId]),
  ])
  const siteName = siteRes.rows[0]?.name || `site-${siteId}`
  const aiRules = rules.filter(r => r.mode === 'ai')
  const lookupRules = rules.filter(r => r.mode === 'lookup')

  const [examples, lookupEntries] = await Promise.all([
    aiRules.length ? getFewShotExamples(siteId) : Promise.resolve([]),
    Promise.all(lookupRules.map(async r => [r.id, await getLookupMap(r.id)] as const)),
  ])
  const lookupMapByRuleId = new Map(lookupEntries)

  const results: GenerateResult[] = []
  for (const mallProductId of mallProductIds) {
    const mpRes = await pool.query<MallProductRow>(
      `SELECT id, name_original, price, sale_price, brand, manufacturer, origin, description,
              mall_category, stock_status, stock_qty, options
       FROM mall_products WHERE id = $1`,
      [mallProductId],
    )
    const mp = mpRes.rows[0]
    if (!mp) continue
    const source = buildSourceFields(mp)
    const values: Record<string, string> = {}

    for (const rule of rules) {
      if (rule.mode === 'copy') {
        values[rule.column_name] = String(source[rule.source_field || ''] ?? '')
      } else if (rule.mode === 'composite') {
        values[rule.column_name] = applyComposite(rule.composite_config || {}, source)
      } else if (rule.mode === 'lookup') {
        const sourceValue = String(source[rule.source_field || ''] ?? '')
        values[rule.column_name] = lookupMapByRuleId.get(rule.id)?.get(sourceValue) ?? ''
      }
      // mode === 'ai'는 아래에서 컬럼당 개별 호출 대신 상품당 1회로 일괄 처리
    }

    if (aiRules.length) {
      const aiValues = await generateTransformColumns(
        siteName,
        aiRules.map(r => ({ name: r.column_name, instruction: r.ai_instruction || '' })),
        examples,
        source,
      )
      Object.assign(values, aiValues)
    }

    await pool.query(
      `INSERT INTO transform_generated_rows (site_id, mall_product_id, generated_values, status, updated_at)
       VALUES ($1, $2, $3, 'draft', NOW())
       ON CONFLICT (site_id, mall_product_id) DO UPDATE SET generated_values = $3, status = 'draft', updated_at = NOW()`,
      [siteId, mallProductId, JSON.stringify(values)],
    )

    results.push({ mallProductId, values })
  }

  return results
}

/** 확정: migrateToMaster로 기본 product_master 행을 확보한 뒤, 매핑된 컬럼만 생성값으로 덮어쓴다. */
export async function commitGeneratedRow(generatedRowId: number, clientId: number): Promise<number> {
  const rowRes = await pool.query<{ site_id: number; mall_product_id: number; generated_values: Record<string, string> }>(
    'SELECT site_id, mall_product_id, generated_values FROM transform_generated_rows WHERE id = $1',
    [generatedRowId],
  )
  const row = rowRes.rows[0]
  if (!row) throw new Error('generated row not found')

  const rules = await getColumnRules(row.site_id)
  const mapped = rules.filter(r => r.target_field && ALLOWED_TARGET_FIELDS.has(r.target_field))

  const { masterIds } = await migrateToMaster([row.mall_product_id], clientId)
  const masterId = masterIds[0]
  if (!masterId) throw new Error('migrateToMaster failed to produce a master id')

  const setClauses: string[] = []
  const params: unknown[] = []
  mapped.forEach(rule => {
    const value = row.generated_values[rule.column_name]
    if (value === undefined) return
    params.push(NUMERIC_TARGET_FIELDS.has(rule.target_field!) ? (value === '' ? null : Number(value)) : value)
    setClauses.push(`${rule.target_field} = $${params.length}`)
  })
  if (setClauses.length) {
    params.push(masterId)
    await pool.query(`UPDATE product_master SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params)
  }

  await pool.query(
    `UPDATE transform_generated_rows SET status = 'committed', product_master_id = $1, updated_at = NOW() WHERE id = $2`,
    [masterId, generatedRowId],
  )
  return masterId
}
