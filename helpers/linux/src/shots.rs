//! --shots: frames. Ops: displays, grab, save, crop, usage. See designs/2026-10-13-autotrack.md
//! "Shots protocol". A grab is an MIT-SHM `GetImage` of one RandR monitor (plain `GetImage` when
//! SHM is missing), box-filtered down to 1920 px at most on the long side into one of 4 RGB slots;
//! save writes a JPEG (path.tmp, then rename). On X11 points are pixels: `os.scale` is 1. A crop
//! is a plain `GetImage` of one rect at native pixels, no stretch.

use crate::json::{self, push_str, Req};
use crate::stage;
use std::time::Instant;
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, Window};
use x11rb::rust_connection::RustConnection;

pub const MAX_SIDE: u32 = 1920;
const RING: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub primary: bool,
}

#[derive(Default)]
struct Slot {
    rgb: Vec<u8>,
    w: u32,
    h: u32,
    seq: u64,
}

/// Byte offsets of red, green and blue in one pixel, and its size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pix {
    pub r: usize,
    pub g: usize,
    pub b: usize,
    pub bpp: usize,
}

impl Pix {
    /// From the root visual's masks: 8-bit channels only (24-bit depth in 32-bit pixels, every
    /// desktop today).
    pub fn of(red: u32, green: u32, blue: u32, bits_per_pixel: u8, lsb_first: bool) -> Option<Pix> {
        let bpp = bits_per_pixel as usize / 8;
        if bpp != 4 && bpp != 3 {
            return None;
        }
        let off = |m: u32| -> Option<usize> {
            if m.count_ones() != 8 || m.trailing_zeros() % 8 != 0 {
                return None;
            }
            let i = (m.trailing_zeros() / 8) as usize;
            Some(if lsb_first { i } else { bpp - 1 - i })
        };
        Some(Pix { r: off(red)?, g: off(green)?, b: off(blue)?, bpp })
    }
}

/// Frame size: the long side at most 1920, rounded half away from zero, at least 1.
pub fn fit_size(w: u32, h: u32) -> (u32, u32) {
    let k = (MAX_SIDE as f64 / w.max(h).max(1) as f64).min(1.0);
    let r = |v: u32| ((v as f64 * k).round() as u32).max(1);
    (r(w), r(h))
}

/// Box-filter a `pix` image (`stride` bytes a row) down to `fw` x `fh` RGB. Same size is a copy.
pub fn downscale(src: &[u8], w: u32, h: u32, stride: usize, pix: Pix, fw: u32, fh: u32, out: &mut Vec<u8>) {
    let (w, h, fw, fh) = (w as usize, h as usize, fw as usize, fh as usize);
    out.clear();
    out.resize(fw * fh * 3, 0);
    if fw == w && fh == h {
        for y in 0..h {
            let row = &src[y * stride..];
            let o = &mut out[y * w * 3..(y + 1) * w * 3];
            for x in 0..w {
                let p = &row[x * pix.bpp..];
                o[x * 3] = p[pix.r];
                o[x * 3 + 1] = p[pix.g];
                o[x * 3 + 2] = p[pix.b];
            }
        }
        return;
    }
    let xs: Vec<(usize, usize)> = (0..fw).map(|x| span(x, w, fw)).collect();
    let mut acc = vec![0u32; fw * 3];
    for fy in 0..fh {
        let (y0, y1) = span(fy, h, fh);
        acc.iter_mut().for_each(|a| *a = 0);
        for y in y0..y1 {
            let row = &src[y * stride..];
            for (fx, &(x0, x1)) in xs.iter().enumerate() {
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for x in x0..x1 {
                    let p = &row[x * pix.bpp..];
                    r += p[pix.r] as u32;
                    g += p[pix.g] as u32;
                    b += p[pix.b] as u32;
                }
                acc[fx * 3] += r;
                acc[fx * 3 + 1] += g;
                acc[fx * 3 + 2] += b;
            }
        }
        let o = &mut out[fy * fw * 3..(fy + 1) * fw * 3];
        for (fx, &(x0, x1)) in xs.iter().enumerate() {
            let n = ((x1 - x0) * (y1 - y0)) as u32;
            for c in 0..3 {
                o[fx * 3 + c] = ((acc[fx * 3 + c] + n / 2) / n) as u8;
            }
        }
    }
}

