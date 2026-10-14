//! The clipboard, once watched: XFixes tells a thread of its own when `CLIPBOARD` changes owner;
//! each change pushes `{"event":"clipboard","types":[…],"length":N,"concealed":bool,"text"?}`.
//! `types` is the owner's `TARGETS`. A copy marked by a password manager
//! (`x-kde-passwordManagerHint`, KeePassXC and KDE) is never read out.

use crate::json::push_str;
use crate::stage;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, Window, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

const TEXT_MAX: usize = 4096;
const TYPES_MAX: usize = 20;
const REPLY_WAIT: Duration = Duration::from_millis(500);

static STARTED: Mutex<bool> = Mutex::new(false);

pub fn watch() {
    let mut s = STARTED.lock().unwrap();
    if *s {
        return;
    }
    *s = true;
    std::thread::Builder::new().name("clipboard".into()).spawn(|| {
        if let Err(e) = run() {
            stage(&format!("clipboard watch stopped: {}", e));
        }
    }).ok();
}

/// A password manager's mark on its copies.
pub fn concealed(types: &[String]) -> bool {
    types.iter().any(|t| t.contains("passwordManagerHint"))
}

/// The pushed line. `text` is left out when concealed or absent.
pub fn event_json(types: &[String], length: usize, concealed: bool, text: Option<&str>) -> String {
    let mut o = String::from("{\"event\":\"clipboard\",\"types\":[");
    for (i, t) in types.iter().take(TYPES_MAX).enumerate() {
        if i > 0 {
            o.push(',');
        }
        push_str(&mut o, t);
    }
    o.push_str(&format!("],\"length\":{},\"concealed\":{}", length, concealed));
    if let (Some(t), false) = (text, concealed) {
        o.push_str(",\"text\":");
        let cut: String = t.chars().take(TEXT_MAX).collect();
        push_str(&mut o, &cut);
    }
    o.push('}');
    o
}

struct Clip {
    conn: RustConnection,
    win: Window,
    clipboard: Atom,
    targets: Atom,
    utf8: Atom,
    incr: Atom,
    prop: Atom,
    names: HashMap<Atom, String>,
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn run() -> Res<()> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    conn.xfixes_query_version(5, 0)?.reply()?;
    let win = conn.generate_id()?;
    conn.create_window(
        0,
        win,
        root,
        -10,
        -10,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new().override_redirect(1).event_mask(EventMask::PROPERTY_CHANGE),
    )?;
    let atom = |n: &str| -> Res<Atom> { Ok(conn.intern_atom(false, n.as_bytes())?.reply()?.atom) };
    let (clipboard, targets, utf8, incr, prop) =
        (atom("CLIPBOARD")?, atom("TARGETS")?, atom("UTF8_STRING")?, atom("INCR")?, atom("AUTOTRACK_CLIP")?);
    conn.xfixes_select_selection_input(
        win,
        clipboard,
        SelectionEventMask::SET_SELECTION_OWNER
            | SelectionEventMask::SELECTION_WINDOW_DESTROY
            | SelectionEventMask::SELECTION_CLIENT_CLOSE,
    )?;
    conn.flush()?;
    stage("clipboard watch on");
    let mut c = Clip { conn, win, clipboard, targets, utf8, incr, prop, names: HashMap::new() };
    loop {
        let ev = c.conn.wait_for_event()?;
        let Event::XfixesSelectionNotify(n) = ev else { continue };
        if n.owner == 0 || n.owner == c.win {
            continue;
        }
        match c.read(n.selection_timestamp) {
            Ok(Some(line)) => crate::emit(&line),
            Ok(None) => {}
            Err(e) => stage(&format!("clipboard read failed: {}", e)),
        }
    }
}

impl Clip {
    /// Ask the owner for `target` into our property; the reply's property value, or None when the
    /// owner refused or did not answer in 500 ms.
    fn convert(&mut self, target: Atom, time: u32) -> Res<Option<(Atom, Vec<u8>, u8)>> {
        self.conn.delete_property(self.win, self.prop)?;
        self.conn.convert_selection(self.win, self.clipboard, target, self.prop, time)?;
        self.conn.flush()?;
        let t = Instant::now();
        loop {
            while let Some(ev) = self.conn.poll_for_event()? {
                if let Event::SelectionNotify(s) = ev {
                    if s.requestor != self.win || s.target != target {
                        continue;
                    }
                    if s.property == 0 {
                        return Ok(None);
                    }
                    let r = self.conn.get_property(true, self.win, self.prop, AtomEnum::ANY, 0, 1 << 20)?.reply()?;
                    return Ok(Some((r.type_, r.value, r.format)));
                }
            }
            if t.elapsed() > REPLY_WAIT {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn name(&mut self, a: Atom) -> String {
        if let Some(n) = self.names.get(&a) {
            return n.clone();
        }
        let n = self
            .conn
            .get_atom_name(a)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.name).into_owned())
            .unwrap_or_else(|| format!("#{}", a));
        if self.names.len() < 4096 {
            self.names.insert(a, n.clone());
        }
        n
    }

    fn read(&mut self, time: u32) -> Res<Option<String>> {
        let Some((_, raw, format)) = self.convert(self.targets, time)? else {
            return Ok(Some(event_json(&[], 0, false, None)));
        };
        let atoms: Vec<Atom> = if format == 32 {
            raw.chunks_exact(4).map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]])).collect()
        } else {
            Vec::new()
        };
        let mut types = Vec::new();
        let mut all = Vec::new();
        for a in atoms.iter().copied() {
            let n = self.name(a);
            if matches!(n.as_str(), "TARGETS" | "MULTIPLE" | "TIMESTAMP" | "SAVE_TARGETS" | "DELETE") {
                continue;
            }
            all.push(n.clone());
            if types.len() < TYPES_MAX {
                types.push(n);
            }
        }
        let hidden = concealed(&all);
        let has_text = atoms.contains(&self.utf8);
        if hidden || !has_text {
            return Ok(Some(event_json(&types, 0, hidden, None)));
        }
        let Some((ty, val, _)) = self.convert(self.utf8, time)? else {
            return Ok(Some(event_json(&types, 0, false, None)));
        };
        if ty == self.incr {
            // Too big for one transfer: its size (a lower bound, in bytes) and no text.
            let n = val.get(0..4).map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0);
            self.conn.delete_property(self.win, self.prop)?;
            self.conn.flush()?;
            return Ok(Some(event_json(&types, n as usize, false, None)));
        }
        let text = String::from_utf8_lossy(&val).into_owned();
        let text = text.split('\0').next().unwrap_or("").to_string();
        let len = text.encode_utf16().count();
        Ok(Some(event_json(&types, len, false, Some(&text))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concealed_copies_never_carry_text() {
        let t = vec!["UTF8_STRING".to_string(), "x-kde-passwordManagerHint".to_string()];
        assert!(concealed(&t));
        assert_eq!(
            event_json(&t, 0, true, Some("hunter2")),
            r#"{"event":"clipboard","types":["UTF8_STRING","x-kde-passwordManagerHint"],"length":0,"concealed":true}"#
        );
        assert!(!concealed(&["text/plain".to_string()]));
    }

    #[test]
    fn text_is_capped() {
        let long = "a".repeat(5000);
        let j = event_json(&["UTF8_STRING".into()], 5000, false, Some(&long));
        assert!(j.contains("\"length\":5000"));
        let text = j.split("\"text\":\"").nth(1).unwrap().trim_end_matches("\"}");
        assert_eq!(text.len(), TEXT_MAX);
    }
}
