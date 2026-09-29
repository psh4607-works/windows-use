// Managed stand-ins for the oleacc boundary used by runtime-msaa-isolated.test.ps1.
// They intentionally model native child IDs independently of enumeration order.
namespace Accessibility {
    public interface IAccessible {
        object get_accState(object child);
        object get_accRole(object child);
        string get_accName(object child);
        string get_accDescription(object child);
        string get_accHelp(object child);
        string get_accValue(object child);
        string get_accDefaultAction(object child);
        void accLocation(out int x, out int y, out int width, out int height, object child);
        int accChildCount { get; }
        void accDoDefaultAction(object child);
        void accSelect(int flags, object child);
        void set_accValue(object child, string value);
    }

    public interface IAccIdentity {
        void GetIdentityString(uint child, System.IntPtr pointer, out uint length);
    }
}

public class MsaaFixture : Accessibility.IAccessible {
    public string Name = "Delete", Description = "", Help = "", Value = "", Unsupported;
    public object Role = 43;
    public int State, Invocations, ValueReads, LastChild = -1;
    public int Error = unchecked((int)0x80020003);
    public string ErrorMessage = "fixture provider failure";
    public bool MapNotImplemented, MapHResult, UnexpectedFailure;
    public int ChildrenError, ChildrenStatus, ReturnedChildren = -1;
    public object[] Children = new object[0];
    protected void Check(string property) {
        if (Unsupported == property && UnexpectedFailure) throw new System.InvalidOperationException(ErrorMessage);
        if (Unsupported == property && MapHResult) System.Runtime.InteropServices.Marshal.ThrowExceptionForHR(Error);
        if (Unsupported == property && MapNotImplemented && Error == unchecked((int)0x80004001))
            throw new System.NotImplementedException(ErrorMessage);
        if (Unsupported == property) throw new System.Runtime.InteropServices.COMException(ErrorMessage, Error);
    }
    public object get_accState(object child) { Check("state"); return State; }
    public object get_accRole(object child) { Check("role"); return Role; }
    public string get_accName(object child) { Check("name"); return Name; }
    public string get_accDescription(object child) { Check("description"); return Description; }
    public string get_accHelp(object child) { Check("help"); return Help; }
    public string get_accValue(object child) { ValueReads++; Check("value"); return Value; }
    public string get_accDefaultAction(object child) { Check("defaultAction"); return "Press"; }
    public void accLocation(out int x, out int y, out int width, out int height, object child) {
        Check("location"); x = y = 10; width = height = 20;
    }
    public int accChildCount { get { Check("children"); return Children.Length; } }
    public void accDoDefaultAction(object child) { Invocations++; LastChild = (int)child; }
    public void accSelect(int flags, object child) { LastChild = (int)child; }
    public void set_accValue(object child, string value) { LastChild = (int)child; Value = value; }
}

public sealed class IdentifiedMsaaFixture : MsaaFixture, Accessibility.IAccIdentity {
    public int ObjectId;
    public bool IdentityUnavailable;
    public void GetIdentityString(uint child, System.IntPtr pointer, out uint length) {
        Check("identity");
        if (IdentityUnavailable) throw new System.Runtime.InteropServices.COMException("identity", unchecked((int)0x80004001));
        byte[] bytes = new byte[8];
        System.Array.Copy(System.BitConverter.GetBytes(ObjectId), 0, bytes, 0, 4);
        System.Array.Copy(System.BitConverter.GetBytes(child), 0, bytes, 4, 4);
        length = (uint)bytes.Length;
        System.IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocCoTaskMem(bytes.Length);
        System.Runtime.InteropServices.Marshal.Copy(bytes, 0, buffer, bytes.Length);
        System.Runtime.InteropServices.Marshal.WriteIntPtr(pointer, buffer);
    }
}

public static class MsaaFixtureNative {
    public static Accessibility.IAccessible Root;
    public static int AccessibleObjectFromWindow(System.IntPtr window, uint objectId, ref System.Guid iid,
        out Accessibility.IAccessible accessible) { accessible = Root; return 0; }
    public static int AccessibleChildren(Accessibility.IAccessible accessible, int start, int count,
        object[] children, out int obtained) {
        var fixture = (MsaaFixture)accessible;
        object[] source = fixture.Children;
        obtained = System.Math.Min(count, source.Length - start);
        if (fixture.ChildrenError != 0) { obtained = 0; return fixture.ChildrenError; }
        if (fixture.ReturnedChildren >= 0) obtained = System.Math.Min(obtained, fixture.ReturnedChildren);
        System.Array.Copy(source, start, children, 0, obtained);
        return fixture.ChildrenStatus;
    }
}
