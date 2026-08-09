# 브라우저 뒤로가기 트랩이 진행 중인 화면을 대시보드로 강제 이동시키던 문제

## 배경

스크래핑을 진행 중인 화면에서 작업하다가, 아무 조작도 안 했는데 화면이 대시보드로 튕겨나가 있는
문제가 실사용 중 보고됐다(2026-08-10). 스크래핑 자체는 서버에서 계속 돌아 정상적으로 완료돼 있었다 —
데이터 손실은 없었고, 화면(활성 탭)만 바뀌어 있었다.

## 원인

`components/shell/TabsContext.tsx`에 브라우저 "뒤로가기"를 눌러도 PTP 밖으로 나가지 않게 막는 트랩이
있다(`61b6b1c`, 사이드바 로고 클릭 시 대시보드로 이동하는 기능과 같이 도입) — `history.pushState`로
더미 히스토리를 계속 채워 `popstate`를 흡수하고, 뜰 때마다 대시보드 탭을 열도록 했다.

문제는 `popstate`가 사용자가 의도적으로 뒤로가기 버튼을 누른 경우에만 뜨는 게 아니라는 것 — 트랙패드
뒤로가기 스와이프, 마우스 사이드 버튼, Alt+← 등으로도 똑같이 뜬다. 스크래핑 진행 화면을 보다가
무심코 이런 제스처가 한 번 들어가면, 그 즉시 대시보드로 강제 전환됐다.

## 수정

`popstate` 핸들러에서 `openTab(DASHBOARD_TAB)` 호출을 제거하고, `history.pushState` 재무장만 남겼다.
"뒤로가기로 앱 밖으로 못 나간다"는 원래 안전장치는 그대로 유지되면서, 지금 보고 있던 화면은 그대로
유지된다. 사이드바 로고를 직접 클릭했을 때의 대시보드 이동(`components/shell/Sidebar.tsx`)은 의도된
명시적 클릭 동작이라 그대로 남겨뒀다.

```diff
  useEffect(() => {
    window.history.pushState(null, '', location.href)
    function handlePopState() {
      window.history.pushState(null, '', location.href)
-     openTab(DASHBOARD_TAB)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
- }, [openTab])
+ }, [])
```

## 관련 파일

- `components/shell/TabsContext.tsx`: `popstate` 핸들러에서 대시보드 강제 전환 제거.

## 상태

**구현 완료.** tsc/eslint 클린.
