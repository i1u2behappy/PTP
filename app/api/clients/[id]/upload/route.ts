import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import pool from '@/lib/db'

const SAVE_ROOT = path.join(process.cwd(), 'public', 'client-docs')
const MAX_SIZE_BYTES = 10 * 1024 * 1024
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.webp']

/** 사업자등록증 사본 업로드 (거래처당 1개, 재업로드 시 덮어씀) */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
  if (file.size > MAX_SIZE_BYTES) return NextResponse.json({ error: '파일 크기는 10MB 이하만 가능합니다.' }, { status: 400 })

  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return NextResponse.json({ error: 'PDF 또는 이미지(jpg/png/webp) 파일만 업로드할 수 있습니다.' }, { status: 400 })

  const dir = path.join(SAVE_ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  const storedName = `business_reg${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  fs.writeFileSync(path.join(dir, storedName), buffer)

  const storagePath = `/client-docs/${id}/${storedName}`
  await pool.query('UPDATE supply_clients SET business_reg_doc_path=$1, business_reg_doc_name=$2 WHERE id=$3', [storagePath, file.name, id])
  return NextResponse.json({ path: storagePath, name: file.name })
}
