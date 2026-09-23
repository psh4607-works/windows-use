# Windows 릴리스 검증 묶음

`scripts/verify-windows-release.ps1`은 **이전 설치 EXE → candidate 설치 EXE**를 실제로
실행하는 수동 검증 진입점이다. 제품 CLI/provider를 바꾸지 않으며 GitHub Actions를
추가하거나 활성화하지 않는다. 이전 수동 검증 기록은
[Windows client 0.2.0 verification](windows-client-verification.md)에 있다.

## 준비

- Windows 10 또는 11 **x64**, .NET Framework 4.8 이상, Windows PowerShell 5.1 x64.
- 잠금이 해제된 로그인 데스크톱의 전용 테스트 계정. SSH session 0에서는 실행하지 않는다.
  관리자 권한, OpenSSH 서버, 전역 Node/npm 설치는 필요 없다.
- 신뢰하는 이전 릴리스 EXE와 candidate EXE를 별도로 준비한다. SHA-256이 같은 파일은
  거절하고, 설치 후 manifest가 같은 payload도 업데이트 검증으로 인정하지 않는다.
  버전 문자열이 같아도 payload가 다르면 검증할 수 있다.
- 두 EXE의 원본 체크섬은 배포 경로에서 별도로 확인한다. 여기서 기록하는 EXE 해시는
  입력 식별과 실행 직전 변조 검사용이며 배포자의 서명/신뢰를 대신하지 않는다.
- 검증 소스 checkout/압축을 함께 가져온다. `scripts/windows-release/`와
  `test/windows-client-smoke.ps1`, `test/windows-ui-fixture.ps1`이 필요하다.
  클린 VM에서는 npm 설치나 소스 빌드를 하지 않는다.
- 실행 정책이 스크립트를 허용해야 한다. harness는 실행 정책, 방화벽, 서비스,
  사용자/시스템 환경 변수, 기존 예약 작업을 변경하지 않는다.
- 기존 Windows Use 앱/owner mutex, 제거 등록, Run 값, 시작 메뉴 폴더,
  기본 또는 현재 `WINDOWS_USE_HOME`의 서버 등록이 있으면 preflight에서 중단한다.
  기존 것을 자동 종료/삭제/백업 이동해서 테스트 공간을 만들지 않는다.

설치기는 사용자별 고정 등록과 owner 이름을 쓰므로 폴더 격리만으로 동시 실행을
보장할 수 없다. 테스트 중 같은 계정에서 다른 Windows Use 설치/실행 작업을 하지 않는다.
기존 계정의 설정 폴더는 기본 실행에서 수정하지 않으며, 새 `work/home`만 사용한다.
원격 호스트/별칭/계정 정보를 인자나 결과 메모에 넣을 필요가 없다.

## 실행

Windows 데스크톱 터미널에서 checkout을 현재 폴더로 둔다. `$run`은 존재하지 않는
새 디렉터리여야 한다. 아래 경로와 EXE 이름은 예시다.

```powershell
$run = Join-Path $env:TEMP ('windows-use-release-' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -File .\scripts\verify-windows-release.ps1 `
  -PreviousInstaller .\packages\previous.exe `
  -CandidateInstaller .\packages\candidate.exe `
  -RunDirectory $run
