<!-- Environment identifiers in this historical record were anonymized for publication on 2026-09-22. -->
# PR #3 리뷰 수정 검증

## 1차 수정본

2026-09-22, `windows-pc` Windows 11 x64에서 리뷰 수정본을 다시 설치해 확인했다.
설치 파일은 `WindowsUse-Setup-0.2.0-x64.exe`, SHA-256은
`ed61f44a119508589c6232afa1284aac5c43dda53fca328a22ecfe769f1cf648`이다.

- [설치](install.json): 실제 EXE 설치 성공, payload 36개 파일의 해시 일치, 번들 Node 24.21.0 확인.
- [Windows 회귀 검사](unit-tests.txt): 설치된 소스와 번들 Node로 관련 테스트 13개 통과.
  Windows named pipe의 동시 복구 배제, 잠금 소유자 강제 종료 후 즉시 복구,
  이전 `recovery.lock` 잔여 파일 무시, 살아 있는 소유자 보호를 확인했다.
  재개 실패 및 저장 실패 시 일시 중지 보존, 손상된 설정·등록 파일 보존과 복구 안내도 검사했다.
- [설정 창 smoke](form-smoke.json): 로그인 세션에서 전역 Node 경로를 제외하고
  실제 앱 조회, 일시 중지·재개, 연결 설정 저장, 데스크톱·로컬 SSH 연결 테스트,
  로그인 자동 시작 등록, 종료와 일시 중지 상태를 보존한 백그라운드 재실행까지 통과했다.
  보고서에 실행 시각과 설치 payload manifest 해시를 기록했다.
- [제거](uninstall.json): 클라이언트, 자동 시작·제거 등록, 테스트 예약 작업을 제거했고
  기존 수동 broker는 같은 PID로 계속 실행 중임을 확인했다.
- 로컬에서는 Node 테스트 35개 통과, Windows 전용 잠금 테스트 1개 건너뜀.
  `npm run test:bridge`, `npm run test:native-isolated`, `npm run package:windows` 통과.

복구 잠금은 시간 제한으로 파일을 삭제하는 대신 프로세스 종료 때 운영체제가 해제하는
named pipe를 사용한다. 손상된 `server.json`은 소유자의 종료를 입증할 수 없어 자동 삭제하지
않고, 모든 클라이언트 종료 후 해당 파일을 백업·제거하는 절차를 안내한다.
손상된 `settings.json`도 접근이 허용된 기본값으로 덮어쓰지 않는다.

실제 로그아웃/로그인은 수행하지 않았다. 이 회차에서 트레이 메뉴의 직접 조작,
Mac에서의 SSH 호출, 설치 중 업데이트를 다시 수행하지는 않았으며 이전 검증과 구분한다.
과거의 세 smoke JSON에도 실행 대상과 설치 파일 해시 또는 소스 패치 여부를 추가했다.

## 2차 수정본

일시 중지 저장 실패 시에도 실제 broker 접근을 차단하고 메모리 상태를 유지하도록 보완했다.
저장 실패로 재시작 시 이전 상태로 돌아갈 수 있다는 오류를 표시하며, 재개와 일시 중지 복귀가
연속 실패해도 원래 원인을 보존한다. 내부 오류 언어와 smoke 사전 검사도 정리했다.

- 설치 EXE SHA-256: `2787dd925e2d4948ead0c8fe2cb4db37b022e8863c5abc31b5af8e6abfe83a55`.
- [설치](round2/install.json): payload 36개 해시 일치, 번들 Node 24.21.0.
- [Windows 검사](round2/unit-tests.txt): 실제 broker의 저장 실패 후 접근 차단과 명시적 재개를 포함해 15개 통과.
- [사전 검사](round2/preflight.json): manifest 누락 시 앱 실행과 보고서 생성 전에 실패.
- [설정 창](round2/form-smoke.json): 1차와 같은 6개 UI·수명 주기 검사 통과. 실행 시각·manifest 해시로 실행을 구분한다.
- [제거](round2/uninstall.json): 앱·등록·테스트 작업 제거, 기존 수동 broker 유지.
- 로컬 Node 검사 37개 통과 / Windows 전용 1개 건너뜀, C#–Node bridge 검사와 설치 빌드 통과.
- Mac에서 두 실행 진입점의 Windows 전용 검사도 확인했다. Mac/Linux는 원격 SSH 호출 측으로만 지원한다.

이번에도 실제 로그아웃/로그인과 트레이 직접 조작, Mac에서의 SSH 조회는 재실행하지 않았다.

## 3차 리뷰의 파일 정리 오류 재현

제품 코드는 2차 수정본 그대로 두고 실제 파일 정리 오류를 일으키는 회귀 테스트 3개를 추가했다.
`setPaused`를 가짜 함수로 바꾸지 않고, 테스트 전용 상태 디렉터리를 임시로 일반 파일로
교체해 관찰 정리가 실패하게 했다. 인증된 IPC에 직접 요청해 다음 경우의 접근 차단을 확인했다.

- pause 저장 성공 후 관찰 정리 실패.
- pause 저장 실패와 관찰 정리 실패가 함께 발생.
- resume 성공 후 저장 실패, 이어서 pause 복귀의 관찰 정리 실패.

세 경우 모두 오류를 반환하면서 실제 IPC는 `desktop_paused`로 거절되고,
host 상태와 메모리 설정이 일시 중지로 유지됐다. `setPaused`는 실패할 수 있는 파일 작업보다
먼저 접근을 차단하므로, 파일 정리 오류가 접근 허용을 의미하지 않는다.

[Windows 검사 결과](round3/unit-tests.txt): 관련 18개 통과.
[실행 환경](round3/run.json): 이미 검증한 설치 payload와 바이트가 같은 제품 소스,
Windows에 기존 설치된 Node 24.19.0으로 추가 오류 검사를 수행했다.
대용량 런타임 재전송이 끊겨 소스와 테스트만 전송했으며 체크섬 검증 후 실행했다.
번들 Node 24.21.0의 설치·UI 검증은 2차 기록을 따른다.
로컬 전체 검사는 40개 통과 / Windows 전용 1개 건너뜀이다.
설치 파일의 SHA-256은 2차 수정본과 같다.