/// Source range [a, b) for output index `i` of `n` over `len` inputs; never empty.
fn span(i: usize, len: usize, n: usize) -> (usize, usize) {
    let a = i * len / n;
    let b = ((i + 1) * len / n).max(a + 1).min(len);
    (a.min(len - 1), b)
}

/// 64-bit hash of an RGB frame: top byte = mean luma of the top half, next = bottom half, low 48
/// bits = difference hash (is each cell darker than its right neighbour) over a 9x6 grid of cell
/// means, each cell 6x6 samples. Same as the Mac and Windows helpers.
pub fn frame_hash(rgb: &[u8], w: u32, h: u32) -> u64 {
    const COLS: usize = 9;
    const ROWS: usize = 6;
    const SUB: usize = 6;
    let (w, h) = (w as usize, h as usize);
    let mut cell = [0u32; COLS * ROWS];
    for gy in 0..ROWS {
        for gx in 0..COLS {
            let mut sum = 0u32;
            for sy in 0..SUB {
                let y = ((gy * SUB + sy) * 2 + 1) * h / (2 * ROWS * SUB);
                for sx in 0..SUB {
                    let x = ((gx * SUB + sx) * 2 + 1) * w / (2 * COLS * SUB);
                    let p = &rgb[(y * w + x) * 3..];
                    sum += (p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8;
                }
            }
            cell[gy * COLS + gx] = sum / (SUB * SUB) as u32;
        }
    }
    let mut bits = 0u64;
    for gy in 0..ROWS {
        for gx in 0..COLS - 1 {
            if cell[gy * COLS + gx] < cell[gy * COLS + gx + 1] {
                bits |= 1u64 << (gy * (COLS - 1) + gx);
            }
        }
    }
    let half = COLS * ROWS / 2;
    let top: u32 = cell[..half].iter().sum();
    let bottom: u32 = cell[half..].iter().sum();
    bits | ((bottom / half as u32) as u64) << 48 | ((top / half as u32) as u64) << 56
}

pub fn display_json(d: &Display) -> String {
    let (fw, _) = fit_size(d.w, d.h);
    let mut s = String::from("{\"id\":");
    push_str(&mut s, &d.id);
    s.push_str(&format!(
        ",\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"scale\":{},\"primary\":{},\"os\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"scale\":1}}}}",
        d.x,
        d.y,
        d.w,
        d.h,
        json::num(fw as f64 / d.w.max(1) as f64, 3),
        d.primary,
        d.x,
        d.y,
        d.w,
        d.h
    ));
    s
}

/// The rect inside the display, in its pixels: at least 1x1, at most the display.
pub fn clamp_rect(d: &Display, x: f64, y: f64, w: f64, h: f64) -> (i32, i32, u32, u32) {
    let w = (w.round() as i64).clamp(1, d.w as i64) as u32;
    let h = (h.round() as i64).clamp(1, d.h as i64) as u32;
    let x = (x.round() as i64).clamp(d.x as i64, d.x as i64 + d.w as i64 - w as i64) as i32;
    let y = (y.round() as i64).clamp(d.y as i64, d.y as i64 + d.h as i64 - h as i64) as i32;
    (x, y, w, h)
}

/// Encode to `path.tmp`, then rename onto `path`. Returns the size.
pub fn write_jpeg(path: &str, data: &[u8], w: u32, h: u32, color: jpeg_encoder::ColorType, q: u8) -> Result<u64, String> {
    if w > 65535 || h > 65535 {
        return Err("image too large".into());
    }
    let tmp = format!("{}.tmp", path);
    let r = (|| -> Result<(), String> {
        let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let enc = jpeg_encoder::Encoder::new(std::io::BufWriter::new(f), q);
        enc.encode(data, w as u16, h as u16, color).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// One SysV shared memory segment the X server writes into.
struct Shm {
    seg: u32,
    addr: *mut u8,
    size: usize,
}

struct Shots {
    conn: RustConnection,
    root: Window,
    pix: Option<Pix>,
    randr: bool,
    shm: Option<Shm>,
    shm_ok: bool,
    ring: Vec<Slot>,
    seq: u64,
}

pub fn run() -> i32 {
    let Ok((conn, screen)) = x11rb::connect(None) else {
        stage("no X display");
        return crate::serve(|req| {
            let op = json::str_of(req, "op");
            Some(match op.as_str() {
                "usage" => crate::usage(false),
                "displays" => "\"displays\":[]".into(),
                "save" | "crop" => "\"ok\":false,\"error\":\"no X display\"".into(),
                _ => "\"error\":\"no X display\"".into(),
            })
        });
    };
    let setup = conn.setup();
    let s = &setup.roots[screen];
    let root = s.root;
    let lsb = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let mut pix = None;
    for d in &s.allowed_depths {
        for v in &d.visuals {
            if v.visual_id == s.root_visual {
                let bpp = setup.pixmap_formats.iter().find(|f| f.depth == d.depth).map(|f| f.bits_per_pixel).unwrap_or(0);
                pix = Pix::of(v.red_mask, v.green_mask, v.blue_mask, bpp, lsb);
            }
        }
    }
    if pix.is_none() {
        stage("root visual is not 8-bit RGB: grabs fail");
    }
    let randr = conn.randr_get_monitors(root, true).ok().and_then(|c| c.reply().ok()).is_some();
    let shm_ok = conn.shm_query_version().ok().and_then(|c| c.reply().ok()).is_some();
    stage(&format!("X11 connected, RandR monitors {}, MIT-SHM {}", randr, shm_ok));
    let mut sh = Shots { conn, root, pix, randr, shm: None, shm_ok, ring: (0..RING).map(|_| Slot::default()).collect(), seq: 0 };
    stage("ready");
    crate::serve(move |req| Some(sh.handle(req)))
}

impl Shots {
    fn handle(&mut self, req: &Req) -> String {
        let op = json::str_of(req, "op");
        let r = match op.as_str() {
            "displays" => Ok(format!(
                "\"displays\":[{}]",
                self.displays().iter().map(display_json).collect::<Vec<_>>().join(",")
            )),
            "grab" => self.grab(req),
            "save" => self.save(req),
            "crop" => self.crop(req),
            "usage" => Ok(crate::usage(false)),
            _ => Ok("\"error\":\"unknown op\"".into()),
        };
        r.unwrap_or_else(|e| {
            let mut s = String::from(if op == "save" || op == "crop" { "\"ok\":false,\"error\":" } else { "\"error\":" });
            push_str(&mut s, &e);
            s
        })
    }

    fn displays(&self) -> Vec<Display> {
        let mut out = Vec::new();
        if self.randr {
            if let Some(m) = self.conn.randr_get_monitors(self.root, true).ok().and_then(|c| c.reply().ok()) {
                for mon in m.monitors {
                    if mon.width == 0 || mon.height == 0 {
                        continue;
                    }
                    out.push(Display {
                        id: mon.name.to_string(),
                        x: mon.x as i32,
                        y: mon.y as i32,
                        w: mon.width as u32,
                        h: mon.height as u32,
                        primary: mon.primary,
                    });
                }
            }
        }
        if out.is_empty() {
            if let Some(g) = self.conn.get_geometry(self.root).ok().and_then(|c| c.reply().ok()) {
                out.push(Display { id: "0".into(), x: 0, y: 0, w: g.width as u32, h: g.height as u32, primary: true });
            }
        }
        if !out.iter().any(|d| d.primary) {
            if let Some(d) = out.first_mut() {
                d.primary = true;
            }
        }
        out
    }

    fn find(&self, id: &str) -> Option<Display> {
        self.displays().into_iter().find(|d| d.id == id)
    }

    /// The rect's pixels and row stride: in the SHM segment (None, no copy), else a GetImage's.
    fn capture(&mut self, x: i32, y: i32, w: u32, h: u32, use_shm: bool) -> Result<(Option<Vec<u8>>, usize), String> {
        let pix = self.pix.ok_or("unsupported pixel format")?;
        if use_shm && self.shm_ok {
            let need = w as usize * h as usize * pix.bpp;
            match self.shm_grab(x, y, w, h, need) {
                Ok(()) => return Ok((None, w as usize * pix.bpp)),
                Err(e) => {
                    stage(&format!("MIT-SHM grab failed, using GetImage: {}", e));
                    self.shm_ok = false;
                    self.free_shm();
                }
            }
        }
        let r = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, x as i16, y as i16, w as u16, h as u16, !0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| format!("capture failed: {}", e))?;
        let stride = r.data.len() / h.max(1) as usize;
        if stride < w as usize * pix.bpp {
            return Err("capture failed: short image".into());
        }
        Ok((Some(r.data), stride))
    }

    /// The bytes `capture` left in the segment.
    fn shm_bytes(&self, len: usize) -> &'static [u8] {
        let shm = self.shm.as_ref().expect("segment");
        // SAFETY: the server finished writing before its reply came; the segment lives until
        // free_shm, which no caller reaches while holding this slice.
        unsafe { std::slice::from_raw_parts(shm.addr, len.min(shm.size)) }
    }

    fn shm_grab(&mut self, x: i32, y: i32, w: u32, h: u32, need: usize) -> Result<(), String> {
        if self.shm.as_ref().map(|s| s.size < need).unwrap_or(true) {
            self.free_shm();
            self.shm = Some(self.new_shm(need)?);
        }
        let seg = self.shm.as_ref().unwrap().seg;
        self.conn
            .shm_get_image(self.root, x as i16, y as i16, w as u16, h as u16, !0, ImageFormat::Z_PIXMAP.into(), seg, 0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn new_shm(&self, size: usize) -> Result<Shm, String> {
        // SAFETY: plain SysV calls; the id is removed once the server has attached, so it goes
        // away with the last detach even if this process dies.
        unsafe {
            let id = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600);
            if id < 0 {
                return Err("shmget failed".into());
            }
            let addr = libc::shmat(id, std::ptr::null(), 0);
            if addr as isize == -1 {
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                return Err("shmat failed".into());
            }
            let seg = self.conn.generate_id().map_err(|e| e.to_string())?;
            let attached = self.conn.shm_attach(seg, id as u32, false).map_err(|e| e.to_string()).and_then(|c| c.check().map_err(|e| e.to_string()));
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            if let Err(e) = attached {
                libc::shmdt(addr);
                return Err(e);
            }
            Ok(Shm { seg, addr: addr as *mut u8, size })
        }
    }

    fn free_shm(&mut self) {
        if let Some(s) = self.shm.take() {
            let _ = self.conn.shm_detach(s.seg);
            let _ = self.conn.flush();
            // SAFETY: addr came from shmat and is not used after this.
            unsafe { libc::shmdt(s.addr as *const libc::c_void) };
        }
    }

    fn grab(&mut self, req: &Req) -> Result<String, String> {
        let d = self.find(&json::str_of(req, "display")).ok_or("no such display")?;
        let (fw, fh) = fit_size(d.w, d.h);
        let t = Instant::now();
        let (owned, stride) = self.capture(d.x, d.y, d.w, d.h, true)?;
        let pix = self.pix.unwrap();
        let data: &[u8] = match &owned {
            Some(v) => v,
            None => self.shm_bytes(stride * d.h as usize),
        };
        self.seq += 1;
        let i = (self.seq % RING as u64) as usize;
        let slot = &mut self.ring[i];
        slot.seq = 0;
        downscale(data, d.w, d.h, stride, pix, fw, fh, &mut slot.rgb);
        slot.w = fw;
        slot.h = fh;
        slot.seq = self.seq;
        let hash = frame_hash(&slot.rgb, fw, fh);
        if t.elapsed().as_millis() > 500 {
            stage(&format!("slow grab: {} ms", t.elapsed().as_millis()));
        }
        Ok(format!("\"slot\":{},\"seq\":{},\"w\":{},\"h\":{},\"hash\":\"{:016x}\"", i, self.seq, fw, fh, hash))
    }

    fn save(&mut self, req: &Req) -> Result<String, String> {
        let path = json::str_of(req, "path");
        let n = json::num_of(req, "slot").ok_or("bad request")?;
        if path.is_empty() || n < 0.0 || n >= RING as f64 {
            return Err("bad request".into());
        }
        let s = &self.ring[n as usize];
        if s.rgb.is_empty() || s.seq == 0 {
            return Err("empty slot".into());
        }
        if let Some(seq) = json::num_of(req, "seq") {
            if seq as u64 != s.seq {
                return Err("slot reused".into());
            }
        }
        let q = json::num_of(req, "quality").unwrap_or(70.0).clamp(1.0, 100.0) as u8;
        let bytes = write_jpeg(&path, &s.rgb, s.w, s.h, jpeg_encoder::ColorType::Rgb, q)?;
        Ok(format!("\"ok\":true,\"bytes\":{}", bytes))
    }

    fn crop(&mut self, req: &Req) -> Result<String, String> {
        let d = self.find(&json::str_of(req, "display")).ok_or("no such display")?;
        let path = json::str_of(req, "path");
        let (Some(x), Some(y)) = (json::num_of(req, "x"), json::num_of(req, "y")) else { return Err("bad request".into()) };
        let w = json::num_of(req, "w").unwrap_or(0.0);
        let h = json::num_of(req, "h").unwrap_or(0.0);
        if path.is_empty() || w < 1.0 || h < 1.0 {
            return Err("bad request".into());
        }
        let (x, y, w, h) = clamp_rect(&d, x, y, w, h);
        let (data, stride) = self.capture(x, y, w, h, false)?;
        let data = data.ok_or("capture failed")?;
        let mut rgb = Vec::new();
        downscale(&data, w, h, stride, self.pix.unwrap(), w, h, &mut rgb);
        let q = json::num_of(req, "quality").unwrap_or(85.0).clamp(1.0, 100.0) as u8;
        let bytes = write_jpeg(&path, &rgb, w, h, jpeg_encoder::ColorType::Rgb, q)?;
        Ok(format!("\"ok\":true,\"bytes\":{},\"w\":{},\"h\":{}", bytes, w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BGRX: Pix = Pix { r: 2, g: 1, b: 0, bpp: 4 };

    #[test]
    fn pixel_layouts() {
        assert_eq!(Pix::of(0xff0000, 0xff00, 0xff, 32, true), Some(BGRX));
        assert_eq!(Pix::of(0xff0000, 0xff00, 0xff, 32, false), Some(Pix { r: 1, g: 2, b: 3, bpp: 4 }));
        assert_eq!(Pix::of(0xf800, 0x7e0, 0x1f, 16, true), None);
    }

    #[test]
    fn fit_rule() {
        assert_eq!(fit_size(1920, 1080), (1920, 1080));
        assert_eq!(fit_size(3840, 2160), (1920, 1080));
        assert_eq!(fit_size(2560, 1440), (1920, 1080));
        assert_eq!(fit_size(2880, 1800), (1920, 1200));
        assert_eq!(fit_size(1080, 2400), (864, 1920));
        assert_eq!(fit_size(5000, 1), (1920, 1));
        assert_eq!(fit_size(1280, 800), (1280, 800));
    }

    #[test]
    fn display_shape() {
        let d = Display { id: "533".into(), x: 1920, y: 0, w: 2560, h: 1440, primary: false };
        assert_eq!(
            display_json(&d),
            r#"{"id":"533","x":1920,"y":0,"width":2560,"height":1440,"scale":0.75,"primary":false,"os":{"x":1920,"y":0,"width":2560,"height":1440,"scale":1}}"#
        );
    }

    #[test]
    fn crops_stay_inside() {
        let d = Display { id: "0".into(), x: 100, y: 0, w: 800, h: 600, primary: true };
        assert_eq!(clamp_rect(&d, 0.0, -50.0, 200.0, 100.0), (100, 0, 200, 100));
        assert_eq!(clamp_rect(&d, 850.0, 590.0, 200.0, 100.0), (700, 500, 200, 100));
        assert_eq!(clamp_rect(&d, 0.0, 0.0, 5000.0, 0.4), (100, 0, 800, 1));
    }

    fn bgrx(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = f(x, y);
                v[(y * w + x) * 4..][..4].copy_from_slice(&[b, g, r, 0]);
            }
        }
        v
    }

    #[test]
    fn downscale_averages_boxes() {
        let src = bgrx(4, 2, |x, _| if x % 2 == 0 { [0, 100, 200] } else { [100, 200, 0] });
        let mut out = Vec::new();
        downscale(&src, 4, 2, 16, BGRX, 2, 1, &mut out);
        assert_eq!(out, vec![50, 150, 100, 50, 150, 100]);
        downscale(&src, 4, 2, 16, BGRX, 4, 2, &mut out);
        assert_eq!(&out[..6], &[0, 100, 200, 100, 200, 0]);
        // odd ratio: every source pixel lands in one box
        downscale(&bgrx(5, 3, |_, _| [9, 9, 9]), 5, 3, 20, BGRX, 2, 2, &mut out);
        assert_eq!(out, vec![9; 12]);
    }

    #[test]
    fn hash_matches_the_other_helpers() {
        let rgb = |w: usize, h: usize, f: &dyn Fn(usize, usize) -> u8| {
            let mut v = vec![0u8; w * h * 3];
            for y in 0..h {
                for x in 0..w {
                    let l = f(x, y);
                    v[(y * w + x) * 3..][..3].copy_from_slice(&[l, l, l]);
                }
            }
            v
        };
        // flat gray: no bits, both halves 0x80 (the luma weights sum to 256)
        assert_eq!(format!("{:016x}", frame_hash(&rgb(90, 60, &|_, _| 128), 90, 60)), "8080000000000000");
        // left to right ramp: every cell brighter than its left neighbour, all 48 bits
        let h = frame_hash(&rgb(180, 120, &|x, _| (x * 255 / 179) as u8), 180, 120);
        assert_eq!(h & 0xffff_ffff_ffff, 0xffff_ffff_ffff);
        assert_eq!(h >> 56, (h >> 48) & 0xff);
        // white top, black bottom
        let h = frame_hash(&rgb(90, 60, &|_, y| if y < 30 { 255 } else { 0 }), 90, 60);
        assert_eq!(format!("{:016x}", h), "ff00000000000000");
    }

    #[test]
    fn jpeg_written_atomically() {
        let p = std::env::temp_dir().join(format!("autotrack-shot-{}.jpg", std::process::id()));
        let p = p.to_str().unwrap();
        let n = write_jpeg(p, &vec![128u8; 64 * 32 * 3], 64, 32, jpeg_encoder::ColorType::Rgb, 70).unwrap();
        let b = std::fs::read(p).unwrap();
        assert_eq!(b.len() as u64, n);
        assert_eq!(&b[..2], &[0xff, 0xd8]);
        assert!(!std::path::Path::new(&format!("{}.tmp", p)).exists());
        assert!(write_jpeg("/nonexistent-dir/x.jpg", &[0; 3], 1, 1, jpeg_encoder::ColorType::Rgb, 70).is_err());
        let _ = std::fs::remove_file(p);
    }
}
