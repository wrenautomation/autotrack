//! --probe: app and window in front (X11), element at a point or focused, the front frame's tree
//! (AT-SPI), the clipboard (XFixes), usage, perm, power. See designs/2026-10-13-autotrack.md
//! "Probe protocol" and "Linux".
//!
//! COORDINATE SPACE: X root pixels, which uiohook reports on X11 and AT-SPI uses for screen
//! extents. A hung app can stall one request until the 1.5 s D-Bus timeout; the caller times out
//! to null first.

use crate::atspi::{A11y, Obj};
use crate::json::{self, push_str, Req};
use crate::x::{comm_of, exe_of, X};
use crate::{clip, stage};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;

const FOCUS_TTL: Duration = Duration::from_millis(2000);
const DIALOG_TTL: Duration = Duration::from_millis(3000);
const LOCK_TTL: Duration = Duration::from_millis(1000);
const A11Y_RETRY: Duration = Duration::from_secs(5);

struct Cached<K> {
    key: K,
    at: Instant,
    json: String,
}

pub struct Probe {
    x: Option<X>,
    a11y: Mutex<Option<Arc<A11y>>>,
    a11y_tried: Mutex<Option<Instant>>,
    session: Option<Connection>,
    lock: Mutex<Option<(Instant, bool)>>,
    focus: Mutex<Option<Cached<(Obj, u64)>>>,
    dialog: Mutex<Option<Cached<(u32, u64)>>>,
    tree_busy: AtomicBool,
    enhance: bool,
}

pub fn run() -> i32 {
    let enhance = std::env::var("AUTOTRACK_PROBE_NO_ENHANCE").map(|v| v != "1").unwrap_or(true);
    let x = X::open();
    stage(if x.is_some() { "X11 connected" } else { "no X display: front, at and tree answer null" });
    let session = Connection::session().ok();
    let p = Arc::new(Probe {
        x,
        a11y: Mutex::new(None),
        a11y_tried: Mutex::new(None),
        session,
        lock: Mutex::new(None),
        focus: Mutex::new(None),
        dialog: Mutex::new(None),
        tree_busy: AtomicBool::new(false),
        enhance,
    });
    if p.a11y().is_some() {
        stage("AT-SPI bus connected");
    } else {
        stage("no AT-SPI bus: elements answer null");
    }
    stage("ready");
    let me = Arc::clone(&p);
    crate::serve(move |req| me.handle(req))
}

impl Probe {
    /// The a11y connection, opened on first use and retried every 5 s while it is missing.
    fn a11y(&self) -> Option<Arc<A11y>> {
        if let Some(a) = self.a11y.lock().unwrap().as_ref() {
            return Some(Arc::clone(a));
        }
        {
            let mut t = self.a11y_tried.lock().unwrap();
            if t.map(|t| t.elapsed() < A11Y_RETRY).unwrap_or(false) {
                return None;
            }
            *t = Some(Instant::now());
        }
        let a = A11y::open(self.enhance)?;
        a.listen_focus();
        *self.a11y.lock().unwrap() = Some(Arc::clone(&a));
        Some(a)
    }

