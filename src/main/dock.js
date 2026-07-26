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
const TAB_W = 30;
const TAB_H = 148;
const GUTTER = 22;

const ANIM_MS = 320;

const COLLAPSED_W = TAB_W + GUTTER;
const COLLAPSED_H = TAB_H + GUTTER * 2;

const easeInOutQuint = (t) =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function displaysByPosition() {
  return screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

function resolveDisplay(displayId) {
  const all = screen.getAllDisplays();
  const match = all.find((d) => String(d.id) === String(displayId));
  return match || screen.getPrimaryDisplay();
}

/** Panel height that actually fits on the given display. */
function panelHeightFor(display) {
  const usable = display.workArea.height - GUTTER * 2;
  return Math.round(clamp(PANEL_H, PANEL_MIN_H, Math.max(PANEL_MIN_H, usable)));
}

/** Panel width for the current mode, never wider than the display allows. */
function panelWidthFor(display, aiOpen) {
  if (!aiOpen) return PANEL_W;
  const usable = display.workArea.width - GUTTER - 40;
  return Math.round(clamp(PANEL_AI_W, PANEL_W, Math.max(PANEL_W, usable)));
}

/**
 * Window rect for a given state. Expanded and collapsed rects share the same
 * outer edge and the same vertical centre, so a straight lerp between them
 * reads as the panel sliding into / out of the edge tab.
 */
function boundsFor(display, { edge, anchor, collapsed, aiOpen }) {
  const wa = display.workArea;
  const panelH = panelHeightFor(display);

  const width = collapsed ? COLLAPSED_W : panelWidthFor(display, aiOpen) + GUTTER;
  const height = collapsed ? COLLAPSED_H : panelH + GUTTER * 2;

  const x = edge === 'left' ? wa.x : wa.x + wa.width - width;

  const centre = wa.y + clamp(anchor, 0, 1) * wa.height;
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
    return { edge: s.edge, anchor: s.anchor, collapsed: s.collapsed, aiOpen: s.aiOpen };
  }

  display() {
    return resolveDisplay(this.settings.get().displayId);
  }

  /** Geometry the renderer needs to size its fixed-width content layer. */
  metrics() {
    const s = this.settings.get();
    return {
      edge: s.edge,
      collapsed: s.collapsed,
      aiOpen: !!s.aiOpen,
      panelW: panelWidthFor(this.display(), s.aiOpen),
      panelH: panelHeightFor(this.display()),
      tabW: TAB_W,
      tabH: TAB_H,
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
    this.layout({ animate });
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
    if (edge !== 'left' && edge !== 'right') return;
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

    // Nearest vertical edge of whichever monitor we were dropped on.
    const edge = centreX - wa.x < wa.width / 2 ? 'left' : 'right';
    const anchor = clamp((centreY - wa.y) / wa.height, 0.05, 0.95);

    this.settings.set({ edge, anchor, displayId: String(display.id) });
    this.layout({ animate: true });
  }
}

module.exports = {
  Dock,
  PANEL_W,
  PANEL_AI_W,
  PANEL_H,
  TAB_W,
  TAB_H,
  GUTTER,
  COLLAPSED_W,
  COLLAPSED_H,
  ANIM_MS,
};
