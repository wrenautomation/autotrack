//! X11 calls the probe makes: the active window, its pid, class, title and bounds, the window at a
//! point, dialogs. EWMH first (`_NET_*` on the root), plain X when no window manager sets them.
//! Coordinates are X pixels, which are autotrack's points on Linux.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt, GetPropertyReply, MapState, Window,
};
use x11rb::rust_connection::RustConnection;

x11rb::atom_manager! {
    pub Atoms: AtomsCookie {
        _NET_ACTIVE_WINDOW,
        _NET_WM_PID,
        _NET_WM_NAME,
        _NET_CLIENT_LIST,
        _NET_CLIENT_LIST_STACKING,
        _NET_FRAME_EXTENTS,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_DIALOG,
        _NET_WM_WINDOW_TYPE_NORMAL,
        _NET_WM_STATE,
        _NET_WM_STATE_MODAL,
        _NET_WM_STATE_SKIP_TASKBAR,
        WM_STATE,
        UTF8_STRING,
    }
}

pub struct X {
    pub conn: RustConnection,
    pub root: Window,
    pub atoms: Atoms,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// A client window's frame: the client's rect grown by `_NET_FRAME_EXTENTS` (left, right, top,
/// bottom), so the title bar counts, as on Windows and Mac.
pub fn with_extents(r: Rect, ext: Option<[u32; 4]>) -> Rect {
    match ext {
        Some([l, rt, t, b]) => Rect {
            x: r.x - l as i32,
            y: r.y - t as i32,
            w: r.w + l as i32 + rt as i32,
            h: r.h + t as i32 + b as i32,
        },
        None => r,
    }
}

/// `WM_CLASS` is "instance\0class\0": the class, else the instance.
pub fn class_of(raw: &[u8]) -> String {
    let parts: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
    let pick = parts.get(1).or_else(|| parts.first());
    pick.map(|p| String::from_utf8_lossy(p).into_owned()).unwrap_or_default()
}

impl X {
    pub fn open() -> Option<X> {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
        Some(X { conn, root, atoms })
    }

    fn prop(&self, w: Window, atom: u32, ty: impl Into<u32>, len: u32) -> Option<GetPropertyReply> {
        let r = self.conn.get_property(false, w, atom, ty, 0, len).ok()?.reply().ok()?;
        if r.format == 0 {
            None
        } else {
            Some(r)
        }
    }

    fn cardinals(&self, w: Window, atom: u32, ty: impl Into<u32>, len: u32) -> Vec<u32> {
        self.prop(w, atom, ty, len)
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }

    /// The focused top-level window: `_NET_ACTIVE_WINDOW`, else the input focus's client.
    pub fn active(&self) -> Option<Window> {
        let a = self.cardinals(self.root, self.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW, 1);
        if let Some(&w) = a.first() {
            if w != 0 {
                return Some(w);
            }
            return None; // a window manager that says nothing is focused
        }
        let f = self.conn.get_input_focus().ok()?.reply().ok()?.focus;
        if f <= 1 {
            return None; // None, PointerRoot
        }
        self.client_of(self.toplevel(f)?)
    }

    /// The child of the root that holds `w`.
    fn toplevel(&self, mut w: Window) -> Option<Window> {
        for _ in 0..32 {
            let t = self.conn.query_tree(w).ok()?.reply().ok()?;
            if t.parent == self.root || t.parent == 0 {
                return Some(w);
            }
            w = t.parent;
        }
        None
    }

    /// The window with `WM_STATE` at or under a top-level frame (a reparenting WM puts the client
    /// one or two levels down).
    fn client_of(&self, w: Window) -> Option<Window> {
        if self.prop(w, self.atoms.WM_STATE, AtomEnum::ANY, 1).is_some() {
            return Some(w);
        }
        let kids = self.conn.query_tree(w).ok()?.reply().ok()?.children;
        for k in kids.iter().rev() {
            if self.prop(*k, self.atoms.WM_STATE, AtomEnum::ANY, 1).is_some() {
                return Some(*k);
            }
            if let Ok(Ok(t)) = self.conn.query_tree(*k).map(|c| c.reply()) {
                for g in t.children.iter().rev() {
                    if self.prop(*g, self.atoms.WM_STATE, AtomEnum::ANY, 1).is_some() {
                        return Some(*g);
                    }
                }
            }
        }
        Some(w)
    }

    pub fn pid(&self, w: Window) -> Option<u32> {
        self.cardinals(w, self.atoms._NET_WM_PID, AtomEnum::CARDINAL, 1).first().copied().filter(|p| *p > 0)
    }

    pub fn class(&self, w: Window) -> String {
        self.prop(w, AtomEnum::WM_CLASS.into(), AtomEnum::STRING, 256)
            .map(|r| class_of(&r.value))
            .unwrap_or_default()
    }

    pub fn title(&self, w: Window) -> String {
        if let Some(r) = self.prop(w, self.atoms._NET_WM_NAME, self.atoms.UTF8_STRING, 1024) {
            return String::from_utf8_lossy(&r.value).into_owned();
        }
        self.prop(w, AtomEnum::WM_NAME.into(), AtomEnum::ANY, 1024)
            .map(|r| String::from_utf8_lossy(&r.value).into_owned())
            .unwrap_or_default()
    }

