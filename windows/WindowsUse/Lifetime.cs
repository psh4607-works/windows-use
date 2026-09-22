using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Threading;
using Microsoft.Win32;

namespace WindowsUse
{
    static class Startup
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public static bool Enabled { get { using (var key = Registry.CurrentUser.OpenSubKey(RunKey)) return key != null && (string)key.GetValue("WindowsUse") == Command; } }
        static string Command { get { return "\"" + System.Reflection.Assembly.GetExecutingAssembly().Location + "\" --background"; } }
        public static void Set(bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
                if (enabled) key.SetValue("WindowsUse", Command); else key.DeleteValue("WindowsUse", false);
        }
    }

    sealed class Lifetime : IDisposable
    {
        readonly Mutex mutex;
        public readonly EventWaitHandle Stop;
        public readonly EventWaitHandle Show;
        public readonly bool IsOwner;
        static string Prefix { get { return @"Global\WindowsUse." + WindowsIdentity.GetCurrent().User.Value; } }
        public Lifetime()
        {
            bool created;
            var user = WindowsIdentity.GetCurrent().User;
            var mutexSecurity = new MutexSecurity();
            mutexSecurity.AddAccessRule(new MutexAccessRule(user, MutexRights.FullControl, AccessControlType.Allow));
            mutex = new Mutex(true, Prefix + ".Owner", out created, mutexSecurity);
            IsOwner = created;
            var eventSecurity = new EventWaitHandleSecurity();
            eventSecurity.AddAccessRule(new EventWaitHandleAccessRule(user, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            Stop = new EventWaitHandle(false, EventResetMode.AutoReset, Prefix + ".Stop", out created, eventSecurity);
            Show = new EventWaitHandle(false, EventResetMode.AutoReset, Prefix + ".Show", out created, eventSecurity);
        }
        public static int Shutdown()
        {
            try
            {
                using (var stop = EventWaitHandle.OpenExisting(Prefix + ".Stop")) stop.Set();
                using (var owner = Mutex.OpenExisting(Prefix + ".Owner"))
                {
                    bool acquired;
                    try { acquired = owner.WaitOne(75000); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) return 3;
                    owner.ReleaseMutex();
                }
            }
            catch (WaitHandleCannotBeOpenedException) { }
            return 0;
        }
        public void Dispose() { Stop.Dispose(); Show.Dispose(); if (IsOwner) mutex.ReleaseMutex(); mutex.Dispose(); }
    }

    // The entire desktop process tree exits if the tray crashes or Windows ends the login session.
    sealed class ChildJob : IDisposable
    {
        IntPtr handle;
        [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public ChildJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            var info = new Extended(); info.BasicLimitInformation.LimitFlags = 0x2000;
            if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(info)))
            { Dispose(); throw new System.ComponentModel.Win32Exception(); }
        }
        public void Attach(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception(); }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
}
