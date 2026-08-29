import { describe, it, expect } from 'vitest'
import { diffQueryParams, looksLikeSortLabel, resetToFirstPage, deriveCategoryUrlPattern, scanCategoryMenuFromHtml } from '../../lib/scraper'

// diffQueryParams는 "카테고리별 정렬기준 설정" 기능의 핵심 — 정렬 후보 링크가 baseUrl과 같은 경로에서
// 쿼리파라미터만 다른지 확인해, 다른 카테고리/상품 상세로 튀는 링크를 걸러낸다.
describe('diffQueryParams', () => {
  it('같은 pathname에서 쿼리파라미터 차이만 뽑아낸다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/list.php?cate_no=1&sort=price',
    )
    expect(diff).toEqual({ sort: 'price' })
  })

  it('pathname이 다르면(카테고리/상품 상세로 이동) null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/goods_view.php?goodsno=123',
    )
    expect(diff).toBeNull()
  })

  it('origin이 다르면 null을 반환한다', () => {
    const diff = diffQueryParams('https://mall.com/list.php', 'https://other.com/list.php?sort=price')
    expect(diff).toBeNull()
  })

  it('page 파라미터 차이만 있으면 정렬과 무관해 null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/list.php?cate_no=1',
      'https://mall.com/list.php?cate_no=1&page=2',
    )
    expect(diff).toBeNull()
  })

  it('쿼리파라미터가 완전히 같으면(변화 없음) null을 반환한다', () => {
    const diff = diffQueryParams('https://mall.com/list.php?cate_no=1', 'https://mall.com/list.php?cate_no=1')
    expect(diff).toBeNull()
  })

  it('잘못된 URL이면 예외 대신 null을 반환한다', () => {
    expect(diffQueryParams('not a url', 'https://mall.com/list.php')).toBeNull()
  })
})

// looksLikeSortLabel — 2026-08-23 펫투비 실사용 중 발견한 사고(카테고리 사이드바 링크 "간식"/"배변용품"을
// 로컬 Ollama가 정렬 옵션으로 잘못 골라 그대로 저장)를 재현하지 않는지 고정해두는 회귀 테스트.
describe('looksLikeSortLabel', () => {
  it.each(['낮은가격', '높은가격순', '신상품', '인기순', '판매량순', '리뷰많은순', '할인순'])(
    '"%s"는 정렬 라벨로 인정한다', (text) => {
      expect(looksLikeSortLabel(text)).toBe(true)
    },
  )

  it.each(['간식', '배변용품', '미용용품', '목욕용품', '위생/의약부외품', '브랜드사료'])(
    '"%s"는 정렬 라벨이 아니다(카테고리명 오탐 방지)', (text) => {
      expect(looksLikeSortLabel(text)).toBe(false)
    },
  )
})

describe('resetToFirstPage', () => {
  it('page 쿼리파라미터를 제거한다', () => {
    expect(resetToFirstPage('https://mall.com/list.php?cate_no=1&page=3')).toBe('https://mall.com/list.php?cate_no=1')
  })

  it('page 파라미터가 없으면 원본 그대로 반환한다', () => {
    expect(resetToFirstPage('https://mall.com/list.php?cate_no=1')).toBe('https://mall.com/list.php?cate_no=1')
  })

  it('잘못된 URL이면 원본 문자열을 그대로 반환한다', () => {
    expect(resetToFirstPage('not a url')).toBe('not a url')
  })
})