    /// The client rect in root coordinates, frame included.
    pub fn bounds(&self, w: Window) -> Option<Rect> {
        let g = self.conn.get_geometry(w).ok()?.reply().ok()?;
        let t = self.conn.translate_coordinates(w, self.root, 0, 0).ok()?.reply().ok()?;
        let r = Rect { x: t.dst_x as i32, y: t.dst_y as i32, w: g.width as i32, h: g.height as i32 };
        let e = self.cardinals(w, self.atoms._NET_FRAME_EXTENTS, AtomEnum::CARDINAL, 4);
        Some(with_extents(r, if e.len() == 4 { Some([e[0], e[1], e[2], e[3]]) } else { None }))
    }

    pub fn viewable(&self, w: Window) -> bool {
        self.conn
            .get_window_attributes(w)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|a| a.map_state == MapState::VIEWABLE)
            .unwrap_or(false)
    }

    /// A dialog by its hints: window type DIALOG or state MODAL.
    pub fn is_dialog(&self, w: Window) -> bool {
        let ty = self.cardinals(w, self.atoms._NET_WM_WINDOW_TYPE, AtomEnum::ATOM, 16);
        let st = self.cardinals(w, self.atoms._NET_WM_STATE, AtomEnum::ATOM, 32);
        ty.contains(&self.atoms._NET_WM_WINDOW_TYPE_DIALOG) || st.contains(&self.atoms._NET_WM_STATE_MODAL)
    }

    /// Client windows, bottom of the stack first.
    pub fn stacking(&self) -> Vec<Window> {
        let s = self.cardinals(self.root, self.atoms._NET_CLIENT_LIST_STACKING, AtomEnum::WINDOW, 4096);
        if !s.is_empty() {
            return s;
        }
        self.cardinals(self.root, self.atoms._NET_CLIENT_LIST, AtomEnum::WINDOW, 4096)
    }

    /// The topmost viewable client window holding the point.
    pub fn at(&self, x: i32, y: i32) -> Option<Window> {
        let stack = self.stacking();
        if !stack.is_empty() {
            return stack
                .iter()
                .rev()
                .copied()
                .find(|w| self.viewable(*w) && self.bounds(*w).map(|r| r.contains(x, y)).unwrap_or(false));
        }
        // No EWMH: the root's children in stacking order.
        let kids = self.conn.query_tree(self.root).ok()?.reply().ok()?.children;
        for k in kids.iter().rev() {
            if !self.viewable(*k) {
                continue;
            }
            let Some(g) = self.conn.get_geometry(*k).ok().and_then(|c| c.reply().ok()) else { continue };
            let r = Rect { x: g.x as i32, y: g.y as i32, w: g.width as i32, h: g.height as i32 };
            if r.contains(x, y) {
                return self.client_of(*k);
            }
        }
        None
    }

    /// Visible normal and dialog windows of a pid (the front app's open windows).
    pub fn windows_of(&self, pid: u32) -> usize {
        self.stacking()
            .into_iter()
            .filter(|w| self.pid(*w) == Some(pid))
            .filter(|w| {
                let st = self.cardinals(*w, self.atoms._NET_WM_STATE, AtomEnum::ATOM, 32);
                !st.contains(&self.atoms._NET_WM_STATE_SKIP_TASKBAR)
            })
            .count()
    }

    /// A 1x1 `GetImage` of the root works (it fails on a Wayland root without XWayland windows).
    pub fn can_read_screen(&self) -> bool {
        use x11rb::protocol::xproto::ImageFormat;
        self.conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, 0, 0, 1, 1, !0)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some()
    }

    pub fn has_extension(&self, name: &str) -> bool {
        self.conn
            .query_extension(name.as_bytes())
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.present)
            .unwrap_or(false)
    }
}

/// The exe path of a pid ("" when gone or not ours to read).
pub fn exe_of(pid: u32) -> String {
    std::fs::read_link(format!("/proc/{}/exe", pid))
        .map(|p| p.to_string_lossy().trim_end_matches(" (deleted)").to_string())
        .unwrap_or_default()
}

/// The pid's `comm` (15 characters at most).
pub fn comm_of(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{}/comm", pid)).map(|s| s.trim().to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_extents_grow_the_rect() {
        let r = Rect { x: 100, y: 80, w: 400, h: 300 };
        assert_eq!(with_extents(r, Some([2, 3, 30, 4])), Rect { x: 98, y: 50, w: 405, h: 334 });
        assert_eq!(with_extents(r, None), r);
        assert!(r.contains(100, 80) && !r.contains(500, 80) && r.contains(499, 379));
    }

    #[test]
    fn wm_class_takes_the_class() {
        assert_eq!(class_of(b"keepassxc\0KeePassXC\0"), "KeePassXC");
        assert_eq!(class_of(b"xterm\0"), "xterm");
        assert_eq!(class_of(b""), "");
    }
}
