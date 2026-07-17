import { NextRequest, NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import pool from '@/lib/db'

/** 그리드가 현재 화면에 보여주는 컬럼 순서·필터·정렬 결과를 그대로 받아 엑셀로 변환한다 — 서버가 별도로
 * 컬럼을 구성하면 화면과 다운로드 내용이 어긋나므로, 어떤 컬럼/값을 넣을지는 전적으로 클라이언트(그리드)가 정한다. */
export async function POST(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const siteId = req.nextUrl.searchParams.get('siteId')
  if (!sessionId && !siteId) return NextResponse.json({ error: 'sessionId or siteId required' }, { status: 400 })
  const { headers, rows } = await req.json() as { headers: string[]; rows: (string | number)[][] }
  if (!Array.isArray(headers) || !Array.isArray(rows)) return NextResponse.json({ error: 'headers, rows required' }, { status: 400 })

  const siteRes = siteId
    ? await pool.query<{ name: string | null }>(`SELECT name FROM sites WHERE id=$1`, [siteId])
    : await pool.query<{ name: string | null }>(
        `SELECT s.name FROM scrape_sessions ss JOIN sites s ON s.id = ss.site_id WHERE ss.id=$1`, [sessionId],
      )
  const mallName = (siteRes.rows[0]?.name || 'Mall').replace(/[\\/:*?"<>|]/g, '')

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Products Transformation Platform (PTP)'
  wb.created = new Date()
  const sheet = wb.addWorksheet('스크랩결과')
  const header = sheet.addRow(headers)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })
  rows.forEach(r => sheet.addRow(r))
  sheet.columns.forEach(col => { col.width = 20 })

  const buf = await wb.xlsx.writeBuffer()
  const now = new Date()
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const fileName = `${mallName}_Raw_${ymd}.xlsx`

  return new NextResponse(Buffer.from(buf) as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
