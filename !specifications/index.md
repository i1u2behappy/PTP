# 스펙 문서 색인

`!specifications/` 아래 요구사항/버그수정 기록을 주제별로 묶은 Foam 허브 노트입니다. `[[문서명]]`을
Ctrl(⌘)+클릭하면 바로 이동하고, 그 문서를 열어두면 오른쪽 "Foam" 패널(또는 하단 Backlinks)에 이
색인 노트가 역링크로 잡힙니다. 왼쪽 탐색기의 Foam "Graph" 뷰(명령 팔레트 → `Foam: Show Graph`)를 열면
전체 문서가 서로 어떻게 연결되는지 한눈에 볼 수 있습니다.

새 스펙 문서를 추가하면 이 노트에도 알맞은 분류로 한 줄 추가해주세요 — 분류는 엄격한 기준이 아니라
탐색 편의를 위한 것이니, 애매하면 가장 가까운 곳에 넣으면 됩니다.

## 스크래핑 · 카테고리 탐지

- [[cascading-option-combinations]] — 옵션1↔옵션2 실제 조합 스크랩
- [[extraction-accuracy-fixes]] — 추출 정확도 개선(공급가/카테고리·브랜드/재고/배송비)
- [[ai-mode-scraping]] — AI모드 스크래핑
- [[ai-mode-gemini-provider]] — AI모드 스크래핑 전용 Gemini 전환
- [[ai-detection-local-ollama-migration]] — 카테고리/정렬 옵션 AI 감지 로컬 Ollama 이관
- [[scrape-preview-grid-columns]] — 스크랩 미리보기 그리드 컬럼 구성
- [[scrape-preview-catalog-count-and-target-ui]] — 미리보기 카테고리 개수 정확도 + 스크랩 대상 UI
- [[preview-catalog-widget-count-inflation]] — 미리보기 개수 부풀림(위젯 오염) 수정
- [[scrape-adjustment]] — 프롬프트 기반 추출 규칙 학습 + 재적용
- [[scraping-control-and-retry]] — 중지 / 실패 상품만 재수집 / 로그인 창 유지
- [[scraper-panel-progress-bar-and-session-restore]] — 진행률 막대 + 완료 세션 복원
- [[scraper-panel-category-grid-fixes]] — 카테고리 전체선택/미리보기 그리드 개선
- [[category-checklist-persistence-and-tracking]] — 카테고리 목록 탭전환 유지 + 완료/제외 표시
- [[category-discovery-textless-menu-and-preview-accuracy]] — 카테고리 불러오기 누락 + 미리보기 부정확
- [[devmode-guidance-clarity-and-repeatable-category-capture]] — 개발자모드 안내 + 카테고리 반복 수집
- [[mall-profile-baseline]] — Mall 스크랩 기본정보(Baseline Profile) + 변동 알림

## 확정 · 이미지 · 스크랩 Raw 확인

- [[confirm-creates-product-master]] — "확정"이 product_master까지 실제로 생성
- [[image-download-pipeline-fixes]] — 이미지 다운로드 파이프라인 + 세션별 폴더 구조
- [[staging-grid-show-only-selected]] — "선택한 것만 보기" 토글
- [[staging-grid-export-wysiwyg]] — 옵션 컬럼 고정 위치 + 엑셀 다운로드 WYSIWYG
- [[staging-review-grid-confirm-toggle]] — 확정 상태 표시/정렬 + 되돌리기 + 그룹별 일괄선택
- [[products-list-session-merge]] — "스크랩 Raw 확인"에서도 세션 선택 병합
- [[scrape-session-grid-and-merge]] — 세션 그리드 고도화 & 세션 병합/분할
- [[transient-error-grace-period-and-merge-progress]] — 일시적 요청 실패 유예시간 + 확정 진행률 표시

## 마이그레이션 · Transform · 상품마스터

- [[continuous-migration]] — 마이그레이션3_연속관리
- [[bulk-migration-parallelization]] — 마이그레이션/연속관리 대량 처리 병렬화
- [[transform-as-is-to-be-migration]] — 마이그레이션2_Transform AS-IS/TO-BE 3단계
- [[custom-fields-transform-bulk-reapply]] — 거래처별 커스텀 필드 + Transform 일괄적용
- [[migration-submenu-scope-picker]] — 거래처/몰/세션 스코프 일원화
- [[master-schema-submenu]] — "기준 Master 테이블 관리" 신설
- [[master-table-driven-column-consistency]] — 기준 마스터테이블이 다른 화면 컬럼의 기준
- [[sales-code-recipe]] — 판매관리코드 관리(순차 스텝 레시피)
- [[coupang-category-profile-mapping]] — 쿠팡 카테고리별 옵션·고시정보 슬롯 매핑
- [[marketplace-formats/coupang]] — 쿠팡(Wing) 대량등록 엑셀 양식 분석
- [[marketplace-formats/reference-domesin-productdb]] — 참고 아키텍처: 도매의신 "상품DB다운" 페이지

## 로그인 · Mall 관리

- [[ptp-login]] — PTP 자체 로그인
- [[mall-management-updates]] — Mall 관리/스크래핑 설정 UX 개선 모음
- [[manual-login-required-malls]] — WebAuthn/Windows Hello "직접로그인 필수" 몰
- [[concurrent-execution-guard]] — 몰별(siteId) 동시 실행 방지(withSiteLock)
- [[login-step-server-restart-reconciliation]] — 서버 재시작 후 로그인 상태 오표시 수정
- [[open-source-url-preferring-chrome]] — 상품 원본 URL을 Chrome(또는 Edge)으로 열기

## 인프라 · 서버 · 시스템

- [[docker-db-server-health-check]] — Docker/DB/PTP 서버 상태 확인 + 재시작 버튼
- [[db-missing-indexes-fix]] — DB 인덱스 누락 성능 저하 진단/수정
- [[db-migration-deadlock-fix]] — initDb() 마이그레이션 데드락 수정
- [[dev-server-autostart-on-logon]] — 로그온 시 dev 서버 자동 기동
- [[restart-script-log-redirection]] — 재시작 후 새 프로세스 로그 끊김 수정
- [[scrape-memory-orphan-cleanup-and-concurrency-mode]] — orphan Chrome 정리 + 동시 처리 전환
- [[sharp-duplicate-version-dll-conflict]] — sharp 중복 버전 Windows DLL 충돌
- [[back-navigation-trap-no-longer-forces-dashboard]] — 뒤로가기 트랩이 화면 강제 이동시키던 문제

## UI 공통 · 기타

- [[permission-management]] — 권한관리(설정 메뉴)
- [[toggle-button-visual-convention]] — 토글 버튼 vs 주 액션 버튼 시각 구분
- [[product-detail-popup-modal]] — 상품/상품마스터 상세를 팝업으로
