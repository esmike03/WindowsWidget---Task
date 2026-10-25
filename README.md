# Sidenote 1.5.0

A small, always-available Windows desktop widget for **notes, tasks and scheduling**.
It docks flush against the left, right, or top edge of your screen and collapses
into a small edge tab, or hides completely to the system tray.

Built with Electron. Manrope throughout, light + dark, frosted-glass surfaces with
low-key gradient highlights.

---

## Run it

```bash
npm install
npx install-electron
npm start
```

The locked Electron release provides a separate runtime installer; run
`install-electron` once after installing the project dependencies.

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

**Notes** — rich notes with a title, formatted text, colored highlights, checklists,
and embedded images. Paste or drop images into the editor, or use its image button.
Use **Save** or `Ctrl+S` to keep changes; `Ctrl+Z` undoes edits while the editor is open.
The list shows note previews and checklist progress.

**Tasks** — a separate list for to-dos. A time is optional; anything without one
lands in `Anytime`.

**Quick capture** — `Alt+Shift+C` opens a floating input bar without opening the
panel. Type a task or event and press Enter to save and close, or Shift+Enter to save
and keep adding. Dated text defaults to an event; undated text defaults to a task.
Use Tab or the task/event buttons to choose explicitly. The bar is also in the tray menu.

**Links** — a bookmark shelf grouped by category. Paste or type a URL and it is saved
under whatever category you give it; categories are just labels you invent, sorted
alphabetically with `Unsorted` last. Clicking a row opens it in your **real browser**,
never inside the widget. Each row gets a letter chip tinted from its hostname — a
stand-in for a favicon, since fetching real ones would mean a network request per row.

**Tools** — a searchable catalogue of web utilities for images, PDFs, documents,
media, codes and development. Star any tool to pin it under **Favorites**, change a
built-in tool's destination, or add your own named URL and category. User-added tools
can be edited or removed later.

**Completing** — click the circle. The title strikes through in place, then after a
beat the item retires to the **Archive** (or is deleted outright, if you prefer —
Settings → *On complete*). An **Undo** toast is offered for 5 seconds. Clicking the
circle again during the strike-through also undoes it.

**Archive** — restore or permanently delete anything you completed, or clear it all.

**Reminders** — desktop notifications for dated events and tasks, configurable to
arrive 10, 15, or 30 minutes early in Settings. Scheduling runs in the main process
so it does not depend on the panel's refresh timer.

**Web pane** — the apps button in the header (left of the monitor button) swaps the
list for an embedded browser. No address bar, no search bar — just the site. The panel
smoothly widens from 344px to 520px while it's open and eases back when you close it
(`Esc` or the ✕). Four tabs:

| Tab | What it is |
| --- | --- |
| 1–2 | **ChatGPT** and **Claude**, fixed |
| 3 | **Custom** — your label, your URL. Starts empty; configure it in Settings |
| 4 | **Mail** — pick from Outlook, Gmail, Yahoo, Proton, iCloud, Zoho, Fastmail, GMX or AOL |

Both configurable slots live in Settings → *Web pane tabs*. Changing one relabels the
tab and drops the old view, so the next visit loads the new address rather than the
previous tenant.

The ✦ button in the pane header opens the **Ask bar** — a floating, draggable field
that sends your prompt to ChatGPT or Claude and shows the complete reply in a
scrollable chat bubble with a copy button. The bubble automatically opens above
or below the compact input bar, whichever keeps it on-screen. Screen capture is
**off by default**; enable
Settings → *Include screen capture in Ask* to attach a full screenshot to each prompt.
`Alt+Shift+A` summons the bar from anywhere, and it's in the tray menu too. When
capture is enabled, both Sidenote windows hide themselves first, so neither ends up
in the screenshot.

- All four tabs share one persistent session, so you sign in once and stay signed in.
- Sign-in popups (Google, Apple, magic links) open in a normal window on that same
  session, so OAuth works.
- Tabs load lazily — nothing is fetched until you first open a tab, and no site
  loads at login.
- Inactive tabs and tool views are released after an idle delay. Persistent sign-in
  sessions remain available when the views are recreated. Hidden Ask windows are
  also released after an idle delay.
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

The Schedule and Tasks composers and the floating quick-capture bar share the
same date parser, so you rarely need the picker:

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
- **Tab size**: choose Small, Medium, or Large in Settings. Turn on **Hide to tray
  when collapsed** to hide the window completely instead of leaving an edge tab.
- **Expand** by clicking the tab, the tray icon, or `Alt+Shift+N`.
- **Drag into the panel**: hold supported text, links, or files over the collapsed
  tab to expand it. Images can then be dropped into an open note editor.
- **Move it** by dragging the header (or the tab itself). Release anywhere — it snaps
  flush to the nearest left, right, or top edge of whichever monitor you dropped it
  on, keeping its position along that edge.
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
| `Alt+Shift+C` | Quick-capture bar (global) |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` / `Ctrl+4` | Schedule / Notes / Tasks / Links |
| `Ctrl+S` / `Ctrl+Z` / `Ctrl+B` | Save / undo / bold in the note editor |
| `/` | Jump to the composer |
| `Enter` | Add, or commit a rename |
| `Shift+Enter` | Save and keep the quick-capture bar open |
| `Esc` | Close popover → close sheet → close AI pane → collapse |
| Double-click an item | Rename a task/event/link, or open the rich-note editor |

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
src/main/main.js     app lifecycle, window, tray, IPC, shortcuts, reminders, autostart
src/main/dock.js     edge geometry, collapse animation, drag-to-snap, monitors
src/main/store.js    atomic JSON persistence
src/main/ask.js      floating Ask bar and idle host lifecycle
src/main/capture.js  floating quick-capture window and persistence bridge
src/preload.js       contextBridge API surface
src/capture-preload.js quick-capture contextBridge API
src/renderer/        UI — index.html, styles.css, app.js
src/renderer/parse.js shared date parser for the panel and quick capture
src/renderer/capture-* quick-capture UI, styling, and event handling
tools/make-icon.js   generates the app/tray icons from code (no image deps)
```

Set `SIDENOTE_DEBUG=1` before `npm start` to log display metrics, window bounds and
renderer console output to the terminal.
