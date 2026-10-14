// --probe: app and window in front, element at a point or focused, the front window's tree, the
// clipboard, usage, power. UI Automation (System.Windows.Automation). See designs/
// 2026-10-13-autotrack.md "Probe protocol".
//
// COORDINATE SPACE: physical screen pixels on the virtual desktop (primary monitor's top-left is
// 0,0; other monitors can be negative). Requests and answers use it. This matches uiohook-napi on
// Windows: libuiohook passes MSLLHOOKSTRUCT.pt straight through, documented as per-monitor-aware
// screen coordinates, i.e. physical pixels. This process makes itself per-monitor DPI aware (v2)
// first, so UIA and window rects are physical too. The recorder converts with displays[].scale.
//
// Never returns an element's value, nor a name that shows it (UIA often names a text box by its
// text). Elements carry path (ancestors up to the window), id (AutomationId), cls (ClassName) and
// help, each left out when empty. Chromium turns its UIA tree on by itself when a UIA client asks.
//
// Cost while someone types: a WinEvent hook (foreground and focus changes, out of context, so no
// code goes into other processes) bumps a counter. `focused` answers the last element again while
// no focus event came, the foreground thread's focus window is the same and the answer is under
// 2 s old; the front window's dialog check is kept the same way. UIA has no per-call timeout, so
// a hung app can stall one request; the caller times out to null.
//
// A click's element is read at button-down, in this process: a low-level mouse hook (class Down)
// sees each press, and a scroll's first tick, before the app under it does. `at` with "down"
// answers that read, so a button that closes its window on release still reads as the button.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Probe {
    const int MaxAncestors = 6;
    const int WalkBudgetMs = 30; // ancestor walking stops past this so a slow app can't blow 50 ms
    const int FocusTtlMs = 2000;
    const int DialogTtlMs = 3000;
    const string Perm = "\"accessibility\":true,\"screen\":true,\"input\":true";

    static CacheRequest elemCache;
    static readonly TreeWalker walker = TreeWalker.ControlViewWalker;
    static readonly Stopwatch clock = Stopwatch.StartNew();

    public static int Run() {
        Io.Stage("DPI awareness: " + Io.EnableDpiAwareness()); // before UIA, so its rects are physical
        elemCache = new CacheRequest();
        elemCache.Add(AutomationElement.NameProperty);
        elemCache.Add(AutomationElement.ControlTypeProperty);
        elemCache.Add(AutomationElement.BoundingRectangleProperty);
        elemCache.Add(AutomationElement.IsPasswordProperty);
        elemCache.Add(AutomationElement.AutomationIdProperty);
        elemCache.Add(AutomationElement.ClassNameProperty);
        elemCache.Add(AutomationElement.HelpTextProperty);
        elemCache.Add(AutomationElement.LabeledByProperty);
        elemCache.Add(AutomationElement.NativeWindowHandleProperty);
        elemCache.Add(ValuePattern.ValueProperty);
        Io.Stage("UI Automation loaded");
        Hooks.Start();
        Io.StartTrim();
        Io.Stage("ready");
        return Io.Serve(Handle);
    }

    static string Handle(Dictionary<string, object> req) {
        string op = Json.Str(req, "op");
        try {
            switch (op) {
                case "at":
                    if (Json.True(req, "down")) {
                        string d = Down.Take(Json.Num(req, "x", double.NaN), Json.Num(req, "y", double.NaN));
                        if (d != null) return "\"element\":" + d;
                    }
                    return "\"element\":" + At(req);
                case "focused": return "\"element\":" + Focused();
                case "front": return Front();
                case "tree":
                    Tree.Start(Json.IdText(req), (int)Json.Num(req, "max", 1500), (int)Json.Num(req, "depth", 25),
                        (int)Json.Num(req, "budgetMs", 750));
                    return null; // answered by the worker
                case "watch":
                    if (Json.True(req, "clipboard")) Clip.Watch();
                    return "\"ok\":true";
                case "perm": return Perm;
                case "usage": return Io.Usage();
                case "power": return Power();
                default: return "\"error\":\"unknown op\"";
            }
        } catch (Exception e) {
            // Whatever half-built, answer null for the op's fields.
            Io.Stage(op + " failed: " + e.Message);
            if (op == "front") return "\"app\":null,\"window\":null";
            if (op == "perm") return Perm;
            if (op == "tree") return "\"nodes\":null";
            return "\"element\":null";
        }
    }

    // ---- elements ----

    static string At(Dictionary<string, object> req) {
        double x = Json.Num(req, "x", double.NaN), y = Json.Num(req, "y", double.NaN);
        if (double.IsNaN(x) || double.IsNaN(y)) return "null";
        return ReadAt(x, y);
    }

    public static string ReadAt(double x, double y) {
        AutomationElement el;
        using (elemCache.Activate()) el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        return ElementJson(el);
    }

    static readonly object focusLock = new object();
    static string focusJson;
    static long focusSeq = -1, focusAt;
    static IntPtr focusWnd;

    static string Focused() {
        long seq = Hooks.FocusSeq;
        IntPtr wnd = Win.FocusWindow();
        lock (focusLock) {
            if (focusJson != null && Hooks.Running && seq == focusSeq && wnd == focusWnd &&
                clock.ElapsedMilliseconds - focusAt < FocusTtlMs) return focusJson;
        }
        AutomationElement el;
        using (elemCache.Activate()) el = AutomationElement.FocusedElement;
        string json = ElementJson(el);
        lock (focusLock) {
            focusJson = json == "null" ? null : json;
            focusSeq = seq;
            focusWnd = wnd;
            focusAt = clock.ElapsedMilliseconds;
        }
        return json;
    }

    static string ElementJson(AutomationElement el) {
        if (el == null) return "null";
        Stopwatch t = Stopwatch.StartNew();
        AutomationElement.AutomationElementInformation c = el.Cached;
        System.Windows.Rect b = c.BoundingRectangle;
        string role = RoleOf(c.ControlType);
        StringBuilder sb = new StringBuilder(256);
        sb.Append("{\"role\":"); Json.Str(sb, role);
        sb.Append(",\"name\":"); Json.Str(sb, SafeName(el, role));
        sb.Append(",\"x\":").Append(Json.Round(b.X)).Append(",\"y\":").Append(Json.Round(b.Y));
        sb.Append(",\"width\":").Append(Json.Round(b.Width)).Append(",\"height\":").Append(Json.Round(b.Height));
        sb.Append(",\"secure\":").Append(Secure(c) ? "true" : "false");
        AppendPath(sb, el, t);
        string aid = c.AutomationId ?? "", cls = c.ClassName ?? "", help = c.HelpText ?? "";
        // No Mac-style url on Windows (UIA has no link target property).
        if (aid.Length > 0) { sb.Append(",\"id\":"); Json.Str(sb, aid); }
        if (cls.Length > 0) { sb.Append(",\"cls\":"); Json.Str(sb, cls); }
        if (help.Length > 0) { sb.Append(",\"help\":"); Json.Str(sb, help); }
        return sb.Append('}').ToString();
    }

    // Ancestors nearest first, stopping before the top-level window (that is `front.window`).
    static void AppendPath(StringBuilder sb, AutomationElement el, Stopwatch t) {
        int n = 0;
        int desktop = Win.Desktop().ToInt32();
        AutomationElement cur = el;
        while (n < MaxAncestors && t.ElapsedMilliseconds < WalkBudgetMs) {
            AutomationElement parent = walker.GetParent(cur, elemCache);
            if (parent == null) break;
            AutomationElement.AutomationElementInformation c = parent.Cached;
            if (c.ControlType == ControlType.Window || c.NativeWindowHandle == desktop) break;
            string role = RoleOf(c.ControlType);
            sb.Append(n == 0 ? ",\"path\":[" : ",");
            sb.Append("{\"role\":"); Json.Str(sb, role);
            sb.Append(",\"name\":"); Json.Str(sb, SafeName(parent, role));
            sb.Append('}');
            n++;
            cur = parent;
        }
        if (n > 0) sb.Append(']');
    }

    public static string RoleOf(ControlType ct) {
        string p = ct == null ? "" : ct.ProgrammaticName;
        if (p.StartsWith("ControlType.", StringComparison.Ordinal)) p = p.Substring(12);
        return p.ToLowerInvariant();
    }

    // UIA's Name is often the content itself: a Document or Edit named by its text, a combo box or
    // list item named by its value, a WinForms text box (seen as a Pane) named by what was typed. A
    // Document or a Win32 edit class takes its name only from its label (LabeledBy); any other
    // element loses a name that shows its ValuePattern value and falls back to its label. The
    // value comes in the same cached call and is read only to compare, never sent.
    public static string SafeName(AutomationElement el, string role) {
        string cls = el.Cached.ClassName ?? "";
        if (role == "document" || cls.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0) return LabelOf(el);
        string name = el.Cached.Name ?? "";
        if (name.Length == 0) return name;
        string value = ValueOf(el);
        if (!ShowsValue(name, value)) return name;
        string label = LabelOf(el);
        return ShowsValue(label, value) ? "" : label;
    }

    static bool ShowsValue(string name, string value) {
        string n = (name ?? "").Trim(), v = (value ?? "").Trim();
        if (n.Length == 0 || v.Length == 0) return false;
        return n == v || (v.Length >= 3 && n.Contains(v)) || (n.Length >= 12 && v.Contains(n));
    }

    static string ValueOf(AutomationElement el) {
        try { return el.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string ?? ""; }
        catch (Exception) { return ""; }
    }

    static string LabelOf(AutomationElement el) {
        try {
            AutomationElement lb = el.Cached.LabeledBy;
            return lb == null ? "" : (lb.Current.Name ?? "");
        } catch (Exception) { return ""; }
    }

    // IsPassword, or a Win32 edit class (WinForms, RichEdit) whose window masks its text: UIA's
    // Win32 proxy only knows the class "Edit", so a WinForms box comes through as a Pane with
    // IsPassword false. Ask the window (ES_PASSWORD, or EM_GETPASSWORDCHAR non-zero).
    public static bool Secure(AutomationElement.AutomationElementInformation c) {
        if (c.IsPassword) return true;
        if ((c.ClassName ?? "").IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) return false;
        return Win.PasswordEdit(new IntPtr(c.NativeWindowHandle));
    }

    // ---- front ----

    static readonly object dialogLock = new object();
    static IntPtr dialogWnd;
    static long dialogSeq = -1, dialogAt;
    static string dialogJson;

    static string Front() {
        IntPtr h = Win.Foreground();
        if (h == IntPtr.Zero) return "\"app\":null,\"window\":null";
        uint pid = Win.Pid(h);
        string path = Win.ImagePath(pid);
        string name = path.Length > 0 ? Path.GetFileNameWithoutExtension(path) : ProcessName(pid);
        StringBuilder sb = new StringBuilder(256);
        sb.Append("\"app\":{\"name\":"); Json.Str(sb, name);
        sb.Append(",\"id\":"); Json.Str(sb, path);
        sb.Append(",\"pid\":").Append(pid).Append('}');
        int[] r = Win.Bounds(h);
        if (r == null) sb.Append(",\"window\":null");
        else {
            sb.Append(",\"window\":{\"title\":"); Json.Str(sb, Win.Title(h));
            sb.Append(",\"x\":").Append(r[0]).Append(",\"y\":").Append(r[1]);
            sb.Append(",\"width\":").Append(r[2]).Append(",\"height\":").Append(r[3]).Append('}');
        }
        sb.Append(",\"dialog\":").Append(DialogCached(h));
        sb.Append(",\"windows\":").Append(Win.Windows(pid));
        return sb.ToString();
    }

    static string ProcessName(uint pid) {
        try { using (Process p = Process.GetProcessById((int)pid)) return p.ProcessName; }
        catch (Exception) { return ""; }
    }

    static string DialogCached(IntPtr h) {
        long seq = Hooks.FrontSeq;
        lock (dialogLock) {
            if (dialogJson != null && Hooks.Running && h == dialogWnd && seq == dialogSeq &&
                clock.ElapsedMilliseconds - dialogAt < DialogTtlMs) return dialogJson;
        }
        string json;
        try { json = Dialog(h); } catch (Exception) { json = "null"; }
        lock (dialogLock) {
            dialogJson = json;
            dialogWnd = h;
            dialogSeq = seq;
            dialogAt = clock.ElapsedMilliseconds;
        }
        return json;
    }

    static CacheRequest dialogCache;

    // The foreground window as a dialog `{title, text, buttons}`, or "null". A dialog is the
    // #32770 class or a modal UIA window; its words come from Text and Button children (60 at most).
    static string Dialog(IntPtr h) {
        if (dialogCache == null) {
            CacheRequest c = new CacheRequest();
            c.Add(AutomationElement.NameProperty);
            c.Add(AutomationElement.ControlTypeProperty);
            c.Add(WindowPattern.IsModalProperty);
            dialogCache = c;
        }
        AutomationElement win;
        using (dialogCache.Activate()) win = AutomationElement.FromHandle(h);
        bool modal = false;
        try { modal = win.GetCachedPropertyValue(WindowPattern.IsModalProperty, true) as bool? == true; } catch (Exception) { }
        if (Win.ClassName(h) != "#32770" && !modal) return "null";
        List<string> texts = new List<string>(), buttons = new List<string>();
        int seen = 0;
        DialogWalk(win, 0, texts, buttons, ref seen);
        string title = win.Cached.Name ?? "";
        if (title.Length == 0 && texts.Count > 0) { title = texts[0]; texts.RemoveAt(0); }
        texts.RemoveAll(delegate(string s) { return s == title; });
        StringBuilder sb = new StringBuilder(256);
        sb.Append("{\"title\":"); Json.Str(sb, title);
        sb.Append(",\"text\":"); Json.Str(sb, string.Join("\n", texts.ToArray()));
        sb.Append(",\"buttons\":[");
        for (int i = 0; i < buttons.Count; i++) { if (i > 0) sb.Append(','); Json.Str(sb, buttons[i]); }
        return sb.Append("]}").ToString();
    }

    static void DialogWalk(AutomationElement el, int depth, List<string> texts, List<string> buttons, ref int seen) {
        if (depth >= 4) return;
        AutomationElement k = walker.GetFirstChild(el, dialogCache);
        while (k != null && seen < 60) {
            seen++;
            ControlType ct = k.Cached.ControlType;
            string name = k.Cached.Name ?? "";
            if (ct == ControlType.Text) { if (name.Length > 0) texts.Add(name); }
            else if (ct == ControlType.Button) { if (name.Length > 0) buttons.Add(name); }
            else if (ct != ControlType.Edit && ct != ControlType.Document && ct != ControlType.ComboBox)
                DialogWalk(k, depth + 1, texts, buttons, ref seen);
            k = walker.GetNextSibling(k, dialogCache);
        }
    }

    static string Power() {
        int[] p = Win.Power();
        return "\"ac\":" + (p[0] < 0 ? "null" : p[0] == 1 ? "true" : "false") +
            ",\"battery\":" + (p[1] < 0 ? "null" : p[1].ToString());
    }
}

