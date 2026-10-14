//! AT-SPI over D-Bus: elements at a point, the focused element, a frame's tree, a dialog's words.
//! Never sends an element's value (see name.rs). An accessible is (bus name, object path).

use crate::json::push_str;
use crate::name;
use crate::x::Rect;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::zvariant::{DynamicDeserialize, OwnedObjectPath, OwnedValue, Structure, Type};

pub type Obj = (String, OwnedObjectPath);

const ACC: &str = "org.a11y.atspi.Accessible";
const COMP: &str = "org.a11y.atspi.Component";
const PROPS: &str = "org.freedesktop.DBus.Properties";
const NULL_PATH: &str = "/org/a11y/atspi/null";
pub const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const REGISTRY: &str = "org.a11y.atspi.Registry";
/// Screen coordinates for Component calls.
const SCREEN: u32 = 0;

pub const ST_ACTIVE: u32 = 1;
pub const ST_FOCUSED: u32 = 12;
pub const ST_SHOWING: u32 = 25;
const REL_LABELLED_BY: u32 = 2;

const MAX_ANCESTORS: usize = 6;
const WALK_BUDGET: Duration = Duration::from_millis(30);
const NAME_MAX: usize = 200;
const TEXT_MAX: i32 = 4096;

pub fn has(states: u64, s: u32) -> bool {
    states & (1u64 << s) != 0
}

/// Roles whose subtree a tree skips through when unnamed (their children take their depth).
pub fn pass_through(role: &str) -> bool {
    matches!(
        role,
        "panel" | "filler" | "section" | "unknown" | "redundant object" | "scroll pane" | "viewport"
            | "layered pane" | "glass pane" | "root pane" | "image" | "label" | "static" | "grouping"
            | "invalid" | "paragraph"
    )
}

/// Roles a tree does not descend into.
pub fn leaf(role: &str) -> bool {
    matches!(role, "text" | "entry" | "password text" | "combo box" | "terminal" | "spin button" | "editbar")
}

/// Roles whose rect clips their children's.
fn clips(role: &str) -> bool {
    matches!(role, "panel" | "list" | "tree" | "scroll pane" | "viewport" | "table" | "tree table")
        || role.starts_with("document")
}

pub struct A11y {
    pub conn: Connection,
    pids: Mutex<HashMap<String, Option<u32>>>,
    focus: Mutex<Option<Obj>>,
    pub focus_seq: AtomicU64,
    pub listening: AtomicBool,
}

/// One accessible's own fields, read in four calls.
pub struct Info {
    pub role: String,
    pub name: String,
    pub desc: String,
    pub parent: Option<Obj>,
    pub ext: Option<Rect>,
    pub aid: String,
}

fn obj_of(o: Obj) -> Option<Obj> {
    if o.0.is_empty() || o.1.as_str() == NULL_PATH {
        None
    } else {
        Some(o)
    }
}

impl A11y {
    /// The accessibility bus. `enhance` sets `org.a11y.Status.IsEnabled` so toolkits that wait for
    /// a screen reader (Chromium, Electron, Qt) build their trees.
    pub fn open(enhance: bool) -> Option<Arc<A11y>> {
        let addr = match std::env::var("AT_SPI_BUS_ADDRESS") {
            Ok(a) if !a.is_empty() => a,
            _ => {
                let s = Connection::session().ok()?;
                if enhance {
                    let v = zbus::zvariant::Value::from(true);
                    let r = s.call_method(
                        Some("org.a11y.Bus"),
                        "/org/a11y/bus",
                        Some(PROPS),
                        "Set",
                        &("org.a11y.Status", "IsEnabled", v),
                    );
                    if let Err(e) = r {
                        crate::stage(&format!("IsEnabled not set: {}", e));
                    }
                }
                let m = s
                    .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
                    .ok()?;
                m.body().deserialize::<String>().ok()?
            }
        };
        let conn = zbus::blocking::connection::Builder::address(addr.as_str())
            .ok()?
            .method_timeout(Duration::from_millis(1500))
            .build()
            .ok()?;
        Some(Arc::new(A11y {
            conn,
            pids: Mutex::new(HashMap::new()),
            focus: Mutex::new(None),
            focus_seq: AtomicU64::new(0),
            listening: AtomicBool::new(false),
        }))
    }

