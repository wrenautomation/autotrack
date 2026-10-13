# autotrack probe (Windows): long-lived helper. One JSON request per line on stdin, one answer per
# line on stdout. Ops: at, front, focused, perm. See designs/2026-10-13-track.md "Probe protocol".
# Windows PowerShell 5.1 syntax only. Run: powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1
#
# COORDINATE SPACE: physical screen pixels on the virtual desktop (primary monitor's top-left is 0,0;
# other monitors can be negative). Requests and answers use it. This matches uiohook-napi on Windows:
# libuiohook passes MSLLHOOKSTRUCT.pt straight through, and Microsoft documents that field as
# "per-monitor-aware screen coordinates", i.e. physical pixels whatever the hooking process's DPI
# awareness. This process makes itself per-monitor DPI aware (v2) first, so UIA and window rects are
# physical too. No scaling happens here; the recorder converts to logical points with displays[].scale.
#
# Elements carry path (ancestors up to the window), id (AutomationId), cls (ClassName), help; each
# omitted when empty. Chromium turns its UIA tree on by itself when a UIA client asks (see README).
# Never returns an element's value, nor a name that shows it (UIA often names a text box by its
# text). Per-request errors answer null; the loop never dies.
# UIA has no per-call timeout, so a hung app can stall one request; the caller times out to null.
#
# `--shots` starts the other long-lived helper instead: frames. Ops: displays, grab, save. See designs/
# 2026-10-13-autotrack.md "Shots protocol". A BitBlt from the screen DC (CAPTUREBLT) with a HALFTONE
# stretch to at most 1920 px on the long side lands in one of 4 DIB sections; save writes a JPEG
# (System.Drawing, path.tmp then rename). Displays are logical points (physical / DPI scale), `os` is
# the physical rect and DPI scale. Everything, JSON included, runs in C# after one compile.

$ErrorActionPreference = 'Stop'