// Foreground and focus changes, counted, and button-downs handed to Down. Out of context and
// low-level: the callbacks run on this thread's message loop, nothing loads into other processes.
static class Hooks {
    public static long FocusSeq, FrontSeq;
    public static volatile bool Running;

    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);

    delegate IntPtr MouseProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int id, MouseProc proc, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string name);
    const int WhMouseLL = 14;
    const int WmLButtonDown = 0x0201, WmRButtonDown = 0x0204, WmMButtonDown = 0x0207, WmXButtonDown = 0x020B;
    const int WmMouseWheel = 0x020A, WmMouseHWheel = 0x020E;
    const int WmLButtonUp = 0x0202, WmRButtonUp = 0x0205, WmMButtonUp = 0x0208, WmXButtonUp = 0x020C;
    static MouseProc mouseProc; // kept alive for the hook

    const uint EventSystemForeground = 0x0003, EventObjectFocus = 0x8005;
    const uint OutOfContext = 0x0000, SkipOwnProcess = 0x0002;
    static WinEventProc proc; // kept alive for the hook

    public static void Start() {
        Thread t = new Thread(Loop);
        t.IsBackground = true;
        t.Name = "winevents";
        t.Start();
    }

    static void Loop() {
        proc = OnEvent;
        IntPtr a = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, proc, 0, 0, OutOfContext | SkipOwnProcess);
        IntPtr b = SetWinEventHook(EventObjectFocus, EventObjectFocus, IntPtr.Zero, proc, 0, 0, OutOfContext | SkipOwnProcess);
        if (a == IntPtr.Zero || b == IntPtr.Zero) {
            Io.Stage("WinEvent hooks failed: focus and dialogs are read every time");
            return;
        }
        Running = true;
        mouseProc = OnMouse;
        if (SetWindowsHookExW(WhMouseLL, mouseProc, GetModuleHandleW(null), 0) == IntPtr.Zero)
            Io.Stage("mouse hook failed (" + Marshal.GetLastWin32Error() + "): a click's element is read when asked");
        else Down.Start();
        MSG m;
        while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref m);
            DispatchMessageW(ref m);
        }
        Running = false;
    }

    static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            int msg = wParam.ToInt32();
            bool press = msg == WmLButtonDown || msg == WmRButtonDown || msg == WmMButtonDown || msg == WmXButtonDown;
            bool wheel = msg == WmMouseWheel || msg == WmMouseHWheel;
            bool up = msg == WmLButtonUp || msg == WmRButtonUp || msg == WmMButtonUp || msg == WmXButtonUp;
            if (up) Down.Release();
            else if (press || wheel) {
                try {
                    MSLLHOOKSTRUCT h = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    Down.Press(h.x, h.y, wheel);
                } catch (Exception) { }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
        if (ev == EventSystemForeground) Interlocked.Increment(ref FrontSeq);
        Interlocked.Increment(ref FocusSeq);
    }
}

