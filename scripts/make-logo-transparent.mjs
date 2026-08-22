// public/PTP_Logo.png은 실제 알파 채널이 없는(hasAlpha:false) 이미지다 — "투명"처럼 보이는 체커보드는
// 미리보기용으로 그림에 그대로 그려진 픽셀이라, 그대로 화면에 쓰면 회색 격자 배경이 그대로 보인다.
// 배경(체커보드)과 로고의 밝은 크롬 하이라이트가 색상 값 자체는 겹치므로(둘 다 230~250대), 단순 색상
// 임계값만으로는 글자 안의 밝은 하이라이트까지 구멍이 뚫린다 — 그래서 가장자리에서부터 배경색과
// 연결된 픽셀만 지우는 플러드필(flood fill)로 처리한다(글자 안의 고립된 하이라이트는 가장자리와
// 연결되지 않으므로 안전하다). 우측 상단의 "Made with AI" 배지는 로고 콘텐츠가 없는 영역이라 사각형
// 그대로 잘라낸다. 마지막으로 완전히 투명해진 여백은 sharp trim으로 잘라 로고만 남긴다.
import sharp from 'sharp'

const SRC = 'public/PTP_Logo.png'
const OUT = 'public/ptp-logo.png'
const BG_MIN = 225 // 이 값 이상이고 채널 간 차이가 작으면(중성 회색/흰색) 배경 후보로 본다
const BG_CHROMA_TOL = 12

const img = sharp(SRC)
const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info // channels === 4 (RGBA)

function isBgLike(i) {
  const r = data[i], g = data[i + 1], b = data[i + 2]
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return min >= BG_MIN && (max - min) <= BG_CHROMA_TOL
}

// "Made with AI" 배지 영역(우측 상단) — 이 사각형은 무조건 투명 처리한다.
const badge = { x0: 1240, y0: 0, x1: width, y1: 110 }

const visited = new Uint8Array(width * height)
const queue = new Int32Array(width * height)
let qHead = 0, qTail = 0

function tryEnqueue(x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const p = y * width + x
  if (visited[p]) return
  const i = p * channels
  if (!isBgLike(i)) return
  visited[p] = 1
  data[i + 3] = 0
  queue[qTail++] = p
}

// 네 변 전체를 시작점으로 큐에 넣는다.
for (let x = 0; x < width; x++) { tryEnqueue(x, 0); tryEnqueue(x, height - 1) }
for (let y = 0; y < height; y++) { tryEnqueue(0, y); tryEnqueue(width - 1, y) }

while (qHead < qTail) {
  const p = queue[qHead++]
  const x = p % width, y = (p / width) | 0
  tryEnqueue(x + 1, y); tryEnqueue(x - 1, y); tryEnqueue(x, y + 1); tryEnqueue(x, y - 1)
}

// 배지 영역은 플러드필 결과와 무관하게 강제로 투명 처리.
for (let y = badge.y0; y < badge.y1; y++) {
  for (let x = badge.x0; x < badge.x1; x++) {
    const i = (y * width + x) * channels
    data[i + 3] = 0
  }
}

// sharp의 trim()은 RGB 유사도로 배경을 판정해서(알파를 그대로 안 봄, 배경 자체도 체커보드라 명도가
// 238~251로 흔들려 기본 threshold로는 못 자름) 우리가 이미 확정한 알파 채널 기준으로 직접 여백을
// 계산해 자른다. 이미지 가장자리에 압축 노이즈로 남은 1~20픽셀짜리 고립된 불투명 티끌이 경계 계산을
// 왜곡하지 않도록, 한 줄/열에 불투명 픽셀이 최소 개수(NOISE_FLOOR) 이상 있어야 "실제 로고 내용"으로 본다.
const NOISE_FLOOR = 30
let minX = width, minY = height, maxX = -1, maxY = -1
const rowCounts = new Int32Array(height)
const colCounts = new Int32Array(width)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * channels + 3] > 0) { rowCounts[y]++; colCounts[x]++ }
  }
}
for (let y = 0; y < height; y++) if (rowCounts[y] >= NOISE_FLOOR) { if (y < minY) minY = y; if (y > maxY) maxY = y }
for (let x = 0; x < width; x++) if (colCounts[x] >= NOISE_FLOOR) { if (x < minX) minX = x; if (x > maxX) maxX = x }
const PAD = 12
const left = Math.max(0, minX - PAD)
const top = Math.max(0, minY - PAD)
const cropW = Math.min(width, maxX + PAD) - left
const cropH = Math.min(height, maxY + PAD) - top

await sharp(data, { raw: { width, height, channels } })
  .extract({ left, top, width: cropW, height: cropH })
  .png()
  .toFile(OUT)

console.log('wrote', OUT, `(${cropW}x${cropH}, cropped from ${width}x${height})`)
