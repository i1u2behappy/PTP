/** 한글 초성(19) → 로마자 표기 첫 글자. ㅇ(초성 없음)은 빈 문자열 — 이 경우 모음 로마자의 첫 글자를 쓴다. */
const CHO_LATIN = ['G', 'K', 'N', 'D', 'T', 'R', 'M', 'B', 'P', 'S', 'S', '', 'J', 'J', 'C', 'K', 'T', 'P', 'H']
/** 한글 중성(21) → 로마자 표기 첫 글자 */
const JUNG_LATIN = ['A', 'A', 'Y', 'Y', 'E', 'E', 'Y', 'Y', 'O', 'W', 'W', 'O', 'Y', 'U', 'W', 'W', 'W', 'Y', 'E', 'U', 'I']

function latinInitialOf(char: string): string {
  const code = char.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const offset = code - 0xac00
    const choIdx = Math.floor(offset / (21 * 28))
    const jungIdx = Math.floor((offset % (21 * 28)) / 28)
    return CHO_LATIN[choIdx] || JUNG_LATIN[jungIdx]
  }
  return char.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'X'
}

/** 이름 앞 2글자를 영문 이니셜 2자로 변환 (한글은 로마자 표기 첫 글자, 영문/숫자는 그대로 대문자) — 예: "일다" → "ID" */
export function englishInitialsOf(name: string): string {
  const chars = Array.from(name.trim().replace(/\s+/g, '')).slice(0, 2)
  const result = chars.map(latinInitialOf).join('')
  return (result || 'XX').padEnd(2, 'X').slice(0, 2)
}
