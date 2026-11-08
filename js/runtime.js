// Arduino built-ins and the virtual-time scheduler that runs a compiled sketch.
(function () {
  const OLED = (globalThis.OLED = globalThis.OLED || {});

  class Ptr {
    constructor(a, i) { this.a = a; this.i = i; }
    get v() { return this.a[this.i] ?? 0; }
    set v(x) { this.a[this.i] = x; }
  }
  class Ref {
    constructor(get, set) { this.get = get; this.set = set; }
    get v() { return this.get(); }
    set v(x) { this.set(x); }
  }

  const cstr = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) || v instanceof Ptr) {
      const a = Array.isArray(v) ? v : v.a, start = Array.isArray(v) ? 0 : v.i;
      let s = '';
      for (let i = start; i < a.length && a[i]; i++) s += String.fromCharCode(a[i] & 255);
      return s;
    }
    if (v === 0 || v === undefined || v === null) return '';
    return String(v);
  };

  function formatFloat(v, digits) {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    return v.toFixed(digits);
  }

  function fmt(v, kind, opt) {
    switch (kind) {
      case 's': return cstr(v);
      case 'c': return opt === undefined ? String.fromCharCode(v & 255) : (v >>> 0).toString(opt).toUpperCase();
      case 'f': return formatFloat(v, opt === undefined ? 2 : opt);
    }
    if (typeof v !== 'number') return cstr(v);
    if (opt !== undefined && opt !== 10) return (v >>> 0).toString(opt).toUpperCase();
    return String(v);
  }

  function sprintf(format, args) {
    let i = 0;
    return cstr(format).replace(/%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|z)?([diuoxXcsfFeEgG%])/g, (_, flags, w, p, _len, conv) => {
      if (conv === '%') return '%';
      let width = w === '*' ? args[i++] : w === undefined ? 0 : +w;
      const prec = p === '*' ? args[i++] : p === undefined ? undefined : +p;
      const arg = args[i++];
      let body;
      switch (conv) {
        case 'd': case 'i': body = String(Math.trunc(Number(arg) || 0)); break;
        case 'u': body = String(Number(arg) >>> 0); break;
        case 'o': body = (Number(arg) >>> 0).toString(8); break;
        case 'x': body = (Number(arg) >>> 0).toString(16); break;
        case 'X': body = (Number(arg) >>> 0).toString(16).toUpperCase(); break;
        case 'c': body = String.fromCharCode(Number(arg) & 255); break;
        case 's': body = cstr(arg); if (prec !== undefined) body = body.slice(0, prec); break;
        case 'f': case 'F': body = formatFloat(Number(arg) || 0, prec === undefined ? 6 : prec); break;
        case 'e': case 'E': body = (Number(arg) || 0).toExponential(prec === undefined ? 6 : prec); if (conv === 'E') body = body.toUpperCase(); break;
        default: body = String(Number((Number(arg) || 0).toPrecision(prec || 6)));
      }
      if (flags.includes('+') && 'dfFeEgGi'.includes(conv) && !body.startsWith('-')) body = '+' + body;
      if (body.length < width) {
        const pad = width - body.length;
        if (flags.includes('-')) body += ' '.repeat(pad);
        else if (flags.includes('0') && conv !== 's') {
          const sign = /^[-+]/.test(body) ? body[0] : '';
          body = sign + '0'.repeat(pad) + body.slice(sign.length);
        } else body = ' '.repeat(pad) + body;
      }
      return body;
    });
  }

  const view = (p) => {
    if (Array.isArray(p)) return { a: p, i: 0 };
    if (p instanceof Ptr) return { a: p.a, i: p.i };
    if (typeof p === 'string') return { a: Array.from(p, (c) => c.charCodeAt(0)), i: 0 };
    return { a: [], i: 0 };
  };

  // Stateless helpers that generated code and the display libraries share.
  const R0 = {
    Ptr, Ref, view, cstr, fmt, sprintf,
    ref: (get, set) => new Ref(get, set),
    ptr: (base, i) => {
      if (typeof base === 'string') return base.slice(i);
      if (base instanceof Ptr) return new Ptr(base.a, base.i + i);
      return new Ptr(base, i);
    },
    padd: (p, n) => {
      if (typeof p === 'string') return p.slice(n);
      if (p instanceof Ptr) return new Ptr(p.a, p.i + n);
      return new Ptr(p, n);
    },
    pdiff: (a, b) => (a instanceof Ptr ? a.i : 0) - (b instanceof Ptr ? b.i : 0),
    at: (p, i) => {
      if (Array.isArray(p)) return p[i] ?? 0;
      if (p instanceof Ptr) return p.a[p.i + i] ?? 0;
      if (typeof p === 'string') return p.charCodeAt(i) || 0;
      return 0;
    },
    put: (p, i, v) => {
      if (Array.isArray(p)) p[i] = v;
      else if (p instanceof Ptr) p.a[p.i + i] = v;
      return v;
    },
    deref: (p) => {
      if (p instanceof Ptr || p instanceof Ref) return p.v;
      if (Array.isArray(p)) return p[0] ?? 0;
      if (typeof p === 'string') return p.charCodeAt(0) || 0;
      return p;
    },
    wr: (p, v) => {
      if (p instanceof Ptr || p instanceof Ref) p.v = v;
      else if (Array.isArray(p)) p[0] = v;
      return v;
    },
    idiv: (a, b) => (b ? Math.trunc(a / b) : 0),
    imod: (a, b) => (b ? a % b : 0),
    big: (op, a, b) => Number(op === '&' ? BigInt(a) & BigInt(b) : op === '|' ? BigInt(a) | BigInt(b) : BigInt(a) ^ BigInt(b)),
    arr: function arr(dims, zero) {
      const out = new Array(Math.max(0, dims[0] | 0));
      const rest = dims.slice(1);
      for (let i = 0; i < out.length; i++) out[i] = rest.length ? arr(rest, zero) : zero();
      return out;
    },
    fill: (a, n, zero) => { while (a.length < n) a.push(zero()); return a; },
    strArr: (s, n) => {
      const a = new Array(Math.max(n, s.length + 1)).fill(0);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    },
    szof: function szof(a, base) { return Array.isArray(a) ? a.reduce((s, x) => s + szof(x, base), 0) : base; },
    iter: (v) => (Array.isArray(v) ? v : typeof v === 'string' ? Array.from(v, (c) => c.charCodeAt(0)) : []),
    clone: function clone(v) {
      if (Array.isArray(v)) return v.map(clone);
      if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const o = {};
        for (const k of Object.keys(v)) o[k] = clone(v[k]);
        return o;
      }
      return v;
    },
    mk: function* (obj, ctor, args) { yield* ctor(obj, ...args); return obj; },
  };
  OLED.R = R0;

  OLED.CONSTS = {
    HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, LED_BUILTIN: 13,
    A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19, A6: 20, A7: 21, SDA: 18, SCL: 19,
    PI: Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, M_PI: Math.PI, EULER: Math.E,
    DEC: 10, HEX: 16, OCT: 8, BIN: 2, RAND_MAX: 32767, CHANGE: 1, FALLING: 2, RISING: 3,
    INT8_MAX: 127, INT8_MIN: -128, UINT8_MAX: 255, INT16_MAX: 32767, INT16_MIN: -32768, UINT16_MAX: 65535, INT32_MAX: 2147483647, INT32_MIN: -2147483648, UINT32_MAX: 4294967295,
    WHITE: 1, BLACK: 0, INVERSE: 2, SSD1306_WHITE: 1, SSD1306_BLACK: 0, SSD1306_INVERSE: 2, SH110X_WHITE: 1, SH110X_BLACK: 0, SH110X_INVERSE: 2,
    SSD1306_SWITCHCAPVCC: 2, SSD1306_EXTERNALVCC: 1,
    U8G2_R0: 0, U8G2_R1: 1, U8G2_R2: 2, U8G2_R3: 3, U8G2_MIRROR: 0, U8X8_PIN_NONE: 255,
    U8G2_DRAW_UPPER_RIGHT: 1, U8G2_DRAW_UPPER_LEFT: 2, U8G2_DRAW_LOWER_LEFT: 4, U8G2_DRAW_LOWER_RIGHT: 8, U8G2_DRAW_ALL: 15,
    TEXT_ALIGN_LEFT: 0, TEXT_ALIGN_CENTER: 1, TEXT_ALIGN_RIGHT: 2, TEXT_ALIGN_CENTER_BOTH: 3,
    GEOMETRY_128_64: 0, GEOMETRY_128_32: 1, GEOMETRY_64_48: 2, GEOMETRY_64_32: 3,
  };

  const copyStr = (dst, s) => {
    const v = view(dst);
    for (let i = 0; i < s.length; i++) v.a[v.i + i] = s.charCodeAt(i);
    v.a[v.i + s.length] = 0;
    return dst;
  };

  let current = null; // The sim whose code is executing; built-ins read pins and time from it.
  let seed = 1;
  const nextRandom = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const B = {
    millis: () => Math.floor(current.vt) >>> 0,
    micros: () => Math.floor(current.vt * 1000) >>> 0,
    pinMode: (pin, mode) => { current.pinMode(pin, mode); },
    digitalRead: (pin) => current.readDigital(pin),
    digitalWrite: () => {},
    analogRead: (pin) => current.readAnalog(pin),
    analogWrite: () => {}, tone: () => {}, noTone: () => {}, attachInterrupt: () => {}, detachInterrupt: () => {},
    digitalPinToInterrupt: (p) => p, noInterrupts: () => {}, interrupts: () => {}, analogReference: () => {}, analogReadResolution: () => {},
    esp_random: () => (nextRandom() * 4294967296) >>> 0,
    random: (a, b) => {
      if (b === undefined) { b = a; a = 0; }
      return b <= a ? a : a + Math.floor(nextRandom() * (b - a));
    },
    randomSeed: (s) => { seed = s | 0; },
    rand: () => Math.floor(nextRandom() * 32768),
    srand: (s) => { seed = s | 0; },
    abs: Math.abs, fabs: Math.abs, labs: Math.abs,
    min: Math.min, max: Math.max,
    constrain: (x, a, b) => (x < a ? a : x > b ? b : x),
    map: (x, a, b, c, d) => (b === a ? c : Math.trunc(((x - a) * (d - c)) / (b - a)) + c),
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow, exp: Math.exp, log: Math.log, log10: Math.log10, log2: Math.log2,
    floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
    round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
    lround: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
    fmod: (a, b) => a % b, hypot: Math.hypot,
    radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI,
    isnan: (x) => (Number.isNaN(x) ? 1 : 0), isinf: (x) => (Math.abs(x) === Infinity ? 1 : 0),
    strlen: (s) => cstr(s).length,
    strlen_P: (s) => cstr(s).length,
    strcpy: (d, s) => copyStr(d, cstr(s)),
    strcpy_P: (d, s) => copyStr(d, cstr(s)),
    strncpy: (d, s, n) => copyStr(d, cstr(s).slice(0, n)),
    strcat: (d, s) => copyStr(d, cstr(d) + cstr(s)),
    strncat: (d, s, n) => copyStr(d, cstr(d) + cstr(s).slice(0, n)),
    strcmp: (a, b) => { a = cstr(a); b = cstr(b); return a < b ? -1 : a > b ? 1 : 0; },
    strcmp_P: (a, b) => B.strcmp(a, b),
    strncmp: (a, b, n) => B.strcmp(cstr(a).slice(0, n), cstr(b).slice(0, n)),
    sprintf: (d, f, ...a) => { const s = sprintf(f, a); copyStr(d, s); return s.length; },
    sprintf_P: (d, f, ...a) => B.sprintf(d, f, ...a),
    snprintf: (d, n, f, ...a) => { const s = sprintf(f, a); copyStr(d, s.slice(0, Math.max(0, n - 1))); return s.length; },
    snprintf_P: (d, n, f, ...a) => B.snprintf(d, n, f, ...a),
    atoi: (s) => parseInt(cstr(s), 10) || 0, atol: (s) => parseInt(cstr(s), 10) || 0, atof: (s) => parseFloat(cstr(s)) || 0,
    itoa: (v, d, base) => copyStr(d, base === 10 ? String(v) : (v >>> 0).toString(base)),
    ltoa: (v, d, base) => copyStr(d, base === 10 ? String(v) : (v >>> 0).toString(base)),
    utoa: (v, d, base) => copyStr(d, (v >>> 0).toString(base)),
    dtostrf: (v, w, p, d) => copyStr(d, formatFloat(v, p).padStart(Math.abs(w))),
    memset: (d, v, n) => { const x = view(d); for (let i = 0; i < n && x.i + i < x.a.length; i++) x.a[x.i + i] = v; return d; },
    memcpy: (d, s, n) => {
      const x = view(d), y = view(s);
      for (let i = 0; i < n && y.i + i < y.a.length; i++) x.a[x.i + i] = y.a[y.i + i];
      return d;
    },
    memcpy_P: (d, s, n) => B.memcpy(d, s, n),
    isDigit: (c) => (c >= 48 && c <= 57 ? 1 : 0), isdigit: (c) => (c >= 48 && c <= 57 ? 1 : 0),
    isAlpha: (c) => (/[A-Za-z]/.test(String.fromCharCode(c)) ? 1 : 0), isalpha: (c) => (/[A-Za-z]/.test(String.fromCharCode(c)) ? 1 : 0),
    isSpace: (c) => (c === 32 || (c >= 9 && c <= 13) ? 1 : 0), isspace: (c) => (c === 32 || (c >= 9 && c <= 13) ? 1 : 0),
    toupper: (c) => String.fromCharCode(c).toUpperCase().charCodeAt(0), tolower: (c) => String.fromCharCode(c).toLowerCase().charCodeAt(0),
  };
  OLED.Builtins = B;
  const FLOATS = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'sqrt', 'cbrt', 'pow', 'exp', 'log', 'log10', 'log2', 'floor', 'ceil', 'trunc', 'round', 'fmod', 'fabs', 'hypot', 'radians', 'degrees', 'atof'];

  // C's float-suffixed variants (sqrtf, fabsf, ...) behave the same here because every float is a JS number.
  const WITH_FLOAT_VARIANT = FLOATS.filter((n) => !['radians', 'degrees', 'atof'].includes(n));
  WITH_FLOAT_VARIANT.forEach((n) => { B[n + 'f'] = B[n]; });
  FLOATS.push(...WITH_FLOAT_VARIANT.map((n) => n + 'f'));
  B.lroundf = B.llround = B.llroundf = B.lround;
  OLED.BuiltinTypes = { millis: 'u32', micros: 'u32', esp_random: 'u32', abs: 'promote', min: 'promote', max: 'promote', constrain: 'promote', strcpy: 'cstr', strcat: 'cstr', itoa: 'cstr', ltoa: 'cstr', utoa: 'cstr', dtostrf: 'cstr' };
  FLOATS.forEach((n) => (OLED.BuiltinTypes[n] = 'f'));

  /* Arduino String helpers. Strings are immutable JS strings; mutators are assigned back. */
  const S = {
    make: (v, kind, opt) => fmt(v, kind, opt),
    concat: (a, ka, b, kb) => fmt(a, ka) + fmt(b, kb),
    m_length: (s) => s.length,
    m_c_str: (s) => s,
    m_charAt: (s, i) => s.charCodeAt(i) || 0,
    m_indexOf: (s, x, from) => s.indexOf(typeof x === 'number' ? String.fromCharCode(x) : cstr(x), from || 0),
    m_lastIndexOf: (s, x) => s.lastIndexOf(typeof x === 'number' ? String.fromCharCode(x) : cstr(x)),
    m_substring: (s, a, b) => s.substring(a, b),
    m_toInt: (s) => parseInt(s, 10) || 0,
    m_toFloat: (s) => parseFloat(s) || 0,
    m_toDouble: (s) => parseFloat(s) || 0,
    m_equals: (s, x) => (s === cstr(x) ? 1 : 0),
    m_equalsIgnoreCase: (s, x) => (s.toLowerCase() === cstr(x).toLowerCase() ? 1 : 0),
    m_startsWith: (s, x) => (s.startsWith(cstr(x)) ? 1 : 0),
    m_endsWith: (s, x) => (s.endsWith(cstr(x)) ? 1 : 0),
    m_compareTo: (s, x) => { x = cstr(x); return s < x ? -1 : s > x ? 1 : 0; },
    m_isEmpty: (s) => (s.length ? 0 : 1),
    m_reserve: () => 1,
    m_toUpperCase: (s) => s.toUpperCase(),
    m_toLowerCase: (s) => s.toLowerCase(),
    m_trim: (s) => s.trim(),
    m_concat: (s, x, kind) => s + fmt(x, kind),
    m_replace: (s, a, b) => s.split(typeof a === 'number' ? String.fromCharCode(a) : cstr(a)).join(typeof b === 'number' ? String.fromCharCode(b) : cstr(b)),
    m_remove: (s, i, n) => s.slice(0, i) + (n === undefined ? '' : s.slice(i + n)),
  };
  OLED.StringRuntime = S;
  OLED.StringMethods = Object.assign(Object.create(null), {
    length: 'i32', c_str: 'cstr', charAt: 'char', indexOf: 'i32', lastIndexOf: 'i32', substring: 'String', toInt: 'i32', toFloat: 'f', toDouble: 'f',
    equals: 'b', equalsIgnoreCase: 'b', startsWith: 'b', endsWith: 'b', compareTo: 'i32', isEmpty: 'b', reserve: 'b',
    toUpperCase: 'mutate', toLowerCase: 'mutate', trim: 'mutate', concat: 'mutate', replace: 'mutate', remove: 'mutate',
  });

  /* ---------- Scheduler ---------- */

  class Sim {
    constructor(compiled, hooks) {
      this.hooks = hooks;
      this.vt = 0;
      this.wake = 0;
      this.clock = 0;
      this.done = false;
      this.failed = false;
      this.devices = [];
      this.pins = new Map();
      this.presentCount = 0;
      this.dirty = true;
      const sim = this;
      this.R = Object.assign(Object.create(R0), {
        l: 0,
        n: 0,
        drawCalls: 0,
        drewNothing: true,
        addDevice: (d) => {
          sim.devices.push(d);
          if (sim.devices.length === 2) hooks.note('The sketch uses more than one display. Only the first is shown.');
          hooks.deviceChanged(sim.devices[0]);
        },
        onPresent: (d) => { if (d === sim.devices[0]) { sim.presentCount++; sim.dirty = true; hooks.presented(d, sim.vt); } },
        note: (msg) => hooks.note(msg),
        serial: (text) => hooks.serial(text),
        markDirty: () => { sim.dirty = true; },
        now: () => sim.vt,
        finishSnippet: () => { const d = sim.devices[0]; if (d && !sim.presentCount) d.present(); },
      });
      seed = (Date.now() & 0x7fffffff) | 1;
      this.gen = compiled.factory(this.R, B, OLED.Libs, S);
    }
    pinMode(pin, mode) {
      if (mode === 1) return;
      const existing = this.pins.get(pin);
      if (existing) { existing.idle = mode === 2 ? 1 : 0; if (!existing.held) existing.value = existing.idle; return; }
      this.pins.set(pin, { kind: 'digital', idle: mode === 2 ? 1 : 0, value: mode === 2 ? 1 : 0, held: false });
      this.hooks.pinsChanged();
    }
    readDigital(pin) {
      if (!this.pins.has(pin)) {
        this.pins.set(pin, { kind: 'digital', idle: 0, value: 0, held: false });
        this.hooks.pinsChanged();
      }
      return this.pins.get(pin).value;
    }
    readAnalog(pin) {
      const p = this.pins.get(pin);
      if (!p || p.kind !== 'analog') {
        const value = this.pinPresets?.get(pin) ?? 512; // A slider keeps its position across re-runs.
        this.pins.set(pin, { kind: 'analog', value });
        this.hooks.pinsChanged();
        return value;
      }
      return p.value;
    }
    fail(err) {
      this.done = true;
      this.failed = true;
      const message = err instanceof RangeError ? 'The sketch recursed too deeply and stopped.' : err.message;
      this.hooks.error(`Line ${this.R.l}: ${message}`, this.R.l);
    }
    // Runs the sketch up to virtual time `target`. Stops early when it has used its share of the frame.
    advance(target, budgetMs, untilPresent) {
      const started = performance.now();
      const startCount = this.presentCount;
      current = this;
      while (!this.done && this.wake <= target) {
        this.vt = this.wake;
        let r;
        try { r = this.gen.next(); } catch (e) { this.fail(e); break; }
        if (r.done) { this.done = true; this.hooks.finished(); break; }
        if (r.value === -1) {
          this.R.n = 0;
          this.wake = Number.isFinite(target) ? Math.max(this.vt, target) + 0.001 : this.vt + 16;
          if (Number.isFinite(target)) break;
        } else this.wake = this.vt + (Number(r.value) || 0);
        if (untilPresent && this.presentCount !== startCount) { this.clock = this.vt; return; }
        if (performance.now() - started > budgetMs) { this.clock = Math.min(this.clock, this.wake); break; }
      }
    }
  }
  OLED.Sim = Sim;
})();
