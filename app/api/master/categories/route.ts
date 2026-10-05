import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getOrCreateCategoryId, listCategoryTree } from '@/lib/master/categories'

export async function GET() {
  return NextResponse.json(await listCategoryTree())
}

const CreateSchema = z.object({
  name: z.string().min(1),
  parentId: z.number().nullable().default(null),
})

export async function POST(req: NextRequest) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  const { name, parentId } = parsed.data
  const id = await getOrCreateCategoryId(parentId, name)
  return NextResponse.json({ id })
}
