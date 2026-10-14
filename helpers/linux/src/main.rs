//! autotrack's Linux helper: one static binary, three long-lived modes. One JSON request per line
//! on stdin, one answer per line on stdout, matched by id. See designs/2026-10-13-autotrack.md
//! "Probe protocol", "Shots protocol" and "Linux".
//!
//!   autotrack-helper --probe   app and window in front (X11), element at a point or focused,
//!                              tree (AT-SPI over D-Bus), clipboard watch (XFixes), usage, perm
//!   autotrack-helper --shots   displays (RandR), grab (MIT-SHM), save, crop (JPEG), usage
//!   autotrack-helper --ocr     read {path} with tesseract when installed, usage; nice 10
//!
//! Answers are ASCII (anything else as \uXXXX). A request that is not JSON gets no answer (there is
//! no id to answer to); a request that fails answers its fields null or an error; the loop never
//! dies. Startup stages and failures go to stderr, which the recorder ignores and a test shows.

mod atspi;
mod clip;
mod json;
mod name;
mod ocr;
mod probe;
mod shots;
mod x;

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

static OUT: Mutex<()> = Mutex::new(());
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
/// ms since start of the last request that was not `usage`.
pub static LAST_REQUEST_MS: AtomicU64 = AtomicU64::new(0);

pub fn elapsed_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

pub fn stage(m: &str) {
    let _ = writeln!(std::io::stderr(), "helper {} ms: {}", elapsed_ms(), m);
}

/// One whole line on stdout; safe from any thread.
pub fn emit(json: &str) {
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(json.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// `handle` answers the fields after the id (`"a":1,"b":2`), or None when it answers later by
/// itself (the probe's tree). Returns when stdin closes.
pub fn serve(mut handle: impl FnMut(&json::Req) -> Option<String>) -> i32 {
    let stdin = std::io::stdin();
    let mut line = String::new();
    let mut input = stdin.lock();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => return 0,
            Ok(_) => {}
        }
        let l = line.trim_start_matches('\u{feff}').trim();
        if l.is_empty() {
            continue;
        }
        let Some(req) = json::parse(l) else {
            stage(&format!("unparseable line: {}", l.chars().take(80).collect::<String>()));
            continue;
        };
        if json::str_of(&req, "op") != "usage" {
            LAST_REQUEST_MS.store(elapsed_ms(), Ordering::Relaxed);
        }
        let body = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&req))) {
            Ok(b) => b,
            Err(_) => Some("\"error\":\"internal error\"".into()),
        };
        let Some(body) = body else { continue };
        let id = json::id_text(&req);
        if body.is_empty() {
            emit(&format!("{{\"id\":{}}}", id));
        } else {
            emit(&format!("{{\"id\":{},{}}}", id, body));
        }
    }
}

/// This process's CPU ms (user + system), children too when asked (the OCR helper's tesseract).
pub fn cpu_ms(children: bool) -> f64 {
    fn of(who: libc::c_int) -> f64 {
        let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(who, &mut ru) } != 0 {
            return 0.0;
        }
        let t = |tv: libc::timeval| tv.tv_sec as f64 * 1000.0 + tv.tv_usec as f64 / 1000.0;
        t(ru.ru_utime) + t(ru.ru_stime)
    }
    of(libc::RUSAGE_SELF) + if children { of(libc::RUSAGE_CHILDREN) } else { 0.0 }
}

/// Resident MB from /proc/self/statm (pages × page size).
pub fn rss_mb() -> f64 {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as f64;
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).and_then(|v| v.parse::<f64>().ok()))
        .map(|pages| pages * page / 1048576.0)
        .unwrap_or(0.0)
}

/// `"cpuMs":…,"rssMb":…` for this process.
pub fn usage(children: bool) -> String {
    format!("\"cpuMs\":{},\"rssMb\":{}", cpu_ms(children).round() as i64, rss_mb().round() as i64)
}

fn main() {
    START.get_or_init(Instant::now);
    let mut mode = "probe";
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--shots" => mode = "shots",
            "--ocr" => mode = "ocr",
            "--probe" => mode = "probe",
            "--version" => {
                println!("autotrack-helper {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            _ => {}
        }
    }
    let code = match mode {
        "shots" => shots::run(),
        "ocr" => ocr::run(),
        _ => probe::run(),
    };
    std::process::exit(code);
}
