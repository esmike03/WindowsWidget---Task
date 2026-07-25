# Sidenote

A small, always-available Windows desktop widget for **notes, tasks and scheduling**.
It docks flush against the side of your screen and collapses into a vertical tab —
like a tool window in Android Studio.

Built with Electron. Manrope throughout, light + dark, frosted-glass surfaces with
low-key gradient highlights.

---

## Run it

```bash
npm install
npm start
```

## Build a real installer

```bash
npm run dist
```

Produces an NSIS installer in `dist/`. Installing is recommended if you want the
widget to start with Windows reliably — see [Starting with Windows](#starting-with-windows).

---

## What it does

**Schedule** — events and meetings with a date and time. Grouped into
`Overdue / Today / Tomorrow / <weekday> / <date>`. The soonest upcoming item is marked
with a thin gradient rail on its edge.

**Notes** — tasks and notes. A time is optional; anything without one lands in `Anytime`.

**Completing** — click the circle. The title strikes through in place, then after a
beat the item retires to the **Archive** (or is deleted outright, if you prefer —
Settings → *On complete*). An **Undo** toast is offered for 5 seconds. Clicking the
circle again during the strike-through also undoes it.

**Archive** — restore or permanently delete anything you completed, or clear it all.

**Reminders** — a desktop notification fires when an event's time arrives.

**AI pane** — the ✦ button in the header (left of the monitor button) swaps the list
for an embedded browser with **ChatGPT** and **Claude** tabs. No address bar, no
search bar — just the site. The panel widens from 344px to 480px while it's open and
snaps back when you close it (`Esc` or the ✕).

- Both tabs share one persistent session, so you sign in once and stay signed in.
- Sign-in popups (Google, Apple, magic links) open in a normal window on that same
  session, so OAuth works.
- Tabs load lazily — nothing is fetched until you first open the pane, and neither
  site loads at login.
- The pane is restricted to those two origins; a webview can't be attached with any
  other partition or start URL.
- Auto-collapse is suppressed while the pane is open, so a sign-in popup taking focus
  can't hide the panel mid-login.

### Quick add

The composer parses dates out of what you type, so you rarely need the picker:

| You type | You get |
| --- | --- |
| `standup tomorrow 9:30am` | *standup* — tomorrow 09:30 |
| `sync with legal in 2h` | *sync with legal* — two hours from now |
| `budget review aug 12 at 3pm` | *budget review* — 12 Aug 15:00 |
| `call Dana friday 16:45` | *call Dana* — next Friday 16:45 |
| `pick up dry cleaning` | no time — filed under *Anytime* |

Also understood: `today`, `tonight`, `noon`, `midnight`, `in 30m`, `in 3d`,
`7/28`, `28 jul`, weekday names. The matched words are stripped from the title.

Use the calendar button for an explicit date/time, or to clear one.

---

## Docking, collapsing, monitors

- **Collapse** with the `›` button, `Esc`, or `Alt+Shift+N`. The panel animates down
  into a slim edge tab showing a badge with how many items are due today.
- **Expand** by clicking the tab, the tray icon, or `Alt+Shift+N`.
- **Move it** by dragging the header (or the tab itself). Release anywhere — it snaps
  flush to the nearest left/right edge of whichever monitor you dropped it on, keeping
  its vertical position.
- **Multi-monitor**: `Alt+Shift+M`, the monitor button in the header, or tray →
  *Move to next screen* cycles displays. The chosen monitor is remembered. If that
  monitor is later unplugged, the widget falls back to the primary display; plugging
  monitors in or changing resolution triggers an automatic re-dock.
- The panel height adapts to the display's work area, so it fits on short or
  high-DPI screens.

### Keyboard

| Key | Action |
| --- | --- |
| `Alt+Shift+N` | Toggle the panel (global) |
| `Alt+Shift+M` | Move to the next monitor (global) |
| `Ctrl+1` / `Ctrl+2` | Schedule / Notes |
| `/` | Jump to the composer |
| `Enter` | Add, or commit a rename |
| `Esc` | Close popover → close sheet → close AI pane → collapse |
| Double-click an item | Rename it |

---

## Starting with Windows

On by default. Toggle it in **Settings → Start with Windows** or from the tray menu.
It registers under `HKCU\...\CurrentVersion\Run` and launches with `--autostart`, which
starts the widget **collapsed** so it doesn't interrupt your login.

When run from source the registry entry points at `electron.exe` plus this project
folder, so it depends on the folder and `node_modules` staying put. Run `npm run dist`
and install the result for a self-contained entry.

---

## Where your data lives

```
%APPDATA%\Sidenote\data.json       notes, tasks and events
%APPDATA%\Sidenote\settings.json   preferences, dock position, chosen monitor
```

Both are plain JSON, written atomically (temp file + rename) so a sudden shutdown
can't truncate them. A file that fails to parse is set aside as `*.corrupt-<time>`
rather than being overwritten.

---

## A note on the glass

Windows will not blur the desktop behind a *transparent* Electron window, so the
frosted look here comes from near-opaque layered gradients, a lit top rim, a fine
grain texture and real blur between in-app layers. The panel is deliberately kept at
~96–99% opacity: any more transparency and whatever is behind it ghosts through the
text.

If you are on Windows 11 and want genuine desktop blur instead, add
`backgroundMaterial: 'acrylic'` to the `BrowserWindow` options in
`src/main/main.js` and set `transparent: false`. You will trade away the rounded
corners and the drop shadow, since acrylic fills the whole window rectangle — you'll
also want `GUTTER = 0` in `src/main/dock.js`.

---

## Layout

```
src/main/main.js     app lifecycle, window, tray, IPC, shortcuts, autostart
src/main/dock.js     edge geometry, collapse animation, drag-to-snap, monitors
src/main/store.js    atomic JSON persistence
src/preload.js       contextBridge API surface
src/renderer/        UI — index.html, styles.css, app.js
tools/make-icon.js   generates the app/tray icons from code (no image deps)
```

Set `SIDENOTE_DEBUG=1` before `npm start` to log display metrics, window bounds and
renderer console output to the terminal.