// The element under each button-down, read before the app under it acts on the press. A
// WH_MOUSE_LL hook on the WinEvent thread sees the press first; it hands the point to a reader
// thread and holds the input until the read is done or HoldMs passed, so the app has not yet
// closed or changed what was pressed; a slow read also holds the button-up (UpHoldMs more), as a
// button acts on release. A scroll's first tick (none in the WheelGapMs before) is
// read the same way. One read is kept; `at` with "down" takes it when it is near the asked point
// and under KeepMs old, waiting for a read still running. The read holds what `at` would answer
// (names never show a value); nothing else sees it, and the next press replaces it.
static class Down {
    const int HoldMs = 60, UpHoldMs = 200, KeepMs = 2000, TakeWaitMs = 1500, Near = 4, WheelGapMs = 500;

    sealed class Read {
        public int X, Y;
        public long At;
        public string Json;
        public bool Taken;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
    }

    static readonly object gate = new object();
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static readonly AutoResetEvent wake = new AutoResetEvent(false);
    static Read last, pending;
    static long lastWheel = -WheelGapMs;
    static int wheelX, wheelY;
    public static volatile bool Running;

    // Called on the hook thread. Returns once the read is done or HoldMs passed.
    public static void Press(int x, int y, bool wheel) {
        long now = clock.ElapsedMilliseconds;
        if (wheel) {
            bool same = now - lastWheel < WheelGapMs && Math.Abs(x - wheelX) <= Near && Math.Abs(y - wheelY) <= Near;
            lastWheel = now; wheelX = x; wheelY = y;
            if (same) return;
        }
        Read r = new Read { X = x, Y = y, At = now };
        lock (gate) { last = r; pending = r; }
        wake.Set();
        r.Done.WaitOne(HoldMs);
    }

