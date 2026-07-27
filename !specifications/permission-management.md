# 권한관리 (설정 메뉴) — 요구사항 및 구현 기록

## 배경 / 요구사항 (사용자 지시 원문 기준)

> 권한관리 기능을 '설정' 메뉴 안에 만들거야. 일단 관리자 계정인 admin을 기본으로 하고, admin 계정에,
> 거래처관리, Mall 상세관리 기능의 등록/삭제 권한을 부여해줘. 그리고 스크래핑한 데이터의 삭제 권한을
> 부여해줘. 즉, 이외의 사용자 등록 기능이 있어야 하고, 그 사용자는 admin 권한을 제외한 나머지 권한만
> 부여해.

즉:
- `admin` 계정(최초 시드 계정, 고정 하나)은 거래처/Mall 등록·삭제 + 스크랩 데이터 삭제 가능.
- 그 외 신규 등록되는 사용자는 항상 "일반" 권한 — 저 3가지만 못 하고 나머지는 전부 가능.
- 설정 메뉴 안에 사용자 등록 UI가 있어야 한다.

## 구현 전 발견한 사실 — 기존 인증은 진짜 단일 계정이었다

`admin_accounts` 테이블이 이미 있었지만 정확히 1행만 있다고 가정한 코드였다(`ORDER BY id LIMIT 1`로
무조건 첫 행을 가져옴, role 컬럼 없음). 세션 토큰도 `{username, exp}`만 담아 role 개념 자체가 없었다.

**다중 사용자로 확장하며 발견/수정한 보안 구멍**: 기존 "관리자 계정" 설정 카드(`/api/auth/admin`)는
로그인한 사람이 누구든 상관없이 항상 그 유일한 admin 행을 조회/수정했다 — 단일 계정 시절엔 "로그인한
사람 = 그 admin"이라 문제가 없었지만, 여러 사용자가 생기면 **일반 사용자가 이 카드로 admin의 비밀번호를
바꿀 수 있는 구조**가 된다. `/api/auth/me`로 교체해 "지금 로그인한 사람 본인의 행"만 조회/수정하도록
고쳤다 — 이건 스코프 확장이 아니라 다중 사용자 도입에 필연적으로 따라오는 수정이었다.

## 데이터 모델

`admin_accounts` → `users`로 이름 변경(`ALTER TABLE IF EXISTS ... RENAME TO`, 기존 DB도 안전하게
전환됨) + `role TEXT NOT NULL DEFAULT 'user'` 컬럼 추가 + `created_at` 컬럼 추가 + `username` 유니크
인덱스. 기존 유일 행(`username='admin'`)은 `role='admin'`으로 지정. 신규 가입 시드도 `role='admin'`으로
INSERT하도록 수정.

`role`은 딱 두 값: `'admin'` | `'user'`. 세분화된 권한 매트릭스가 아니라 "admin 전용 3개 동작 + 그 외
전부"라는 단순한 이분법이라, 별도 permissions 테이블 없이 이 컬럼 하나로 충분하다.

## 세션/헤더 전달 방식

`role`을 세션 토큰(HMAC 서명된 쿠키) 안에 같이 실어서(`signSessionToken(username, role)`), 매 요청마다
DB를 다시 조회하지 않고도 권한을 확인할 수 있게 했다. `proxy.ts`가 쿠키를 검증한 뒤
`x-ptp-username`/`x-ptp-role` 요청 헤더로 API 라우트에 신원을 넘겨준다(`lib/auth.ts`의
`isAdminRequest(req)` 헬퍼로 각 라우트에서 확인) — 이 헤더는 proxy를 거치지 않고는 만들 수 없어 위조
불가능하다.

