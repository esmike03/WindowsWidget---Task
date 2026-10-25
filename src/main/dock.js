'use strict';

const { screen } = require('electron');

// Panel geometry. GUTTER is empty, transparent space kept on the *inner* side
// (and top/bottom) so the CSS drop shadow has somewhere to render — the panel
// itself always sits flush against the screen edge.
const PANEL_W = 344;
// The web pane hosts real sites (chat and webmail), unusable at note-panel width.
// Mail clients are the denser of the two, so this is sized for them.
const PANEL_AI_W = 520;
const PANEL_H = 620;
const PANEL_MIN_H = 320;
// The collapsed edge tab, in three sizes the user picks between. It sits on top
// of every other window all day, so the default is deliberately slim — `large`
// is the size Sidenote shipped with before the setting existed.
const TAB_SIZES = {
  small: { w: 20, h: 72 },
  medium: { w: 24, h: 96 },
  large: { w: 30, h: 148 },
};
const DEFAULT_TAB_SIZE = 'medium';
const GUTTER = 22;

const ANIM_MS = 320;

// The smallest collapsed window any size can produce, so the BrowserWindow
// minimums never fight the layout — including at the top edge, where the tab
// lies on its side and the window is shorter than it is wide.
const COLLAPSED_MIN = TAB_SIZES.small.w + GUTTER;

const EDGES = ['left', 'right', 'top'];

const easeInOutQuint = (t) =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normalizeEdge = (edge) => (EDGES.includes(edge) ? edge : 'right');
const tabSizeFor = (name) =>
  Object.prototype.hasOwnProperty.call(TAB_SIZES, name)
    ? TAB_SIZES[name]
    : TAB_SIZES[DEFAULT_TAB_SIZE];

