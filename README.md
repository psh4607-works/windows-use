# windows-use

Codex와 Claude Code가 Windows 앱을 조회하고 조작할 수 있게 하는 독립 CLI와
에이전트 스킬입니다. 접근성 트리로 창과 컨트롤을 읽고, 클릭·텍스트 입력·단축키를
실행한 뒤 결과를 JSON으로 돌려줍니다.

에이전트는 자신의 셸 도구로 `windows-use`를 실행합니다. 별도 에이전트 전용 앱이나
MCP 서버에 연결할 필요가 없으며, 일반 터미널에서도 같은 명령을 사용할 수 있습니다.
Windows에서 직접 실행하거나, Mac/Linux에서 기존 SSH 연결로 Windows PC를 제어합니다.

```text
Codex / Claude Code / terminal
        ↓ windows-use --host <SSH alias>
existing SSH connection → Windows CLI + bundled Node (JSON stdin)
        ↓ authenticated local named pipe
Windows Use tray client (logged-in Windows desktop)
        ↓
PowerShell UI Automation + focus helper
```

## 실행 환경

- Mac/Linux 호출 PC: Node.js 22 이상, npm, SSH 클라이언트. CLI의 런타임 npm 의존성은 없습니다.
- 에이전트는 CLI가 설치된 로컬 환경에서 셸 명령을 실행할 수 있어야 합니다. 웹 채팅에 스킬 파일만 올리는 것으로 로컬 Windows에 연결되지는 않습니다.
- Mac/Linux는 SSH 호출 측으로 지원합니다. 데스크톱 서버와 트레이 host는 실행 진입점에서 Windows만 허용합니다. 내부 테스트의 Unix socket은 제품의 Mac/Linux 데스크톱 지원을 의미하지 않습니다.
- Windows 설치 파일은 Node.js 24.21.0을 포함합니다. Windows PC에 Node.js를 별도로 설치할 필요가 없습니다.
- 설치 대상: x64 Windows 10/11, .NET Framework 4.8 이상(최신 Windows 기본 구성 요소). ARM64 설치 파일은 아직 제공하지 않습니다.
- Windows PC에는 로그인된 데스크톱에서 실행 중인 Windows Use 클라이언트가 필요합니다. 원격 제어 시에는 같은 Windows 사용자로 접속할 수 있는 SSH 연결도 필요합니다.
- Windows PC에 Codex나 Claude Code를 설치할 필요는 없습니다. 에이전트가 Windows에서 직접 실행되는 경우에는 아래의 로컬 사용 방식을 따르세요.
- 이 저장소에는 GitHub Actions 워크플로가 없습니다. 테스트·빌드는 수동으로 실행합니다.

## 1. 호출 PC에 CLI 설치

Mac/Linux에서 저장소를 내려받아 패키지를 만듭니다. 아래 예시는 소스에서 설치하는
방식이며, npm 레지스트리에 게시된 패키지를 전제로 하지 않습니다.

```sh
git clone https://github.com/psh4607/windows-use.git
cd windows-use
npm ci
npm pack
npm install --global ./psh4607-windows-use-0.2.0.tgz
windows-use --help
```

`npm pack`은 provider를 자동으로 빌드합니다. 결과에는 실행 파일, 생성된 provider, Windows 스크립트, 스킬, 문서와
라이선스가 포함됩니다. 에이전트가 사용하는 셸에서도 `windows-use --help`가 실행되는지
확인하세요. 전역 설치 대신 저장소의 CLI를 직접 실행할 수도 있습니다.
`npm pack`을 실행하지 않았다면 `npm ci` 후 `npm run build`를 먼저 실행하세요.

```sh
node ./bin/windows-use.mjs --help
```

직접 실행하는 경우에는 에이전트에 CLI 파일의 절대 경로를 알려주세요. 스킬 설치
명령은 아래에서도 이 저장소의 루트 디렉터리를 기준으로 합니다.