**버그 하나 발견/수정**: `/api/auth/`가 이미 `PUBLIC_API_PREFIXES`(로그아웃 상태에서도 닿아야 하는
경로)에 있었는데, "공개"와 "로그인 시 헤더 주입 생략"을 같은 분기로 처리해서 `/api/auth/me`가 로그인
상태에서도 신원 헤더를 못 받는 문제가 있었다. "공개 = 로그아웃 상태에서도 닿을 수 있어야 함"과 "로그인
상태면 헤더를 준다"는 서로 다른 축이라, 세션이 유효하면 공개/비공개 구분 없이 항상 헤더를 싣도록
`proxy.ts` 로직을 분리했다.

## admin 전용으로 막은 5곳

| 기능 | 라우트 | 프론트엔드 |
|---|---|---|
| 거래처 등록 | `POST /api/clients` | `ClientsListPanel`의 `NewClientForm` (isAdmin 아니면 렌더 안 함) |
| 거래처 삭제 | `DELETE /api/clients/[id]` | `ClientsListPanel`/`ClientDetailPanel`의 삭제 버튼 |
| Mall 등록 | `POST /api/sites` | `SitesListPanel`의 "새 Mall 등록", `SiteDetailPanel`의 등록 저장 버튼(isNew), `ClientDetailPanel`의 "Mall 추가" |
| Mall 삭제 | `DELETE /api/sites/[id]` | `SitesListPanel`/`SiteDetailPanel`/`ClientDetailPanel`의 삭제 버튼 |
| 스크랩 데이터 삭제 | `DELETE /api/sessions/[id]` (세션 전체), `DELETE /api/scrape-staging/[id]` (개별 항목 "무시") | `ProductsListPanel`의 "선택 삭제"/행별 삭제, `StagingItemsGrid`의 "선택 무시" |

**의도적으로 안 막은 것**: 거래처/Mall의 PUT(수정)은 그대로 전체 사용자에게 열려있다 — 사용자가 명시한
건 "등록/삭제 권한"이지 "관리 전체"가 아니라서, 기존 항목의 필드 수정은 계속 가능하다. 스크랩 항목의
필드 수정(`PUT /api/scrape-staging/[id]`)도 마찬가지로 열어뒀다.

프론트엔드 숨김은 UX용일 뿐 실제 차단은 위 라우트들의 서버 쪽 `isAdminRequest` 체크가 한다 — UI만
숨기고 라우트를 안 막으면 URL 직접 호출로 우회 가능하므로 반드시 둘 다 필요했다.

## 설정 > 권한관리 UI

`SettingsPanel.tsx`에 admin에게만 보이는 새 카드 추가 — 사용자 목록(아이디/권한/등록일) + 등록 폼
(아이디/비밀번호, role 선택 UI 자체가 없음 — 항상 'user'로만 생성) + 삭제 버튼(role='admin' 행은 삭제
버튼 자체를 안 보여주고, 서버(`DELETE /api/users/[id]`)도 한 번 더 막음).

기존 "관리자 계정" 카드는 "내 계정"으로 이름을 바꾸고 `/api/auth/me`로 교체 — 이제 admin이든 일반
사용자든 자기 자신의 아이디/비밀번호만 바꿀 수 있다.

## 검증

`tsc --noEmit`/`eslint` 클린. curl로 직접 확인: admin 로그인 → 사용자 등록 → 신규 사용자 로그인 →
세션 토큰에 `role:"user"` 정확히 인코딩 → `POST /api/clients`/`DELETE /api/sessions/{id}`/`GET /api/users`
전부 403 확인. Playwright로 프론트엔드도 확인: admin은 등록/삭제 버튼과 권한관리 섹션이 보이고, 일반
사용자는 전부 숨겨짐. 검증에 쓴 테스트 계정은 삭제해 정리함.

## 후속 — 실사용 중 "사용자 등록이 안 됨" 버그 발견/수정 (2026-07-28)

