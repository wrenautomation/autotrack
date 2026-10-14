#!/usr/bin/env python3
"""E2E fixtures for Linux (CI only), GTK 3 so AT-SPI sees them.

  linux-form.py note <file>        a text editor window titled "note.txt - Text Editor" with one
                                   text area; writes {"text": {x, y}} (screen center) to <file>
  linux-form.py form <file>        "autotrack e2e form": a Password label, a password entry
                                   (role "password text") and a Submit button; writes
                                   {"password": {x, y}, "submit": {x, y}} to <file>. Submit writes
                                   "<file>.done" and closes it.
  linux-form.py concealed <text>   puts <text> on the clipboard the way KeePassXC does
                                   (x-kde-passwordManagerHint beside UTF8_STRING), keeps it 20 s
"""
import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


def center(widget):
    """The widget's center in root (screen) coordinates."""
    top = widget.get_toplevel()
    alloc = widget.get_allocation()
    x, y = widget.translate_coordinates(top, alloc.width // 2, alloc.height // 2)
    _, ox, oy = top.get_window().get_origin()
    return {"x": ox + x, "y": oy + y}


def write_when_shown(win, out, widgets):
    def go():
        with open(out + ".tmp", "w") as f:
            json.dump({k: center(w) for k, w in widgets.items()}, f)
        os.replace(out + ".tmp", out)
        return False

    # After the window manager placed it.
    win.connect("map-event", lambda *_: GLib.timeout_add(700, go) and False)


def note(out):
    win = Gtk.Window(title="note.txt - Text Editor")
    win.set_default_size(520, 360)
    win.move(20, 20)
    view = Gtk.TextView()
    view.set_wrap_mode(Gtk.WrapMode.WORD)
    scroll = Gtk.ScrolledWindow()
    scroll.add(view)
    win.add(scroll)
    win.connect("destroy", Gtk.main_quit)
    write_when_shown(win, out, {"text": view})
    win.show_all()
    Gtk.main()


def form(out):
    win = Gtk.Window(title="autotrack e2e form")
    win.set_default_size(420, 160)
    screen = Gdk.Screen.get_default()
    win.move(screen.get_width() - 480, screen.get_height() - 260)
    win.set_keep_above(True)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    box.set_border_width(20)
    label = Gtk.Label(label="Password")
    label.set_xalign(0)
    entry = Gtk.Entry()
    entry.set_visibility(False)
    label.set_mnemonic_widget(entry)
    button = Gtk.Button(label="Submit")

    def submit(*_):
        with open(out + ".done", "w") as f:
            f.write("submitted\n")
        win.destroy()

    button.connect("clicked", submit)
    box.pack_start(label, False, False, 0)
    box.pack_start(entry, False, False, 0)
    box.pack_start(button, False, False, 0)
    win.add(box)
    win.connect("destroy", Gtk.main_quit)
    write_when_shown(win, out, {"password": entry, "submit": button})
    win.show_all()
    Gtk.main()


def concealed(text):
    targets = [
        Gtk.TargetEntry.new("UTF8_STRING", 0, 0),
        Gtk.TargetEntry.new("text/plain;charset=utf-8", 0, 1),
        Gtk.TargetEntry.new("x-kde-passwordManagerHint", 0, 2),
    ]
    data = text.encode()

    def get(sel, info):
        if info == 2:
            sel.set(Gdk.Atom.intern("x-kde-passwordManagerHint", False), 8, b"secret")
        else:
            sel.set(sel.get_target(), 8, data)

    # PyGObject has no set_with_data; a hidden widget owning the selection does the same.
    w = Gtk.Invisible()
    w.selection_add_targets(Gdk.SELECTION_CLIPBOARD, targets)
    w.connect("selection-get", lambda _w, sel, info, _t: get(sel, info))
    Gtk.selection_owner_set(w, Gdk.SELECTION_CLIPBOARD, Gdk.CURRENT_TIME)
    GLib.timeout_add_seconds(20, Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    mode, arg = sys.argv[1], sys.argv[2]
    {"note": note, "form": form, "concealed": concealed}[mode](arg)
