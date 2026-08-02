'use client'
import { useEffect, useState } from 'react'

/** 기준 Master 테이블(master_schema_fields)에 실제로 등록된 필드 키 — 브랜드·제조사·원산지 관리, 가격 및
 *  이익 관리, 스크랩 검토 그리드 등 여러 하위 메뉴가 저마다 다른 필드 목록을 하드코딩하는 대신 이 하나의
 *  기준을 참고해, 기준 테이블에서 뺀 컬럼은 해당 메뉴에서도 자동으로 사라지게 한다. loaded 전에는
 *  필터링하지 않아야 로딩 중 잠깐 빈 목록이 보이는 깜빡임을 피할 수 있다.
 *  customKeys는 그중 커스텀 필드만 — 고정 컬럼(브랜드 등)은 이미 전용 컬럼이 있는 화면에서 중복 컬럼이
 *  생기지 않도록 구분해 둔다.
 *  labels는 field_key -> field_label(사용자가 기준 마스터테이블관리에서 직접 수정한 실제 라벨) — 코드에
 *  박아둔 FIXED_FIELD_INFO 기본 라벨은 사용자가 이 화면에서 라벨을 바꾸고 나면 더 이상 실제와 다를 수
 *  있다(예: cost_price를 "원가" 대신 "공급가"로 바꿔 쓰는 경우) — 라벨을 보여주는 모든 화면은 이 값을
 *  우선해야 스크랩 미리보기 등 다른 메뉴 컬럼이 기준 테이블과 계속 어긋나 보이던 문제가 안 생긴다. */
export function useRegisteredFieldKeys(): { keys: Set<string>; customKeys: Set<string>; labels: Map<string, string>; loaded: boolean } {
  const [keys, setKeys] = useState<Set<string>>(new Set())
  const [customKeys, setCustomKeys] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<Map<string, string>>(new Map())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/master/schema').then(r => r.json())
      .then((d: { field_key: string; field_label: string; is_custom: boolean }[]) => {
        const fields = Array.isArray(d) ? d : []
        setKeys(new Set(fields.map(f => f.field_key)))
        setCustomKeys(new Set(fields.filter(f => f.is_custom).map(f => f.field_key)))
        setLabels(new Map(fields.map(f => [f.field_key, f.field_label])))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  return { keys, customKeys, labels, loaded }
}
