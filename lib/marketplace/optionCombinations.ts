/**
 * 쿠팡 등록(items[]) 등 "옵션 조합마다 하나씩" 필요한 소비자를 위한 변환 — options(옵션별 독립 값
 * 목록)와 option_combinations(실제 옵션1↔옵션2 쌍, !specifications/cascading-option-combinations.md)
 * 로부터 실제 구매 가능한 조합 목록을 만든다.
 *
 * 2026-10-03, 쿠팡 register() 설계 중 발견: product_master.options만으로 카티전 곱을 만들면 "빨강은
 * 100/105, 파랑은 100만 있음" 같은 실제 조합을 무시하고 "빨강-105"처럼 실재하지 않는 조합까지 쿠팡에
 * 판매 가능한 것처럼 등록하게 된다. option_combinations가 있으면 그대로 쓰고, 없으면(과거 스크랩분 등
 * 이 필드가 생기기 전 데이터) 어쩔 수 없이 카티전 곱으로 근사한다 — 그 경우 approximated=true로 호출부가
 * "실제 조합과 다를 수 있다"는 걸 알고 등록 전 경고를 띄울 수 있게 한다.
 */
export interface ResolvedOptionCombinations {
  combinations: Record<string, string>[]
  /** true면 options 전체의 카티전 곱으로 근사한 것 — 실제로 없는 조합이 섞여 있을 수 있다. */
  approximated: boolean
}

export function resolveOptionCombinations(
  options: { name: string; values: string[] }[],
  optionCombinations: string[][],
): ResolvedOptionCombinations {
  const usable = options.filter(o => o.values.length > 0)
  if (usable.length === 0) return { combinations: [], approximated: false }

  // 옵션이 1개뿐이면 "조합"이라는 개념 자체가 없다 — 그 옵션의 값 하나하나가 곧 실제 항목.
  if (usable.length === 1) {
    return { combinations: usable[0].values.map(v => ({ [usable[0].name]: v })), approximated: false }
  }

  // 옵션이 정확히 2개이고 실제 조합 쌍이 있으면(캐스케이드 스캔 지원 범위, 1단계까지) 그대로 쓴다 —
  // 근사가 아니라 실측값이다.
  if (usable.length === 2 && optionCombinations.length > 0) {
    const [opt1, opt2] = usable
    return {
      combinations: optionCombinations.map(([v1, v2]) => ({ [opt1.name]: v1, [opt2.name]: v2 })),
      approximated: false,
    }
  }

  // 그 외(조합 데이터가 없거나, 옵션이 3개 이상이라 캐스케이드 스캔 범위 밖) — 카티전 곱으로 근사.
  let acc: Record<string, string>[] = [{}]
  for (const opt of usable) {
    const next: Record<string, string>[] = []
    for (const combo of acc) for (const v of opt.values) next.push({ ...combo, [opt.name]: v })
    acc = next
  }
  return { combinations: acc, approximated: true }
}