    fn call<B, R>(&self, o: &Obj, iface: &str, method: &str, body: &B) -> Option<R>
    where
        B: serde::Serialize + Type,
        R: for<'d> DynamicDeserialize<'d>,
    {
        let m = self.conn.call_method(Some(o.0.as_str()), o.1.as_str(), Some(iface), method, body).ok()?;
        let b = m.body();
        b.deserialize::<R>().ok()
    }

    fn get(&self, o: &Obj, iface: &str, prop: &str) -> Option<OwnedValue> {
        self.call(o, PROPS, "Get", &(iface, prop))
    }

    pub fn props(&self, o: &Obj) -> HashMap<String, OwnedValue> {
        self.call(o, PROPS, "GetAll", &(ACC,)).unwrap_or_default()
    }

    pub fn role(&self, o: &Obj) -> String {
        self.call::<_, String>(o, ACC, "GetRoleName", &()).unwrap_or_default()
    }

    pub fn states(&self, o: &Obj) -> u64 {
        let v: Vec<u32> = self.call(o, ACC, "GetState", &()).unwrap_or_default();
        v.first().copied().unwrap_or(0) as u64 | (v.get(1).copied().unwrap_or(0) as u64) << 32
    }

    pub fn extents(&self, o: &Obj) -> Option<Rect> {
        let (x, y, w, h): (i32, i32, i32, i32) = self.call(o, COMP, "GetExtents", &(SCREEN,))?;
        Some(Rect { x, y, w, h })
    }

    pub fn children(&self, o: &Obj) -> Vec<Obj> {
        if let Some(v) = self.call::<_, Vec<Obj>>(o, ACC, "GetChildren", &()) {
            return v.into_iter().filter_map(obj_of).collect();
        }
        let n = self.get(o, ACC, "ChildCount").and_then(|v| i32::try_from(v).ok()).unwrap_or(0);
        (0..n.min(500))
            .filter_map(|i| self.call::<_, Obj>(o, ACC, "GetChildAtIndex", &(i,)).and_then(obj_of))
            .collect()
    }

    pub fn info(&self, o: &Obj) -> Info {
        let mut p = self.props(o);
        let take_str = |p: &mut HashMap<String, OwnedValue>, k: &str| {
            p.remove(k).and_then(|v| String::try_from(v).ok()).unwrap_or_default()
        };
        let name = take_str(&mut p, "Name");
        let desc = take_str(&mut p, "Description");
        let aid = take_str(&mut p, "AccessibleId");
        let parent = p.remove("Parent").and_then(|v| <(String, OwnedObjectPath)>::try_from(v).ok()).and_then(obj_of);
        let role = self.role(o);
        let ext = self.extents(o);
        Info { role, name, desc, parent, ext, aid }
    }

    fn name_of(&self, o: &Obj) -> String {
        self.get(o, ACC, "Name").and_then(|v| String::try_from(v).ok()).unwrap_or_default()
    }

    /// The names of its `LABELLED_BY` targets.
    pub fn label(&self, o: &Obj) -> String {
        let rels: Vec<(u32, Vec<Obj>)> = self.call(o, ACC, "GetRelationSet", &()).unwrap_or_default();
        let mut out: Vec<String> = Vec::new();
        for (ty, targets) in rels {
            if ty != REL_LABELLED_BY {
                continue;
            }
            for t in targets.into_iter().filter_map(obj_of).take(4) {
                let n = self.name_of(&t);
                if !n.trim().is_empty() {
                    out.push(n.trim().to_string());
                }
            }
        }
        out.join(" ")
    }

    /// The element's text (a text role) or Value (a value role), read only to compare to its name.
    fn value(&self, o: &Obj, role: &str) -> Option<String> {
        if name::value_role(role) {
            let v = self.get(o, "org.a11y.atspi.Value", "CurrentValue")?;
            return f64::try_from(v).ok().map(name::value_text);
        }
        let n = self.get(o, "org.a11y.atspi.Text", "CharacterCount").and_then(|v| i32::try_from(v).ok())?;
        self.call::<_, String>(o, "org.a11y.atspi.Text", "GetText", &(0i32, n.min(TEXT_MAX)))
    }