describe('deriveCategoryUrlPattern', () => {
  it('과반수 URL에 공통된 쿼리파라미터 키로 패턴을 만든다', () => {
    const urls = [
      'https://www.sinwoo.com/shop/socks.php?cat_code=48/57/',
      'https://www.sinwoo.com/shop/knit.php?cat_code=319/320/',
      'https://www.sinwoo.com/shop/bra.php?cat_code=1/2/',
    ]
    const pattern = deriveCategoryUrlPattern(urls)
    expect(pattern).toBe('[?&]cat_code=')
    urls.forEach(u => expect(new RegExp(pattern!).test(u)).toBe(true))
  })

  it('공통 키가 과반수 미만이면 패턴을 만들지 않는다', () => {
    const urls = [
      'https://mall.com/a.php?x=1',
      'https://mall.com/b.php?y=1',
      'https://mall.com/c.php?z=1',
    ]
    expect(deriveCategoryUrlPattern(urls)).toBeNull()
  })

  it('URL이 1개뿐이면 패턴을 만들지 않는다', () => {
    expect(deriveCategoryUrlPattern(['https://mall.com/a.php?cat=1'])).toBeNull()
  })

  it('URL이 하나도 없으면 패턴을 만들지 않는다', () => {
    expect(deriveCategoryUrlPattern([])).toBeNull()
  })

  it('잘못된 URL은 건너뛰고 나머지로 패턴을 만든다', () => {
    const urls = ['not a url', 'https://mall.com/a.php?cat=1', 'https://mall.com/b.php?cat=2']
    expect(deriveCategoryUrlPattern(urls)).toBe('[?&]cat=')
  })

  it('정규식 특수문자가 포함된 키는 이스케이프한다', () => {
    // URLSearchParams가 실제로 만들어낼 일은 드물지만, 방어적으로 이스케이프 여부를 확인한다.
    const urls = ['https://mall.com/a.php?a.b=1', 'https://mall.com/b.php?a.b=2']
    const pattern = deriveCategoryUrlPattern(urls)
    expect(pattern).toBe('[?&]a\\.b=')
    expect(new RegExp(pattern!).test('https://mall.com/x.php?aXb=9')).toBe(false)
  })

  // 실사용 확인(2026-08-30, 소꿉노리) — 공지/문의 게시글이 한 번 "카테고리"로 잘못 저장되면, 그 URL들의
  // 공통 쿼리파라미터(bdId)가 "이 몰의 카테고리 패턴"으로 학습돼버려 이후 실행마다 게시판 글만 계속
  // 카테고리로 재발견하는 자기강화 오염 루프가 생겼다(발견된 "카테고리" 59개 중 59개 전부가 게시판 글).
  // board/bbs 경로의 URL은 애초에 투표 대상에서 빼서, 진짜 카테고리 URL(cateCd=)이 과반수를 차지하면
  // 그 키로 정상 학습되게 한다.
  it('board/bbs 경로 URL은 투표에서 제외한다(게시판 글이 학습되는 것을 막음)', () => {
    const urls = [
      'https://mall.com/board/view.php?bdId=notice&sno=1',
      'https://mall.com/board/view.php?bdId=notice&sno=2',
      'https://mall.com/board/view.php?bdId=qna&sno=3',
      'https://mall.com/goods/goods_list.php?cateCd=011',
      'https://mall.com/goods/goods_list.php?cateCd=017',
    ]
    expect(deriveCategoryUrlPattern(urls)).toBe('[?&]cateCd=')
  })

  it('board/bbs 경로 URL만 있으면 패턴을 만들지 않는다', () => {
    const urls = [
      'https://mall.com/board/view.php?bdId=notice&sno=1',
      'https://mall.com/bbs/board.php?bdId=qna&sno=2',
    ]
    expect(deriveCategoryUrlPattern(urls)).toBeNull()
  })
})

// 도매의신 실사용 확인(2026-08-26): 카테고리 메뉴 전체가 <a href> 없이 <li onclick="location.href='...'">
// 로만 이동하는 구형 몰 템플릿 — scanCategoryMenu(라이브 DOM)/scanCategoryMenuFromHtml(원본 HTML) 둘 다
// ownHref가 <a>를 못 찾으면 onclick 속성을 정규식으로 파싱하는 폴백을 추가했다. 브라우저 없이도 검증
// 가능한 cheerio 버전(scanCategoryMenuFromHtml)으로 실제 마크업을 그대로 재현해 회귀를 막는다.
describe('scanCategoryMenuFromHtml — onclick="location.href=...\'" 메뉴(구형 몰 템플릿)', () => {
  const html = `
    <html><body>
      <div id="div_cat" style="display:none">
        <ul>
          <li onmouseover="getsub(1);">가구/인테리어
            <ul id="subul_1" style="display:none">
              <li onclick="location.href='shop.html?p=list.html&cid=632';">DIY자재/용품</li>
              <li onclick="location.href='shop.html?p=list.html&cid=633';">조명/전등</li>
            </ul>
          </li>
          <li onmouseover="getsub(2);">디지털/가전
            <ul id="subul_2" style="display:none">
              <li onclick="location.href='shop.html?p=list.html&cid=722';">생활가전</li>
              <li onclick="location.href='shop.html?p=list.html&cid=723';">주방가전</li>
            </ul>
          </li>
        </ul>
      </div>
    </body></html>
  `
  it('<a> 없이 onclick만 있는 리프 항목의 href를 onclick에서 뽑아낸다', () => {
    const { links } = scanCategoryMenuFromHtml(html, 'https://www.domesin.com/')
    const hrefs = links.map(l => l.href).sort()
    expect(hrefs).toEqual([
      'https://www.domesin.com/shop.html?p=list.html&cid=632',
      'https://www.domesin.com/shop.html?p=list.html&cid=633',
      'https://www.domesin.com/shop.html?p=list.html&cid=722',
      'https://www.domesin.com/shop.html?p=list.html&cid=723',
    ].sort())
  })

  it('상위 항목 이름을 경로에 포함한 이름(예: "가구/인테리어 > DIY자재/용품")을 만든다', () => {
    const { links } = scanCategoryMenuFromHtml(html, 'https://www.domesin.com/')
    expect(links.some(l => l.name === '가구/인테리어 > DIY자재/용품')).toBe(true)
  })
})
