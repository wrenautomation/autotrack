// --ocr: started on demand at BelowNormal priority while the person is idle. `read {path}` runs
// Windows.Media.Ocr (WinRT) on one image and answers {lines: [{text, x, y, w, h}], w, h, cpuMs},
// each box the union of its words in image pixels, origin top-left. The engine has no per-line
// confidence, so `conf` is absent.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

static class Ocr {
    static OcrEngine engine;

    public static int Run() {
        try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch (Exception) { }
        try { engine = OcrEngine.TryCreateFromUserProfileLanguages(); } catch (Exception) { }
        if (engine == null) {
            try { engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US")); } catch (Exception) { }
        }
        Io.Stage(engine == null ? "no OCR language" : "ready");
        Io.StartTrim();
        return Io.Serve(Handle);
    }

    static string Handle(Dictionary<string, object> req) {
        string op = Json.Str(req, "op");
        try {
            if (op == "read") return Read(Json.Str(req, "path"));
            if (op == "usage") return Io.Usage();
            return "\"error\":\"unknown op\"";
        } catch (Exception e) {
            return "\"error\":" + Json.Quote(e.Message);
        }
    }

    // WinRT async to a result on this thread; the real error, not AggregateException's.
    static T Wait<T>(IAsyncOperation<T> op) {
        try { return op.AsTask().Result; }
        catch (AggregateException e) { throw e.InnerException ?? e; }
    }

    static string Read(string path) {
        if (engine == null) return "\"error\":\"no OCR language installed\"";
        if (path.Length == 0 || !File.Exists(path)) return "\"error\":" + Json.Quote("cannot read " + path);
        double c0 = Io.CpuMs();
        StorageFile file = Wait(StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)));
        using (IRandomAccessStream stream = Wait(file.OpenAsync(FileAccessMode.Read))) {
            BitmapDecoder decoder = Wait(BitmapDecoder.CreateAsync(stream));
            using (SoftwareBitmap bitmap = Wait(decoder.GetSoftwareBitmapAsync())) {
                OcrResult result = Wait(engine.RecognizeAsync(bitmap));
                StringBuilder sb = new StringBuilder(1024);
                sb.Append("\"lines\":[");
                int n = 0;
                foreach (OcrLine line in result.Lines) {
                    double x0 = double.MaxValue, y0 = double.MaxValue, x1 = 0, y1 = 0;
                    foreach (OcrWord w in line.Words) {
                        Rect r = w.BoundingRect;
                        x0 = Math.Min(x0, r.X); y0 = Math.Min(y0, r.Y);
                        x1 = Math.Max(x1, r.X + r.Width); y1 = Math.Max(y1, r.Y + r.Height);
                    }
                    if (x0 == double.MaxValue) continue;
                    if (n++ > 0) sb.Append(',');
                    sb.Append("{\"text\":"); Json.Str(sb, line.Text);
                    sb.Append(",\"x\":").Append(Json.Round(x0)).Append(",\"y\":").Append(Json.Round(y0));
                    sb.Append(",\"w\":").Append(Json.Round(x1 - x0)).Append(",\"h\":").Append(Json.Round(y1 - y0)).Append('}');
                }
                sb.Append("],\"w\":").Append(bitmap.PixelWidth).Append(",\"h\":").Append(bitmap.PixelHeight);
                sb.Append(",\"cpuMs\":").Append((long)Math.Round(Io.CpuMs() - c0));
                return sb.ToString();
            }
        }
    }
}
