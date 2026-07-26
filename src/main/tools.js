'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Tool launcher catalogue.

   The list of tools follows domodomo.site's categories; the default URL for
   each is a well-known public site that does that job, because the widget
   only opens a page — it does no processing itself. Every URL is a default
   only: `settings.toolUrls[id]` overrides it, so the user can point any tool
   at whatever service they prefer.
   ═══════════════════════════════════════════════════════════════════════ */

const TOOLS = [
  // ── Image ──────────────────────────────────────────────────────────
  { id: 'bg-remover', label: 'Background remover', cat: 'Image', url: 'https://www.remove.bg/upload' },
  { id: 'image-upscaler', label: 'Image upscaler', cat: 'Image', url: 'https://www.upscale.media/upload' },
  { id: 'image-resizer', label: 'Image resizer', cat: 'Image', url: 'https://www.iloveimg.com/resize-image' },
  { id: 'image-compressor', label: 'Image compressor', cat: 'Image', url: 'https://tinypng.com/' },
  { id: 'image-converter', label: 'Image converter', cat: 'Image', url: 'https://cloudconvert.com/image-converter' },
  { id: 'crop-rotate', label: 'Crop & rotate', cat: 'Image', url: 'https://www.iloveimg.com/crop-image' },
  { id: 'watermark', label: 'Watermark image', cat: 'Image', url: 'https://www.iloveimg.com/watermark-image' },
  { id: 'ai-enhancer', label: 'Photo enhancer', cat: 'Image', url: 'https://www.cutout.pro/photo-enhancer-sharpener' },
  { id: 'palette', label: 'Palette extractor', cat: 'Image', url: 'https://coolors.co/image-picker' },
  { id: 'collage', label: 'Collage maker', cat: 'Image', url: 'https://www.befunky.com/create/collage/' },
  { id: 'exif-viewer', label: 'EXIF viewer', cat: 'Image', url: 'https://exifdata.com/' },

  // ── PDF ────────────────────────────────────────────────────────────
  { id: 'pdf-merge', label: 'Merge PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/merge_pdf' },
  { id: 'pdf-split', label: 'Split PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/split_pdf' },
  { id: 'pdf-compress', label: 'Compress PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/compress_pdf' },
  { id: 'pdf-to-img', label: 'PDF to image', cat: 'PDF', url: 'https://www.ilovepdf.com/pdf_to_jpg' },
  { id: 'img-to-pdf', label: 'Image to PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/jpg_to_pdf' },
  { id: 'pdf-sign', label: 'Sign PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/sign_pdf' },
  { id: 'pdf-protect', label: 'Protect PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/protect_pdf' },
  { id: 'pdf-ocr', label: 'OCR PDF', cat: 'PDF', url: 'https://www.ilovepdf.com/ocr_pdf' },
  { id: 'pdf-edit', label: 'Edit PDF', cat: 'PDF', url: 'https://www.sejda.com/pdf-editor' },

  // ── Documents ──────────────────────────────────────────────────────
  { id: 'doc-converter', label: 'Document converter', cat: 'Documents', url: 'https://cloudconvert.com/document-converter' },
  { id: 'word-to-pdf', label: 'Word to PDF', cat: 'Documents', url: 'https://www.ilovepdf.com/word_to_pdf' },
  { id: 'ocr-scanner', label: 'OCR scanner', cat: 'Documents', url: 'https://www.onlineocr.net/' },
  { id: 'markdown', label: 'Markdown editor', cat: 'Documents', url: 'https://dillinger.io/' },
  { id: 'resume', label: 'Resume builder', cat: 'Documents', url: 'https://www.resume.com/' },
  { id: 'invoice', label: 'Invoice generator', cat: 'Documents', url: 'https://invoice-generator.com/' },
  { id: 'translator', label: 'Translator', cat: 'Documents', url: 'https://translate.google.com/' },
  { id: 'grammar', label: 'Grammar checker', cat: 'Documents', url: 'https://languagetool.org/' },

  // ── Media ──────────────────────────────────────────────────────────
  { id: 'video-convert', label: 'Video converter', cat: 'Media', url: 'https://cloudconvert.com/video-converter' },
  { id: 'video-compress', label: 'Video compressor', cat: 'Media', url: 'https://www.veed.io/tools/video-compressor' },
  { id: 'video-trim', label: 'Trim video', cat: 'Media', url: 'https://online-video-cutter.com/' },
  { id: 'extract-audio', label: 'Extract audio', cat: 'Media', url: 'https://cloudconvert.com/mp4-to-mp3' },
  { id: 'gif-maker', label: 'GIF maker', cat: 'Media', url: 'https://ezgif.com/video-to-gif' },
  { id: 'audio-convert', label: 'Audio converter', cat: 'Media', url: 'https://cloudconvert.com/audio-converter' },
  { id: 'audio-cutter', label: 'Audio cutter', cat: 'Media', url: 'https://mp3cut.net/' },
  { id: 'speech-to-text', label: 'Speech to text', cat: 'Media', url: 'https://speechnotes.co/' },

  // ── Codes ──────────────────────────────────────────────────────────
  { id: 'qr-generator', label: 'QR generator', cat: 'Codes', url: 'https://www.qr-code-generator.com/' },
  { id: 'qr-scanner', label: 'QR scanner', cat: 'Codes', url: 'https://webqr.com/' },
  { id: 'barcode-gen', label: 'Barcode generator', cat: 'Codes', url: 'https://barcode.tec-it.com/en' },

  // ── Developer ──────────────────────────────────────────────────────
  { id: 'json-format', label: 'JSON formatter', cat: 'Developer', url: 'https://jsonformatter.org/' },
  { id: 'diff-checker', label: 'Diff checker', cat: 'Developer', url: 'https://www.diffchecker.com/' },
  { id: 'regex-tester', label: 'Regex tester', cat: 'Developer', url: 'https://regex101.com/' },
  { id: 'jwt-decode', label: 'JWT decoder', cat: 'Developer', url: 'https://jwt.io/' },
  { id: 'base64-tool', label: 'Base64 encoder', cat: 'Developer', url: 'https://www.base64decode.org/' },
  { id: 'uuid-gen', label: 'UUID generator', cat: 'Developer', url: 'https://www.uuidgenerator.net/' },
  { id: 'hash-gen', label: 'Hash generator', cat: 'Developer', url: 'https://emn178.github.io/online-tools/sha256.html' },
  { id: 'cron-parser', label: 'Cron parser', cat: 'Developer', url: 'https://crontab.guru/' },
  { id: 'sql-formatter', label: 'SQL formatter', cat: 'Developer', url: 'https://sqlformat.org/' },
  { id: 'color-converter', label: 'Colour picker', cat: 'Developer', url: 'https://htmlcolorcodes.com/color-picker/' },
  { id: 'url-encoder', label: 'URL encoder', cat: 'Developer', url: 'https://www.urlencoder.org/' },
  { id: 'csv-json', label: 'CSV to JSON', cat: 'Developer', url: 'https://csvjson.com/csv2json' },
];

const byId = new Map(TOOLS.map((t) => [t.id, t]));

const isHttpUrl = (value) => {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

/** The catalogue with any user overrides applied. */
function resolveTools(overrides) {
  const map = overrides && typeof overrides === 'object' ? overrides : {};
  return TOOLS.map((t) => {
    const custom = isHttpUrl(map[t.id]) ? String(map[t.id]) : null;
    return { ...t, url: custom || t.url, custom: !!custom, defaultUrl: t.url };
  });
}

function resolveToolUrl(id, overrides) {
  const base = byId.get(id);
  if (!base) return null;
  const custom = overrides && overrides[id];
  return isHttpUrl(custom) ? String(custom) : base.url;
}

/** Origins a tool webview is allowed to attach to, defaults plus overrides. */
function toolOrigins(overrides) {
  const out = new Set();
  for (const t of resolveTools(overrides)) {
    try {
      out.add(new URL(t.url).origin);
    } catch (_) {
      /* skip anything unparseable */
    }
    try {
      out.add(new URL(t.defaultUrl).origin);
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

module.exports = { TOOLS, resolveTools, resolveToolUrl, toolOrigins, isHttpUrl };