    // Called on the hook thread at a button-up: waits out a read of the press still running.
    public static void Release() {
        Read r;
        lock (gate) r = last;
        if (r == null || clock.ElapsedMilliseconds - r.At > KeepMs) return;
        r.Done.WaitOne(UpHoldMs);
    }

    public static void Start() {
        Thread t = new Thread(Reader);
        t.IsBackground = true;
        t.Name = "down";
        t.Start();
        Running = true;
    }

    static void Reader() {
        while (true) {
            wake.WaitOne();
            Read r;
            lock (gate) { r = pending; pending = null; }
            if (r == null) continue;
            string json;
            try { json = Probe.ReadAt(r.X, r.Y); } catch (Exception) { json = null; }
            r.Json = json;
            r.Done.Set();
        }
    }

    // The read of the press at (x, y), or null: none near there in KeepMs, already taken, or failed.
    public static string Take(double x, double y) {
        if (!Running || double.IsNaN(x) || double.IsNaN(y)) return null;
        Read r;
        lock (gate) r = last;
        if (r == null || r.Taken || clock.ElapsedMilliseconds - r.At > KeepMs) return null;
        if (Math.Abs(r.X - x) > Near || Math.Abs(r.Y - y) > Near) return null;
        if (!r.Done.WaitOne(TakeWaitMs)) return null;
        lock (gate) {
            if (r.Taken) return null;
            r.Taken = true;
        }
        return r.Json;
    }
}