$LASTEXITCODE
Get-Content (Join-Path $run 'result.json') -Raw | ConvertFrom-Json
```

단계 순서는 다음과 같다. 실패하면 뒤의 검증 단계는 실행하지 않고 `finally` 정리를 시도한다.

1. 환경 및 보호 대상 preflight, EXE 구분/해시, 고유 작업 폴더 소유권 기록.
2. 이전 EXE 무인 설치, payload 전체 manifest hash 검증, 번들 Node 버전,
   제거 항목/바로가기/자동 시작 등록 확인.
3. 기존 client smoke 재사용: 실제 앱 시작, doctor, 접근성 pause/resume,
   설정 저장, 자동 시작 토글, 정상 종료. 로컬 SSH 리스너는 선택 검사로 남긴다.
4. 기존 WPF fixture를 고유 폴더/제목으로 시작. fixture PID와 창 제목을 확인한 뒤
   CLI snapshot의 element로 `set-value`를 실행하고 fixture 상태에서 한글/emoji 값을 확인.
   좌표 클릭/드래그/포인터 fallback은 사용하지 않는다.
5. 사용자 추가 파일과 합성 설정 보존 기준을 만들고 자동 시작을 비활성화한다.
   실행 중인 이전 client에 candidate EXE를 설치한다. owner/IPC 정상 종료,
   새 payload hash, 비활성화 선택·설정·추가 파일 보존을 확인한다.
6. candidate에서도 client smoke와 fixture 입력을 반복한다.
7. 실행 중인 candidate를 실제 제거 EXE로 제거한다. NSIS 자식 제거 프로세스가
   끝날 때까지 등록/파일을 관찰한다. 이전/새 payload, 바로가기, 등록, owner/IPC가
   사라졌는지와 사용자 파일·설정이 보존됐는지를 확인한 후 테스트 소유 폴더를 정리한다.

NSIS `/D=`는 마지막 인자로 따옴표 없이 전달한다. 공백이 있는 경로도 같은 규칙을 따른다.
[NSIS 공식 명령행 문서](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage)를 기준으로
전용 인자 테스트가 있으며, 일반 프로그램의 인자 quoting과 구분한다.

## 결과와 artifact

`result.json`과 stdout은 [v1 JSON Schema](windows-release-result.schema.json)를 따른다.
`evidence: windows`는 Windows 실행 경로를 선택했다는 뜻이다. 개별 `steps[].status`,
`environment.windows`, `requiredPassed`를 함께 읽어야 한다. 비 Windows preflight 실패도
동일한 schema로 남으며 Windows 검증 통과가 아니다. 로컬 모의 테스트는 `fixture`로 구분한다.

| 값 | 의미 |
| --- | --- |
| `steps[].status: passed` | 해당 단계의 관찰/검증 완료 |
| `failed` | 해당 단계 또는 cleanup 실패; 후속 검증 중단 |
| `skipped` / `unverified` | 수행 안 함 / 증거 미확보. pass 집계에서 제외 |
| `requiredPassed: true` | 자동화한 전체 설치 수명주기 단계와 cleanup 통과 |
| `status: incomplete` | 수동 범위가 남음. 전체 릴리스 승인 아님 |
| `status: checkpoint` | 명시적 재로그인 대기. 설치/설정을 보유 중 |
| exit **1** | 입력/환경/검증/복구 실패 |
| exit **2** | 수동 항목 미검증, checkpoint 대기 또는 cleanup-only |

대화형 wizard와 Node 없는 VM 출처는 자동 판정하지 않으므로 이 버전은 성공 exit 0을
반환하지 않는다. CI나 래퍼에서 exit 2를 pass로 바꾸지 않는다. 자동화한 수명주기만
집계해야 할 때는 `requiredPassed`를 사용하고 전체 `status`도 같이 표시한다.

공유 가능한 artifact는 **`result.json`만**이다. allowlist 필드만 담는다:
단계 ID/고정 결과 코드, OS build/환경 boolean, EXE/manifest SHA-256, package/runtime
버전, 파일/체크 수, UTC 시각. 원시 stdout/stderr, 예외/stack, UI tree/screenshot,
설치 경로, 호스트, 사용자, SSH 별칭, broker token은 넣지 않는다.

`work/`와 `.release-owner`, `run.json`, `checkpoint.json`은 **로컬 복구 상태**다.
이를 통째로 업로드하지 않는다. `work/`의 앱 상태에는 제품이 생성하는 IPC 정보가
있을 수 있다. 성공적인 정리에서는 제거되고, 소유권이 불분명하거나 프로세스가
남으면 보존한다. checkpoint에는 경로/계정 원문 없이 임의 run ID, 로그인 ID의
SHA-256, 합성 설정 hash, package hash와 완료 단계만 저장한다.

## 재로그인 opt-in / checkpoint

기본 실행은 실제 로그아웃/로그인을 `unverified`로 남긴다. 자동 로그아웃/재부팅은 없다.
실제 확인은 사용 중인 계정이 아닌 **폐기 가능한 전용 계정**에서만 아래 opt-in으로 실행한다.
이 모드는 기본 `.windows-use` 폴더가 아예 없어야 한다. 자동 시작 앱은 로그인 후 부모의
임시 환경 변수를 상속하지 않으므로, 이 모드에 한해 새 기본 폴더를 소유권 표식과 함께 만든다.

```powershell
powershell.exe -NoProfile -File .\scripts\verify-windows-release.ps1 `
  -PreviousInstaller .\packages\previous.exe `
  -CandidateInstaller .\packages\candidate.exe `
  -RunDirectory $run -ReloginCheckpoint
```

`status: checkpoint`를 확인하고 `$run` 값을 로컬에서 기록한다. 사용자가 편한 때
직접 로그아웃/로그인한다. 앱을 수동으로 시작하지 않고 자동 시작을 기다린 후, 같은 계정에서:

```powershell
powershell.exe -NoProfile -File .\scripts\verify-windows-release.ps1 -RunDirectory $run -Resume
```

