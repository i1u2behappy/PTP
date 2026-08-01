'use client'
import { useEffect, useState } from 'react'

interface OptionSlot { index: number; label: string; targetField: string }
interface CategoryProfile {
  sheetName: string
  hasFashionExtraColumns: boolean
  purchaseOptions: OptionSlot[]
  searchOptions: OptionSlot[]
  noticeInfo: { categoryValue: string; fields: OptionSlot[] }
}

function SlotRow({ slot, onChange }: { slot: OptionSlot; onChange: (s: OptionSlot) => void }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-16 shrink-0 text-xs text-gray-400">#{slot.index}</span>
      <input value={slot.label} onChange={e => onChange({ ...slot, label: e.target.value })}
        placeholder="실제 라벨 (예: 색상계열)"
        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
      <input value={slot.targetField} onChange={e => onChange({ ...slot, targetField: e.target.value })}
        placeholder="매핑 대상 필드 (product_master 필드명 또는 커스텀필드 키)"
        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
    </div>
  )
}

/** 쿠팡 대량등록 양식의 카테고리별 옵션/고시정보 슬롯 라벨 + 매핑 대상 필드를 편집한다.
 *  라벨/필드는 쿠팡 Wing에서 해당 카테고리를 선택했을 때 실제로 뜨는 값이라 여기선 구조만 잡아두고,
 *  값은 나중에 사용자가 직접 확인해서 채운다(!specifications/marketplace-formats/coupang.md 참고). */
export function CoupangCategoryProfileEditor({ channelCategoryValue, onClose }: { channelCategoryValue: string; onClose: () => void }) {
  const [profile, setProfile] = useState<CategoryProfile | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/marketplace-configs/coupang/category-profile?category=${encodeURIComponent(channelCategoryValue)}`)
      .then(r => r.json()).then(setProfile).catch(() => {})
  }, [channelCategoryValue])

  async function save() {
    if (!profile) return
    setSaving(true)
    await fetch(`/api/marketplace-configs/coupang/category-profile`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: channelCategoryValue, profile }),
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 shrink-0">
          <h2 className="text-lg font-bold text-gray-800">🎛️ 쿠팡 옵션·고시정보 매핑 — {channelCategoryValue}</h2>
          <p className="text-xs text-gray-400 mt-1">라벨은 쿠팡 Wing에서 이 카테고리 선택 시 실제로 뜨는 값을 확인해서 입력합니다. 비워두면 나중에 채울 수 있습니다.</p>
        </div>

        {!profile ? (
          <div className="p-8 text-center text-gray-400 text-sm">불러오는 중...</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 min-h-0 space-y-6">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <span className="w-20 shrink-0">시트명</span>
                <input value={profile.sheetName} onChange={e => setProfile({ ...profile, sheetName: e.target.value })}
                  placeholder="예: 패션잡화 / 식품 / 가전 / 반려동물"
                  className="border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={profile.hasFashionExtraColumns}
                  onChange={e => setProfile({ ...profile, hasFashionExtraColumns: e.target.checked })} />
                패션잡화 전용 추가 8컬럼 필요
              </label>
            </div>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">구매옵션 (옵션유형1~6 / 옵션값1~6)</h3>
              {profile.purchaseOptions.map((slot, i) => (
                <SlotRow key={slot.index} slot={slot} onChange={s => {
                  const next = [...profile.purchaseOptions]; next[i] = s
                  setProfile({ ...profile, purchaseOptions: next })
                }} />
              ))}
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">검색옵션 (옵션유형1~20 / 옵션값1~20)</h3>
              {profile.searchOptions.map((slot, i) => (
                <SlotRow key={slot.index} slot={slot} onChange={s => {
                  const next = [...profile.searchOptions]; next[i] = s
                  setProfile({ ...profile, searchOptions: next })
                }} />
              ))}
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">고시정보 (상품고시정보값1~14)</h3>
              <input value={profile.noticeInfo.categoryValue}
                onChange={e => setProfile({ ...profile, noticeInfo: { ...profile.noticeInfo, categoryValue: e.target.value } })}
                placeholder="상품고시정보 카테고리 (예: 기타 재화)"
                className="w-full border border-gray-200 rounded px-2 py-1 text-xs mb-2 focus:outline-none focus:ring-1 focus:ring-teal-300" />
              {profile.noticeInfo.fields.map((slot, i) => (
                <SlotRow key={slot.index} slot={slot} onChange={s => {
                  const next = [...profile.noticeInfo.fields]; next[i] = s
                  setProfile({ ...profile, noticeInfo: { ...profile.noticeInfo, fields: next } })
                }} />
              ))}
            </section>
          </div>
        )}

        <div className="p-4 border-t border-gray-100 shrink-0 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-full text-gray-500 hover:bg-gray-50">닫기</button>
          <button onClick={save} disabled={!profile || saving}
            className="px-4 py-1.5 text-sm rounded-full bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
