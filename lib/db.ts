import { Pool } from 'pg'
import crypto from 'crypto'
import { hashPassword } from './auth'

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'scrape',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
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

export async function initDb() {
  // 동적 import로 지연 로드 — scheduler.ts가 이 파일의 pool/decryptSecret을 정적으로 import하므로
  // 최상단에서 바로 import하면 순환참조가 된다. startScheduler()는 자체적으로 1회만 실행되도록 가드한다.
  import('./scheduler').then(m => m.startScheduler()).catch(() => {})

  await pool.query(`
    -- PTP 앱 자체 로그인 관리자 계정(단일 계정). 몰 스크래핑 로그인 정보(sites 테이블)와는 별개.
    CREATE TABLE IF NOT EXISTS admin_accounts (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

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
    ALTER TABLE sites ALTER COLUMN name SET NOT NULL;

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
    CREATE INDEX IF NOT EXISTS idx_scrape_sessions_merge_group ON scrape_sessions(merge_group_id) WHERE merge_group_id IS NOT NULL;

    -- 카탈로그 스크랩 중 상품별 성공/실패 로그 (진행 화면의 실시간 로그 + 실패 재시도 큐 근거)
    CREATE TABLE IF NOT EXISTS scrape_item_log (
      id         SERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES scrape_sessions(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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
  `)

  await pool.query(`
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

  const adminCount = await pool.query('SELECT COUNT(*) FROM admin_accounts')
  if (Number(adminCount.rows[0].count) === 0) {
    const { hash, salt } = hashPassword('admin1234')
    await pool.query(
      'INSERT INTO admin_accounts (username, password_hash, password_salt) VALUES ($1,$2,$3)',
      ['admin', hash, salt],
    )
    console.warn('[auth] 기본 관리자 계정 생성: admin / admin1234 — 설정 메뉴에서 즉시 변경해주세요.')
  }
}
