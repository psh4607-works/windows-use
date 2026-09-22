using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace WindowsUse
{
    public class Connection { public string alias { get; set; } public string hostname { get; set; } public int port { get; set; } public string username { get; set; } }
    public class Settings { public bool paused { get; set; } public Connection connection { get; set; } }
    public class Status { public string state { get; set; } public int activeRequests { get; set; } public int pid { get; set; } }
    public class CheckResult { public bool ok { get; set; } public string message { get; set; } }
    public class Diagnostics { public CheckResult desktop { get; set; } public CheckResult ssh { get; set; } }
    public class HostView { public Status status { get; set; } public Settings settings { get; set; } public string sshConfig { get; set; } public string command { get; set; } public Diagnostics diagnostics { get; set; } }
    public class HostError { public string message { get; set; } }
    public class Reply { public int id { get; set; } public string @event { get; set; } public bool ok { get; set; } public HostView result { get; set; } public HostError error { get; set; } }
    public class ControlRequest { public int id { get; set; } public string command { get; set; } public Connection connection { get; set; } }

    public sealed class HostBridge : IDisposable
    {
        readonly ConcurrentDictionary<int, TaskCompletionSource<Reply>> pending = new ConcurrentDictionary<int, TaskCompletionSource<Reply>>();
        readonly TaskCompletionSource<HostView> ready = new TaskCompletionSource<HostView>(TaskCreationOptions.RunContinuationsAsynchronously);
        readonly object writerLock = new object();
        Process process;
        StreamWriter writer;
        int sequence;
        int failed;
        bool stopping;
        public event Action<HostView> Changed;
        public event Action<string> Failed;
        public Action<Process> OnStarted { get; set; }
        public int ProcessId { get { return process == null ? 0 : process.Id; } }

        static string Serialize(ControlRequest request)
        {
#if NETFRAMEWORK
            return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(request);
#else
            return System.Text.Json.JsonSerializer.Serialize(request);
#endif
        }
        static Reply Deserialize(string text)
        {
#if NETFRAMEWORK
            return new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Reply>(text);
#else
            return System.Text.Json.JsonSerializer.Deserialize<Reply>(text);
#endif
        }

        public async Task<HostView> StartAsync(string node, string entry, string home = null)
        {
            var start = new ProcessStartInfo(node, "\"" + entry + "\"") {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
                WorkingDirectory = Path.GetDirectoryName(entry)
            };
            if (home != null) start.EnvironmentVariables["WINDOWS_USE_HOME"] = home;
            process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += (sender, args) => Receive(args.Data);
            // Never forward arbitrary stderr or IPC registration contents into the UI/logs.
            process.ErrorDataReceived += (sender, args) => { };
            if (!process.Start()) throw new IOException("Windows 제어 프로세스를 시작할 수 없습니다.");
            try { if (OnStarted != null) OnStarted(process); }
            catch { process.Kill(); throw; }
            writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            return await WithTimeout(ready.Task, 20000);
        }

        void Receive(string line)
        {
            // EOF follows all stdout replies. Process.Exited may race ahead of the final reply.
            if (line == null) { Fail("Windows 제어 프로세스가 종료되었습니다. 다시 시작해 주세요."); return; }
            if (String.IsNullOrWhiteSpace(line)) return;
            try
            {
                if (line.Length > 65536) throw new IOException("Control reply exceeded the size limit.");
                var reply = Deserialize(line);
                if (reply == null) throw new IOException("Invalid control reply.");
                if (reply.@event == "fatal") { Fail(reply.error == null ? "Client startup failed." : reply.error.message); return; }
                if (reply.@event == "ready") ready.TrySetResult(reply.result);
                TaskCompletionSource<Reply> request;
                if (pending.TryRemove(reply.id, out request))
                {
                    if (reply.ok) request.TrySetResult(reply);
                    else request.TrySetException(new IOException(reply.error == null ? "Client command failed." : reply.error.message));
                }
                if (reply.ok && reply.result != null && Changed != null) Changed(reply.result);
            }
            catch (Exception error) { Fail(error.Message); }
        }

        void Fail(string message)
        {
            if (Interlocked.Exchange(ref failed, 1) != 0) return;
            var error = new IOException(message);
            ready.TrySetException(error);
            foreach (var item in pending)
            {
                TaskCompletionSource<Reply> request;
                if (pending.TryRemove(item.Key, out request)) request.TrySetException(error);
            }
            if (!stopping && Failed != null) Failed(message);
        }

        public async Task<Reply> RequestAsync(string command, Connection connection = null, int timeoutMs = 70000)
        {
            int id = Interlocked.Increment(ref sequence);
            var reply = new TaskCompletionSource<Reply>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[id] = reply;
            try
            {
                lock (writerLock)
                {
                    if (writer == null || process.HasExited) throw new IOException("Client is not running.");
                    writer.WriteLine(Serialize(new ControlRequest { id = id, command = command, connection = connection }));
                }
                return await WithTimeout(reply.Task, timeoutMs);
            }
            finally { TaskCompletionSource<Reply> removed; pending.TryRemove(id, out removed); }
        }

        static async Task<T> WithTimeout<T>(Task<T> task, int milliseconds)
        {
            using (var cancellation = new CancellationTokenSource())
            {
                if (await Task.WhenAny(task, Task.Delay(milliseconds, cancellation.Token)) != task)
                    throw new TimeoutException("응답 시간이 초과되었습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.");
                cancellation.Cancel();
                return await task;
            }
        }

        public async Task StopAsync()
        {
            stopping = true;
            if (process == null || process.HasExited) return;
            try { await RequestAsync("quit"); }
            finally { lock (writerLock) { if (writer != null) writer.Close(); writer = null; } }
            if (!await Task.Run(() => process.WaitForExit(65000))) throw new TimeoutException("진행 중인 작업이 끝나지 않아 종료하지 못했습니다.");
        }

        public void Dispose()
        {
            stopping = true;
            lock (writerLock) { if (writer != null) writer.Dispose(); writer = null; }
            if (process != null) { if (!process.HasExited) process.Kill(); process.Dispose(); process = null; }
        }
    }
}
