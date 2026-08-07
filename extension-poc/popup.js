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
      setStatus(action === 'start' ? '✓ 시작했습니다 — PTP 화면에서 진행상황을 확인하세요.'
        : action === 'picker' ? '✓ 몰 탭에 직접지정 패널이 열렸습니다 — 그 패널에서 값을 클릭해 지정하세요.'
        : '✓ 완료했습니다 — PTP 화면에서 결과를 확인하세요.', 'ok')
    } else {
      setStatus(`✗ ${res?.error || '알 수 없는 오류'}`, 'error')
    }
  } catch (e) {
    setStatus(`✗ ${e.message} (팝업이 닫혀도 이미 시작된 작업은 계속 진행됩니다)`, 'error')
  } finally {
    setBusy(false)
  }
}

document.getElementById('btn-preview').addEventListener('click', () => run('preview', '지금 페이지를 캡처하는 중...'))
document.getElementById('btn-start').addEventListener('click', () => run('start', '스크랩을 시작합니다...'))
document.getElementById('btn-picker').addEventListener('click', () => run('picker', '직접지정 패널을 여는 중...'))
