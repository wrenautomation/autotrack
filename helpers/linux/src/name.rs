//! The name rule: an element's name never shows its value. Same rule as the Windows helper's
//! `SafeName`, mapped to AT-SPI roles.

/// Roles whose name a toolkit may set to their text: a name showing it is dropped.
pub fn text_role(role: &str) -> bool {
    matches!(role, "text" | "entry" | "terminal" | "combo box" | "editbar" | "autocomplete")
}

/// Roles with a `Value` a name can show (a spin button named "42").
pub fn value_role(role: &str) -> bool {
    matches!(role, "spin button" | "slider" | "scroll bar" | "progress bar" | "dial" | "level bar")
}

/// Does `name` show `value`? Equal, holding a value of 3+ characters, or a 12+ character name
/// inside the value.
pub fn shows_value(name: &str, value: &str) -> bool {
    let n = name.trim();
    let v = value.trim();
    if n.is_empty() || v.is_empty() {
        return false;
    }
    n == v || (v.chars().count() >= 3 && n.contains(v)) || (n.chars().count() >= 12 && v.contains(n))
}

/// The name to send. `value` (the element's text or Value) is read only to compare, never sent;
/// `label` (its `LABELLED_BY` names) only when needed. A document takes only its label (Windows'
/// rule); a password field its label, else its name (its text is never read: it is masked anyway).
pub fn safe_name(
    role: &str,
    name: &str,
    value: impl FnOnce() -> Option<String>,
    label: impl FnOnce() -> String,
) -> String {
    if role.starts_with("document") {
        return label();
    }
    if role == "password text" {
        let l = label();
        return if l.is_empty() { name.to_string() } else { l };
    }
    if name.is_empty() || !(text_role(role) || value_role(role)) {
        return name.to_string();
    }
    let v = value().unwrap_or_default();
    if !shows_value(name, &v) {
        return name.to_string();
    }
    let l = label();
    if shows_value(&l, &v) {
        String::new()
    } else {
        l
    }
}

/// A number as a person reads it: no trailing ".0".
pub fn value_text(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_value_rule() {
        assert!(shows_value("hunter2", "hunter2"));
        assert!(shows_value("Volume 42%", "42%"));
        assert!(!shows_value("Volume 4", "4")); // a 1-2 character value is too common
        assert!(shows_value("a long sentence typed", "this is a long sentence typed in"));
        assert!(!shows_value("Short", "Shorter text"));
        assert!(!shows_value("", "x"));
        assert!(!shows_value("x", ""));
    }

    #[test]
    fn documents_and_password_fields() {
        assert_eq!(safe_name("document web", "Page", || panic!("never read"), String::new), "");
        assert_eq!(safe_name("document text", "Notes", || panic!("never read"), || "Body".into()), "Body");
        assert_eq!(safe_name("password text", "Password", || panic!("never read"), String::new), "Password");
        assert_eq!(safe_name("password text", "x", || panic!("never read"), || "PIN".into()), "PIN");
    }

    #[test]
    fn text_roles_drop_a_name_showing_their_text() {
        assert_eq!(safe_name("text", "hello world", || Some("hello world".into()), || "Note".into()), "Note");
        assert_eq!(safe_name("text", "hello world", || Some("hello world".into()), String::new), "");
        assert_eq!(safe_name("entry", "Email", || Some("me@example.com".into()), || panic!()), "Email");
        assert_eq!(safe_name("text", "", || panic!(), || panic!()), "");
    }

    #[test]
    fn value_roles_drop_a_name_showing_the_value() {
        assert_eq!(safe_name("spin button", "42", || Some("42".into()), || "Count".into()), "Count");
        assert_eq!(safe_name("spin button", "42", || Some("42".into()), || "42".into()), "");
        assert_eq!(safe_name("spin button", "Count", || Some("42".into()), || panic!()), "Count");
        assert_eq!(safe_name("push button", "Submit", || panic!(), || panic!()), "Submit");
    }

    #[test]
    fn value_text_reads_plainly() {
        assert_eq!(value_text(42.0), "42");
        assert_eq!(value_text(0.5), "0.5");
    }
}
