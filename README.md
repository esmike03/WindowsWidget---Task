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

**Links** — a bookmark shelf grouped by category. Paste or type a URL and it is saved
under whatever category you give it; categories are just labels you invent, sorted
alphabetically with `Unsorted` last. Clicking a row opens it in your **real browser**,
never inside the widget. Each row gets a letter chip tinted from its hostname — a
stand-in for a favicon, since fetching real ones would mean a network request per row.

**Completing** — click the circle. The title strikes through in place, then after a
beat the item retires to the **Archive** (or is deleted outright, if you prefer —
Settings → *On complete*). An **Undo** toast is offered for 5 seconds. Clicking the
circle again during the strike-through also undoes it.

**Archive** — restore or permanently delete anything you completed, or clear it all.

**Reminders** — a desktop notification fires when an event's time arrives.

**Web pane** — the apps button in the header (left of the monitor button) swaps the
list for an embedded browser. No address bar, no search bar — just the site. The panel
widens from 344px to 520px while it's open and snaps back when you close it (`Esc` or
the ✕). Four tabs:

| Tab | What it is |
| --- | --- |
| 1–2 | **ChatGPT** and **Claude**, fixed |
| 3 | **Custom** — your label, your URL. Defaults to Gmail |
| 4 | **Mail** — pick from Outlook, Gmail, Yahoo, Proton, iCloud, Zoho, Fastmail, GMX or AOL |

Both configurable slots live in Settings → *Web pane tabs*. Changing one relabels the
tab and drops the old view, so the next visit loads the new address rather than the
previous tenant.

The ✦ button in the pane header opens the **Ask bar** — a floating, draggable field
that captures the screen you're looking at, sends it with your prompt to ChatGPT or
Claude, and shows the reply in place (truncated, with *Show more* and a copy button).
`Alt+Shift+A` summons it from anywhere, and it's in the tray menu too. Both Sidenote
windows hide themselves for the capture, so neither ends up in the screenshot.

- All four tabs share one persistent session, so you sign in once and stay signed in.
- Sign-in popups (Google, Apple, magic links) open in a normal window on that same
  session, so OAuth works.
- Tabs load lazily — nothing is fetched until you first open a tab, and no site
  loads at login.
- The pane is restricted to those four origins; a webview can't be attached with any
  other partition or start URL.
- Auto-collapse is suppressed while the pane is open, so a sign-in popup taking focus
  can't hide the panel mid-login.

#### Signing in

**"Sign in with Google" does not work inside the pane** — Google deliberately blocks
OAuth in embedded browser frameworks (an embedding app could read your keystrokes and
cookies), and returns *"This browser or app may not be secure."* That is a security
control, not a bug, and it is not something the app should try to defeat.

Two things that do work:

1. **Sign in with an email address instead.** ChatGPT (email + password) and Claude
   (email + a one-time code) both work in the pane, and the session persists.
2. **Use the ⧉ button** in the pane header. It opens the current site in a real
   Chrome or Edge window using `--app=`, which has no address bar and no tab strip —
   and since it's your normal browser profile, you are usually already signed in.
   Falls back to your default browser if neither is installed.

The pane shows a banner the moment it lands on a Google sign-in page, so the dead
end is not silent.

**Google mail is the harder case:** a Google account is its *only* way in, so option 1
doesn't exist there. A tab pointed at Google mail can display a session you already
have, but it can never start one — its banner says so and offers the pop-out directly
instead of sending you back to a form that can't help. The warning follows the *URL*,
not the tab name, so it appears on whichever slot you point at Google.

**Outlook** loads and renders normally in the pane. Microsoft's sign-in is not
blanket-blocked the way Google's is, but it is their call to make and it may refuse
in the same way at any time — the ⧉ button is the fallback there too. The tab opens
`outlook.live.com`; work and school accounts redirect on to `outlook.office.com` by
themselves.

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

### Saving links

In the **Links** tab the composer takes a URL plus anything else you want to say
about it. A `#tag` anywhere in the line sets the category:

| You type | You get |
| --- | --- |
| `figma.com/file/x moodboard #design` | *moodboard* — figma.com, filed under **Design** |
| `https://news.ycombinator.com` | *News* — no category, filed under **Unsorted** |
| `github.com/me/repo #work` | *repo* — filed under **Work** |
| `http://localhost:3000 dev server` | *dev server* — explicit schemes are taken as-is |

The scheme is optional (`https://` is assumed), and a bare hostname needs a real
TLD, so `v1.2 release notes` and `meeting at 3.30` are *not* mistaken for links —
if nothing usable is found the composer nudges instead of saving junk.

Leave the title out and the hostname is used (`figma.com` → *Figma*). Use the tag
button for a picker of categories you already have, or to type a new one; category
names match case-insensitively, so `reading` and `READING` stay one group.

Renaming a link (✎) also accepts a `#tag` to re-file it.

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
| `Alt+Shift+A` | Ask about this screen — floating bar (global) |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Schedule / Notes / Links |
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
%APPDATA%\Sidenote\data.json       notes, tasks, events and saved links
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
