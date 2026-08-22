# initDb() 마이그레이션이 유발한 실사용 데드락 수정

## 배경

2026-08-21 실사용 중 `/api/sites/{id}` 등 여러 라우트가 `"deadlock detected"` 500 에러로 반복
실패했다. 처음엔 `lib/scraper.ts`의 `getCategoryScrapeHistory`(product_master/supply_clients 조회)
자체를 의심했지만, 진짜 원인은 그 요청과 **동시에 실행된 `initDb()`**였다.

`initDb()`는 가드 없이 로그인/사이트 목록 등 거의 모든 요청 경로에서 매번 호출되고 있었고, 호출될
때마다 ~600줄짜리 `runMigrations()` DDL(테이블 수십 개에 대한 `ALTER TABLE`/`CREATE TABLE` 등)을
그대로 실행했다. 이 SQL 뭉치를 문자열 하나로 `pool.query()`에 넘기면 pg가 이를 **암묵적 트랜잭션
하나**로 실행한다 — 즉 이 트랜잭션이 끝날 때까지 관련된 모든 테이블의 잠금을 고정된 순서로 잡은 채
놓지 않는다. 그 사이 다른 요청(`getCategoryScrapeHistory`처럼 `product_master` → `supply_clients`
순으로 잠그는 쿼리)이 반대 순서로 같은 테이블들을 건드리면 PostgreSQL이 데드락으로 감지해 둘 중
하나를 강제 종료시킨다.

## 두 단계로 나뉜 수정 — 첫 번째만으로는 해결되지 않았다

1. **`initDb()`를 프로세스당 1회로 캐싱** (`lib/db.ts`): 매 요청 재검증이 원래도 불필요했다(스키마는
   배포 중에만 바뀐다). `initPromise: Promise<void> | null` 모듈 변수에 캐싱하고, 실패 시에만 캐시를
   비워 다음 호출이 처음부터 재시도하게 한다.
   ```ts
   let initPromise: Promise<void> | null = null
   export function initDb(): Promise<void> {
     if (!initPromise) initPromise = runMigrations().catch(err => { initPromise = null; throw err })
     return initPromise
   }
   ```
   → 이것만 적용한 뒤에도 데드락이 재현됐다. **근본 원인은 호출 빈도가 아니라 트랜잭션 자체의 잠금
   범위**였다는 뜻 — 서버가 갓 재시작된 직후 첫 요청이 `initDb()`를 트리거하는 그 짧은 창 안에,
   동시에 들어온 다른 요청과 여전히 충돌할 수 있었다.

2. **DDL을 문장 단위로 쪼개 각각 자동 커밋** (`runStatements`, `lib/db.ts`): 세미콜론으로 SQL을
   분리해 문장마다 별도의 `pool.query()` 호출로 실행한다. 문장 하나가 끝나면 그 문장이 잡았던 잠금도
   즉시 풀리므로, 서로 다른 순서로 잠그는 두 실행이 실제로 "겹치는 순간" 자체가 극히 짧아져 데드락이
   실질적으로 불가능해진다.
   ```ts
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
       } else if (ch === '$' && sql.startsWith(tag, i)) { i += tag.length - 1; tag = null }
     }
     const last = sql.slice(start).trim()
     if (last) statements.push(last)
     for (const stmt of statements) { const trimmed = stmt.trim(); if (trimmed) await pool.query(trimmed) }
   }
   ```
   `$tag$...$tag$` 달러 인용 블록(`DO $$ ... $$;` 등) 안의 세미콜론은 문장 구분자로 보지 않도록
   별도 처리했다 — 안 그러면 `DO` 블록 내부에서 SQL이 잘려 문법 오류가 난다. 문자열 리터럴 안의
   세미콜론까지는 다루지 않는데, 현재 마이그레이션 SQL에는 없어 해당 없음(있었다면 즉시 SQL 문법
   오류로 드러난다).

## 검증

24개 동시 요청으로 데드락을 인위 재현하는 테스트로 확인 — 수정 전엔 100% 재현, 수정 후엔 0건.

## 관련 파일

- `lib/db.ts`: `initDb()`(캐시드 프로미스), `runStatements`(신규), `runMigrations()`의 DDL/시드
  삽입 블록 모두 `pool.query(sql)` 한 번 호출에서 `runStatements(sql)` 호출로 교체.

## 상태

**적용 완료, 동시 요청 재현 테스트로 검증됨.**
