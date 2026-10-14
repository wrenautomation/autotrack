// autotrack's Windows helper: one exe, three long-lived modes. One JSON request per line on stdin,
// one answer per line on stdout, matched by id. See designs/2026-10-13-autotrack.md "Probe
// protocol" and "Shots protocol".
//
//   autotrack-helper.exe --probe   app and window in front, element at a point or focused, tree,
//                                  clipboard watch, usage, power (probe.cs)
//   autotrack-helper.exe --shots   displays, grab, save, crop, usage (shots.cs)
//   autotrack-helper.exe --ocr     read {path}, usage; started on demand at BelowNormal (ocr.cs)
//
// C# 5 for .NET Framework 4.8, built by build.ps1 with the csc that ships in every Windows, so the
// exe needs nothing installed. Answers are ASCII (anything else as \uXXXX): the line is the same
// bytes under any console code page. A request that is not JSON gets no answer (there is no id to
// answer to); a request that fails answers its fields null or an error; the loop never dies.
// Startup stages and failures go to stderr, which the recorder ignores and a test run shows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Program {
    [MTAThread]
    static int Main(string[] args) {
        string mode = "probe";
        foreach (string a in args) {
            if (a == "--shots") mode = "shots";
            else if (a == "--ocr") mode = "ocr";
            else if (a == "--probe") mode = "probe";
        }
        try {
            if (mode == "shots") return Shots.Run();
            if (mode == "ocr") return Ocr.Run();
            return Probe.Run();
        } catch (Exception e) {
            Io.Stage("fatal: " + e);
            return 1;
        }
    }
}

// stdin, stdout, stderr and the process's own cost.
static class Io {
    static readonly object outLock = new object();
    static Stream stdout;
    static readonly Stopwatch clock = Stopwatch.StartNew();

    public static void Stage(string m) {
        try { Console.Error.WriteLine("helper " + clock.ElapsedMilliseconds + " ms: " + m); } catch (Exception) { }
    }

    // One whole line; safe from any thread.
    public static void Emit(string json) {
        StringBuilder sb = new StringBuilder(json.Length + 16);
        foreach (char ch in json) {
            if (ch < 0x80) sb.Append(ch);
            else sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
        }
        sb.Append('\n');
        byte[] bytes = Encoding.ASCII.GetBytes(sb.ToString());
        lock (outLock) {
            if (stdout == null) stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    // `handle` answers the fields after the id ("\"a\":1,\"b\":2"), or null when it answers later
    // by itself (the probe's tree). Returns when stdin closes.
    public static int Serve(Func<Dictionary<string, object>, string> handle) {
        StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), true);
        string line;
        while ((line = input.ReadLine()) != null) {
            line = line.TrimStart('\uFEFF');
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> req = Json.Parse(line);
            if (req == null) {
                Stage("unparseable line: " + line.Substring(0, Math.Min(80, line.Length)));
                continue;
            }
            if (Json.Str(req, "op") != "usage") lastRequest = Environment.TickCount; // the governor's poll is not use
            string body;
            try { body = handle(req); } catch (Exception e) { body = "\"error\":" + Json.Quote(e.Message); }
            if (body == null) continue;
            Emit("{\"id\":" + Json.IdText(req) + (body.Length > 0 ? "," + body : "") + "}");
        }
        return 0;
    }

    // `"cpuMs":…,"rssMb":…` for this process.
    public static string Usage() {
        Process p = Process.GetCurrentProcess();
        p.Refresh();
        return "\"cpuMs\":" + Math.Round(p.TotalProcessorTime.TotalMilliseconds).ToString(CultureInfo.InvariantCulture) +
            ",\"rssMb\":" + Math.Round(p.WorkingSet64 / 1048576.0).ToString(CultureInfo.InvariantCulture);
    }

    public static double CpuMs() {
        return Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr p, IntPtr min, IntPtr max);
    static Timer trimmer;
    static volatile int lastRequest = Environment.TickCount;
    static int trimmedAt = -1;
    public const int TrimIdleMs = 5000;

    // Once a helper has had no request (but `usage`) for 5 s: collect, then hand the working set back to
    // Windows. Pages touched once (the runtime's start, UI Automation's setup, a frame) stay out
    // until used again. Not while requests come: each trim costs page faults after it.
    public static void StartTrim() {
        trimmer = new Timer(delegate {
            int last = lastRequest;
            if (trimmedAt == last || unchecked(Environment.TickCount - last) < TrimIdleMs) return;
            trimmedAt = last;
            try {
                GC.Collect();
                SetProcessWorkingSetSize(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1));
            } catch (Exception) { }
        }, null, 1000, 1000);
    }

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);

    // Per-monitor DPI aware (v2) before any window or UIA call, so rects come back physical.
    // Newest API first; each older one exists on older Windows. Returns which one took.
    public static string EnableDpiAwareness() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch (Exception) { }
        try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch (Exception) { }
        try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
        return "none";
    }
}

// Flat JSON in (requests are one level deep), JSON text out.
static class Json {
    public static string Num(double v, int digits) {
        return Math.Round(v, digits, MidpointRounding.AwayFromZero).ToString("0.###############", CultureInfo.InvariantCulture);
    }

    public static int Round(double v) {
        if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
        return (int)Math.Round(v);
    }

    public static string Quote(string s) {
        StringBuilder sb = new StringBuilder();
        Str(sb, s);
        return sb.ToString();
    }

    // A JSON string literal; non-ASCII stays (Io.Emit escapes it).
    public static void Str(StringBuilder sb, string s) {
        sb.Append('"');
        foreach (char ch in s ?? "") {
            switch (ch) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
    }

    public static string IdText(Dictionary<string, object> req) {
        object id;
        if (req.TryGetValue("id", out id) && id is double) return ((double)id).ToString("0.###############", CultureInfo.InvariantCulture);
        return "null";
    }

    public static string Str(Dictionary<string, object> req, string key) {
        object v;
        if (!req.TryGetValue(key, out v) || v == null) return "";
        if (v is double) return ((double)v).ToString("0.###############", CultureInfo.InvariantCulture);
        return v as string ?? "";
    }

    public static double Num(Dictionary<string, object> req, string key, double fallback) {
        object v;
        return req.TryGetValue(key, out v) && v is double ? (double)v : fallback;
    }

    public static bool True(Dictionary<string, object> req, string key) {
        object v;
        return req.TryGetValue(key, out v) && v is bool && (bool)v;
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
}
