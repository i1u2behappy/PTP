# 새 PC에서 실행 — backup-for-migration.ps1이 만든 백업 폴더를 복원한다.
# 미리 해둘 것: 1) git clone(또는 프로젝트 폴더 복사)로 코드 준비, 2) Docker Desktop 실행,
# 3) 이 프로젝트 폴더에서 `docker compose up -d`로 빈 DB 컨테이너 기동(스키마는 아래 덤프가 채움).

$projectPath = 'c:\Users\seyi_MOVE\Project\scrape'   # 새 PC의 실제 프로젝트 경로로 바꿀 것
$backupDir = Read-Host "백업 폴더 경로를 입력하세요 (예: C:\Users\me\Desktop\PTP-Migration-Backup_...)"

if (-not (Test-Path $backupDir)) { Write-Host "폴더를 찾을 수 없습니다: $backupDir"; exit 1 }

# 1) DB 복원 — 덤프 파일을 컨테이너 안으로 넣고 그 안에서 psql로 읽는다.
Write-Host "1/4 DB 복원 중..."
docker cp (Join-Path $backupDir 'scrape_backup.sql') scrape-postgres:/tmp/scrape_backup.sql
docker exec scrape-postgres psql -U devuser -d scrape -f /tmp/scrape_backup.sql
docker exec scrape-postgres rm -f /tmp/scrape_backup.sql

# 2) .env.local — 기존 파일이 있으면 덮어쓰기 전에 먼저 확인.
Write-Host "2/4 .env.local 복원 중..."
$envDest = Join-Path $projectPath '.env.local'
if ((Test-Path $envDest) -and -not (Read-Host "$envDest 가 이미 있습니다. 백업본으로 덮어쓸까요? (y/n)").ToLower().StartsWith('y')) {
  Write-Host "  .env.local은 건너뜁니다 — CREDENTIALS_ENCRYPTION_KEY가 기존 DB 암호화 키와 다르면 몰 로그인 비밀번호를 못 읽으니 수동으로 값을 맞춰주세요."
} else {
  Copy-Item (Join-Path $backupDir '.env.local') $envDest -Force
}

# 3) 로그인 세션/거래처 문서
Write-Host "3/4 로그인 세션/거래처 문서 복원 중..."
$profilesSrc = Join-Path $backupDir '.playwright-profiles'
if (Test-Path $profilesSrc) { Copy-Item $profilesSrc (Join-Path $projectPath '.playwright-profiles') -Recurse -Force -ErrorAction SilentlyContinue }
$docsSrc = Join-Path $backupDir 'client-docs'
if (Test-Path $docsSrc) { Copy-Item $docsSrc (Join-Path $projectPath 'public\client-docs') -Recurse -Force -ErrorAction SilentlyContinue }

# 4) 스크랩 이미지 원본
Write-Host "4/4 스크랩 이미지 복원 중 (용량이 커서 시간이 걸릴 수 있습니다)..."
$scrapedSrc = Join-Path $backupDir 'scraped'
if (Test-Path $scrapedSrc) { Copy-Item $scrapedSrc (Join-Path $projectPath 'public\scraped') -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "복원 완료. 남은 수동 작업:"
Write-Host "  - npm install (node_modules는 백업에 없음 — 새로 설치)"
Write-Host "  - Google Chrome 설치 확인 (이 앱은 실제 크롬을 직접 띄움)"
Write-Host "  - npm run dev로 정상 기동 확인"
Write-Host "  - 필요하면 Windows 작업 스케줄러에 로그온 시 scripts\start-dev-server.cmd 실행 등록"
