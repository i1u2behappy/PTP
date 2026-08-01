'use client'
import { useEffect, useState } from 'react'

/** 기준 Master 테이블(master_schema_fields)에 실제로 등록된 필드 키 — 브랜드·제조사·원산지 관리, 가격 및
 *  이익 관리 등 여러 하위 메뉴가 저마다 다른 필드 목록을 하드코딩하는 대신 이 하나의 기준을 참고해,
 *  기준 테이블에서 뺀 컬럼은 해당 메뉴에서도 자동으로 사라지게 한다. loaded 전에는 필터링하지 않아야
 *  로딩 중 잠깐 빈 목록이 보이는 깜빡임을 피할 수 있다. */
export function useRegisteredFieldKeys(): { keys: Set<string>; loaded: boolean } {
  const [keys, setKeys] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/master/schema').then(r => r.json())
      .then((d: { field_key: string }[]) => setKeys(new Set(Array.isArray(d) ? d.map(f => f.field_key) : [])))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  return { keys, loaded }
}