// The front window's tree on a pool thread; a second tree while one runs answers empty and
// truncated.
static class Tree {
    static CacheRequest cache;
    static readonly HashSet<string> passThrough = new HashSet<string> { "pane", "group", "custom", "text", "image", "dataitem" };
    static readonly HashSet<string> leaves = new HashSet<string> { "edit", "combobox" };
    const int NameMax = 200;
    static int busy;

    static CacheRequest Cache() {
        if (cache != null) return cache;
        CacheRequest c = new CacheRequest();
        c.Add(AutomationElement.NameProperty);
        c.Add(AutomationElement.ControlTypeProperty);
        c.Add(AutomationElement.BoundingRectangleProperty);
        c.Add(AutomationElement.IsPasswordProperty);
        c.Add(AutomationElement.AutomationIdProperty);
        c.Add(AutomationElement.IsOffscreenProperty);
        c.Add(AutomationElement.LabeledByProperty);
        c.Add(AutomationElement.ClassNameProperty);
        c.Add(AutomationElement.NativeWindowHandleProperty);
        c.Add(ValuePattern.ValueProperty);
        cache = c;
        return c;
    }

    public static void Start(string id, int max, int depth, int budgetMs) {
        if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) {
            Io.Emit("{\"id\":" + id + ",\"nodes\":[],\"truncated\":true,\"ms\":0}");
            return;
        }
        ThreadPool.QueueUserWorkItem(delegate(object o) {
            try { Io.Emit(Walk(id, max, depth, budgetMs)); }
            catch (Exception) { Io.Emit("{\"id\":" + id + ",\"nodes\":null}"); }
            finally { Interlocked.Exchange(ref busy, 0); }
        });
    }

    class State {
        public StringBuilder sb = new StringBuilder(32768);
        public int count, max, maxDepth, budgetMs;
        public bool truncated;
        public Stopwatch clock;
        public CacheRequest cache;
    }

    // The foreground window, depth first with the ControlView walker: on-screen nodes inside the
    // window only, unnamed id-less containers and labels skipped (their children take their
    // depth), edits and combo boxes as leaves, `max` nodes, `depth` emitted levels, `budgetMs`.
    static string Walk(string id, int max, int depth, int budgetMs) {
        State w = new State();
        w.max = max; w.maxDepth = depth; w.budgetMs = budgetMs;
        w.clock = Stopwatch.StartNew();
        w.cache = Cache();
        w.sb.Append("{\"id\":").Append(id).Append(",\"nodes\":[");
        IntPtr h = Win.Foreground();
        if (h != IntPtr.Zero) {
            AutomationElement root;
            using (w.cache.Activate()) root = AutomationElement.FromHandle(h);
            Visit(w, root, 0, 0, root.Cached.BoundingRectangle);
        }
        w.sb.Append("],\"truncated\":").Append(w.truncated ? "true" : "false");
        w.sb.Append(",\"ms\":").Append(w.clock.ElapsedMilliseconds).Append('}');
        return w.sb.ToString();
    }

    static void Visit(State w, AutomationElement el, int depth, int raw, System.Windows.Rect clip) {
        if (w.truncated) return;
        if (w.count >= w.max || w.clock.ElapsedMilliseconds > w.budgetMs || raw > 60) { w.truncated = true; return; }
        AutomationElement.AutomationElementInformation c = el.Cached;
        if (c.IsOffscreen) return;
        System.Windows.Rect r = c.BoundingRectangle;
        bool sized = !r.IsEmpty && r.Width > 0 && r.Height > 0;
        if (sized && !r.IntersectsWith(clip)) return;
        string role = Probe.RoleOf(c.ControlType);
        string name = Probe.SafeName(el, role);
        if (name.Length > NameMax) name = name.Substring(0, NameMax);
        string aid = c.AutomationId ?? "";
        bool skip = !sized || (name.Length == 0 && aid.Length == 0 && passThrough.Contains(role));
        int next = depth;
        if (!skip) {
            if (depth >= w.maxDepth) { w.truncated = true; return; }
            System.Windows.Rect v = System.Windows.Rect.Intersect(r, clip);
            if (w.count > 0) w.sb.Append(',');
            w.sb.Append("{\"role\":"); Json.Str(w.sb, role);
            w.sb.Append(",\"name\":"); Json.Str(w.sb, name);
            if (aid.Length > 0) { w.sb.Append(",\"id\":"); Json.Str(w.sb, aid); }
            w.sb.Append(",\"x\":").Append(Json.Round(v.X)).Append(",\"y\":").Append(Json.Round(v.Y));
            w.sb.Append(",\"width\":").Append(Json.Round(v.Width)).Append(",\"height\":").Append(Json.Round(v.Height));
            w.sb.Append(",\"depth\":").Append(depth);
            if (Probe.Secure(c)) w.sb.Append(",\"secure\":true");
            w.sb.Append('}');
            w.count++;
            next = depth + 1;
        }
        if (leaves.Contains(role)) return;
        System.Windows.Rect inner = clip;
        if (sized && (role == "pane" || role == "document" || role == "list" || role == "tree")) inner = System.Windows.Rect.Intersect(clip, r);
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement k = walker.GetFirstChild(el, w.cache);
        while (k != null && !w.truncated) {
            Visit(w, k, next, raw + 1, inner);
            k = walker.GetNextSibling(k, w.cache);
        }
    }
}

