# windows-use

Orca의 Windows Computer Use를 추출한 독립 CLI와 스킬입니다. Orca 에이전트의
일반 셸 도구에서 호출할 수 있습니다. Windows 대상에는 Orca 앱이 필요하지 않습니다.
`orca computer` 내장 명령을 교체하는 방식은 아닙니다.

```text
Orca / Codex / terminal
        ↓ windows-use --host <SSH alias>
existing SSH connection → Windows CLI (JSON stdin)
        ↓ authenticated local named pipe
windows-use serve (logged-in Windows desktop)
        ↓
PowerShell UI Automation + focus helper
```

## 구성과 비용

- 실행 요구 사항: 호출 PC와 Windows PC의 Node.js 22 이상. 런타임 npm 의존성 0개.
- Windows 스크립트와 필요한 제어 모듈만 포함합니다. 소스 출처는 `provenance.json`.
- 전체 Orca 빌드, Electron, upstream E2E, 예약 Actions를 포함하지 않습니다.
- 이 저장소에는 GitHub Actions 워크플로가 없습니다. 테스트·빌드는 수동으로 실행합니다.
- GitHub의 무료 3,000분은 실행 시간 한도입니다. 저장공간과는 별도입니다.

## 로컬 개발 및 배포 패키지

```sh
npm ci
npm run build
npm test
npm pack
```

`npm pack` 결과에는 실행 파일, 생성된 provider, Windows 스크립트, 스킬과 라이선스만
포함됩니다. 설치 PC에서 Orca 소스나 개발 의존성을 설치할 필요가 없습니다.

Mac/Linux에서 CLI 등록:

```sh
npm install --global /path/to/psh4607-windows-use-0.1.0.tgz
windows-use --help
```

## Windows 설치

Node.js 22 이상이 있는 Windows PC에 배포 파일을 복사한 다음, **로그인된 Windows
데스크톱의 터미널**에서 실행합니다. 기존 파일이 있는 설치 경로는 먼저 확인하세요.

```powershell
$installDir = Join-Path $env:USERPROFILE '.windows-use/app'
New-Item -ItemType Directory -Force $installDir | Out-Null
tar -xzf .\psh4607-windows-use-0.1.0.tgz -C $installDir --strip-components=1
node (Join-Path $installDir 'bin/windows-use.mjs') serve
```

마지막 프로세스를 계속 실행해 둡니다. Windows의 Orca 터미널에서도 시작할 수 있습니다.
Ctrl+C로 종료합니다. 시작 프로그램이나 Windows 서비스는 자동으로 등록하지 않습니다.
SSH에서 `serve`를 시작하면 대화형 데스크톱을 사용할 수 있다는 보장이 없습니다.

다른 Windows 터미널에서 로컬 CLI를 사용하려면 `node <설치경로>/bin/windows-use.mjs`
뒤에 아래 명령을 붙이거나 패키지를 `npm install --global`로 등록하세요. 원격 호출의
`--remote-dir`에는 실제 설치 루트(그 안에 `bin/windows-use.mjs`가 있는 경로)를 지정합니다.

## Mac의 Orca에서 호출

```sh
windows-use apps --host <existing-SSH-alias>
windows-use snapshot --host <existing-SSH-alias> --app Notepad --session task-a
windows-use set-value --host <existing-SSH-alias> --app Notepad --session task-a \
  --observation <result.session.observation> --element 4 --value 'hello'
```

`--remote-dir`를 생략하면 위의 기본 Windows 설치 경로를 사용합니다. SSH는 기존 인증을
사용하며 새 자격증명을 만들거나 host key 검증을 끄지 않습니다. Windows 데스크톱
서버와 SSH 사용자는 동일한 Windows 계정을 사용해야 합니다.

`skills/windows-use`를 `~/.codex/skills/windows-use` 또는 `~/.agents/skills/windows-use`에
설치하면 해당 스킬 경로를 읽는 Orca 에이전트가 사용할 수 있습니다. 새 에이전트 세션에서
`$windows-use`를 선택하거나 SKILL.md 경로를 직접 전달하세요.

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

## 검증 범위

### MSAA와 팝업 창

UIA 스냅샷에 앱 내부 항목이 빠지면 `--accessibility msaa`로 MSAA 트리를 명시적으로
조회할 수 있습니다. 이후 액션은 같은 관찰의 백엔드를 상속하며, 다른 백엔드로 바꾸려면
새 스냅샷이 필요합니다. MSAA도 본문을 노출하지 않는 터미널은 스크린샷으로 확인해야 합니다.

```sh
windows-use windows --host <SSH-alias> --app <pid>
windows-use snapshot --host <SSH-alias> --app <pid> --window-id <HWND> \
  --accessibility msaa --session inspect-app
windows-use hotkey --host <SSH-alias> --app <pid> --session inspect-app \
  --observation <token> --key Shift+F10 --restore-window
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

Orca 업데이트와 독립적으로 버전을 관리합니다. 원본 모듈을 갱신할 때는 고정된 커밋에서
동일한 파일 목록을 추출하고 `provenance.json`을 갱신한 뒤 빌드·테스트·Windows 검증을 실행하세요.
원본 저장소의 전체 워크플로를 복사하지 않습니다.