새 로그인 ID, 소유권 표식, candidate manifest, 실행 파일/세션, Run 값, doctor를 확인한다.
완료한 설치/업데이트를 재실행하지 않고 제거/보존 검증과 cleanup으로 이어진다.
로그인 ID가 같은 resume는 거절하고 checkpoint 설치를 유지한다. OS Run 처리 경로를
추적하는 기능은 아니므로, 사용자가 앱을 수동 시작하면 자동 시작에 대한 증거로 쓰지 않는다.
다른 PC/계정으로 복사한 checkpoint는 복구 대상으로 사용하지 않는다.

## 중단 및 복구

모든 정상/오류 경로에서 `try/finally`로 소유한 client의 정상 종료와 공식 제거를 시도한다.
timeout 시 강제 kill하지 않는다. 소유한 installer/smoke/fixture가 아직 실행 중이면 cleanup도
실패로 기록하고 파일을 보존한다. process tree, 전역 client, 등록의 소유권이 바뀌면 작업을 멈춘다.
일반 crash/전원 차단은 `finally`를 보장할 수 없으므로 root에 `run.json`을 먼저 기록한다.

남은 테스트 프로세스가 끝난 것을 확인한 뒤 같은 계정에서 다음 명령으로 정리만 재시도한다.

```powershell
powershell.exe -NoProfile -File .\scripts\verify-windows-release.ps1 -RunDirectory $run -CleanupOnly
```

새 설치나 삭제를 무조건 반복하지 않는다. 소유권 표식 불일치, junction/symlink,
다른 client/등록, 불완전한 installer가 남긴 복구 불가능 상태에서는 보존하고 종료한다.
이때 전용 VM의 기존 snapshot으로 사용자가 복구하거나, 남은 테스트 파일/등록을 직접 검토한다.
기존 앱/설정을 자동 복원한다며 덮어쓰는 동작은 없다. 보호 대상은 처음부터 변경하지 않으며
변경한 것은 소유한 테스트 리소스뿐이다. 외부에 임의 연결을 생성하거나 인프라 비용을 발생시키지 않는다.

## 클린 VM 수동 matrix

이미 준비된 VM에 두 EXE와 검증 소스를 복사해서 위 진입점을 그대로 실행한다.
VM 생성, 비용 발생, 새로운 credential 발급은 이 묶음의 기능이 아니다.

| 환경/항목 | 증거 및 남은 작업 |
| --- | --- |
| Windows 10 x64 / Windows 11 x64 | 각 환경에서 별도 run. `environment.build`와 package hash를 기록 |
| Node 미설치 클린 VM | OS 이미지/전역 Node 미설치 여부를 사용자가 확인. `nodeOnPath: false`만으로 클린 VM이라고 판정하지 않음 |
| 로그인 자동 시작 | opt-in checkpoint/resume. 실행 전후 동일 candidate hash 확인 |
| 대화형 설치 wizard | 전용 계정/VM에서 사용자가 화면·선택·취소를 별도 확인. `/S` 결과는 wizard 검증이 아님 |
| 원격 SSH / 트레이 시각 검증 | 이 묶음의 필수 단계 밖. 기존 수동 문서 참고 |

수동 확인 결과는 환경 식별 정보가 없는 별도 기록에 남기고 `result.json`의
`unverified`를 자동으로 `passed`로 바꾸지 않는다.

## 로컬 개발 검증과 이번 변경의 한계

```sh
node --test test/windows-release.test.mjs
npm test
npm run test:native-isolated
npm run build
npm run test:bridge
dotnet build windows/WindowsUse/WindowsUse.csproj -c Release --nologo
```

PowerShell 격리 테스트는 단계 순서, 실패 전파, cleanup 실패 집계, checkpoint 재개/거절,
외부 owner/등록 보호, 링크 경로 삭제 금지, manifest 변조/경로 거절, 프로세스 nonzero/timeout,
NSIS 인자, 비 Windows preflight와 개인정보 없는 결과를 검증한다. `pwsh`가 없으면 Node의
해당 테스트는 skip으로 남으므로 검증 PC에서는 PowerShell 7을 별도로 준비한다.
실제 EXE harness는 Windows 기본 PowerShell 5.1을 사용한다.

이번 변경은 macOS의 Node/PowerShell fixture 테스트와 C# 교차 빌드/bridge 통합까지 검증했다.
격리된 Windows/VM 대상이 확인되지 않아 새 harness의 실제 EXE 설치/업데이트/제거,
Windows 10/11 UI, 실제 재로그인, wizard, Node 없는 클린 VM은 **미실행**이다.
이전 수동 smoke의 성공 기록을 새 harness 실행 증거로 재사용하지 않는다.
