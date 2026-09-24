'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTabs } from '../../shell/TabsContext'

/** name 컬럼의 미정 배지 등에서 쓰는 텍스트 버전. undefined도 null(미정)과 같이 다룬다 — ScraperPanel의
 *  Site 타입은 이 필드를 optional로 선언해둬서(?: boolean | null) API 응답에 따라 undefined일 수 있다. */
export function loginModeLabel(manualLoginRequired: boolean | null | undefined): string {
  if (manualLoginRequired === true) return '개발자모드'
  if (manualLoginRequired === false) return '일반모드'
  return '미정'
}

/** 몰 유형 배지를 색으로 바로 구분: 일반모드=초록, 개발자모드=노랑, 미정=회색. */
export const LOGIN_MODE_BADGE_CLASS: Record<string, string> = {
  '일반모드': 'bg-emerald-100 text-emerald-700',
  '개발자모드': 'bg-amber-100 text-amber-700',
  '미정': 'bg-gray-100 text-gray-500',
}

const LOGIN_MODE_OPTIONS = [
  { v: null, label: '❔ 아직 모름' },
  { v: false, label: '🤖 일반모드' },
  { v: true, label: '🧩 개발자모드' },
] as const

/** 몰 유형 배지를 눌러 그 자리에서 바로 스크랩 방식(일반모드/개발자모드/미정)을 바꾼다 — 예전엔
 *  "Mall 상세관리 → 수정" 화면을 열어야만 바꿀 수 있었다(사용자 요청, 2026-09-20 — "수정 화면을
 *  통해서만 설정되는데, 밖으로 빼"). Mall 상세관리 목록(SitesListPanel)과 스크래핑 화면의 몰 선택
 *  그리드(ScraperPanel) 둘 다에서 쓰므로 공용 컴포넌트로 뺐다 — 처음엔 SitesListPanel에만 넣었다가
 *  "스크래핑 설정의 몰 선택 그리드에 넣어달라던 것"이었다는 걸 뒤늦게 확인해 이쪽으로 옮기며 공용화했다.
 *  두 화면 다 행 자체에 onClick(스크랩 화면 이동/몰 선택)이 걸려 있어, 배지를 누를 때 그쪽으로 새지
 *  않도록 항상 stopPropagation한다. */
export function LoginModeBadgeEditor({ site, className = '' }: {
  site: { id: number; manual_login_required?: boolean | null }
  className?: string
}) {
  const { bumpRefresh } = useTabs()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const label = loginModeLabel(site.manual_login_required)

  // 목록/그리드 둘 다 열마다 overflow-hidden(말줄임용)에 스크롤 컨테이너까지 겹쳐있어, 이 배지 바로
  // 아래 absolute로 띄우면 그 조상의 overflow:hidden에 그대로 잘려 안 보였다(실사용 확인, 2026-09-20)
  // — SystemStatus.tsx가 같은 이유로 쓰는 것과 같은 방식으로 document.body에 포탈로 그려 완전히 벗어난다.
  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  function openMenu() {
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left })
    setOpen(true)
  }

  async function choose(v: boolean | null) {
    setOpen(false)
    if (v === site.manual_login_required) return
    setSaving(true)
    try {
      const res = await fetch(`/api/sites/${site.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualLoginRequired: v }),
      })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('sites')
    } catch (e) {
      alert(`스크랩 방식 변경에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button ref={btnRef} type="button" disabled={saving}
        onClick={e => { e.stopPropagation(); if (open) setOpen(false); else openMenu() }}
        title="클릭해서 스크랩 방식 바꾸기"
        // 읽기 전용이던 시절과 겉모습이 똑같으면 "이제 클릭해서 바꿀 수 있다"는 게 안 보인다(사용자
        // 실사용 확인, 2026-09-20 — 실제로는 잘 작동하는데도 겉모습이 그대로라 안 바뀐 줄 알았음) — 배지
        // 안에 드롭다운 화살표(▾)를 넣어 "눌러서 고르는 것"임을 바로 알 수 있게 한다.
        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap disabled:opacity-50 hover:ring-2 hover:ring-teal-300 ${LOGIN_MODE_BADGE_CLASS[label]} ${className}`}>
        {saving ? '저장 중...' : <>{label}<span aria-hidden="true" className="text-[8px] opacity-60">▾</span></>}
      </button>
      {open && menuPos && typeof document !== 'undefined' && createPortal(
        <div ref={menuRef} onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          className="z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-1 flex flex-col gap-0.5 min-w-[112px]">
          {LOGIN_MODE_OPTIONS.map(opt => (
            <button key={String(opt.v)} type="button" onClick={() => choose(opt.v)}
              className={`text-left px-2 py-1 rounded-lg text-xs whitespace-nowrap transition-colors ${
                site.manual_login_required === opt.v ? 'bg-teal-50 text-teal-700 font-semibold' : 'text-gray-600 hover:bg-gray-50'}`}>
              {opt.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
