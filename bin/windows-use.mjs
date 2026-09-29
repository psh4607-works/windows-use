#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCli } from '../src/arguments.mjs';
import { startDesktop, requestDesktop } from '../src/desktop.mjs';
import { sshInvocation } from '../src/ssh.mjs';
import { sendRequest } from '../src/transport.mjs';
import { waitFor } from '../src/wait-for.mjs';
import { preflightScreenshot, saveScreenshot } from '../src/screenshot-output.mjs';

const help = `windows-use — standalone Windows UI Automation (Node.js 22+)

Commands: serve, status, doctor, capabilities, apps, windows, snapshot, query, wait-for, click, invoke, set-value,
          type-text, press-key, hotkey, paste-text, scroll, drag

Start in a Windows desktop terminal: windows-use serve (keep it running)
Local Windows: windows-use apps
From another machine: windows-use apps --host <SSH-alias>
Codex / Claude Code: invoke these commands through the agent's shell tool.
Remote install discovers %LOCALAPPDATA%/Programs/WindowsUse, then the legacy %USERPROFILE%/.windows-use/app.
Override with --remote-dir <Windows-path>.

Observe: windows-use snapshot --app Notepad --session my-task [--screenshot image.png]
Act:     windows-use set-value --app Notepad --session my-task \\
           --observation <latest-session.observation> --element 4 --value "text"

--host <alias>                    Run against the installed remote Windows package
--session <task-id>               Isolate observed elements for this task
--observation <token>             Required for actions; use the latest snapshot token
--window-id <id> | --window-index <index>
--accessibility uia|msaa          Snapshot backend (default uia); actions inherit it
--role <native-role>              query/wait-for exact role, e.g. ControlType.Edit or MSAA.42
--name <name> --automation-id <id> Exact AND selectors; AutomationId is UIA-only
--condition element|window|value|changed  wait-for condition (default element)
--window-title <exact-title>      wait-for window selector; pins the first unique HWND
--timeout-ms <1-600000>            wait-for deadline including reads (default 10000)
--poll-ms <50-10000>               wait-for interval between reads (default 250)
--restore-window                 Explicitly permit restoring/focusing the target
--element <index>                 Accessibility element from the latest snapshot
--action <name>                   Accessible secondary action (invoke)
--text <text> | --text-file <file> Text for typing/pasting; files avoid argv exposure
--value <text> | --value-file <file>
--key <key>                       Key or hotkey, e.g. Enter, Shift+F10, F1-F16, Ctrl+s
--allow-pointer                  Permit coordinate/fallback pointer input only when authorized
--screenshot <local-file>         Save PNG locally; images are omitted by default
--json                           Results are always JSON
Snapshots expire after two minutes. Re-observe after errors or another task's input.
Query/wait never focus or send input; no --window-index or --screenshot.
wait-for value uses --value/--value-file; changed compares against its first match.
Ambiguous waits fail; timeout is wait_timeout with exit 1. Ctrl+C cancels the wait.
Screenshot failures exit 1. Post-input failures preserve result and screenshotOutput;
inspect action.verification and the new observation before any input. Never replay to save an image.
`;

async function readStdin() {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const options = parseCli(process.argv.slice(2));
  if (options.version) process.stdout.write('0.2.0\n');
  else if (options.help) process.stdout.write(help);
  else if (options.request.command === 'serve') {
    if (process.platform !== 'win32' || options.host) throw new Error('Run serve directly in the interactive Windows desktop session.');
    const desktop = await startDesktop();
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await desktop.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'desktop-server', transport: 'named-pipe' })}\n`);
  } else {
    let request = options.request;
    const rpc = request.command === 'rpc';
    if (rpc) request = JSON.parse(await readStdin());
    else {
      for (const [source, field] of [[options.textFile, 'text'], [options.valueFile, 'value']]) {
        if (source) {
          if (request.params[field] !== undefined) throw new Error(`Use --${field} or --${field}-file, not both.`);
          request.params[field] = await readFile(source, 'utf8');
        }
      }
    }
    const screenshotPath = !rpc && options.screenshot ? resolve(options.screenshot) : undefined;
    if (screenshotPath) await preflightScreenshot(screenshotPath);
    const read = (req, limits) => !rpc && options.host
      ? sendRequest(sshInvocation(options.host, options.remoteDir), req, limits)
      : requestDesktop(req, limits);
    let result;
    if (request.command === 'wait-for') {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { result = await waitFor(request, { read, signal: controller.signal }); }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    } else result = await read(request);
    const response = screenshotPath ? await saveScreenshot(result, screenshotPath) : { ok: true, result };
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (!response.ok) process.exitCode = 1;
    if (!rpc && request.command === 'doctor' && result?.desktop?.ok !== true) process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? 'windows_use_error', message: error.message },
    ...(error.screenshotOutput && { screenshotOutput: error.screenshotOutput }) })}\n`);
  process.exitCode = 1;
}