if ($args -contains '--shots') {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Shots mode: grab a display into a ring of 4 DIB sections, hash it, write a JPEG on request.
// C# 5 only (Windows PowerShell 5.1 compiles it).
public static class AutotrackShots {
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }

    delegate bool MonitorEnumProc(IntPtr mon, IntPtr dc, ref RECT r, IntPtr data);

    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFOEX mi);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dpiX, out uint dpiY);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr old);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, uint rop);

    const int MaxSide = 1920;
    const int RingSize = 4;
    const uint SrcCopy = 0x00CC0020;
    const uint CaptureBlt = 0x40000000;

    sealed class Display {
        public IntPtr Handle;
        public int X, Y, W, H;       // physical pixels on the virtual desktop
        public double Dpi;           // DPI scale: 1.0 = 96 dpi
        public bool Primary;
    }

    sealed class Slot {
        public IntPtr Dc, Dib, Old, Bits;
        public int W, H;
        public int Seq;
    }

    static readonly Slot[] ring = NewRing();
    static int grabSeq = 0;

    static Slot[] NewRing() {
        Slot[] r = new Slot[RingSize];
        for (int i = 0; i < RingSize; i++) r[i] = new Slot();
        return r;
    }

    // Newest API first; each older one exists on older Windows.
    static void EnableDpiAwareness() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    static List<Display> Displays() {
        List<Display> list = new List<Display>();
        MonitorEnumProc cb = delegate(IntPtr mon, IntPtr dc, ref RECT r, IntPtr data) {
            Display d = new Display();
            d.Handle = mon;
            d.X = r.Left; d.Y = r.Top; d.W = r.Right - r.Left; d.H = r.Bottom - r.Top;
            d.Dpi = 1.0;
            try {
                uint dx, dy;
                if (GetDpiForMonitor(mon, 0, out dx, out dy) == 0 && dx > 0) d.Dpi = dx / 96.0;
            } catch (Exception) { }
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            d.Primary = GetMonitorInfoW(mon, ref mi) && (mi.dwFlags & 1) != 0;
            list.Add(d);
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return list;
    }

    static void FitSize(int w, int h, out int fw, out int fh) {
        double k = Math.Min(1.0, (double)MaxSide / Math.Max(w, h));
        fw = Math.Max(1, (int)Math.Round(w * k, MidpointRounding.AwayFromZero));
        fh = Math.Max(1, (int)Math.Round(h * k, MidpointRounding.AwayFromZero));
    }

    static string Num(double v, int digits) {
        return Math.Round(v, digits, MidpointRounding.AwayFromZero).ToString("0.###############", CultureInfo.InvariantCulture);
    }

    static string DisplayJson(Display d) {
        int fw, fh;
        FitSize(d.W, d.H, out fw, out fh);
        double lw = d.W / d.Dpi;
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"id\":\"").Append(((long)d.Handle).ToString(CultureInfo.InvariantCulture)).Append("\"");
        sb.Append(",\"x\":").Append(Num(d.X / d.Dpi, 2));
        sb.Append(",\"y\":").Append(Num(d.Y / d.Dpi, 2));
        sb.Append(",\"width\":").Append(Num(lw, 2));
        sb.Append(",\"height\":").Append(Num(d.H / d.Dpi, 2));
        sb.Append(",\"scale\":").Append(Num(fw / lw, 3));
        sb.Append(",\"primary\":").Append(d.Primary ? "true" : "false");
        sb.Append(",\"os\":{\"x\":").Append(d.X).Append(",\"y\":").Append(d.Y);
        sb.Append(",\"width\":").Append(d.W).Append(",\"height\":").Append(d.H);
        sb.Append(",\"scale\":").Append(Num(d.Dpi, 3)).Append("}}");
        return sb.ToString();
    }

    static void Resize(Slot s, int w, int h) {
        if (s.Dc != IntPtr.Zero && s.W == w && s.H == h) return;
        Free(s);
        BITMAPINFOHEADER bmi = new BITMAPINFOHEADER();
        bmi.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bmi.biWidth = w; bmi.biHeight = -h; // top-down
        bmi.biPlanes = 1; bmi.biBitCount = 32;
        IntPtr screen = GetDC(IntPtr.Zero);
        try {
            s.Dc = CreateCompatibleDC(screen);
            s.Dib = CreateDIBSection(screen, ref bmi, 0, out s.Bits, IntPtr.Zero, 0);
        } finally { ReleaseDC(IntPtr.Zero, screen); }
        if (s.Dc == IntPtr.Zero || s.Dib == IntPtr.Zero || s.Bits == IntPtr.Zero) { Free(s); throw new Exception("no memory for a frame"); }
        s.Old = SelectObject(s.Dc, s.Dib);
        s.W = w; s.H = h;
    }

    static void Free(Slot s) {
        if (s.Dc != IntPtr.Zero) {
            if (s.Old != IntPtr.Zero) SelectObject(s.Dc, s.Old);
            DeleteDC(s.Dc);
        }
        if (s.Dib != IntPtr.Zero) DeleteObject(s.Dib);
        s.Dc = s.Dib = s.Old = s.Bits = IntPtr.Zero;
        s.W = s.H = s.Seq = 0;
    }

    // 64-bit hash of a BGRA frame: top byte = mean luma of the top half, next = bottom half, low 48 bits =
    // difference hash (is each cell darker than its right neighbour) over a 9x6 grid of cell means. Same as the Mac helper.
    static ulong FrameHash(Slot s) {
        int cols = 9, rows = 6, sub = 6, w = s.W, h = s.H, stride = w * 4;
        int[] cell = new int[cols * rows];
        for (int gy = 0; gy < rows; gy++) {
            for (int gx = 0; gx < cols; gx++) {
                int sum = 0;
                for (int sy = 0; sy < sub; sy++) {
                    int y = ((gy * sub + sy) * 2 + 1) * h / (2 * rows * sub);
                    for (int sx = 0; sx < sub; sx++) {
                        int x = ((gx * sub + sx) * 2 + 1) * w / (2 * cols * sub);
                        int p = Marshal.ReadInt32(s.Bits, y * stride + x * 4);
                        sum += (((p >> 16) & 0xff) * 77 + ((p >> 8) & 0xff) * 150 + (p & 0xff) * 29) >> 8;
                    }
                }
                cell[gy * cols + gx] = sum / (sub * sub);
            }
        }
        ulong bits = 0;
        for (int gy = 0; gy < rows; gy++)
            for (int gx = 0; gx < cols - 1; gx++)
                if (cell[gy * cols + gx] < cell[gy * cols + gx + 1]) bits |= 1UL << (gy * (cols - 1) + gx);
        int half = cols * rows / 2, top = 0, bottom = 0;
        for (int i = 0; i < half; i++) top += cell[i];
        for (int i = half; i < cols * rows; i++) bottom += cell[i];
        return bits | ((ulong)(bottom / half) << 48) | ((ulong)(top / half) << 56);
    }

    static string OpGrab(Dictionary<string, object> req) {
        string id = Str(req, "display");
        Display d = null;
        foreach (Display e in Displays()) if (((long)e.Handle).ToString(CultureInfo.InvariantCulture) == id) d = e;
        if (d == null) return "\"error\":\"no such display\"";
        int w, h;
        FitSize(d.W, d.H, out w, out h);
        grabSeq++;
        Slot s = ring[grabSeq % RingSize];
        s.Seq = 0; // not savable until the new picture is in
        Resize(s, w, h);
        IntPtr screen = GetDC(IntPtr.Zero);
        bool ok;
        try {
            SetStretchBltMode(s.Dc, 4); // HALFTONE
            SetBrushOrgEx(s.Dc, 0, 0, IntPtr.Zero);
            ok = StretchBlt(s.Dc, 0, 0, w, h, screen, d.X, d.Y, d.W, d.H, SrcCopy | CaptureBlt);
        } finally { ReleaseDC(IntPtr.Zero, screen); }
        if (!ok) return "\"error\":\"capture failed\"";
        s.Seq = grabSeq;
        return "\"slot\":" + (grabSeq % RingSize) + ",\"seq\":" + grabSeq + ",\"w\":" + w + ",\"h\":" + h +
            ",\"hash\":\"" + FrameHash(s).ToString("x16", CultureInfo.InvariantCulture) + "\"";
    }

    static string Fail(string why) { return "\"ok\":false,\"error\":" + Quote(why); }

    static string OpSave(Dictionary<string, object> req) {
        object slotObj, pathObj;
        req.TryGetValue("slot", out slotObj);
        req.TryGetValue("path", out pathObj);
        string path = pathObj as string;
        if (!(slotObj is double) || string.IsNullOrEmpty(path)) return Fail("bad request");
        int n = (int)(double)slotObj;
        if (n < 0 || n >= RingSize) return Fail("bad request");
        Slot s = ring[n];
        if (s.Dc == IntPtr.Zero || s.Seq <= 0) return Fail("empty slot");
        object seqObj;
        if (req.TryGetValue("seq", out seqObj) && seqObj is double && (int)(double)seqObj != s.Seq) return Fail("slot reused");
        long q = 70;
        object qObj;
        if (req.TryGetValue("quality", out qObj) && qObj is double) q = Math.Min(100, Math.Max(1, (long)(double)qObj));
        string tmp = path + ".tmp";
        try {
            ImageCodecInfo jpeg = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
            if (jpeg == null) return Fail("no JPEG encoder");
            using (Bitmap bmp = new Bitmap(s.W, s.H, s.W * 4, PixelFormat.Format32bppRgb, s.Bits))
            using (EncoderParameters ep = new EncoderParameters(1)) {
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
                bmp.Save(tmp, jpeg, ep);
            }
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
            return "\"ok\":true,\"bytes\":" + new FileInfo(path).Length;
        } catch (Exception e) {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (Exception) { }
            return Fail(e.Message);
        }
    }

    static string Handle(Dictionary<string, object> req) {
        string body;
        string op = Str(req, "op");
        try {
            if (op == "displays") {
                List<string> parts = new List<string>();
                foreach (Display d in Displays()) parts.Add(DisplayJson(d));
                body = "\"displays\":[" + string.Join(",", parts.ToArray()) + "]";
            } else if (op == "grab") body = OpGrab(req);
            else if (op == "save") body = OpSave(req);
            else body = "\"error\":\"unknown op\"";
        } catch (Exception e) {
            body = (op == "save" ? "\"ok\":false," : "") + "\"error\":" + Quote(e.Message);
        }
        object id;
        string idText = "null";
        if (req.TryGetValue("id", out id) && id is double) idText = ((double)id).ToString("0.###############", CultureInfo.InvariantCulture);
        return "{\"id\":" + idText + "," + body + "}";
    }

    static string Str(Dictionary<string, object> req, string key) {
        object v;
        if (!req.TryGetValue(key, out v) || v == null) return "";
        if (v is double) return ((double)v).ToString("0.###############", CultureInfo.InvariantCulture);
        return v as string ?? "";
    }

    // JSON string literal, ASCII only: the line is the same bytes whatever the console code page.
    public static string Quote(string s) {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // A flat JSON object: string, number, true, false, null values. Null when the line is not one.
    public static Dictionary<string, object> Parse(string line) {
        int i = 0;
        Dictionary<string, object> map = new Dictionary<string, object>();
        Ws(line, ref i);
        if (i >= line.Length || line[i] != '{') return null;
        i++;
        Ws(line, ref i);
        if (i < line.Length && line[i] == '}') return map;
        while (i < line.Length) {
            Ws(line, ref i);
            string key = ReadString(line, ref i);
            if (key == null) return null;
            Ws(line, ref i);
            if (i >= line.Length || line[i] != ':') return null;
            i++;
            Ws(line, ref i);
            if (i >= line.Length) return null;
            object val;
            char c = line[i];
            if (c == '"') { string sv = ReadString(line, ref i); if (sv == null) return null; val = sv; }
            else if (c == 't' && string.CompareOrdinal(line, i, "true", 0, 4) == 0) { val = true; i += 4; }
            else if (c == 'f' && string.CompareOrdinal(line, i, "false", 0, 5) == 0) { val = false; i += 5; }
            else if (c == 'n' && string.CompareOrdinal(line, i, "null", 0, 4) == 0) { val = null; i += 4; }
            else {
                int start = i;
                while (i < line.Length && "+-0123456789.eE".IndexOf(line[i]) >= 0) i++;
                double dv;
                if (i == start || !double.TryParse(line.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out dv)) return null;
                val = dv;
            }
            map[key] = val;
            Ws(line, ref i);
            if (i >= line.Length) return null;
            if (line[i] == ',') { i++; continue; }
            if (line[i] == '}') return map;
            return null;
        }
        return null;
    }

    static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

    static string ReadString(string s, ref int i) {
        if (i >= s.Length || s[i] != '"') return null;
        i++;
        StringBuilder sb = new StringBuilder();
        while (i < s.Length) {
            char c = s[i++];
            if (c == '"') return sb.ToString();
            if (c != '\\') { sb.Append(c); continue; }
            if (i >= s.Length) return null;
            char e = s[i++];
            if (e == 'n') sb.Append('\n');
            else if (e == 't') sb.Append('\t');
            else if (e == 'r') sb.Append('\r');
            else if (e == 'b') sb.Append('\b');
            else if (e == 'f') sb.Append('\f');
            else if (e == 'u') {
                int code;
                if (i + 4 > s.Length || !int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) return null;
                sb.Append((char)code);
                i += 4;
            } else sb.Append(e); // " \ /
        }
        return null;
    }

    public static int Run() {
        EnableDpiAwareness();
        StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        Stream output = Console.OpenStandardOutput();
        string line;
        while ((line = input.ReadLine()) != null) {
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> req = Parse(line);
            if (req == null) continue; // no id to answer to
            byte[] bytes = Encoding.ASCII.GetBytes(Handle(req) + "\n");
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }
        return 0;
    }
}
'@
    exit [AutotrackShots]::Run()
}

