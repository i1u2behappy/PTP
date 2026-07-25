# sharp 중복 버전으로 인한 Windows DLL 충돌 (간헐적 서버 크래시)

## 증상
PTP 서버(Next dev)가 특정 라우트(`/`, `/api/products` 등 이미지 관련 코드를 타는 라우트)에 접속하면
간헐적으로 죽었다. 어떤 라우트는 되고 어떤 라우트는 안 되는 식으로 재현이 불규칙해서 처음엔 "고쳤다"고
판단했다가(`npm approve-scripts sharp`만으로 일부 라우트가 우연히 통과) 다른 라우트에서 재발해 잘못된
결론이었음이 드러났다.

에러:
```
Error: Could not load the "sharp" module using the win32-x64 runtime
ERR_DLOPEN_FAILED: The specified procedure could not be found.
...\node_modules\@img\sharp-win32-x64\lib\sharp-win32-x64-0.35.2.node
```

## 진짜 원인
`npm ls sharp`로 확인해보니 프로젝트에 sharp가 **두 버전** 동시에 깔려 있었다:
- 최상위 `sharp@0.35.2` — 이 프로젝트(`lib/images.ts`)가 직접 의존
- `next@16.2.9`가 자체 내부(이미지 최적화용)로 요구하는 중첩 `sharp@0.34.5`
  (`node_modules/next/node_modules/sharp`)

두 버전 모두 자기 버전의 `libvips-42.dll`을 함께 배포한다(각 `@img/sharp-win32-x64` 패키지 안에 별도
사본으로 존재). Node 프로세스 하나 안에서 두 사본이 다 로드되면(예: Next 자체 이미지 최적화 코드가 먼저
자기 sharp를 로드하고, 이후 우리 코드가 자기 sharp를 로드하는 경우) Windows DLL 로더가 같은 파일명의
DLL을 나중 로드 시 무시하고 먼저 로드된 버전을 재사용해버려, 두 번째로 로드되는 쪽이 자기 버전의 함수를
찾지 못해 "procedure not found"로 죽는다. 어느 라우트가 먼저 어느 sharp를 건드리느냐에 따라 재현 여부가
갈렸던 것.

`npm rebuild sharp` / `npm approve-scripts sharp`(설치 스크립트 실행 승인)는 이 문제와 무관했다 —
바이너리 파일 자체는 처음부터 멀쩡했고, 문제는 "같은 프로세스 안에 서로 다른 버전이 공존"하는 것이었다.

## 해결
`next@16.2.9`가 원하는 sharp 범위(`^0.34.5`)와 이 프로젝트가 원하는 범위(`^0.35.2`)는 겹치지 않아 일반
semver 해석으로는 npm이 알아서 하나로 합치지 못한다. `package.json`에 `overrides`로 강제 통일:
```json
"overrides": { "sharp": "^0.35.2" }
```
`npm install` 재실행 후 `npm ls sharp` 확인 결과 전체 트리가 `sharp@0.35.3` 하나로 dedupe됐고,
`node_modules/next/node_modules/sharp` 중첩 사본은 사라졌다.

## 검증
이전엔 `GET /` 한 번 성공한 것만 보고 "해결"이라 잘못 판단했던 재발 방지를 위해, 이번엔 인증 세션 쿠키까지
직접 발급받아(`/api/auth/login` curl 로그인) `/`, `/login`, `/api/health/db`, `/api/products`를 모두
재기동 직후 순서대로 호출해 전부 200 확인, 서버가 죽지 않고 계속 응답하는 것까지 확인했다.

## 교훈
Next.js가 이미지 최적화용으로 sharp를 자체 내장 의존성으로 갖고 있다는 사실을 놓치고, 우리 프로젝트가 쓰는
sharp 버전만 봤던 것이 첫 오진의 원인이었다. 네이티브 애드온(특히 자체 DLL을 동봉하는 패키지)이 얽힌 크래시는
`npm ls <pkg>`로 트리 전체에 중복 버전이 있는지부터 확인해야 한다.