    fn handle(self: &Arc<Self>, req: &Req) -> Option<String> {
        let op = json::str_of(req, "op");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match op.as_str() {
            "at" => Some(format!("\"element\":{}", self.at(req).unwrap_or_else(|| "null".into()))),
            "focused" => Some(format!("\"element\":{}", self.focused().unwrap_or_else(|| "null".into()))),
            "front" => Some(self.front()),
            "tree" => {
                self.tree(req);
                None
            }
            "watch" => {
                if json::is_true(req, "clipboard") {
                    clip::watch();
                }
                Some("\"ok\":true".into())
            }
            "perm" => Some(self.perm()),
            "usage" => Some(crate::usage(false)),
            "power" => Some(power_json(&read_power("/sys/class/power_supply"))),
            _ => Some("\"error\":\"unknown op\"".into()),
        }));
        match r {
            Ok(v) => v,
            Err(_) => {
                stage(&format!("{} failed", op));
                Some(match op.as_str() {
                    "front" => "\"app\":null,\"window\":null".into(),
                    "perm" => self.perm(),
                    "tree" => "\"nodes\":null".into(),
                    _ => "\"element\":null".into(),
                })
            }
        }
    }

    // ---- elements ----

    fn at(&self, req: &Req) -> Option<String> {
        let x = json::num_of(req, "x")?.round() as i32;
        let y = json::num_of(req, "y")?.round() as i32;
        if self.locked() {
            return None;
        }
        let xc = self.x.as_ref()?;
        let a = self.a11y()?;
        let w = xc.at(x, y)?;
        let pid = xc.pid(w)?;
        let app = a.app_for(pid)?;
        let frame = a.frame_at(&app, x, y)?;
        let el = a.deepest_at(&frame, x, y);
        a.element_json(&el)
    }

    /// The focused element, re-read each time: the event's object must still be `FOCUSED` and in
    /// the front window's process, or the frame is searched. Its JSON is kept 2 s per object while
    /// no focus event comes.
    fn focused(&self) -> Option<String> {
        if self.locked() {
            return None;
        }
        let a = self.a11y()?;
        let xc = self.x.as_ref()?;
        let front_pid = xc.active().and_then(|w| xc.pid(w));
        let seq = a.focus_seq.load(Ordering::SeqCst);
        let mut obj = a.focused_from_events();
        if let (Some(o), Some(pid)) = (&obj, front_pid) {
            if a.app_for(pid).map(|app| app.0 != o.0).unwrap_or(true) {
                obj = None; // focus left that app without a new event
            }
        }
        if obj.is_none() {
            let app = a.app_for(front_pid?)?;
            let frame = a.active_frame(&app)?;
            obj = a.focused_in(&frame);
        }
        let o = obj?;
        {
            let c = self.focus.lock().unwrap();
            if let Some(c) = c.as_ref() {
                if c.key == (o.clone(), seq) && c.at.elapsed() < FOCUS_TTL && a.listening.load(Ordering::SeqCst) {
                    return Some(c.json.clone());
                }
            }
        }
        let json = a.element_json(&o)?;
        *self.focus.lock().unwrap() = Some(Cached { key: (o, seq), at: Instant::now(), json: json.clone() });
        Some(json)
    }

    // ---- front ----

    fn front(&self) -> String {
        if self.locked() {
            return "\"app\":{\"name\":\"lockscreen\",\"id\":\"lock\",\"pid\":0},\"window\":null,\"dialog\":null,\"windows\":0"
                .into();
        }
        let Some(xc) = self.x.as_ref() else { return "\"app\":null,\"window\":null".into() };
        let Some(w) = xc.active() else { return "\"app\":null,\"window\":null".into() };
        let pid = xc.pid(w).unwrap_or(0);
        let class = xc.class(w);
        let (id, comm) = if pid > 0 { (exe_of(pid), comm_of(pid)) } else { (String::new(), String::new()) };
        let name = if !class.is_empty() { class } else { comm };
        let mut s = String::with_capacity(256);
        s.push_str("\"app\":{\"name\":");
        push_str(&mut s, &name);
        s.push_str(",\"id\":");
        push_str(&mut s, &id);
        s.push_str(&format!(",\"pid\":{}}}", pid));
        let title = xc.title(w);
        match xc.bounds(w) {
            Some(r) => {
                s.push_str(",\"window\":{\"title\":");
                push_str(&mut s, &title);
                s.push_str(&format!(",\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}", r.x, r.y, r.w, r.h));
            }
            None => s.push_str(",\"window\":null"),
        }
        s.push_str(",\"dialog\":");
        s.push_str(&self.dialog(w, pid, &title));
        s.push_str(&format!(",\"windows\":{}", if pid > 0 { xc.windows_of(pid) } else { 1 }));
        s
    }

    /// `{title,text,buttons}` when the front window is a dialog by its hints, else null. Kept 3 s
    /// per window while no focus event comes.
    fn dialog(&self, w: u32, pid: u32, title: &str) -> String {
        let Some(xc) = self.x.as_ref() else { return "null".into() };
        if !xc.is_dialog(w) {
            return "null".into();
        }
        let a = self.a11y();
        let seq = a.as_ref().map(|a| a.focus_seq.load(Ordering::SeqCst)).unwrap_or(0);
        if let Some(c) = self.dialog.lock().unwrap().as_ref() {
            if c.key == (w, seq) && c.at.elapsed() < DIALOG_TTL {
                return c.json.clone();
            }
        }
        let frame = a.as_ref().and_then(|a| a.app_for(pid).and_then(|app| a.active_frame(&app)));
        let json = match (a, frame) {
            (Some(a), Some(f)) => a.dialog_json(&f, title),
            _ => {
                let mut s = String::from("{\"title\":");
                push_str(&mut s, title);
                s.push_str(",\"text\":\"\",\"buttons\":[]}");
                s
            }
        };
        *self.dialog.lock().unwrap() = Some(Cached { key: (w, seq), at: Instant::now(), json: json.clone() });
        json
    }

    // ---- tree ----

    /// Answered from a thread; a second tree while one runs answers empty and truncated.
    fn tree(self: &Arc<Self>, req: &Req) {
        let id = json::id_text(req);
        if self.tree_busy.swap(true, Ordering::SeqCst) {
            crate::emit(&format!("{{\"id\":{},\"nodes\":[],\"truncated\":true,\"ms\":0}}", id));
            return;
        }
        let max = json::num_of(req, "max").unwrap_or(1500.0).max(1.0) as usize;
        let depth = json::num_of(req, "depth").unwrap_or(25.0).max(1.0) as usize;
        let budget = Duration::from_millis(json::num_of(req, "budgetMs").unwrap_or(750.0).max(1.0) as u64);
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new().name("tree".into()).spawn(move || {
            let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.tree_json(&id, max, depth, budget)))
                .ok()
                .flatten()
                .unwrap_or_else(|| format!("{{\"id\":{},\"nodes\":null}}", id));
            crate::emit(&out);
            me.tree_busy.store(false, Ordering::SeqCst);
        });
        if spawned.is_err() {
            self.tree_busy.store(false, Ordering::SeqCst);
            crate::emit(&format!("{{\"id\":{},\"nodes\":null}}", json::id_text(req)));
        }
    }

    fn tree_json(&self, id: &str, max: usize, depth: usize, budget: Duration) -> Option<String> {
        let t = Instant::now();
        let empty = || Some(format!("{{\"id\":{},\"nodes\":[],\"truncated\":false,\"ms\":{}}}", id, t.elapsed().as_millis()));
        if self.locked() {
            return empty();
        }
        let xc = self.x.as_ref()?;
        let a = self.a11y()?;
        let Some(pid) = xc.active().and_then(|w| xc.pid(w)) else { return empty() };
        let Some(frame) = a.app_for(pid).and_then(|app| a.active_frame(&app)) else { return empty() };
        let (nodes, truncated, _) = a.tree_json(&frame, max, depth, budget.saturating_sub(t.elapsed()));
        Some(format!(
            "{{\"id\":{},\"nodes\":[{}],\"truncated\":{},\"ms\":{}}}",
            id,
            nodes,
            truncated,
            t.elapsed().as_millis()
        ))
    }

    // ---- lock, perm ----

    /// The screen locker is up: `GetActive` on GNOME's or freedesktop's screensaver (1 s cache).
    fn locked(&self) -> bool {
        if let Some((at, v)) = *self.lock.lock().unwrap() {
            if at.elapsed() < LOCK_TTL {
                return v;
            }
        }
        let v = self.session.as_ref().map(screensaver_active).unwrap_or(false);
        *self.lock.lock().unwrap() = Some((Instant::now(), v));
        v
    }

    fn perm(&self) -> String {
        let session = session_type();
        let wayland = session == "wayland";
        let atspi = self.a11y().is_some();
        let screen = self.x.as_ref().map(|x| x.can_read_screen()).unwrap_or(false);
        let record = self.x.as_ref().map(|x| x.has_extension("RECORD")).unwrap_or(false);
        let mut s = format!(
            "\"accessibility\":{},\"screen\":{},\"input\":{},\"session\":",
            atspi,
            screen && !wayland,
            record && !wayland
        );
        push_str(&mut s, &session);
        s.push_str(&format!(",\"atspi\":{},\"record\":{}", atspi, record));
        s
    }
}