# Startup stages go to stderr (the recorder ignores it; a test run shows it), so a helper that
# never answers says where it stopped.
$startClock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Stage([string]$m) { [Console]::Error.WriteLine(('probe {0} ms: {1}' -f $startClock.ElapsedMilliseconds, $m)) }
Write-Stage 'compiling native helpers'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AutotrackNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint size);

    // Newest API first; each older one exists on older Windows. Returns which one took.
    public static string EnableDpiAwareness() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch (Exception) { }
        try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch (Exception) { }
        try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
        return "none";
    }

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static string Title(IntPtr h) {
        int n = GetWindowTextLengthW(h);
        StringBuilder sb = new StringBuilder(n + 1);
        GetWindowTextW(h, sb, sb.Capacity);
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
}
'@

# Before UIA loads, so its coordinates come back physical.
Write-Stage ('DPI awareness: ' + [AutotrackNative]::EnableDpiAwareness())
Add-Type -AssemblyName WindowsBase, UIAutomationClient, UIAutomationTypes
Write-Stage 'UI Automation loaded'

function ConvertTo-Rounded([double]$v) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0 }
    return [int][math]::Round($v)
}

# One cross-process call per element: every property we read is fetched into the cache together.
$script:cache = New-Object System.Windows.Automation.CacheRequest
foreach ($prop in @(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
        [System.Windows.Automation.AutomationElement]::IsPasswordProperty,
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        [System.Windows.Automation.AutomationElement]::HelpTextProperty,
        [System.Windows.Automation.AutomationElement]::LabeledByProperty,
        [System.Windows.Automation.ValuePattern]::ValueProperty)) { $script:cache.Add($prop) }
