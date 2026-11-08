(function () {
  const OLED = globalThis.OLED;
  const $ = (id) => document.getElementById(id);
  const el = {
    code: $('code'), gutter: $('gutter'), errorBar: $('errorBar'), message: $('message'), fileName: $('fileName'), extra: $('extraFiles'),
    screen: $('screen'), glow: $('glow'), glass: $('glass'), status: $('status'), pause: $('pause'), step: $('step'), restart: $('restart'),
    speed: $('speed'), panel: $('panel'), save: $('save'), examples: $('examples'), open: $('open'), file: $('file'),
    inputsBlock: $('inputsBlock'), inputs: $('inputs'), screensBlock: $('screensBlock'), screens: $('screens'),
    unsimulated: $('unsimulated'), unsimulatedList: $('unsimulatedList'), notesBlock: $('notesBlock'), notes: $('notes'), serialBlock: $('serialBlock'), serial: $('serial'), codePanel: $('codePanel'), traces: $('traces'),
  };
  const ctx = el.screen.getContext('2d');
  const glowCtx = el.glow.getContext('2d');
  const LINE_HEIGHT = 21;
  const SCREEN_HOLD_MS = 250;
  const MAX_SCREENS = 24;

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* Private windows can block storage. */ } },
  };

  const state = {
    sim: null, device: null, compiled: null, paused: false, speed: 1, panel: store.get('oled.panel') || 'white',
    files: {}, loadedFromExample: false, name: 'sketch.ino', held: null, screenHashes: new Set(), pinnedScreen: null,
    analogMemory: new Map(), serialBuffer: '', serialText: '', notes: new Set(), scale: 1, statusAt: 0,
  };

  /* ---------- Drawing ---------- */

  const COLORS = { white: ['#eaf6ff', '#eaf6ff'], blue: ['#62ccff', '#62ccff'], bicolor: ['#ffdc52', '#62ccff'] };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  function rowColor(y, H) {
    const [top, rest] = COLORS[state.panel];
    return H === 64 && y < 16 ? top : rest;
  }

  function composed(dev) {
    const { W, H, front, scroll } = dev;
    let pix = front;
    if (scroll) {
      const out = new Uint8Array(W * H);
      const steps = Math.floor((state.sim.vt - scroll.t0) / 50);
      const xShift = (((steps * scroll.dir) % W) + W) % W;
      const yShift = scroll.diag ? steps % H : 0;
      for (let y = 0; y < H; y++) {
        const page = y >> 3;
        const moves = page >= scroll.start && page <= scroll.stop;
        const srcY = (y + yShift) % H;
        for (let x = 0; x < W; x++) out[y * W + (moves ? (x + xShift) % W : x)] = front[srcY * W + x];
      }
      pix = out;
    }
    if (dev.inverted) { const out = new Uint8Array(W * H); for (let i = 0; i < out.length; i++) out[i] = pix[i] ^ 1; pix = out; }
    return pix;
  }

  function fillThumb(canvas, pix, W, H) {
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext('2d');
    const img = c.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const [r, g, b] = rgb(rowColor(y, H));
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (pix[y * W + x]) { img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255; }
      }
    }
    c.putImageData(img, 0, 0);
  }

  function paintPixels(pix, W, H, dimmed) {
    const s = state.scale;
    const gap = s >= 4 ? Math.max(1, Math.round(s * 0.12)) : 0;
    const size = s - gap;
    ctx.clearRect(0, 0, el.screen.width, el.screen.height);
    ctx.globalAlpha = dimmed ? 0.45 : 1;
    let color = null;
    for (let y = 0; y < H; y++) {
      const next = rowColor(y, H);
      if (next !== color) { color = next; ctx.fillStyle = color; }
      for (let x = 0; x < W; x++) if (pix[y * W + x]) ctx.fillRect(x * s, y * s, size, size);
    }
    ctx.globalAlpha = 1;
    fillThumb(el.glow, pix, W, H);
    el.glow.style.opacity = dimmed ? '.25' : '.55';
  }

  function paint() {
    if (state.pinnedScreen) {
      const p = state.pinnedScreen;
      paintPixels(p.pix, p.W, p.H, false);
    } else if (state.device) {
      paintPixels(composed(state.device), state.device.W, state.device.H, state.device.dimmed);
    }
  }

  function fitCanvas() {
    const dev = state.device;
    const W = dev ? dev.W : 128, H = dev ? dev.H : 64;
    const style = getComputedStyle(el.glass);
    const avail = el.glass.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const dpr = window.devicePixelRatio || 1;
    const maxHeight = window.innerHeight * 0.5;
    const scale = Math.max(1, Math.floor(Math.min((avail * dpr) / W, (maxHeight * dpr) / H)));
    state.scale = scale;
    el.screen.width = W * scale;
    el.screen.height = H * scale;
    el.screen.style.width = `${(W * scale) / dpr}px`;
    el.screen.style.height = `${(H * scale) / dpr}px`;
    if (state.sim) state.sim.dirty = true;
    drawTraces();
  }

  // Runs one copper trace from each header pin back to the edge of the code panel.
  function drawTraces() {
    const svg = el.traces;
    if (getComputedStyle(svg).display === 'none') return;
    const page = document.body.getBoundingClientRect();
    const editor = document.querySelector('.editor').getBoundingClientRect();
    const pins = [...document.querySelectorAll('.pin i')].map((p) => p.getBoundingClientRect());
    const editorRight = editor.right - page.left;
    let markup = '';
    pins.forEach((pin, i) => {
      const x = pin.left + pin.width / 2 - page.left;
      const y = pin.top - page.top;
      const routeY = y - 22 - (pins.length - 1 - i) * 10;
      const bend = 8;
      markup += `<path d="M${x} ${y}V${routeY + bend}L${x - bend} ${routeY}H${editorRight}" fill="none" stroke="#2358bd" stroke-width="3"/>`;
      markup += `<rect x="${editorRight}" y="${routeY - 4}" width="9" height="8" fill="#dcb15a"/>`;
    });
    svg.innerHTML = markup;
  }

  /* ---------- Page chrome ---------- */

  function updateGutter() {
    const count = el.code.value.split('\n').length;
    if (el.gutter.dataset.count === String(count)) return;
    el.gutter.dataset.count = String(count);
    let text = '';
    for (let i = 1; i <= count; i++) text += i + '\n';
    el.gutter.textContent = text;
  }

  function syncScroll() {
    el.gutter.style.transform = `translateY(${-el.code.scrollTop}px)`;
    positionErrorBar();
  }

  function positionErrorBar() {
    const line = Number(el.errorBar.dataset.line);
    if (!line) return;
    el.errorBar.style.top = `${12 + (line - 1) * LINE_HEIGHT - el.code.scrollTop}px`;
  }

  function showError(text, line) {
    el.message.textContent = text;
    el.message.hidden = false;
    el.message.dataset.line = line || '';
    el.message.style.cursor = line ? 'pointer' : 'default';
    if (line) {
      el.errorBar.dataset.line = line;
      el.errorBar.hidden = false;
      positionErrorBar();
    } else clearErrorBar();
  }

  function clearErrorBar() {
    el.errorBar.dataset.line = '';
    el.errorBar.hidden = true;
  }

  function clearError() {
    el.message.hidden = true;
    clearErrorBar();
  }

  function goToLine(line) {
    const lines = el.code.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    el.code.focus();
    el.code.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    el.code.scrollTop = Math.max(0, (line - 4) * LINE_HEIGHT);
    syncScroll();
  }

  function showUnsimulated(items) {
    el.unsimulatedList.textContent = '';
    el.unsimulated.hidden = !items.length;
    for (const item of items) {
      const li = document.createElement('li');
      if (item.file || !item.line) li.textContent = item.file ? `${item.label} in ${item.file}` : item.label;
      else {
        const link = document.createElement('button');
        link.type = 'button';
        link.textContent = item.label;
        link.title = `Go to line ${item.line}`;
        link.addEventListener('click', () => goToLine(item.line));
        li.append(link);
      }
      el.unsimulatedList.append(li);
    }
  }

  function addNote(text) {
    if (state.notes.has(text)) return;
    state.notes.add(text);
    const li = document.createElement('li');
    li.textContent = text;
    el.notes.append(li);
    el.notesBlock.hidden = false;
  }

  function pinLabel(pin) {
    return pin >= 14 && pin <= 21 ? `A${pin - 14}` : `Pin ${pin}`;
  }

  function renderInputs() {
    const sim = state.sim;
    el.inputs.textContent = '';
    if (!sim || !sim.pins.size) { el.inputsBlock.hidden = true; return; }
    el.inputsBlock.hidden = false;
    for (const [pin, p] of [...sim.pins].sort((a, b) => a[0] - b[0])) {
      if (p.kind === 'digital') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pad push';
        b.textContent = pinLabel(pin);
        b.title = 'Hold to press';
        b.setAttribute('aria-pressed', 'false');
        const press = (down) => {
          p.held = down;
          p.value = down ? (p.idle ? 0 : 1) : p.idle;
          b.setAttribute('aria-pressed', String(down));
        };
        b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); press(true); });
        b.addEventListener('pointerup', () => press(false));
        b.addEventListener('pointercancel', () => press(false));
        b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(true); } });
        b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') press(false); });
        b.addEventListener('blur', () => { if (p.held) press(false); });
        el.inputs.append(b);
      } else {
        const label = document.createElement('label');
        label.className = 'analog';
        const range = document.createElement('input');
        range.type = 'range'; range.min = 0; range.max = 1023; range.value = p.value;
        const out = document.createElement('output');
        out.textContent = p.value;
        range.addEventListener('input', () => {
          p.value = +range.value;
          out.textContent = range.value;
          state.analogMemory.set(pin, p.value);
        });
        label.append(pinLabel(pin), range, out);
        el.inputs.append(label);
      }
    }
  }

  function hashPixels(pix) {
    let h = 2166136261, lit = 0;
    for (let i = 0; i < pix.length; i++) { h = Math.imul(h ^ pix[i], 16777619); lit += pix[i]; }
    return lit ? h : 0;
  }

  function saveHeldScreen() {
    const held = state.held;
    if (!held || held.saved || state.sim.vt - held.t < SCREEN_HOLD_MS) return;
    held.saved = true;
    const hash = hashPixels(held.pix);
    if (!hash || state.screenHashes.has(hash)) return;
    state.screenHashes.add(hash);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Show screen ${state.screenHashes.size}`);
    button.setAttribute('aria-pressed', 'false');
    const canvas = document.createElement('canvas');
    canvas._frame = held;
    fillThumb(canvas, held.pix, held.W, held.H);
    button.append(canvas);
    button.addEventListener('click', () => pinScreen(held, button));
    el.screens.append(button);
    while (el.screens.children.length > MAX_SCREENS) el.screens.firstChild.remove();
    el.screensBlock.hidden = false;
  }

  function pinScreen(frame, button) {
    state.pinnedScreen = frame;
    setPaused(true);
    [...el.screens.children].forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    paint();
  }

  function unpinScreen() {
    state.pinnedScreen = null;
    [...el.screens.children].forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }

  function repaintThumbs() {
    [...el.screens.querySelectorAll('canvas')].forEach((c) => fillThumb(c, c._frame.pix, c._frame.W, c._frame.H));
  }

  function setPaused(paused) {
    state.paused = paused;
    el.pause.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) unpinScreen();
    state.statusAt = 0;
  }

  function updateStatus(now) {
    if (now - state.statusAt < 200) return;
    state.statusAt = now;
    const { sim, device } = state;
    if (!device) {
      el.status.textContent = el.code.value.trim() ? 'No display found. Declare Adafruit_SSD1306, U8G2 or SSD1306Wire in the sketch.' : 'Paste a sketch to see it here';
      return;
    }
    const phase = sim.failed ? 'Stopped' : state.paused ? 'Paused' : sim.done ? 'Finished' : 'Running';
    const label = device.label.startsWith('U8G2') ? 'U8g2' : device.label;
    el.status.textContent = `${device.W} × ${device.H} ${label}, ${phase.toLowerCase()} at ${(sim.vt / 1000).toFixed(1)} s`;
  }

  /* ---------- Running ---------- */

  function resetRunOutput() {
    state.notes = new Set();
    el.notes.textContent = '';
    el.notesBlock.hidden = true;
    state.serialText = '';
    state.serialBuffer = '';
    el.serial.textContent = '';
    el.serialBlock.hidden = true;
    state.screenHashes = new Set();
    el.screens.textContent = '';
    el.screensBlock.hidden = true;
    state.held = null;
    state.pinnedScreen = null;
  }

  function start(compiled) {
    resetRunOutput();
    state.compiled = compiled;
    state.device = null;
    ctx.clearRect(0, 0, el.screen.width, el.screen.height);
    glowCtx.clearRect(0, 0, el.glow.width, el.glow.height);
    compiled.notes.forEach(addNote);
    showUnsimulated(compiled.unsimulated);
    const sim = new OLED.Sim(compiled, {
      note: addNote,
      serial: (text) => { state.serialBuffer += text; },
      deviceChanged: (dev) => { if (state.device !== dev) { state.device = dev; fitCanvas(); } },
      pinsChanged: () => { state.pinsDirty = true; },
      presented: (dev, t) => { state.held = { pix: dev.front.slice(), W: dev.W, H: dev.H, t, saved: false }; },
      error: (msg, line) => showError(msg, line),
      finished: () => {},
    });
    sim.pinPresets = state.analogMemory;
    state.sim = sim;
    setPaused(false);
    renderInputs();
    state.statusAt = 0;
  }

  function compileAndRun() {
    const source = el.code.value;
    store.set('oled.code', source);
    clearError();
    showUnsimulated([]);
    if (!source.trim()) {
      state.sim = null;
      state.device = null;
      resetRunOutput();
      renderInputs();
      ctx.clearRect(0, 0, el.screen.width, el.screen.height);
      glowCtx.clearRect(0, 0, el.glow.width, el.glow.height);
      state.statusAt = 0;
      return;
    }
    try {
      start(OLED.compile(source, state.files));
    } catch (err) {
      if (err instanceof OLED.CompileError) {
        const where = err.file && err.file !== '<generated>' ? `${err.file} line ${err.line}` : `Line ${err.line}`;
        showError(`${where}: ${err.message}`, err.file ? 0 : err.line);
      } else {
        showError(`This sketch couldn't be run: ${err.message}`);
      }
    }
  }

  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(now - lastFrame, 100);
    lastFrame = now;
    const sim = state.sim;
    if (sim && !state.paused) {
      if (sim.done) sim.vt += dt * state.speed;
      else { sim.clock += dt * state.speed; sim.advance(sim.clock, 12); }
    }
    if (sim) {
      saveHeldScreen();
      if (state.pinsDirty) { state.pinsDirty = false; renderInputs(); }
      if (state.serialBuffer) flushSerial();
      if (state.pinnedScreen) { /* The pinned screen is already on the panel. */ }
      else if (sim.dirty || (state.device && state.device.scroll && !state.paused)) { sim.dirty = false; paint(); }
    }
    updateStatus(now);
  }

  function flushSerial() {
    state.serialText = (state.serialText + state.serialBuffer).slice(-6000);
    state.serialBuffer = '';
    const atEnd = el.serial.scrollTop + el.serial.clientHeight >= el.serial.scrollHeight - 4;
    el.serial.textContent = state.serialText;
    el.serialBlock.hidden = false;
    if (atEnd) el.serial.scrollTop = el.serial.scrollHeight;
  }

  /* ---------- Files ---------- */

  function setCode(text, name) {
    el.code.value = text;
    state.name = name;
    el.fileName.textContent = name;
    store.set('oled.name', name);
    el.code.scrollTop = 0;
    updateGutter();
    syncScroll();
    compileAndRun();
  }

  function showExtraFiles() {
    const names = Object.keys(state.files);
    el.extra.textContent = names.length ? `with ${names.join(', ')}` : '';
  }

  async function loadFiles(list) {
    const files = [...list];
    if (!files.length) return;
    const main = files.find((f) => /\.ino$/i.test(f.name)) || (files.every((f) => /\.(h|hpp)$/i.test(f.name)) ? null : files[0]);
    const contents = await Promise.all(files.map(async (f) => [f, await f.text()]));
    if (main) state.files = {};
    for (const [f, text] of contents) if (f !== main) state.files[f.name] = text;
    showExtraFiles();
    state.loadedFromExample = false;
    if (main) setCode(contents.find(([f]) => f === main)[1], main.name);
    else compileAndRun();
  }

  /* ---------- Events ---------- */

  let debounce = 0;
  el.code.addEventListener('input', () => {
    updateGutter();
    state.loadedFromExample = false;
    clearTimeout(debounce);
    debounce = setTimeout(compileAndRun, 450);
  });
  el.code.addEventListener('scroll', syncScroll);
  el.code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // Escape first moves focus out, so Tab stays available for keyboard users.
      if (state.editorEscaped) { state.editorEscaped = false; return; }
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    } else if (e.key === 'Escape') state.editorEscaped = true;
    else state.editorEscaped = false;
  });
  el.message.addEventListener('click', () => { if (el.message.dataset.line) goToLine(+el.message.dataset.line); });

  el.pause.addEventListener('click', () => setPaused(!state.paused));
  el.step.addEventListener('click', () => {
    if (!state.sim) return;
    unpinScreen();
    setPaused(true);
    state.sim.advance(Infinity, 400, true);
    state.sim.dirty = true;
    state.statusAt = 0;
  });
  el.restart.addEventListener('click', compileAndRun);
  el.speed.addEventListener('change', () => { state.speed = +el.speed.value; });
  el.panel.value = COLORS[state.panel] ? state.panel : 'white';
  state.panel = el.panel.value;
  el.panel.addEventListener('change', () => {
    state.panel = el.panel.value;
    store.set('oled.panel', state.panel);
    repaintThumbs();
    if (state.sim) state.sim.dirty = true;
    paint();
  });
  el.save.addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = el.screen.width; out.height = el.screen.height;
    const c = out.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(el.screen, 0, 0);
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.name.replace(/\.[^.]+$/, '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  });

  OLED.EXAMPLES.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ex.name;
    el.examples.append(opt);
  });
  el.examples.addEventListener('change', () => {
    const ex = OLED.EXAMPLES[+el.examples.value];
    const value = el.examples.value;
    el.examples.value = '';
    if (value === '' || !ex) return;
    if (!state.loadedFromExample && el.code.value.trim() && !confirm('Replace the code in the editor with this example?')) return;
    state.files = {};
    showExtraFiles();
    state.loadedFromExample = true;
    setCode(ex.code, `${ex.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.ino`);
  });

  el.open.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { loadFiles(el.file.files); el.file.value = ''; });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; el.codePanel.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.codePanel.classList.remove('dragging'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.codePanel.classList.remove('dragging');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  window.addEventListener('resize', fitCanvas);
  if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(el.glass);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawTraces);

  /* ---------- Start ---------- */

  const saved = store.get('oled.code');
  fitCanvas();
  if (saved && saved.trim()) setCode(saved, store.get('oled.name') || 'sketch.ino');
  else { state.loadedFromExample = true; setCode(OLED.EXAMPLES[0].code, 'text_and_shapes.ino'); }
  requestAnimationFrame(frame);
})();
