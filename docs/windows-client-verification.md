# Windows client 0.2.0 verification

2026-09-22. 구현 브랜치: `feat/windows-installer`.

이 문서와 연결된 검증 자료는 공개용으로 정리했다. SSH 별칭·PC 이름·계정·세션 이름은
가상 예시이며, 실제 연결 설정이 찍힌 화면은 제외했다. `windows-pc`를 사용할 때는
자신의 기존 SSH 별칭으로 바꾼다. 정리 과정에서 Windows 검증을 다시 실행하지 않았다.

추가 검증에서 배포 EXE를 그대로 다시 설치하고 트레이 메뉴의 상태 표시·일시 중지·재개·종료까지
직접 확인했다. 자세한 결과와 캡처는 [최종 설치 파일 재검증](smoke-2026-09-22/final-recheck/README.md)을 참고한다.

## 완료한 로컬 검증

- Node 테스트 27개 통과: pause/resume, 상태·진단, 이전 관찰 무효화, 대기 요청 취소, 죽은 소유자 복구·살아 있는 소유자 보호, 한글 PC 이름을 포함한 연결 설정 검증, SSH 런타임 탐색, 체크섬·제거 파일 범위와 기존 CLI/provider 회귀 검증.
- C# ↔ 실제 Node host 통합: ready, pause/resume 응답 연계, 오류 전달, 정상 종료 후 IPC 등록 정리. Windows UI provider만 테스트용 앱 목록 응답으로 대체했다.
- Windows GUI 실행 파일: .NET Framework 4.8 대상으로 교차 빌드.
- NSIS: x64 Windows 설치 EXE 생성. Node 24.21.0 Windows ZIP의 공식 SHA-256을 검증하고 런타임·라이선스를 포함했다.

## 실제 Windows 검증

이전 SSH handshake 실패가 재시도 시 해소되어 `windows-pc`의 Windows 11 Pro x64,
.NET Framework 4.8, 로그인 세션 1에서 검증했다. 임시 설치 경로와
`WINDOWS_USE_HOME`을 사용해 기존 수동 데스크톱 서버와 상태 파일을 분리했다.

- 설치·업데이트·제거: 실제 EXE의 무인 설치 성공, 설치 payload 29개 파일의 SHA-256 일치, 번들 Node 24.21.0 실행, 바로가기·제거 항목·자동 시작 등록 확인.
- 실행 중 업데이트: 트레이 앱과 자식 broker의 정상 종료, 자동 시작 해제 선택 유지, 사용자가 설치 폴더에 추가한 파일 보존.
- 실제 클라이언트: 전역 Node/npm 경로를 제외한 환경에서 실행하고 Windows 앱 목록 조회 성공. 대상 PC의 기존 Node 설치를 제거한 것은 아니다.
- 접근성 조작: 앱 자체 창의 MSAA 이름·역할로 일시 중지, 재개, 연결 설정 저장, 연결 테스트, 자동 시작 체크박스, 종료를 실행했다. 좌표 클릭이나 마우스 이동은 사용하지 않았다.
- 일시 중지 후 데스크톱 요청은 `desktop_paused`로 거절. 재개 시 접근 복구. 종료 시 IPC 등록 정리, `--background` 재시작 시 일시 중지 상태 유지, 설치 프로그램용 `--shutdown` 성공.
- 연결 테스트 화면: 실제 데스크톱 조회와 로컬 SSH 응답 모두 성공. 별도로 Mac → SSH → 설치된 클라이언트의 `doctor`와 자체 창 snapshot도 성공했다.
- 제거: 앱 소유 파일·바로가기·자동 시작·제거 등록 제거. 설치 폴더의 사용자 추가 파일과 외부의 격리된 설정 파일 보존. 기존 수동 데스크톱 서버는 제거 전후 실행 상태 확인.

