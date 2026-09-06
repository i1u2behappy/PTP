import { test, expect, type Page } from '@playwright/test'

// PTP 화면이 최소한 뜨고 깨지지 않는지만 확인하는 스모크 테스트 — 기능 자체의 정확성(스크랩 결과가
// 맞는지 등)은 다루지 않는다. 로그인 이후 화면들은 실제 PTP 계정이 있어야 하므로, 환경변수
// PTP_TEST_USERNAME/PTP_TEST_PASSWORD가 없으면 그 테스트들만 건너뛴다(로그인 폼 자체 렌더링 테스트는
// 계정 없이도 항상 돈다) — CI나 다른 개발자 PC에 이 계정이 없어도 스위트 전체가 실패하지 않게 하기 위함.
const TEST_USERNAME = process.env.PTP_TEST_USERNAME
const TEST_PASSWORD = process.env.PTP_TEST_PASSWORD

async function login(page: Page) {
  await page.goto('/login')
  // ChromeWarning(components/shell/ChromeWarning.tsx) — 이 스위트는 실제 크롬으로 도는데(스크래핑용
  // 크롬 재사용, playwright.config.ts 참고), 그 컴포넌트가 "크롬이면 엣지로 열어달라"는 모달을 항상
  // 띄워 로그인 버튼을 가리는 문제가 있었다(2026-09-02) — 확인을 눌러 닫아야 아래 로그인 버튼을 누를 수
  // 있다. localStorage에 안 남기고 매번 새로 뜨므로(시크릿 컨텍스트) 매 로그인 전에 확인한다.
  // isVisible()은 그 순간 상태만 즉시 확인할 뿐 기다려주지 않는다 — 이 모달은 리액트 하이드레이션 후
  // useEffect로 뜨므로, isVisible()이 "아직 안 떴다"고 너무 이르게 판단하고 지나친 뒤 로그인 버튼을
  // 누르려는 순간 모달이 떠서 클릭을 가로막는 경합이 실제로 재현됐다. waitFor로 실제로 기다린다 —
  // 안 뜨는 몰(엣지 등)에서는 타임아웃까지 기다렸다가 조용히 없는 걸로 처리한다.
  await page.getByRole('button', { name: '확인' }).waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => page.getByRole('button', { name: '확인' }).click())
    .catch(() => {})
  await page.getByLabel('아이디').fill(TEST_USERNAME!)
  await page.getByLabel('비밀번호').fill(TEST_PASSWORD!)
  await page.getByRole('button', { name: '로그인' }).click()
  await expect(page.getByRole('button', { name: '첫페이지로 이동' })).toBeVisible()
}

test.describe('로그인 페이지', () => {
  test('로그인 폼이 정상적으로 렌더링된다', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByAltText('ILDA:Bridge')).toBeVisible()
    await expect(page.getByText('(Product Transformation Platform)')).toBeVisible()
    await expect(page.getByLabel('아이디')).toBeVisible()
    await expect(page.getByLabel('비밀번호')).toBeVisible()
    await expect(page.getByRole('button', { name: '로그인' })).toBeVisible()
  })
})

test.describe('인증된 화면', () => {
  test.skip(!TEST_USERNAME || !TEST_PASSWORD, 'PTP_TEST_USERNAME/PTP_TEST_PASSWORD가 설정되지 않아 건너뜀')

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('로그인 후 대시보드와 사이드바가 뜬다', async ({ page }) => {
    await expect(page.getByAltText('ILDA:Bridge')).toBeVisible()
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible()
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
  })

  test('사이드바에서 Mall 상세관리 화면을 열 수 있다', async ({ page }) => {
    await page.getByRole('navigation', { name: '주 메뉴' }).getByText('Mall 상세관리').click()
    await expect(page.getByRole('heading', { name: '🏬 Mall 관리' })).toBeVisible()
  })

  test('사이드바에서 거래처 관리 화면을 열 수 있다', async ({ page }) => {
    await page.getByRole('navigation', { name: '주 메뉴' }).getByText('거래처 관리').click()
    await expect(page.getByRole('heading', { name: '🏢 거래처 관리' })).toBeVisible()
  })

  test('사이드바에서 스크래핑 화면을 열 수 있다', async ({ page }) => {
    await page.getByRole('navigation', { name: '주 메뉴' }).getByText('스크래핑').click()
    await expect(page.getByRole('heading', { name: '🔍 스크래핑 설정' })).toBeVisible()
  })
})
