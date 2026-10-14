# autotrack probe (Windows): long-lived helper. One JSON request per line on stdin, one answer per
# line on stdout. Ops: at, front, focused, perm, tree, watch, usage, power. See designs/2026-10-13-autotrack.md
# "Probe protocol". `tree` is answered from a pool thread and `watch` starts an STA thread that
# pushes `{"event":"clipboard",…}` lines; AutotrackBg's one locked writer keeps every line whole.
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
# `--shots` starts the other long-lived helper instead: frames. Ops: displays, grab, save, crop, usage. See designs/
# 2026-10-13-autotrack.md "Shots protocol". A BitBlt from the screen DC (CAPTUREBLT) with a HALFTONE
# stretch to at most 1920 px on the long side lands in one of 4 DIB sections; save writes a JPEG
# (System.Drawing, path.tmp then rename). Displays are logical points (physical / DPI scale), `os` is
# the physical rect and DPI scale. Everything, JSON included, runs in C# after one compile. A crop is
# a plain BitBlt of one rect (logical points x DPI) at physical pixels, no stretch.
#
# `--ocr` is the third helper, started on demand at BelowNormal priority: op read {path} runs
# Windows.Media.Ocr (WinRT, from PowerShell 5.1 through AsTask) on one image and answers
# {lines: [{text, x, y, w, h}], w, h, cpuMs}, each box the union of its words in image pixels. The
# engine has no per-line confidence, so `conf` is absent.

$ErrorActionPreference = 'Stop'

