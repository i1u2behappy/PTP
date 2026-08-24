import { test, expect, type Page } from '@playwright/test'

// PTP 화면이 최소한 뜨고 깨지지 않는지만 확인하는 스모크 테스트 — 기능 자체의 정확성(스크랩 결과가
// 맞는지 등)은 다루지 않는다. 로그인 이후 화면들은 실제 PTP 계정이 있어야 하므로, 환경변수
// PTP_TEST_USERNAME/PTP_TEST_PASSWORD가 없으면 그 테스트들만 건너뛴다(로그인 폼 자체 렌더링 테스트는
// 계정 없이도 항상 돈다) — CI나 다른 개발자 PC에 이 계정이 없어도 스위트 전체가 실패하지 않게 하기 위함.
const TEST_USERNAME = process.env.PTP_TEST_USERNAME
const TEST_PASSWORD = process.env.PTP_TEST_PASSWORD

async function login(page: Page) {
  await page.goto('/login')
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
