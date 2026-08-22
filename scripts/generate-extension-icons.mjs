// PTP 개발자모드 확장 아이콘 생성 — manifest.json에 icons가 없어 크롬이 이름 첫 글자로 자동 생성하던
// 검은 바탕 "P" 아이콘을, 빨강 바탕으로 직접 만든 PNG로 바꾼다(2026-08-22 사용자 요청). 1회성 생성
// 스크립트라 별도 npm script 등록 없이 그때그때 node로 직접 돌린다.
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const SIZES = [16, 32, 48, 128]
const OUT_DIR = fileURLToPath(new URL('../extension-poc/icons/', import.meta.url))
mkdirSync(OUT_DIR, { recursive: true })

function svgFor(size) {
  // 크롬 아이콘 캔버스 자체는 항상 정사각형이라 파일 크기를 바꿀 순 없지만, 그 안에 유튜브 로고처럼
  // 옆으로 긴 빨간 막대만 그리고 위아래는 투명하게 비워 "가로로 긴 사각형" 느낌을 낸다.
  const barHeight = Math.round(size * 0.86)
  const barY = Math.round((size - barHeight) / 2)
  const barMarginX = Math.round(size * 0.04)
  const barWidth = size - barMarginX * 2
  const radius = Math.round(barHeight * 0.22)
  // 배경이 글자를 사방으로 감싸 보이게(2026-08-22 피드백) 글자 크기를 막대보다 한 단계 낮춰 위아래·
  // 좌우에 빨간 여백이 뚜렷이 남게 한다. 자간은 여전히 좁혀서(letterSpacing 음수) 그 안에서 최대한
  // 크게 채운다.
  const fontSize = Math.round(barHeight * 0.62)
  const letterSpacing = -Math.round(size * 0.045)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="${barMarginX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${radius}" fill="#dc2626"/>
    <text x="50%" y="${barY + barHeight / 2 + 1}" text-anchor="middle" dominant-baseline="middle" letter-spacing="${letterSpacing}"
      font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontSize}" fill="#ffffff">PTP</text>
  </svg>`
}

for (const size of SIZES) {
  const outPath = path.join(OUT_DIR, `icon${size}.png`)
  await sharp(Buffer.from(svgFor(size))).png().toFile(outPath)
  console.log('wrote', outPath)
}
