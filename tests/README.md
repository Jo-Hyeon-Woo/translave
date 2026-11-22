# 테스트 실행과 점검 기록

제품 완료 기준은 SPEC.md를 따른다. 선택 실행은 작업 중 피드백이며 전체 회귀 통과를 의미하지 않는다. 자동 검증은 실제 계정·OpenAI/Gemini 추론 없이 가짜 인증/모델/응답만 쓴다.

## 실행

Node.js 24 이상. 숨긴 Electron 검사도 macOS GUI 세션이 필요하다. 일반 선택은 **quiet**, 실제 창 활성화·최대화·전체 화면은 **screen**으로 분리한다. 기능 카테고리와 실행 방식은 독립적이며 두 매핑 모두 카탈로그가 기준이다.

```sh
# 전체 Electron/전체 통합은 화면 검사까지 포함하며 다른 앱 사용을 방해할 수 있다.
npm test                       # 전체 단위
npm run test:e2e:quiet          # 전체 조용한 Electron (타입·빌드 포함)
npm run test:e2e:screen         # 명시적 실제 화면 검사 (타입·빌드 포함)
npm run test:e2e                # 기존 전체 Electron = quiet + screen
npm run test:all                # 전체 단위 + quiet + screen
npm run typecheck
npm run build
npm run format:check

# 단위 또는 Electron 한 종류, 카테고리 하나/여러 개
npm run test:select -- --unit --category pdf
npm run test:select -- --e2e --category chat
npm run test:select -- --category translation,queue
npm run test:select -- --unit --category auth --category chat

# 변경 파일을 직접 지정. 삭제/이동 전 경로도 함께 넘긴다.
npm run test:select -- --files src/main/chatgpt/batching.ts
npm run test:select -- --files src/main/chat/stream.ts src/main/chat/request.ts --list
npm run test:select -- --files README.md --list

# Git 저장소인 경우에만. 기본 HEAD 대비 staged+unstaged 및 untracked 포함.
npm run test:select -- --changed --list
npm run test:select -- --changed origin/main --list

# 관련 실제 창 검사만 명시적으로 실행하거나 미리보기
npm run test:select -- --e2e --category pdf --mode screen
npm run test:select -- --files src/renderer/src/styles.css --mode all --list

# 모든 카테고리의 quiet만; 전체(화면 포함); 도움말/매핑 검사
npm run test:select -- --all --mode quiet
npm run test:select -- --all
npm run test:select -- --help
npm run test:select -- --catalog
```

종류를 생략하면 단위+조용한 Electron을 실행한다. `--mode quiet|screen|all`은 Electron 실행 방식만 고른다. `--all`은 모든 카테고리와 두 실행 방식을 명시적으로 요청하며, `--all --mode quiet`는 화면을 제외한 전체 범위다. `npm test`는 전체 **단위** 명령이다.

`--list`는 카테고리·근거·실행 파일·방식·미실행 화면 검사와 별도 명령만 출력한다. 범위가 보수적으로 전체로 확대되어도 일반 파일/카테고리 선택은 quiet를 유지한다. 미실행 화면 검사는 통과에 포함하지 않는다. 화면 파일만 quiet로 선택하면 이유/별도 명령을 출력하고 종료 코드 2로 끝낸다(`--list`는 0). 관련 화면 검사가 없는 범주에 screen만 요청하면 오류다. 문서만 변경한 선택은 자동 테스트 미실행으로 구분한다.

파일/카테고리는 합집합으로 중복을 제거하고 Vitest/Playwright의 기존 파일 필터에 한 번 전달한다. Electron 두 방식은 서로 다른 프로젝트/파일 집합이며 전체 명령에서도 각 시나리오는 한 번만 실행된다. 직접 진단하는 `npx playwright test tests/e2e/reader.spec.ts -g 'sample PDF'`도 기본 quiet다(현재 빌드 필요). 직접 화면 실행은 `TRANSLAVE_TEST_MODE=screen npx playwright test`, 둘 다는 `TRANSLAVE_TEST_MODE=all npx playwright test`로 명시해야 한다. 프로젝트가 quiet일 때 screen 파일은 아예 수집되지 않는다.