## 2. Windows PC 준비

설치 파일이 없다면 아래의 **Windows 설치 파일 빌드** 절차로 생성한 EXE를
대상 Windows PC에 복사하세요. Node.js가 이미 설치된 PC에서는 **수동 설치**도 가능합니다.

1. 로그인된 Windows 데스크톱에서 `WindowsUse-Setup-0.2.0-x64.exe`를 실행합니다.
2. 기본 선택된 **Windows 로그인 시 자동 시작**을 유지하고 설치합니다. 관리자 권한을 요구하지 않습니다.
3. 설치 완료 후 **Windows Use 시작**을 선택합니다. 이후에는 시작 메뉴 또는 트레이 아이콘에서 엽니다.
4. 연결 설정에 기존 SSH 연결 이름, Windows 접속 주소·사용자·포트를 입력하고 저장합니다.
5. **연결 테스트**로 데스크톱 접근과 로컬 SSH 응답을 확인합니다. 다른 PC에서의 실제 인증·통신은 아래 **3. 연결 확인과 CLI 사용**의 `doctor` 명령으로 별도 확인합니다.

- 설치 위치는 `%LOCALAPPDATA%\Programs\WindowsUse`입니다. 설치 파일에 실행 환경이 포함되므로 대상 PC에 npm을 설치할 필요가 없습니다.
- 트레이 메뉴: 실행 상태, 연결 설정, 연결 테스트, 일시 중지/재개, 종료. 설정 창의 닫기 버튼은 트레이로 숨깁니다.
- 일시 중지는 화면 조회와 입력을 거절하며 이미 시작된 작업은 마무리합니다. 재개하면 새 snapshot이 필요합니다. 중지 상태는 종료·로그인 후에도 유지됩니다.
- 일시 중지 상태를 디스크에 저장하지 못해도 현재 접근은 차단하며 저장 실패를 표시합니다. 이 경우 재시작 후에는 이전 저장 상태로 돌아갈 수 있으므로 저장 장치·권한 문제를 해결하고 일시 중지를 다시 저장하세요.
- 자동 실행은 현재 사용자의 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`에 등록합니다. 설정에서 끌 수 있습니다.
- 연결 설정은 호출 PC의 SSH 설정에 사용할 안내 정보입니다. SSH 서버·인증키·Cloudflare 터널·방화벽을 자동 설정하거나 수정하지 않습니다. 기존 SSH 사용자와 데스크톱 사용자가 같아야 합니다.
- 연결 테스트는 입력 중인 SSH 포트를 사용하고 설정을 자동 저장하지 않습니다. Windows에서 확인한 로컬 SSH 응답은 외부 네트워크나 SSH 인증 성공의 증거가 아닙니다.
- `doctor`는 원격 SSH 왕복, 인증된 IPC, 실제 앱 목록 조회를 검사합니다. 데스크톱이 중지됐거나 조회에 실패하면 종료 코드 1입니다.
- 업데이트 시 현재 트레이 앱을 정상 종료한 뒤 파일을 교체합니다. 제거는 Windows의 설치된 앱 또는 시작 메뉴에서 실행합니다. 연결 설정·기존 수동 설치·사용자 추가 파일은 보존합니다.
- 다른 `windows-use serve`가 실행 중이면 먼저 해당 소유자를 확인하고 정상 종료하세요. 설치 프로그램은 기존 수동 서버를 임의 종료하지 않습니다. 트레이는 죽은 PID의 등록만 회수하며 살아 있는 소유자는 덮어쓰지 않습니다.
- 현재 배포 EXE는 코드 서명되지 않았습니다. Windows 실기 검증 범위는 [설치 검증 기록](docs/windows-client-verification.md)을 확인하세요.

### Windows 설치 파일 빌드

빌드 PC에 Node.js 22+, .NET SDK, NSIS 3.x(`makensis`)가 필요합니다. Mac과 Windows에서 빌드할 수 있으며 빌드 도구는 설치 파일에 포함하지 않습니다.

```sh
npm ci
npm test
npm run test:bridge
npm run package:windows
```

`DOTNET`, `MAKENSIS`, `NSISDIR` 환경 변수로 빌드 도구 위치를 지정할 수 있습니다. Windows에서도 호출 실행 파일은 셸 배치 파일이 아닌 `dotnet.exe`, `makensis.exe`를 사용하세요.

`release/WindowsUse-Setup-0.2.0-x64.exe`와 SHA-256 파일이 생성됩니다. Node Windows ZIP은 버전·SHA-256을 고정하고 다운로드 및 캐시 재사용 시 검증합니다. 런타임 라이선스와 파일별 해시를 설치 파일에 포함합니다.

### 수동 설치

Node.js 22 이상이 있는 Windows PC에 배포 파일을 복사한 다음, **로그인된 Windows
데스크톱의 터미널**에서 실행합니다. 기존 파일이 있는 설치 경로는 먼저 확인하세요.

```powershell
$installDir = Join-Path $env:USERPROFILE '.windows-use/app'
New-Item -ItemType Directory -Force $installDir | Out-Null
tar -xzf .\psh4607-windows-use-0.2.0.tgz -C $installDir --strip-components=1
node (Join-Path $installDir 'bin/windows-use.mjs') serve
```

마지막 프로세스를 로그인된 Windows 데스크톱의 터미널에서 계속 실행해 둡니다.
Ctrl+C로 종료합니다. 이 수동 설치 방식은 시작 프로그램이나 Windows 서비스를 등록하지 않습니다.
SSH에서 `serve`를 시작하면 대화형 데스크톱을 사용할 수 있다는 보장이 없습니다.

다른 Windows 터미널에서 로컬 CLI를 사용하려면 `node <설치경로>/bin/windows-use.mjs`
뒤에 아래 명령을 붙이거나 패키지를 `npm install --global`로 등록하세요. 원격 호출의
`--remote-dir`에는 실제 설치 루트(그 안에 `bin/windows-use.mjs`가 있는 경로)를 지정합니다.

## 3. 연결 확인과 CLI 사용

아래의 `windows-pc`는 예시입니다. 호출 PC의 SSH 설정에 등록되어 있고 실제로 접속되는
별칭으로 바꾸세요. Windows Use는 SSH 서버나 접속 자격증명을 대신 설정하지 않습니다.

```sh
windows-use doctor --host windows-pc
windows-use apps --host windows-pc
windows-use snapshot --host windows-pc --app Notepad --session task-a
```

대상 Windows에서 메모장 등 테스트 앱을 먼저 열어 두세요. `apps` 결과의 앱 이름이나
PID를 `--app`에 넣습니다. `snapshot` 응답의 `result.snapshot.treeText`에서 입력할
요소 번호를, `result.session.observation`에서 관찰 토큰을 확인합니다.

다음 예시의 `OBSERVATION_TOKEN`과 `4`는 방금 받은 실제 토큰과 입력칸 번호로 바꿔야 합니다.
`--host`, `--app`, `--session`은 관찰할 때와 동일하게 유지하세요.

```sh
windows-use set-value --host windows-pc --app Notepad --session task-a \
  --observation 'OBSERVATION_TOKEN' --element 4 --value 'hello'
