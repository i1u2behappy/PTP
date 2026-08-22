// 팝업은 우클릭 컨텍스트메뉴가 몰 페이지 JS로 차단당해도(실제 발견된 사례) 항상 쓸 수 있는 경로다 —
// 툴바 아이콘 클릭 자체가 우클릭이 아니라 확장 UI를 직접 여는 것이라 페이지가 막을 방법이 없다.
// 2026-07-27: AI모드 토글/조정 지시문 입력은 PTP 화면(일반모드와 같은 자리)으로 옮겼다 — PTP에서 할 수
// 있는 설정은 PTP에서 하고, 이 팝업은 실제 몰 탭에서만 가능한 "실행" 트리거 역할만 맡는다(그래야 양쪽
// 모드를 PTP 한 곳에서 통합 관리할 수 있다). 결과도 PTP 화면이 폴링으로 보여준다.

const statusEl = document.getElementById('status')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind || ''
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach(b => { b.disabled = busy })
}

async function run(action, busyText) {
  setBusy(true)
  setStatus(busyText)
  try {
    // background.js(서비스 워커)는 "현재 창"이라는 개념이 없어(팝업처럼 특정 창에 매인 UI가 아니다)
    // chrome.tabs.query({currentWindow:true})를 거기서 부르면 의미가 불확실하다 — 팝업 자신이 매인
    // 창을 정확히 아는 여기서 활성 탭을 찾아 tabId/tabUrl로 넘겨준다.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !tab.url) { setStatus('✗ 활성 탭을 찾을 수 없습니다', 'error'); return }
    const res = await chrome.runtime.sendMessage({ action, tabId: tab.id, tabUrl: tab.url })
    if (res?.ok) {
      // "몰 구조분석"은 카테고리 하위구조 자동확인/정렬 옵션 감지까지 한 번에 처리한다(2026-08-22,
      // 세 버튼을 하나로 합침) — 셋 중 일부만 실패했으면(partialErrors) 성공 메시지 뒤에 같이 적어준다.
      const profileNote = res.partialErrors?.length
        ? ` (일부 실패: ${res.partialErrors.join(', ')})`
        : ` — 카테고리 하위구조 ${res.expandCount ?? '-'}개, 정렬 옵션 ${res.sortCount ?? '-'}개 확인 완료`
      setStatus(action === 'start' ? '✓ 시작했습니다 — PTP 화면에서 진행상황을 확인하세요.'
        : action === 'picker' ? '✓ 몰 탭에 직접지정 패널이 열렸습니다 — 그 패널에서 값을 클릭해 지정하세요.'
        : action === 'profile' ? `✓ 몰 구조분석 완료${profileNote} — PTP에서 다시 확인하세요.`
        : action === 'current-category' ? '✓ 카테고리 URL 목록에 추가했습니다 — 잠시 후 PTP 화면에 반영됩니다.'
        : '✓ 완료했습니다 — PTP 화면에서 결과를 확인하세요.', res.partialErrors?.length ? 'error' : 'ok')
    } else {
      setStatus(`✗ ${res?.error || '알 수 없는 오류'}`, 'error')
    }
  } catch (e) {
    setStatus(`✗ ${e.message} (팝업이 닫혀도 이미 시작된 작업은 계속 진행됩니다)`, 'error')
  } finally {
    setBusy(false)
  }
}

// "몰 구조분석"은 예전엔 이 버튼 하나였는데, 카테고리 하위구조 자동확인/정렬 옵션 감지 버튼 2개를
// 따로 눌러야 하는 게 번거롭다는 지적으로 셋을 하나로 합쳤다(2026-08-22, background.js의
// runFullMallProfile 참고) — 몰 구조분석 자체는 서버가 별도로 여는 헤드리스 브라우저(개인 크롬 프로필
// 사본)로 하고, 나머지 둘은 지금 이 탭(chrome.debugger)에서 순서대로 진행한다. 대분류 개수만큼 페이지를
// 하나씩 열어봐야 해서(카테고리 사이 1.2~2.4초 대기 포함) 몰 규모에 따라 몇 분 걸릴 수 있다 — PTP의
// "카테고리 불러오기"를 먼저 한 번 실행해 대분류 목록을 만들어둬야 한다.
document.getElementById('btn-profile').addEventListener('click', () => run('profile', '몰 구조를 분석하는 중... (카테고리 하위구조/정렬 옵션까지 함께 확인 — 몰 규모에 따라 몇 분 걸릴 수 있습니다)'))
document.getElementById('btn-current-category').addEventListener('click', () => run('current-category', '현재 페이지를 카테고리 목록에 추가하는 중...'))
document.getElementById('btn-preview').addEventListener('click', () => run('preview', '지금 페이지를 캡처하는 중...'))
document.getElementById('btn-start').addEventListener('click', () => run('start', '스크랩을 시작합니다...'))
document.getElementById('btn-picker').addEventListener('click', () => run('picker', '직접지정 패널을 여는 중...'))
