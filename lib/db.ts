import { Pool } from 'pg'

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'scrap',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
})

export default pool

export async function getProductsByIds(ids: number[]) {
  const res = await pool.query(
    `SELECT id, name_original, name_ai, price, sale_price, brand, manufacturer,
            origin, category, description, options, thumbnail_local, detail_images
     FROM products WHERE id = ANY($1::int[])`,
    [ids],
  )
  return res.rows.map(p => ({
    ...p,
    options:       typeof p.options       === 'string' ? JSON.parse(p.options)       : (p.options       || []),
    detail_images: typeof p.detail_images === 'string' ? JSON.parse(p.detail_images) : (p.detail_images || []),
  }))
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scrape_sessions (
      id          SERIAL PRIMARY KEY,
      url         TEXT NOT NULL,
      site_name   TEXT,
      login_id    TEXT,
      status      TEXT DEFAULT 'pending',
      product_count INT DEFAULT 0,
      error       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id              SERIAL PRIMARY KEY,
      session_id      INT REFERENCES scrape_sessions(id) ON DELETE CASCADE,
      source_url      TEXT,

      name_original   TEXT,
      name_ai         TEXT,
      price           INT,
      sale_price      INT,
      brand           TEXT,
      manufacturer    TEXT,
      origin          TEXT,
      category        TEXT,
      description     TEXT,
      options         JSONB DEFAULT '[]',

      thumbnail_url   TEXT,
      thumbnail_local TEXT,
      detail_images   JSONB DEFAULT '[]',

      raw_data        JSONB DEFAULT '{}',
      status          TEXT DEFAULT 'draft',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sites (
      id          SERIAL PRIMARY KEY,
      name        TEXT,
      url         TEXT NOT NULL,
      login_id    TEXT,
      login_pw    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exports (
      id            SERIAL PRIMARY KEY,
      product_ids   INT[],
      marketplace   TEXT,
      file_name     TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `)
}
