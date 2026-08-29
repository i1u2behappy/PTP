// popup.js가 chrome.runtime.sendMessage로 보내는 action 값과 background.js의 msg.action 분기가
// 반드시 일치해야 하는데, 각자 문자열 리터럴로 따로 적어두면 한쪽만 고쳤을 때 조용히 어긋난다
// (2026-08-29, 공통 상수로 정리). 클래식 스크립트(모듈 아님)라 background.js는 importScripts로,
// popup.html은 popup.js보다 먼저 <script> 태그로 이 파일을 로드해 전역 PTP_ACTIONS를 공유한다 —
// 다른 파일에서 참조하는 거라 린트가 사용처를 못 보고 "안 쓰임"으로 오탐한다.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PTP_ACTIONS = Object.freeze({
  START: 'start',
  PREVIEW: 'preview',
  PICKER: 'picker',
  PROFILE: 'profile',
  CURRENT_CATEGORY: 'current-category',
})
