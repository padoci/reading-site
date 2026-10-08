/* UI wiring, persistence (localStorage), focus mode, and keyboard controls. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEYS = {
    library: 'flashreader.library', // [{ id, title, total, index, hash, readAt }]
    text: 'flashreader.text.', // + id → the document's full text
    settings: 'flashreader.settings',
    legacyDoc: 'flashreader.doc', // single-document storage from earlier versions
    legacyPos: 'flashreader.pos',
  };

  // Selectable speeds: fine 10-WPM steps through the common 250-500 range, coarser at the ends.
  const WPMS = [];
  for (let w = 100; w < 250; w += 25) WPMS.push(w);
  for (let w = 250; w <= 500; w += 10) WPMS.push(w);
  for (const w of [550, 600, 650, 700, 800, 900, 1000]) WPMS.push(w);
  const wpmIndex = (wpm) => {
    let best = 0;
    WPMS.forEach((w, i) => { if (Math.abs(w - wpm) < Math.abs(WPMS[best] - wpm)) best = i; });
    return best;
  };

  const THEMES = ['light', 'grey', 'black'];
  const ACCENTS = ['#e5392f', '#f08c00', '#2f9e44', '#12a4a4', '#2f6fed', '#8250df', '#e83e8c'];
  const DEFAULTS = { wpm: 300, size: 56, theme: null, accent: ACCENTS[0], smart: true };

  // ---- storage (always guarded: it can be unavailable or full) ----
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    },
    getRaw(key) {
      try { return localStorage.getItem(key); } catch (_) { return null; }
    },
    setRaw(key, value) {
      try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
    },
  };

  // ---- library: several documents, each with its own reading position ----
  const library = {
    list() {
      const l = store.get(KEYS.library);
      return Array.isArray(l) ? l : [];
    },
    save(list) { return store.set(KEYS.library, list); },
    get(id) { return library.list().find((e) => e.id === id) || null; },
    text(id) { return store.getRaw(KEYS.text + id); },
    update(id, fields) {
      const list = library.list();
      const e = list.find((x) => x.id === id);
      if (!e) return;
      Object.assign(e, fields);
      library.save(list);
    },
    remove(id) {
      store.remove(KEYS.text + id);
      library.save(library.list().filter((e) => e.id !== id));
    },
    /** Store a new entry, evicting the least recently read ones if storage is full. */
    add(entry, text) {
      let list = library.list();
      while (!store.setRaw(KEYS.text + entry.id, text)) {
        if (!list.length) return false;
        const oldest = list.reduce((a, b) => (a.readAt <= b.readAt ? a : b));
        store.remove(KEYS.text + oldest.id);
        list = list.filter((e) => e !== oldest);
        library.save(list);
      }
      list.unshift(entry);
      if (!library.save(list)) { store.remove(KEYS.text + entry.id); return false; }
      return true;
    },
  };

  function hashText(text) {
    let h = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + text.length;
  }

  (function migrateLegacy() {
    const old = store.get(KEYS.legacyDoc);
    if (old && old.text) {
      const pos = store.get(KEYS.legacyPos);
      library.add({
        id: String(old.id), title: old.title || 'Untitled',
        total: (old.text.match(/\S+/g) || []).length,
        index: pos && pos.id === old.id ? pos.index : 0,
        hash: hashText(old.text), readAt: Date.now(),
      }, old.text);
    }
    store.remove(KEYS.legacyDoc);
    store.remove(KEYS.legacyPos);
  })();

  const settings = Object.assign({}, DEFAULTS, store.get(KEYS.settings));
  if (settings.theme === 'dark') settings.theme = 'grey'; // from the earlier two-theme version
  if (!THEMES.includes(settings.theme)) {
    settings.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'grey' : 'light';
  }
  if (!/^#[0-9a-f]{6}$/i.test(settings.accent)) settings.accent = DEFAULTS.accent;
  let doc = null; // { id, title, saved } — saved is false when the text didn't fit in storage

  // ---- elements ----
  const el = {
    input: $('inputView'), reader: $('readerView'), newBtn: $('newBtn'), status: $('status'),
    word: $('word'), stage: $('stage'), note: $('stageNote'), scrub: $('scrub'),
    counter: $('counter'), pct: $('pct'), eta: $('eta'), title: $('docTitle'),
    play: $('playBtn'), wpm: $('wpm'), wpmOut: $('wpmOut'), size: $('size'), sizeOut: $('sizeOut'),
    smart: $('smart'), focusBtn: $('focusBtn'), fWpm: $('fWpm'), fProg: $('fProg'),
  };
  const wordParts = { l: el.word.querySelector('.l'), p: el.word.querySelector('.p'), r: el.word.querySelector('.r') };

  // ---- reader engine ----
  let lastSaved = 0;
  const reader = new Rsvp.Reader({
    onWord(i, w) {
      const p = Rsvp.pivotIndex(w);
      wordParts.l.textContent = w.slice(0, p);
      wordParts.p.textContent = w.charAt(p);
      wordParts.r.textContent = w.slice(p + 1);
      el.scrub.value = i;
      updateStats();
      if (reader.playing && Date.now() - lastSaved > 2000) savePosition();
    },
    onState(playing) {
      el.play.textContent = playing ? 'Pause' : 'Play';
      el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      el.note.textContent = playing ? '' : reader.atEnd && reader.length > 1 ? 'End of text' : '';
      if (focus) pokeFocusUi();
      if (!playing) savePosition();
    },
    onEnd() {
      el.note.textContent = 'End of text';
      savePosition();
    },
  });

  function fmtTime(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + 's left';
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' min left' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm left';
  }

  function updateStats() {
    const n = reader.length;
    const frac = n > 1 ? reader.index / (n - 1) : 1;
    el.counter.textContent = n ? (reader.index + 1).toLocaleString() + ' / ' + n.toLocaleString() : '';
    el.pct.textContent = Math.round(frac * 100) + '%';
    el.eta.textContent = reader.atEnd ? '' : '~' + fmtTime(reader.secondsLeft());
    el.scrub.style.setProperty('--f', frac);
    el.fProg.style.width = frac * 100 + '%';
  }

  function savePosition() {
    if (!doc || !doc.saved) return;
    lastSaved = Date.now();
    library.update(doc.id, { index: reader.index, readAt: Date.now() });
  }

  // ---- speed slider ticks ----
  (function buildTicks() {
    const ticks = $('wpmTicks');
    [100, 250, 300, 400, 500, 1000].forEach((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      s.style.setProperty('--p', wpmIndex(w) / (WPMS.length - 1));
      ticks.appendChild(s);
    });
    el.wpm.max = WPMS.length - 1;
  })();

  // ---- theme & accent controls ----
  const themeBtns = Array.from(document.querySelectorAll('#themeSeg button'));
  themeBtns.forEach((b) => b.addEventListener('click', () => changeSetting('theme', b.dataset.theme)));

  const swatchBox = $('accentSwatches');
  const swatchBtns = ACCENTS.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', 'Accent ' + c);
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => changeSetting('accent', c));
    swatchBox.appendChild(b);
    return b;
  });
  const customWrap = document.createElement('span');
  customWrap.className = 'swatch custom';
  customWrap.setAttribute('role', 'radio');
  customWrap.title = 'Custom colour';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.setAttribute('aria-label', 'Custom accent colour');
  customInput.addEventListener('input', () => changeSetting('accent', customInput.value));
  customWrap.appendChild(customInput);
  swatchBox.appendChild(customWrap);

  function inkFor(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#111111' : '#ffffff';
  }

  // ---- settings ----
  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    const accent = settings.accent.toLowerCase();
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', inkFor(accent));
    root.style.setProperty('--fs', settings.size + 'px');

    reader.setWpm(settings.wpm);
    reader.smart = settings.smart;
    const idx = wpmIndex(settings.wpm);
    el.wpm.value = idx;
    el.wpm.style.setProperty('--f', idx / (WPMS.length - 1));
    el.wpm.setAttribute('aria-valuetext', WPMS[idx] + ' words per minute');
    el.wpmOut.textContent = WPMS[idx];
    el.fWpm.textContent = WPMS[idx] + ' WPM';

    el.size.value = settings.size;
    el.size.style.setProperty('--f', (settings.size - el.size.min) / (el.size.max - el.size.min));
    el.sizeOut.textContent = settings.size;
    el.smart.checked = settings.smart;

    themeBtns.forEach((b) => b.setAttribute('aria-checked', b.dataset.theme === settings.theme));
    let preset = false;
    swatchBtns.forEach((b) => {
      const on = b.dataset.color === accent;
      preset = preset || on;
      b.setAttribute('aria-checked', on);
    });
    customWrap.setAttribute('aria-checked', !preset);
    customWrap.classList.toggle('on', !preset);
    customWrap.style.setProperty('--c', accent);
    customInput.value = accent;
    updateStats();
  }
  function changeSetting(key, value) {
    settings[key] = value;
    store.set(KEYS.settings, settings);
    applySettings();
  }
  function stepWpm(delta) {
    const i = Math.max(0, Math.min(WPMS.length - 1, wpmIndex(settings.wpm) + delta));
    changeSetting('wpm', WPMS[i]);
  }

  // ---- focus mode ----
  let focus = false;
  let uiTimer = null;

  function pokeFocusUi() {
    el.stage.classList.add('ui');
    el.stage.classList.remove('idle');
    clearTimeout(uiTimer);
    if (reader.playing) {
      uiTimer = setTimeout(() => {
        el.stage.classList.remove('ui');
        el.stage.classList.add('idle');
      }, 2000);
    }
  }

  function setFocus(on) {
    if (on === focus) return;
    focus = on;
    document.body.classList.toggle('focus', on);
    el.focusBtn.setAttribute('aria-label', on ? 'Exit focus mode' : 'Enter focus mode');
    el.focusBtn.title = on ? 'Exit focus mode (Esc)' : 'Focus mode (F)';
    if (on) {
      // Real fullscreen where supported; the CSS overlay is the fallback (e.g. iPhone Safari).
      try {
        const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* ignore */ }
      el.stage.focus({ preventScroll: true });
      pokeFocusUi();
    } else {
      clearTimeout(uiTimer);
      el.stage.classList.remove('ui', 'idle');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && focus) setFocus(false); // user pressed Esc in fullscreen
  });
  ['mousemove', 'touchstart'].forEach((ev) => el.stage.addEventListener(ev, () => { if (focus) pokeFocusUi(); }, { passive: true }));
  // Buttons inside the stage must not also toggle playback.
  el.focusBtn.addEventListener('click', (e) => { e.stopPropagation(); setFocus(!focus); });
  document.querySelector('.focus-bar').addEventListener('click', (e) => e.stopPropagation());
  $('fDown').addEventListener('click', () => stepWpm(-1));
  $('fUp').addEventListener('click', () => stepWpm(1));

  // ---- views ----
  function setStatus(msg, isError) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('error', !!isError);
  }

  function showReader() {
    el.input.hidden = true;
    el.reader.hidden = false;
    el.newBtn.hidden = false;
    el.title.textContent = doc.title;
    el.note.textContent = '';
    el.scrub.max = Math.max(0, reader.length - 1);
    window.scrollTo(0, 0);
    el.stage.focus({ preventScroll: true });
  }

  function showInput() {
    setFocus(false);
    reader.pause();
    savePosition();
    el.reader.hidden = true;
    el.input.hidden = false;
    el.newBtn.hidden = true;
    renderLibrary();
  }

  /** Start reading a new document (or reopen it if the same text is already in the library). */
  function openDoc(title, text) {
    const hash = hashText(text);
    const existing = library.list().find((e) => e.hash === hash);
    if (existing && library.text(existing.id) !== null) return openEntry(existing.id);

    reader.load(text, 0);
    if (!/\S/.test(text) || reader.length === 0) {
      setStatus('No readable text was found in that.', true);
      return false;
    }
    const entry = { id: String(Date.now()), title: title || 'Untitled', total: reader.length, index: 0, hash, readAt: Date.now() };
    doc = { id: entry.id, title: entry.title, saved: library.add(entry, text) };
    setStatus('');
    showReader();
    if (!doc.saved) el.note.textContent = 'Too large to remember between visits';
    return true;
  }

  function openEntry(id) {
    const entry = library.get(id);
    const text = entry && library.text(id);
    if (!entry || text === null) {
      if (entry) library.remove(id);
      renderLibrary();
      setStatus('That text is no longer stored.', true);
      return false;
    }
    doc = { id, title: entry.title, saved: true };
    reader.load(text, entry.index);
    library.update(id, { readAt: Date.now(), total: reader.length });
    setStatus('');
    showReader();
    return true;
  }

  function timeAgo(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  function renderLibrary() {
    const list = library.list().sort((a, b) => b.readAt - a.readAt);
    const ul = $('libList');
    ul.textContent = '';
    $('library').hidden = !list.length;
    for (const e of list) {
      const frac = e.total > 1 ? Math.min(1, e.index / (e.total - 1)) : 0;
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lib-open';
      const title = document.createElement('strong');
      title.textContent = e.title;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = (frac >= 1 ? 'Finished' : Math.round(frac * 100) + '%') + ' · ' +
        e.total.toLocaleString() + ' words · ' + timeAgo(e.readAt);
      const bar = document.createElement('span');
      bar.className = 'lib-bar';
      bar.style.setProperty('--f', frac);
      open.append(title, meta, bar);
      open.addEventListener('click', () => openEntry(e.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lib-del';
      del.setAttribute('aria-label', 'Remove ' + e.title);
      del.title = 'Remove';
      del.textContent = '\u00d7';
      del.addEventListener('click', () => { library.remove(e.id); renderLibrary(); });
      li.append(open, del);
      ul.appendChild(li);
    }
  }

  // ---- input handling ----
  async function run(label, fn) {
    setStatus(label);
    const buttons = document.querySelectorAll('#inputView .btn');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const r = await fn();
      openDoc(r.title, r.text);
    } catch (err) {
      console.error(err);
      setStatus((err && err.message) || 'Something went wrong.', true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  // Tabs
  const tabs = ['paste', 'file', 'url'];
  function selectTab(name) {
    tabs.forEach((t) => {
      const on = t === name;
      const tab = $('tab-' + t);
      tab.setAttribute('aria-selected', on);
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
    });
    setStatus('');
  }
  tabs.forEach((t) => {
    $('tab-' + t).addEventListener('click', () => selectTab(t));
    $('tab-' + t).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next);
      $('tab-' + next).focus();
    });
  });

  // Paste
  const pasteText = $('pasteText');
  pasteText.addEventListener('input', () => {
    const n = (pasteText.value.match(/\S+/g) || []).length;
    $('pasteCount').textContent = n ? n.toLocaleString() + ' words' : '';
  });
  $('pasteBtn').addEventListener('click', () => {
    const text = Extract.normalizeText(pasteText.value);
    if (!text) { setStatus('Paste or type some text first.', true); return; }
    const first = text.split(/\s+/).slice(0, 6).join(' ');
    openDoc(first + (text.length > first.length ? '…' : ''), text);
  });

  // File
  const fileInput = $('fileInput');
  const drop = $('drop');
  function handleFile(file) {
    if (!file) return;
    run('Reading ' + file.name + '…', () => Extract.fromFile(file));
  }
  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  // Dropping a file anywhere on the page should not navigate away to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { if (!drop.contains(e.target)) e.preventDefault(); });

  // URL
  $('urlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run('Fetching page…', () => Extract.fromUrl($('urlInput').value));
  });

  // New text
  el.newBtn.addEventListener('click', showInput);
  $('home').addEventListener('click', (e) => {
    if (!el.reader.hidden) { e.preventDefault(); showInput(); }
  });

  // ---- reader controls ----
  el.play.addEventListener('click', () => reader.toggle());
  el.stage.addEventListener('click', () => reader.toggle());
  $('restartBtn').addEventListener('click', () => reader.seek(0));
  $('backBtn').addEventListener('click', () => reader.skip(-10));
  $('fwdBtn').addEventListener('click', () => reader.skip(10));
  el.scrub.addEventListener('input', () => { reader.seek(+el.scrub.value); });
  el.scrub.addEventListener('change', savePosition);
  el.wpm.addEventListener('input', () => changeSetting('wpm', WPMS[+el.wpm.value]));
  $('wpmDown').addEventListener('click', () => stepWpm(-1));
  $('wpmUp').addEventListener('click', () => stepWpm(1));
  el.size.addEventListener('input', () => changeSetting('size', +el.size.value));
  el.smart.addEventListener('change', () => changeSetting('smart', el.smart.checked));

  document.addEventListener('keydown', (e) => {
    if (el.reader.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && (t.type === 'text' || t.type === 'color'))) return;
    // Space/Enter on a focused button should activate that button, not toggle playback.
    if ((e.key === ' ' || e.key === 'Enter') && t !== el.stage && (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && t.type === 'checkbox'))) return;
    // Arrow keys on a focused slider adjust that slider natively.
    if (tag === 'INPUT' && t.type === 'range' && e.key.startsWith('Arrow')) return;
    if (focus) pokeFocusUi();
    const step = e.shiftKey ? 1 : 10;
    switch (e.key) {
      case ' ': reader.toggle(); break;
      case 'ArrowLeft': reader.skip(-step); break;
      case 'ArrowRight': reader.skip(step); break;
      case 'ArrowUp': stepWpm(1); break;
      case 'ArrowDown': stepWpm(-1); break;
      case 'Home': reader.seek(0); break;
      case 'f': case 'F': setFocus(!focus); break;
      case 'Escape': focus ? setFocus(false) : showInput(); break;
      default: return;
    }
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) reader.pause(); });
  window.addEventListener('pagehide', savePosition);

  // ---- init ----
  applySettings();
  renderLibrary();
})();