function displaysByPosition() {
  return screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

function resolveDisplay(displayId) {
  const all = screen.getAllDisplays();
  const match = all.find((d) => String(d.id) === String(displayId));
  return match || screen.getPrimaryDisplay();
}

/**
 * Panel height that actually fits on the given display. Docked to a side the
 * panel is centred and needs a gutter above *and* below; docked to the top it
 * is flush with the edge, so only the bottom gutter is spent.
 */
function panelHeightFor(display, edge) {
  const gutters = edge === 'top' ? GUTTER : GUTTER * 2;
  const usable = display.workArea.height - gutters;
  return Math.round(clamp(PANEL_H, PANEL_MIN_H, Math.max(PANEL_MIN_H, usable)));
}

/** Panel width for the current mode, never wider than the display allows. */
function panelWidthFor(display, aiOpen, edge) {
  if (!aiOpen) return PANEL_W;
  const reserve = edge === 'top' ? GUTTER * 2 + 40 : GUTTER + 40;
  const usable = display.workArea.width - reserve;
  return Math.round(clamp(PANEL_AI_W, PANEL_W, Math.max(PANEL_W, usable)));
}

/**
 * Window rect for a given state. Expanded and collapsed rects share the same
 * outer edge and the same centre *along* that edge, so a straight lerp between
 * them reads as the panel sliding into / out of the edge tab.
 *
 * `anchor` is always the position along the docked edge: vertical for the left
 * and right edges, horizontal for the top one.
 */
function boundsFor(display, { edge: rawEdge, anchor, collapsed, aiOpen, tabSize }) {
  const edge = normalizeEdge(rawEdge);
  const wa = display.workArea;
  const along = clamp(anchor, 0, 1);
  const panelW = panelWidthFor(display, aiOpen, edge);
  const panelH = panelHeightFor(display, edge);

  // Collapsed, the window is the tab plus a gutter on its inner side and both
  // ends: `deep` across the edge, `long` along it.
  const tab = tabSizeFor(tabSize);
  const deep = tab.w + GUTTER;
  const long = tab.h + GUTTER * 2;

  if (edge === 'top') {
    // The tab lies on its side up here: long horizontally, deep vertically.
    const width = collapsed ? long : panelW + GUTTER * 2;
    const height = collapsed ? deep : panelH + GUTTER;
    const centre = wa.x + along * wa.width;
    const x = Math.round(clamp(centre - width / 2, wa.x, wa.x + wa.width - width));
    return { x, y: Math.round(wa.y), width, height };
  }

  const width = collapsed ? deep : panelW + GUTTER;
  const height = collapsed ? long : panelH + GUTTER * 2;

  const x = edge === 'left' ? wa.x : wa.x + wa.width - width;
  const centre = wa.y + along * wa.height;
  const y = Math.round(clamp(centre - height / 2, wa.y, wa.y + wa.height - height));

  return { x: Math.round(x), y, width, height };
}

class Dock {
  constructor(win, settings) {
    this.win = win;
    this.settings = settings; // { get(), set(patch) }
    this._anim = null;
    this._drag = null;
  }

  get state() {
    const s = this.settings.get();
    return {
      edge: normalizeEdge(s.edge),
      anchor: s.anchor,
      collapsed: s.collapsed,
      aiOpen: s.aiOpen,
      tabSize: s.tabSize,
    };
  }

  /** Tray-only: collapsing means hiding the window, not showing an edge tab. */
  get trayOnly() {
    return this.settings.get().trayOnly === true;
  }

  display() {
    return resolveDisplay(this.settings.get().displayId);
  }

  /** Geometry the renderer needs to size its fixed-width content layer. */
  metrics() {
    const s = this.settings.get();
    const edge = normalizeEdge(s.edge);
    const tab = tabSizeFor(s.tabSize);
    return {
      edge,
      collapsed: s.collapsed,
      trayOnly: this.trayOnly,
      aiOpen: !!s.aiOpen,
      panelW: panelWidthFor(this.display(), s.aiOpen, edge),
      panelH: panelHeightFor(this.display(), edge),
      tabW: tab.w,
      tabH: tab.h,
      gutter: GUTTER,
      animMs: ANIM_MS,
      displayCount: screen.getAllDisplays().length,
    };
  }

  emit() {
    if (!this.win.isDestroyed()) this.win.webContents.send('dock:state', this.metrics());
  }

  /** Snap the window to the stored edge/anchor/display. */
  layout({ animate = false } = {}) {
    const target = boundsFor(this.display(), this.state);
    this.emit();
    if (animate) this._animateTo(target);
    else {
      this._stopAnim();
      this.win.setBounds(target);
    }
  }

  setCollapsed(collapsed, { animate = true } = {}) {
    if (this.settings.get().collapsed === collapsed) return;
    this.settings.set({ collapsed });

    // In tray-only mode there is no edge tab to slide into, so there is nothing
    // to animate — the window simply leaves the screen and comes back.
    if (this.trayOnly) {
      this._stopAnim();
      this.emit();
      if (this.win.isDestroyed()) return;
      if (collapsed) this.win.hide();
      else {
        this.win.setBounds(boundsFor(this.display(), this.state));
        this.win.show();
      }
      return;
    }

    this.layout({ animate });
  }

  /**
   * Re-apply visibility after the tray-only setting is flipped: switching it on
   * while collapsed must hide the tab that is already on screen, and switching
   * it off while hidden must bring that tab back.
   */
  syncTrayOnly() {
    if (this.win.isDestroyed()) return;
    this._stopAnim();
    if (this.trayOnly && this.settings.get().collapsed) {
      this.emit();
      this.win.hide();
      return;
    }
    this.layout({ animate: false });
    this.win.show();
  }

  toggle() {
    this.setCollapsed(!this.settings.get().collapsed);
  }

  /** Widen (or restore) the panel for the embedded AI browser. */
  setAiOpen(aiOpen) {
    if (!!this.settings.get().aiOpen === !!aiOpen) return;
    this.settings.set({ aiOpen: !!aiOpen });
    this.layout({ animate: true });
  }

  setEdge(edge) {
    if (!EDGES.includes(edge) || this.settings.get().edge === edge) return;
    this.settings.set({ edge });
    this.layout({ animate: true });
  }

  moveToDisplay(displayId) {
    this.settings.set({ displayId: String(displayId) });
    this.layout({ animate: false });
    this.emit();
  }

  /** Hop to the next monitor, keeping the same edge and vertical anchor. */
  cycleDisplay() {
    const all = displaysByPosition();
    if (all.length < 2) return;
    const current = this.display();
    const idx = all.findIndex((d) => d.id === current.id);
    const next = all[(idx + 1) % all.length];
    this.moveToDisplay(next.id);
  }

  // ---- animation ---------------------------------------------------------

  _stopAnim() {
    if (this._anim) {
      clearInterval(this._anim);
      this._anim = null;
    }
  }

  _animateTo(target, duration = ANIM_MS) {
    this._stopAnim();
    const from = this.win.getBounds();
    const start = Date.now();
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);

    const tick = () => {
      if (this.win.isDestroyed()) return this._stopAnim();
      const t = clamp((Date.now() - start) / duration, 0, 1);
      const e = easeInOutQuint(t);
      this.win.setBounds({
        x: lerp(from.x, target.x, e),
        y: lerp(from.y, target.y, e),
        width: lerp(from.width, target.width, e),
        height: lerp(from.height, target.height, e),
      });
      if (t >= 1) this._stopAnim();
    };
    this._anim = setInterval(tick, 16);
    tick();
  }

  // ---- dragging ----------------------------------------------------------

  /**
   * Custom drag loop. We follow the OS cursor ourselves rather than using
   * `-webkit-app-region: drag`, because we need the cursor's screen position on
   * release to decide which monitor and which edge to snap to.
   */
  beginDrag() {
    this.endDrag(false);
    const cursor = screen.getCursorScreenPoint();
    const b = this.win.getBounds();
    const off = { dx: cursor.x - b.x, dy: cursor.y - b.y };

    this._stopAnim();
    this._drag = setInterval(() => {
      if (this.win.isDestroyed()) return this.endDrag(false);
      const p = screen.getCursorScreenPoint();
      this.win.setPosition(p.x - off.dx, p.y - off.dy);
    }, 16);
  }

  endDrag(snap = true) {
    if (this._drag) {
      clearInterval(this._drag);
      this._drag = null;
    }
    if (!snap || this.win.isDestroyed()) return;

    const b = this.win.getBounds();
    const centreX = b.x + b.width / 2;
    const centreY = b.y + b.height / 2;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(centreX),
      y: Math.round(centreY),
    });
    const wa = display.workArea;

    // Nearest dockable edge of whichever monitor we were dropped on, measured
    // from the window's own rect rather than its centre — a tall panel dropped
    // at the top of the screen still has its centre halfway down.
    const gaps = {
      left: b.x - wa.x,
      right: wa.x + wa.width - (b.x + b.width),
      top: b.y - wa.y,
    };
    const edge = EDGES.reduce((best, e) => (gaps[e] < gaps[best] ? e : best), 'right');

    const along =
      edge === 'top' ? (centreX - wa.x) / wa.width : (centreY - wa.y) / wa.height;
    const anchor = clamp(along, 0.05, 0.95);

    this.settings.set({ edge, anchor, displayId: String(display.id) });
    this.layout({ animate: true });
  }
}

module.exports = {
  Dock,
  EDGES,
  TAB_SIZES,
  DEFAULT_TAB_SIZE,
  normalizeEdge,
  tabSizeFor,
  PANEL_W,
  PANEL_AI_W,
  PANEL_H,
  GUTTER,
  COLLAPSED_MIN,
  ANIM_MS,
};
