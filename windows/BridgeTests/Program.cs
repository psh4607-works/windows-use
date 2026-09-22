using System;
using System.IO;
using System.Diagnostics;
using System.Reflection;
using System.Threading.Tasks;

class BridgeTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static async Task Main(string[] args)
    {
        var type = Assembly.GetExecutingAssembly().GetType("WindowsUse.HostBridge");
        Check(type != null, "Tray bridge must launch the managed host and correlate replies.");
        string home = Path.Combine(Path.GetTempPath(), "wu-b-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        dynamic bridge = Activator.CreateInstance(type);
        try
        {
            dynamic initial = await bridge.StartAsync(args[0], args[1], home);
            Check(initial.status.state == "running", "Initial desktop state must be ready.");
            dynamic paused = await bridge.RequestAsync("pause");
            Check(paused.result.status.state == "paused", "Pause reply must reach the caller.");
            dynamic resumed = await bridge.RequestAsync("resume");
            Check(resumed.result.status.state == "running", "Resume must correlate with its own reply.");
            bool rejected = false;
            try { await bridge.RequestAsync("invalid-command"); } catch (Exception) { rejected = true; }
            Check(rejected, "Command errors must reach the caller.");
            await bridge.StopAsync();
            Check(!File.Exists(Path.Combine(home, "server.json")), "Graceful exit must release desktop registration.");
            Console.WriteLine("PASS: tray bridge ready / pause / resume / errors / graceful exit");
        }
        finally { bridge.Dispose(); if (Directory.Exists(home)) Directory.Delete(home, true); }
    }
}
