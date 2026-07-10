import { NextResponse } from 'next/server'
import { initDb } from '@/lib/db'
import { scrapeAllSites } from '@/lib/scheduler'

/** 마지막으로 사용한 스크랩 설정이 저장된 모든 Mall을 증분 재스크랩한다 ("전체 Mall 재스크랩" 버튼). */
export async function POST() {
  await initDb()
  const result = await scrapeAllSites()
  return NextResponse.json(result)
}
