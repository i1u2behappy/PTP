# PTP 자체 로그인 — 요구사항 기록

## 배경 / 요구사항 (사용자 지시 원문 기준, 2026-07-17)

> 이 ptp 프로그램에 로그인 화면을 만들어야 겠어. 설정메뉴에 관리자 ID/PW 관리할 수 있게 해주고, 다른
> project와 같은 로그인을 만들어줘.

"다른 project와 같은 로그인"이 구체적으로 어떤 프로젝트를 가리키는지는 불명확해, "표준적인 ID/PW
로그인"(단일 관리자 계정, 세션 쿠키 기반, OAuth/소셜로그인 아님)으로 해석하고 진행했다. 지금까지 PTP는
몰 스크래핑용 로그인(사이트별 `sites.login_id`/`login_pw_encrypted`)만 있었고, PTP 앱 자체에는 아무
인증이 없었다 — 이번 기능은 그 앱 레벨 로그인을 새로 추가하는 것.

## 설계 결정

- **새 라이브러리를 추가하지 않는다.** next-auth/iron-session/jose 등을 넣는 대신, 이미 있는
  `CREDENTIALS_ENCRYPTION_KEY`(sites 로그인 비번 암호화에 쓰던 키)를 재사용해 `crypto.createHmac`으로
  세션 쿠키를 직접 서명한다. 비밀번호 해시도 `crypto.scryptSync`(Node 표준 라이브러리)만 사용 — bcrypt
  의존성 추가 없음. 단일 관리자 계정짜리 내부 도구에 외부 인증 라이브러리는 과함.
- **Next.js 버전 확인 필수 (AGENTS.md 경고 대응)**: 이 프로젝트의 Next.js는 `middleware.ts`가
  deprecated되고 **`proxy.ts`**(파일명, export 함수명 모두 `proxy`)로 이름이 바뀐 버전이다
  (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`). `cookies()`도
  Route Handler에서 `await cookies()`로 비동기 호출해야 한다. 문서 확인 없이 예전 관행대로
  `middleware.ts`를 만들었으면 조용히 무시됐을 것.
- **인증 게이트 위치**: 프로젝트 루트 `proxy.ts` 하나로 전체 앱(페이지 + API)을 막는다.
  `/login`, `/api/auth/*`만 공개 경로. 나머지 경로는 서명된 `ptp_session` 쿠키가 없거나 만료되면
  `/api/`는 401 JSON, 그 외는 `/login`으로 리다이렉트. 이미 로그인된 상태로 `/login`에 접근하면 `/`로
  리다이렉트. matcher는 `_next/static`/`_next/image`/`favicon.ico`만 제외하고 나머지는 전부 proxy를
  통과시킨 뒤 함수 내부에서 공개/비공개를 판정한다 (matcher 정규식으로 API 경로까지 세밀하게 제외하면
  나중에 리팩터링 때 보호가 조용히 빠질 수 있다는 Next 공식 문서 경고를 따름).
- **관리자 계정은 단일 계정**: `admin_accounts` 테이블(단일 행), `lib/db.ts`의 `initDb()`에서 테이블이
  비어있으면 `admin` / `admin1234` 기본 계정을 자동 생성하고 콘솔에 경고를 남긴다("설정 메뉴에서 즉시
  변경해주세요"). 설정 메뉴에서 ID/새 비밀번호/현재 비밀번호(확인용) 폼으로 변경 가능.
- **세션**: HMAC-SHA256으로 서명한 `{username, exp}` payload를 쿠키 값으로 사용(7일 만료), JWT
  라이브러리 없이 직접 구현 — 클레임이 `username`/`exp` 둘 뿐이라 표준 JWT가 주는 이점(다양한 alg,
  header 등)이 필요 없음.

## 새 파일 / 수정 파일

**신규**
- `lib/auth.ts` — `hashPassword`/`verifyPassword`(scrypt), `signSessionToken`/`verifySessionToken`(HMAC).
- `proxy.ts` (프로젝트 루트) — 인증 게이트.
- `app/login/page.tsx` — ID/PW 로그인 폼 (teal 브랜드 컬러, 앱 표준 버튼 스타일).
- `app/api/auth/login/route.ts` — POST, 로그인 성공 시 `ptp_session` 쿠키 설정.
- `app/api/auth/logout/route.ts` — POST, 쿠키 삭제.
- `app/api/auth/admin/route.ts` — GET(현재 아이디 조회)/PUT(현재 비밀번호 확인 후 아이디/비밀번호 변경).

**수정**
- `lib/db.ts` — `admin_accounts` 테이블 생성 + 빈 경우 기본 계정 부트스트랩.
- `components/panels/SettingsPanel.tsx` — "관리자 계정" 섹션 추가.
- `components/shell/Sidebar.tsx` — 하단에 "로그아웃" 버튼 추가.

## 검증

- `npx tsc --noEmit`, `npx eslint` 통과.
- 새 `proxy.ts`는 이미 떠 있던 dev 서버 프로세스에 반영되지 않아(신규 루트 파일은 서버 부팅 시점에
  등록됨) 서버를 재시작한 뒤에야 정상 동작 확인 — 재시작 전엔 `/`가 게이트 없이 200을 반환했었다.
- curl로 실제 시나리오 전부 확인: 비로그인 `/` → 307 `/login` 리다이렉트, 비로그인 `/api/sites` → 401,
  틀린 비밀번호 → 401, 올바른 로그인 → 쿠키 발급 → 이후 `/`/`/api/sites` 200, 로그인 상태로 `/login`
  접근 → `/`로 리다이렉트, 관리자 비밀번호 변경(틀린 현재 비번 거부 → 올바른 현재 비번으로 변경 성공) →
  로그아웃 → 이전 비밀번호 실패/새 비밀번호 성공까지 확인 후 테스트용으로 바꿨던 비밀번호는
  `admin1234`로 되돌려둠.

## 보완 (2026-07-17) — 로고/파비콘 적용 시 발견한 공개 경로 누락

실제 로고 이미지(ILDA:Bridge)를 사이드바/로그인 화면/브라우저 파비콘(`app/icon.jpg`)에 적용하면서,
`proxy.ts`의 matcher가 `_next/static`/`_next/image`/`favicon.ico`만 제외하고 `public/` 밑 정적 파일은
전부 게이트한다는 점을 놓쳤던 걸 발견했다 — `/logo.jpg`, `/icon.jpg`(favicon 라우트)가 비로그인
상태에서도 307로 막혀 로그인 화면 자체에 로고/파비콘이 안 보이는 버그였다. `PUBLIC_PATHS`에
`/logo.jpg`, `/icon.jpg`를 추가해 해결 — curl로 로그인 전/후 두 경로 모두 재확인함. 앞으로 로그인 화면에
쓰이는 정적 자산을 추가할 때마다 `PUBLIC_PATHS`에 등록해야 한다는 점을 기억할 것.

## 상태

**구현 완료 (2026-07-17).** 기본 계정은 `admin` / `admin1234` — 최초 로그인 후 설정 메뉴에서 반드시
변경 권장.
