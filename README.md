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