$script:walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:windowTypeId = [System.Windows.Automation.ControlType]::Window.Id
$maxAncestors = 6
$walkBudgetMs = 30   # ancestor walking stops past this so a slow app can't blow the 50 ms answer

function Get-RoleName($controlType) {
    return ($controlType.ProgrammaticName -replace '^ControlType\.', '').ToLowerInvariant()
}

# UIA's Name is often the content itself: a Document or Edit named by its text, a combo box or
# list item named by its value, a WinForms text box (seen as a Pane) named by what was typed. A
# Document or a Win32 edit class takes its name only from its label (LabeledBy); any other element
# loses a name that shows its ValuePattern value and falls back to its label. The value comes in
# the same cached call and is read only to compare, never sent.
$script:valueProp = [System.Windows.Automation.ValuePattern]::ValueProperty

function Test-ShowsValue([string]$name, [string]$value) {
    $n = $name.Trim(); $v = $value.Trim()
    if ($n.Length -eq 0 -or $v.Length -eq 0) { return $false }
    return ($n -eq $v) -or ($v.Length -ge 3 -and $n.Contains($v)) -or ($n.Length -ge 12 -and $v.Contains($n))
}

function Get-ValueText($el) {
    try {
        $v = $el.GetCachedPropertyValue($script:valueProp, $true)
        if ($v -is [string]) { return $v }
    } catch { }
    return ''
}

