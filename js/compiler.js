// Compiles a subset of Arduino C++ to a JavaScript generator.
// Every identifier from the sketch is prefixed in the output, so pasted code can only
// reach the simulated runtime, never the page.
(function () {
  const OLED = (globalThis.OLED = globalThis.OLED || {});

  class CompileError extends Error {
    constructor(msg, line, file) {
      super(msg);
      this.line = line;
      this.file = file;
    }
  }

  /* ---------- Preprocessor ---------- */

  function stripComments(src) {
    let out = '', i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
        i += 2; out += ' '; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
        out += src.slice(i, j + 1); i = j + 1; continue;
      }
      out += c; i++;
    }
    return out;
  }

  const TOKEN = /\s+|([A-Za-z_][A-Za-z0-9_]*)|(0[xX][0-9a-fA-F']+[uUlL]*|0[bB][01']+[uUlL]*|(?:\d[\d']*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFuUlL]*)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(\.\.\.|<<=|>>=|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\|=|\^=|::|##|[-+*\/%&|^~!<>=?:;,.()\[\]{}#])/y;

  function unescape(s) {
    return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => {
      if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
      return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' }[e] ?? e;
    });
  }

  function parseNumber(raw) {
    const s = raw.replace(/'/g, '');
    const suffix = (s.match(/[uUlL]+$/) || [''])[0].toLowerCase();
    const body = s.slice(0, s.length - suffix.length);
    let value, isFloat = false;
    if (/^0[xX]/.test(body)) value = parseInt(body, 16);
    else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
    else if (/^0[0-7]+$/.test(body)) value = parseInt(body, 8);
    else if (/[.eE]/.test(body) || /[fF]$/.test(body)) { value = parseFloat(body); isFloat = true; }
    else value = parseInt(body, 10);
    return { value, isFloat, unsigned: suffix.includes('u') };
  }

  function tokenize(text, line, file) {
    const out = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < text.length) {
      const at = TOKEN.lastIndex;
      const m = TOKEN.exec(text);
      if (!m) throw new CompileError(`Unexpected character "${text[at]}"`, line, file);
      if (m[1]) {
        if (/^B[01]{1,8}$/.test(m[1])) out.push({ t: 'num', v: parseInt(m[1].slice(1), 2), line, file });
        else out.push({ t: 'id', v: m[1], line, file });
      } else if (m[2]) {
        const n = parseNumber(m[2]);
        out.push({ t: 'num', v: n.value, isFloat: n.isFloat, unsigned: n.unsigned, line, file });
      } else if (m[3]) out.push({ t: 'str', v: unescape(m[3].slice(1, -1)), line, file });
      else if (m[4]) out.push({ t: 'chr', v: unescape(m[4].slice(1, -1)).charCodeAt(0) || 0, line, file });
      else if (m[5]) out.push({ t: 'op', v: m[5], line, file });
    }
    return out;
  }

  const PREAMBLE = `
#define ARDUINO 10819
#define F(x) (x)
#define PSTR(x) (x)
#define FPSTR(x) (x)
#define sq(x) ((x)*(x))
#define bit(b) (1UL << (b))
#define _BV(b) (1 << (b))
#define bitRead(v,b) (((v) >> (b)) & 1)
#define bitSet(v,b) ((v) |= (1UL << (b)))
#define bitClear(v,b) ((v) &= ~(1UL << (b)))
#define bitWrite(v,b,x) ((x) ? bitSet(v,b) : bitClear(v,b))
#define lowByte(w) ((uint8_t)((w) & 0xff))
#define highByte(w) ((uint8_t)((w) >> 8))
#define pgm_read_byte(a) (*(a))
#define pgm_read_byte_near(a) (*(a))
#define pgm_read_byte_far(a) (*(a))
#define pgm_read_word(a) (*(a))
#define pgm_read_word_near(a) (*(a))
#define pgm_read_dword(a) (*(a))
#define pgm_read_float(a) (*(a))
#define pgm_read_ptr(a) (*(a))
#define pgm_read_pointer(a) (*(a))
typedef struct { uint16_t bitmapOffset; uint8_t width, height, xAdvance; int8_t xOffset, yOffset; } GFXglyph;
typedef struct { uint8_t *bitmap; GFXglyph *glyph; uint16_t first, last; uint8_t yAdvance; } GFXfont;
`;

  const DROPPED = new Set(['const', 'constexpr', 'PROGMEM', 'U8X8_PROGMEM', 'volatile', 'register', 'inline', 'IRAM_ATTR',
    'ICACHE_RAM_ATTR', 'ICACHE_FLASH_ATTR', 'DRAM_ATTR', 'virtual', 'explicit', 'override', 'mutable', 'noexcept']);

  function expandTokens(tokens, macros, hide) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id' || !macros.has(tk.v) || hide.has(tk.v)) { out.push(tk); continue; }
      const m = macros.get(tk.v);
      const nextHide = new Set(hide).add(tk.v);
      if (!m.params) {
        out.push(...expandTokens(m.body.map((b) => ({ ...b, line: tk.line, file: tk.file })), macros, nextHide));
        continue;
      }
      if (!(tokens[i + 1] && tokens[i + 1].v === '(' && tokens[i + 1].t === 'op')) { out.push(tk); continue; }
      const args = [[]];
      let depth = 0, j = i + 1;
      for (; j < tokens.length; j++) {
        const a = tokens[j];
        if (a.t === 'op' && (a.v === '(' || a.v === '[' || a.v === '{')) { if (depth++ > 0) args[args.length - 1].push(a); continue; }
        if (a.t === 'op' && (a.v === ')' || a.v === ']' || a.v === '}')) { if (--depth === 0) break; args[args.length - 1].push(a); continue; }
        if (a.t === 'op' && a.v === ',' && depth === 1) { args.push([]); continue; }
        args[args.length - 1].push(a);
      }
      if (j >= tokens.length) throw new CompileError(`Missing ")" in the call to ${tk.v}`, tk.line, tk.file);
      const expanded = args.map((a) => expandTokens(a, macros, hide));
      const body = [];
      const b = m.body;
      for (let k = 0; k < b.length; k++) {
        const t = b[k];
        if (t.t === 'op' && t.v === '#' && b[k + 1] && m.params.includes(b[k + 1].v)) {
          const arg = args[m.params.indexOf(b[k + 1].v)] || [];
          body.push({ t: 'str', v: arg.map((x) => x.v).join(' '), line: tk.line, file: tk.file });
          k++; continue;
        }
        if (t.t === 'op' && t.v === '##' && body.length && b[k + 1]) {
          const left = body.pop();
          const nextT = b[k + 1];
          const pi = m.params.indexOf(nextT.v);
          const right = pi >= 0 ? (args[pi] || [])[0] : nextT;
          body.push(...tokenize(String(left.v) + String(right ? right.v : ''), tk.line, tk.file));
          k++; continue;
        }
        const pi = t.t === 'id' ? m.params.indexOf(t.v) : -1;
        if (pi >= 0) body.push(...(expanded[pi] || []));
        else body.push({ ...t, line: tk.line, file: tk.file });
      }
      out.push(...expandTokens(body, macros, nextHide));
      i = j;
    }
    return out;
  }

  function preprocess(source, files, notes) {
    const macros = new Map();
    const includes = [];
    const stream = [];
    const seen = new Set();

    function evalCondition(tokens) {
      const resolved = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.t === 'id' && t.v === 'defined') {
          const paren = tokens[i + 1] && tokens[i + 1].v === '(';
          const nameTok = tokens[i + (paren ? 2 : 1)];
          resolved.push({ t: 'num', v: nameTok && macros.has(nameTok.v) ? 1 : 0, line: t.line });
          i += paren ? 3 : 1;
        } else resolved.push(t);
      }
      const parser = new Parser(expandTokens(resolved, macros, new Set()), new Map());
      try { return !!constEval(parser.parseExpr(), new Map(), true); } catch (e) { return false; }
    }

    function run(text, file) {
      const lines = stripComments(text).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        while (lines[i].endsWith('\\') && i + 1 < lines.length) {
          const continued = lines[i + 1];
          lines[i + 1] = lines[i].slice(0, -1) + ' ' + continued;
          lines[i] = '';
          i++;
        }
      }
      const stack = [];
      const active = () => stack.every((s) => s.on);
      lines.forEach((raw, idx) => {
        const line = idx + 1;
        const m = /^\s*#\s*([a-z_]+)?\s*(.*)$/.exec(raw);
        if (!m) {
          if (active() && raw.trim()) stream.push(...tokenize(raw, line, file));
          return;
        }
        const dir = m[1] || '';
        const rest = m[2].trim();
        switch (dir) {
          case 'ifdef': case 'ifndef': {
            const has = macros.has(rest.split(/\s+/)[0]);
            const on = dir === 'ifdef' ? has : !has;
            stack.push({ on, taken: on }); return;
          }
          case 'if': {
            const on = active() && evalCondition(tokenize(rest, line, file));
            stack.push({ on, taken: on }); return;
          }
          case 'elif': {
            const top = stack[stack.length - 1];
            if (!top) throw new CompileError('#elif without a matching #if', line, file);
            if (top.taken) top.on = false;
            else { top.on = evalCondition(tokenize(rest, line, file)); top.taken = top.on; }
            return;
          }
          case 'else': {
            const top = stack[stack.length - 1];
            if (!top) throw new CompileError('#else without a matching #if', line, file);
            top.on = !top.taken; top.taken = true; return;
          }
          case 'endif':
            if (!stack.length) throw new CompileError('#endif without a matching #if', line, file);
            stack.pop(); return;
        }
        if (!active()) return;
        if (dir === 'define') {
          const def = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
          if (!def) return;
          const params = def[2] ? def[3].split(',').map((s) => s.trim()).filter(Boolean) : null;
          macros.set(def[1], { params, body: tokenize(def[4], line, file) });
        } else if (dir === 'undef') {
          macros.delete(rest.split(/\s+/)[0]);
        } else if (dir === 'include') {
          const inc = /^[<"]([^>"]+)[>"]/.exec(rest);
          if (!inc) return;
          const name = inc[1];
          const base = name.split('/').pop();
          includes.push(name);
          if (files[name] !== undefined || files[base] !== undefined) {
            if (!seen.has(base)) { seen.add(base); run(files[name] ?? files[base], base); }
          } else if (rest[0] === '"') {
            notes.add(`${name} isn't loaded. Open it together with the sketch if the sketch needs what's inside.`);
          }
        }
      });
      if (stack.length) throw new CompileError('#if without a matching #endif', lines.length, file);
    }

    run(PREAMBLE, '<preamble>');
    run(source, null);
    let tokens = expandTokens(stream, macros, new Set());
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === 'id' && t.v === '__attribute__' && tokens[i + 1] && tokens[i + 1].v === '(') {
        let depth = 0, j = i + 1;
        for (; j < tokens.length; j++) {
          if (tokens[j].v === '(' && tokens[j].t === 'op') depth++;
          if (tokens[j].v === ')' && tokens[j].t === 'op' && --depth === 0) break;
        }
        i = j; continue;
      }
      if (t.t === 'id' && DROPPED.has(t.v)) continue;
      out.push(t);
    }
    return { tokens: out, includes };
  }

  function constEval(n, env, lenient) {
    switch (n.k) {
      case 'num': case 'chr': return n.v;
      case 'id':
        if (env.has(n.name)) return env.get(n.name);
        if (OLED.CONSTS && Object.prototype.hasOwnProperty.call(OLED.CONSTS, n.name)) return OLED.CONSTS[n.name];
        if (lenient) return 0;
        throw new Error('not constant');
      case 'cast': return constEval(n.e, env, lenient);
      case 'un': {
        const v = constEval(n.e, env, lenient);
        return { '-': -v, '+': +v, '!': v ? 0 : 1, '~': ~v }[n.op];
      }
      case 'cond': return constEval(n.c, env, lenient) ? constEval(n.a, env, lenient) : constEval(n.b, env, lenient);
      case 'bin': {
        const a = constEval(n.a, env, lenient), b = constEval(n.b, env, lenient);
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b ? Math.trunc(a / b) : 0; case '%': return b ? a % b : 0;
          case '<<': return a << b; case '>>': return a >> b; case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
          case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
          case '==': return +(a === b); case '!=': return +(a !== b); case '&&': return +(a && b); case '||': return +(a || b);
        }
      }
    }
    throw new Error('not constant');
  }

  /* ---------- Types ---------- */

  const T = (b, p = 0, d = 0) => ({ b, p, d });
  const I32 = T('i32'), U32 = T('u32'), FLT = T('f'), VOID = T('void'), STRING = T('String'), CSTR = T('char', 1), CHAR = T('char');
  const INT_BASES = new Set(['char', 'u8', 'i8', 'i16', 'u16', 'i32', 'u32', 'i64', 'b']);
  const isVal = (t) => !t.p && !t.d;
  const isF = (t) => isVal(t) && t.b === 'f';
  const isStr = (t) => isVal(t) && t.b === 'String';
  const isPtr = (t) => t.p > 0 || t.d > 0;
  const isInt = (t) => isVal(t) && INT_BASES.has(t.b);
  const isNum = (t) => isF(t) || isInt(t);
  const isStruct = (t) => t.b.startsWith('struct:');
  const kindOf = (t) => {
    if (isStr(t)) return 's';
    if ((t.b === 'char' || t.b === 'u8') && t.p + t.d === 1) return 's';
    if (isVal(t) && t.b === 'char') return 'c';
    return isF(t) ? 'f' : 'i';
  };
  const promote = (a, b) => (a.b === 'i64' || b.b === 'i64' ? T('i64') : a.b === 'u32' || b.b === 'u32' ? U32 : I32);
  const SIZES = { char: 1, u8: 1, i8: 1, b: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, f: 4 };
  const WRAP_RANGE = { u8: [0, 255], char: [-128, 255], i8: [-128, 127], i16: [-32768, 32767], u16: [0, 65535], i32: [-2147483648, 2147483647], u32: [0, 4294967295] };

  const TYPE_WORDS = new Set(['void', 'bool', 'boolean', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
    'byte', 'word', 'size_t', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t', 'auto']);
  const STATEMENT_WORDS = new Set(['return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'break', 'continue', 'goto', 'delete', 'new', 'sizeof', 'this', 'throw']);

  function mapTypeWords(w) {
    const has = (x) => w.includes(x);
    const uns = has('unsigned');
    if (has('float') || has('double')) return 'f';
    if (has('void')) return 'void';
    if (has('auto')) return 'auto';
    if (has('bool') || has('boolean')) return 'b';
    if (has('char')) return uns ? 'u8' : has('signed') ? 'i8' : 'char';
    if (has('short')) return uns ? 'u16' : 'i16';
    if (w.filter((x) => x === 'long').length > 1) return 'i64';
    if (has('long')) return uns ? 'u32' : 'i32';
    if (has('int') || uns || has('signed')) return uns ? 'u32' : 'i32';
    return { byte: 'u8', word: 'u16', size_t: 'u32', uint8_t: 'u8', int8_t: 'i8', uint16_t: 'u16', int16_t: 'i16', uint32_t: 'u32', int32_t: 'i32', uint64_t: 'i64', int64_t: 'i64' }[w[0]];
  }

  /* ---------- Parser ---------- */

  const EOF = { t: 'eof', v: '<end of file>', line: 0 };
  const BIN_PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

  class Parser {
    constructor(tokens, aliases) {
      this.t = tokens;
      this.i = 0;
      this.aliases = aliases;
      this.classes = new Map();
      this.enums = new Map();
      this.anon = 0;
      // Struct and enum names are collected up front so casts and declarations resolve before their definition.
      for (let k = 0; k + 1 < tokens.length; k++) {
        if (tokens[k].t === 'id' && ['struct', 'class', 'union'].includes(tokens[k].v) && tokens[k + 1].t === 'id') this.classes.set(tokens[k + 1].v, this.classes.get(tokens[k + 1].v) || null);
      }
    }
    peek(k = 0) { return this.t[this.i + k] || EOF; }
    next() { return this.t[this.i++] || EOF; }
    is(v, k = 0) { const p = this.peek(k); return (p.t === 'op' || p.t === 'id') && p.v === v; }
    accept(v) { if (this.is(v)) { this.i++; return true; } return false; }
    fail(msg, tk = this.peek()) { throw new CompileError(msg, tk.line, tk.file); }
    expect(v) {
      if (!this.accept(v)) {
        const prev = this.t[this.i - 1];
        if (v === ';' && prev) this.fail(`Missing ";" after "${prev.v}"`, prev);
        this.fail(`Expected "${v}" but found "${this.peek().v}"`);
      }
    }
    ident() {
      const p = this.next();
      if (p.t !== 'id') this.fail(`Expected a name but found "${p.v}"`, p);
      return p.v;
    }
    isKnownType(name) {
      return name === 'String' || this.aliases.has(name) || this.classes.has(name) || this.enums.has(name) || OLED.isLibClass(name);
    }
    isCastAt(k) {
      const p = this.peek(k);
      if (p.t !== 'id') return false;
      if (!(TYPE_WORDS.has(p.v) || this.isKnownType(p.v) || p.v === 'struct')) return false;
      let j = k + 1;
      while (this.peek(j).t === 'id' && TYPE_WORDS.has(this.peek(j).v)) j++;
      if (p.v === 'struct') j++;
      while (this.is('*', j)) j++;
      return this.is(')', j);
    }
    startsDecl() {
      const p = this.peek();
      if (p.t !== 'id' || STATEMENT_WORDS.has(p.v)) return false;
      if (['static', 'struct', 'class', 'enum', 'union', 'typedef'].includes(p.v)) return true;
      if (TYPE_WORDS.has(p.v)) return !this.is('(', 1);
      let k = 1;
      let name = p.v;
      while (this.is('::', k) && this.peek(k + 1).t === 'id') { name = this.peek(k + 1).v; k += 2; }
      const nxt = this.peek(k);
      const declaratorAfterStar = () => this.peek(k + 1).t === 'id' && (this.is('=', k + 2) || this.is(';', k + 2) || this.is(',', k + 2) || this.is('[', k + 2) || this.is(')', k + 2));
      if (this.isKnownType(name)) return nxt.t === 'id' || this.is('*', k) || this.is('&', k);
      if (nxt.t === 'id' && !STATEMENT_WORDS.has(nxt.v)) return true;
      return (this.is('*', k) || this.is('&', k)) && declaratorAfterStar();
    }
    parseBaseType() {
      const start = this.peek();
      if (this.is('enum')) return this.parseEnum();
      if (this.is('struct') || this.is('class') || this.is('union')) {
        if (this.peek(1).t === 'id' && !this.is('{', 2) && !this.is(':', 2)) { this.i++; return T('struct:' + this.ident()); }
        return this.parseClass();
      }
      const words = [];
      while (this.peek().t === 'id' && TYPE_WORDS.has(this.peek().v)) words.push(this.next().v);
      if (words.length) return T(mapTypeWords(words));
      let name = this.ident();
      while (this.accept('::')) name = this.ident();
      if (this.is('<')) this.fail(`Templates such as ${name}<...> aren't supported`, start);
      if (name === 'String') return T('String');
      if (this.aliases.has(name)) return { ...this.aliases.get(name) };
      if (this.enums.has(name)) return I32;
      if (this.classes.has(name)) return T('struct:' + name);
      if (OLED.isLibClass(name)) return T('lib:' + name);
      return T('ext:' + name);
    }
    parseEnum() {
      this.expect('enum');
      if (!this.accept('class')) this.accept('struct');
      let name = null;
      if (this.peek().t === 'id') name = this.ident();
      if (this.accept(':')) this.parseBaseType();
      if (name) this.enums.set(name, true);
      if (this.accept('{')) {
        let v = 0;
        while (!this.is('}')) {
          const id = this.ident();
          if (this.accept('=')) {
            const expr = this.parseAssign();
            try { v = constEval(expr, this.enumValues()); } catch (e) { this.fail(`The value of ${id} must be a constant`); }
          }
          this.enumValues().set(id, v++);
          if (!this.accept(',')) break;
        }
        this.expect('}');
      }
      return I32;
    }
    enumValues() { return (this._enumValues = this._enumValues || new Map()); }
    parseClass() {
      this.next();
      let name = this.peek().t === 'id' ? this.ident() : `__anon${this.anon++}`;
      const cls = { name, base: null, fields: [], methods: [], ctors: [] };
      this.classes.set(name, cls);
      if (this.accept(':')) {
        this.accept('public') || this.accept('private') || this.accept('protected');
        cls.base = this.ident();
      }
      this.expect('{');
      while (!this.is('}')) {
        if (this.peek().t === 'eof') this.fail(`Missing "}" at the end of ${name}`);
        if ((this.is('public') || this.is('private') || this.is('protected')) && this.is(':', 1)) { this.i += 2; continue; }
        if (this.accept('friend')) { while (!this.accept(';')) this.next(); continue; }
        if (this.accept(';')) continue;
        if (this.is('~')) { this.i += 2; this.parseParams(); if (!this.accept(';')) this.parseBlock(); continue; }
        if (this.is(name) && this.is('(', 1)) {
          const line = this.peek().line;
          this.i++;
          const params = this.parseParams();
          const fn = { name, params, ret: VOID, line, cls: name, inits: this.parseCtorInits(), body: null };
          if (!this.accept(';')) fn.body = this.parseBlock();
          cls.ctors.push(fn);
          continue;
        }
        const isStatic = this.accept('static');
        const base = this.parseBaseType();
        if (this.accept(';')) continue;
        for (;;) {
          const t = { ...base };
          while (this.accept('*')) t.p++;
          if (this.accept('&')) t.r = true;
          if (this.is('operator')) this.fail('Operator overloading isn\'t supported');
          const line = this.peek().line;
          const fname = this.ident();
          if (this.is('(')) {
            const params = this.parseParams();
            const fn = { name: fname, params, ret: t, line, cls: name, isStatic, body: null };
            if (this.accept('=')) this.next();
            if (!this.accept(';')) fn.body = this.parseBlock();
            cls.methods.push(fn);
            break;
          }
          const dims = this.parseDims();
          const field = { name: fname, type: { ...t, d: dims.length }, dims, init: null };
          if (this.accept('=')) field.init = this.parseInit();
          else if (this.is('{')) field.init = this.parseInit();
          cls.fields.push(field);
          if (this.accept(',')) continue;
          this.expect(';');
          break;
        }
      }
      this.expect('}');
      return T('struct:' + name);
    }
    parseCtorInits() {
      const inits = [];
      if (this.accept(':')) {
        do {
          const name = this.ident();
          const close = this.is('{') ? '}' : ')';
          this.next();
          const args = [];
          while (!this.is(close)) { args.push(this.parseAssign()); if (!this.accept(',')) break; }
          this.expect(close);
          inits.push({ name, args });
        } while (this.accept(','));
      }
      return inits;
    }
    parseDims() {
      const dims = [];
      while (this.accept('[')) {
        if (this.accept(']')) { dims.push(null); continue; }
        dims.push(this.parseExpr());
        this.expect(']');
      }
      return dims;
    }
    parseParams() {
      this.expect('(');
      const params = [];
      if (this.is('void') && this.is(')', 1)) { this.i += 2; return params; }
      while (!this.is(')')) {
        if (this.is('...')) this.fail('Variable-length argument lists aren\'t supported');
        const t = { ...this.parseBaseType() };
        while (this.accept('*')) t.p++;
        if (this.accept('&')) t.r = true;
        if (this.is('(')) this.fail('Function pointers aren\'t supported');
        let name = `__p${params.length}`;
        if (this.peek().t === 'id') name = this.ident();
        const dims = this.parseDims();
        if (dims.length) { t.p += 1; t.d = dims.length - 1; }
        const param = { name, type: t, def: null };
        if (this.accept('=')) param.def = this.parseAssign();
        params.push(param);
        if (!this.accept(',')) break;
      }
      this.expect(')');
      return params;
    }
    parseInit() {
      if (this.is('{')) {
        const line = this.next().line;
        const items = [];
        while (!this.is('}')) {
          if (this.is('.') && this.peek(1).t === 'id' && this.is('=', 2)) {
            this.i++;
            const field = this.ident();
            this.i++;
            items.push({ k: 'designated', field, value: this.parseInit() });
          } else items.push(this.parseInit());
          if (!this.accept(',')) break;
        }
        this.expect('}');
        return { k: 'init', items, line };
      }
      return this.parseAssign();
    }
    parseDeclarators(base, isStatic, line) {
      const decls = [];
      do {
        const t = { ...base };
        while (this.accept('*')) t.p++;
        if (this.accept('&')) t.r = true;
        if (this.is('(')) this.fail('Function pointers aren\'t supported');
        const name = this.ident();
        const dims = this.parseDims();
        t.d = dims.length;
        const d = { name, type: t, dims, init: null, args: null, isStatic, line };
        if (this.accept('=')) d.init = this.parseInit();
        else if (this.is('(')) {
          this.i++;
          d.args = [];
          while (!this.is(')')) { d.args.push(this.parseAssign()); if (!this.accept(',')) break; }
          this.expect(')');
        } else if (this.is('{')) d.init = this.parseInit();
        decls.push(d);
      } while (this.accept(','));
      return decls;
    }
    parseTypedef() {
      this.expect('typedef');
      const base = this.parseBaseType();
      const t = { ...base };
      while (this.accept('*')) t.p++;
      if (this.is('(')) this.fail('Function pointer typedefs aren\'t supported');
      const name = this.ident();
      this.expect(';');
      this.aliases.set(name, t);
    }
    parseBlock() {
      const line = this.peek().line;
      this.expect('{');
      const body = [];
      while (!this.is('}')) {
        if (this.peek().t === 'eof') this.fail('Missing "}" before the end of the sketch', this.t[this.t.length - 1] || EOF);
        body.push(this.parseStatement());
      }
      this.expect('}');
      return { k: 'block', body, line };
    }
    parseDeclStatement() {
      const line = this.peek().line;
      if (this.is('typedef')) { this.parseTypedef(); return { k: 'empty', line }; }
      const isStatic = this.accept('static');
      const base = this.parseBaseType();
      if (this.accept(';')) return { k: 'empty', line };
      const decls = this.parseDeclarators(base, isStatic, line);
      this.expect(';');
      return { k: 'decl', decls, line };
    }
    parseStatement() {
      const tk = this.peek();
      const line = tk.line;
      if (this.is('{')) return this.parseBlock();
      if (this.accept(';')) return { k: 'empty', line };
      if (tk.t === 'id') {
        switch (tk.v) {
          case 'if': {
            this.i++; this.expect('(');
            const c = this.parseExpr(); this.expect(')');
            const a = this.parseStatement();
            const b = this.accept('else') ? this.parseStatement() : null;
            return { k: 'if', c, a, b, line };
          }
          case 'while': {
            this.i++; this.expect('(');
            const c = this.parseExpr(); this.expect(')');
            return { k: 'while', c, body: this.parseStatement(), line };
          }
          case 'do': {
            this.i++;
            const body = this.parseStatement();
            this.expect('while'); this.expect('(');
            const c = this.parseExpr(); this.expect(')'); this.expect(';');
            return { k: 'dowhile', c, body, line };
          }
          case 'for': return this.parseFor();
          case 'switch': {
            this.i++; this.expect('(');
            const e = this.parseExpr(); this.expect(')');
            return { k: 'switch', e, body: this.parseBlock(), line };
          }
          case 'case': {
            this.i++;
            const e = this.parseCond(); this.expect(':');
            return { k: 'case', e, line };
          }
          case 'default': this.i++; this.expect(':'); return { k: 'default', line };
          case 'break': this.i++; this.expect(';'); return { k: 'break', line };
          case 'continue': this.i++; this.expect(';'); return { k: 'continue', line };
          case 'return': {
            this.i++;
            const e = this.is(';') ? null : this.parseExpr();
            this.expect(';');
            return { k: 'return', e, line };
          }
          case 'goto': this.fail('goto isn\'t supported');
          case 'delete':
            this.i++;
            if (this.accept('[')) this.expect(']');
            this.parseExpr(); this.expect(';');
            return { k: 'empty', line };
        }
        if (this.startsDecl()) return this.parseDeclStatement();
      }
      const e = this.parseExpr();
      this.expect(';');
      return { k: 'expr', e, line };
    }
    parseFor() {
      const line = this.next().line;
      this.expect('(');
      if (this.startsDecl()) {
        const save = this.i;
        const base = this.parseBaseType();
        const t = { ...base };
        while (this.accept('*')) t.p++;
        this.accept('&');
        if (this.peek().t === 'id' && this.is(':', 1)) {
          const name = this.ident();
          this.i++;
          const e = this.parseExpr();
          this.expect(')');
          return { k: 'range', name, type: t, e, body: this.parseStatement(), line };
        }
        this.i = save;
      }
      let init = null;
      if (!this.accept(';')) {
        if (this.startsDecl()) init = this.parseDeclStatement();
        else { init = { k: 'expr', e: this.parseExpr(), line }; this.expect(';'); }
      }
      const c = this.is(';') ? null : this.parseExpr();
      this.expect(';');
      const step = this.is(')') ? null : this.parseExpr();
      this.expect(')');
      return { k: 'for', init, c, step, body: this.parseStatement(), line };
    }
    parseExpr() {
      let e = this.parseAssign();
      while (this.is(',')) { const line = this.next().line; e = { k: 'comma', a: e, b: this.parseAssign(), line }; }
      return e;
    }
    parseAssign() {
      const left = this.parseCond();
      const p = this.peek();
      if (p.t === 'op' && ASSIGN_OPS.has(p.v)) {
        this.i++;
        const right = this.is('{') ? this.parseInit() : this.parseAssign();
        return { k: 'assign', op: p.v, l: left, r: right, line: p.line };
      }
      return left;
    }
    parseCond() {
      const c = this.parseBin(1);
      if (this.is('?')) {
        const line = this.next().line;
        const a = this.parseAssign();
        this.expect(':');
        return { k: 'cond', c, a, b: this.parseAssign(), line };
      }
      return c;
    }
    parseBin(min) {
      let left = this.parseUnary();
      for (;;) {
        const p = this.peek();
        const prec = p.t === 'op' ? BIN_PREC[p.v] : undefined;
        if (!prec || prec < min) return left;
        this.i++;
        left = { k: 'bin', op: p.v, a: left, b: this.parseBin(prec + 1), line: p.line };
      }
    }
    parseUnary() {
      const p = this.peek();
      if (p.t === 'op') {
        if (['-', '+', '!', '~', '*', '&'].includes(p.v)) { this.i++; return { k: 'un', op: p.v, e: this.parseUnary(), line: p.line }; }
        if (p.v === '++' || p.v === '--') { this.i++; return { k: 'pre', op: p.v, e: this.parseUnary(), line: p.line }; }
        if (p.v === '(' && this.isCastAt(1)) {
          this.i++;
          const t = this.parseCastType();
          this.expect(')');
          return { k: 'cast', t, e: this.parseUnary(), line: p.line };
        }
      }
      return this.parsePostfix();
    }
    parseCastType() {
      const t = { ...this.parseBaseType() };
      while (this.accept('*')) t.p++;
      return t;
    }
    parsePostfix() {
      let e = this.parsePrimary();
      for (;;) {
        const p = this.peek();
        if (p.t !== 'op') return e;
        if (p.v === '[') { this.i++; const i = this.parseExpr(); this.expect(']'); e = { k: 'index', o: e, i, line: p.line }; }
        else if (p.v === '.' || p.v === '->') { this.i++; e = { k: 'member', o: e, name: this.ident(), line: p.line }; }
        else if (p.v === '(') {
          this.i++;
          const args = [];
          while (!this.is(')')) { args.push(this.parseAssign()); if (!this.accept(',')) break; }
          this.expect(')');
          e = { k: 'call', f: e, args, line: p.line, file: p.file };
        } else if (p.v === '++' || p.v === '--') { this.i++; e = { k: 'post', op: p.v, e, line: p.line }; }
        else return e;
      }
    }
    parsePrimary() {
      const p = this.next();
      const line = p.line;
      if (p.t === 'num') return { k: 'num', v: p.v, isFloat: p.isFloat, unsigned: p.unsigned, line };
      if (p.t === 'chr') return { k: 'chr', v: p.v, line };
      if (p.t === 'str') {
        let v = p.v;
        while (this.peek().t === 'str') v += this.next().v;
        return { k: 'str', v, line };
      }
      if (p.t === 'op' && p.v === '(') { const e = this.parseExpr(); this.expect(')'); return e; }
      if (p.t === 'id') {
        if (p.v === 'true') return { k: 'num', v: 1, isBool: true, line };
        if (p.v === 'false') return { k: 'num', v: 0, isBool: true, line };
        if (p.v === 'nullptr' || p.v === 'NULL') return { k: 'num', v: 0, line };
        if (p.v === 'this') return { k: 'this', line };
        if (p.v === 'sizeof') {
          this.expect('(');
          if (this.isCastAt(0)) {
            const t = this.parseCastType();
            this.expect(')');
            return { k: 'sizeofT', t, line };
          }
          const e = this.parseExpr();
          this.expect(')');
          return { k: 'sizeofE', e, line };
        }
        if (p.v === 'new') {
          const t = this.parseBaseType();
          const args = [];
          if (this.accept('(')) {
            while (!this.is(')')) { args.push(this.parseAssign()); if (!this.accept(',')) break; }
            this.expect(')');
          }
          if (this.is('[')) this.fail('new[] isn\'t supported');
          return { k: 'new', t, args, line };
        }
        if (['static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast'].includes(p.v)) {
          this.expect('<');
          const t = this.parseCastType();
          this.expect('>');
          this.expect('(');
          const e = this.parseExpr();
          this.expect(')');
          return { k: 'cast', t, e, line };
        }
        if (TYPE_WORDS.has(p.v) && this.is('(')) {
          this.i++;
          const e = this.parseExpr();
          this.expect(')');
          return { k: 'cast', t: T(mapTypeWords([p.v])), e, line };
        }
        if (this.is('::')) {
          let name = p.v, scope = p.v;
          while (this.accept('::')) { scope = name; name = this.ident(); }
          return { k: 'id', name, scope, line, file: p.file };
        }
        return { k: 'id', name: p.v, line, file: p.file };
      }
      throw new CompileError(`Unexpected "${p.v}"`, p.line, p.file);
    }
    matchParen(start) {
      let depth = 0;
      for (let k = start; k < this.t.length; k++) {
        const x = this.t[k];
        if (x.t !== 'op') continue;
        if (x.v === '(') depth++;
        else if (x.v === ')' && --depth === 0) return k;
      }
      return -1;
    }
    looksLikeParams(k) {
      if (this.is(')', k)) return true;
      const p = this.peek(k);
      if (p.t !== 'id') return false;
      if (TYPE_WORDS.has(p.v) || this.isKnownType(p.v) || p.v === 'struct') return true;
      return this.peek(k + 1).t === 'id';
    }
    parseFunctionRest(ret, name, line, cls) {
      const params = this.parseParams();
      const fn = { name, params, ret, line, cls: cls || null, body: null };
      if (cls && name === cls) fn.inits = this.parseCtorInits();
      if (!this.accept(';')) fn.body = this.parseBlock();
      return fn;
    }
    parseProgram() {
      const prog = { funcs: [], globals: [] };
      while (this.peek().t !== 'eof') {
        const tk = this.peek();
        const line = tk.line;
        if (this.accept(';')) continue;
        if (this.is('template')) this.fail('Templates aren\'t supported');
        if (this.is('namespace')) this.fail('Namespaces aren\'t supported');
        if (this.is('using') || this.is('extern')) {
          if (this.is('extern') && this.peek(1).t === 'str') this.fail('extern "C" blocks aren\'t supported');
          while (!this.accept(';')) { if (this.peek().t === 'eof') this.fail('Missing ";"'); this.next(); }
          continue;
        }
        if (this.is('typedef')) { this.parseTypedef(); continue; }
        if (tk.t !== 'id') this.fail(`Unexpected "${tk.v}" outside a function`);
        // Foo::Foo(...) constructor defined outside its class.
        if (tk.t === 'id' && this.is('::', 1) && (this.peek(2).v === tk.v || this.is('~', 2))) {
          if (this.is('~', 2)) { this.i += 4; this.parseParams(); if (!this.accept(';')) this.parseBlock(); continue; }
          this.i += 3;
          prog.funcs.push(this.parseFunctionRest(VOID, tk.v, line, tk.v));
          continue;
        }
        const isStatic = this.accept('static');
        const base = this.parseBaseType();
        if (this.accept(';')) continue;
        const save = this.i;
        const t = { ...base };
        while (this.accept('*')) t.p++;
        if (this.accept('&')) t.r = true;
        let name = this.ident();
        let cls = null;
        if (this.is('::')) { this.i++; cls = name; name = this.ident(); }
        if (this.is('(')) {
          const close = this.matchParen(this.i);
          if (close < 0) this.fail(`Missing ")" after ${name}`);
          const after = this.t[close + 1] || EOF;
          const isLibOrExt = base.b.startsWith('lib:') || base.b.startsWith('ext:');
          const isBody = after.t === 'op' && (after.v === '{' || after.v === ':');
          const isProto = after.t === 'op' && after.v === ';' && (isLibOrExt ? (this.looksLikeParams(1) && !this.is(')', 1)) : this.looksLikeParams(1));
          if (isBody || isProto) { prog.funcs.push(this.parseFunctionRest(t, name, line, cls)); continue; }
        }
        this.i = save;
        const decls = this.parseDeclarators(base, isStatic, line);
        this.expect(';');
        prog.globals.push(...decls);
      }
      return prog;
    }
  }

  /* ---------- Code generator ---------- */

  const GUARD = 'if(++__R.n>300000)yield -1;';

  class Compiler {
    constructor(prog, parser, notes) {
      this.prog = prog;
      this.parser = parser;
      this.notes = notes;
      this.unsimulated = new Map();
      this.classes = new Map();
      this.scopes = [new Map()];
      this.funcs = new Map();
      this.methods = new Map();
      this.statics = [];
      this.topDecls = [];
      this.autoInits = [];
      this.initBody = [];
      this.output = [];
      this.tempCount = 0;
      this.temps = [];
      this.staticCount = 0;
      this.deviceClasses = [];
      this.cls = null;
      this.fn = null;
    }
    fail(msg, n) { throw new CompileError(msg, n && n.line, n && n.file); }
    note(msg) { this.notes.add(msg); }
    // Remembers the first place each unsupported name is used so the page can link to it.
    missing(label, n) { if (!this.unsimulated.has(label)) this.unsimulated.set(label, { label, line: n.line, file: n.file }); }
    objectLabel(node, fallback) { return node.k === 'id' ? node.name : fallback; }
    temp() { const t = `__t${this.tempCount++}`; this.temps.push(t); return t; }
    push() { this.scopes.push(new Map()); }
    pop() { this.scopes.pop(); }
    declare(name, info) { this.scopes[this.scopes.length - 1].set(name, info); }
    lookup(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const v = this.scopes[i].get(name);
        if (v) return v;
      }
      return null;
    }
    fieldsOf(name) {
      const c = this.classes.get(name);
      if (!c) return [];
      return c.base ? [...this.fieldsOf(c.base), ...c.fields] : c.fields;
    }
    methodsOf(name) {
      const c = this.classes.get(name);
      if (!c) return [];
      return [...(c.base ? this.methodsOf(c.base) : []), ...c.methods];
    }
    sizeOf(t) {
      if (t.p > 0) return 4;
      if (isStruct(t)) return this.fieldsOf(t.b.slice(7)).reduce((s, f) => s + this.sizeOf({ ...f.type, d: 0 }), 0) || 1;
      if (isStr(t)) return 6;
      return SIZES[t.b] || 4;
    }

    /* Conversions */
    wrapInt(js, b) {
      const range = WRAP_RANGE[b];
      if (range && /^-?\d+$/.test(js)) {
        const v = Number(js);
        if (v >= range[0] && v <= range[1]) return js;
      }
      switch (b) {
        case 'u8': return `(${js}&255)`;
        case 'char': case 'i8': return `(${js}<<24>>24)`;
        case 'i16': return `(${js}<<16>>16)`;
        case 'u16': return `(${js}&65535)`;
        case 'i32': return `(${js}|0)`;
        case 'u32': return `(${js}>>>0)`;
        case 'i64': return `Math.trunc(${js})`;
        case 'b': return `(${js}?1:0)`;
      }
      return js;
    }
    conv(e, t) {
      if (isStr(t)) return isStr(e.t) ? e.js : `__S.make(${e.js},"${kindOf(e.t)}")`;
      if (isVal(t) && isStruct(t) && !t.r) return `__R.clone(${e.js})`;
      if (!isVal(t) || !isNum(t) || !isNum(e.t)) return e.js;
      if (t.b === 'f') return e.js;
      if (e.t.b === t.b) return e.js;
      return this.wrapInt(e.js, t.b);
    }

    /* Lvalues */
    lvalue(n) {
      if (n.k === 'id') {
        const info = this.resolveVar(n);
        if (!info) { this.missing(n.name, n); return { get: '0', set: () => '0', t: I32 }; }
        if (info.isRef) return { get: `${info.js}.v`, set: (v) => `${info.js}.v=${v}`, t: info.type };
        return { get: info.js, set: (v) => `${info.js}=${v}`, t: info.type };
      }
      if (n.k === 'index') {
        const o = this.ex(n.o);
        const i = this.ex(n.i);
        const t = this.elemType(o.t);
        if (o.t.d > 0) return { get: `${o.js}[${i.js}]`, read: `(${o.js}[${i.js}]??0)`, set: (v) => `${o.js}[${i.js}]=${v}`, t, base: o, idx: i };
        return { get: `__R.at(${o.js},${i.js})`, set: (v) => `__R.put(${o.js},${i.js},${v})`, t, base: o, idx: i };
      }
      if (n.k === 'member') {
        const r = this.memberRef(n);
        if (r) return r;
        return { get: '0', set: () => '0', t: I32 };
      }
      if (n.k === 'un' && n.op === '*') {
        const p = this.ex(n.e);
        return { get: `__R.deref(${p.js})`, set: (v) => `__R.wr(${p.js},${v})`, t: this.elemType(p.t) };
      }
      this.fail('This expression can\'t be assigned to', n);
    }
    elemType(t) {
      if (t.d > 0) return { ...t, d: t.d - 1 };
      if (t.p > 0) return { ...t, p: t.p - 1 };
      if (isStr(t)) return CHAR;
      return I32;
    }
    memberRef(n) {
      const o = this.ex(n.o);
      if (!isStruct(o.t)) return null;
      const f = this.fieldsOf(o.t.b.slice(7)).find((x) => x.name === n.name);
      if (!f) this.fail(`${o.t.b.slice(7)} has no member named ${n.name}`, n);
      const js = `${o.js}.$${n.name}`;
      return { get: js, set: (v) => `${js}=${v}`, t: f.type };
    }
    resolveVar(n) {
      const v = this.lookup(n.name);
      if (v) return v;
      if (this.cls) {
        const f = this.fieldsOf(this.cls).find((x) => x.name === n.name);
        if (f) return { js: `__this.$${n.name}`, type: f.type };
      }
      return null;
    }

    /* Expressions */
    ex(n) {
      switch (n.k) {
        case 'num':
          if (n.isFloat) return { js: Number.isFinite(n.v) ? String(n.v) : '0', t: FLT };
          return { js: String(n.v), t: n.isBool ? T('b') : n.unsigned || n.v > 2147483647 ? U32 : I32 };
        case 'chr': return { js: String(n.v), t: CHAR };
        case 'str': return { js: JSON.stringify(n.v), t: CSTR };
        case 'this': return { js: '__this', t: T('struct:' + this.cls, 1) };
        case 'id': return this.idExpr(n);
        case 'comma': { const a = this.ex(n.a), b = this.ex(n.b); return { js: `(${a.js},${b.js})`, t: b.t }; }
        case 'cond': {
          const c = this.ex(n.c), a = this.ex(n.a), b = this.ex(n.b);
          const t = isF(a.t) || isF(b.t) ? FLT : isStr(a.t) || isStr(b.t) ? STRING : a.t;
          return { js: `(${c.js}?${a.js}:${b.js})`, t };
        }
        case 'cast': return this.castExpr(n);
        case 'sizeofT': return { js: String(this.sizeOf(n.t)), t: U32 };
        case 'sizeofE': {
          if (n.e.k === 'str') return { js: String(n.e.v.length + 1), t: U32 };
          const e = this.ex(n.e);
          if (e.t.d > 0) return { js: `__R.szof(${e.js},${this.sizeOf({ ...e.t, d: 0 })})`, t: U32 };
          return { js: String(this.sizeOf(e.t)), t: U32 };
        }
        case 'bin': return this.binExpr(n);
        case 'un': return this.unExpr(n);
        case 'pre': case 'post': return this.incExpr(n);
        case 'assign': return this.assignExpr(n);
        case 'index': {
          const l = this.lvalue(n);
          return { js: l.read || l.get, t: l.t };
        }
        case 'member': {
          const o = this.ex(n.o);
          if (isStruct(o.t)) { const r = this.memberRef(n); return { js: r.get, t: r.t }; }
          this.missing(`${this.objectLabel(n.o, '')}.${n.name}`, n);
          return { js: '0', t: I32 };
        }
        case 'call': return this.callExpr(n);
        case 'new': {
          if (isStruct(n.t)) return { js: this.construct(n.t.b.slice(7), n.args, n), t: { ...n.t, p: 1 } };
          this.fail('new is only supported for structs and classes', n);
        }
        case 'init': this.fail('A brace list can\'t be used here', n);
      }
      this.fail(`Unsupported expression (${n.k})`, n);
    }
    idExpr(n) {
      const info = this.resolveVar(n);
      if (info) return { js: info.isRef ? `${info.js}.v` : info.js, t: info.type };
      const name = n.name;
      const enums = this.parser.enumValues();
      if (enums.has(name)) return { js: String(enums.get(name)), t: I32 };
      if (Object.prototype.hasOwnProperty.call(OLED.CONSTS, name)) {
        const v = OLED.CONSTS[name];
        return { js: String(v), t: Number.isInteger(v) ? I32 : FLT };
      }
      if (OLED.isFontName(name)) return { js: JSON.stringify(name), t: CSTR };
      this.missing(name, n);
      return { js: '0', t: I32 };
    }
    castExpr(n) {
      const e = this.ex(n.e);
      const t = n.t;
      if (isVal(t) && isStr(t)) return { js: `__S.make(${e.js},"${kindOf(e.t)}")`, t };
      if (isVal(t) && t.b === 'f') return { js: e.js, t };
      if (isVal(t) && INT_BASES.has(t.b) && isNum(e.t)) return { js: this.wrapInt(e.js, t.b), t };
      return { js: e.js, t: isPtr(t) ? t : e.t };
    }
    binExpr(n) {
      const op = n.op;
      if (op === '&&') { const a = this.ex(n.a), b = this.ex(n.b); return { js: `(${a.js}&&${b.js}?1:0)`, t: T('b') }; }
      if (op === '||') { const a = this.ex(n.a), b = this.ex(n.b); return { js: `(${a.js}||${b.js}?1:0)`, t: T('b') }; }
      return this.applyBin(op, this.ex(n.a), this.ex(n.b));
    }
    applyBin(op, a, b) {
      if (op === '==' || op === '!=') return { js: `(${a.js}${op === '==' ? '===' : '!=='}${b.js}?1:0)`, t: T('b') };
      if (['<', '>', '<=', '>='].includes(op)) return { js: `(${a.js}${op}${b.js}?1:0)`, t: T('b') };
      if (op === '+' && (isStr(a.t) || isStr(b.t))) return { js: `__S.concat(${a.js},"${kindOf(a.t)}",${b.js},"${kindOf(b.t)}")`, t: STRING };
      if (op === '+' && isPtr(a.t)) return { js: `__R.padd(${a.js},${b.js})`, t: a.t.d ? { ...a.t, d: a.t.d - 1, p: a.t.p + 1 } : a.t };
      if (op === '+' && isPtr(b.t)) return { js: `__R.padd(${b.js},${a.js})`, t: b.t.d ? { ...b.t, d: b.t.d - 1, p: b.t.p + 1 } : b.t };
      if (op === '-' && isPtr(a.t) && !isPtr(b.t)) return { js: `__R.padd(${a.js},-(${b.js}))`, t: a.t.d ? { ...a.t, d: a.t.d - 1, p: a.t.p + 1 } : a.t };
      if (op === '-' && isPtr(a.t)) return { js: `__R.pdiff(${a.js},${b.js})`, t: I32 };
      if (isF(a.t) || isF(b.t)) {
        if (op === '%') return { js: `(${a.js}%${b.js})`, t: FLT };
        if (['+', '-', '*', '/'].includes(op)) return { js: `(${a.js}${op}${b.js})`, t: FLT };
      }
      const r = promote(a.t, b.t);
      const seal = (js, t) => (t.b === 'u32' ? { js: `(${js}>>>0)`, t } : t.b === 'i64' ? { js: `(${js})`, t } : { js: `(${js}|0)`, t });
      switch (op) {
        case '+': case '-': return seal(`${a.js}${op}${b.js}`, r);
        case '*': return r.b === 'i64' ? { js: `(${a.js}*${b.js})`, t: r } : seal(`Math.imul(${a.js},${b.js})`, r);
        case '/': return { js: `__R.idiv(${a.js},${b.js})`, t: r };
        case '%': return { js: `__R.imod(${a.js},${b.js})`, t: r };
        case '&': case '|': case '^': return r.b === 'i64' ? { js: `__R.big("${op}",${a.js},${b.js})`, t: r } : seal(`${a.js}${op}${b.js}`, r);
        case '<<': {
          const lt = promote(a.t, I32);
          if (lt.b === 'i64') return { js: `(${a.js}*2**${b.js})`, t: lt };
          return seal(`${a.js}<<${b.js}`, lt);
        }
        case '>>': {
          const lt = promote(a.t, I32);
          if (lt.b === 'i64') return { js: `Math.floor(${a.js}/2**${b.js})`, t: lt };
          return { js: `(${a.js}${lt.b === 'u32' ? '>>>' : '>>'}${b.js})`, t: lt };
        }
      }
      throw new CompileError(`Unsupported operator ${op}`, 0);
    }
    unExpr(n) {
      if (n.op === '&') return this.addressOf(n);
      if (n.op === '*') {
        const p = this.ex(n.e);
        if (isVal(p.t) && isStruct(p.t)) return p;
        return { js: `__R.deref(${p.js})`, t: this.elemType(p.t) };
      }
      const e = this.ex(n.e);
      switch (n.op) {
        case '!': return { js: `(${e.js}?0:1)`, t: T('b') };
        case '-': return isF(e.t) ? { js: `(-${e.js})`, t: FLT } : this.wrapped(`(-(${e.js}))`, e.t);
        case '+': return e;
        case '~': return this.wrapped(`(~${e.js})`, e.t);
      }
    }
    wrapped(js, t) {
      const r = promote(t, I32);
      return { js: r.b === 'u32' ? `(${js}>>>0)` : js, t: r };
    }
    addressOf(n) {
      if (n.e.k === 'index') {
        const l = this.lvalue(n.e);
        if (isVal(l.t) && isStruct(l.t)) return { js: l.get, t: { ...l.t, p: 1 } };
        return { js: `__R.ptr(${l.base.js},${l.idx.js})`, t: { ...l.t, p: l.t.p + 1 } };
      }
      const probe = this.ex(n.e);
      if (!isNum(probe.t) && !isStr(probe.t)) return probe;
      return { js: this.refOf(n.e), t: { ...probe.t, p: 1 } };
    }
    refOf(node) {
      const l = this.lvalue(node);
      return `__R.ref(()=>${l.get},(__v)=>{${l.set('__v')}})`;
    }
    assignExpr(n) {
      if (n.r.k === 'init') {
        const l = this.lvalue(n.l);
        return { js: `(${l.set(this.initFor(l.t, n.l.dims || [], n.r))})`, t: l.t };
      }
      const l = this.lvalue(n.l);
      const r = this.ex(n.r);
      if (n.op === '=') {
        if (l.t.d > 0) this.fail('Arrays can\'t be assigned with =', n);
        return { js: `(${l.set(this.conv(r, l.t))})`, t: l.t };
      }
      const value = this.applyBin(n.op.slice(0, -1), { js: l.get, t: l.t }, r);
      return { js: `(${l.set(this.conv(value, l.t))})`, t: l.t };
    }
    incExpr(n) {
      const l = this.lvalue(n.e);
      const delta = n.op === '++' ? 1 : -1;
      const next = (cur) => {
        if (isPtr(l.t)) return `__R.padd(${cur},${delta})`;
        return this.conv({ js: `${cur}+${delta}`, t: isF(l.t) ? FLT : T('i64') }, l.t);
      };
      if (n.k === 'pre') return { js: `(${l.set(next(l.get))})`, t: l.t };
      const tmp = this.temp();
      return { js: `(${tmp}=${l.get},${l.set(next(tmp))},${tmp})`, t: l.t };
    }

    /* Calls */
    pickOverload(list, args) {
      const n = args.length;
      const fits = list.filter((f) => n <= f.params.length && n >= f.params.filter((p) => !p.def).length);
      if (fits.length <= 1) return fits[0];
      const score = (f) => args.reduce((s, a, i) => {
        const p = f.params[i].type;
        return s + (isF(a.t) === isF(p) ? 1 : 0) + (kindOf(a.t) === kindOf(p) ? 2 : 0);
      }, 0);
      return fits.reduce((best, f) => (score(f) > score(best) ? f : best));
    }
    argsFor(fn, argNodes, compiled, n) {
      return fn.params.map((p, i) => {
        if (i < argNodes.length) {
          if (p.type.r && isVal(p.type) && (isNum(p.type) || isStr(p.type))) return this.refOf(argNodes[i]);
          return this.conv(compiled[i], p.type);
        }
        return this.conv(this.ex(p.def), p.type);
      });
    }
    callUser(fn, argNodes, n, self) {
      const compiled = argNodes.map((a) => this.ex(a));
      const fnIdList = fn;
      const pick = this.pickOverload(fnIdList, compiled);
      if (!pick) this.fail(`No version of ${fn[0].name} takes ${argNodes.length} argument${argNodes.length === 1 ? '' : 's'}`, n);
      if (!pick.body) { this.missing(`${pick.name}()`, n); return { js: '0', t: pick.ret }; }
      const args = this.argsFor(pick, argNodes, compiled, n);
      if (self) args.unshift(self);
      return { js: `(yield* ${pick.jsName}(${args.join(',')}))`, t: { ...pick.ret, r: false } };
    }
    construct(cname, argNodes, n) {
      const c = this.classes.get(cname);
      if (!c) this.fail(`${cname} is used before it's defined`, n);
      if (!c.ctors.length || (c.ctors.every((x) => !x.body) )) {
        if (argNodes.length) return this.initFor(T('struct:' + cname), [], { k: 'init', items: argNodes, line: n.line }, true);
        return `__new_${cname}()`;
      }
      const compiled = argNodes.map((a) => this.ex(a));
      const pick = this.pickOverload(c.ctors, compiled);
      if (!pick) {
        if (!argNodes.length) return `__new_${cname}()`;
        this.fail(`No constructor of ${cname} takes ${argNodes.length} argument${argNodes.length === 1 ? '' : 's'}`, n);
      }
      const args = this.argsFor(pick, argNodes, compiled, n);
      return `(yield* __R.mk(__new_${cname}(),${pick.jsName},[${args.join(',')}]))`;
    }
    callExpr(n) {
      const f = n.f;
      if (f.k === 'id') return this.callNamed(f.name, n);
      if (f.k === 'member') return this.callMember(f, n);
      this.fail('Only named functions and methods can be called', n);
    }
    callNamed(name, n) {
      if (name === 'String') {
        const a = n.args.map((x) => this.ex(x));
        if (!a.length) return { js: '""', t: STRING };
        return { js: `__S.make(${a[0].js},"${kindOf(a[0].t)}"${a[1] ? ',' + a[1].js : ''})`, t: STRING };
      }
      if (this.cls) {
        const ms = this.methodsOf(this.cls).filter((m) => m.name === name);
        if (ms.length) return this.callUser(ms, n.args, n, '__this');
      }
      if (this.funcs.has(name)) return this.callUser(this.funcs.get(name), n.args, n);
      if (this.classes.has(name)) return { js: this.construct(name, n.args, n), t: T('struct:' + name) };
      if (name === 'delay') return { js: `(yield Math.max(0,${this.ex(n.args[0] || { k: 'num', v: 0 }).js}))`, t: VOID };
      if (name === 'delayMicroseconds') return { js: `(yield Math.max(0,${this.ex(n.args[0] || { k: 'num', v: 0 }).js})/1000)`, t: VOID };
      if (name === 'yield') return { js: '(yield 0)', t: VOID };
      if (Object.prototype.hasOwnProperty.call(OLED.Builtins, name)) {
        const a = n.args.map((x) => this.ex(x));
        const spec = OLED.BuiltinTypes[name] || 'i32';
        let t;
        if (spec === 'promote') t = a.some((x) => isF(x.t)) ? FLT : a.reduce((acc, x) => promote(acc, x.t), I32);
        else if (spec === 'cstr') t = CSTR;
        else t = T(spec);
        return { js: `__B.${name}(${a.map((x) => x.js).join(',')})`, t };
      }
      this.missing(`${name}()`, n);
      return { js: '0', t: I32 };
    }
    autoDevice(name, method) {
      if (this.lookup(name)) return;
      const cls = OLED.guessDeviceClass(name, method);
      if (!cls) return;
      const js = `$${name}`;
      this.topDecls.push(js);
      this.autoInits.push(`${js}=__L.make(__R,"${cls}",[]);`);
      this.scopes[0].set(name, { js, type: T('lib:' + cls) });
      this.deviceClasses.push(cls);
      this.note(`${name} isn't declared, so a 128 × 64 ${cls.startsWith('U8G2') ? 'U8g2' : 'Adafruit_SSD1306'} display is assumed.`);
    }
    callMember(f, n) {
      if (f.o.k === 'id' && !this.resolveVar(f.o)) {
        this.autoDevice(f.o.name, f.name);
        if (!this.resolveVar(f.o)) {
          this.missing(`${f.o.name}.${f.name}()`, n);
          return { js: '0', t: I32 };
        }
      }
      const o = this.ex(f.o);
      const name = f.name;
      if (isStr(o.t)) return this.stringMethod(f, o, n);
      if (isStruct(o.t)) {
        const cname = o.t.b.slice(7);
        const ms = this.methodsOf(cname).filter((m) => m.name === name);
        if (!ms.length) this.fail(`${cname} has no method named ${name}`, n);
        return this.callUser(ms, n.args, n, o.js);
      }
      if (o.t.b.startsWith('lib:')) return this.libCall(o, o.t.b.slice(4), name, n);
      this.missing(`${this.objectLabel(f.o, o.t.b.startsWith('ext:') ? o.t.b.slice(4) : '')}.${name}()`, n);
      return { js: '0', t: I32 };
    }
    stringMethod(f, o, n) {
      const name = f.name;
      const args = n.args.map((a) => this.ex(a));
      const spec = OLED.StringMethods[name];
      if (!spec) { this.missing(`${this.objectLabel(f.o, 'String')}.${name}()`, n); return { js: '0', t: I32 }; }
      const kinds = name === 'concat' ? [`"${kindOf(args[0].t)}"`] : [];
      const call = `__S.m_${name}(${[o.js, ...args.map((a) => a.js), ...kinds].join(',')})`;
      if (spec === 'mutate') {
        const l = this.lvalue(f.o);
        return { js: `(${l.set(call)})`, t: STRING };
      }
      return { js: call, t: spec === 'cstr' ? CSTR : T(spec) };
    }
    libCall(o, cls, name, n) {
      const C = OLED.resolveLib(cls);
      const args = n.args.map((a) => this.ex(a));
      if (name === 'print' || name === 'println') {
        const a = args[0] || { js: '""', t: CSTR };
        return { js: `${o.js}.m_${name}(${a.js},"${kindOf(a.t)}"${args[1] ? ',' + args[1].js : ''})`, t: I32 };
      }
      if (!(('m_' + name) in C.prototype)) {
        this.missing(`${this.objectLabel(n.f.o, cls)}.${name}()`, n);
        return { js: '0', t: I32 };
      }
      const list = args.map((a) => (isF(a.t) && !C.FLOAT_ARGS?.has(name) ? `(${a.js}|0)` : a.js)).join(',');
      const js = `${o.js}.m_${name}(${list})`;
      return { js: C.YIELDS.has(name) ? `(yield ${js})` : js, t: T(C.RETURNS?.[name] || 'i32') };
    }

    /* Initialisers */
    zero(t, dims, n) {
      if (dims && dims.length) {
        const sizes = dims.map((d) => {
          if (d === null) this.fail('This array needs a size or a list of values', n);
          return this.ex(d).js;
        });
        return `__R.arr([${sizes.join(',')}],()=>${this.zero({ ...t, d: 0 })})`;
      }
      if (t.p > 0) return '0';
      if (isStr(t)) return '""';
      if (isStruct(t)) return `__new_${t.b.slice(7)}()`;
      if (t.b.startsWith('lib:')) return `__L.make(__R,${JSON.stringify(t.b.slice(4))},[])`;
      if (t.b.startsWith('ext:')) return '({})';
      return '0';
    }
    initFor(t, dims, init, forceAggregate) {
      if (dims.length) return this.arrayInit({ ...t, d: 0 }, dims, 0, init);
      if (init.k === 'init') {
        if (isStruct(t) && !t.p) {
          const cname = t.b.slice(7);
          const c = this.classes.get(cname);
          if (!forceAggregate && c && c.ctors.some((x) => x.body)) return this.construct(cname, init.items, init);
          const fields = this.fieldsOf(cname);
          const parts = init.items.map((item, i) => {
            const field = item.k === 'designated' ? fields.find((f) => f.name === item.field) : fields[i];
            const value = item.k === 'designated' ? item.value : item;
            if (!field) this.fail(`Too many values for ${cname}`, init);
            return `$${field.name}:${this.initFor(field.type, field.dims, value)}`;
          });
          return `Object.assign(__new_${cname}(),{${parts.join(',')}})`;
        }
        if (init.items.length === 0) return this.zero(t);
        return this.initFor(t, dims, init.items[0]);
      }
      return this.conv(this.ex(init), t);
    }
    arrayInit(t, dims, depth, init) {
      const remaining = dims.slice(depth + 1);
      let lenJs = dims[depth] ? this.ex(dims[depth]).js : null;
      if (init.k === 'str' && t.b !== 'String' && !remaining.length && !t.p) {
        return `__R.strArr(${JSON.stringify(init.v)},${lenJs ?? init.v.length + 1})`;
      }
      if (init.k !== 'init') this.fail('Arrays need a list of values in braces', init);
      let items = init.items;
      // A flat list for a multi-dimensional array, e.g. int a[2][2] = {1,2,3,4}.
      if (remaining.length && items.length && items.every((x) => x.k !== 'init' && x.k !== 'str')) {
        let inner = 1;
        try { remaining.forEach((d) => (inner *= constEval(d, this.parser.enumValues()))); } catch (e) { inner = 0; }
        if (inner > 0) {
          const chunks = [];
          for (let i = 0; i < items.length; i += inner) chunks.push({ k: 'init', items: items.slice(i, i + inner), line: init.line });
          items = chunks;
        }
      }
      const parts = items.map((item) => (remaining.length ? this.arrayInit(t, dims, depth + 1, item) : this.initFor(t, [], item)));
      const literal = `[${parts.join(',')}]`;
      if (lenJs === null || Number(lenJs) === items.length) return literal;
      return `__R.fill(${literal},${lenJs},()=>${remaining.length ? this.zero(t, remaining) : this.zero(t)})`;
    }
    declInit(d) {
      const t = d.type;
      if (t.b === 'auto') {
        if (!d.init) this.fail(`auto variable ${d.name} needs a value`, d);
        const e = this.ex(d.init);
        d.type = { ...e.t, r: false };
        return e.js;
      }
      if (t.b.startsWith('lib:') && !t.p && !d.dims.length) {
        const args = (d.args || []).map((a) => this.ex(a).js);
        this.deviceClasses.push(t.b.slice(4));
        return `__L.make(__R,${JSON.stringify(t.b.slice(4))},[${args.join(',')}])`;
      }
      if (isStruct(t) && !t.p && !t.r && !d.dims.length) {
        const cname = t.b.slice(7);
        if (d.args) return this.construct(cname, d.args, d);
        if (d.init) return this.initFor(t, [], d.init);
        return this.construct(cname, [], d);
      }
      if (d.dims.length) {
        if (d.init) return this.initFor({ ...t, d: 0 }, d.dims, d.init);
        return this.zero({ ...t, d: 0 }, d.dims, d);
      }
      if (d.args && d.args.length) return this.conv(this.ex(d.args[0]), t);
      if (d.init) return this.initFor(t, [], d.init);
      return this.zero(t);
    }

    /* Statements */
    stmt(n) {
      const at = n.line ? `__R.l=${n.line};` : '';
      switch (n.k) {
        case 'empty': return '';
        case 'block': {
          this.push();
          const body = n.body.map((s) => this.stmt(s)).join('\n');
          this.pop();
          return `{${body}}`;
        }
        case 'expr': return `${at}${this.ex(n.e).js};`;
        case 'decl': return n.decls.map((d) => this.localDecl(d, at)).join('');
        case 'if': {
          const c = this.ex(n.c).js;
          return `${at}if(${c}){${this.scoped(n.a)}}${n.b ? `else{${this.scoped(n.b)}}` : ''}`;
        }
        case 'while': return `while(${this.ex(n.c).js}){${GUARD}${at}${this.scoped(n.body)}}`;
        case 'dowhile': return `do{${GUARD}${this.scoped(n.body)}}while(${this.ex(n.c).js});`;
        case 'for': {
          this.push();
          const init = n.init ? this.stmt(n.init) : '';
          const c = n.c ? this.ex(n.c).js : '';
          const step = n.step ? this.ex(n.step).js : '';
          const body = this.scoped(n.body);
          this.pop();
          return `{${init}for(;${c};${step}){${GUARD}${body}}}`;
        }
        case 'range': {
          this.push();
          const e = this.ex(n.e);
          const t = n.type.b === 'auto' ? { ...this.elemType(e.t), r: false } : n.type;
          this.declare(n.name, { js: `$${n.name}`, type: t });
          const body = this.scoped(n.body);
          this.pop();
          return `for(const $${n.name} of __R.iter(${e.js})){${GUARD}${body}}`;
        }
        case 'switch': {
          const e = this.ex(n.e).js;
          this.push();
          const body = n.body.body.map((s) => this.stmt(s)).join('\n');
          this.pop();
          return `${at}switch(${e}){${body}}`;
        }
        case 'case': return `case ${this.ex(n.e).js}:`;
        case 'default': return 'default:';
        case 'break': return 'break;';
        case 'continue': return 'continue;';
        case 'return': {
          if (!n.e) return 'return;';
          const e = this.ex(n.e);
          const ret = this.fn && this.fn.ret;
          return `${at}return ${ret && ret.b !== 'void' ? this.conv(e, { ...ret, r: false }) : e.js};`;
        }
      }
      this.fail(`Unsupported statement (${n.k})`, n);
    }
    scoped(n) {
      this.push();
      const js = this.stmt(n);
      this.pop();
      return js;
    }
    localDecl(d, at) {
      if (d.isStatic) {
        const js = `$s${this.staticCount++}_${d.name}`;
        const savedFn = this.temps;
        const init = this.declInit(d);
        this.temps = savedFn;
        this.topDecls.push(js);
        this.statics.push(`${js}=${init};`);
        this.declare(d.name, { js, type: d.type });
        return '';
      }
      const js = `$${d.name}`;
      if (d.type.r && d.init && isVal(d.type) && (isNum(d.type) || isStr(d.type))) {
        const ref = this.refOf(d.init);
        this.declare(d.name, { js, type: d.type, isRef: true });
        return `${at}let ${js}=${ref};`;
      }
      const init = this.declInit(d);
      this.declare(d.name, { js, type: d.type });
      return `${at}let ${js}=${init};`;
    }

    /* Program */
    registerFunctions() {
      for (const [name, c] of this.parser.classes) {
        if (c) this.classes.set(name, c);
        else this.note(`${name} is declared but never defined.`);
      }
      let id = 0;
      const addDefaults = (target, proto) => proto.params.forEach((p, i) => { if (p.def && target.params[i] && !target.params[i].def) target.params[i].def = p.def; });
      for (const c of this.classes.values()) {
        c.methods.forEach((m) => (m.jsName = `$m${id++}_${m.name}`));
        c.ctors.forEach((m) => (m.jsName = `$c${id++}_${m.cls}`));
      }
      for (const fn of this.prog.funcs) {
        if (fn.cls) {
          const c = this.classes.get(fn.cls);
          if (!c) this.fail(`${fn.cls} isn't a known class`, fn);
          const list = fn.name === fn.cls ? c.ctors : c.methods;
          const existing = list.find((m) => m.name === fn.name && m.params.length === fn.params.length && !m.body);
          if (existing) {
            existing.params = fn.params.map((p, i) => ({ ...p, def: p.def || existing.params[i].def }));
            existing.body = fn.body;
            existing.ret = fn.ret;
            if (fn.inits) existing.inits = fn.inits;
          } else { fn.jsName = `$m${id++}_${fn.name}`; list.push(fn); }
          continue;
        }
        const list = this.funcs.get(fn.name) || [];
        this.funcs.set(fn.name, list);
        const same = list.find((f) => f.params.length === fn.params.length && f.params.every((p, i) => p.type.b === fn.params[i].type.b && p.type.p === fn.params[i].type.p));
        if (same) {
          if (fn.body) { addDefaults(fn, same); same.params = fn.params; same.body = fn.body; same.ret = fn.ret; }
          else addDefaults(same, fn);
          continue;
        }
        fn.jsName = `$f${id++}_${fn.name}`;
        list.push(fn);
      }
    }
    emitFunction(fn, cname) {
      if (!fn.body) return;
      this.fn = fn;
      this.cls = cname;
      this.temps = [];
      this.push();
      const names = [];
      if (cname) names.push('__this');
      for (const p of fn.params) {
        names.push(`$${p.name}`);
        this.declare(p.name, { js: `$${p.name}`, type: p.type, isRef: p.type.r && isVal(p.type) && (isNum(p.type) || isStr(p.type)) });
      }
      let body = '';
      if (fn.inits) {
        for (const init of fn.inits) {
          const field = this.fieldsOf(cname).find((f) => f.name === init.name);
          if (field) {
            const value = init.args.length === 1 ? this.conv(this.ex(init.args[0]), field.type) : init.args.length ? this.fail(`${init.name} takes one value`, fn) : this.zero(field.type, field.dims);
            body += `__this.$${init.name}=${value};`;
          } else if (this.classes.has(init.name)) {
            const base = this.classes.get(init.name);
            const compiled = init.args.map((a) => this.ex(a));
            const pick = this.pickOverload(base.ctors, compiled);
            if (pick) body += `yield* ${pick.jsName}(__this,${this.argsFor(pick, init.args, compiled, fn).join(',')});`;
          }
        }
      }
      body += this.stmt(fn.body);
      this.pop();
      const temps = this.temps.length ? `let ${this.temps.join(',')};` : '';
      this.output.push(`function* ${fn.jsName}(${names.join(',')}){${GUARD}${temps}${body}}`);
      this.fn = null;
      this.cls = null;
    }
    emitClass(c) {
      const fields = this.fieldsOf(c.name);
      this.temps = [];
      const parts = fields.map((f) => {
        const value = f.init ? this.initFor(f.type, f.dims, f.init) : this.zero({ ...f.type, d: 0 }, f.dims);
        return `$${f.name}:${value}`;
      });
      this.output.push(`function __new_${c.name}(){return {${parts.join(',')}};}`);
    }
    compile(wrapped) {
      this.registerFunctions();
      for (const g of OLED.GLOBAL_OBJECTS) {
        this.scopes[0].set(g.name, { js: `$${g.name}`, type: T('lib:' + g.cls) });
        this.topDecls.push(`$${g.name}`);
        this.autoInits.push(`$${g.name}=__L.make(__R,"${g.cls}",[]);`);
      }
      this.temps = [];
      for (const c of this.classes.values()) this.emitClass(c);
      this.temps = [];
      const initTemps = [];
      for (const g of this.prog.globals) {
        const js = `$${g.name}`;
        this.temps = [];
        this.scopes[0].set(g.name, { js, type: g.type });
        const init = this.declInit(g);
        this.scopes[0].set(g.name, { js, type: g.type });
        initTemps.push(...this.temps);
        this.topDecls.push(js);
        this.initBody.push(`__R.l=${g.line || 0};${js}=${init};`);
      }
      for (const c of this.classes.values()) {
        c.methods.forEach((m) => this.emitFunction(m, c.name));
        c.ctors.forEach((m) => this.emitFunction(m, c.name));
      }
      for (const list of this.funcs.values()) list.forEach((f) => this.emitFunction(f, null));
      const entry = (name) => {
        const list = this.funcs.get(name);
        const f = list && list.find((x) => x.params.length === 0 && x.body);
        return f || null;
      };
      const setup = entry('setup'), loop = entry('loop');
      const loopEmpty = !loop || loop.body.body.length === 0;
      const decls = this.topDecls.length ? `let ${[...new Set(this.topDecls)].join(',')};` : '';
      const temps = initTemps.length ? `let ${initTemps.join(',')};` : '';
      const main = `function* __main(){${temps}${this.autoInits.join('')}${this.statics.join('')}${this.initBody.join('\n')}
${setup ? `yield* ${setup.jsName}();` : ''}
${wrapped ? '__R.finishSnippet();' : ''}
${loopEmpty ? '' : `for(;;){yield* ${loop.jsName}();${GUARD}}`}}`;
      return `"use strict";\n${decls}\n${this.output.join('\n')}\n${main}\nreturn __main();`;
    }
  }

  /* ---------- Entry point ---------- */

  OLED.CompileError = CompileError;
  OLED.compile = function compile(source, files = {}) {
    const notes = new Set();
    const pre = preprocess(source, files, notes);
    let tokens = pre.tokens;
    const hasFn = (name) => tokens.some((t, i) => t.t === 'id' && t.v === name && tokens[i + 1] && tokens[i + 1].v === '(' && tokens[i - 1] && tokens[i - 1].t === 'id' && tokens[i - 1].v === 'void' && t.file === null);
    const hasSetup = hasFn('setup'), hasLoop = hasFn('loop');
    let wrapped = false;
    const synth = (text) => tokenize(text, 0, '<generated>');
    if (!hasSetup && !hasLoop) {
      const firstUser = tokens.findIndex((t) => t.file === null);
      const preamble = firstUser < 0 ? tokens : tokens.slice(0, firstUser);
      const body = firstUser < 0 ? [] : tokens.slice(firstUser);
      tokens = [...preamble, ...synth('void setup() {'), ...body, ...synth('} void loop() {}')];
      wrapped = true;
      notes.add('No setup() or loop() found, so the code runs once as a snippet.');
    } else if (!hasSetup) tokens = [...tokens, ...synth('void setup() {}')];
    else if (!hasLoop) tokens = [...tokens, ...synth('void loop() {}')];

    const aliases = new Map();
    const parser = new Parser(tokens, aliases);
    const prog = parser.parseProgram();
    const compiler = new Compiler(prog, parser, notes);
    const js = compiler.compile(wrapped);
    const factory = new Function('__R', '__B', '__L', '__S', js);
    return { factory, notes: [...notes], unsimulated: [...compiler.unsimulated.values()], includes: pre.includes, wrapped, js };
  };
})();