실기 테스트 중 한글 Windows PC 이름이 초기 설정 검증에서 거절되어 시작되지 않는
문제를 발견했다. 호스트 이름에 Unicode 문자·숫자를 허용하도록 수정하고 회귀 테스트와
수정된 설치본의 Windows smoke를 통과했다. 개행·공백·URL 입력은 계속 거절한다.

저장소의 `docs/smoke-2026-09-22/`에 환경 식별 정보를 정리한 UI smoke 결과,
설치 수명 주기 결과, SSH 조회 결과와 트레이 메뉴 캡처를 보관했다.
실제 연결 설정이 찍힌 앱 자체 창의 캡처는 공개 자료에서 제외했다. 개별 smoke JSON의
`unverified`는 해당 스크립트 단독으로 확인하지 않은 범위이며, 별도 설치·SSH 검증은
위 결과를 따른다. 기존 수동 서버의 PID는 작업 중 바뀌었지만 이 테스트에서는 해당
서버의 파일·예약 작업을 수정하거나 재시작하지 않았다.

## 남은 검증 범위

- 실제 로그아웃/로그인: 사용 중인 세션을 끊지 않기 위해 수행하지 않았다. Run 등록과 `--background` 재실행까지만 확인했다.
- 설치 마법사의 대화형 화면: 실제 설치·업데이트·제거는 `/S` 무인 모드로 검증했다.
- Windows 10과 Node가 전혀 설치되지 않은 별도 클린 VM: 이번 대상은 Windows 11이며 Node가 PATH에 없는 조건으로 검증했다.

## 검증 재현

기존 수동 `serve` 및 다른 사용자의 창을 먼저 확인한다. 기존 서버나 세션을 임의로 중단하지 않는다.

1. 설치 EXE를 실행한다. 설치 경로·제거 항목·로그인 자동 실행 등록을 확인한다. 무인 설치는 `/S`, 격리 경로는 마지막 인자 `/D=<전용 경로>`로 지정한다.
2. 테스트 전에 트레이 앱을 종료한 뒤 같은 로그인 세션에서 소스 checkout의 `test/windows-client-smoke.ps1`을 실행한다. 이 스크립트는 자체 임시 상태 디렉터리와 앱 창만 사용하고 기존 자동 실행 값을 복원한다.

```powershell
./test/windows-client-smoke.ps1 `
  -ClientDirectory "$env:LOCALAPPDATA/Programs/WindowsUse" `
  -ReportPath "$env:TEMP/windows-use-client-smoke-result.json"
```

SSH로 진입한 프로세스는 세션 0일 수 있다. 그 경우 동일 사용자의 임시 작업 스케줄러 작업을 `Interactive` / `Limited`로 등록해 위 스크립트를 로그인 세션에서 실행하고, 검증 후 그 임시 작업만 제거한다. ExecutionPolicy나 다른 보안 설정을 바꾸지 않는다.

3. 트레이 앱을 정상 실행한 뒤 Mac에서 `windows-use doctor --host windows-pc`와 `windows-use apps --host windows-pc`를 실행한다. 격리 테스트는 `--remote-dir`와 원격 프로세스의 `WINDOWS_USE_HOME`을 같은 테스트 경로에 맞춘다.
4. 실제 로그아웃/로그인은 사용자 작업을 끊으므로 일정이 허용될 때 별도로 검증한다. Run 등록 확인이나 `--background` 실행만으로 로그인 후 성공을 주장하지 않는다.
5. 설치 폴더에 사용자 추가 파일 하나를 둔 뒤 제거한다. 앱 파일·바로가기·자동 실행·제거 등록은 없어지고 사용자 추가 파일과 `%USERPROFILE%/.windows-use/settings.json`은 보존되는지 확인한다.

릴리스 파일별 SHA-256은 `release/*.sha256`, 설치 payload 파일별 해시는 `release/windows-x64/package-manifest.json`에 있다. 배포 EXE는 아직 코드 서명하지 않았다.