function Get-LabelName($c) {
    try { $lb = $c.LabeledBy; if ($null -ne $lb) { return [string]$lb.Current.Name } } catch { }
    return ''
}

# $c: the element's Cached properties.
function Get-SafeName($el, $c, [string]$role) {
    if ($role -eq 'document' -or [string]$c.ClassName -match '(?i)edit') { return (Get-LabelName $c) }
    $name = [string]$c.Name
    if ($name.Length -eq 0) { return $name }
    $value = Get-ValueText $el
    if (-not (Test-ShowsValue $name $value)) { return $name }
    $label = Get-LabelName $c
    if (Test-ShowsValue $label $value) { return '' }
    return $label
}

# Ancestors nearest first, stopping before the top-level window (that is `front.window`).
function Get-Path($el, $clock) {
    $path = New-Object System.Collections.ArrayList
    $cur = $el
    while ($path.Count -lt $maxAncestors -and $clock.ElapsedMilliseconds -lt $walkBudgetMs) {
        $parent = $script:walker.GetParent($cur, $script:cache)
        if ($null -eq $parent) { break }
        $c = $parent.Cached
        if ($c.ControlType.Id -eq $script:windowTypeId) { break }
        if ([System.Windows.Automation.Automation]::Compare($parent, [System.Windows.Automation.AutomationElement]::RootElement)) { break }
        $role = Get-RoleName $c.ControlType
        [void]$path.Add([ordered]@{ role = $role; name = (Get-SafeName $parent $c $role) })
        $cur = $parent
    }
    return , $path.ToArray()
}

