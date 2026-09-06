param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^orca-computer-focus-[A-Za-z0-9-]+$')]
    [string]$PipeName,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$ParentPid
)

$ErrorActionPreference = "Stop"
$token = [string]$env:ORCA_COMPUTER_WINDOWS_FOCUS_TOKEN
Remove-Item Env:ORCA_COMPUTER_WINDOWS_FOCUS_TOKEN -ErrorAction SilentlyContinue
if ($token -notmatch '^[a-f0-9]{64}$') { throw "focus helper token is invalid" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class OrcaFocusHelperWin32 {
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_MENU = 0x12;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public INPUTUNION data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public HARDWAREINPUT hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT {
        public uint message;
        public ushort parameterLow;
        public ushort parameterHigh;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

    [DllImport("user32.dll")]
    private static extern uint GetQueueStatus(uint flags);

    public static bool Focus(IntPtr hwnd, int timeoutMilliseconds) {
        ShowWindowAsync(hwnd, 9);
        if (WaitForForeground(hwnd, 100)) return true;

        GetQueueStatus(0);
        uint currentThread = GetCurrentThreadId();
        uint ignored;
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignored);
        bool attachedForeground = false;
        bool attachedTarget = false;
        try {
            if (foregroundThread != 0 && foregroundThread != currentThread) {
                attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            }
            if (targetThread != 0 && targetThread != currentThread) {
                attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            }
            BringWindowToTop(hwnd);
            SetActiveWindow(hwnd);
            SetForegroundWindow(hwnd);
        } finally {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
        if (WaitForForeground(hwnd, 100)) return true;

        // Windows can reject SetForegroundWindow when the caller did not receive the
        // most recent input. A balanced Alt press/release grants the helper a fresh
        // input event without leaving a modifier held if focus recovery is interrupted.
        SendKeyboardInput(false);
        try {
            BringWindowToTop(hwnd);
            SetActiveWindow(hwnd);
            SetForegroundWindow(hwnd);
        } finally {
            SendKeyboardInput(true);
        }
        return WaitForForeground(hwnd, timeoutMilliseconds);
    }

    private static bool SendKeyboardInput(bool keyUp) {
        INPUT input = new INPUT {
            type = INPUT_KEYBOARD,
            data = new INPUTUNION {
                keyboard = new KEYBDINPUT {
                    virtualKey = VK_MENU,
                    scanCode = 0,
                    flags = keyUp ? KEYEVENTF_KEYUP : 0,
                    time = 0,
                    extraInfo = UIntPtr.Zero
                }
            }
        };
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool SecureEquals(string left, string right) {
        if (left == null || right == null) return false;
        int difference = left.Length ^ right.Length;
        int length = Math.Max(left.Length, right.Length);
        for (int index = 0; index < length; index++) {
            char leftValue = index < left.Length ? left[index] : (char)0;
            char rightValue = index < right.Length ? right[index] : (char)0;
            difference |= leftValue ^ rightValue;
        }
        return difference == 0;
    }

    private static bool WaitForForeground(IntPtr hwnd, int timeoutMilliseconds) {
        int elapsed = 0;
        while (elapsed < timeoutMilliseconds) {
            if (GetForegroundWindow() == hwnd) return true;
            Thread.Sleep(25);
            elapsed += 25;
        }
        return GetForegroundWindow() == hwnd;
    }
}
"@

function Test-OrcaFocusToken([string]$Candidate) {
    [OrcaFocusHelperWin32]::SecureEquals($token, $Candidate)
}

function Test-OrcaParentAlive {
    try {
        $parent = Get-Process -Id $ParentPid -ErrorAction Stop
        $current = [Diagnostics.Process]::GetCurrentProcess()
        $parent.SessionId -eq $current.SessionId
    } catch {
        $false
    }
}

function Invoke-OrcaFocusRequest($request) {
    if (-not (Test-OrcaFocusToken ([string]$request.token))) {
        return [pscustomobject]@{ ok = $false; error = "authentication_failed" }
    }
    if ([string]$request.command -eq "terminate") {
        return [pscustomobject]@{ ok = $true; terminate = $true }
    }
    if ([string]$request.command -ne "focus") {
        return [pscustomobject]@{ ok = $false; error = "unsupported_command" }
    }

    $target = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
    $current = [Diagnostics.Process]::GetCurrentProcess()
    if ($target.SessionId -ne $current.SessionId) {
        return [pscustomobject]@{ ok = $false; error = "wrong_session" }
    }
    $handle = [IntPtr][int64]$request.windowHandle
    $ownerPid = [uint32]0
    [void][OrcaFocusHelperWin32]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
    if ([int]$ownerPid -ne [int]$request.pid) {
        return [pscustomobject]@{ ok = $false; error = "window_owner_mismatch" }
    }

    $focused = [OrcaFocusHelperWin32]::Focus($handle, 750)
    $foreground = [int64][OrcaFocusHelperWin32]::GetForegroundWindow()
    [pscustomobject]@{
        ok = $focused -and $foreground -eq [int64]$handle
        focused = $focused
        foregroundWindow = $foreground
        windowHandle = [int64]$handle
    }
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$pipeSecurity = [System.IO.Pipes.PipeSecurity]::new()
$pipeSecurity.SetAccessRuleProtection($true, $false)
$pipeRule = [System.IO.Pipes.PipeAccessRule]::new(
    $currentSid,
    [System.IO.Pipes.PipeAccessRights]::ReadWrite,
    [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$pipeSecurity.AddAccessRule($pipeRule)
$utf8 = [System.Text.UTF8Encoding]::new($false)
$running = $true
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($running -and (Test-OrcaParentAlive)) {
    $server = [System.IO.Pipes.NamedPipeServerStream]::new(
        $PipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        1,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::Asynchronous,
        4096,
        4096,
        $pipeSecurity
    )
    try {
        $connection = $server.WaitForConnectionAsync()
        while (-not $connection.Wait(250)) {
            if (-not (Test-OrcaParentAlive)) { return }
        }
        $reader = [System.IO.StreamReader]::new($server, $utf8, $false, 4096, $true)
        $writer = [System.IO.StreamWriter]::new($server, $utf8, 4096, $true)
        $writer.AutoFlush = $true
        try {
            $request = $reader.ReadLine() | ConvertFrom-Json
            $response = Invoke-OrcaFocusRequest $request
            $writer.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
            if ([bool]$response.terminate) { $running = $false }
        } finally {
            $reader.Dispose()
            $writer.Dispose()
        }
    } catch {
        if ($server.IsConnected) {
            $errorResponse = [pscustomobject]@{ ok = $false; error = "focus_failed" }
            try {
                $fallbackWriter = [System.IO.StreamWriter]::new($server, $utf8, 4096, $true)
                $fallbackWriter.AutoFlush = $true
                $fallbackWriter.WriteLine(($errorResponse | ConvertTo-Json -Compress))
                $fallbackWriter.Dispose()
            } catch {}
        }
    } finally {
        $server.Dispose()
    }
}