    pub fn safe_name(&self, o: &Obj, role: &str, raw: &str) -> String {
        let n = name::safe_name(role, raw, || self.value(o, role), || self.label(o));
        n.chars().take(NAME_MAX).collect()
    }

    fn attributes(&self, o: &Obj) -> HashMap<String, String> {
        self.call(o, ACC, "GetAttributes", &()).unwrap_or_default()
    }

    /// The registered apps.
    pub fn apps(&self) -> Vec<Obj> {
        let root: Obj = (REGISTRY.to_string(), OwnedObjectPath::try_from(ROOT_PATH).unwrap());
        self.children(&root)
    }

    /// The pid behind a bus name on the a11y bus (cached).
    fn pid_of(&self, bus: &str) -> Option<u32> {
        if let Some(p) = self.pids.lock().unwrap().get(bus) {
            return *p;
        }
        let p = self
            .conn
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetConnectionUnixProcessID",
                &(bus,),
            )
            .ok()
            .and_then(|m| m.body().deserialize::<u32>().ok());
        self.pids.lock().unwrap().insert(bus.to_string(), p);
        p
    }

    /// The app (its root accessible) whose connection belongs to `pid`.
    pub fn app_for(&self, pid: u32) -> Option<Obj> {
        let apps = self.apps();
        {
            let mut cache = self.pids.lock().unwrap();
            if cache.len() > 512 {
                cache.clear();
            }
        }
        apps.into_iter().find(|a| self.pid_of(&a.0) == Some(pid))
    }

    /// The app's top-level frame holding the point (the active one first).
    pub fn frame_at(&self, app: &Obj, x: i32, y: i32) -> Option<Obj> {
        let mut fallback = None;
        for f in self.children(app).into_iter().take(64) {
            let st = self.states(&f);
            if !has(st, ST_SHOWING) {
                continue;
            }
            if !self.extents(&f).map(|r| r.contains(x, y)).unwrap_or(false) {
                continue;
            }
            if has(st, ST_ACTIVE) {
                return Some(f);
            }
            if fallback.is_none() {
                fallback = Some(f);
            }
        }
        fallback
    }

    /// The app's active frame, else its first showing one.
    pub fn active_frame(&self, app: &Obj) -> Option<Obj> {
        let mut fallback = None;
        for f in self.children(app).into_iter().take(64) {
            let st = self.states(&f);
            if has(st, ST_ACTIVE) {
                return Some(f);
            }
            if fallback.is_none() && has(st, ST_SHOWING) {
                fallback = Some(f);
            }
        }
        fallback
    }

    /// The deepest accessible at a screen point under `from`.
    pub fn deepest_at(&self, from: &Obj, x: i32, y: i32) -> Obj {
        let mut cur = from.clone();
        for _ in 0..40 {
            let next = self.call::<_, Obj>(&cur, COMP, "GetAccessibleAtPoint", &(x, y, SCREEN)).and_then(obj_of);
            match next {
                Some(n) if n != cur => cur = n,
                _ => break,
            }
        }
        cur
    }

    /// `{role,name,x,y,width,height,secure,path?,id?,cls?,help?}`, or None when it has no role.
    pub fn element_json(&self, o: &Obj) -> Option<String> {
        let t = Instant::now();
        let i = self.info(o);
        if i.role.is_empty() {
            return None;
        }
        let r = i.ext.unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
        let mut s = String::with_capacity(256);
        s.push_str("{\"role\":");
        push_str(&mut s, &i.role);
        s.push_str(",\"name\":");
        push_str(&mut s, &self.safe_name(o, &i.role, &i.name));
        s.push_str(&format!(",\"x\":{},\"y\":{},\"width\":{},\"height\":{}", r.x, r.y, r.w, r.h));
        s.push_str(&format!(",\"secure\":{}", i.role == "password text"));
        self.push_path(&mut s, o, i.parent.clone(), t);
        let attrs = self.attributes(o);
        let id = attrs.get("id").cloned().filter(|v| !v.is_empty()).unwrap_or(i.aid);
        if !id.is_empty() {
            s.push_str(",\"id\":");
            push_str(&mut s, &id);
        }
        if let Some(c) = attrs.get("class").filter(|v| !v.is_empty()) {
            s.push_str(",\"cls\":");
            push_str(&mut s, c);
        }
        if !i.desc.is_empty() {
            s.push_str(",\"help\":");
            push_str(&mut s, &i.desc.chars().take(NAME_MAX).collect::<String>());
        }
        s.push('}');
        Some(s)
    }

    /// Ancestors nearest first, stopping before the top-level window (that is `front.window`).
    fn push_path(&self, s: &mut String, o: &Obj, mut parent: Option<Obj>, t: Instant) {
        let mut n = 0;
        while n < MAX_ANCESTORS && t.elapsed() < WALK_BUDGET {
            let Some(p) = parent.take() else { break };
            if p.1.as_str() == ROOT_PATH || p.0 != o.0 {
                break; // the app itself
            }
            let mut props = self.props(&p);
            let up = props
                .remove("Parent")
                .and_then(|v| <(String, OwnedObjectPath)>::try_from(v).ok())
                .and_then(obj_of);
            if up.as_ref().map(|u| u.1.as_str() == ROOT_PATH).unwrap_or(true) {
                break; // p is the window
            }
            let raw = props.remove("Name").and_then(|v| String::try_from(v).ok()).unwrap_or_default();
            let role = self.role(&p);
            s.push_str(if n == 0 { ",\"path\":[" } else { "," });
            s.push_str("{\"role\":");
            push_str(s, &role);
            s.push_str(",\"name\":");
            push_str(s, &self.safe_name(&p, &role, &raw));
            s.push('}');
            n += 1;
            parent = up;
        }
        if n > 0 {
            s.push(']');
        }
    }

    // ---- focus ----

    /// Listen for focus changes on a thread of its own. Returns at once.
    pub fn listen_focus(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("focus".into())
            .spawn(move || me.focus_loop())
            .ok();
    }

    fn register_event(&self, ev: &str) -> bool {
        let reg: Obj = (REGISTRY.to_string(), OwnedObjectPath::try_from("/org/a11y/atspi/registry").unwrap());
        let none: Vec<String> = Vec::new();
        let ok3 = self.conn.call_method(Some(reg.0.as_str()), reg.1.as_str(), Some(REGISTRY), "RegisterEvent", &(ev, &none, "")).is_ok();
        ok3 || self.conn.call_method(Some(reg.0.as_str()), reg.1.as_str(), Some(REGISTRY), "RegisterEvent", &(ev, &none)).is_ok()
            || self.conn.call_method(Some(reg.0.as_str()), reg.1.as_str(), Some(REGISTRY), "RegisterEvent", &(ev,)).is_ok()
    }

    fn focus_loop(&self) {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.a11y.atspi.Event.Object")
            .and_then(|b| b.member("StateChanged"))
            .and_then(|b| b.arg(0, "focused"))
            .map(|b| b.build());
        let Ok(rule) = rule else { return };
        let iter = match zbus::blocking::MessageIterator::for_match_rule(rule, &self.conn, Some(256)) {
            Ok(i) => i,
            Err(e) => {
                crate::stage(&format!("focus events: {}", e));
                return;
            }
        };
        if !self.register_event("object:state-changed:focused") {
            crate::stage("focus events: RegisterEvent failed; focus is found by a walk");
        }
        self.listening.store(true, Ordering::SeqCst);
        crate::stage("focus events on");
        for m in iter {
            let Ok(m) = m else { continue };
            let h = m.header();
            let (Some(sender), Some(path)) = (h.sender(), h.path()) else { continue };
            let gained = m
                .body()
                .deserialize::<Structure>()
                .ok()
                .map(|st| {
                    let f = st.fields();
                    let detail = f.first().and_then(|v| <&str>::try_from(v).ok()).unwrap_or("");
                    let d1 = f.get(1).and_then(|v| i32::try_from(v).ok()).unwrap_or(0);
                    detail == "focused" && d1 == 1
                })
                .unwrap_or(false);
            if !gained {
                continue;
            }
            let o: Obj = (sender.to_string(), OwnedObjectPath::from(path.to_owned()));
            *self.focus.lock().unwrap() = Some(o);
            self.focus_seq.fetch_add(1, Ordering::SeqCst);
        }
        self.listening.store(false, Ordering::SeqCst);
    }

    /// The last object a focus event named, while it still has `FOCUSED`.
    pub fn focused_from_events(&self) -> Option<Obj> {
        let o = self.focus.lock().unwrap().clone()?;
        if has(self.states(&o), ST_FOCUSED) {
            Some(o)
        } else {
            None
        }
    }

    /// The focused object under a frame: Collection first (one call, done in the app), else a
    /// bounded walk through showing nodes.
    pub fn focused_in(&self, frame: &Obj) -> Option<Obj> {
        let states: Vec<i32> = vec![1 << ST_FOCUSED, 0];
        let rule = (
            states,
            1i32,
            HashMap::<String, String>::new(),
            1i32,
            Vec::<i32>::new(),
            1i32,
            Vec::<String>::new(),
            1i32,
            false,
        );
        let found: Option<Vec<Obj>> =
            self.call(frame, "org.a11y.atspi.Collection", "GetMatches", &(rule, 1u32, 1i32, true));
        if let Some(v) = found {
            if let Some(o) = v.into_iter().filter_map(obj_of).next() {
                return Some(o);
            }
        }
        let t = Instant::now();
        let mut queue = std::collections::VecDeque::from([frame.clone()]);
        let mut seen = 0;
        while let Some(o) = queue.pop_front() {
            seen += 1;
            if seen > 3000 || t.elapsed() > Duration::from_millis(150) {
                return None;
            }
            let st = self.states(&o);
            if has(st, ST_FOCUSED) && o != *frame {
                return Some(o);
            }
            if o != *frame && !has(st, ST_SHOWING) {
                continue;
            }
            queue.extend(self.children(&o));
        }
        None
    }

    // ---- dialog ----

    /// `{title,text,buttons}` from a dialog frame: labels and buttons, 60 nodes, depth 4.
    pub fn dialog_json(&self, frame: &Obj, title: &str) -> String {
        let mut texts: Vec<String> = Vec::new();
        let mut buttons: Vec<String> = Vec::new();
        let mut seen = 0;
        self.dialog_walk(frame, 0, &mut texts, &mut buttons, &mut seen);
        let mut title = title.to_string();
        if title.is_empty() && !texts.is_empty() {
            title = texts.remove(0);
        }
        texts.retain(|t| *t != title);
        let mut s = String::from("{\"title\":");
        push_str(&mut s, &title);
        s.push_str(",\"text\":");
        push_str(&mut s, &texts.join("\n"));
        s.push_str(",\"buttons\":[");
        for (i, b) in buttons.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            push_str(&mut s, b);
        }
        s.push_str("]}");
        s
    }

    fn dialog_walk(&self, o: &Obj, depth: usize, texts: &mut Vec<String>, buttons: &mut Vec<String>, seen: &mut usize) {
        if depth >= 4 {
            return;
        }
        for k in self.children(o) {
            if *seen >= 60 {
                return;
            }
            *seen += 1;
            let role = self.role(&k);
            let n = self.name_of(&k);
            match role.as_str() {
                "label" | "static" => {
                    if !n.is_empty() {
                        texts.push(n)
                    }
                }
                "push button" | "toggle button" => {
                    if !n.is_empty() {
                        buttons.push(n)
                    }
                }
                r if name::text_role(r) || r == "password text" || r.starts_with("document") => {}
                _ => self.dialog_walk(&k, depth + 1, texts, buttons, seen),
            }
        }
    }

    // ---- tree ----

    /// The frame's tree: on-screen nodes, unnamed id-less containers skipped (children take their
    /// depth), text fields as leaves, `max` nodes, `depth` levels, `budget`.
    pub fn tree_json(&self, frame: &Obj, max: usize, depth: usize, budget: Duration) -> (String, bool, u128) {
        let mut w = Walk { sb: String::with_capacity(32768), count: 0, max, max_depth: depth, budget, truncated: false, t: Instant::now() };
        let clip = self.extents(frame).unwrap_or(Rect { x: -100000, y: -100000, w: 200000, h: 200000 });
        self.visit(&mut w, frame, 0, 0, clip);
        let ms = w.t.elapsed().as_millis();
        (w.sb, w.truncated, ms)
    }

    fn visit(&self, w: &mut Walk, o: &Obj, depth: usize, raw: usize, clip: Rect) {
        if w.truncated {
            return;
        }
        if w.count >= w.max || w.t.elapsed() > w.budget || raw > 60 {
            w.truncated = true;
            return;
        }
        let st = self.states(o);
        if !has(st, ST_SHOWING) {
            return;
        }
        let r = self.extents(o);
        let sized = r.map(|r| r.w > 0 && r.h > 0).unwrap_or(false);
        let r = r.unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
        if sized && intersect(r, clip).is_none() {
            return;
        }
        let mut props = self.props(o);
        let raw_name = props.remove("Name").and_then(|v| String::try_from(v).ok()).unwrap_or_default();
        let aid = props.remove("AccessibleId").and_then(|v| String::try_from(v).ok()).unwrap_or_default();
        let role = self.role(o);
        let nm = self.safe_name(o, &role, &raw_name);
        let skip = !sized || (nm.is_empty() && aid.is_empty() && pass_through(&role));
        let mut next = depth;
        if !skip {
            if depth >= w.max_depth {
                w.truncated = true;
                return;
            }
            let v = intersect(r, clip).unwrap_or(r);
            if w.count > 0 {
                w.sb.push(',');
            }
            w.sb.push_str("{\"role\":");
            push_str(&mut w.sb, &role);
            w.sb.push_str(",\"name\":");
            push_str(&mut w.sb, &nm);
            if !aid.is_empty() {
                w.sb.push_str(",\"id\":");
                push_str(&mut w.sb, &aid);
            }
            w.sb.push_str(&format!(",\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"depth\":{}", v.x, v.y, v.w, v.h, depth));
            if role == "password text" {
                w.sb.push_str(",\"secure\":true");
            }
            w.sb.push('}');
            w.count += 1;
            next = depth + 1;
        }
        if leaf(&role) {
            return;
        }
        let inner = if sized && clips(&role) { intersect(clip, r).unwrap_or(clip) } else { clip };
        for k in self.children(o) {
            if w.truncated {
                break;
            }
            self.visit(w, &k, next, raw + 1, inner);
        }
    }
}