function Get-ElementJson($raw) {
    if ($null -eq $raw) { return $null }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $el = $raw.GetUpdatedCache($script:cache)
    $c = $el.Cached
    $b = $c.BoundingRectangle
    $role = Get-RoleName $c.ControlType
    $out = [ordered]@{
        role   = $role
        name   = (Get-SafeName $el $c $role)
        x      = ConvertTo-Rounded $b.X
        y      = ConvertTo-Rounded $b.Y
        width  = ConvertTo-Rounded $b.Width
        height = ConvertTo-Rounded $b.Height
        secure = [bool]$c.IsPassword
    }
    $path = Get-Path $el $clock
    if ($path.Count -gt 0) { $out['path'] = $path }
    # Each omitted when empty. No Mac-style url on Windows (UIA has no link target property).
    if ($c.AutomationId) { $out['id'] = [string]$c.AutomationId }
    if ($c.ClassName) { $out['cls'] = [string]$c.ClassName }
    if ($c.HelpText) { $out['help'] = [string]$c.HelpText }
    return $out
}

function Get-FrontJson {
    $h = [AutotrackNative]::Foreground()
    if ($h -eq [IntPtr]::Zero) { return @{ app = $null; window = $null } }
    $procId = [AutotrackNative]::Pid($h)
    $path = [AutotrackNative]::ImagePath($procId)
    if ($path) {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($path)
    } else {
        $name = [System.Diagnostics.Process]::GetProcessById([int]$procId).ProcessName
    }
    $app = [ordered]@{ name = [string]$name; id = [string]$path; pid = [int]$procId }
    $window = $null
    $b = [AutotrackNative]::Bounds($h)
    if ($null -ne $b) {
        $window = [ordered]@{ title = [AutotrackNative]::Title($h); x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
    }
    return @{ app = $app; window = $window }
}

function Invoke-Op($req) {
    $res = [ordered]@{ id = $req.id }
    $op = [string]$req.op
    try {
        switch ($op) {
            'at' {
                $res['element'] = $null
                if ($null -ne $req.x -and $null -ne $req.y) {
                    $pt = New-Object System.Windows.Point -ArgumentList ([double]$req.x), ([double]$req.y)
                    $res['element'] = Get-ElementJson ([System.Windows.Automation.AutomationElement]::FromPoint($pt))
                }
            }
            'focused' {
                $res['element'] = Get-ElementJson ([System.Windows.Automation.AutomationElement]::FocusedElement)
            }
            'front' {
                $f = Get-FrontJson
                $res['app'] = $f.app
                $res['window'] = $f.window
            }
            'perm' {
                $res['accessibility'] = $true; $res['screen'] = $true; $res['input'] = $true
            }
            default { $res['error'] = 'unknown op' }
        }
    } catch {
        # Whatever half-built, answer null for the op's fields.
        switch ($op) {
            'front' { $res['app'] = $null; $res['window'] = $null }
            'perm'  { $res['accessibility'] = $true; $res['screen'] = $true; $res['input'] = $true }
            default { $res['element'] = $null }
        }
    }
    return $res
}

# Escape everything above ASCII so the line is the same bytes under any console code page.
$escape = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\u{0:x4}' -f [int][char]$m.Value }

# UTF-8 in, BOM dropped: a .NET parent whose console is UTF-8 writes one before its first line,
# which ConvertFrom-Json refuses (the shots helper's StreamReader skips it by itself).
$stdin = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding -ArgumentList $false)
$stdout = New-Object System.IO.StreamWriter -ArgumentList ([Console]::OpenStandardOutput()), (New-Object System.Text.ASCIIEncoding)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"
Write-Stage 'ready'
while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.TrimStart([char]0xFEFF)
    if ($line.Trim().Length -eq 0) { continue }
    try {
        $req = $line | ConvertFrom-Json
    } catch {
        # No id to answer to, so say nothing on stdout.
        Write-Stage ('unparseable line: ' + $line.Substring(0, [math]::Min(80, $line.Length)))
        continue
    }
    try {
        $json = (Invoke-Op $req) | ConvertTo-Json -Compress -Depth 4
        $json = [System.Text.RegularExpressions.Regex]::Replace($json, '[^\x00-\x7F]', $escape)
        $stdout.WriteLine($json)
    } catch {
        Write-Stage ('answer failed: ' + $_.Exception.Message)
    }
}
