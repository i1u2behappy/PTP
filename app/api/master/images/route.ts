import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1

  const res = await pool.query(
    `SELECT pm.id, pm.name_original, pm.name_final,
            COALESCE(
              json_agg(json_build_object('id', pi.id, 'image_type', pi.image_type, 'sort_order', pi.sort_order, 'storage_path', pi.storage_path)
                       ORDER BY pi.image_type, pi.sort_order)
              FILTER (WHERE pi.id IS NOT NULL), '[]'
            ) AS images
     FROM product_master pm
     LEFT JOIN product_images pi ON pi.product_master_id = pm.id
     WHERE pm.client_id = $1
     GROUP BY pm.id
     ORDER BY pm.updated_at DESC`,
    [clientId],
  )
  return NextResponse.json(res.rows)
}