### 실행 정책과 분류

- 일상 작업은 변경 영향에 맞춘 조용한 선택 검사, 공통 기반은 연결 범주 확대. 실제 창 동작을 바꾸면 관련 screen을 별도로 실행한다. 최종 통합·배포/테스트 구조 변경은 전체 단위+quiet+screen이 원칙이며 사용자 지정 생략은 미실행으로 남긴다. 조용한 통과를 전체 통과로 보고하지 않는다.
- `reader`의 PDF/텍스트 선택·페이지/확대·드래그·중앙/스크롤·창 크기·좁은 패널과 나머지 번역/채팅/인증/IPC/DB/테마/수식 시나리오는 quiet다. 기존 Playwright 클릭·마우스·키 입력과 assertion을 유지한다. 숨긴 창의 크기 변경은 OS 활성화/최대화를 검증하는 대신이 아니다.
- `window.screen`은 실제 포커스·최대화/복원·macOS 전체 화면 enter/leave 이벤트·좌측 여백/네이티브 창 버튼 위치·PDF 중앙을 검사한다. 기존 혼합 reader 시나리오를 이 경계에서 나눴고 `readerLayout` 준비/기하 검증을 공유한다. screen은 실제 창을 표시/활성화하며 quiet용 포커스 무시나 모의 fullscreen을 사용하지 않는다. macOS 외에서는 원래대로 미지원 skip이므로 전체 네이티브 검증 통과라고 해석하지 않는다.
- 런처는 Electron 시작 전 `TRANSLAVE_TEST_MODE`와 임시 프로필을 전달한다. pre-main `runtime.cjs`는 macOS activation policy를 accessory로 설정하고, 테스트 전용 메인 분기는 `show:false`/`focusable:false`와 ready-to-show의 show 생략을 적용한다. 숨긴 렌더러의 정상 입력·애니메이션·이미지 생성을 위해 backgroundThrottling만 테스트에서 끈다. 일반 앱/화면 검사의 네이티브 동작은 그대로다. 조용한 모드 실패 시 자동으로 표시 모드로 전환하지 않는다.
- accessory는 창을 생성할 수 있고 자동 Dock/메뉴 표시를 피하는 정책이며 활성화를 절대 금지한다는 뜻은 아니다. 따라서 최초 창 생성부터 show/focus/앱 did-become-active/최대화/전체 화면 이벤트와 실제 창 상태를 기록·검증하고 재시작/종료에도 수치만 첨부한다. 이는 다른 앱의 포커스를 직접 관찰했다는 근거와 구분한다. 다른 앱을 임의로 활성화하지 않는다. 근거: [Electron app 정책](https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos), [숨긴 창의 paint/visibility](https://www.electronjs.org/docs/latest/api/browser-window#showing-the-window-gracefully) (Electron 44.7.0, 2026-10-21 확인).
- 자동 리소스 fixture는 setup/테스트/hook 실패·시간 초과 후에도 소유한 앱/임시 프로필을 정리한다. 정상 종료가 멈추면 제한 시간 후 해당 테스트 자식 프로세스만 종료한다. 이전 시나리오 상태나 실제 사용자 프로필을 재사용하지 않는다. 조용한 창은 Chromium headless 가정으로 대체하지 않는다.

## 범주와 선택 정책

범주 ID: `pdf`, `translation`, `queue`, `chat`, `auth`, `storage`, `output`, `ui`, `tooling`(선택 규칙 자체 검증). 테스트 파일은 복수 범주를 가질 수 있다. **실제 범주·파일·변경 경로 연결은 `scripts/test-catalog.mts` 한곳에서만 관리한다.** 아래 표는 역할 설명이며 별도 실행 매핑이 아니다. 출력되는 범주는 직접 지정하거나 경로 규칙으로 선택한 범주다. 선택 파일의 다른 태그를 다시 전이 확장하지 않는다.

- 작업 중에는 바뀐 파일 또는 범주로 실행한다. IPC·preload·공유 계약은 프로세스 간 연결을 포함한다. 인증/토큰/추론 잠금은 번역과 채팅까지, 공용 SSE/완료 수집은 두 스트리밍 경로까지, SQLite는 문서·번역·채팅·설정까지 확대한다. 안전 Markdown/수식은 번역과 채팅 화면을 함께 검사한다.
- 공통 CSS/앱 조립은 관련 화면 전체를 선택한다. 의존성/잠금 파일·빌드/테스트 설정·선택 실행기/카탈로그·공용 도우미/가짜 제공자 변경은 단위/Electron 기능 범위를 전체로 선택하되 기본 quiet와 별도 screen 구분을 유지한다. `--unit`/`--e2e`로 종류를 제한한 경우에는 해당 종류 전체이며 최종 통합 전체 검사를 대신하지 않는다.
- 미매핑 소스/새 경로는 이유를 출력하고 전체로 확대한다. 새 테스트를 목록에 등록하지 않았거나 삭제된 테스트 매핑이 남으면 전체/선택 명령 모두 실행 전에 실패한다. 등록 누락을 조용히 성공 처리하지 않는다.
- 문서만 변경하면 “자동 테스트 미실행”을 출력한다. 빈 입력·잘못된 범주·선택 종류에 없는 테스트는 실패한다. 문서 완료 기준 변경의 검토 책임까지 생략하지 않는다.
- 최종 통합·배포 전에는 타입/빌드와 전체 단위·Electron을 실행한다. 테스트 실행 방식 변경도 마지막에 두 방식까지 실행하는 것이 원칙이며, 사용자 지정 생략은 PLAN에 미실행으로 남긴다. 선택 통과/전체 통과/미실행을 따로 보고한다.

## 기존 검증 점검 (2026-10-20)

수치는 변경 전 1회 실행의 실측이다. 단위는 테스트 파일 내부 경과 시간(ms, import/transform 제외), Electron은 시나리오 실행 시간 합(초)이며 전체 경과 시간과 합산 방식이 다르다. 단위 파일들은 병렬, Electron은 workers=1이다. 모든 행은 현재 제품/보존된 구현에 유효하다.

| 테스트 파일              | 기준 개수 / 시간 | 검증하는 동작·실패와 유지 근거                                                                                                     |
| ------------------------ | ---------------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| unit/extract             |          4 / 1ms | 행/2단 읽기 순서, 표 값, 빈 추출. PDF.js가 내놓는 좌표 정렬 알고리즘 경계                                                          |
| unit/library             |         3 / 11ms | 중복 등록 방지·최근 열람 정렬·원본/위치·구 DB 복원·큐 상태                                                                         |
| unit/translation         |     36 / 3,704ms | Gemini 이미지 요청/식별자·영역·JSON·축소 재시도·키/네트워크/429·취소. 비활성 구현도 보존 요구에 따라 유지                          |
| unit/translationLanguage |        18 / 24ms | 한국어 결과/영문 원문 오인 방지·코드/약어 예외·제한된 재시도. Gemini 보존 경로                                                     |
| unit/images              |        22 / 53ms | 원문 미전송·실제 바이트·영역/부분 성공·contentType·캐시·브리지 취소/늦은 응답. 표시 2건은 아래 Markdown 파일로 이동                |
| unit/budget              |        11 / 53ms | 예산 기본값/구 기본값 이행·사용자 값·재시작·7/8페이지 경계·출력 추정·캐시 재사용                                                   |
| unit/queue               |       18 / 457ms | 문서/페이지 소유권·FIFO/현재 우선·묶음 경계·중복/일시정지/설정 변경·저장 실패·부분 재개                                            |
| unit/chatgpt             |       37 / 663ms | PKCE/state/nonce/JWT·취소/시간 초과·갱신/철회·보안 저장·계정 모델·시험/실제 추론 잠금. 기본 스트림 중복은 전용 파일로 정리         |
| unit/chatgptStream       |       33 / 224ms | SSE MIME/UTF-8/개행·종료 검증·완료/오류 분류·크기 제한·안전 진단/로그. 전송 계층의 상세 경계                                       |
| unit/chatgptOutput       |        31 / 14ms | 항목/본문 인덱스·최종 스냅샷·중복·commentary/reasoning 제외·부모/항목 완료 일치                                                    |
| unit/chatgptBatching     |          5 / 3ms | 모델별 이미지/출력/바이트 추정·5/6페이지·고정 수 아님·과대 단독 페이지 거부                                                        |
| unit/chatgptQueue        |       39 / 362ms | 실제 제공자+큐+SQLite와 가짜 HTTP: 문서 매핑·묶음 축소·선점·429·계정/모델 캐시·이전 Gemini 보존                                    |
| unit/pageChat            |     23 / 2,639ms | 페이지 이력·첨부·용량·실제 delta/완료·취소/초기화/재시작·저장 실패·인증/한도·번역 양보/재개                                        |
| unit/themes              |         2 / 11ms | 지원 ID/명암 대비/의미 색상·기존 DB 이행과 재시작/캐시 보존                                                                        |
| unit/markdownMath        |         6 / 79ms | 수식/통화/코드·불완전/악성 출력·매크로/로그·메타데이터 분리·문자열/캐시 보존. GFM/별도 판독 표시 2건 수용                          |
| e2e/reader               |       7 / 12.15s | 실제 PDF.js/캔버스·선택·파일 취소/손상/재연결·페이지/확대/키보드/드래그·최소 창/실제 macOS 전체 화면·카드 전체 중앙                |
| e2e/activeChatGPT        |      14 / 52.38s | 실제 IPC/renderer→queue→DB: 가짜 로그인·백그라운드/페이지 우선·계정/모델/재시작/재번역·단일 실행·여러 페이지 매핑·기존 Gemini 이행 |
| e2e/pageChat             |       7 / 20.15s | 실제 탭/입력/키보드·첨부·페이지/문서 전환·부분 출력/취소/스크롤·DB 이력·번역 잠금 통합                                             |
| e2e/settings             |        6 / 8.32s | 단일 아코디언·빠른 전환·키보드/모션 감소·입력 보존/기본값·실제 SQLite 실패·비동기 적용 중 메뉴 전환                                |
| e2e/themes               |       5 / 21.91s | 선택≠적용·기본값·영속/실패/미지원 ID·5개 테마·포커스·PDF 픽셀/배율/위치/캐시 보존                                                  |
| e2e/math                 |       3 / 13.01s | 실제 로컬 KaTeX CSS/폰트·수식 저장/재시작·기존 완료 결과·외부 요청/로그 차단·각 테마/좁은 패널 스크롤                              |

단위와 Electron이 같은 기능을 다뤄도 서로 다른 실패를 잡는다. 단위는 조작된 프레임/토큰/오류/시간으로 경계를 빠르게 검증하고, Electron은 실제 IPC·preload·PDF.js·SQLite·키보드/스크롤/네이티브 창의 연결을 검증한다. 둘 중 하나로 완전히 대체하지 않는다. 단위 전체가 약 4초이므로 import 캐시/공유 상태 최적화를 추가하지 않았다.

## 삭제·통합 근거와 검증 보존 위치

1. `chatgpt.test.ts`의 기본 스트림 오류 9건을 분리했다. incomplete/진행 중 종료/완료 없음/잘못된 JSON/다른 page/빈 번역/누락/중복 **8건**은 `chatgptStream`의 완료/부분 종료/JSON 검증, `chatgptOutput`의 부모 상태/다른 page, `chatgptQueue`의 누락·중복·빈 결과/잘림 축소 테스트가 더 강한 조건과 저장 결과까지 다뤄 삭제했다. `response.failed`의 quota는 named error와 다른 이벤트 분기이므로 **삭제하지 않고** `chatgptStream`으로 옮겨 종료를 성공으로 오인하지 않는 검증을 유지했다. 인증/시험 기능·공용 잠금 검증은 그대로다.
2. `activeChatGPT`의 `settings single accordion, DPI drafts/failure and theme apply keep reader geometry and keyboard actions` 1건은 이미 `settings`(단일 메뉴·키보드·DPI 오류/초기화/저장·작은 창), `themes`(적용/Reader 상태 유지), `reader`(연결 대기 Space·확대/리사이즈 키보드)로 완전히 검증된다. 중복 앱/PDF 준비만 제거했다. 번역이 진행 중인 실패/계정 변경/캐시 시나리오는 모두 유지한다.
3. settings의 정확한 `0.24s` CSS 값 단정만 제거했다. 실제 메뉴 열림/닫힘·높이 0·inert·빠른 전환·모션 감소 시 `0s`/키보드 검증은 유지한다. 사용자 완료 기준인 PDF 중앙/카드 여백/전체 화면/수식 잘림 수치 검증은 유지한다.
4. images의 GFM 안전 렌더링/판독 메타데이터 분리 2건은 `markdownMath`로 옮겼다(동일 assertion). 이미지/요청과 표시 검증의 책임을 구분하며 삭제하지 않았다.
5. 6개 Electron 파일의 환경·앱 실행·임시 프로필·부트스트랩을 `helpers.ts`로 공유하고 중복 가짜 로그인 도우미를 통합했다. **각 시나리오 새 앱/프로필/DB**, 재시작은 같은 시나리오 프로필만 사용한다. suite/app 공유나 재시도/대기 확대는 하지 않는다. 공용 종료는 실패해도 앱/프로필을 정리하고 가짜 제공자/외부 요청/동시 실행/로그 카운터를 확인한다.
6. 첫 재구성 전체 검사에서 macOS 전체 화면 이벤트 대기가 시간 초과했다. 같은 작업에서 창 활성화/전체 화면을 연속 요청하던 테스트 준비를 실제 포커스 선행 조건 대기로 분리했다. 전체 화면 상태와 실제 enter/leave 이벤트를 둘 다 확인하며 renderer 상태/기하 검증도 유지한다. 임의 sleep·재시도·timeout 확대·skip으로 가리지 않았고 최종 전체에서 통과했다. 정확한 OS 내부 원인을 단정하지 않는다.

## 보안·준비 비용과 제약

- 단위는 가짜 fetch/렌더러, in-memory 또는 임시 SQLite/암호화 vault를 사용한다. OAuth 통합 단위만 앱 자체의 `127.0.0.1 /auth/callback` 서버를 연다. 네트워크 guard는 이 콜백 외의 global fetch를 거부한다. 새 외부 서버·실제 로그인은 없다. 의존성의 다른 네트워크 API까지 OS 수준에서 차단하는 도구는 아니다.
- 변경 전 reader는 main 가짜 부트스트랩 없이 임시 프로필/미연결 상태로 검사했고 다른 5개 파일은 가짜 OAuth/모델/추론을 썼다. 이제 reader도 같은 pre-main fake를 쓴다. 실행기는 소유한 임시 프로필만 허용하며 상속된 제공자 환경 변수를 제거한다. fake는 임시 경로를 재검사하고 모든 main fetch/브라우저 로그인을 가짜로 대체한다. renderer HTTP(S)는 실제 전송 전 차단하며 요청 시도를 테스트 실패로 남긴다.
- 테스트 자료는 자체 생성 PDF/수식/고정 가짜 문자열이다. 실제 사용자 앱·PDF·인증 저장소·DB를 열지 않는다. 키/토큰/이미지/본문을 진단 로그로 출력하지 않으며 화면/트레이스 등 테스트 산출물은 ignore된 `test-results/`/`playwright-report/`에만 둔다. 실제 사용자 자료를 테스트에 사용하지 않는다.
- Electron은 매번 앱/가짜 서명 키/작은 PDF를 준비하는 비용이 있다. 이를 공용 코드로 정리했지만 시나리오 간 상태 공유로 시간을 줄이지 않았다. 실행 시간은 1회 실측이며 환경/창 애니메이션에 따라 달라진다. 품질·속도·회귀 검출력 향상을 측정 없이 주장하지 않는다.
- macOS 네이티브 전체 화면 시나리오는 다른 OS에서 기존 조건에 따라 미지원이다. 실제 API 품질/한도/지연과 실제 사용자 로그인은 자동 테스트 범위 밖이다.

최종 실행 결과·전후 개수/시간·실행하지 못한 항목은 PLAN.md의 “테스트 점검·선택 실행” 기록을 따른다.