// The clipboard, polled at 4 Hz on its sequence number from an STA thread once watched; each
// change pushes `{"event":"clipboard",…}`. Text marked for exclusion is never read out.
static class Clip {
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatNameW(uint format, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);

    static readonly object startLock = new object();
    static Thread thread;
    static readonly Dictionary<uint, string> stdFormats = new Dictionary<uint, string> {
        { 1, "text" }, { 2, "bitmap" }, { 8, "dib" }, { 13, "unicodetext" }, { 15, "files" }, { 17, "dibv5" } };
    static readonly HashSet<string> concealedFormats = new HashSet<string> {
        "ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore" };
    const int TextMax = 4096;

    public static void Watch() {
        lock (startLock) {
            if (thread != null) return;
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }
    }

    // A change read while another app holds the clipboard is retried on the next tick.
    static void Loop() {
        uint last = GetClipboardSequenceNumber();
        while (true) {
            Thread.Sleep(250);
            uint n = GetClipboardSequenceNumber();
            if (n == last) continue;
            string ev;
            try { ev = Event(); } catch (Exception) { ev = null; }
            if (ev == null) continue;
            last = n;
            Io.Emit(ev);
        }
    }

    static string Event() {
        if (!OpenClipboard(IntPtr.Zero)) return null;
        List<string> types = new List<string>();
        bool concealed = false, hasText = false;
        string text = null;
        try {
            uint f = 0;
            while ((f = EnumClipboardFormats(f)) != 0) {
                string name;
                if (!stdFormats.TryGetValue(f, out name)) {
                    StringBuilder sb = new StringBuilder(128);
                    name = GetClipboardFormatNameW(f, sb, sb.Capacity) > 0 ? sb.ToString() : ("#" + f);
                }
                if (concealedFormats.Contains(name)) concealed = true;
                if (f == 13) hasText = true;
                if (types.Count < 20) types.Add(name);
            }
            if (hasText) {
                IntPtr h = GetClipboardData(13);
                IntPtr p = h == IntPtr.Zero ? IntPtr.Zero : GlobalLock(h);
                if (p != IntPtr.Zero) {
                    try {
                        int max = (int)Math.Min(GlobalSize(h).ToUInt64() / 2, (ulong)int.MaxValue);
                        text = Marshal.PtrToStringUni(p, max);
                        int nul = text.IndexOf('\0');
                        if (nul >= 0) text = text.Substring(0, nul);
                    } finally { GlobalUnlock(h); }
                }
            }
        } finally { CloseClipboard(); }
        StringBuilder o = new StringBuilder(256);
        o.Append("{\"event\":\"clipboard\",\"types\":[");
        for (int i = 0; i < types.Count; i++) { if (i > 0) o.Append(','); Json.Str(o, types[i]); }
        o.Append("],\"length\":").Append(text == null ? 0 : text.Length);
        o.Append(",\"concealed\":").Append(concealed ? "true" : "false");
        if (text != null && !concealed) {
            o.Append(",\"text\":");
            Json.Str(o, text.Length > TextMax ? text.Substring(0, TextMax) : text);
        }
        return o.Append('}').ToString();
    }
}

