'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Blur effect — a pre-blurred copy of the desktop wallpaper.

   Windows' own acrylic material falls back to flat grey whenever the window
   is not focused (most of the time for a side widget) and needs the GPU.
   Windows 11's Mica works from the wallpaper instead, and so does this: the
   wallpaper is cropped to the display the panel sits on, blurred once here
   by shrinking and re-enlarging it, and handed to the renderer as a small
   JPEG it lines up behind the panel. No live blur, so it stays cheap even
   without hardware acceleration.
   ═══════════════════════════════════════════════════════════════════════ */

const { nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TINY_W = 64; // shrink to this width: the shrink is what does the blurring
const OUT_W = 512; // then smooth back up; CSS stretches it to the display

function transcodedWallpaper() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper') : null;
}

/** The registry path is the source of truth; Windows' cached copy is the fallback. */
function wallpaperPath() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
      { windowsHide: true },
      (err, stdout) => {
        const m = !err && /WallPaper\s+REG_SZ\s+(.+)/i.exec(String(stdout));
        const fromReg = m && m[1].trim();
        const candidates = [fromReg, transcodedWallpaper()];
        resolve(candidates.find((p) => p && fs.existsSync(p)) || null);
      }
    );
  });
}

/** Crop to the display's aspect ratio, the way Windows' default "Fill" does. */
function coverCrop(img, aspect) {
  const { width, height } = img.getSize();
  if (!width || !height) return img;
  let w = width;
  let h = Math.round(width / aspect);
  if (h > height) {
    h = height;
    w = Math.round(height * aspect);
  }
  return img.crop({ x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h });
}

class Backdrop {
  constructor() {
    this.cache = new Map(); // `${file}|${mtime}|${aspect}` -> data URL
  }

  /**
   * `{ image, display }` for the given display, or null when there is no
   * usable wallpaper (solid colour background, missing file…).
   */
  async forDisplay(display) {
    const file = await wallpaperPath();
    if (!file) return null;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (_) {
      return null;
    }
    const { width, height, x, y } = display.bounds;
    const aspect = (width / height).toFixed(3);
    const key = `${file}|${mtime}|${aspect}`;

    let image = this.cache.get(key);
    if (!image) {
      let img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      img = coverCrop(img, width / height);
      const tiny = img.resize({ width: TINY_W, quality: 'good' });
      const out = tiny.resize({ width: OUT_W, quality: 'best' });
      image = `data:image/jpeg;base64,${out.toJPEG(82).toString('base64')}`;
      this.cache.clear(); // only the current wallpaper is worth keeping
      this.cache.set(key, image);
    }
    return { image, display: { x, y, width, height } };
  }
}

module.exports = { Backdrop };
