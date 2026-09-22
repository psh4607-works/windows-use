using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace WindowsUse
{
    static class Program
    {
        [STAThread] static int Main(string[] args)
        {
            try
            {
                if (Array.IndexOf(args, "--shutdown") >= 0) return Lifetime.Shutdown();
                if (Process.GetCurrentProcess().SessionId == 0) return 2;
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                using (var lifetime = new Lifetime())
                {
                    if (!lifetime.IsOwner) { lifetime.Show.Set(); return 0; }
                    using (var app = new TrayContext(lifetime, Array.IndexOf(args, "--background") >= 0)) Application.Run(app);
                }
                return 0;
            }
            catch (Exception error) { MessageBox.Show(error.Message, "Windows Use", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        }
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly Form form;
        readonly NotifyIcon tray;
        readonly Label status = new Label { AutoSize = true, Text = "시작 중…", Margin = new Padding(0, 8, 0, 12) };
        readonly Button pause = new Button { Text = "일시 중지", AutoSize = true, Enabled = false };
        readonly Button test = new Button { Text = "연결 테스트", AutoSize = true, Enabled = false };
        readonly Button save = new Button { Text = "연결 설정 저장", AutoSize = true, Enabled = false };
        readonly CheckBox autoStart = new CheckBox { Text = "Windows 로그인 시 자동 시작", AutoSize = true };
        readonly TextBox alias = new TextBox(), address = new TextBox(), username = new TextBox();
        readonly NumericUpDown port = new NumericUpDown { Minimum = 1, Maximum = 65535, Value = 22 };
        readonly TextBox instructions = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 125 };
        readonly TextBox result = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 105, Text = "연결 테스트를 실행하면 데스크톱 접근과 로컬 SSH 응답을 확인합니다." };
        readonly ToolStripMenuItem trayStatus = new ToolStripMenuItem("시작 중…") { Enabled = false };
        readonly ToolStripMenuItem trayPause = new ToolStripMenuItem("일시 중지") { Enabled = false };
        ChildJob job;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 3000 };
        readonly RegisteredWaitHandle stopWait, showWait;
        HostBridge bridge;
        HostView current;
        bool quitting, busy, initialized, refreshing;

        public TrayContext(Lifetime lifetime, bool background)
        {
            form = new Form { Text = "Windows Use", ClientSize = new Size(640, 760), MinimumSize = new Size(570, 700), StartPosition = FormStartPosition.CenterScreen,
                Font = new Font("Malgun Gothic", 10), AutoScaleMode = AutoScaleMode.Dpi, Icon = SystemIcons.Application };
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, AutoScroll = true };
            form.Controls.Add(layout);
            layout.Controls.Add(new Label { Text = "Windows Use", Font = new Font(form.Font.FontFamily, 21, FontStyle.Bold), AutoSize = true });
            layout.Controls.Add(status);
            layout.Controls.Add(new Label { Text = "Codex / Claude Code에서 이 PC의 화면을 조회하고 조작합니다.", AutoSize = true, Margin = new Padding(0, 0, 0, 14) });
            var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
            actions.Controls.Add(pause); actions.Controls.Add(test);
            layout.Controls.Add(actions);
            autoStart.Checked = Startup.Enabled;
            autoStart.Margin = new Padding(0, 12, 0, 16);
            layout.Controls.Add(autoStart);
            var fields = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 135)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            AddField(fields, "SSH 연결 이름", alias); AddField(fields, "이 PC의 접속 주소", address);
            AddField(fields, "Windows 사용자", username); AddField(fields, "SSH 포트", port);
            layout.Controls.Add(fields); layout.Controls.Add(save);
            layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(570, 0), Margin = new Padding(0, 12, 0, 8), Text = "호출 PC의 SSH 설정에 사용할 정보입니다. 기존 SSH 연결이 있으면 그 설정을 유지하세요. 비밀번호·키·터널·방화벽은 여기서 변경하지 않습니다." });
            layout.Controls.Add(instructions);
            var copy = new Button { Text = "연결 안내 복사", AutoSize = true };
            copy.Click += (sender, args) => { try { if (instructions.Text.Length > 0) Clipboard.SetText(instructions.Text); } catch (Exception error) { ShowError(error); } };
            layout.Controls.Add(copy); layout.Controls.Add(result);
            var exit = new Button { Text = "Windows Use 종료", AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
            exit.Click += async (sender, args) => await QuitAsync(); layout.Controls.Add(exit);
            var menu = new ContextMenuStrip();
            menu.Items.Add(trayStatus); menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("연결 설정 열기", null, (sender, args) => ShowForm());
            menu.Items.Add(trayPause);
            menu.Items.Add("연결 테스트", null, async (sender, args) => { ShowForm(); await DiagnoseAsync(); });
            menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("종료", null, async (sender, args) => await QuitAsync());
            tray = new NotifyIcon { Text = "Windows Use — 시작 중", Icon = SystemIcons.Application, Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += (sender, args) => ShowForm();
            form.FormClosing += (sender, args) => { if (!quitting && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; form.Hide(); } };
            pause.Click += async (sender, args) => await ToggleAsync(); trayPause.Click += async (sender, args) => await ToggleAsync();
            save.Click += async (sender, args) => await SaveAsync(); test.Click += async (sender, args) => await DiagnoseAsync();
            autoStart.CheckedChanged += (sender, args) => { try { Startup.Set(autoStart.Checked); } catch (Exception error) { ShowError(error); } };
            // A real handle allows background callbacks to marshal safely even when the window is hidden.
            var handle = form.Handle;
            stopWait = ThreadPool.RegisterWaitForSingleObject(lifetime.Stop, (state, timedOut) => Ui(async () => await QuitAsync()), null, -1, false);
            showWait = ThreadPool.RegisterWaitForSingleObject(lifetime.Show, (state, timedOut) => Ui(ShowForm), null, -1, false);
            timer.Tick += async (sender, args) => {
                if (busy || refreshing || current == null || bridge == null) return;
                refreshing = true;
                try { await bridge.RequestAsync("status", null, 5000); } catch (Exception error) { if (!busy) SetFailure(error.Message); }
                finally { refreshing = false; }
            };
            timer.Start(); if (!background) ShowForm();
            Ui(async () => await StartAsync());
        }
        void AddField(TableLayoutPanel panel, string label, Control input)
        {
            int row = panel.RowCount++;
            panel.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(0, 7, 4, 8) }, 0, row);
            input.Dock = DockStyle.Fill; input.Margin = new Padding(0, 3, 0, 8); input.AccessibleName = label;
            panel.Controls.Add(input, 1, row);
        }
        void Ui(Action action) { if (!form.IsDisposed && form.IsHandleCreated) try { form.BeginInvoke(action); } catch (InvalidOperationException) { } }
        void ShowForm() { if (quitting) return; form.Show(); form.WindowState = FormWindowState.Normal; form.Activate(); }
        void Apply(HostView view)
        {
            if (quitting) return;
            current = view;
            bool paused = view.status.state == "paused";
            string text = paused ? "일시 중지됨 · 화면 조회와 입력을 차단합니다" : "실행 중 · 연결 요청을 받을 수 있습니다";
            if (view.status.activeRequests > 0) text += " · 작업 처리 중";
            status.Text = text; status.ForeColor = paused ? Color.DarkOrange : Color.FromArgb(20, 120, 78);
            tray.Text = paused ? "Windows Use — 일시 중지" : "Windows Use — 실행 중";
            tray.Icon = paused ? SystemIcons.Warning : SystemIcons.Application;
            trayStatus.Text = paused ? "일시 중지됨" : "실행 중";
            pause.Text = trayPause.Text = paused ? "재개" : "일시 중지";
            if (!initialized)
            {
                alias.Text = view.settings.connection.alias; address.Text = view.settings.connection.hostname;
                username.Text = view.settings.connection.username; port.Value = view.settings.connection.port; initialized = true;
            }
            instructions.Text = view.sshConfig.Replace("\n", "\r\n") + "\r\n" + view.command;
            SetBusy(busy);
        }
        void SetBusy(bool value)
        {
            busy = value;
            pause.Enabled = trayPause.Enabled = !value;
            save.Enabled = test.Enabled = current != null && !value;
        }
        void SetFailure(string message)
        {
            current = null; status.Text = "중지됨 · 다시 시작이 필요합니다"; status.ForeColor = Color.Firebrick;
            result.Text = message; trayStatus.Text = "중지됨"; tray.Text = "Windows Use — 중지됨"; tray.Icon = SystemIcons.Error;
            pause.Text = trayPause.Text = "다시 시작"; SetBusy(false);
        }
        void ShowError(Exception error) { result.Text = error.Message; }
        async Task StartAsync()
        {
            if (busy || quitting) return; SetBusy(true);
            try
            {
                if (bridge != null) bridge.Dispose();
                // Revoke the old process tree before starting a replacement owner.
                job?.Dispose(); job = new ChildJob();
                bridge = new HostBridge { OnStarted = process => job.Attach(process) };
                bridge.Changed += view => Ui(() => Apply(view));
                bridge.Failed += message => Ui(() => SetFailure(message));
                string root = AppDomain.CurrentDomain.BaseDirectory;
                Apply(await bridge.StartAsync(Path.Combine(root, "runtime", "node.exe"), Path.Combine(root, "bin", "windows-use-host.mjs")));
            }
            catch (Exception error) { SetFailure(error.Message); }
            finally { SetBusy(false); }
        }
        async Task ToggleAsync()
        {
            if (busy || quitting) return;
            if (current == null) { await StartAsync(); return; }
            SetBusy(true);
            status.Text = current.status.state == "paused" ? "재개 중…" : "중지 요청됨 · 진행 중인 작업이 끝나기를 기다립니다";
            try { Apply((await bridge.RequestAsync(current.status.state == "paused" ? "resume" : "pause")).result); }
            catch (Exception error) { ShowError(error); }
            finally { SetBusy(false); }
        }
        async Task SaveAsync()
        {
            if (busy || current == null) return; SetBusy(true);
            try
            {
                var connection = new Connection { alias = alias.Text.Trim(), hostname = address.Text.Trim(), username = username.Text.Trim(), port = (int)port.Value };
                Apply((await bridge.RequestAsync("settings", connection)).result);
                result.Text = "연결 설정을 저장했습니다. SSH 서비스나 기존 연결 설정은 변경하지 않았습니다.";
            }
            catch (Exception error) { ShowError(error); }
            finally { SetBusy(false); }
        }
        async Task DiagnoseAsync()
        {
            if (busy || current == null) return; SetBusy(true); result.Text = "데스크톱과 로컬 SSH 응답을 확인 중입니다…";
            try
            {
                var connection = new Connection { alias = alias.Text.Trim(), hostname = address.Text.Trim(), username = username.Text.Trim(), port = (int)port.Value };
                var view = (await bridge.RequestAsync("diagnose", connection)).result; Apply(view);
                result.Text = "데스크톱: " + (view.diagnostics.desktop.ok ? "성공" : "확인 필요") + "\r\n" + view.diagnostics.desktop.message +
                    "\r\nSSH 응답: " + (view.diagnostics.ssh.ok ? "성공" : "확인 필요") + "\r\n" + view.diagnostics.ssh.message +
                    "\r\n다른 PC에서의 접속·인증은 위 연결 테스트 명령으로 확인하세요.";
            }
            catch (Exception error) { ShowError(error); }
            finally { SetBusy(false); }
        }
        async Task QuitAsync()
        {
            if (quitting) return; quitting = true; timer.Stop(); SetBusy(true); status.Text = "종료 중…";
            try { if (bridge != null) await bridge.StopAsync(); }
            catch (Exception error) { quitting = false; SetFailure(error.Message); ShowForm(); return; }
            tray.Visible = false; form.Close(); ExitThread();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { stopWait.Unregister(null); showWait.Unregister(null); timer.Dispose(); bridge?.Dispose(); job?.Dispose(); tray.Dispose(); form.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
