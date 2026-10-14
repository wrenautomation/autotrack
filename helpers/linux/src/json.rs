//! Flat JSON in (requests are one level deep), JSON text out. Output is ASCII: anything else is
//! `\uXXXX` (UTF-16, surrogate pairs above the BMP), the same bytes the Windows helper writes.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

pub type Req = HashMap<String, Val>;

/// A JSON string literal, ASCII only.
#[cfg(test)]
pub fn quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    push_str(&mut o, s);
    o
}

pub fn push_str(o: &mut String, s: &str) {
    o.push('"');
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 || (c as u32) >= 0x7f => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    o.push_str(&format!("\\u{:04x}", u));
                }
            }
            c => o.push(c),
        }
    }
    o.push('"');
}

/// A number the way the other helpers print it: integers bare, else up to `digits` decimals.
pub fn num(v: f64, digits: i32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let k = 10f64.powi(digits);
    let r = (v * k).round() / k;
    if r == r.trunc() && r.abs() < 1e15 {
        return format!("{}", r as i64);
    }
    let s = format!("{:.*}", digits as usize, r);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

pub fn id_text(req: &Req) -> String {
    match req.get("id") {
        Some(Val::Num(n)) => num(*n, 15),
        _ => "null".into(),
    }
}

pub fn str_of(req: &Req, key: &str) -> String {
    match req.get(key) {
        Some(Val::Str(s)) => s.clone(),
        Some(Val::Num(n)) => num(*n, 15),
        _ => String::new(),
    }
}

pub fn num_of(req: &Req, key: &str) -> Option<f64> {
    match req.get(key) {
        Some(Val::Num(n)) => Some(*n),
        _ => None,
    }
}

pub fn is_true(req: &Req, key: &str) -> bool {
    matches!(req.get(key), Some(Val::Bool(true)))
}

/// A flat JSON object of string, number, true, false and null values; None when it is not one.
pub fn parse(line: &str) -> Option<Req> {
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut map = HashMap::new();
    ws(&b, &mut i);
    if b.get(i) != Some(&'{') {
        return None;
    }
    i += 1;
    ws(&b, &mut i);
    if b.get(i) == Some(&'}') {
        return Some(map);
    }
    while i < b.len() {
        ws(&b, &mut i);
        let key = read_string(&b, &mut i)?;
        ws(&b, &mut i);
        if b.get(i) != Some(&':') {
            return None;
        }
        i += 1;
        ws(&b, &mut i);
        let c = *b.get(i)?;
        let val = if c == '"' {
            Val::Str(read_string(&b, &mut i)?)
        } else if starts(&b, i, "true") {
            i += 4;
            Val::Bool(true)
        } else if starts(&b, i, "false") {
            i += 5;
            Val::Bool(false)
        } else if starts(&b, i, "null") {
            i += 4;
            Val::Null
        } else {
            let start = i;
            while i < b.len() && "+-0123456789.eE".contains(b[i]) {
                i += 1;
            }
            if i == start {
                return None;
            }
            let s: String = b[start..i].iter().collect();
            Val::Num(s.parse().ok()?)
        };
        map.insert(key, val);
        ws(&b, &mut i);
        match b.get(i) {
            Some(',') => {
                i += 1;
            }
            Some('}') => return Some(map),
            _ => return None,
        }
    }
    None
}

fn starts(b: &[char], i: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    b.len() >= i + w.len() && b[i..i + w.len()] == w[..]
}

fn ws(b: &[char], i: &mut usize) {
    while *i < b.len() && b[*i].is_whitespace() {
        *i += 1;
    }
}

fn read_string(b: &[char], i: &mut usize) -> Option<String> {
    if b.get(*i) != Some(&'"') {
        return None;
    }
    *i += 1;
    let mut units: Vec<u16> = Vec::new();
    let mut out = String::new();
    let flush = |units: &mut Vec<u16>, out: &mut String| {
        if !units.is_empty() {
            out.push_str(&String::from_utf16_lossy(units));
            units.clear();
        }
    };
    while *i < b.len() {
        let c = b[*i];
        *i += 1;
        if c == '"' {
            flush(&mut units, &mut out);
            return Some(out);
        }
        if c != '\\' {
            flush(&mut units, &mut out);
            out.push(c);
            continue;
        }
        let e = *b.get(*i)?;
        *i += 1;
        if e == 'u' {
            if *i + 4 > b.len() {
                return None;
            }
            let hex: String = b[*i..*i + 4].iter().collect();
            units.push(u16::from_str_radix(&hex, 16).ok()?);
            *i += 4;
            continue;
        }
        flush(&mut units, &mut out);
        out.push(match e {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'b' => '\u{8}',
            'f' => '\u{c}',
            other => other,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flat_objects() {
        let r = parse(r#"{"id":7,"op":"at","x":-1.5,"y":2e2,"wait":null,"clipboard":true}"#).unwrap();
        assert_eq!(id_text(&r), "7");
        assert_eq!(str_of(&r, "op"), "at");
        assert_eq!(num_of(&r, "x"), Some(-1.5));
        assert_eq!(num_of(&r, "y"), Some(200.0));
        assert!(is_true(&r, "clipboard"));
        assert_eq!(r.get("wait"), Some(&Val::Null));
        assert!(parse("{}").unwrap().is_empty());
        assert!(parse("nope").is_none());
        assert!(parse(r#"{"a":1"#).is_none());
        assert!(parse(r#"{"a":}"#).is_none());
    }

    #[test]
    fn parses_escapes() {
        let r = parse(r#"{"p":"a\"b\\c\ndé😀/"}"#).unwrap();
        assert_eq!(str_of(&r, "p"), "a\"b\\c\nd\u{e9}\u{1f600}/");
    }

    #[test]
    fn quotes_as_ascii() {
        assert_eq!(quote("a\"b\\\n\t\u{1}é😀"), r#""a\"b\\\n\t\u0001\u00e9\ud83d\ude00""#);
    }

    #[test]
    fn numbers() {
        assert_eq!(num(1.0, 3), "1");
        assert_eq!(num(1.2346, 3), "1.235");
        assert_eq!(num(1.5, 3), "1.5");
        assert_eq!(num(-2.0, 2), "-2");
        assert_eq!(num(f64::NAN, 2), "0");
    }
}
