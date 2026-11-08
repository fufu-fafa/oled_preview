// Simulated display libraries. Drawing routines follow the published Adafruit_GFX and
// U8g2 algorithms so shapes land on the same pixels as on real hardware.
(function () {
  const OLED = (globalThis.OLED = globalThis.OLED || {});

  /* ---------- Glyph sources ---------- */

  function classicGlyph(code, advance) {
    const cols = OLED.fontColumns(code);
    return { w: 5, h: 8, xo: 0, yo: -7, adv: advance || 6, get: (i, j) => (cols[i] >> j) & 1 };
  }

  const rasterCache = new Map();
  let rasterCtx = null;
  function rasterGlyph(css, code) {
    const key = css + '|' + code;
    if (rasterCache.has(key)) return rasterCache.get(key);
    let glyph;
    if (typeof document === 'undefined') {
      glyph = classicGlyph(code);
    } else {
      if (!rasterCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 160;
        rasterCtx = c.getContext('2d', { willReadFrequently: true });
      }
      const ctx = rasterCtx, ox = 40, oy = 110;
      ctx.clearRect(0, 0, 160, 160);
      ctx.font = css;
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'alphabetic';
      const ch = String.fromCharCode(code);
      ctx.fillText(ch, ox, oy);
      const adv = Math.max(1, Math.round(ctx.measureText(ch).width));
      const data = ctx.getImageData(0, 0, 160, 160).data;
      let x0 = 160, y0 = 160, x1 = -1, y1 = -1;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
        if (data[(y * 160 + x) * 4 + 3] > 110) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      if (x1 < 0) glyph = { w: 0, h: 0, xo: 0, yo: 0, adv, get: () => 0 };
      else {
        const w = x1 - x0 + 1, h = y1 - y0 + 1, bits = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = data[((y + y0) * 160 + x + x0) * 4 + 3] > 110 ? 1 : 0;
        glyph = { w, h, xo: x0 - ox, yo: y0 - oy, adv, get: (i, j) => bits[j * w + i] };
      }
    }
    rasterCache.set(key, glyph);
    return glyph;
  }

  function gfxFontGlyph(font, code) {
    if (code < font.$first || code > font.$last) return null;
    const g = font.$glyph[code - font.$first];
    if (!g) return null;
    const view = OLED.R.view(font.$bitmap);
    const start = view.i + g.$bitmapOffset;
    return {
      w: g.$width, h: g.$height, xo: g.$xOffset, yo: g.$yOffset, adv: g.$xAdvance,
      get: (i, j) => {
        const bit = j * g.$width + i;
        return ((view.a[start + (bit >> 3)] || 0) >> (7 - (bit & 7))) & 1;
      },
    };
  }

  const FAMILIES = {
    helv: 'Helvetica, Arial, sans-serif', ncen: 'Georgia, "Times New Roman", serif', tim: '"Times New Roman", Times, serif',
    cour: '"Courier New", Courier, monospace', profont: 'Menlo, Consolas, monospace', inr: 'Menlo, Consolas, monospace', inb: 'Menlo, Consolas, monospace',
    fur: 'Arial, sans-serif', fub: 'Arial, sans-serif', logisoso: 'Arial, sans-serif', osb: 'Arial, sans-serif', osr: 'Arial, sans-serif',
  };

  function parseU8g2Font(name) {
    const fixed = /_(\d+)x(\d+)[a-zA-Z]*_/.exec(name);
    if (fixed) {
      const w = +fixed[1], h = +fixed[2];
      return { fixed: true, w, h, scale: Math.max(1, Math.round(h / 10)), ascent: Math.max(5, h - 2), descent: Math.min(2, h - 5) };
    }
    const m = /u8g2_font_([a-z]+?)([RBO]?)(\d+)/.exec(name);
    if (!m) return { fixed: true, w: 6, h: 10, scale: 1, ascent: 7, descent: 2, approx: true };
    const cap = +m[3];
    const weight = m[2] === 'B' || m[1] === 'fub' || m[1] === 'inb' || m[1] === 'osb' ? 'bold ' : '';
    const px = Math.round(cap / 0.72);
    return { css: `${weight}${px}px ${FAMILIES[m[1]] || 'Arial, sans-serif'}`, ascent: cap, descent: Math.round(cap * 0.28), approx: true };
  }

  function drawFreeFontSpec(name) {
    const m = /^Free(Sans|Serif|Mono)(Bold)?(Oblique|Italic)?(\d+)pt7b$/.exec(name);
    if (!m) return null;
    const family = { Sans: 'Helvetica, Arial, sans-serif', Serif: '"Times New Roman", serif', Mono: '"Courier New", monospace' }[m[1]];
    const px = Math.round((+m[4] * 141) / 72);
    return { css: `${m[3] ? 'italic ' : ''}${m[2] ? 'bold ' : ''}${px}px ${family}`, yAdvance: Math.round(px * 1.25) };
  }

  /* ---------- Shared panel ---------- */

  class Panel {
    constructor(R, w, h) {
      this.R = R;
      this.W = w; this.H = h;
      this.buf = new Uint8Array(w * h);
      this.front = new Uint8Array(w * h);
      this.rot = 0;
      this.inverted = false;
      this.dimmed = false;
      this.scroll = null;
      this.quad = null;
      this.flipV = false;
      R.addDevice(this);
    }
    get lw() { return this.rot & 1 ? this.H : this.W; }
    get lh() { return this.rot & 1 ? this.W : this.H; }
    px(x, y, c) {
      x |= 0; y |= 0;
      if (this.quad && !this.quad(x, y)) return;
      switch (this.rot) {
        case 1: { const t = x; x = this.W - 1 - y; y = t; break; }
        case 2: x = this.W - 1 - x; y = this.H - 1 - y; break;
        case 3: { const t = x; x = y; y = this.H - 1 - t; break; }
      }
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
      const i = y * this.W + x;
      if (c === 1) this.buf[i] = 1;
      else if (c === 0) this.buf[i] = 0;
      else if (c === 2) this.buf[i] ^= 1;
    }
    get(x, y) {
      x |= 0; y |= 0;
      switch (this.rot) {
        case 1: { const t = x; x = this.W - 1 - y; y = t; break; }
        case 2: x = this.W - 1 - x; y = this.H - 1 - y; break;
        case 3: { const t = x; x = y; y = this.H - 1 - t; break; }
      }
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return 0;
      return this.buf[y * this.W + x];
    }
    present() {
      this.R.drewNothing = false;
      this.front.set(this.buf);
      this.R.onPresent(this);
      return ((this.W * this.H) / 8) * 9 / 400; // Milliseconds to push the buffer over 400 kHz I2C.
    }
    clearBuf() { this.buf.fill(0); this.R.drawCalls++; }
    hline(x, y, w, c) { for (let i = 0; i < w; i++) this.px(x + i, y, c); }
    vline(x, y, h, c) { for (let i = 0; i < h; i++) this.px(x, y + i, c); }
    rect(x, y, w, h, c) {
      this.hline(x, y, w, c); this.hline(x, y + h - 1, w, c);
      this.vline(x, y, h, c); this.vline(x + w - 1, y, h, c);
    }
    fill(x, y, w, h, c) { for (let i = 0; i < w; i++) this.vline(x + i, y, h, c); }
    line(x0, y0, x1, y1, c) {
      const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
      if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
      if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const dx = x1 - x0, dy = Math.abs(y1 - y0), ystep = y0 < y1 ? 1 : -1;
      let err = dx >> 1;
      for (; x0 <= x1; x0++) {
        if (steep) this.px(y0, x0, c); else this.px(x0, y0, c);
        err -= dy;
        if (err < 0) { y0 += ystep; err += dx; }
      }
    }
    circle(x0, y0, r, c) {
      let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
      this.px(x0, y0 + r, c); this.px(x0, y0 - r, c); this.px(x0 + r, y0, c); this.px(x0 - r, y0, c);
      while (x < y) {
        if (f >= 0) { y--; ddy += 2; f += ddy; }
        x++; ddx += 2; f += ddx;
        this.px(x0 + x, y0 + y, c); this.px(x0 - x, y0 + y, c); this.px(x0 + x, y0 - y, c); this.px(x0 - x, y0 - y, c);
        this.px(x0 + y, y0 + x, c); this.px(x0 - y, y0 + x, c); this.px(x0 + y, y0 - x, c); this.px(x0 - y, y0 - x, c);
      }
    }
    circleCorner(x0, y0, r, corners, c) {
      let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
      while (x < y) {
        if (f >= 0) { y--; ddy += 2; f += ddy; }
        x++; ddx += 2; f += ddx;
        if (corners & 4) { this.px(x0 + x, y0 + y, c); this.px(x0 + y, y0 + x, c); }
        if (corners & 2) { this.px(x0 + x, y0 - y, c); this.px(x0 + y, y0 - x, c); }
        if (corners & 8) { this.px(x0 - y, y0 + x, c); this.px(x0 - x, y0 + y, c); }
        if (corners & 1) { this.px(x0 - y, y0 - x, c); this.px(x0 - x, y0 - y, c); }
      }
    }
    fillCorner(x0, y0, r, corners, delta, c) {
      let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r, px = x, py = y;
      delta++;
      while (x < y) {
        if (f >= 0) { y--; ddy += 2; f += ddy; }
        x++; ddx += 2; f += ddx;
        if (x < y + 1) {
          if (corners & 1) this.vline(x0 + x, y0 - y, 2 * y + delta, c);
          if (corners & 2) this.vline(x0 - x, y0 - y, 2 * y + delta, c);
        }
        if (y !== py) {
          if (corners & 1) this.vline(x0 + py, y0 - px, 2 * px + delta, c);
          if (corners & 2) this.vline(x0 - py, y0 - px, 2 * px + delta, c);
          py = y;
        }
        px = x;
      }
    }
    disc(x0, y0, r, c) { this.vline(x0, y0 - r, 2 * r + 1, c); this.fillCorner(x0, y0, r, 3, 0, c); }
    roundRect(x, y, w, h, r, c) {
      r = Math.min(r, (Math.min(w, h) / 2) | 0);
      this.hline(x + r, y, w - 2 * r, c); this.hline(x + r, y + h - 1, w - 2 * r, c);
      this.vline(x, y + r, h - 2 * r, c); this.vline(x + w - 1, y + r, h - 2 * r, c);
      this.circleCorner(x + r, y + r, r, 1, c); this.circleCorner(x + w - r - 1, y + r, r, 2, c);
      this.circleCorner(x + w - r - 1, y + h - r - 1, r, 4, c); this.circleCorner(x + r, y + h - r - 1, r, 8, c);
    }
    fillRound(x, y, w, h, r, c) {
      r = Math.min(r, (Math.min(w, h) / 2) | 0);
      this.fill(x + r, y, w - 2 * r, h, c);
      this.fillCorner(x + w - r - 1, y + r, r, 1, h - 2 * r - 1, c);
      this.fillCorner(x + r, y + r, r, 2, h - 2 * r - 1, c);
    }
    tri(x0, y0, x1, y1, x2, y2, c) { this.line(x0, y0, x1, y1, c); this.line(x1, y1, x2, y2, c); this.line(x2, y2, x0, y0, c); }
    fillTri(x0, y0, x1, y1, x2, y2, c) {
      if (y0 > y1) { [y0, y1] = [y1, y0]; [x0, x1] = [x1, x0]; }
      if (y1 > y2) { [y2, y1] = [y1, y2]; [x2, x1] = [x1, x2]; }
      if (y0 > y1) { [y0, y1] = [y1, y0]; [x0, x1] = [x1, x0]; }
      if (y0 === y2) {
        const a = Math.min(x0, x1, x2), b = Math.max(x0, x1, x2);
        this.hline(a, y0, b - a + 1, c);
        return;
      }
      const dx01 = x1 - x0, dy01 = y1 - y0, dx02 = x2 - x0, dy02 = y2 - y0, dx12 = x2 - x1, dy12 = y2 - y1;
      let sa = 0, sb = 0, y;
      const last = y1 === y2 ? y1 : y1 - 1;
      for (y = y0; y <= last; y++) {
        let a = x0 + Math.trunc(sa / dy01), b = x0 + Math.trunc(sb / dy02);
        sa += dx01; sb += dx02;
        if (a > b) [a, b] = [b, a];
        this.hline(a, y, b - a + 1, c);
      }
      sa = dx12 * (y - y1); sb = dx02 * (y - y0);
      for (; y <= y2; y++) {
        let a = x1 + Math.trunc(sa / dy12), b = x0 + Math.trunc(sb / dy02);
        sa += dx12; sb += dx02;
        if (a > b) [a, b] = [b, a];
        this.hline(a, y, b - a + 1, c);
      }
    }
    bitmapMSB(x, y, bmp, w, h, c, bg) {
      const v = OLED.R.view(bmp), bw = (w + 7) >> 3;
      let byte = 0;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (i & 7) byte = (byte << 1) & 255; else byte = v.a[v.i + j * bw + (i >> 3)] || 0;
        if (byte & 0x80) this.px(x + i, y + j, c);
        else if (bg !== undefined) this.px(x + i, y + j, bg);
      }
    }
    bitmapLSB(x, y, bmp, w, h, c, bg) {
      const v = OLED.R.view(bmp), bw = (w + 7) >> 3;
      let byte = 0;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (i & 7) byte >>= 1; else byte = v.a[v.i + j * bw + (i >> 3)] || 0;
        if (byte & 1) this.px(x + i, y + j, c);
        else if (bg !== undefined) this.px(x + i, y + j, bg);
      }
    }
    m_print(v, kind, opt) { this.text(OLED.R.fmt(v, kind, opt)); return 1; }
    m_println(v, kind, opt) { this.text((kind === 's' && v === '' ? '' : OLED.R.fmt(v, kind, opt)) + '\n'); return 1; }
    m_printf(fmt, ...args) { this.text(OLED.R.sprintf(fmt, args)); return 1; }
    text(s) { for (let i = 0; i < s.length; i++) this.writeCh(s.charCodeAt(i)); }
    m_write(v) {
      if (typeof v === 'number') this.writeCh(v & 255);
      else this.text(OLED.R.cstr(v));
      return 1;
    }
    m_begin() { return 1; }
  }

  /* ---------- Adafruit_GFX family ---------- */

  class AdafruitDisplay extends Panel {
    constructor(R, name, args) {
      let w = 128, h = 64;
      if (args.length >= 2 && args[0] > 0 && args[1] > 0 && args[0] <= 256 && args[1] <= 256) { w = args[0]; h = args[1]; }
      super(R, w, h);
      this.label = name;
      this.cx = 0; this.cy = 0;
      this.sx = 1; this.sy = 1;
      this.color = 0xffff; this.bg = 0xffff;
      this.wrap = true;
      this.cp437 = false;
      this.font = null;
      this.noColorWarned = false;
    }
    m_clearDisplay() { this.clearBuf(); }
    m_display() { return this.present(); }
    m_drawPixel(x, y, c) { this.R.drawCalls++; this.px(x, y, c); }
    m_getPixel(x, y) { return this.get(x, y); }
    m_writePixel(x, y, c) { this.px(x, y, c); }
    m_drawLine(a, b, c, d, col) { this.R.drawCalls++; this.line(a, b, c, d, col); }
    m_drawFastHLine(x, y, w, c) { this.R.drawCalls++; if (w < 0) { x += w + 1; w = -w; } this.hline(x, y, w, c); }
    m_drawFastVLine(x, y, h, c) { this.R.drawCalls++; if (h < 0) { y += h + 1; h = -h; } this.vline(x, y, h, c); }
    m_drawRect(x, y, w, h, c) { this.R.drawCalls++; this.rect(x, y, w, h, c); }
    m_fillRect(x, y, w, h, c) { this.R.drawCalls++; this.fill(x, y, w, h, c); }
    m_fillScreen(c) { this.R.drawCalls++; this.fill(0, 0, this.lw, this.lh, c); }
    m_drawCircle(x, y, r, c) { this.R.drawCalls++; this.circle(x, y, r, c); }
    m_fillCircle(x, y, r, c) { this.R.drawCalls++; this.disc(x, y, r, c); }
    m_drawCircleHelper(x, y, r, n, c) { this.R.drawCalls++; this.circleCorner(x, y, r, n, c); }
    m_fillCircleHelper(x, y, r, n, d, c) { this.R.drawCalls++; this.fillCorner(x, y, r, n, d, c); }
    m_drawRoundRect(x, y, w, h, r, c) { this.R.drawCalls++; this.roundRect(x, y, w, h, r, c); }
    m_fillRoundRect(x, y, w, h, r, c) { this.R.drawCalls++; this.fillRound(x, y, w, h, r, c); }
    m_drawTriangle(a, b, c, d, e, f, col) { this.R.drawCalls++; this.tri(a, b, c, d, e, f, col); }
    m_fillTriangle(a, b, c, d, e, f, col) { this.R.drawCalls++; this.fillTri(a, b, c, d, e, f, col); }
    m_drawBitmap(x, y, bmp, w, h, c, bg) { this.R.drawCalls++; this.bitmapMSB(x, y, bmp, w, h, c, bg); }
    m_drawXBitmap(x, y, bmp, w, h, c) { this.R.drawCalls++; this.bitmapLSB(x, y, bmp, w, h, c); }
    m_setCursor(x, y) { this.cx = x; this.cy = y; }
    m_getCursorX() { return this.cx; }
    m_getCursorY() { return this.cy; }
    m_setTextColor(c, bg) { this.color = c; this.bg = bg === undefined ? c : bg; }
    m_setTextSize(x, y) { this.sx = Math.max(1, x); this.sy = Math.max(1, y === undefined ? x : y); }
    m_setTextWrap(w) { this.wrap = !!w; }
    m_cp437(on) { this.cp437 = on === undefined ? true : !!on; }
    m_setRotation(r) { this.rot = r & 3; }
    m_getRotation() { return this.rot; }
    m_width() { return this.lw; }
    m_height() { return this.lh; }
    m_invertDisplay(i) { this.inverted = !!i; this.R.markDirty(); }
    m_dim(d) { this.dimmed = !!d; this.R.markDirty(); }
    m_setContrast(v) { this.dimmed = v < 64; this.R.markDirty(); }
    m_ssd1306_command() {}
    m_oled_command() {}
    m_oled_data() {}
    m_setFont(f) {
      if (!f) { this.font = null; return; }
      if (typeof f === 'string') {
        const spec = drawFreeFontSpec(f);
        this.font = spec ? { approx: spec } : null;
        this.R.note(`${f} is drawn with a similar system font, so text may be a few pixels off.`);
        return;
      }
      this.font = { gfx: f };
    }
    glyphFor(code) {
      if (this.font.gfx) return gfxFontGlyph(this.font.gfx, code);
      return rasterGlyph(this.font.approx.css, code);
    }
    get lineHeight() { return this.font.gfx ? this.font.gfx.$yAdvance : this.font.approx.yAdvance; }
    drawChar(x, y, code, c, bg, sx, sy) {
      if (x >= this.lw || y >= this.lh || x + 6 * sx - 1 < 0 || y + 8 * sy - 1 < 0) return;
      if (!this.cp437 && code >= 176) code++;
      const cols = OLED.fontColumns(code);
      for (let i = 0; i < 5; i++) {
        let line = cols[i];
        for (let j = 0; j < 8; j++, line >>= 1) {
          if (line & 1) { if (sx === 1 && sy === 1) this.px(x + i, y + j, c); else this.fill(x + i * sx, y + j * sy, sx, sy, c); }
          else if (bg !== c) { if (sx === 1 && sy === 1) this.px(x + i, y + j, bg); else this.fill(x + i * sx, y + j * sy, sx, sy, bg); }
        }
      }
      if (bg !== c) this.fill(x + 5 * sx, y, sx, 8 * sy, bg);
    }
    drawCustom(x, y, g, c, sx, sy) {
      for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
        if (!g.get(i, j)) continue;
        if (sx === 1 && sy === 1) this.px(x + g.xo + i, y + g.yo + j, c);
        else this.fill(x + (g.xo + i) * sx, y + (g.yo + j) * sy, sx, sy, c);
      }
    }
    writeCh(code) {
      this.R.drawCalls++;
      if (this.color > 2 && !this.noColorWarned) {
        this.noColorWarned = true;
        this.R.note('Text is invisible until the sketch calls setTextColor(), the same as on a real display.');
      }
      if (this.font) {
        if (code === 10) { this.cx = 0; this.cy += this.sy * this.lineHeight; return; }
        if (code === 13) return;
        const g = this.glyphFor(code);
        if (!g) return;
        if (g.w > 0 && g.h > 0) {
          if (this.wrap && this.cx + this.sx * (g.xo + g.w) > this.lw) { this.cx = 0; this.cy += this.sy * this.lineHeight; }
          this.drawCustom(this.cx, this.cy, g, this.color, this.sx, this.sy);
        }
        this.cx += g.adv * this.sx;
        return;
      }
      if (code === 10) { this.cx = 0; this.cy += this.sy * 8; return; }
      if (code === 13) return;
      if (this.wrap && this.cx + this.sx * 6 > this.lw) { this.cx = 0; this.cy += this.sy * 8; }
      this.drawChar(this.cx, this.cy, code, this.color, this.bg, this.sx, this.sy);
      this.cx += this.sx * 6;
    }
    m_drawChar(x, y, ch, c, bg, sx, sy) {
      this.R.drawCalls++;
      this.drawChar(x, y, ch & 255, c, bg === undefined ? c : bg, sx || 1, sy === undefined ? sx || 1 : sy);
    }
    m_getTextBounds(str, x, y, px1, py1, pw, ph) {
      const s = OLED.R.cstr(str);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, cx = x, cy = y;
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (this.font) {
          if (code === 10) { cx = 0; cy += this.sy * this.lineHeight; continue; }
          const g = this.glyphFor(code);
          if (!g) continue;
          if (g.w > 0 && g.h > 0) {
            minx = Math.min(minx, cx + g.xo * this.sx); maxx = Math.max(maxx, cx + (g.xo + g.w) * this.sx - 1);
            miny = Math.min(miny, cy + g.yo * this.sy); maxy = Math.max(maxy, cy + (g.yo + g.h) * this.sy - 1);
          }
          cx += g.adv * this.sx;
        } else {
          if (code === 10) { cx = 0; cy += this.sy * 8; continue; }
          if (code === 13) continue;
          if (this.wrap && cx + this.sx * 6 > this.lw) { cx = 0; cy += this.sy * 8; }
          minx = Math.min(minx, cx); maxx = Math.max(maxx, cx + this.sx * 6 - 1);
          miny = Math.min(miny, cy); maxy = Math.max(maxy, cy + this.sy * 8 - 1);
          cx += this.sx * 6;
        }
      }
      const R = OLED.R;
      if (maxx === -Infinity) { R.wr(px1, x); R.wr(py1, y); R.wr(pw, 0); R.wr(ph, 0); return; }
      R.wr(px1, minx); R.wr(py1, miny); R.wr(pw, maxx - minx + 1); R.wr(ph, maxy - miny + 1);
    }
    startScroll(dir, start, stop, diag) { this.scroll = { dir, start: start & 7, stop: stop & 7, diag, t0: this.R.now() }; this.R.markDirty(); }
    m_startscrollright(a, b) { this.startScroll(1, a, b, false); }
    m_startscrollleft(a, b) { this.startScroll(-1, a, b, false); }
    m_startscrolldiagright(a, b) { this.startScroll(1, a, b, true); }
    m_startscrolldiagleft(a, b) { this.startScroll(-1, a, b, true); }
    m_stopscroll() { this.scroll = null; this.R.markDirty(); }
  }
  AdafruitDisplay.YIELDS = new Set(['display']);

  /* ---------- U8g2 ---------- */

  class U8G2Display extends Panel {
    constructor(R, name, args) {
      const m = /_(\d+)X(\d+)/.exec(name);
      super(R, m ? +m[1] : 128, m ? +m[2] : 64);
      this.label = name;
      this.rot = (args[0] || 0) & 3;
      this.dc = 1;
      this.bitmapMode = 0;
      this.fontName = '';
      this.font = { fixed: true, w: 6, h: 10, scale: 1, ascent: 7, descent: 2 };
      this.pos = 'baseline';
      this.dir = 0;
      this.cx = 0; this.cy = 0;
    }
    glyph(code) {
      const f = this.font;
      if (f.fixed) {
        const base = classicGlyph(code, f.w);
        if (f.scale === 1) return base;
        const s = f.scale;
        return { w: 5 * s, h: 8 * s, xo: 0, yo: -7 * s, adv: f.w, get: (i, j) => base.get((i / s) | 0, (j / s) | 0) };
      }
      return rasterGlyph(f.css, code);
    }
    baselineOffset() {
      switch (this.pos) {
        case 'top': return this.font.ascent;
        case 'center': return (this.font.ascent / 2) | 0;
        case 'bottom': return -this.font.descent;
      }
      return 0;
    }
    plot(ox, oy, dx, dy) {
      switch (this.dir) {
        case 0: this.px(ox + dx, oy + dy, this.dc); break;
        case 1: this.px(ox - dy, oy + dx, this.dc); break;
        case 2: this.px(ox - dx, oy - dy, this.dc); break;
        case 3: this.px(ox + dy, oy - dx, this.dc); break;
      }
    }
    drawGlyphAt(x, y, code) {
      const g = this.glyph(code);
      for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.get(i, j)) this.plot(x, y, g.xo + i, g.yo + j);
      return g.adv;
    }
    drawText(x, y, s) {
      this.R.drawCalls++;
      const yb = this.baselineOffset();
      let ax = x, ay = y;
      if (this.dir === 0) ay += yb; else if (this.dir === 1) ax -= yb; else if (this.dir === 2) ay -= yb; else ax += yb;
      let total = 0;
      for (let i = 0; i < s.length; i++) {
        const adv = this.drawGlyphAt(ax, ay, s.charCodeAt(i));
        total += adv;
        if (this.dir === 0) ax += adv; else if (this.dir === 1) ay += adv; else if (this.dir === 2) ax -= adv; else ay -= adv;
      }
      return total;
    }
    writeCh(code) {
      if (code === 10 || code === 13) return;
      this.cx += this.drawText(this.cx, this.cy, String.fromCharCode(code));
    }
    m_initDisplay() {} m_setI2CAddress() {} m_setBusClock() {} m_enableUTF8Print() {} m_setPowerSave() {} m_setAutoPageClear() {}
    m_setFontRefHeightAll() {} m_setFontRefHeightText() {} m_setFontRefHeightExtendedText() {} m_setFontMode() {}
    m_clearBuffer() { this.clearBuf(); }
    m_clear() { this.clearBuf(); return this.present(); }
    m_clearDisplay() { this.clearBuf(); return this.present(); }
    m_sendBuffer() { return this.present(); }
    m_firstPage() { this.clearBuf(); }
    m_nextPage() { return this.present(); }
    m_home() { this.cx = 0; this.cy = 0; }
    m_setCursor(x, y) { this.cx = x; this.cy = y; }
    m_getCursorX() { return this.cx; }
    m_getCursorY() { return this.cy; }
    m_setDrawColor(c) { this.dc = c; }
    m_getDrawColor() { return this.dc; }
    m_setBitmapMode(m) { this.bitmapMode = m; }
    m_setContrast(v) { this.dimmed = v < 64; this.R.markDirty(); }
    m_setFlipMode(f) { this.rot = f ? 2 : 0; }
    m_setDisplayRotation(r) { this.rot = r & 3; }
    m_getDisplayWidth() { return this.lw; }
    m_getDisplayHeight() { return this.lh; }
    m_getWidth() { return this.lw; }
    m_getHeight() { return this.lh; }
    m_setFont(name) {
      if (typeof name !== 'string') return;
      this.fontName = name;
      this.font = parseU8g2Font(name);
      if (this.font.approx) this.R.note(`${name} is drawn with a similar system font, so text may be a few pixels off.`);
    }
    m_setFontPosBaseline() { this.pos = 'baseline'; }
    m_setFontPosTop() { this.pos = 'top'; }
    m_setFontPosCenter() { this.pos = 'center'; }
    m_setFontPosBottom() { this.pos = 'bottom'; }
    m_setFontDirection(d) { this.dir = d & 3; }
    m_getAscent() { return this.font.ascent; }
    m_getDescent() { return -this.font.descent; }
    m_getMaxCharHeight() { return this.font.ascent + this.font.descent; }
    m_getMaxCharWidth() { return this.font.fixed ? this.font.w : this.font.ascent; }
    m_getStrWidth(s) { s = OLED.R.cstr(s); let w = 0; for (let i = 0; i < s.length; i++) w += this.glyph(s.charCodeAt(i)).adv; return w; }
    m_getUTF8Width(s) { return this.m_getStrWidth(s); }
    m_drawStr(x, y, s) { return this.drawText(x, y, OLED.R.cstr(s)); }
    m_drawUTF8(x, y, s) { return this.drawText(x, y, OLED.R.cstr(s)); }
    m_drawGlyph(x, y, code) { this.R.drawCalls++; return this.drawGlyphAt(x, y + this.baselineOffset(), code); }
    m_drawPixel(x, y) { this.R.drawCalls++; this.px(x, y, this.dc); }
    m_drawLine(a, b, c, d) { this.R.drawCalls++; this.line(a, b, c, d, this.dc); }
    m_drawHLine(x, y, w) { this.R.drawCalls++; this.hline(x, y, w, this.dc); }
    m_drawVLine(x, y, h) { this.R.drawCalls++; this.vline(x, y, h, this.dc); }
    m_drawBox(x, y, w, h) { this.R.drawCalls++; this.fill(x, y, w, h, this.dc); }
    m_drawFrame(x, y, w, h) { this.R.drawCalls++; this.rect(x, y, w, h, this.dc); }
    m_drawRBox(x, y, w, h, r) { this.R.drawCalls++; this.fillRound(x, y, w, h, r, this.dc); }
    m_drawRFrame(x, y, w, h, r) { this.R.drawCalls++; this.roundRect(x, y, w, h, r, this.dc); }
    withQuadrants(x0, y0, opt, draw) {
      this.R.drawCalls++;
      if (opt === undefined || (opt & 15) === 15) { draw(); return; }
      this.quad = (x, y) => ((opt & 1) && x >= x0 && y <= y0) || ((opt & 2) && x <= x0 && y <= y0) || ((opt & 4) && x <= x0 && y >= y0) || ((opt & 8) && x >= x0 && y >= y0);
      draw();
      this.quad = null;
    }
    m_drawCircle(x, y, r, opt) { this.withQuadrants(x, y, opt, () => this.circle(x, y, r, this.dc)); }
    m_drawDisc(x, y, r, opt) { this.withQuadrants(x, y, opt, () => this.disc(x, y, r, this.dc)); }
    m_drawEllipse(x, y, rx, ry, opt) {
      this.withQuadrants(x, y, opt, () => {
        const steps = Math.max(32, (rx + ry) * 6);
        let lx = null, ly = null;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2, px = Math.round(x + rx * Math.cos(a)), py = Math.round(y + ry * Math.sin(a));
          if (px !== lx || py !== ly) this.px(px, py, this.dc);
          lx = px; ly = py;
        }
      });
    }
    m_drawFilledEllipse(x, y, rx, ry, opt) {
      this.withQuadrants(x, y, opt, () => {
        for (let j = -ry; j <= ry; j++) {
          const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (j * j) / (ry * ry || 1))));
          this.hline(x - half, y + j, 2 * half + 1, this.dc);
        }
      });
    }
    m_drawTriangle(a, b, c, d, e, f) { this.R.drawCalls++; this.fillTri(a, b, c, d, e, f, this.dc); }
    m_drawXBM(x, y, w, h, bmp) { this.R.drawCalls++; this.bitmapLSB(x, y, bmp, w, h, this.dc, this.bitmapMode ? undefined : 0); }
    m_drawXBMP(x, y, w, h, bmp) { this.m_drawXBM(x, y, w, h, bmp); }
    m_drawBitmap(x, y, cnt, h, bmp) { this.R.drawCalls++; this.bitmapMSB(x, y, bmp, cnt * 8, h, this.dc, this.bitmapMode ? undefined : 0); }
    m_drawBitmapP(x, y, cnt, h, bmp) { this.m_drawBitmap(x, y, cnt, h, bmp); }
  }
  U8G2Display.YIELDS = new Set(['sendBuffer', 'nextPage', 'clear', 'clearDisplay']);

  /* ---------- ThingPulse SSD1306Wire ---------- */

  const GEOMETRIES = [[128, 64], [128, 32], [64, 48], [64, 32]];

  class ThingPulseDisplay extends Panel {
    constructor(R, name, args) {
      const g = GEOMETRIES[args[3] || 0] || GEOMETRIES[0];
      super(R, g[0], g[1]);
      this.label = name;
      this.dc = 1;
      this.align = 0;
      this.size = 10;
    }
    get css() { return `${Math.round(this.size * 1.3)}px Arial, Helvetica, sans-serif`; }
    width(s) { let w = 0; for (let i = 0; i < s.length; i++) w += rasterGlyph(this.css, s.charCodeAt(i)).adv; return w; }
    writeCh() {}
    m_init() { return 1; }
    m_end() {} m_resetDisplay() {} m_displayOn() {} m_displayOff() {} m_resetOrientation() {} m_mirrorScreen() {} m_setLogBuffer() {}
    m_clear() { this.clearBuf(); }
    m_display() { return this.present(); }
    m_setColor(c) { this.dc = c; }
    m_setPixel(x, y) { this.R.drawCalls++; this.px(x, y, this.dc); }
    m_setPixelColor(x, y, c) { this.R.drawCalls++; this.px(x, y, c); }
    m_clearPixel(x, y) { this.R.drawCalls++; this.px(x, y, 0); }
    m_drawLine(a, b, c, d) { this.R.drawCalls++; this.line(a, b, c, d, this.dc); }
    m_drawHorizontalLine(x, y, w) { this.R.drawCalls++; this.hline(x, y, w, this.dc); }
    m_drawVerticalLine(x, y, h) { this.R.drawCalls++; this.vline(x, y, h, this.dc); }
    m_drawRect(x, y, w, h) { this.R.drawCalls++; this.rect(x, y, w, h, this.dc); }
    m_fillRect(x, y, w, h) { this.R.drawCalls++; this.fill(x, y, w, h, this.dc); }
    m_drawCircle(x, y, r) { this.R.drawCalls++; this.circle(x, y, r, this.dc); }
    m_fillCircle(x, y, r) { this.R.drawCalls++; this.disc(x, y, r, this.dc); }
    m_drawProgressBar(x, y, w, h, pct) {
      this.R.drawCalls++;
      const radius = (h / 2) | 0, xr = x + radius, yr = y + radius, maxW = w - 2 * radius;
      this.roundRect(x, y, w, h, radius, this.dc);
      const fillW = Math.round((Math.min(100, Math.max(0, pct)) / 100) * maxW);
      this.fillRound(x + 2, y + 2, Math.max(0, fillW + 2 * radius - 4), Math.max(0, h - 4), Math.max(0, radius - 2), this.dc);
      void xr; void yr;
    }
    m_setFont(name) {
      const m = typeof name === 'string' && /_(\d+)$/.exec(name);
      if (m) this.size = +m[1];
      this.R.note('ArialMT fonts are drawn with a similar system font, so text may be a few pixels off.');
    }
    m_setTextAlignment(a) { this.align = a; }
    m_getStringWidth(s) { return this.width(OLED.R.cstr(s)); }
    m_drawString(x, y, str) {
      this.R.drawCalls++;
      this.R.note('ArialMT fonts are drawn with a similar system font, so text may be a few pixels off.');
      const lines = OLED.R.cstr(str).split('\n');
      lines.forEach((line, li) => {
        const lineW = this.width(line);
        let ax = x;
        if (this.align === 1) ax -= lineW >> 1; else if (this.align === 2) ax -= lineW;
        const lineY = y + li * Math.round(this.size * 1.3);
        let ay = lineY + Math.round(this.size * 1.1);
        if (this.align === 3) { ax = x - (lineW >> 1); ay -= Math.round(this.size * 0.55); }
        for (let i = 0; i < line.length; i++) {
          const g = rasterGlyph(this.css, line.charCodeAt(i));
          for (let j = 0; j < g.h; j++) for (let k = 0; k < g.w; k++) if (g.get(k, j)) this.px(ax + g.xo + k, ay + g.yo + j, this.dc);
          ax += g.adv;
        }
      });
    }
    m_drawStringMaxWidth(x, y, _w, s) { this.m_drawString(x, y, s); }
    m_drawXbm(x, y, w, h, bmp) { this.R.drawCalls++; this.bitmapLSB(x, y, bmp, w, h, this.dc); }
    m_flipScreenVertically() { this.rot = 2; }
    m_setBrightness(b) { this.dimmed = b < 64; this.R.markDirty(); }
    m_setContrast(c) { this.dimmed = c < 64; this.R.markDirty(); }
    m_invertDisplay() { this.inverted = true; this.R.markDirty(); }
    m_normalDisplay() { this.inverted = false; this.R.markDirty(); }
    m_getWidth() { return this.W; }
    m_getHeight() { return this.H; }
  }
  ThingPulseDisplay.YIELDS = new Set(['display']);

  /* ---------- Serial and do-nothing buses ---------- */

  class SerialPort {
    constructor(R) { this.R = R; }
    m_begin() {} m_end() {} m_flush() {} m_setTimeout() {}
    m_available() { return 0; }
    m_read() { return -1; }
    m_peek() { return -1; }
    m_parseInt() { return 0; }
    m_parseFloat() { return 0; }
    m_readString() { return ''; }
    m_readStringUntil() { return ''; }
    m_print(v, kind, opt) { this.R.serial(OLED.R.fmt(v, kind, opt)); return 1; }
    m_println(v, kind, opt) { this.R.serial((kind === 's' && v === '' ? '' : OLED.R.fmt(v, kind, opt)) + '\n'); return 1; }
    m_printf(fmt, ...args) { this.R.serial(OLED.R.sprintf(fmt, args)); return 1; }
    m_write(v) { this.R.serial(typeof v === 'number' ? String.fromCharCode(v) : OLED.R.cstr(v)); return 1; }
  }
  SerialPort.YIELDS = new Set();
  SerialPort.RETURNS = { readString: 'String', readStringUntil: 'String', parseFloat: 'f' };

  class BusStub {
    m_begin() {} m_end() {} m_setClock() {} m_setPins() {} m_setClockDivider() {} m_setDataMode() {} m_setBitOrder() {}
    m_beginTransmission() {} m_endTransmission() { return 0; } m_requestFrom() { return 0; }
    m_write() { return 1; } m_read() { return 0; } m_available() { return 0; } m_transfer() { return 0; }
    m_beginTransaction() {} m_endTransaction() {}
  }
  BusStub.YIELDS = new Set();

  /* ---------- Library registry ---------- */

  const ADAFRUIT = new Set(['Adafruit_SSD1306', 'Adafruit_SH1106G', 'Adafruit_SH1107', 'Adafruit_SH1106', 'Adafruit_SSD1305', 'Adafruit_GrayOLED']);
  const THINGPULSE = new Set(['SSD1306Wire', 'SH1106Wire', 'SSD1306Spi', 'SH1106Spi', 'SSD1306I2C', 'SSD1306Brzo', 'SH1106Brzo']);
  const OTHERS = { SerialPort, TwoWire: BusStub, SPIClass: BusStub };

  OLED.isLibClass = (name) => ADAFRUIT.has(name) || THINGPULSE.has(name) || /^U8G2_\w+_(F|1|2)_/.test(name) || name === 'U8G2' || Object.prototype.hasOwnProperty.call(OTHERS, name);
  OLED.resolveLib = (name) => {
    if (ADAFRUIT.has(name)) return AdafruitDisplay;
    if (THINGPULSE.has(name)) return ThingPulseDisplay;
    if (/^U8G2/.test(name)) return U8G2Display;
    return OTHERS[name];
  };
  OLED.Libs = {
    make(R, name, args) {
      if (!OLED.isLibClass(name)) throw new Error(`${name} isn't a known display library`);
      const C = OLED.resolveLib(name);
      if (C === SerialPort) return new SerialPort(R);
      if (C === BusStub) return new BusStub();
      return new C(R, name, args);
    },
  };
  OLED.isFontName = (name) => /^u8g2_font_\w+$/.test(name) || /^u8x8_font_\w+$/.test(name) || /^ArialMT_Plain_\d+$/.test(name) || !!drawFreeFontSpec(name);
  OLED.guessDeviceClass = (objName, method) => {
    const looksLikeDisplay = /^(display|oled|screen|lcd|u8g2|u8g)\w*$/i.test(objName);
    const looksLikeDrawing = /^(draw|fill|clearDisplay|clearBuffer|sendBuffer|setCursor|setText)/.test(method);
    if (!looksLikeDisplay && !looksLikeDrawing) return null;
    if (/u8g/i.test(objName) || (('m_' + method) in U8G2Display.prototype && !(('m_' + method) in AdafruitDisplay.prototype))) return 'U8G2_SSD1306_128X64_NONAME_F_HW_I2C';
    return ('m_' + method) in AdafruitDisplay.prototype ? 'Adafruit_SSD1306' : null;
  };
  OLED.GLOBAL_OBJECTS = [
    { name: 'Serial', cls: 'SerialPort' }, { name: 'Serial1', cls: 'SerialPort' }, { name: 'Serial2', cls: 'SerialPort' },
    { name: 'Wire', cls: 'TwoWire' }, { name: 'Wire1', cls: 'TwoWire' }, { name: 'SPI', cls: 'SPIClass' },
  ];
})();
