// OurCode Computer Use helper (Windows, .NET Framework 4.8, C# 5).
//
// Same NDJSON protocol as UiaBridge.ps1 (cua-ips/1), same method surface, but a
// compiled process: no PowerShell startup cost per spawn, no PS object pipeline
// between UIA calls. Built with the in-box csc.exe (see build.ps1) so it needs
// nothing installed beyond the .NET Framework that ships with Windows.
//
// Rules that matter (identical to the PS helper):
//   - per-monitor-v2 DPI awareness before touching any UI;
//   - element indexes are valid only for the LATEST capture of that window;
//   - no policy/approval decisions here — the main process owns them.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

static class Native
{
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    public static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = scan;
        i.U.ki.dwFlags = flags;
        return i;
    }

    public static void KeyDown(ushort vk) { INPUT[] a = new INPUT[] { Key(vk, 0, 0) }; SendInput(1, a, Marshal.SizeOf(typeof(Native.INPUT))); }
    public static void KeyUp(ushort vk) { INPUT[] a = new INPUT[] { Key(vk, 0, KEYEVENTF_KEYUP) }; SendInput(1, a, Marshal.SizeOf(typeof(Native.INPUT))); }

    public static void TypeUnicode(string text)
    {
        foreach (char ch in text)
        {
            Native.INPUT[] down = new Native.INPUT[] { Key(0, (ushort)ch, KEYEVENTF_UNICODE) };
            SendInput(1, down, Marshal.SizeOf(typeof(Native.INPUT)));
            Native.INPUT[] up = new Native.INPUT[] { Key(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
            SendInput(1, up, Marshal.SizeOf(typeof(Native.INPUT)));
        }
    }

    static INPUT Mouse(uint flags, int data)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dwFlags = flags;
        i.U.mi.mouseData = (uint)data;
        return i;
    }

    public static void MouseButton(uint down, uint up, int count)
    {
        for (int i = 0; i < count; i++)
        {
            INPUT[] d = new INPUT[] { Mouse(down, 0) }; SendInput(1, d, Marshal.SizeOf(typeof(Native.INPUT)));
            INPUT[] u = new INPUT[] { Mouse(up, 0) }; SendInput(1, u, Marshal.SizeOf(typeof(Native.INPUT)));
            System.Threading.Thread.Sleep(30);
        }
    }

    public static void Wheel(int delta)
    {
        INPUT[] a = new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, delta) };
        SendInput(1, a, Marshal.SizeOf(typeof(Native.INPUT)));
    }
}

class CuaException : Exception
{
    public string Code;
    public bool ActionSent;
    public CuaException(string code, string message) : base(message) { Code = code; ActionSent = false; }
    public CuaException(string code, string message, bool actionSent) : base(message) { Code = code; ActionSent = actionSent; }
}

