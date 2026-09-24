import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { diffQueryParams, looksLikeSortLabel, resetToFirstPage, deriveCategoryUrlPattern, scanCategoryMenuFromHtml, deriveDetailUrlPattern, LOGOUT_URL_RE, ACCOUNT_UNSAFE_URL_RE, classifySessionLossSignal, isBrokenPlaceholderCategoryName, isNonCategoryCandidate } from '../../lib/scraper'

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

  // 실제 재발 사고(모자사러, 2026-09-04): pathname이 같아도(카페24 product/list.html은 모든 카테고리가
  // 같은 경로) cate_no만 다르면 정렬이 아니라 완전히 다른 카테고리다. "신상품" 카테고리 메뉴 링크가
  // SORT_KEYWORD_PATTERN(신상)에 걸려 정렬 후보로 들어왔을 때, 이 가드가 없으면 {cate_no:'51'}을 정렬
  // 옵션으로 잘못 저장해 실제 스크랩 시 정렬 대신 엉뚱한 카테고리로 튕겨나가는 문제가 있었다.
  it('cate_no(카테고리 식별자)만 다르면 다른 카테고리로 보고 null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/product/list.html?cate_no=24',
      'https://mall.com/product/list.html?cate_no=51',
    )
    expect(diff).toBeNull()
  })

  it('category 파라미터도 같은 이유로 정렬 차이에서 제외한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/goods_list.php?category=031001',
      'https://mall.com/goods_list.php?category=031002&sort=price',
    )
    expect(diff).toEqual({ sort: 'price' })
  })

  it('cate_no와 진짜 정렬 파라미터가 함께 다르면 정렬 파라미터만 남긴다', () => {
    const diff = diffQueryParams(
      'https://mall.com/product/list.html?cate_no=24',
      'https://mall.com/product/list.html?cate_no=51&sort_method=5',
    )
    expect(diff).toEqual({ sort_method: '5' })
  })

  it('쿼리파라미터가 완전히 같으면(변화 없음) null을 반환한다', () => {
    const diff = diffQueryParams('https://mall.com/list.php?cate_no=1', 'https://mall.com/list.php?cate_no=1')
    expect(diff).toBeNull()
  })

  // 실제 재발 사고(도매의신, 2026-09-18): "실제 화면(목록/상세)이 어느 쪽인지"를 pathname이 아니라
  // 쿼리파라미터 값으로 넘기는 몰(?p=xxx.html)에서, 홈 화면 "인기상품" 위젯의 상품 링크(상세페이지로
  // 이동)가 pathname은 같고 쿼리만 다르다는 이유로 정렬 옵션 10개로 잘못 저장됐다. 값이 페이지 파일명
  // 처럼 생겼으면(sort 값(asc/price_low 등)일 수 없음) 화면 자체가 바뀐 것으로 보고 전체를 무효화한다.
  it('바뀐 파라미터 값이 페이지 파일명처럼 생기면(다른 화면으로 이동) null을 반환한다', () => {
    const diff = diffQueryParams(
      'https://mall.com/shop.html?p=best_list.html',
      'https://mall.com/shop.html?p=search4_itemdetail.html&q=TV100197',
    )
    expect(diff).toBeNull()
  })

  it('페이지 파일명 값이 진짜 정렬 파라미터와 함께 와도 전체를 무효화한다(다른 파라미터로 착각해 살리지 않음)', () => {
    const diff = diffQueryParams(
      'https://mall.com/shop.html?p=best_list.html',
      'https://mall.com/shop.html?p=search4_itemdetail.html&sort=price',
    )
    expect(diff).toBeNull()
  })

  it('잘못된 URL이면 예외 대신 null을 반환한다', () => {
    expect(diffQueryParams('not a url', 'https://mall.com/list.php')).toBeNull()
  })
})