function Write-AsciiLine([System.IO.Stream]$out, [string]$json) {
    # Non-ASCII as \uXXXX: the line is the same bytes whatever the console code page.
    $json = [regex]::Replace($json, '[^\x00-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($json + "`n")
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

function Get-Usage {
    $p = [System.Diagnostics.Process]::GetCurrentProcess()
    $p.Refresh()
    return @{ cpuMs = [math]::Round($p.TotalProcessorTime.TotalMilliseconds); rssMb = [math]::Round($p.WorkingSet64 / 1MB) }
}

if ($args -contains '--ocr') {
    try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    # WinRT IAsyncOperation<T> to a Task<T> (PowerShell 5.1 has no await).
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Wait-Op($op, [Type]$type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
        $null = $task.Wait(-1)
        return $task.Result
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) } catch { }
    }
    function Read-Image([string]$path) {
        if ($null -eq $engine) { return @{ error = 'no OCR language installed' } }
        if (-not (Test-Path -LiteralPath $path)) { return @{ error = "cannot read $path" } }
        $c0 = (Get-Usage).cpuMs
        $file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $path).ProviderPath)) ([Windows.Storage.StorageFile])
        $stream = Wait-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $decoder = Wait-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Wait-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            try {
                $result = Wait-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
                $lines = New-Object System.Collections.ArrayList
                foreach ($line in $result.Lines) {
                    $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0.0; $y1 = 0.0
                    foreach ($w in $line.Words) {
                        $r = $w.BoundingRect
                        $x0 = [math]::Min($x0, $r.X); $y0 = [math]::Min($y0, $r.Y)
                        $x1 = [math]::Max($x1, $r.X + $r.Width); $y1 = [math]::Max($y1, $r.Y + $r.Height)
                    }
                    if ($x0 -eq [double]::MaxValue) { continue }
                    $null = $lines.Add([ordered]@{
                        text = $line.Text; x = [math]::Round($x0); y = [math]::Round($y0)
                        w = [math]::Round($x1 - $x0); h = [math]::Round($y1 - $y0)
                    })
                }
                return [ordered]@{ lines = $lines; w = $bitmap.PixelWidth; h = $bitmap.PixelHeight; cpuMs = (Get-Usage).cpuMs - $c0 }
            } finally { $bitmap.Dispose() }
        } finally { $stream.Dispose() }
    }
    $stdin = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding -ArgumentList $false)
    $stdout = [Console]::OpenStandardOutput()
    while ($null -ne ($line = $stdin.ReadLine())) {
        $line = $line.TrimStart([char]0xFEFF)
        if ($line.Trim().Length -eq 0) { continue }
        try { $req = $line | ConvertFrom-Json } catch { continue }
        $res = [ordered]@{ id = $req.id }
        try {
            switch ([string]$req.op) {
                'read' { $a = Read-Image ([string]$req.path); foreach ($k in $a.Keys) { $res[$k] = $a[$k] } }
                'usage' { $a = Get-Usage; $res['cpuMs'] = $a.cpuMs; $res['rssMb'] = $a.rssMb }
                default { $res['error'] = 'unknown op' }
            }
        } catch { $res['error'] = $_.Exception.Message }
        Write-AsciiLine $stdout ($res | ConvertTo-Json -Compress -Depth 5)
    }
    exit 0
}

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
    // Every 30 s: collect, then hand the working set back to Windows. Most of a PowerShell
    // process is runtime pages it touched once at startup; they stay out until used again.
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr p, IntPtr min, IntPtr max);
    static System.Threading.Timer trimmer;
    public static void StartTrim() {
        trimmer = new System.Threading.Timer(delegate {
            GC.Collect();
            SetProcessWorkingSetSize(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1));
        }, null, 30000, 30000);
    }
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
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, uint rop);

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
        try {
            using (Bitmap bmp = new Bitmap(s.W, s.H, s.W * 4, PixelFormat.Format32bppRgb, s.Bits)) WriteJpeg(bmp, path, q);
            return "\"ok\":true,\"bytes\":" + new FileInfo(path).Length;
        } catch (Exception e) {
            return Fail(e.Message);
        }
    }

    static double NumOf(Dictionary<string, object> req, string key, double fallback) {
        object v;
        return req.TryGetValue(key, out v) && v is double ? (double)v : fallback;
    }

    static ImageCodecInfo Jpeg() {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
        return null;
    }

    static void WriteJpeg(Bitmap bmp, string path, long q) {
        string tmp = path + ".tmp";
        ImageCodecInfo jpeg = Jpeg();
        if (jpeg == null) throw new Exception("no JPEG encoder");
        try {
            using (EncoderParameters ep = new EncoderParameters(1)) {
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
                bmp.Save(tmp, jpeg, ep);
            }
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        } catch (Exception) {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (Exception) { }
            throw;
        }
    }

    // A rect in global logical points, at the display's physical pixels: one BitBlt, no stretch.
    static string OpCrop(Dictionary<string, object> req) {
        string id = Str(req, "display");
        Display d = null;
        foreach (Display e in Displays()) if (((long)e.Handle).ToString(CultureInfo.InvariantCulture) == id) d = e;
        if (d == null) return Fail("no such display");
        object pathObj;
        req.TryGetValue("path", out pathObj);
        string path = pathObj as string;
        double lx = NumOf(req, "x", double.NaN), ly = NumOf(req, "y", double.NaN);
        double lw = NumOf(req, "w", 0), lh = NumOf(req, "h", 0);
        if (string.IsNullOrEmpty(path) || double.IsNaN(lx) || double.IsNaN(ly) || lw < 1 || lh < 1) return Fail("bad request");
        // logical to physical: a display's logical origin is its physical origin / DPI
        int w = Math.Min(d.W, Math.Max(1, (int)Math.Round(lw * d.Dpi)));
        int h = Math.Min(d.H, Math.Max(1, (int)Math.Round(lh * d.Dpi)));
        int x = Math.Max(d.X, Math.Min(d.X + d.W - w, (int)Math.Round(lx * d.Dpi)));
        int y = Math.Max(d.Y, Math.Min(d.Y + d.H - h, (int)Math.Round(ly * d.Dpi)));
        long q = Math.Min(100, Math.Max(1, (long)NumOf(req, "quality", 85)));
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr dst = g.GetHdc();
                IntPtr screen = GetDC(IntPtr.Zero);
                bool ok;
                try { ok = BitBlt(dst, 0, 0, w, h, screen, x, y, SrcCopy | CaptureBlt); }
                finally { ReleaseDC(IntPtr.Zero, screen); g.ReleaseHdc(dst); }
                if (!ok) return Fail("capture failed");
            }
            WriteJpeg(bmp, path, q);
        }
        return "\"ok\":true,\"bytes\":" + new FileInfo(path).Length + ",\"w\":" + w + ",\"h\":" + h;
    }

    static string OpUsage() {
        System.Diagnostics.Process p = System.Diagnostics.Process.GetCurrentProcess();
        p.Refresh();
        return "\"cpuMs\":" + Math.Round(p.TotalProcessorTime.TotalMilliseconds).ToString(CultureInfo.InvariantCulture) +
            ",\"rssMb\":" + Math.Round(p.WorkingSet64 / 1048576.0).ToString(CultureInfo.InvariantCulture);
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
            else if (op == "crop") body = OpCrop(req);
            else if (op == "usage") body = OpUsage();
            else body = "\"error\":\"unknown op\"";
        } catch (Exception e) {
            body = (op == "save" || op == "crop" ? "\"ok\":false," : "") + "\"error\":" + Quote(e.Message);
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
        StartTrim();
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
    // Every 30 s: collect, then hand the working set back to Windows. Most of a PowerShell
    // process is runtime pages it touched once at startup; they stay out until used again.
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr p, IntPtr min, IntPtr max);
    static System.Threading.Timer trimmer;
    public static void StartTrim() {
        trimmer = new System.Threading.Timer(delegate {
            GC.Collect();
            SetProcessWorkingSetSize(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1));
        }, null, 30000, 30000);
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int StyleOf(IntPtr h, int index);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);

    // A Win32 edit that masks its text. UIA's Win32 proxy only knows the class "Edit", so a
    // WinForms box (WindowsForms10.EDIT...) comes through as a Pane with IsPassword false: ask the
    // window itself (ES_PASSWORD, or EM_GETPASSWORDCHAR non-zero).
    public static bool PasswordEdit(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if ((StyleOf(h, -16) & 0x20) != 0) return true;
        IntPtr r;
        return SendMessageTimeoutW(h, 0xD2, IntPtr.Zero, IntPtr.Zero, 0x2, 50, out r) != IntPtr.Zero && r != IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_POWER_STATUS { public byte AC, BatteryFlag, BatteryPercent, Saver; public int LifeTime, FullLifeTime; }
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

    // [ac, battery]: ac 1/0, -1 unknown; battery 0..100, -1 none or unknown.
    public static int[] Power() {
        SYSTEM_POWER_STATUS s;
        if (!GetSystemPowerStatus(out s)) return new int[] { -1, -1 };
        int ac = s.AC == 1 ? 1 : s.AC == 0 ? 0 : -1;
        int pct = (s.BatteryFlag & 128) != 0 || s.BatteryPercent > 100 ? -1 : s.BatteryPercent;
        return new int[] { ac, pct };
    }

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
$uiaRefs = @([System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $uiaRefs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// The probe's work off the request loop: one locked stdout writer (answers from any thread stay
// whole lines), the `tree` walk on a pool thread, the clipboard poll on an STA thread, and the
// front window's dialog words and window count. Never an element's value. C# 5 only.
public static class AutotrackBg {
    static readonly object outLock = new object();
    static StreamWriter stdout;

    public static void Open() {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new ASCIIEncoding());
        stdout.AutoFlush = true;
        stdout.NewLine = "\n";
    }

    // Everything above ASCII escaped, so the line is the same bytes under any console code page.
    public static void Emit(string json) {
        StringBuilder sb = new StringBuilder(json.Length + 16);
        foreach (char ch in json) {
            if (ch < 0x80) sb.Append(ch);
            else sb.Append("\\u").Append(((int)ch).ToString("x4"));
        }
        lock (outLock) { stdout.WriteLine(sb.ToString()); }
    }

    static void Str(StringBuilder sb, string s) {
        sb.Append('"');
        foreach (char ch in s ?? "") {
            switch (ch) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
    }

    static int Round(double v) {
        if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
        return (int)Math.Round(v);
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc fn, IntPtr data);

    // ---- names: never one that shows the element's value (see probe.ps1 Get-SafeName) ----

    public static bool ShowsValue(string name, string value) {
        string n = (name ?? "").Trim(), v = (value ?? "").Trim();
        if (n.Length == 0 || v.Length == 0) return false;
        return n == v || (v.Length >= 3 && n.Contains(v)) || (n.Length >= 12 && v.Contains(n));
    }

    static string ValueOf(AutomationElement el) {
        try {
            object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
            string s = v as string;
            return s ?? "";
        } catch (Exception) { return ""; }
    }

    static string LabelOf(AutomationElement el) {
        try {
            AutomationElement lb = el.Cached.LabeledBy;
            return lb == null ? "" : (lb.Current.Name ?? "");
        } catch (Exception) { return ""; }
    }

    public static string RoleOf(ControlType ct) {
        string p = ct == null ? "" : ct.ProgrammaticName;
        if (p.StartsWith("ControlType.")) p = p.Substring(12);
        return p.ToLowerInvariant();
    }

    static string SafeName(AutomationElement el, string role) {
        string cls = el.Cached.ClassName ?? "";
        if (role == "document" || cls.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0) return LabelOf(el);
        string name = el.Cached.Name ?? "";
        if (name.Length == 0) return name;
        string value = ValueOf(el);
        if (!ShowsValue(name, value)) return name;
        string label = LabelOf(el);
        return ShowsValue(label, value) ? "" : label;
    }

    // ---- tree ----

    static CacheRequest treeCache;
    static readonly HashSet<string> passThrough = new HashSet<string> {
        "pane", "group", "custom", "text", "image", "dataitem" };
    static readonly HashSet<string> leaves = new HashSet<string> { "edit", "combobox" };
    const int nameMax = 200;
    static int treeBusy;

    static CacheRequest TreeCache() {
        if (treeCache != null) return treeCache;
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
        treeCache = c;
        return c;
    }

    // Answers `{"id":…,"nodes":[…],"truncated":…,"ms":…}` from a pool thread; a second tree while
    // one runs answers empty and truncated.
    public static void StartTree(long id, int max, int depth, int budgetMs) {
        if (Interlocked.CompareExchange(ref treeBusy, 1, 0) != 0) {
            Emit("{\"id\":" + id + ",\"nodes\":[],\"truncated\":true,\"ms\":0}");
            return;
        }
        ThreadPool.QueueUserWorkItem(delegate(object o) {
            try { Emit(Tree(id, max, depth, budgetMs)); }
            catch (Exception) { Emit("{\"id\":" + id + ",\"nodes\":null}"); }
            finally { Interlocked.Exchange(ref treeBusy, 0); }
        });
    }

    class Walk {
        public StringBuilder sb = new StringBuilder(32768);
        public int count, max, maxDepth, budgetMs;
        public bool truncated;
        public System.Diagnostics.Stopwatch clock;
        public CacheRequest cache;
        public TreeWalker walker = TreeWalker.ControlViewWalker;
    }

    // The foreground window, walked depth first with the ControlView walker: on-screen nodes inside
    // the window only, unnamed id-less containers and labels skipped (their children take their
    // depth), edits and combo boxes as leaves, `max` nodes, `depth` emitted levels, `budgetMs`.
    public static string Tree(long id, int max, int depth, int budgetMs) {
        Walk w = new Walk();
        w.max = max; w.maxDepth = depth; w.budgetMs = budgetMs;
        w.clock = System.Diagnostics.Stopwatch.StartNew();
        w.cache = TreeCache();
        w.sb.Append("{\"id\":").Append(id).Append(",\"nodes\":[");
        IntPtr h = GetForegroundWindow();
        if (h != IntPtr.Zero) {
            AutomationElement root;
            using (w.cache.Activate()) { root = AutomationElement.FromHandle(h); }
            System.Windows.Rect clip = root.Cached.BoundingRectangle;
            Visit(w, root, 0, 0, clip);
        }
        w.sb.Append("],\"truncated\":").Append(w.truncated ? "true" : "false");
        w.sb.Append(",\"ms\":").Append(w.clock.ElapsedMilliseconds).Append('}');
        return w.sb.ToString();
    }

    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);

    // IsPassword, or a Win32 edit class (WinForms, RichEdit) whose window masks its text: UIA's
    // proxy sees those as Panes with IsPassword false. Same test as AutotrackNative.PasswordEdit.
    static bool Secure(AutomationElement.AutomationElementInformation c) {
        if (c.IsPassword) return true;
        if ((c.ClassName ?? "").IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) return false;
        IntPtr h = new IntPtr(c.NativeWindowHandle);
        if (h == IntPtr.Zero) return false;
        if ((GetWindowLongW(h, -16) & 0x20) != 0) return true;
        IntPtr r;
        return SendMessageTimeoutW(h, 0xD2, IntPtr.Zero, IntPtr.Zero, 0x2, 50, out r) != IntPtr.Zero && r != IntPtr.Zero;
    }

    static void Visit(Walk w, AutomationElement el, int depth, int raw, System.Windows.Rect clip) {
        if (w.truncated) return;
        if (w.count >= w.max || w.clock.ElapsedMilliseconds > w.budgetMs || raw > 60) { w.truncated = true; return; }
        AutomationElement.AutomationElementInformation c = el.Cached;
        if (c.IsOffscreen) return;
        System.Windows.Rect r = c.BoundingRectangle;
        bool sized = !r.IsEmpty && r.Width > 0 && r.Height > 0;
        if (sized && !r.IntersectsWith(clip)) return;
        string role = RoleOf(c.ControlType);
        string name = SafeName(el, role);
        if (name.Length > nameMax) name = name.Substring(0, nameMax);
        string aid = c.AutomationId ?? "";
        bool skip = !sized || (name.Length == 0 && aid.Length == 0 && passThrough.Contains(role));
        int next = depth;
        if (!skip) {
            if (depth >= w.maxDepth) { w.truncated = true; return; }
            System.Windows.Rect v = System.Windows.Rect.Intersect(r, clip);
            if (w.count > 0) w.sb.Append(',');
            w.sb.Append("{\"role\":"); Str(w.sb, role);
            w.sb.Append(",\"name\":"); Str(w.sb, name);
            if (aid.Length > 0) { w.sb.Append(",\"id\":"); Str(w.sb, aid); }
            w.sb.Append(",\"x\":").Append(Round(v.X)).Append(",\"y\":").Append(Round(v.Y));
            w.sb.Append(",\"width\":").Append(Round(v.Width)).Append(",\"height\":").Append(Round(v.Height));
            w.sb.Append(",\"depth\":").Append(depth);
            if (Secure(c)) w.sb.Append(",\"secure\":true");
            w.sb.Append('}');
            w.count++;
            next = depth + 1;
        }
        if (leaves.Contains(role)) return;
        System.Windows.Rect inner = clip;
        if (sized && (role == "pane" || role == "document" || role == "list" || role == "tree")) inner = System.Windows.Rect.Intersect(clip, r);
        AutomationElement k = w.walker.GetFirstChild(el, w.cache);
        while (k != null && !w.truncated) {
            Visit(w, k, next, raw + 1, inner);
            k = w.walker.GetNextSibling(k, w.cache);
        }
    }

    // ---- front: dialog and window count ----

    static CacheRequest dialogCache;

    // The foreground window as a dialog: [title, text, buttons...] or null. A dialog is the
    // #32770 class or a modal UIA window; its words come from Text and Button children (60 at most).
    public static string[] Dialog(IntPtr h) {
        if (h == IntPtr.Zero) return null;
        StringBuilder cls = new StringBuilder(64);
        GetClassNameW(h, cls, cls.Capacity);
        if (dialogCache == null) {
            CacheRequest c = new CacheRequest();
            c.Add(AutomationElement.NameProperty);
            c.Add(AutomationElement.ControlTypeProperty);
            c.Add(WindowPattern.IsModalProperty);
            dialogCache = c;
        }
        AutomationElement win;
        using (dialogCache.Activate()) { win = AutomationElement.FromHandle(h); }
        bool modal = false;
        try { modal = (bool)win.GetCachedPropertyValue(WindowPattern.IsModalProperty, true) == true; } catch (Exception) { }
        if (cls.ToString() != "#32770" && !modal) return null;
        List<string> texts = new List<string>();
        List<string> buttons = new List<string>();
        int seen = 0;
        DialogWalk(win, 0, texts, buttons, ref seen);
        string title = win.Cached.Name ?? "";
        if (title.Length == 0 && texts.Count > 0) { title = texts[0]; texts.RemoveAt(0); }
        texts.RemoveAll(delegate(string t) { return t == title; });
        List<string> outList = new List<string>();
        outList.Add(title);
        outList.Add(string.Join("\n", texts.ToArray()));
        outList.AddRange(buttons);
        return outList.ToArray();
    }

    static void DialogWalk(AutomationElement el, int depth, List<string> texts, List<string> buttons, ref int seen) {
        if (depth >= 4) return;
        AutomationElement k = TreeWalker.ControlViewWalker.GetFirstChild(el, dialogCache);
        while (k != null && seen < 60) {
            seen++;
            ControlType ct = k.Cached.ControlType;
            string name = k.Cached.Name ?? "";
            if (ct == ControlType.Text) { if (name.Length > 0) texts.Add(name); }
            else if (ct == ControlType.Button) { if (name.Length > 0) buttons.Add(name); }
            else if (ct != ControlType.Edit && ct != ControlType.Document && ct != ControlType.ComboBox) DialogWalk(k, depth + 1, texts, buttons, ref seen);
            k = TreeWalker.ControlViewWalker.GetNextSibling(k, dialogCache);
        }
    }

    // Visible top-level windows of the process, tool windows left out.
    public static int Windows(uint pid) {
        int n = 0;
        EnumWindows(delegate(IntPtr h, IntPtr d) {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h) && (GetWindowLongW(h, -20) & 0x80) == 0) n++;
            return true;
        }, IntPtr.Zero);
        return n;
    }

    // ---- clipboard ----

    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatNameW(uint format, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);

    static Thread clipThread;
    static readonly Dictionary<uint, string> stdFormats = new Dictionary<uint, string> {
        { 1, "text" }, { 2, "bitmap" }, { 8, "dib" }, { 13, "unicodetext" }, { 15, "files" }, { 17, "dibv5" } };
    static readonly HashSet<string> concealedFormats = new HashSet<string> {
        "ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore" };
    const int clipTextMax = 4096;

    public static void WatchClipboard() {
        lock (outLock) {
            if (clipThread != null) return;
            clipThread = new Thread(ClipLoop);
            clipThread.IsBackground = true;
            clipThread.SetApartmentState(ApartmentState.STA);
            clipThread.Start();
        }
    }

    // 4 Hz on the sequence number; a change read while another app holds the clipboard is retried.
    static void ClipLoop() {
        uint last = GetClipboardSequenceNumber();
        while (true) {
            Thread.Sleep(250);
            uint n = GetClipboardSequenceNumber();
            if (n == last) continue;
            string ev = ClipEvent();
            if (ev == null) continue;
            last = n;
            Emit(ev);
        }
    }

    static string ClipEvent() {
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
                if (h != IntPtr.Zero) {
                    IntPtr p = GlobalLock(h);
                    if (p != IntPtr.Zero) {
                        try {
                            int max = (int)Math.Min((ulong)GlobalSize(h).ToUInt64() / 2, (ulong)int.MaxValue);
                            text = Marshal.PtrToStringUni(p, max);
                            int nul = text.IndexOf('\0');
                            if (nul >= 0) text = text.Substring(0, nul);
                        } finally { GlobalUnlock(h); }
                    }
                }
            }
        } finally { CloseClipboard(); }
        StringBuilder o = new StringBuilder(256);
        o.Append("{\"event\":\"clipboard\",\"types\":[");
        for (int i = 0; i < types.Count; i++) { if (i > 0) o.Append(','); Str(o, types[i]); }
        o.Append("],\"length\":").Append(text == null ? 0 : text.Length);
        o.Append(",\"concealed\":").Append(concealed ? "true" : "false");
        if (text != null && !concealed) {
            o.Append(",\"text\":");
            Str(o, text.Length > clipTextMax ? text.Substring(0, clipTextMax) : text);
        }
        o.Append('}');
        return o.ToString();
    }
}
'@
Write-Stage 'worker compiled'

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
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
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