fn screensaver_active(c: &Connection) -> bool {
    for (dest, path, iface) in [
        ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver"),
        ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver"),
        ("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver"),
    ] {
        if let Ok(m) = c.call_method(Some(dest), path, Some(iface), "GetActive", &()) {
            if let Ok(v) = m.body().deserialize::<bool>() {
                return v;
            }
        }
    }
    false
}

/// `x11`, `wayland`, `tty` or `""`: `XDG_SESSION_TYPE`, else Wayland when `WAYLAND_DISPLAY` is set.
pub fn session_type() -> String {
    session_type_of(std::env::var("XDG_SESSION_TYPE").ok(), std::env::var("WAYLAND_DISPLAY").ok(), std::env::var("DISPLAY").ok())
}

pub fn session_type_of(xdg: Option<String>, wayland: Option<String>, display: Option<String>) -> String {
    let set = |v: &Option<String>| v.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    match xdg.as_deref() {
        Some(t) if !t.is_empty() && t != "unspecified" => t.to_string(),
        _ if set(&wayland) => "wayland".into(),
        _ if set(&display) => "x11".into(),
        _ => String::new(),
    }
}

/// (ac, battery): ac from a `Mains` or `USB` supply's `online`, battery from a `Battery`'s
/// `capacity`. None when unknown.
pub fn read_power(dir: &str) -> (Option<bool>, Option<u32>) {
    let mut ac: Option<bool> = None;
    let mut bat: Option<u32> = None;
    let Ok(rd) = std::fs::read_dir(dir) else { return (None, None) };
    let read = |p: &std::path::Path, f: &str| std::fs::read_to_string(p.join(f)).map(|s| s.trim().to_string()).unwrap_or_default();
    for e in rd.flatten() {
        let p = e.path();
        match read(&p, "type").as_str() {
            "Mains" | "USB" => {
                if let Ok(v) = read(&p, "online").parse::<u32>() {
                    ac = Some(ac.unwrap_or(false) || v == 1);
                }
            }
            "Battery" => {
                if read(&p, "scope") == "Device" {
                    continue; // a mouse's battery
                }
                if let Ok(v) = read(&p, "capacity").parse::<u32>() {
                    bat = Some(bat.map(|b| b.min(v)).unwrap_or(v).min(100));
                }
            }
            _ => {}
        }
    }
    (ac, bat)
}