static class Program
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Dictionary<string, List<AutomationElement>> Sessions = new Dictionary<string, List<AutomationElement>>();
    static string Token;
    static bool Handshaken;

    [STAThread]
    static void Main()
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); Console.InputEncoding = Encoding.UTF8; } catch { }
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        Token = Environment.GetEnvironmentVariable("OURCODE_CUA_TOKEN");

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> req = null;
            try { req = Json.DeserializeObject(line) as Dictionary<string, object>; } catch { continue; }
            if (req == null) continue;

            object id = req.ContainsKey("id") ? req["id"] : null;
            string method = AsString(req, "method");
            Dictionary<string, object> p = new Dictionary<string, object>();
            if (req.ContainsKey("params") && req["params"] is Dictionary<string, object>) p = (Dictionary<string, object>)req["params"];

            try
            {
                if (!Handshaken)
                {
                    if (method != "hello" || Token == null || AsString(p, "token") != Token)
                    {
                        Fail(id, "PERMISSION_DENIED", "handshake 失败：token 不匹配", false);
                        break;
                    }
                    Handshaken = true;
                    Dictionary<string, object> hello = new Dictionary<string, object>();
                    hello["protocol"] = "cua-ips/1";
                    hello["platform"] = "win32";
                    hello["capabilities"] = new object[] { "uia", "sendinput", "gdi", "clipboard", "csharp" };
                    hello["permission"] = PermissionStatus();
                    Ok(id, hello);
                    continue;
                }

                switch (method)
                {
                    case "broker_info":
                        Ok(id, BrokerInfo());
                        break;
                    case "permission_status":
                        Ok(id, PermissionStatus());
                        break;
                    case "list_apps":
                        Ok(id, ListApps());
                        break;
                    case "capture_app":
                        Ok(id, CaptureApp(p));
                        break;
                    case "screenshot":
                        Ok(id, Screenshot(p));
                        break;
                    case "click":
                        Ok(id, Click(p));
                        break;
                    case "set_value":
                        Ok(id, SetValue(p));
                        break;
                    case "select_text":
                        Ok(id, SelectText(p));
                        break;
                    case "element_perform_action":
                        Ok(id, PerformAction(p));
                        break;
                    case "type_text":
                        Ok(id, TypeText(p));
                        break;
                    case "press_key":
                        Ok(id, PressKey(p));
                        break;
                    case "paste":
                        Ok(id, Paste(p));
                        break;
                    case "scroll":
                        Ok(id, Scroll(p));
                        break;
                    case "drag":
                        Ok(id, Drag(p));
                        break;
                    case "activate_window":
                        Ok(id, ActivateWindow(p));
                        break;
                    case "launch_app":
                        Ok(id, LaunchApp(p));
                        break;
                    case "controller_stop":
                        Ok(id, Simple(true));
                        break;
                    case "shutdown":
                        Ok(id, Simple(true));
                        return;
                    default:
                        Fail(id, "UNSUPPORTED", "未实现的方法：" + method, false);
                        break;
                }
            }
            catch (CuaException ce)
            {
                Fail(id, ce.Code, ce.Message, ce.ActionSent || IsWrite(method));
            }
            catch (Exception ex)
            {
                string code = "INTERNAL";
                string msg = ex.Message;
                if (msg.IndexOf("ElementNotAvailable", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    msg.IndexOf("0x80040201", StringComparison.OrdinalIgnoreCase) >= 0) code = "ELEMENT_UNAVAILABLE";
                else if (msg.IndexOf("ElementNotEnabled", StringComparison.OrdinalIgnoreCase) >= 0) code = "ACTION_UNAVAILABLE";
                else if (ex is InvalidOperationException) code = "ACTION_UNAVAILABLE";
                Fail(id, code, msg, IsWrite(method));
            }
        }
    }

    // ── protocol helpers ────────────────────────────────────────────────────

    static bool IsWrite(string method)
    {
        switch (method)
        {
            case "click":
            case "type_text":
            case "press_key":
            case "set_value":
            case "scroll":
            case "drag":
            case "paste":
            case "element_perform_action":
            case "select_text":
            case "activate_window":
            case "launch_app":
                return true;
            default:
                return false;
        }
    }

    static Dictionary<string, object> Simple(bool value)
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["ok"] = value;
        return d;
    }

    static void Ok(object id, object result)
    {
        Dictionary<string, object> msg = new Dictionary<string, object>();
        msg["id"] = id;
        msg["ok"] = true;
        msg["result"] = result;
        Write(msg);
    }

    static void Fail(object id, string code, string message, bool actionSent)
    {
        Dictionary<string, object> err = new Dictionary<string, object>();
        err["code"] = code;
        err["message"] = message;
        err["actionSent"] = actionSent;
        Dictionary<string, object> msg = new Dictionary<string, object>();
        msg["id"] = id;
        msg["ok"] = false;
        msg["error"] = err;
        Write(msg);
    }

    static void Write(Dictionary<string, object> msg)
    {
        string text = Json.Serialize(msg);
        Console.Out.WriteLine(text);
        Console.Out.Flush();
    }

    static string AsString(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return "";
        return Convert.ToString(d[key]);
    }

    static int AsInt(Dictionary<string, object> d, string key, int fallback)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
        try { return Convert.ToInt32(d[key]); } catch { return fallback; }
    }

    static long AsLong(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return 0;
        try { return Convert.ToInt64(d[key]); } catch { return 0; }
    }

    static bool AsBool(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return false;
        try { return Convert.ToBoolean(d[key]); } catch { return false; }
    }

    static Dictionary<string, object> BrokerInfo()
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["protocol"] = "cua-ips/1";
        d["platform"] = "win32";
        d["capabilities"] = new object[] { "uia", "sendinput", "gdi", "clipboard", "csharp" };
        return d;
    }

    static Dictionary<string, object> PermissionStatus()
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["interactiveSession"] = true;
        d["dpiAware"] = true;
        d["screenCapture"] = true;
        d["accessibility"] = "not_required";
        d["screenRecording"] = "not_required";
        return d;
    }

    // ── windows / apps ──────────────────────────────────────────────────────

    static string ProcessName(int pid)
    {
        try { return Process.GetProcessById(pid).ProcessName; } catch { return ""; }
    }

    static int[] Bounds(AutomationElement el)
    {
        try
        {
            System.Windows.Rect r = el.Current.BoundingRectangle;
            if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return null;
            return new int[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height };
        }
        catch { return null; }
    }

    static List<Dictionary<string, object>> WindowList()
    {
        List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
        AutomationElementCollection kids = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in kids)
        {
            try
            {
                AutomationElement.AutomationElementInformation cur = w.Current;
                if (cur.ProcessId <= 0) continue;
                IntPtr hwnd = new IntPtr(cur.NativeWindowHandle);
                if (hwnd == IntPtr.Zero) continue;
                bool visible = Native.IsWindowVisible(hwnd);
                bool minimized = Native.IsIconic(hwnd);
                if (!visible && !minimized) continue;
                if (string.IsNullOrEmpty(cur.Name) && string.IsNullOrEmpty(cur.ClassName)) continue;
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["pid"] = cur.ProcessId;
                d["name"] = ProcessName(cur.ProcessId);
                d["title"] = cur.Name;
                d["className"] = cur.ClassName;
                d["windowId"] = (long)hwnd.ToInt64();
                d["visible"] = visible;
                d["minimized"] = minimized;
                d["bounds"] = Bounds(w);
                list.Add(d);
            }
            catch { }
        }
        return list;
    }

    static Dictionary<string, object> ResolveWindow(Dictionary<string, object> app)
    {
        long wantWindow = AsLong(app, "windowId");
        int wantPid = AsInt(app, "pid", 0);
        string wantName = AsString(app, "name");
        List<Dictionary<string, object>> windows = WindowList();

        if (wantWindow != 0)
            foreach (Dictionary<string, object> w in windows)
                if (AsLong(w, "windowId") == wantWindow) return w;
        if (wantPid != 0)
            foreach (Dictionary<string, object> w in windows)
                if (AsInt(w, "pid", 0) == wantPid) return w;
        if (wantName.Length > 0)
            foreach (Dictionary<string, object> w in windows)
            {
                string hay = AsString(w, "name") + " " + AsString(w, "title");
                if (hay.IndexOf(wantName, StringComparison.OrdinalIgnoreCase) >= 0) return w;
            }
        return windows.Count > 0 ? windows[0] : null;
    }

    static string SessionKey(Dictionary<string, object> window)
    {
        return AsInt(window, "pid", 0) + ":" + AsLong(window, "windowId");
    }

    static AutomationElement ElementAt(Dictionary<string, object> app, int index)
    {
        Dictionary<string, object> window = ResolveWindow(app);
        if (window == null) throw new CuaException("WINDOW_NOT_FOUND", "找不到目标窗口");
        string key = SessionKey(window);
        if (!Sessions.ContainsKey(key)) throw new CuaException("TARGET_STALE", "请先 capture_app 观察该窗口");
        List<AutomationElement> list = Sessions[key];
        if (index < 0 || index >= list.Count)
            throw new CuaException("TARGET_STALE", "元素索引 " + index + " 不在最新观察里（共 " + list.Count + " 个）");
        return list[index];
    }

    // ── capture ─────────────────────────────────────────────────────────────

    class Walker
    {
        public List<object> Elements = new List<object>();
        public List<AutomationElement> Native = new List<AutomationElement>();
        public int Max;
        public bool Truncated;

        public void Walk(AutomationElement el, int depth)
        {
            if (Truncated) return;
            if (Elements.Count >= Max) { Truncated = true; return; }
            AutomationElement.AutomationElementInformation cur;
            try { cur = el.Current; } catch { return; }

            string role = cur.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
            string name = cur.Name ?? "";
            object[] actions = Actions(el);
            bool keep = name.Length > 0 || actions.Length > 0 || depth <= 1;
            if (keep)
            {
                Dictionary<string, object> node = new Dictionary<string, object>();
                node["index"] = Elements.Count;
                node["role"] = role;
                node["name"] = name;
                node["value"] = ElementValue(el);
                node["automationId"] = cur.AutomationId ?? "";
                node["enabled"] = cur.IsEnabled;
                node["actions"] = actions;
                node["bounds"] = Bounds(el);
                Elements.Add(node);
                Native.Add(el);
            }
            if (depth >= 12) return;
            AutomationElement child = null;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { child = null; }
            while (child != null)
            {
                Walk(child, depth + 1);
                if (Truncated) return;
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { break; }
            }
        }
    }

    static object[] Actions(AutomationElement el)
    {
        List<object> names = new List<object>();
        object obj;
        try { if (el.TryGetCurrentPattern(InvokePattern.Pattern, out obj)) names.Add("press"); } catch { }
        try
        {
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out obj))
            {
                ValuePattern vp = (ValuePattern)obj;
                if (!vp.Current.IsReadOnly) names.Add("set_value");
            }
        }
        catch { }
        try { if (el.TryGetCurrentPattern(TogglePattern.Pattern, out obj)) names.Add("toggle"); } catch { }
        try { if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out obj)) names.Add("select"); } catch { }
        try { if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out obj)) names.Add("expand"); } catch { }
        try { if (el.TryGetCurrentPattern(ScrollPattern.Pattern, out obj)) names.Add("scroll"); } catch { }
        try { if (el.TryGetCurrentPattern(TextPattern.Pattern, out obj)) names.Add("select_text"); } catch { }
        return names.ToArray();
    }

    static string ElementValue(AutomationElement el)
    {
        try
        {
            object obj;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out obj))
            {
                string v = ((ValuePattern)obj).Current.Value;
                if (v != null) return v;
            }
        }
        catch { }
        return "";
    }

    static Dictionary<string, object> CaptureApp(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        Dictionary<string, object> window = ResolveWindow(app);
        if (window == null) throw new CuaException("WINDOW_NOT_FOUND", "找不到目标窗口（先 list_apps）");
        if (AsBool(window, "minimized")) throw new CuaException("WINDOW_NOT_VISIBLE", "窗口已最小化：先恢复窗口再观察");

        long hwnd = AsLong(window, "windowId");
        AutomationElement winEl = AutomationElement.FromHandle(new IntPtr(hwnd));
        if (winEl == null) throw new CuaException("WINDOW_NOT_FOUND", "窗口句柄无效");

        int maxNodes = AsInt(p, "maxNodes", 300);
        if (maxNodes < 20) maxNodes = 20;

        Walker walker = new Walker();
        walker.Max = maxNodes;
        walker.Walk(winEl, 0);

        Sessions[SessionKey(window)] = walker.Native;

        Dictionary<string, object> result = new Dictionary<string, object>();
        Dictionary<string, object> appOut = new Dictionary<string, object>();
        appOut["pid"] = AsInt(window, "pid", 0);
        appOut["name"] = AsString(window, "name");
        result["app"] = appOut;
        Dictionary<string, object> winOut = new Dictionary<string, object>();
        winOut["windowId"] = hwnd;
        winOut["title"] = AsString(window, "title");
        winOut["className"] = AsString(window, "className");
        winOut["main"] = true;
        winOut["focused"] = ForegroundPid() == AsInt(window, "pid", 0);
        winOut["visible"] = AsBool(window, "visible");
        winOut["minimized"] = false;
        winOut["bounds"] = window.ContainsKey("bounds") ? window["bounds"] : null;
        result["window"] = winOut;
        result["elements"] = walker.Elements.ToArray();
        result["nodeCount"] = walker.Elements.Count;
        result["truncated"] = walker.Truncated;

        if (AsBool(p, "includeScreenshot"))
        {
            string path; int w; int h;
            SaveWindowPng(window, out path, out w, out h);
            Dictionary<string, object> image = new Dictionary<string, object>();
            image["path"] = path;
            image["width"] = w;
            image["height"] = h;
            image["scale"] = 1;
            result["image"] = image;
        }
        return result;
    }

    static Dictionary<string, object> ListApps()
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["apps"] = WindowList().ToArray();
        return d;
    }

    // ── screenshot ──────────────────────────────────────────────────────────

    static int ForegroundPid()
    {
        uint pid;
        Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
        return (int)pid;
    }

    static void SaveWindowPng(Dictionary<string, object> window, out string path, out int width, out int height)
    {
        int[] b = window.ContainsKey("bounds") ? window["bounds"] as int[] : null;
        if (b == null) throw new CuaException("WINDOW_NOT_VISIBLE", "窗口没有可截图的区域");
        width = b[2]; height = b[3];
        if (width <= 0 || height <= 0) throw new CuaException("WINDOW_NOT_VISIBLE", "窗口尺寸为 0");
        string dir = Path.Combine(Path.GetTempPath(), "ourcode-cua");
        Directory.CreateDirectory(dir);
        path = Path.Combine(dir, "frame-" + Guid.NewGuid().ToString("n") + ".png");
        using (Bitmap bmp = new Bitmap(width, height))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(b[0], b[1], 0, 0, new Size(width, height));
            }
            bmp.Save(path, ImageFormat.Png);
        }
    }

    static Dictionary<string, object> Screenshot(Dictionary<string, object> p)
    {
        string path; int w; int h;
        if (AsString(p, "target") == "screen")
        {
            Rectangle vs = SystemInformation.VirtualScreen;
            Dictionary<string, object> fake = new Dictionary<string, object>();
            fake["bounds"] = new int[] { vs.X, vs.Y, vs.Width, vs.Height };
            SaveWindowPng(fake, out path, out w, out h);
        }
        else
        {
            Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
            Dictionary<string, object> window = ResolveWindow(app);
            if (window == null) throw new CuaException("WINDOW_NOT_FOUND", "找不到目标窗口");
            SaveWindowPng(window, out path, out w, out h);
        }
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["path"] = path;
        d["width"] = w;
        d["height"] = h;
        d["scale"] = 1;
        d["unit"] = "physical_pixel";
        return d;
    }

    // ── actions ─────────────────────────────────────────────────────────────

    static void ClickPoint(int x, int y, string button, int count)
    {
        Native.SetCursorPos(x, y);
        System.Threading.Thread.Sleep(40);
        uint down = Native.MOUSEEVENTF_LEFTDOWN; uint up = Native.MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = Native.MOUSEEVENTF_RIGHTDOWN; up = Native.MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = Native.MOUSEEVENTF_MIDDLEDOWN; up = Native.MOUSEEVENTF_MIDDLEUP; }
        Native.MouseButton(down, up, Math.Max(1, count));
    }

    static Dictionary<string, object> Click(Dictionary<string, object> p)
    {
        string button = AsString(p, "button");
        if (button.Length == 0) button = "left";
        int count = AsInt(p, "count", 1);
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();

        Dictionary<string, object> d = new Dictionary<string, object>();
        if (p.ContainsKey("elementIndex") && p["elementIndex"] != null)
        {
            AutomationElement el = ElementAt(app, AsInt(p, "elementIndex", 0));
            string strategy = AsString(p, "strategy");
            bool invoked = false;
            if (strategy != "event")
            {
                try
                {
                    object obj;
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out obj))
                    {
                        ((InvokePattern)obj).Invoke();
                        invoked = true;
                    }
                }
                catch { invoked = false; }
            }
            if (!invoked)
            {
                int[] b = Bounds(el);
                if (b == null) throw new CuaException("ELEMENT_UNAVAILABLE", "元素没有可点击区域");
                ClickPoint(b[0] + b[2] / 2, b[1] + b[3] / 2, button, count);
            }
            d["ok"] = true;
            d["strategy"] = invoked ? "a11y" : "event";
            return d;
        }

        int x = AsInt(p, "x", int.MinValue);
        int y = AsInt(p, "y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue) throw new CuaException("TARGET_STALE", "需要 elementIndex 或 x/y 坐标");
        ClickPoint(x, y, button, count);
        d["ok"] = true;
        d["strategy"] = "event";
        return d;
    }

    static void EnsureForeground(Dictionary<string, object> window)
    {
        if (ForegroundPid() != AsInt(window, "pid", 0))
            throw new CuaException("FOREGROUND_REQUIRED", "目标窗口不在前台：先用 activate_window，或改用元素动作");
    }

    static Dictionary<string, object> SetValue(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        AutomationElement el = ElementAt(app, AsInt(p, "elementIndex", 0));
        object obj;
        if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out obj))
            throw new CuaException("NOT_SETTABLE", "该元素不支持 set_value");
        ValuePattern vp = (ValuePattern)obj;
        if (vp.Current.IsReadOnly) throw new CuaException("NOT_SETTABLE", "该元素是只读的");
        vp.SetValue(AsString(p, "value"));
        return Simple(true);
    }

    static Dictionary<string, object> SelectText(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        AutomationElement el = ElementAt(app, AsInt(p, "elementIndex", 0));
        object obj;
        if (!el.TryGetCurrentPattern(TextPattern.Pattern, out obj))
            throw new CuaException("NOT_SELECTABLE", "该元素不支持文本选择");
        ((TextPattern)obj).DocumentRange.Select();
        return Simple(true);
    }

    static Dictionary<string, object> PerformAction(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        AutomationElement el = ElementAt(app, AsInt(p, "elementIndex", 0));
        string action = AsString(p, "action").ToLowerInvariant();
        if (action.Length == 0) action = "press";
        object obj;
        if (action == "press" || action == "invoke" || action == "click")
        {
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out obj)) { ((InvokePattern)obj).Invoke(); return Simple(true); }
        }
        else if (action == "expand" || action == "collapse")
        {
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out obj))
            {
                ExpandCollapsePattern ep = (ExpandCollapsePattern)obj;
                if (action == "expand") ep.Expand(); else ep.Collapse();
                return Simple(true);
            }
        }
        else if (action == "select")
        {
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out obj)) { ((SelectionItemPattern)obj).Select(); return Simple(true); }
        }
        else if (action == "toggle")
        {
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out obj)) { ((TogglePattern)obj).Toggle(); return Simple(true); }
        }
        throw new CuaException("ACTION_UNAVAILABLE", "元素不支持 action=" + action);
    }

    static Dictionary<string, object> TypeText(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        Dictionary<string, object> window = ResolveWindow(app);
        if (window != null) EnsureForeground(window);
        Native.TypeUnicode(AsString(p, "text"));
        return Simple(true);
    }

    static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort>
    {
        { "return", 0x0D }, { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "esc", 0x1B },
        { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E },
        { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
        { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "control_l", 0xA2 }, { "control", 0xA2 }, { "ctrl", 0xA2 },
        { "shift_l", 0xA0 }, { "shift", 0xA0 }, { "alt_l", 0xA4 }, { "alt", 0xA4 }
    };

    static ushort ToVk(string key)
    {
        string k = (key ?? "").Trim();
        if (k.Length == 0) throw new CuaException("ACTION_UNAVAILABLE", "空按键");
        string lower = k.ToLowerInvariant();
        if (lower == "win" || lower == "meta" || lower == "lwin" || lower == "rwin")
            throw new CuaException("FOREGROUND_REQUIRED", "拒绝 Win/Meta 组合键（会与系统全局快捷键冲突）");
        if (Vk.ContainsKey(lower)) return Vk[lower];
        if (k.Length == 1)
        {
            char c = char.ToUpperInvariant(k[0]);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
        }
        throw new CuaException("ACTION_UNAVAILABLE", "不认识的按键：" + key);
    }

    static void PressChord(string keys)
    {
        string[] parts = keys.Split('+');
        List<ushort> codes = new List<ushort>();
        foreach (string part in parts) codes.Add(ToVk(part));
        foreach (ushort c in codes) { Native.KeyDown(c); System.Threading.Thread.Sleep(20); }
        for (int i = codes.Count - 1; i >= 0; i--) { Native.KeyUp(codes[i]); System.Threading.Thread.Sleep(20); }
    }

    static Dictionary<string, object> PressKey(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        Dictionary<string, object> window = ResolveWindow(app);
        if (window != null) EnsureForeground(window);
        PressChord(AsString(p, "keys"));
        return Simple(true);
    }

    static Dictionary<string, object> Paste(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        Dictionary<string, object> window = ResolveWindow(app);
        if (window != null) EnsureForeground(window);
        string previous = "";
        try { if (Clipboard.ContainsText()) previous = Clipboard.GetText(); } catch { }
        Clipboard.SetText(AsString(p, "text"));
        PressChord("Control_L+v");
        System.Threading.Thread.Sleep(80);
        try { Clipboard.SetText(previous); } catch { }
        return Simple(true);
    }

    static Dictionary<string, object> Scroll(Dictionary<string, object> p)
    {
        int amount = AsInt(p, "amount", 1);
        if (amount <= 0) amount = 1;
        int delta = (AsString(p, "direction") == "up" ? 120 : -120) * amount;
        if (p.ContainsKey("elementIndex") && p["elementIndex"] != null)
        {
            Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
            AutomationElement el = ElementAt(app, AsInt(p, "elementIndex", 0));
            int[] b = Bounds(el);
            if (b != null) { Native.SetCursorPos(b[0] + b[2] / 2, b[1] + b[3] / 2); System.Threading.Thread.Sleep(40); }
        }
        else if (p.ContainsKey("x") && p.ContainsKey("y") && p["x"] != null && p["y"] != null)
        {
            Native.SetCursorPos(AsInt(p, "x", 0), AsInt(p, "y", 0));
            System.Threading.Thread.Sleep(40);
        }
        Native.Wheel(delta);
        return Simple(true);
    }

    static Dictionary<string, object> Drag(Dictionary<string, object> p)
    {
        Dictionary<string, object> from = p.ContainsKey("from") ? p["from"] as Dictionary<string, object> : null;
        Dictionary<string, object> to = p.ContainsKey("to") ? p["to"] as Dictionary<string, object> : null;
        if (from == null || to == null) throw new CuaException("TARGET_STALE", "drag 需要 from/to");
        int fx = AsInt(from, "x", 0), fy = AsInt(from, "y", 0);
        int tx = AsInt(to, "x", 0), ty = AsInt(to, "y", 0);
        Native.SetCursorPos(fx, fy);
        System.Threading.Thread.Sleep(60);
        Native.INPUT[] down = new Native.INPUT[] { MouseInput(Native.MOUSEEVENTF_LEFTDOWN) };
        Native.SendInput(1, down, Marshal.SizeOf(typeof(Native.INPUT)));
        for (int i = 1; i <= 10; i++)
        {
            Native.SetCursorPos(fx + (tx - fx) * i / 10, fy + (ty - fy) * i / 10);
            System.Threading.Thread.Sleep(20);
        }
        Native.INPUT[] up = new Native.INPUT[] { MouseInput(Native.MOUSEEVENTF_LEFTUP) };
        Native.SendInput(1, up, Marshal.SizeOf(typeof(Native.INPUT)));
        return Simple(true);
    }

    static Native.INPUT MouseInput(uint flags)
    {
        Native.INPUT i = new Native.INPUT();
        i.type = Native.INPUT_MOUSE;
        i.U.mi.dwFlags = flags;
        return i;
    }

    static Dictionary<string, object> ActivateWindow(Dictionary<string, object> p)
    {
        Dictionary<string, object> app = p.ContainsKey("app") ? p["app"] as Dictionary<string, object> : new Dictionary<string, object>();
        Dictionary<string, object> window = ResolveWindow(app);
        if (window == null) throw new CuaException("WINDOW_NOT_FOUND", "找不到目标窗口");
        IntPtr hwnd = new IntPtr(AsLong(window, "windowId"));
        Native.ShowWindow(hwnd, 9);
        Native.SetForegroundWindow(hwnd);
        Dictionary<string, object> d = Simple(true);
        d["windowId"] = AsLong(window, "windowId");
        return d;
    }

    static Dictionary<string, object> LaunchApp(Dictionary<string, object> p)
    {
        string target = AsString(p, "target");
        string path = AsString(p, "path");
        if (path.Length == 0 && target.Length == 0) throw new CuaException("WINDOW_NOT_FOUND", "launch 需要 target 或 path");
        Process.Start(new ProcessStartInfo(path.Length > 0 ? path : target) { UseShellExecute = true });
        DateTime deadline = DateTime.UtcNow.AddSeconds(12);
        while (DateTime.UtcNow < deadline)
        {
            System.Threading.Thread.Sleep(300);
            Dictionary<string, object> window = ResolveWindow(new Dictionary<string, object> { { "name", target } });
            if (window != null && AsString(window, "title").Length > 0)
            {
                Dictionary<string, object> app = new Dictionary<string, object>();
                app["pid"] = AsInt(window, "pid", 0);
                app["name"] = AsString(window, "name");
                app["windowId"] = AsLong(window, "windowId");
                app["title"] = AsString(window, "title");
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["ok"] = true;
                d["app"] = app;
                return d;
            }
        }
        Dictionary<string, object> pending = new Dictionary<string, object>();
        pending["ok"] = false;
        pending["pending"] = true;
        return pending;
    }
}