```

입력 후 반환된 스냅샷과 `result.action.verification`으로 실제 변경을 확인합니다.
다음 액션은 그 응답의 새 관찰 토큰을 사용합니다.

`--remote-dir`를 생략하면 새 설치 경로를 먼저 찾고 기존 `%USERPROFILE%/.windows-use/app`을 확인합니다. 새 설치에서는 번들 Node를 사용합니다. SSH는 기존 인증을
사용하며 새 자격증명을 만들거나 host key 검증을 끄지 않습니다. Windows 데스크톱
서버와 SSH 사용자는 동일한 Windows 계정을 사용해야 합니다.

### Windows에서 로컬로 사용

Windows 설치 파일에는 `windows-use.cmd`도 포함됩니다. PowerShell에서 다음처럼
호출할 수 있으며, 로컬 제어에는 SSH나 별도 Node.js 설치가 필요하지 않습니다.

```powershell
$windowsUse = Join-Path $env:LOCALAPPDATA 'Programs\WindowsUse\windows-use.cmd'
& $windowsUse doctor
& $windowsUse apps
& $windowsUse snapshot --app Notepad --session task-a
```

Windows에서 실행하는 에이전트에도 이 명령 경로를 알려주고 `--host`를 생략하도록
지시하세요. CLI는 Windows Use 클라이언트와 같은 Windows 사용자로 실행해야 합니다.

## 4. Codex에서 사용

저장소 루트에서 스킬 폴더를 사용자 스킬 경로로 복사합니다. 이미 같은 이름의 스킬이
있다면 먼저 내용을 확인하고, 유지할 수정 사항을 보존한 뒤 갱신하세요.

```sh
mkdir -p ~/.agents/skills
cp -R skills/windows-use ~/.agents/skills/
```

Windows PowerShell에서는 다음 명령을 사용합니다.

```powershell
New-Item -ItemType Directory -Force "$HOME/.agents/skills" | Out-Null
Copy-Item -Recurse ./skills/windows-use "$HOME/.agents/skills/"
```

로컬 Codex 세션에서 `$windows-use`를 지정하고 대상과 작업을 알려주세요.
스킬이 보이지 않으면 세션을 다시 시작하세요.

```text
$windows-use
windows-pc에 연결해서 실행 중인 앱을 조회해 줘.
메모장 창을 찾으면 스냅샷으로 입력칸을 확인하고 "hello"를 입력한 뒤 결과를 확인해 줘.
```

프로젝트에만 적용하려면 `skills/windows-use`를 프로젝트의 `.agents/skills/windows-use/`로
복사할 수 있습니다. 경로와 검색 범위는 [Codex 스킬 문서](https://learn.chatgpt.com/docs/build-skills)를 참고하세요.

## 5. Claude Code에서 사용

같은 스킬 폴더를 Claude Code의 사용자 스킬 경로로 복사합니다. 기존 설치가 있으면
위와 같이 내용을 확인한 뒤 갱신하세요.

```sh
mkdir -p ~/.claude/skills
cp -R skills/windows-use ~/.claude/skills/
```

Windows PowerShell에서는 다음 명령을 사용합니다.

```powershell
New-Item -ItemType Directory -Force "$HOME/.claude/skills" | Out-Null
Copy-Item -Recurse ./skills/windows-use "$HOME/.claude/skills/"
```

로컬 Claude Code 세션에서 다음과 같이 요청하세요.

```text
/windows-use windows-pc의 실행 중인 앱을 조회하고, 메모장 입력칸에 "hello"를 입력한 뒤 결과를 확인해 줘.
```

프로젝트에만 적용하려면 `.claude/skills/windows-use/`에 복사할 수 있습니다.
스킬이 보이지 않으면 세션을 다시 시작하세요. 자세한 규칙은
[Claude Code 스킬 문서](https://code.claude.com/docs/en/skills)를 참고하세요.

두 에이전트 모두 동일한 CLI와 스킬을 사용합니다. 스킬은 명령 사용법을 전달하며,
CLI 설치·Windows 클라이언트 실행·SSH 연결을 대신하지 않습니다. 에이전트의 기존
셸·네트워크 권한 설정이 적용됩니다.

## 동작 규칙

- 결과는 항상 JSON입니다. `ok:true`와 UI 조작 검증 성공은 별도입니다.
- Windows named pipe 요청·응답은 줄바꿈으로 구분한 JSON을 사용합니다. 요청 전송 후
  연결을 반쯤 닫는 Unix 소켓 방식에 의존하지 않습니다.
- `snapshot`의 접근성 요소 번호와 관찰 토큰은 같은 세션에서만 재사용합니다.
- 관찰은 2분 후 만료됩니다. 같은 세션의 동시 실행은 거절하며, 서버는 데스크톱 요청을 순서대로 처리합니다.
- 입력 실패 시 관찰 토큰을 소모합니다. 재입력하기 전에 화면을 다시 확인하세요.
- 클릭은 기본적으로 접근성 Invoke/Select/Toggle만 사용합니다. 포인터가 필요한 경우
  사용자 승인 후 `--allow-pointer`를 지정합니다. `--restore-window`는 명시적인 포커스 복구입니다.
- 창 포커스와 입력칸 포커스는 별개입니다. 키보드 명령의 `--element`는 해당 입력칸을
  포커스하지 않습니다. 버튼 실행 후 입력칸 포커스를 확인하고, 지원되는 경우 `set-value`를 우선 사용하세요.
- 스크린샷은 기본적으로 찍지 않습니다. `--screenshot <새 파일>`로 요청하며 기존 파일을 덮어쓰지 않습니다.
- UI 관찰 상태는 Windows 사용자 폴더 `.windows-use/state`에 저장합니다. 이미지 데이터는
  캐시하지 않습니다. `server.json`은 로컬 IPC 인증 정보를 포함하므로 공유하거나 출력하지 마세요.
- 비정상 종료 후 등록 파일이 남으면 기존 서버 실행 여부를 먼저 확인하세요. 실행 중인
  서버를 임의 종료하거나 등록 파일을 덮어쓰지 마세요.

### 스크린샷 오류와 입력 결과

`--screenshot`은 입력 전에 기존 파일(디렉터리·끊어진 심볼릭 링크 포함), 부모 경로와
쓰기 권한을 검사합니다. 사전 검사 실패 시 입력 요청은 보내지 않습니다. 검사 이후의
파일 생성·삭제·권한 변경 경합까지 막는 것은 아니므로 실제 저장도 배타 생성(`wx`)을 사용합니다.

stdout은 항상 단일 JSON입니다. 스크린샷 실패의 기존 `ok: false`, `error`, exit 1은
유지하며, 다음 필드로 입력 응답과 이미지 저장 결과를 구분합니다.

| 상황 | exit / ok | `result` | `screenshotOutput` |
| --- | --- | --- | --- |
| 사전 경로 검사 실패 | 1 / false | 없음; 입력 미전송 | `status: failed`, `stage: preflight`, 요청한 절대 `path` |
| 응답 후 이미지 누락 | 1 / false | 원격 결과 보존 | `status: failed`, `stage: capture`, `path` |
| 응답 후 로컬 저장 실패 | 1 / false | 원격 결과 보존 | `status: failed`, `stage: save`, `path` |
| 저장 성공 | 0 / true | 기존 결과, `screenshot.path` | `status: saved`, `path` |

후처리 실패에서도 `result.action`과 그 `verification`, `snapshot`, 새
`session.observation`, 원격 캡처 상태인 `screenshotStatus`를 보존합니다. 이미지의
base64 `data`는 로컬 출력에서 제거하고 나머지 메타데이터는 유지합니다. `result`가
있다는 것은 원격 응답을 받았다는 뜻이며, 입력 성공 여부는 `action.verification`과
스냅샷으로 판단해야 합니다. 캡처 상태와 로컬 저장 상태는 별개입니다.

호출자는 exit 1에서도 JSON을 읽어야 합니다. `stage: capture` 또는 `save`이면
이미 실행된 입력을 재전송하지 말고 보존된 결과를 확인하세요. 이미지가 더 필요하면
새 파일 경로로 별도의 `snapshot --screenshot`을 실행하세요. 쓰기 도중 디스크 오류가
발생하면 새로 만든 불완전한 파일이 남을 수 있으므로 `screenshotOutput.status: saved`만
저장 성공으로 취급합니다. 사전 검사와 후처리는 기존 파일을 삭제하거나 덮어쓰지 않습니다.
스크린샷을 요청하지 않은 명령과 RPC의 응답 계약은 바뀌지 않습니다.

## 요소 검색과 조건 대기

`query`는 새 snapshot을 관찰하고 `--role`, `--name`, `--automation-id`를 대소문자를
구분해 정확히 AND 매칭합니다. 선택자는 하나 이상 필요합니다. 창이 여러 개면
`--window-id`를 지정하세요. 검색과 대기는 창 인덱스, 포커스 복구, 스크린샷을 지원하지 않습니다.

```sh
windows-use query --app Notepad --session find-editor --window-id <HWND> \
  --role ControlType.Edit --automation-id <observed-id>