# UIA's IsPassword, or a Win32 edit class (WinForms, RichEdit) whose window masks its text.
function Test-Secure($c) {
    if ($c.IsPassword) { return $true }
    if ([string]$c.ClassName -notmatch '(?i)edit') { return $false }
    return [AutotrackNative]::PasswordEdit([IntPtr][int]$c.NativeWindowHandle)
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
        secure = (Test-Secure $c)
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
    $dialog = $null
    try {
        $d = [AutotrackBg]::Dialog($h)
        if ($null -ne $d) { $dialog = [ordered]@{ title = $d[0]; text = $d[1]; buttons = @($d | Select-Object -Skip 2) } }
    } catch { }
    return @{ app = $app; window = $window; dialog = $dialog; windows = [AutotrackBg]::Windows($procId) }
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
                $res['windows'] = $f.windows
                $res['dialog'] = $f.dialog
            }
            'tree' {
                $max = 1500; $depth = 25; $budget = 750
                if ($null -ne $req.max) { $max = [int]$req.max }
                if ($null -ne $req.depth) { $depth = [int]$req.depth }
                if ($null -ne $req.budgetMs) { $budget = [int]$req.budgetMs }
                [AutotrackBg]::StartTree([long]$req.id, $max, $depth, $budget)
                return $null # answered by the worker
            }
            'watch' {
                if ($req.clipboard -eq $true) { [AutotrackBg]::WatchClipboard() }
                $res['ok'] = $true
            }
            'perm' {
                $res['accessibility'] = $true; $res['screen'] = $true; $res['input'] = $true
            }
            'usage' {
                $u = Get-Usage
                $res['cpuMs'] = $u.cpuMs; $res['rssMb'] = $u.rssMb
            }
            'power' {
                $p = [AutotrackNative]::Power()
                $res['ac'] = $(if ($p[0] -lt 0) { $null } else { $p[0] -eq 1 })
                $res['battery'] = $(if ($p[1] -lt 0) { $null } else { $p[1] })
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


# UTF-8 in, BOM dropped: a .NET parent whose console is UTF-8 writes one before its first line,
# which ConvertFrom-Json refuses (the shots helper's StreamReader skips it by itself).
$stdin = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding -ArgumentList $false)
[AutotrackBg]::Open()
[AutotrackNative]::StartTrim()
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
        $res = Invoke-Op $req
        if ($null -ne $res) { [AutotrackBg]::Emit(($res | ConvertTo-Json -Compress -Depth 4)) }
    } catch {
        Write-Stage ('answer failed: ' + $_.Exception.Message)
    }
}