pub fn power_json(p: &(Option<bool>, Option<u32>)) -> String {
    format!(
        "\"ac\":{},\"battery\":{}",
        p.0.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
        p.1.map(|v| v.to_string()).unwrap_or_else(|| "null".into())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_types() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(session_type_of(s("x11"), None, s(":0")), "x11");
        assert_eq!(session_type_of(s("wayland"), s("wayland-0"), s(":0")), "wayland");
        assert_eq!(session_type_of(None, s("wayland-0"), s(":0")), "wayland");
        assert_eq!(session_type_of(s("unspecified"), None, s(":99")), "x11");
        assert_eq!(session_type_of(None, None, None), "");
    }

    #[test]
    fn power_from_sysfs() {
        let d = std::env::temp_dir().join(format!("autotrack-power-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mk = |n: &str, files: &[(&str, &str)]| {
            let p = d.join(n);
            std::fs::create_dir_all(&p).unwrap();
            for (f, v) in files {
                std::fs::write(p.join(f), format!("{}\n", v)).unwrap();
            }
        };
        assert_eq!(read_power(d.to_str().unwrap()), (None, None));
        mk("AC", &[("type", "Mains"), ("online", "0")]);
        mk("BAT0", &[("type", "Battery"), ("capacity", "57")]);
        mk("hidpp_battery_0", &[("type", "Battery"), ("scope", "Device"), ("capacity", "5")]);
        assert_eq!(read_power(d.to_str().unwrap()), (Some(false), Some(57)));
        mk("ucsi-source-psy", &[("type", "USB"), ("online", "1")]);
        assert_eq!(read_power(d.to_str().unwrap()), (Some(true), Some(57)));
        assert_eq!(power_json(&(Some(true), Some(57))), "\"ac\":true,\"battery\":57");
        assert_eq!(power_json(&(None, None)), "\"ac\":null,\"battery\":null");
        let _ = std::fs::remove_dir_all(&d);
    }
}