windows-use query --app <pid> --session find-button --accessibility msaa --name Save
windows-use wait-for --app Notepad --session await-editor --name Editor \
  --condition element --timeout-ms 10000 --poll-ms 250
windows-use wait-for --app <pid> --session await-dialog --condition window --window-title Ready
windows-use wait-for --app <pid> --session await-value --automation-id status \
  --condition value --value ready
windows-use wait-for --app <pid> --session await-change --name Editor --condition changed
```

모든 호출에 같은 `--host`/`--remote-dir`를 유지합니다. `query` 결과 형태는 다음과 같습니다.

```json
{
  "ok": true,
  "result": {
    "snapshot": { "id": "…", "window": { "id": 123 } },
    "query": {
      "matchCount": 1, "unique": true, "complete": true,
      "matches": [{ "index": 4, "role": "ControlType.Edit", "roleLabel": "edit",
        "name": "Editor", "automationId": "editor", "value": "ready",
        "valueTruncated": false, "sensitive": false, "identity": [42, 88] }]
    },
    "session": { "id": "find-editor", "observation": "…", "expiresAt": 123456789, "accessibility": "uia" }
  }
}
```

예시는 필드를 일부 생략한 구조 설명입니다. `matches`는 snapshot 순서이며, 번호는
해당 관찰에서만 유효합니다. `unique: true`일 때 의도한 요소인지 확인한 후
같은 app/session, `result.snapshot.window.id`, `result.session.observation`, 요소 `index`를
다음 액션의 `--window-id`, `--observation`, `--element`에 사용하세요. 검색이 액션을
자동 실행하지 않습니다. 0개/복수 후보도 목록으로 반환하며, 잘린 트리는 `complete: false`,
`unique: false`입니다. 이 경우 선택자를 좁히거나 다시 관찰하세요.

`role`은 UIA의 `ControlType.Edit` 같은 programmatic name, MSAA의 `MSAA.42` 같은
네이티브 역할입니다. MSAA 사용자 정의 역할은 `MSAA.custom.<role>`입니다. 번역된 표시 역할은
`roleLabel`이며 선택자로 사용하지 않습니다. MSAA는 AutomationId를 제공하지 않아
`null`로 반환하며 해당 선택자를 주면 `unsupported_selector`로 실패합니다. 이름은
현재 backend가 노출한 문자열과 비교하며, 누락된 metadata를 추측하지 않습니다.

`wait-for`의 기본 조건은 `element`입니다. `window`는 요소 선택자 없이 창의 등장,
`value`는 `--value` 또는 `--value-file`과의 정확한 일치, `changed`는 **대기 중 첫 번째로
관찰한 값**으로부터의 변화를 기다립니다. 변경 대기는 네이티브 식별자를 추적하여 번호가
바뀌어도 같은 요소를 확인하고, 교체된 요소는 거절합니다. 민감 요소의 이름과 AutomationId는
검색 출력에서 가리며 값은 `null`입니다. 민감 값, 미지원 값, 잘린 값의 비교는 거절합니다.

대기 시간은 단조 시계 기준 전체 deadline이며 SSH·대기열·조회 시간도 포함합니다.
`--timeout-ms`는 1–600000ms(기본 10000), `--poll-ms`는 50–10000ms(기본 250)입니다.
처음 선택한 HWND를 고정하며 닫히면 다른 창으로 옮겨가지 않습니다. 조건 충족 시 최신
관찰 토큰을 반환하고, 복수 후보·불완전한 트리·pause/재개·서버 재시작은 오류로 종료합니다.
호출 측과 Windows 서버를 함께 업데이트해야 합니다. 이전 서버의 읽기 응답에 접근 세대값이 없으면
`unsupported_wait`로 실패합니다.

polling은 호출 측에서 개별 읽기 RPC로 수행하여 broker를 대기 시간 동안 점유하지 않습니다.
각 읽기는 앞서 받은 접근 세대값을 전달하고 서버가 실행 전후에 검사합니다. 이 값은
읽기 결과와 함께 반환하므로 별도 `status` 왕복은 필요하지 않습니다. 앱이 아직 없는 경우도
세대값을 유지하여 polling 사이의 pause/재개를 감지합니다.
입력 재시도는 없습니다. Ctrl+C/SIGTERM은 `wait_cancelled`, deadline 초과는
`wait_timeout`으로 종료하며 CLI 종료 코드는 1입니다. timeout/취소 오류에는 기대값이나
마지막 관찰 값을 싣지 않습니다. 취소는 호출 측의 IPC/SSH 요청을 닫지만 이미 시작된
단일 native 조회는 서버에서 마무리될 수 있습니다. pause는 그 조회가 끝난 뒤 관찰을
폐기합니다. 대기 중 다른 입력이 발생하면 반환 토큰도 무효화될 수 있으므로 기존 관찰
안전성 검사를 그대로 따르고, 액션 오류 후 자동 재입력하지 마세요.

## 검증 범위

### MSAA와 팝업 창

UIA 스냅샷에 앱 내부 항목이 빠지면 `--accessibility msaa`로 MSAA 트리를 명시적으로
조회할 수 있습니다. 이후 액션은 같은 관찰의 백엔드를 상속하며, 다른 백엔드로 바꾸려면
새 스냅샷이 필요합니다. MSAA도 본문을 노출하지 않는 터미널은 스크린샷으로 확인해야 합니다.
아래 예시의 호스트, `APP_PID`, `WINDOW_ID`, `OBSERVATION_TOKEN`은 실제 조회 결과로 바꾸세요.

```sh
windows-use windows --host windows-pc --app 'APP_PID'
windows-use snapshot --host windows-pc --app 'APP_PID' --window-id 'WINDOW_ID' \
  --accessibility msaa --session inspect-app
