using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Accessibility;

public sealed class OrcaMsaaFrame {
    public int x, y, width, height;
}

public sealed class OrcaMsaaNode {
    public int index, depth;
    public int[] runtimeId;
    public string automationId = "", name, controlType, localizedControlType, className = "MSAA", value;
    public bool isSelected, isFocused;
    public long nativeWindowHandle;
    public OrcaMsaaFrame frame;
    public string[] actions;
    internal IAccessible accessible;
    internal int child, state;
}

public sealed class OrcaMsaaTree {
    public OrcaMsaaNode[] elements;
    public bool truncated, maxDepthReached;
    public int errors;
}

public static class OrcaMsaa {
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    [DllImport("oleacc.dll")]
    private static extern int AccessibleChildren(IAccessible accessible, int start, int count,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children, out int obtained);

    public static OrcaMsaaTree Read(IntPtr window, int left, int top, int maxNodes, int maxDepth, int textLimit) {
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IAccessible root;
        Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(window, 0xFFFFFFFC, ref iid, out root));
        var result = new OrcaMsaaTree();
        var nodes = new List<OrcaMsaaNode>();
        Visit(root, 0, 0, window, left, top, maxNodes, maxDepth, textLimit, nodes, result);
        result.elements = nodes.ToArray();
        return result;
    }

    private static string Limit(string value, int length) {
        value = value ?? "";
        return value.Length <= length ? value : value.Substring(0, length) + "...";
    }

    private static bool Sensitive(params string[] metadata) {
        // Match runtime.ps1's Test-OrcaSensitiveElement before reading accValue.
        string haystack = Regex.Replace(String.Join(" ", metadata), @"\s+", " ").ToLowerInvariant();
        foreach (string term in new string[] { "password", "passcode", "secret", "one-time code", "verification code" }) {
            if (haystack.Contains(term)) return true;
        }
        return Regex.IsMatch(haystack, @"(^|[^a-z0-9])pin([^a-z0-9]|$)");
    }

    private static T Optional<T>(Func<T> read, T fallback) {
        try { return read(); }
        catch (COMException error) {
            if (error.ErrorCode != unchecked((int)0x80020003) && error.ErrorCode != unchecked((int)0x80004001)) throw;
            return fallback;
        }
    }

    private static int[] Identity(IAccessible accessible, int child, IntPtr window) {
        // COM pointers and sibling ordinals cannot identify an object across CLI processes.
        // Keep IAccIdentity's opaque bytes intact, including the requested native child ID.
        // https://learn.microsoft.com/windows/win32/api/oleacc/nf-oleacc-iaccidentity-getidentitystring
        var provider = accessible as IAccIdentity;
        if (provider == null) return null;
        IntPtr slot = Marshal.AllocCoTaskMem(IntPtr.Size);
        Marshal.WriteIntPtr(slot, IntPtr.Zero);
        try {
            uint length;
            provider.GetIdentityString(unchecked((uint)child), slot, out length);
            IntPtr buffer = Marshal.ReadIntPtr(slot);
            if (buffer == IntPtr.Zero || length == 0 || length > 65536) return null;
            var bytes = new byte[(int)length];
            Marshal.Copy(buffer, bytes, 0, bytes.Length);
            var identity = new int[bytes.Length + 3];
            identity[0] = -34; // Versioned separately from the old ordinal-based IDs.
            identity[1] = unchecked((int)window.ToInt64());
            identity[2] = (int)(window.ToInt64() >> 32);
            for (int i = 0; i < bytes.Length; i++) identity[i + 3] = bytes[i];
            return identity;
        } catch (COMException) { return null; }
        finally {
            Marshal.FreeCoTaskMem(Marshal.ReadIntPtr(slot));
            Marshal.FreeCoTaskMem(slot);
        }
    }

    private static string Role(int role) {
        switch (role) {
            case 9: return "window"; case 10: return "pane"; case 12: return "menu item";
            case 18: return "dialog"; case 33: return "list"; case 34: return "list item";
            case 35: return "tree"; case 36: return "tree item"; case 37: return "tab item";
            case 41: return "text"; case 42: return "edit"; case 43: return "button";
            case 44: return "check box"; case 45: return "radio button"; case 46: return "combo box";
            case 62: return "button"; default: return "MSAA role " + role;
        }
    }

    private static void Visit(IAccessible accessible, int child, int depth, IntPtr window,
        int left, int top, int maxNodes, int maxDepth, int textLimit, List<OrcaMsaaNode> nodes, OrcaMsaaTree result) {
        if (nodes.Count >= maxNodes || depth > maxDepth) {
            result.truncated = true;
            if (depth > maxDepth) result.maxDepthReached = true;
            return;
        }
        try {
            int[] identity = Identity(accessible, child, window);
            int state = Convert.ToInt32(accessible.get_accState(child));
            object rawRole = accessible.get_accRole(child);
            int role = rawRole is int ? (int)rawRole : 0;
            string customRole = rawRole as string;
            string roleName = customRole ?? Role(role);
            bool protectedValue = (state & 0x20000000) != 0;
            string rawName = protectedValue ? "[redacted]" : Optional(() => accessible.get_accName(child), "");
            string name = protectedValue ? "[redacted]" : Limit(rawName, textLimit);
            bool sensitiveValue = protectedValue || Sensitive(rawName, roleName);
            if (!sensitiveValue && role == 42) {
                sensitiveValue = Sensitive(rawName, roleName,
                    Optional(() => accessible.get_accDescription(child), ""),
                    Optional(() => accessible.get_accHelp(child), ""));
            }
            string value = "";
            // Do not query values for arbitrary containers or sensitive controls.
            if (sensitiveValue) value = "[redacted]";
            else if (role == 42) value = Limit(Optional(() => accessible.get_accValue(child), ""), textLimit);
            var actions = new List<string>();
            if (!String.IsNullOrEmpty(Optional(() => accessible.get_accDefaultAction(child), ""))) actions.Add("Invoke");
            if ((state & 0x200000) != 0) actions.Add("Select");
            if (role == 42 && (state & 0x40) == 0) actions.Add("SetValue");
            if (identity == null) actions.Clear();
            var frame = Optional<OrcaMsaaFrame>(() => {
                int x, y, width, height;
                accessible.accLocation(out x, out y, out width, out height, child);
                return width > 0 && height > 0 ? new OrcaMsaaFrame { x = x - left, y = y - top, width = width, height = height } : null;
            }, null);
            nodes.Add(new OrcaMsaaNode {
                index = nodes.Count, depth = depth, runtimeId = identity, name = name, value = value,
                // Keep custom strings distinct from system constants, including strings like "42".
                controlType = customRole == null ? "MSAA." + role : "MSAA.custom." + customRole,
                localizedControlType = Limit(roleName, textLimit),
                isSelected = (state & 2) != 0, isFocused = (state & 4) != 0, nativeWindowHandle = window.ToInt64(),
                frame = frame,
                actions = actions.ToArray(), accessible = accessible, child = child, state = state
            });
            if (child != 0) return;
            int actualCount = accessible.accChildCount;
            int count = Math.Min(actualCount, Math.Max(0, maxNodes - nodes.Count));
            if (actualCount > count) result.truncated = true;
            if (count == 0) return;
            var children = new object[count]; int obtained;
            Marshal.ThrowExceptionForHR(AccessibleChildren(accessible, 0, count, children, out obtained));
            for (int i = 0; i < obtained; i++) {
                if (children[i] is int) Visit(accessible, (int)children[i], depth + 1, window, left, top, maxNodes, maxDepth, textLimit, nodes, result);
                else if (children[i] != null) Visit((IAccessible)children[i], 0, depth + 1, window, left, top, maxNodes, maxDepth, textLimit, nodes, result);
            }
        } catch (COMException) { result.errors++; }
    }

    public static OrcaMsaaNode Resolve(OrcaMsaaTree tree, int[] identity, string name, string controlType) {
        OrcaMsaaNode match = null;
        foreach (var node in tree.elements) {
            if (!SameIdentity(identity, node.runtimeId)) continue;
            if (match != null) throw new InvalidOperationException("stale MSAA element; ambiguous native identity");
            match = node;
        }
        if (match != null && match.name == name && match.controlType == controlType) return match;
        throw new InvalidOperationException("stale MSAA element; take a fresh snapshot");
    }

    private static bool SameIdentity(int[] left, int[] right) {
        if (left == null || right == null || left.Length < 4 || left[0] != -34 || left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
        return true;
    }

    public static void Act(OrcaMsaaNode node, string action, string value) {
        if (!SameIdentity(node.runtimeId, node.runtimeId)) throw new InvalidOperationException("stale MSAA element; native identity unavailable");
        if ((node.state & 0x8001) != 0) throw new InvalidOperationException("MSAA element is hidden or disabled");
        if (action == "invoke" && Array.IndexOf(node.actions, "Invoke") >= 0) node.accessible.accDoDefaultAction(node.child);
        else if (action == "select" && Array.IndexOf(node.actions, "Select") >= 0) node.accessible.accSelect(3, node.child);
        else if (action == "setValue" && Array.IndexOf(node.actions, "SetValue") >= 0) node.accessible.set_accValue(node.child, value);
        else throw new InvalidOperationException("Unsupported MSAA action: " + action);
    }
}