// looksLikeSortLabel — 2026-08-23 펫투비 실사용 중 발견한 사고(카테고리 사이드바 링크 "간식"/"배변용품"을
// 로컬 Ollama가 정렬 옵션으로 잘못 골라 그대로 저장)를 재현하지 않는지 고정해두는 회귀 테스트.
describe('looksLikeSortLabel', () => {
  it.each(['낮은가격', '높은가격순', '신상품', '인기순', '판매량순', '리뷰많은순', '할인순', '판매순', '상품명순'])(
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

// classifySessionLossSignal — 정글북 실사용 확인(2026-09-15, 사용자 지적: "로그인이 끊겼다는 내용은
// 맞는거야?" → "이런 몰의 경우 메시지를 수정해. 몰 특성 때문에 그렇다는 내용으로") — 로그인 여부를
// 화면에 전혀 드러내지 않는 몰은 로그인 시도 직후(분석 시작 전)에도 이미 신호가 false라, "분석 도중
// 끊겼다"와 구분해야 한다.
describe('classifySessionLossSignal', () => {
  it('시작 시점부터 신호가 없었으면(몰 특성) unavailable', () => {
    expect(classifySessionLossSignal({ loggedInAtStart: false, loggedInAtEnd: false, hubExpansionHitLoginWall: false })).toBe('unavailable')
  })

  it('시작 시점엔 신호가 있었는데 끝에 사라졌으면 진짜로 lost', () => {
    expect(classifySessionLossSignal({ loggedInAtStart: true, loggedInAtEnd: false, hubExpansionHitLoginWall: false })).toBe('lost')
  })

  it('시작 시점을 확인 안 했어도(null, 로그인 정보 없음 등) 끝에 false면 안전하게 lost로 본다', () => {
    expect(classifySessionLossSignal({ loggedInAtStart: null, loggedInAtEnd: false, hubExpansionHitLoginWall: false })).toBe('lost')
  })

  it('카테고리 확장 중 실제로 로그인 벽을 만났으면 시작 신호와 무관하게 항상 lost', () => {
    expect(classifySessionLossSignal({ loggedInAtStart: false, loggedInAtEnd: false, hubExpansionHitLoginWall: true })).toBe('lost')
    expect(classifySessionLossSignal({ loggedInAtStart: true, loggedInAtEnd: true, hubExpansionHitLoginWall: true })).toBe('lost')
  })

  it('끝에 로그인됨(true)이거나 검사 자체가 실패(null)면 ok', () => {
    expect(classifySessionLossSignal({ loggedInAtStart: false, loggedInAtEnd: true, hubExpansionHitLoginWall: false })).toBe('ok')
    expect(classifySessionLossSignal({ loggedInAtStart: false, loggedInAtEnd: null, hubExpansionHitLoginWall: false })).toBe('ok')
  })
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

// 로그인 세션을 끊는 링크 판정 — "카테고리 메뉴를 찾으려고 헤더를 더듬다가 로그아웃을 눌러버리는"
// 사고가 이 프로젝트에서 네 번 반복됐다(걸스굽 2026-09-01 / 오토카필 2026-09-06 / 투비즈온 2026-09-12
// 비전 클릭 / 투비즈온 2026-09-13 헤더 아이콘 전수클릭). 어느 몰이든 통하도록 "몰별 URL"이 아니라
// 패턴으로 막고 있으므로, 실제로 쓰이는 몰 솔루션들의 로그아웃 URL 형태를 여기에 고정해둔다.
describe('LOGOUT_URL_RE (세션을 끊는 링크 판정)', () => {
  it('국내 몰 솔루션들이 실제로 쓰는 로그아웃 URL 형태를 잡아낸다', () => {
    const logoutUrls = [
      'https://www.tobizon.co.kr/mall/member/logout.php',       // 코워크몰(투비즈온)
      'http://www.autocarfeel.co.kr/member/logout.php?returnUrl=', // 오토카필 — 실제 사고 URL
      'https://girlsgoob.cafe24.com/member/logout.html',        // 카페24
      'https://mall.com/shop/member.html?type=logout',          // 메이크샵
      'https://mall.com/member/log_out.asp',
      'https://mall.com/signout',
      'https://mall.com/auth/sign-out',
    ]
    logoutUrls.forEach(u => expect(LOGOUT_URL_RE.test(u)).toBe(true))
  })

  it('로그인/일반 카테고리 링크는 막지 않는다 — 오탐하면 진짜 카테고리가 통째로 사라진다', () => {
    const safeUrls = [
      'https://www.tobizon.co.kr/mall/goods/goods_list.php?ctno=007',
      'https://girlsgoob.cafe24.com/product/list.html?cate_no=80',
      'https://www.tobizon.co.kr/mall/member/login.php',        // 로그인은 막으면 안 된다
      'https://mall.com/member/join.html',
      'https://mall.com/goods/catalog?logouts=1',               // "logout"이 낱말 경계 없이 이어지는 경우
    ]
    safeUrls.forEach(u => expect(LOGOUT_URL_RE.test(u)).toBe(false))
  })
})

describe('ACCOUNT_UNSAFE_URL_RE (클릭/방문 후보에서 뺄 계정·주문 링크)', () => {
  it('헤더 우측 유틸리티 영역의 계정/주문 링크를 잡아낸다', () => {
    const unsafe = [
      'https://www.tobizon.co.kr/mall/member/logout.php',
      'https://www.tobizon.co.kr/mall/order/cart.php',
      'https://www.tobizon.co.kr/mall/mypage/order_list.php',
      'https://girlsgoob.cafe24.com/member/login.html',
    ]
    unsafe.forEach(u => expect(ACCOUNT_UNSAFE_URL_RE.test(u)).toBe(true))
  })

  it('상품 목록 URL은 후보로 남긴다', () => {
    expect(ACCOUNT_UNSAFE_URL_RE.test('https://www.tobizon.co.kr/mall/goods/goods_list.php?ctno=011')).toBe(false)
    expect(ACCOUNT_UNSAFE_URL_RE.test('https://girlsgoob.cafe24.com/product/list.html?cate_no=80')).toBe(false)
  })
})

// 플랫폼 프로필에 없는 몰(platform=unknown)은 상품 상세 URL 패턴이 없어, 상품 링크 판별이 "이미지를
// 감싼 <a>는 전부 상품"이라는 폴백에 의존했다 — 그 결과 미리보기 표본이 로고(/index.php)나 회사소개
// (/mall/service/company_intro.php)로 잡히고 개수도 부풀었다(2026-09-13, 투비즈온). 목록에서 한 번
// 학습해 기억해두면 개수/미리보기/스크랩이 전부 같은 기준을 쓴다 — 잘못 학습하면 그 몰 상품을 통째로
// 놓치므로 "근거가 부족하면 null"이 이 함수의 핵심 규칙이다.
describe('deriveDetailUrlPattern', () => {
  const tobizon = [1, 2, 3, 4, 5].map(i => `https://www.tobizon.co.kr/mall/goods/goods_view.php?goodsno=${i}`)

  it('과반수가 공유하는 "경로+쿼리키"를 패턴으로 만든다', () => {
    const pattern = deriveDetailUrlPattern(tobizon)
    expect(pattern).toBeTruthy()
    const re = new RegExp(pattern!)
    tobizon.forEach(u => expect(re.test(u)).toBe(true))
  })

  it('학습한 패턴은 상품이 아닌 링크를 걸러낸다 — 이게 이 기능의 목적이다', () => {
    const re = new RegExp(deriveDetailUrlPattern(tobizon)!)
    expect(re.test('https://www.tobizon.co.kr/index.php')).toBe(false)
    expect(re.test('https://www.tobizon.co.kr/mall/service/company_intro.php')).toBe(false)
    expect(re.test('https://www.tobizon.co.kr/mall/goods/goods_list.php?ctno=065')).toBe(false)
  })

  it('표본이 적거나 제각각이면 null — 잘못된 패턴보다 "모름"이 안전하다', () => {
    expect(deriveDetailUrlPattern(tobizon.slice(0, 2))).toBeNull()
    expect(deriveDetailUrlPattern([
      'https://m.com/a.php?x=1', 'https://m.com/b.php?y=2', 'https://m.com/c.php?z=3',
      'https://m.com/d.php?w=4', 'https://m.com/e.php?v=5',
    ])).toBeNull()
  })

  it('쿼리 없이 경로에 상품번호가 들어가는 몰은 숫자를 일반화한다', () => {
    const pattern = deriveDetailUrlPattern([1, 2, 3, 4].map(i => `https://m.com/product/${i}`))
    expect(pattern).toBeTruthy()
    const re = new RegExp(pattern!)
    expect(re.test('https://m.com/product/77')).toBe(true)
    expect(re.test('https://m.com/company_intro')).toBe(false)
  })

  it('임의 입력에서도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.array(fc.string(), { maxLength: 20 }), (urls) => {
      expect(() => deriveDetailUrlPattern(urls)).not.toThrow()
    }))
  })
})

// 빈 배너 위젯의 미렌더링 템플릿 토큰/placeholder 앵커 텍스트가 "직전 결과 대조" 복구에서 href만 보고
// (상품이 있다) 되살아나 영원히 안 없어지던 문제(도매신 실사용 확인, 2026-09-17: "WOMEN SHOES > 링크 >
// 링크"/"WOMEN SHOES > {$js-banner}")를 막는 판정.
describe('isBrokenPlaceholderCategoryName', () => {
  it('경로 끝(리프)이 정확히 "링크"뿐이면 깨진 배너로 본다', () => {
    expect(isBrokenPlaceholderCategoryName('WOMEN SHOES > 링크 > 링크')).toBe(true)
    expect(isBrokenPlaceholderCategoryName('링크')).toBe(true)
  })

  it('미렌더링 템플릿 토큰이 이름에 남아있으면 깨진 배너로 본다', () => {
    expect(isBrokenPlaceholderCategoryName('WOMEN SHOES > {$js-banner}')).toBe(true)
    expect(isBrokenPlaceholderCategoryName('%7B%24js-href%7D')).toBe(true)
  })

  it('진짜 카테고리 이름은 그대로 통과시킨다', () => {
    expect(isBrokenPlaceholderCategoryName('WOMEN SHOES > 부츠/털신발')).toBe(false)
    expect(isBrokenPlaceholderCategoryName('링크모음')).toBe(false) // 리프 전체 일치만 걸러낸다
  })

  it('임의 입력에서도 예외를 던지지 않는다', () => {
    fc.assert(fc.property(fc.string(), s => { expect(() => isBrokenPlaceholderCategoryName(s)).not.toThrow() }))
  })
})

// 이름/경로/깨진 배너 판정 3가지를 한 곳에 묶은 공용 게이트 — 카테고리 탐지 파이프라인 곳곳(비전/AI/DOM
// 스캔/하위 카테고리 확장)에 각자 따로 있던 필터 중 하나(expandCategoryChildren)가 빠뜨려 실제 사고가
// 났다(도매신, 2026-09-17: "하위 카테고리"로 WOMEN SHOES를 펼쳤더니 "샘플 기획전"/깨진 배너가 딸려옴).
describe('isNonCategoryCandidate', () => {
  it('"기획전" 라벨은 경로가 goods_exhibit이 아니어도 걸러낸다', () => {
    expect(isNonCategoryCandidate('샘플 기획전', 'https://m.com/product/project.html?cate_no=104')).toBe(true)
  })

  it('깨진 배너 placeholder도 걸러낸다', () => {
    expect(isNonCategoryCandidate('링크', 'https://m.com/_wg/import/sub/page_01.html')).toBe(true)
  })

  it('게시판 경로도 걸러낸다', () => {
    expect(isNonCategoryCandidate('공지사항 아닌 척', 'https://m.com/board/list.php')).toBe(true)
  })

  it('진짜 카테고리는 통과시킨다', () => {
    expect(isNonCategoryCandidate('스니커즈/슬립온', 'https://m.com/product/list.html?cate_no=106')).toBe(false)
  })
})