// Win32 calls the probe makes.
static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_POWER_STATUS { public byte AC, BatteryFlag, BatteryPercent, Saver; public int LifeTime, FullLifeTime; }

    delegate bool EnumWindowsProc(IntPtr h, IntPtr data);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc fn, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

    public static IntPtr Foreground() { return GetForegroundWindow(); }
    public static IntPtr Desktop() { return GetDesktopWindow(); }

    // The window with keyboard focus in the foreground thread (no cross-process call).
    public static IntPtr FocusWindow() {
        GUITHREADINFO g = new GUITHREADINFO();
        g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        return GetGUIThreadInfo(0, ref g) ? g.hwndFocus : IntPtr.Zero;
    }

    public static string Title(IntPtr h) {
        int n = GetWindowTextLengthW(h);
        StringBuilder sb = new StringBuilder(n + 1);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassName(IntPtr h) {
        StringBuilder sb = new StringBuilder(64);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Visible bounds [x, y, width, height]. DWM's extended frame skips the invisible resize border
    // that GetWindowRect includes on Windows 10 and 11. Null when the window has no rect.
    public static int[] Bounds(IntPtr h) {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) return null;
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static uint Pid(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    // Full exe path, or "" when the process is protected or gone.
    public static string ImagePath(uint pid) {
        IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (p == IntPtr.Zero) return "";
        try {
            StringBuilder sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            return QueryFullProcessImageNameW(p, 0, sb, ref size) ? sb.ToString() : "";
        } finally { CloseHandle(p); }
    }

    // Visible top-level windows of the process, tool windows left out.
    public static int Windows(uint pid) {
        int n = 0;
        EnumWindowsProc fn = delegate(IntPtr h, IntPtr d) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h) && (GetWindowLongW(h, -20) & 0x80) == 0) n++;
            return true;
        };
        EnumWindows(fn, IntPtr.Zero);
        GC.KeepAlive(fn);
        return n;
    }

    // A Win32 edit that masks its text (ES_PASSWORD, or EM_GETPASSWORDCHAR non-zero).
    public static bool PasswordEdit(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if ((GetWindowLongW(h, -16) & 0x20) != 0) return true;
        IntPtr r;
        return SendMessageTimeoutW(h, 0xD2, IntPtr.Zero, IntPtr.Zero, 0x2, 50, out r) != IntPtr.Zero && r != IntPtr.Zero;
    }

    // [ac, battery]: ac 1/0, -1 unknown; battery 0..100, -1 none or unknown.
    public static int[] Power() {
        SYSTEM_POWER_STATUS s;
        if (!GetSystemPowerStatus(out s)) return new int[] { -1, -1 };
        int ac = s.AC == 1 ? 1 : s.AC == 0 ? 0 : -1;
        int pct = (s.BatteryFlag & 128) != 0 || s.BatteryPercent > 100 ? -1 : s.BatteryPercent;
        return new int[] { ac, pct };
    }
}