사용자가 실제로 화면에서 사용자 등록을 시도했는데 admin인데도 안 됐다. 원인: **이 기능을 만들기 전부터
브라우저에 남아있던 예전 세션 쿠키**는 `signSessionToken`이 role을 넣기 전(2026-07-27 이전)에 발급된
토큰이라 `{username, exp}`만 있고 `role` 클레임이 아예 없었다. `verifySessionToken`이 이런 토큰도 서명
검증만 통과하면 그대로 `{username, role: undefined}`를 돌려줬고, `isAdminRequest`(`role === 'admin'`)는
당연히 false가 돼 실제 admin인데도 모든 admin 전용 라우트(사용자 등록 포함)가 403으로 막혔다 —
`/api/auth/me`는 DB를 직접 조회해 role을 가져오므로(토큰의 role과 무관) 화면(권한관리 섹션, 등록
버튼)은 정상적으로 다 보이는데 실제 등록 요청만 실패해서 더 헷갈리는 증상이었다.

**수정**: `verifySessionToken`이 payload에 `role`이 없으면 그 토큰 자체를 무효로 처리하도록 바꿨다
(`!role → return null`) — role 없는 옛 토큰을 가진 사람은 이제 401(미인증)로 처리돼 재로그인하게
되고, 재로그인하면 `signSessionToken`이 항상 role을 채운 새 토큰을 발급해 문제가 사라진다. 곁들여
모든 admin 전용 라우트(clients/sites/sessions/scrape-staging/users 총 9곳)의 403 메시지를 `'forbidden'`
에서 `'관리자 권한이 필요합니다.'`로 바꿔, 이후 비슷한 문제가 생겨도 원인이 화면에 바로 보이게 했다.

**교훈**: 세션 토큰 payload 스키마를 바꿀 때(필드 추가 등)는 항상 "그 필드가 없는 옛 토큰이 아직
브라우저에 남아있을 수 있다"는 걸 감안해야 한다 — 안 그러면 딱 이번처럼, 권한 검사가 조용히 잘못된
쪽으로(보통 더 제한적인 쪽으로) 실패하고, 화면에 보이는 것과 실제 서버 판단이 어긋나 진단하기 어려운
버그가 된다. 새 필드가 없으면 토큰을 무효 처리해 재로그인을 강제하는 게 가장 단순하고 안전하다.

curl로 재현 확인: `CREDENTIALS_ENCRYPTION_KEY`로 role 없는 옛 형식 토큰을 직접 만들어
`/api/auth/me`·`POST /api/users`에 넣어보니 수정 전엔 있었을 조용한 403 대신 수정 후엔 401(미인증)로
명확히 처리됨을 확인. 정상 재로그인 세션으로는 등록/중복아이디 에러 메시지 모두 정상 동작 확인.

## 후속 — 일반 사용자에게 거래처/Mall "등록" 권한 개방 (2026-07-28)

사용자 요청으로 admin 전용 5곳 중 등록(POST) 2곳을 일반 사용자에게도 열었다:
`POST /api/clients`(거래처 등록), `POST /api/sites`(Mall 등록)에서 `isAdminRequest` 체크를 제거.
프론트엔드도 맞춰 `ClientsListPanel`의 `NewClientForm`, `SitesListPanel`의 "새 Mall 등록" 버튼,
`SiteDetailPanel`의 등록 저장 버튼(기존엔 `isNew`일 때 admin만), `ClientDetailPanel`의 "Mall 추가"
버튼을 전부 무조건 노출로 변경.

**admin 전용으로 남은 것은 삭제뿐이다**: 거래처 삭제(`DELETE /api/clients/[id]`), Mall 삭제
(`DELETE /api/sites/[id]`), 스크랩 데이터 삭제(세션/개별 항목) — 이 3곳은 그대로 `isAdminRequest`로
막혀있다. 즉 일반 사용자 권한이 "거래처·Mall 등록/삭제, 스크랩 데이터 삭제 제외 전체"에서
"거래처·Mall 삭제, 스크랩 데이터 삭제 제외 전체"로 바뀐 것 — 등록은 이제 전체 권한에 포함된다.

권한관리 화면 문구도 "일반 (거래처·Mall 삭제, 스크랩 데이터 삭제 권한 제외)"로 갱신.
