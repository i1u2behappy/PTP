# 다른 PC로 옮기기 위한 백업 — DB 덤프 + git에 없는 로컬 전용 파일들을 한 폴더에 모은다.
# 코드 자체(git으로 관리되는 파일)는 이 백업에 포함하지 않는다 — 새 PC에서 git clone(또는 폴더 복사)으로
# 따로 가져오면 된다.

$projectPath = 'c:\Users\seyi_MOVE\Project\scrape'
$backupDir = Join-Path $env:USERPROFILE ("Desktop\PTP-Migration-Backup_" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Write-Host "백업 위치: $backupDir"

# 1) DB 덤프 — 컨테이너 안에 먼저 쓰고 docker cp로 꺼낸다(PowerShell 리다이렉션은 한글이 깨질 수 있어 피함).
Write-Host "1/4 DB 덤프 중..."
docker exec scrape-postgres pg_dump -U devuser -d scrape --no-owner --no-privileges -f /tmp/scrape_backup.sql
docker cp scrape-postgres:/tmp/scrape_backup.sql (Join-Path $backupDir 'scrape_backup.sql')
docker exec scrape-postgres rm -f /tmp/scrape_backup.sql

# 2) .env.local — API 키/암호화 키. 절대 새로 생성하지 말고 이 파일 그대로 새 PC에 옮길 것.
Write-Host "2/4 .env.local 복사 중..."
Copy-Item (Join-Path $projectPath '.env.local') (Join-Path $backupDir '.env.local') -ErrorAction SilentlyContinue

# 3) 몰별 로그인 세션 쿠키 — 없어도 동작엔 지장 없음(각 몰에 새로 로그인하면 됨), 편의상 옮김.
Write-Host "3/4 로그인 세션/거래처 문서 복사 중..."
$profilesSrc = Join-Path $projectPath '.playwright-profiles'
if (Test-Path $profilesSrc) { Copy-Item $profilesSrc (Join-Path $backupDir '.playwright-profiles') -Recurse -ErrorAction SilentlyContinue }
$docsSrc = Join-Path $projectPath 'public\client-docs'
if (Test-Path $docsSrc) { Copy-Item $docsSrc (Join-Path $backupDir 'client-docs') -Recurse -ErrorAction SilentlyContinue }

# 4) 스크랩 이미지 원본(용량이 커서 시간이 걸릴 수 있음) — DB가 경로만 저장하고 있어 이게 없으면 이미지가 다 깨짐.
Write-Host "4/4 스크랩 이미지 복사 중 (용량이 커서 시간이 걸릴 수 있습니다)..."
$scrapedSrc = Join-Path $projectPath 'public\scraped'
if (Test-Path $scrapedSrc) { Copy-Item $scrapedSrc (Join-Path $backupDir 'scraped') -Recurse -ErrorAction SilentlyContinue }

@"
PTP 마이그레이션 백업 — $(Get-Date -Format 'yyyy-MM-dd HH:mm')

포함된 것:
- scrape_backup.sql          DB 전체 덤프
- .env.local                 API 키 + CREDENTIALS_ENCRYPTION_KEY(절대 새로 만들지 말 것)
- .playwright-profiles/      몰별 로그인 세션(없어도 무방, 있으면 재로그인 안 해도 됨)
- client-docs/                거래처 업로드 문서
- scraped/                    스크랩 상품 이미지 원본

이 폴더를 통째로 새 PC로 옮긴 뒤 restore-from-migration.ps1을 실행하세요.

새 PC에 별도로 필요한 것(이 백업과 무관, 직접 설치):
- Docker Desktop
- Google Chrome (이 앱은 Playwright 번들 브라우저가 아니라 실제 설치된 크롬을 씀)
- git clone(또는 이 프로젝트 폴더 복사) 후 새 PC에서 npm install (node_modules는 옮기지 말 것)
- Windows 작업 스케줄러: 로그온 시 scripts\start-dev-server.cmd 자동 실행 등록(선택)
"@ | Out-File -Encoding utf8 (Join-Path $backupDir 'README.txt')

Write-Host "완료: $backupDir"