windows-use hotkey --host windows-pc --app 'APP_PID' --session inspect-app \
  --observation 'OBSERVATION_TOKEN' --key Shift+F10 --restore-window
```

`windows`는 해당 프로세스의 보이는 최상위 창과 소유 팝업을 열거합니다. 기본 스냅샷은
그 프로세스에 속한 전경 창을 우선하며, 창 ID를 지정하면 해당 창만 대상으로 합니다.
메뉴나 대화상자가 열린 뒤에는 창 목록과 스냅샷을 다시 읽으세요. 오래된 ID, 다른 프로세스의
ID, 이름·역할이 달라진 MSAA 요소는 입력 전에 거절합니다. 창 인덱스로 관찰한 뒤에도
액션은 관찰한 HWND로 고정되며, 창이 닫히면 다른 창으로 입력을 넘기지 않고 거절합니다.

MSAA 요소는 `IAccIdentity`가 제공하는 네이티브 식별자로 다시 찾습니다. 형제 순서가
바뀌어도 같은 요소를 유지하며, 삭제되었거나 식별자가 중복된 요소는 거절합니다.
식별자를 제공하지 않는 요소도 조회할 수 있지만 접근성 액션은 제공하지 않습니다.
기본 액션·이름·값·위치 같은 선택 속성이 미지원이어도 자식 트리는 계속 조회합니다.

F1–F16과 `Shift+F10`을 지원합니다. MSAA 메서드가 성공해도 앱이 실제로 반응했는지는
새 스냅샷으로 검증해야 합니다. 비밀번호로 표시된 MSAA 컨트롤의 이름과 값은 가립니다.
보호 플래그가 없어도 이름·역할·설명·도움말에서 비밀번호, PIN, 인증 코드 등의 민감 필드
표시가 확인되면 값을 조회하지 않고 `[redacted]`로 표시합니다. 정수 역할과 문자열 사용자
정의 역할을 구분하며, 사용자 정의 역할이 있어도 자식과 형제 탐색을 계속합니다.

Windows 회귀 테스트:

```powershell
& .\native\computer-use-windows\runtime-keyboard.test.ps1
& .\native\computer-use-windows\runtime-windows.test.ps1
& .\native\computer-use-windows\runtime-msaa.test.ps1
& .\native\computer-use-windows\runtime-render.test.ps1
```

MSAA 테스트는 임시 WinForms 창을 만들고 닫습니다. 운영 앱을 대상으로 하지 않습니다.

PowerShell 7이 설치된 Mac/Linux에서도 격리 테스트를 실행할 수 있습니다.

```sh
npm run test:native-isolated
pwsh -NoProfile -File native/computer-use-windows/runtime-query.test.ps1
```

MSAA 격리 테스트는 실제 탐색·식별·액션 코드의 oleacc 호출 경계만 fixture로 대체합니다.
COM 마샬링과 실제 Windows UI 연동은 위의 Windows 회귀 테스트로 별도 확인해야 합니다.

로컬 테스트는 독립 CLI, SSH 인자/Unicode 전송, 인증된 IPC, 세션 격리, 원본 provider의
요소 ID 전달과 값 검증을 확인합니다. 실제 Windows UI와 키보드·포커스 동작은 Windows의
로그인된 데스크톱에서 별도로 검증해야 합니다. 기본 확인은 `serve` 실행 후 `apps`,
`snapshot`이며, 입력 검증은 승인된 테스트 창에서 수행하세요.

원본 스크립트의 렌더링 테스트는 Windows에서 `native/computer-use-windows/runtime-render.test.ps1`로
실행할 수 있습니다. 포커스 smoke 테스트는 화면에 영향을 줄 수 있으므로 의도한 검증 창에서만 실행하세요.

## 업데이트

공유하는 예시에는 가상 SSH 별칭·PC 이름·계정을 사용하고, 검증 자료에서 값을 바꿨다면
익명화 사실을 표시하세요. 실제 연결 설정 화면, 로컬 상태 파일, 인증정보는 저장소나 패키지에 포함하지 않습니다.

패키지를 갱신하면 CLI와 에이전트에 복사한 스킬도 함께 갱신하세요. 변경 검증에는
`npm run build`, `npm test`, `npm run test:bridge`를 사용합니다. Windows 실행에 영향을
주는 변경은 로그인된 Windows 데스크톱에서 별도로 확인하세요.

`bin/`은 실행 진입점 소스이므로 Git으로 관리합니다. `dist/`는 `vendor/orca/`의 소스로
생성하는 빌드 결과물이므로 Git 추적에서 제외하고 배포 패키지에만 포함합니다.
`npm test`와 `npm pack`은 실행 전에 provider를 자동으로 다시 빌드하며,
`npm run package:windows`도 패키징 과정에서 빌드합니다.

이 프로젝트는 MIT 라이선스로 배포합니다. 라이선스와 포함된 코드의 출처는
[LICENSE](LICENSE), [NOTICE.md](NOTICE.md), [provenance.json](provenance.json)에 기록합니다.
