//! --ocr: `read {path}` runs `tesseract <path> stdout tsv` (nice 10, one thread) and answers
//! `{lines: [{text, x, y, w, h, conf}], w, h, cpuMs}`, each box the union of its words in image
//! pixels, origin top-left, `conf` the words' mean / 100. `cpuMs` counts tesseract too.

use crate::json::{self, push_str, Req};
use crate::stage;
use std::process::{Command, Stdio};

#[derive(Debug, PartialEq)]
pub struct Line {
    pub text: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub conf: f64,
}

pub struct Page {
    pub lines: Vec<Line>,
    pub w: i64,
    pub h: i64,
}

pub fn run() -> i32 {
    // SAFETY: plain libc call; children (tesseract) inherit the niceness.
    unsafe {
        libc::nice(10);
    }
    stage(if which("tesseract").is_some() { "ready" } else { "tesseract not found: reads fail" });
    crate::serve(|req: &Req| {
        let op = json::str_of(req, "op");
        Some(match op.as_str() {
            "read" => read(&json::str_of(req, "path")).unwrap_or_else(|e| {
                let mut s = String::from("\"error\":");
                push_str(&mut s, &e);
                s
            }),
            "usage" => crate::usage(true),
            _ => "\"error\":\"unknown op\"".into(),
        })
    })
}

pub fn which(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(bin)).find(|p| {
        std::fs::metadata(p).map(|m| m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0).unwrap_or(false)
    })
}

fn read(path: &str) -> Result<String, String> {
    if path.is_empty() || !std::path::Path::new(path).is_file() {
        return Err(format!("cannot read {}", path));
    }
    let c0 = crate::cpu_ms(true);
    let out = Command::new("tesseract")
        .arg(path)
        .arg("stdout")
        .arg("tsv")
        .env("OMP_THREAD_LIMIT", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "tesseract not installed".to_string() } else { e.to_string() })?;
    if !out.status.success() {
        return Err(format!("tesseract failed ({})", out.status));
    }
    let page = parse_tsv(&String::from_utf8_lossy(&out.stdout));
    let mut s = String::with_capacity(1024);
    s.push_str("\"lines\":[");
    for (i, l) in page.lines.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"text\":");
        push_str(&mut s, &l.text);
        s.push_str(&format!(",\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"conf\":{}}}", l.x, l.y, l.w, l.h, json::num(l.conf, 3)));
    }
    s.push_str(&format!("],\"w\":{},\"h\":{},\"cpuMs\":{}", page.w, page.h, (crate::cpu_ms(true) - c0).round() as i64));
    Ok(s)
}

/// tesseract's TSV: level, page, block, par, line, word, left, top, width, height, conf, text.
/// Level 1 is the page (its size); level 5 rows are words, grouped by (block, par, line).
pub fn parse_tsv(tsv: &str) -> Page {
    let mut page = Page { lines: Vec::new(), w: 0, h: 0 };
    let mut key: Option<(i64, i64, i64)> = None;
    let mut cur: Option<(Vec<String>, i64, i64, i64, i64, f64, usize)> = None;
    let flush = |cur: &mut Option<(Vec<String>, i64, i64, i64, i64, f64, usize)>, lines: &mut Vec<Line>| {
        if let Some((words, x0, y0, x1, y1, conf, n)) = cur.take() {
            if n > 0 {
                lines.push(Line { text: words.join(" "), x: x0, y: y0, w: x1 - x0, h: y1 - y0, conf: conf / n as f64 / 100.0 });
            }
        }
    };
    for row in tsv.lines() {
        let f: Vec<&str> = row.splitn(12, '\t').collect();
        if f.len() < 11 {
            continue;
        }
        let n = |i: usize| f[i].trim().parse::<i64>().ok();
        let Some(level) = n(0) else { continue }; // the header
        let (Some(x), Some(y), Some(w), Some(h)) = (n(6), n(7), n(8), n(9)) else { continue };
        if level == 1 {
            page.w = page.w.max(w);
            page.h = page.h.max(h);
            continue;
        }
        if level != 5 {
            continue;
        }
        let text = f.get(11).map(|t| t.trim()).unwrap_or("");
        let conf = f[10].trim().parse::<f64>().unwrap_or(-1.0);
        if text.is_empty() || conf < 0.0 {
            continue;
        }
        let k = (n(2).unwrap_or(0), n(3).unwrap_or(0), n(4).unwrap_or(0));
        if key != Some(k) {
            flush(&mut cur, &mut page.lines);
            key = Some(k);
        }
        let c = cur.get_or_insert_with(|| (Vec::new(), i64::MAX, i64::MAX, i64::MIN, i64::MIN, 0.0, 0));
        c.0.push(text.to_string());
        c.1 = c.1.min(x);
        c.2 = c.2.min(y);
        c.3 = c.3.max(x + w);
        c.4 = c.4.max(y + h);
        c.5 += conf;
        c.6 += 1;
    }
    flush(&mut cur, &mut page.lines);
    page
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_words_into_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t640\t480\t-1\t
2\t1\t1\t0\t0\t0\t10\t10\t300\t60\t-1\t
3\t1\t1\t1\t0\t0\t10\t10\t300\t60\t-1\t
4\t1\t1\t1\t1\t0\t10\t10\t200\t20\t-1\t
5\t1\t1\t1\t1\t1\t10\t10\t90\t20\t96.5\tHello
5\t1\t1\t1\t1\t2\t110\t12\t100\t18\t91.5\tworld
5\t1\t1\t1\t1\t3\t220\t12\t10\t18\t-1\t
4\t1\t1\t1\t2\t0\t10\t50\t120\t20\t-1\t
5\t1\t1\t1\t2\t1\t10\t50\t120\t20\t88\tSubmit
";
        let p = parse_tsv(tsv);
        assert_eq!((p.w, p.h), (640, 480));
        assert_eq!(
            p.lines,
            vec![
                Line { text: "Hello world".into(), x: 10, y: 10, w: 200, h: 20, conf: 0.94 },
                Line { text: "Submit".into(), x: 10, y: 50, w: 120, h: 20, conf: 0.88 },
            ]
        );
        assert!(parse_tsv("").lines.is_empty());
    }
}
