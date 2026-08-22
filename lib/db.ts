import { Pool } from 'pg'
import crypto from 'crypto'
import { hashPassword } from './auth'
import { FIXED_FIELD_INFO } from './master/schema'

const pool = new Pool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'scrape',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  // DB가 잠깐 안 닿을 때(Docker 재시작, 네트워크 문제 등) 무한정 멈추는 대신 몇 초 안에 에러로 실패하게 한다.
  connectionTimeoutMillis: 5000,
  // PC가 절전모드로 들어가면 이 풀에 남아있던 기존 연결이 "좀비"가 된다 — Node 프로세스가 멈춰있는 동안
  // WSL2/Docker 네트워크 쪽에서는 연결이 끊겨도, 다시 켰을 때 Node는 그걸 모른 채 그대로 재사용하려
  // 한다(실사용 확인: PC를 안 쓰다가 다시 켜면 "도커 재시작" 배너가 뜨는데, Docker/Postgres 자체는
  // 멀쩡했다). idleTimeoutMillis 기본값(10초)은 Node가 실행 중일 때만 흐르는 타이머라 절전 중엔 사실상
  // 멈춰있어 못 믿는다 — keepAlive로 좀비가 되기 전에 OS가 먼저 끊어주게 하고, query_timeout으로 그래도
  // 좀비를 붙잡으면 무한정 멈추는 대신 몇 초 안에 에러로 실패해 풀에서 제거되게 한다(이 두 가지가 없으면
  // 앱 전체 어디서든 쿼리가 영원히 멈출 수 있었다 — 지금까지는 우연히 상태확인 화면 자체의 3초 타임아웃
  // 덕에 "도커 재시작" 배너로만 보였을 뿐).
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  query_timeout: 8_000,
})

// pg Pool은 idle 커넥션이 예기치 않게 끊기면(DB 재시작, 네트워크 단절 등) 'error' 이벤트를 낸다 —
// 리스너가 없으면 Node가 이 이벤트를 uncaughtException으로 취급해 프로세스 전체가 죽는다(pg 공식 문서에
// 명시된 함정). 로그만 남기고 계속 동작하게 해서, DB가 잠깐 끊겨도 서버 프로세스는 살아있게 한다.
pool.on('error', err => {
  console.error('[db] idle client error (연결이 계속 시도됩니다):', err.message)
})

export default pool

// ── 비밀번호 등 민감정보 암복호화 (AES-256-GCM) ──────────────────────────────
const CIPHER_ALGO = 'aes-256-gcm'

function getEncryptionKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex) throw new Error('CREDENTIALS_ENCRYPTION_KEY 환경변수가 필요합니다 (openssl rand -hex 32)')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plain: string): { encrypted: string; iv: string } {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(CIPHER_ALGO, getEncryptionKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { encrypted: enc.toString('base64'), iv: iv.toString('base64') }
}

export function decryptSecret(encrypted: string | null, iv: string | null): string {
  if (!encrypted || !iv) return ''
  const buf = Buffer.from(encrypted, 'base64')
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(0, buf.length - 16)
  const decipher = crypto.createDecipheriv(CIPHER_ALGO, getEncryptionKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// ── 상품마스터 + 이미지 조회 (엑셀 내보내기/마켓 업로드 공용) ──────────────────
export interface RawMasterImage { image_type: string; sort_order: number; storage_path: string }

export interface RawMasterRow {
  id: number
  name_original: string
  name_ai: string | null
  name_final: string | null
  master_category: string | null
  mall_category: string | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  cost_price: number | null
  list_price: number | null
  sale_price: number | null
  shipping_fee: number | null
  other_cost: number | null
  target_margin_rate: number | null
  stock_status: string | null
  stock_qty: number | null
  images: RawMasterImage[]
}

export async function getProductMasterRows(ids: number[]): Promise<RawMasterRow[]> {
  const res = await pool.query(
    `SELECT pm.id, pm.name_original, pm.name_ai, pm.name_final,
            pm.master_category, pm.mall_category, pm.brand, pm.manufacturer, pm.origin, pm.description, pm.options,
            pm.cost_price, pm.list_price, pm.sale_price, pm.shipping_fee, pm.other_cost, pm.target_margin_rate,
            pm.stock_status, pm.stock_qty,
            COALESCE(
              json_agg(json_build_object('image_type', pi.image_type, 'sort_order', pi.sort_order, 'storage_path', pi.storage_path) ORDER BY pi.sort_order)
              FILTER (WHERE pi.id IS NOT NULL), '[]'
            ) AS images
     FROM product_master pm
     LEFT JOIN product_images pi ON pi.product_master_id = pm.id
     WHERE pm.id = ANY($1::int[])
     GROUP BY pm.id`,
    [ids],
  )
  return res.rows.map(r => ({
    ...r,
    options: typeof r.options === 'string' ? JSON.parse(r.options) : (r.options || []),
    images:  typeof r.images  === 'string' ? JSON.parse(r.images)  : (r.images  || []),
  }))
}

// initDb()가 가드 없이 매번 호출부(로그인/사이트 목록 등 여러 라우트)에서 그대로 불려, 요청마다 아래
// 600줄짜리 마이그레이션 전체(ALTER TABLE 수십~수백 개)를 매번 새 트랜잭션으로 다시 실행하고 있었다 —
// 이 트랜잭션이 여러 테이블을 고정된 순서로 잠그는데, 동시에 들어온 다른 요청(예: getCategoryScrapeHistory
// 의 product_master/supply_clients 조회)이 그 반대 순서로 같은 테이블을 잠그면 데드락이 난다(2026-08-21
// 실사용 확인: `/api/sites/1`이 "deadlock detected" 500으로 반복 실패). 프로세스당 한 번만 실제로
// 실행되게 캐시된 Promise로 감싼다 — 매 요청 재검증이 원래도 불필요했다(스키마는 배포 중에만 바뀜).
let initPromise: Promise<void> | null = null
export function initDb(): Promise<void> {
  if (!initPromise) {
    // 실패하면(일시적 DB 연결 문제 등) 캐시를 비워 다음 호출이 처음부터 다시 시도하게 한다 — 그러지
    // 않으면 한 번 실패한 뒤로 이 프로세스가 살아있는 내내 영영 실패한 채로 굳어버린다.
    initPromise = runMigrations().catch(err => { initPromise = null; throw err })
  }
  return initPromise
}

/** 세미콜론으로 구분된 대량 DDL을 문장 단위로 쪼개 각각 별도 쿼리(자동 커밋)로 실행한다 — initDb()의
 *  마이그레이션 전체를 원래처럼 하나의 거대한 트랜잭션(pool.query에 여러 문장을 통째로 넘기면 암묵적
 *  트랜잭션이 됨)으로 실행하면, 그 안에서 여러 테이블을 고정된 순서로 잠근 채 전부 끝날 때까지 놓지
 *  않는다 — 반대 순서로 같은 테이블들을 건드리는 동시 요청(예: getCategoryScrapeHistory의
 *  product_master → supply_clients 조회)과 데드락이 났다(2026-08-21 `/api/sites/{id}`가 "deadlock
 *  detected" 500으로 반복 실패해 실사용 확인 — initDb()를 프로세스당 1회로 캐싱한 뒤에도 재현됨, 즉
 *  근본 원인은 호출 빈도가 아니라 이 트랜잭션 자체의 잠금 범위였다). 문장마다 즉시 커밋되면 한 문장이
 *  잡는 잠금은 그 문장이 끝나는 즉시 풀리므로, 서로 다른 순서로 잠그더라도 겹치는 순간 자체가 극히
 *  짧아져 데드락이 실질적으로 불가능해진다. `$tag$...$tag$` 달러 인용 블록(DO 블록) 안의 세미콜론은
 *  문장 구분자로 보지 않는다 — 문자열 리터럴 안의 세미콜론까지는 다루지 않는데, 이 마이그레이션
 *  SQL에는 없기 때문(있었다면 문장이 잘려 SQL 문법 오류로 즉시 드러난다). */
async function runStatements(sql: string) {
  const statements: string[] = []
  let tag: string | null = null
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (tag === null) {
      if (ch === '$') {
        const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
        if (m) { tag = m[0]; i += m[0].length - 1; continue }
      }
      if (ch === ';') { statements.push(sql.slice(start, i)); start = i + 1 }
    } else if (ch === '$' && sql.startsWith(tag, i)) {
      i += tag.length - 1
      tag = null
    }
  }
  const last = sql.slice(start).trim()
  if (last) statements.push(last)
  for (const stmt of statements) {
    const trimmed = stmt.trim()
    if (trimmed) await pool.query(trimmed)
  }
}

async function runMigrations() {
  // 동적 import로 지연 로드 — scheduler.ts가 이 파일의 pool/decryptSecret을 정적으로 import하므로
  // 최상단에서 바로 import하면 순환참조가 된다. startScheduler()는 자체적으로 1회만 실행되도록 가드한다.
  import('./scheduler').then(m => m.startScheduler()).catch(() => {})

  await runStatements(`
    -- PTP 앱 자체 로그인 계정. 몰 스크래핑 로그인 정보(sites 테이블)와는 별개.
    -- 원래 admin_accounts(단일 관리자 계정)이었다가 권한관리 기능 추가로 다중 사용자 테이블로 확장 —
    -- 기존 DB는 테이블명을 그대로 옮기고, role 컬럼만 새로 얹는다(기존 유일 행은 아래에서 admin으로 지정).
    ALTER TABLE IF EXISTS admin_accounts RENAME TO users;
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    -- role: 'admin'(거래처/Mall 등록·삭제, 스크랩 데이터 삭제 가능) | 'user'(그 외 전부 — admin 권한만 없음).
    -- 신규 가입은 항상 'user'로만 생성된다(권한관리 화면에 role 선택 UI 자체가 없음) — admin은 최초 시드
    -- 계정 하나뿐이라는 전제.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);
    UPDATE users SET role = 'admin' WHERE username = 'admin';

    CREATE TABLE IF NOT EXISTS sites (
      id                         SERIAL PRIMARY KEY,
      name                       TEXT,
      url                        TEXT NOT NULL,
      login_url                  TEXT,
      login_id                   TEXT,
      login_pw_encrypted         TEXT,
      login_pw_iv                TEXT,
      custom_name_selector       TEXT,
      custom_price_selector      TEXT,
      custom_thumbnail_selector  TEXT,
      auto_scrape_enabled        BOOLEAN DEFAULT false,
      auto_scrape_hour           INT,
      last_auto_scrape_date      DATE,
      last_scrape_config         JSONB,
      created_at                 TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS custom_name_selector TEXT;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS custom_price_selector TEXT;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS custom_thumbnail_selector TEXT;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS auto_scrape_enabled BOOLEAN DEFAULT false;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS auto_scrape_hour INT;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_auto_scrape_date DATE;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_scrape_config JSONB;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS login_url TEXT;
    -- 로그인 확인 시점에 몰 상품페이지 구조를 샘플링해 저장하는 기준정보 (이미지/옵션/재고/상세텍스트 구성) — 변경 감지용
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS scrape_profile JSONB;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS scrape_profile_updated_at TIMESTAMPTZ;
    -- Windows Hello/WebAuthn 등 자동화 브라우저로는 통과할 수 없는 로그인 보안을 쓰는 몰 표시용
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS manual_login_required BOOLEAN DEFAULT false;
    -- Mall 등록 시 기입하는 주요 판매 품목 (자유 텍스트)
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS main_items TEXT;
    -- "운영 메모" — 택배사/배송비/계좌 등 이 몰만의 거래정보를 사용자가 직접 기록하는 단일 메모(여러 건
    -- 쌓는 로그가 아니라 항상 최신 값 1개만 유지). Mall 목록의 "메모" 컬럼에 그대로 노출된다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS memo TEXT;
    ALTER TABLE sites ALTER COLUMN name SET NOT NULL;
    -- "스크랩 조정" 기능이 AI로 학습해 저장하는 이 몰 전용 영구 추출 규칙
    -- { [field]: { type: 'label', pattern: string } | { type: 'selector', value: string } }
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS extraction_rules JSONB DEFAULT '{}';
    -- 개발자모드 몰의 "스크랩 조정" 1단계(프롬프트 입력)와 2단계(확장이 페이지 캡처해서 보냄) 사이에
    -- 잠깐 들고 있는 값 — 확장이 캡처를 보내오는 즉시 소비되고 비워진다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS pending_adjustment_prompt TEXT;
    -- 개발자모드 몰은 백엔드가 실제 데이터를 다시 스크랩할 수 없어, 확장이 캡처해온 HTML을 새 규칙으로
    -- 재추출한 "미리보기"만 여기 저장해둔다("개발자모드 재기동"이 이 값을 다시 읽어 화면에 보여준다).
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_adjustment_preview JSONB;
    -- "스크랩 조정 개시" 시점에 화면에 보이던(방금 스크랩한 세션의) 맨 위 상품 id를 같이 저장해둔다 —
    -- 이게 없으면 확장이 "이 몰에서 아무 미확정 상품이나 최신순 1건"을 테스트 대상으로 골라버려서,
    -- 사용자가 지금 보고 있는(방금 스크랩한) 세션이 아니라 다른 세션의 상품을 조정해버릴 수 있었다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS pending_adjustment_item_id INT;
    -- 개발자모드 "상품 페이지 미리보기"의 AI모드 토글 — PTP 화면(일반모드와 같은 자리)에서 켜고 끄지만,
    -- 실제로 그 값을 참고하는 건 확장(별도 실제 크롬 탭)이라 DB에 저장해두고 /api/sites/resolve로 매번
    -- 같이 받아가게 한다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS devmode_ai_preview BOOLEAN NOT NULL DEFAULT false;
    -- 개발자모드에서 "카테고리 불러오기"로 선택한 카테고리 URL 목록 — 일반모드의 categoryUrlsText와 같은
    -- 개념이지만, 확장(별도 실제 크롬 탭)이 나중에 "스크랩 시작"을 누를 때 읽어가야 해서 DB에 저장해두고
    -- /api/sites/resolve로 같이 받아가게 한다(devmode_ai_preview와 같은 이유). 비어있으면(기본값) 기존
    -- 동작 그대로 "지금 탭 위치"만 처리한다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS devmode_category_urls JSONB NOT NULL DEFAULT '[]';
    -- 카테고리별 정렬/상한 그리드 설정(개발자모드) — 프론트 categorySettings 상태와 같은 모양(href →
    -- {sortLabel?, limitMode?, limitValue?})을 가공 없이 그대로 저장한다. devmode_category_urls(순수
    -- href)와 분리해두는 이유: href에 정렬 파라미터를 미리 구워 넣으면 다음 재선택 시 체크박스/그리드
    -- 매칭이 href 문자열 비교로 깨진다 — 정렬은 확장의 run()이 스크랩 시작 순간에만 URL에 반영한다
    -- (사용자 요청, 2026-08-19).
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS devmode_category_settings JSONB NOT NULL DEFAULT '{}';

    -- 카테고리 목록의 "이미 스크랩함" 표시가 이 시각 이후의 완료 세션만 기준으로 삼는다(app/api/scrape/
    -- categories) — 로그인을 다시 하면 이전 로그인 때 완료한 카테고리는 더 이상 참고 대상이 아니라는
    -- 사용자 판단(2026-08-10)에 따른 것. app/api/scrape/login-confirm이 로그인 확인 시점마다 갱신한다.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_login_confirmed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS supply_clients (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      memo                 TEXT,
      business_reg_no      TEXT,
      representative_name  TEXT,
      business_address     TEXT,
      business_type        TEXT,
      business_item        TEXT,
      contact_name         TEXT,
      contact_phone        TEXT,
      contact_email        TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_reg_doc_path TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_reg_doc_name TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS next_internal_seq INT DEFAULT 0;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS auto_internal_code BOOLEAN DEFAULT true;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_reg_no TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS representative_name TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_address TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_type TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS business_item TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS contact_name TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS contact_phone TEXT;
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS contact_email TEXT;
    -- 결제(정산) 계좌 목록 — 한 거래처가 여러 결제자/통장을 등록할 수 있어 배열로 둔다.
    -- [{ payerName, paymentMethod, bankAccount }]
    ALTER TABLE supply_clients ADD COLUMN IF NOT EXISTS payment_accounts JSONB DEFAULT '[]';

    ALTER TABLE sites DROP COLUMN IF EXISTS client_name;
    ALTER TABLE sites DROP COLUMN IF EXISTS client_contact;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS client_id INT REFERENCES supply_clients(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS site_memos (
      id         SERIAL PRIMARY KEY,
      site_id    INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      memo_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='site_memos' AND column_name='memo_date') THEN
        ALTER TABLE site_memos RENAME COLUMN memo_date TO memo_at;
      END IF;
    END $do$;
    ALTER TABLE site_memos ALTER COLUMN memo_at TYPE TIMESTAMPTZ USING memo_at::timestamptz;
    ALTER TABLE site_memos ALTER COLUMN memo_at SET DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS client_memos (
      id         SERIAL PRIMARY KEY,
      client_id  INT NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
      memo_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_memos' AND column_name='memo_date') THEN
        ALTER TABLE client_memos RENAME COLUMN memo_date TO memo_at;
      END IF;
    END $do$;
    ALTER TABLE client_memos ALTER COLUMN memo_at TYPE TIMESTAMPTZ USING memo_at::timestamptz;
    ALTER TABLE client_memos ALTER COLUMN memo_at SET DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS scrape_sessions (
      id            SERIAL PRIMARY KEY,
      url           TEXT NOT NULL,
      site_id       INT REFERENCES sites(id) ON DELETE CASCADE,
      site_name     TEXT,
      login_id      TEXT,
      status        TEXT DEFAULT 'pending',
      product_count INT DEFAULT 0,
      error         TEXT,
      scope_type    TEXT DEFAULT 'all',
      scope_params  JSONB DEFAULT '{}',
      mode          TEXT DEFAULT 'full',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    -- 데이터 마이그 목록의 "선택 병합" — 같은 몰의 세션 여러 개를 하나로 묶어, 다른 메뉴에서 이 중 아무
    -- 세션이나 조회해도(sessionId 파라미터) 병합된 전체가 함께 보이게 한다. 그룹 식별자는 실제 세션 id를
    -- 재사용하지 않고 별도 시퀀스로 발급해, 그룹의 "대표" 세션이라는 개념 없이 모든 멤버를 동등하게 다룬다.
    CREATE SEQUENCE IF NOT EXISTS scrape_session_merge_seq;
    ALTER TABLE scrape_sessions ADD COLUMN IF NOT EXISTS merge_group_id INTEGER;
    ALTER TABLE scrape_sessions ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
    -- 적응형 동시성(scrapeCatalogPage)이 이번 회차에 동시 처리 수를 올리거나(연속 성공) 차단 감지로
    -- 다시 낮춘 시점들을 기록 — 스크래핑 후 "간략히" 확인할 수 있게 세션에 남긴다.
    ALTER TABLE scrape_sessions ADD COLUMN IF NOT EXISTS concurrency_log JSONB DEFAULT '[]';
    -- 완료/중지/오류로 끝난 시각 — created_at과의 차이로 진행 화면에 총 소요시간을 보여준다.
    ALTER TABLE scrape_sessions ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_scrape_sessions_merge_group ON scrape_sessions(merge_group_id) WHERE merge_group_id IS NOT NULL;
    -- Mall 상세관리 목록(GET /api/sites)이 몰마다 "가장 최근 세션" 하나를 LATERAL로 조회하는데,
    -- site_id에 인덱스가 없어 scrape_sessions가 쌓일수록 몰 수만큼 순차 스캔이 반복돼 점점 느려졌다.
    CREATE INDEX IF NOT EXISTS idx_scrape_sessions_site_created ON scrape_sessions(site_id, created_at DESC);

    -- 카탈로그 스크랩 중 상품별 성공/실패 로그 (진행 화면의 실시간 로그 + 실패 재시도 큐 근거)
    CREATE TABLE IF NOT EXISTS scrape_item_log (
      id         SERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES scrape_sessions(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- 진행 화면이 세션당 로그를 계속 폴링(session_id 조회 + id DESC LIMIT)하고, 확장의 "실패 재수집"도
    -- session_id로 join하므로 스크랩량이 쌓일수록 인덱스 없인 점점 느려진다.
    CREATE INDEX IF NOT EXISTS idx_scrape_item_log_session ON scrape_item_log(session_id, id DESC);

    -- 1단계 원천 스크랩 데이터. 몰 상품코드 기준 upsert (증분 재스크랩의 정체성 앵커)
    CREATE TABLE IF NOT EXISTS mall_products (
      id                     SERIAL PRIMARY KEY,
      site_id                INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      mall_product_code      TEXT NOT NULL,
      source_url             TEXT,
      mall_category          TEXT,
      name_original          TEXT,
      price                  INT,
      sale_price             INT,
      brand                  TEXT,
      manufacturer           TEXT,
      origin                 TEXT,
      description            TEXT,
      options                JSONB DEFAULT '[]',
      thumbnail_urls         JSONB DEFAULT '[]',
      detail_image_urls      JSONB DEFAULT '[]',
      stock_status           TEXT,
      stock_qty              INT,
      raw_data               JSONB DEFAULT '{}',
      first_seen_session_id  INT REFERENCES scrape_sessions(id) ON DELETE SET NULL,
      last_seen_session_id   INT REFERENCES scrape_sessions(id) ON DELETE SET NULL,
      last_scraped_at        TIMESTAMPTZ,
      master_product_id      INT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (site_id, mall_product_code)
    );
    -- site_id는 위 UNIQUE(site_id, mall_product_code)가 왼쪽 컬럼이라 이미 인덱스로 커버되지만,
    -- last_seen_session_id로 필터/조인하는 곳(세션 그리드, 상품 목록)은 커버되지 않아 따로 추가.
    CREATE INDEX IF NOT EXISTS idx_mall_products_last_seen_session ON mall_products(last_seen_session_id);

    -- 스크랩 직후 원시 결과 보관소. mall_products를 즉시 덮어쓰지 않고, 사용자가 검토 후 병합할 때까지 대기시킨다.
    -- 같은 상품이 여러 세션에서 스크랩되면 세션마다 별도 행으로 쌓여 세션 간 비교/개별 병합이 가능하다.
    CREATE TABLE IF NOT EXISTS scrape_staging_items (
      id                       SERIAL PRIMARY KEY,
      session_id               INT REFERENCES scrape_sessions(id) ON DELETE CASCADE,
      site_id                  INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      mall_product_code        TEXT NOT NULL,
      source_url               TEXT,
      mall_category            TEXT,
      name_original            TEXT,
      price                    INT,
      sale_price               INT,
      brand                    TEXT,
      manufacturer             TEXT,
      origin                   TEXT,
      description              TEXT,
      options                  JSONB DEFAULT '[]',
      thumbnail_urls           JSONB DEFAULT '[]',
      detail_image_urls        JSONB DEFAULT '[]',
      stock_status             TEXT,
      stock_qty                INT,
      raw_data                 JSONB DEFAULT '{}',
      matched_mall_product_id  INT REFERENCES mall_products(id) ON DELETE SET NULL,
      is_new                   BOOLEAN DEFAULT true,
      is_already_migrated      BOOLEAN DEFAULT false,
      status                   TEXT DEFAULT 'pending',
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    );
    -- "스크랩 Raw 확인 그리드"(session_id/site_id 필터 + created_at 정렬)와 병합/마이그레이션 쪽의
    -- matched_mall_product_id join이 전부 이 테이블을 scan하는데, 스크랩할수록 계속 쌓이는 테이블이라
    -- 인덱스 없인 Mall 상세관리와 똑같은 방식으로 느려진다.
    CREATE INDEX IF NOT EXISTS idx_staging_items_session_status ON scrape_staging_items(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_staging_items_site_created ON scrape_staging_items(site_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_staging_items_matched_mall_product ON scrape_staging_items(matched_mall_product_id);

    -- 재고/가격 변동 이력 (증분 스크랩 diff 근거)
    CREATE TABLE IF NOT EXISTS stock_snapshots (
      id               SERIAL PRIMARY KEY,
      mall_product_id  INT REFERENCES mall_products(id) ON DELETE CASCADE,
      session_id       INT REFERENCES scrape_sessions(id) ON DELETE SET NULL,
      stock_status     TEXT,
      stock_qty        INT,
      price            INT,
      sale_price       INT,
      captured_at      TIMESTAMPTZ DEFAULT NOW()
    );
    -- 가공내역(재고/가격 history)이 mall_product_id로 최근 순 조회되는데, 재스크랩마다 계속 쌓인다.
    CREATE INDEX IF NOT EXISTS idx_stock_snapshots_mall_product ON stock_snapshots(mall_product_id, captured_at DESC);

    -- 가공 시 빈 컬럼을 채우는 참조(이전 완료) 데이터
    CREATE TABLE IF NOT EXISTS reference_products (
      id                 SERIAL PRIMARY KEY,
      site_id            INT REFERENCES sites(id) ON DELETE CASCADE,
      mall_product_code  TEXT,
      match_key          TEXT,
      brand              TEXT,
      manufacturer       TEXT,
      origin             TEXT,
      category           TEXT,
      description        TEXT,
      extra              JSONB DEFAULT '{}',
      source             TEXT,
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    );

    -- 실제 영속 '상품마스터' (3단계 자동 마이그레이션의 목표 테이블)
    CREATE TABLE IF NOT EXISTS product_master (
      id                  SERIAL PRIMARY KEY,
      mall_product_id     INT REFERENCES mall_products(id) ON DELETE SET NULL,
      client_id           INT NOT NULL DEFAULT 1 REFERENCES supply_clients(id),
      name_original       TEXT,
      name_ai             TEXT,
      name_final          TEXT,
      mall_category       TEXT,
      master_category     TEXT,
      brand               TEXT,
      manufacturer        TEXT,
      origin              TEXT,
      description         TEXT,
      options             JSONB DEFAULT '[]',
      cost_price          INT,
      list_price          INT,
      sale_price          INT,
      shipping_fee        INT,
      other_cost          INT,
      target_margin_rate  NUMERIC(5,2),
      stock_status        TEXT,
      stock_qty           INT,
      status              TEXT DEFAULT 'draft',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (mall_product_id, client_id)
    );
    ALTER TABLE product_master ADD COLUMN IF NOT EXISTS internal_code TEXT;
    ALTER TABLE product_master ADD COLUMN IF NOT EXISTS sales_code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS product_master_internal_code_idx ON product_master(internal_code) WHERE internal_code IS NOT NULL;
    -- 판매관리코드 = 이 시스템에서 상품을 관리하는 키값이므로 상품마다 고유해야 한다
    CREATE UNIQUE INDEX IF NOT EXISTS product_master_sales_code_idx ON product_master(sales_code) WHERE sales_code IS NOT NULL;
    -- 거래처별 커스텀 필드(기준 Master DB에서 정의) 값 저장 — { field_key: value }
    ALTER TABLE product_master ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}';

    -- "기준 Master DB" 타깃 필드 목록 — 거래처 구분 없이 시스템 전체가 공유하는 단일 기준 테이블 정의.
    -- 예전엔 client_id로 거래처별로 나눠 가졌으나(client_master_schema_fields), 기준 테이블은 하나만
    -- 두기로 해서 거래처 구분을 없앴다. 이전 테이블은 비어 있었으므로 데이터 이관 없이 바로 교체한다.
    DROP TABLE IF EXISTS client_master_schema_fields;
    CREATE TABLE IF NOT EXISTS master_schema_fields (
      id           SERIAL PRIMARY KEY,
      field_key    TEXT NOT NULL,
      field_label  TEXT NOT NULL,
      is_custom    BOOLEAN NOT NULL DEFAULT true,
      sort_order   INT DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (field_key)
    );

    -- 이미지 레코드 (원본명/정규화명/저장위치)
    CREATE TABLE IF NOT EXISTS product_images (
      id                     SERIAL PRIMARY KEY,
      mall_product_id        INT REFERENCES mall_products(id) ON DELETE CASCADE,
      product_master_id      INT REFERENCES product_master(id) ON DELETE SET NULL,
      image_type             TEXT,
      sort_order             INT DEFAULT 0,
      source_url             TEXT,
      original_file_name     TEXT,
      normalized_file_name   TEXT,
      storage_path           TEXT,
      file_size_bytes        INT,
      created_at             TIMESTAMPTZ DEFAULT NOW()
    );
    -- 상품/마스터 상세, 목록 썸네일, 마이그레이션 화면 전부 mall_product_id 또는 product_master_id +
    -- image_type(+ sort_order 정렬)으로 이 테이블을 조회한다 — 이미지가 계속 쌓이는 테이블이라 필수.
    CREATE INDEX IF NOT EXISTS idx_product_images_mall_product ON product_images(mall_product_id, image_type, sort_order);
    CREATE INDEX IF NOT EXISTS idx_product_images_master ON product_images(product_master_id, image_type, sort_order);

    -- 대표이미지가 여러 장일 수 있도록 단일 thumbnail_url(TEXT)을 배열 thumbnail_urls(JSONB)로 이전.
    -- 기존 값이 있는 행만 1회 백필하고, 이관이 끝나면 옛 컬럼은 지운다 (컬럼이 없으면 이미 이관된 것으로 보고 건너뜀).
    ALTER TABLE mall_products ADD COLUMN IF NOT EXISTS thumbnail_urls JSONB DEFAULT '[]';
    ALTER TABLE scrape_staging_items ADD COLUMN IF NOT EXISTS thumbnail_urls JSONB DEFAULT '[]';
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mall_products' AND column_name='thumbnail_url') THEN
        UPDATE mall_products SET thumbnail_urls = jsonb_build_array(thumbnail_url) WHERE thumbnail_url IS NOT NULL AND thumbnail_url <> '' AND thumbnail_urls = '[]';
        ALTER TABLE mall_products DROP COLUMN thumbnail_url;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scrape_staging_items' AND column_name='thumbnail_url') THEN
        UPDATE scrape_staging_items SET thumbnail_urls = jsonb_build_array(thumbnail_url) WHERE thumbnail_url IS NOT NULL AND thumbnail_url <> '' AND thumbnail_urls = '[]';
        ALTER TABLE scrape_staging_items DROP COLUMN thumbnail_url;
      END IF;
    END $$;

    -- 이미지 호스팅 base-URL 설정. 이 한 줄이 "URL 일괄 편집" 요구사항의 구현 방식
    CREATE TABLE IF NOT EXISTS image_host_config (
      id          SERIAL PRIMARY KEY,
      base_url    TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- 작명 템플릿 (3단계 작명 커스터마이징)
    CREATE TABLE IF NOT EXISTS naming_templates (
      id               SERIAL PRIMARY KEY,
      name             TEXT,
      prompt_template  TEXT,
      max_length       INT DEFAULT 20,
      is_default       BOOLEAN DEFAULT false,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    -- 마켓별 설정 (배치 한도, 수수료 등)
    CREATE TABLE IF NOT EXISTS marketplace_configs (
      id                        SERIAL PRIMARY KEY,
      code                      TEXT UNIQUE NOT NULL,
      name                      TEXT NOT NULL,
      max_batch_size            INT DEFAULT 500,
      default_commission_rate   NUMERIC(5,2) DEFAULT 0.1,
      default_shipping_fee      INT DEFAULT 3000,
      template_mapping          JSONB DEFAULT '{}',
      updated_at                TIMESTAMPTZ DEFAULT NOW()
    );

    -- 내부 카테고리(master_category) ↔ 채널별(마켓별) 카테고리 값 매핑
    CREATE TABLE IF NOT EXISTS category_channel_mappings (
      id                       SERIAL PRIMARY KEY,
      master_category          TEXT NOT NULL,
      marketplace_code         TEXT NOT NULL REFERENCES marketplace_configs(code),
      channel_category_value   TEXT,
      updated_at               TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (master_category, marketplace_code)
    );

    -- 채널(마켓)별 등록용 상품명/URL — 엑셀 생성 시점에만 임시로 만들어지던 것을 미리보기/수정 가능하게 저장
    CREATE TABLE IF NOT EXISTS product_channel_listings (
      id                  SERIAL PRIMARY KEY,
      product_master_id   INT NOT NULL REFERENCES product_master(id) ON DELETE CASCADE,
      marketplace_code    TEXT NOT NULL REFERENCES marketplace_configs(code),
      channel_name        TEXT,
      channel_url         TEXT,
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (product_master_id, marketplace_code)
    );

    CREATE TABLE IF NOT EXISTS exports (
      id            SERIAL PRIMARY KEY,
      product_ids   INT[],
      marketplace   TEXT,
      file_name     TEXT,
      batch_count   INT DEFAULT 1,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- 5단계(오픈마켓 API 연동) — 이번 라운드는 설계만, 소비하는 코드 없음
    CREATE TABLE IF NOT EXISTS marketplace_credentials (
      id                         SERIAL PRIMARY KEY,
      client_id                  INT REFERENCES supply_clients(id) ON DELETE CASCADE,
      marketplace_code           TEXT REFERENCES marketplace_configs(code),
      credential_data_encrypted  TEXT,
      credential_iv              TEXT,
      is_active                  BOOLEAN DEFAULT true,
      created_at                 TIMESTAMPTZ DEFAULT NOW(),
      updated_at                 TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS registration_jobs (
      id                  SERIAL PRIMARY KEY,
      marketplace_code    TEXT,
      client_id           INT REFERENCES supply_clients(id) ON DELETE CASCADE,
      product_master_ids  INT[],
      status              TEXT DEFAULT 'pending',
      result              JSONB,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE mall_products DROP CONSTRAINT IF EXISTS mall_products_master_product_id_fkey;
    ALTER TABLE mall_products ADD CONSTRAINT mall_products_master_product_id_fkey
      FOREIGN KEY (master_product_id) REFERENCES product_master(id) ON DELETE SET NULL;

    -- 마이그레이션2_Transform: 몰별 AS-IS(원본)/TO-BE(완성본) 샘플 업로드 — 헤더/컬럼 구성이 몰마다 달라 JSONB로 보관
    CREATE TABLE IF NOT EXISTS transform_reference_uploads (
      id              SERIAL PRIMARY KEY,
      site_id         INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      file_name       TEXT,
      column_headers  JSONB NOT NULL DEFAULT '[]',
      code_column     TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE transform_reference_uploads ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'to_be';

    -- 완성본 원본 행. mall_product_code로 mall_products와 매칭해 few-shot 예시(원본→완성값 쌍)를 만든다
    CREATE TABLE IF NOT EXISTS transform_reference_rows (
      id                       SERIAL PRIMARY KEY,
      upload_id                INT NOT NULL REFERENCES transform_reference_uploads(id) ON DELETE CASCADE,
      mall_product_code        TEXT,
      row_values               JSONB NOT NULL DEFAULT '{}',
      matched_mall_product_id  INT REFERENCES mall_products(id) ON DELETE SET NULL
    );
    -- Transform 업로드 매칭(lib/transform/matching.ts)이 upload_id로 반복 조회한다.
    CREATE INDEX IF NOT EXISTS idx_transform_reference_rows_upload ON transform_reference_rows(upload_id);

    -- 컬럼별 생성 규칙 (몰 단위). target_field는 이 값이 최종 반영될 product_master 컬럼명
    CREATE TABLE IF NOT EXISTS transform_column_rules (
      id                  SERIAL PRIMARY KEY,
      site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      column_name         TEXT NOT NULL,
      sort_order          INT DEFAULT 0,
      target_field        TEXT,
      mode                TEXT NOT NULL DEFAULT 'ai',
      ai_instruction      TEXT,
      source_field        TEXT,
      composite_config    JSONB DEFAULT '{}',
      UNIQUE (site_id, column_name)
    );

    -- mode='lookup' 규칙의 원본값→완성값 조회표 (카테고리매핑 그리드와 동일한 편집 UI 재사용)
    CREATE TABLE IF NOT EXISTS transform_lookup_entries (
      id             SERIAL PRIMARY KEY,
      rule_id        INT NOT NULL REFERENCES transform_column_rules(id) ON DELETE CASCADE,
      source_field   TEXT NOT NULL,
      source_value   TEXT NOT NULL,
      target_value   TEXT,
      UNIQUE (rule_id, source_field, source_value)
    );

    -- 신규 스크래핑 상품에 대해 생성한 값의 검토/확정 스냅샷
    CREATE TABLE IF NOT EXISTS transform_generated_rows (
      id                  SERIAL PRIMARY KEY,
      site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      mall_product_id     INT NOT NULL REFERENCES mall_products(id) ON DELETE CASCADE,
      product_master_id   INT REFERENCES product_master(id) ON DELETE SET NULL,
      generated_values    JSONB NOT NULL DEFAULT '{}',
      status              TEXT DEFAULT 'draft',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (site_id, mall_product_id)
    );

    -- 판매관리코드(상품고유코드) 생성 레시피 — 몰×거래처 조합 하나당 순차 스텝 배열 하나.
    -- 스텝은 Transform의 rule 개념(rename/조합/AI)을 재사용하되, "TO-BE 컬럼별 규칙(병렬)"이 아니라
    -- "한 값을 순서대로 가공(직렬)"하는 체인이라 steps를 JSONB 배열로 통째로 저장한다(Power Query
    -- Applied Steps / OpenRefine 조작이력과 같은 구조 — !specifications/sales-code-recipe.md 참고).
    CREATE TABLE IF NOT EXISTS sales_code_recipes (
      id          SERIAL PRIMARY KEY,
      site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      client_id   INT NOT NULL REFERENCES supply_clients(id) ON DELETE CASCADE,
      steps       JSONB NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (site_id, client_id)
    );
  `)

  await runStatements(`
    INSERT INTO supply_clients (name)
    SELECT '기본 거래처' WHERE NOT EXISTS (SELECT 1 FROM supply_clients);

    INSERT INTO image_host_config (base_url)
    SELECT '' WHERE NOT EXISTS (SELECT 1 FROM image_host_config);

    INSERT INTO naming_templates (name, prompt_template, max_length, is_default)
    SELECT '기본 템플릿',
           '원본 상품명: {{name}}' || chr(10) || chr(10) ||
           '위 이미지를 보고 오픈마켓(쿠팡, 네이버 등) 등록용 상품명을 한국어로 만들어줘.' || chr(10) ||
           '조건:' || chr(10) ||
           '- 20자 이내' || chr(10) ||
           '- 특수문자 최소화' || chr(10) ||
           '- 핵심 키워드 포함 (소재, 용도, 특징)' || chr(10) ||
           '- 상품명만 출력, 설명 없이',
           20, true
    WHERE NOT EXISTS (SELECT 1 FROM naming_templates);

    INSERT INTO marketplace_configs (code, name, max_batch_size, default_commission_rate, default_shipping_fee)
    VALUES
      ('coupang', '쿠팡 Wing', 500, 0.10, 3000),
      ('naver', '네이버 스마트스토어', 1000, 0.06, 3000),
      ('11st', '11번가', 500, 0.12, 3000),
      ('gmarket', 'G마켓', 500, 0.12, 3000),
      ('auction', '옥션', 500, 0.12, 3000),
      ('shoplinker', '샵링커', 1000, 0, 3000),
      ('sabangnet', '사방넷', 1000, 0, 3000)
    ON CONFLICT (code) DO NOTHING;
  `)

  // 기준 Master 테이블 관리 화면이 빈 그리드로 열리지 않도록, 고정 컬럼 15개를 기본값으로 미리 채워둔다
  // — 사용자가 지워도 상관없고, "기본 컬럼 전체 추가" 버튼으로 언제든 다시 채울 수 있다.
  const schemaFieldCount = await pool.query('SELECT COUNT(*) FROM master_schema_fields')
  if (Number(schemaFieldCount.rows[0].count) === 0) {
    for (const [i, f] of FIXED_FIELD_INFO.entries()) {
      await pool.query(
        `INSERT INTO master_schema_fields (field_key, field_label, is_custom, sort_order) VALUES ($1,$2,false,$3) ON CONFLICT (field_key) DO NOTHING`,
        [f.key, f.label, i],
      )
    }
  }

  const adminCount = await pool.query('SELECT COUNT(*) FROM users')
  if (Number(adminCount.rows[0].count) === 0) {
    const { hash, salt } = hashPassword('admin1234')
    await pool.query(
      "INSERT INTO users (username, password_hash, password_salt, role) VALUES ($1,$2,$3,'admin')",
      ['admin', hash, salt],
    )
    console.warn('[auth] 기본 관리자 계정 생성: admin / admin1234 — 설정 메뉴에서 즉시 변경해주세요.')
  }
}