struct Walk {
    sb: String,
    count: usize,
    max: usize,
    max_depth: usize,
    budget: Duration,
    truncated: bool,
    t: Instant,
}

pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.w).min(b.x + b.w);
    let y1 = (a.y + a.h).min(b.y + b.h);
    if x1 <= x0 || y1 <= y0 {
        None
    } else {
        Some(Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_bits() {
        let st = (1u64 << ST_FOCUSED) | (1u64 << ST_SHOWING);
        assert!(has(st, ST_FOCUSED) && has(st, ST_SHOWING) && !has(st, ST_ACTIVE));
    }

    #[test]
    fn rects_intersect() {
        let a = Rect { x: 0, y: 0, w: 100, h: 50 };
        assert_eq!(intersect(a, Rect { x: 50, y: 10, w: 100, h: 100 }), Some(Rect { x: 50, y: 10, w: 50, h: 40 }));
        assert_eq!(intersect(a, Rect { x: 100, y: 0, w: 10, h: 10 }), None);
    }

    #[test]
    fn roles() {
        assert!(leaf("password text") && leaf("entry") && !leaf("push button"));
        assert!(pass_through("filler") && !pass_through("push button"));
        assert!(clips("document web") && !clips("frame"));
    }

    #[test]
    fn null_refs_are_none() {
        let n: Obj = (":1.2".into(), OwnedObjectPath::try_from(NULL_PATH).unwrap());
        assert!(obj_of(n).is_none());
        let e: Obj = ("".into(), OwnedObjectPath::try_from("/a").unwrap());
        assert!(obj_of(e).is_none());
        let ok: Obj = (":1.2".into(), OwnedObjectPath::try_from("/a").unwrap());
        assert!(obj_of(ok).is_some());
    }
}
