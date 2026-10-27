// --shots: frames. Ops: displays, grab, save, crop, usage. See designs/2026-10-13-autotrack.md
// "Shots protocol". A BitBlt from the screen DC (CAPTUREBLT) with a HALFTONE stretch to at most
// 1280 px on the long side lands in one of 4 DIB sections; save writes a JPEG (System.Drawing,
// path.tmp then rename). Displays are logical points (physical / DPI scale), `os` is the physical
// rect and DPI scale. A crop is a plain BitBlt of one rect (logical points x DPI) at physical
// pixels, no stretch.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Shots {
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

    const int MaxSide = 1280;
    const int RingSize = 4;
    const uint SrcCopy = 0x00CC0020;
    const uint CaptureBlt = 0x40000000;

    sealed class Display {
        public IntPtr Handle;
        public int X, Y, W, H; // physical pixels on the virtual desktop
        public double Dpi;     // DPI scale: 1.0 = 96 dpi
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

    public static int Run() {
        Io.Stage("DPI awareness: " + Io.EnableDpiAwareness());
        Io.StartTrim();
        Io.Stage("ready");
        return Io.Serve(Handle);
    }

    static string Handle(Dictionary<string, object> req) {
        string op = Json.Str(req, "op");
        try {
            if (op == "displays") {
                List<string> parts = new List<string>();
                foreach (Display d in Displays()) parts.Add(DisplayJson(d));
                return "\"displays\":[" + string.Join(",", parts.ToArray()) + "]";
            }
            if (op == "grab") return Grab(req);
            if (op == "save") return Save(req);
            if (op == "crop") return Crop(req);
            if (op == "usage") return Io.Usage();
            return "\"error\":\"unknown op\"";
        } catch (Exception e) {
            return (op == "save" || op == "crop" ? "\"ok\":false," : "") + "\"error\":" + Json.Quote(e.Message);
        }
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

    static Display Find(string id) {
        foreach (Display e in Displays()) if (((long)e.Handle).ToString(CultureInfo.InvariantCulture) == id) return e;
        return null;
    }

    static void FitSize(int w, int h, out int fw, out int fh) {
        double k = Math.Min(1.0, (double)MaxSide / Math.Max(w, h));
        fw = Math.Max(1, (int)Math.Round(w * k, MidpointRounding.AwayFromZero));
        fh = Math.Max(1, (int)Math.Round(h * k, MidpointRounding.AwayFromZero));
    }

    static string DisplayJson(Display d) {
        int fw, fh;
        FitSize(d.W, d.H, out fw, out fh);
        double lw = d.W / d.Dpi;
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"id\":\"").Append(((long)d.Handle).ToString(CultureInfo.InvariantCulture)).Append("\"");
        sb.Append(",\"x\":").Append(Json.Num(d.X / d.Dpi, 2));
        sb.Append(",\"y\":").Append(Json.Num(d.Y / d.Dpi, 2));
        sb.Append(",\"width\":").Append(Json.Num(lw, 2));
        sb.Append(",\"height\":").Append(Json.Num(d.H / d.Dpi, 2));
        sb.Append(",\"scale\":").Append(Json.Num(fw / lw, 3));
        sb.Append(",\"primary\":").Append(d.Primary ? "true" : "false");
        sb.Append(",\"os\":{\"x\":").Append(d.X).Append(",\"y\":").Append(d.Y);
        sb.Append(",\"width\":").Append(d.W).Append(",\"height\":").Append(d.H);
        sb.Append(",\"scale\":").Append(Json.Num(d.Dpi, 3)).Append("}}");
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

    // 64-bit hash of a BGRA frame: top byte = mean luma of the top half, next = bottom half, low
    // 48 bits = difference hash (is each cell darker than its right neighbour) over a 9x6 grid of
    // cell means. Same as the Mac helper.
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

    static string Grab(Dictionary<string, object> req) {
        Display d = Find(Json.Str(req, "display"));
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

    static string Fail(string why) { return "\"ok\":false,\"error\":" + Json.Quote(why); }

    static string Save(Dictionary<string, object> req) {
        string path = Json.Str(req, "path");
        double slot = Json.Num(req, "slot", double.NaN);
        if (double.IsNaN(slot) || path.Length == 0) return Fail("bad request");
        int n = (int)slot;
        if (n < 0 || n >= RingSize) return Fail("bad request");
        Slot s = ring[n];
        if (s.Dc == IntPtr.Zero || s.Seq <= 0) return Fail("empty slot");
        double seq = Json.Num(req, "seq", double.NaN);
        if (!double.IsNaN(seq) && (int)seq != s.Seq) return Fail("slot reused");
        long q = Math.Min(100, Math.Max(1, (long)Json.Num(req, "quality", 70)));
        try {
            using (Bitmap bmp = new Bitmap(s.W, s.H, s.W * 4, PixelFormat.Format32bppRgb, s.Bits)) WriteJpeg(bmp, path, q);
            return "\"ok\":true,\"bytes\":" + new FileInfo(path).Length;
        } catch (Exception e) {
            return Fail(e.Message);
        }
    }

    static ImageCodecInfo jpeg;

    static void WriteJpeg(Bitmap bmp, string path, long q) {
        if (jpeg == null)
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        if (jpeg == null) throw new Exception("no JPEG encoder");
        string tmp = path + ".tmp";
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
    static string Crop(Dictionary<string, object> req) {
        Display d = Find(Json.Str(req, "display"));
        if (d == null) return Fail("no such display");
        string path = Json.Str(req, "path");
        double lx = Json.Num(req, "x", double.NaN), ly = Json.Num(req, "y", double.NaN);
        double lw = Json.Num(req, "w", 0), lh = Json.Num(req, "h", 0);
        if (path.Length == 0 || double.IsNaN(lx) || double.IsNaN(ly) || lw < 1 || lh < 1) return Fail("bad request");
        // logical to physical: a display's logical origin is its physical origin / DPI
        int w = Math.Min(d.W, Math.Max(1, (int)Math.Round(lw * d.Dpi)));
        int h = Math.Min(d.H, Math.Max(1, (int)Math.Round(lh * d.Dpi)));
        int x = Math.Max(d.X, Math.Min(d.X + d.W - w, (int)Math.Round(lx * d.Dpi)));
        int y = Math.Max(d.Y, Math.Min(d.Y + d.H - h, (int)Math.Round(ly * d.Dpi)));
        long q = Math.Min(100, Math.Max(1, (long)Json.Num(req, "quality", 85)));
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
}
