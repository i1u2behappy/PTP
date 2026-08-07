'use client'
import { useTabs } from './TabsContext'

/**
 * "← 뒤로가기"와 같은 줄, 우측에 상시 노출되는 안내 슬롯 — 지금 열린 메뉴(패널)가 useTabs().setGuidance로
 * 넣어준 "다음에 뭘 눌러야 하는지" 한 줄 문구를 그대로 보여준다. 안내 로직 자체는 각 패널(예:
 * ScraperPanel)이 자신의 내부 진행 상태를 보고 계산해 채운다 — 이 컴포넌트는 표시만 맡는다.
 */
export function NextStepBanner() {
  const { guidance } = useTabs()
  if (!guidance) return null

  return (
    <div className="flex items-center bg-amber-50 border border-amber-200 rounded-full px-3 py-1 shrink-0 max-w-full">
      <span className="text-xs text-amber-800 truncate">📍 {guidance}</span>
    </div>
  )
}
