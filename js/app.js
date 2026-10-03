/* UI wiring, persistence (localStorage), and keyboard controls. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEYS = { doc: 'flashreader.doc', pos: 'flashreader.pos', settings: 'flashreader.settings' };
  const DEFAULTS = { wpm: 300, size: 56, theme: 'auto', smart: true };

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
  };

  const settings = Object.assign({}, DEFAULTS, store.get(KEYS.settings));
  let doc = null; // { id, title, text }

  // ---- elements ----
  const el = {
    input: $('inputView'), reader: $('readerView'), newBtn: $('newBtn'), status: $('status'),
    word: $('word'), stage: $('stage'), note: $('stageNote'), scrub: $('scrub'),
    counter: $('counter'), pct: $('pct'), eta: $('eta'), title: $('docTitle'),
    play: $('playBtn'), wpm: $('wpm'), wpmOut: $('wpmOut'), size: $('size'), sizeOut: $('sizeOut'),
    theme: $('theme'), smart: $('smart'),
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
      el.note.textContent = playing ? '' : reader.atEnd && reader.length > 1 ? 'End of text' : 'Paused — tap or press Space';
      if (!playing) savePosition();
    },
    onEnd() {
      el.note.textContent = 'End of text — press Play to read again';
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
    el.counter.textContent = n ? (reader.index + 1).toLocaleString() + ' / ' + n.toLocaleString() + ' words' : '';
    el.pct.textContent = n > 1 ? Math.round((reader.index / (n - 1)) * 100) + '%' : '100%';
    el.eta.textContent = reader.atEnd ? '' : '~' + fmtTime(reader.secondsLeft());
  }

  function savePosition() {
    if (!doc) return;
    lastSaved = Date.now();
    store.set(KEYS.pos, { id: doc.id, index: reader.index });
  }

  // ---- settings ----
  function applySettings() {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty('--fs', settings.size + 'px');
    reader.setWpm(settings.wpm);
    reader.smart = settings.smart;
    el.wpm.value = settings.wpm; el.wpmOut.textContent = settings.wpm;
    el.size.value = settings.size; el.sizeOut.textContent = settings.size;
    el.theme.value = settings.theme;
    el.smart.checked = settings.smart;
    updateStats();
  }
  function changeSetting(key, value) {
    settings[key] = value;
    store.set(KEYS.settings, settings);
    applySettings();
  }

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
    el.note.textContent = 'Paused — tap or press Space';
    el.scrub.max = Math.max(0, reader.length - 1);
    window.scrollTo(0, 0);
    el.stage.focus({ preventScroll: true });
  }

  function showInput() {
    reader.pause();
    savePosition();
    el.reader.hidden = true;
    el.input.hidden = false;
    el.newBtn.hidden = true;
    renderResume();
  }

  /** Start reading a new document. */
  function openDoc(title, text, startIndex) {
    if (!/\S/.test(text)) {
      setStatus('No readable text was found in that.', true);
      return false;
    }
    doc = { id: Date.now(), title: title || 'Untitled', text };
    const saved = store.set(KEYS.doc, doc);
    store.set(KEYS.pos, { id: doc.id, index: startIndex || 0 });
    if (!saved) {
      // Too large for localStorage: drop the stale copy so "Continue" never opens the wrong text.
      store.remove(KEYS.doc);
      store.remove(KEYS.pos);
    }
    reader.load(text, startIndex || 0);
    if (reader.length === 0) { setStatus('No readable text was found in that.', true); return false; }
    setStatus('');
    showReader();
    if (!saved) el.note.textContent = 'Paused — too large to remember between visits';
    return true;
  }

  function renderResume() {
    const saved = store.get(KEYS.doc);
    const pos = store.get(KEYS.pos);
    const card = $('resumeCard');
    if (!saved || !saved.text) { card.hidden = true; return; }
    const idx = pos && pos.id === saved.id ? pos.index : 0;
    // Rough word count without tokenizing the whole text.
    const total = (saved.text.match(/\S+/g) || []).length;
    const pct = total > 1 ? Math.min(100, Math.round((idx / total) * 100)) : 0;
    $('resumeTitle').textContent = saved.title;
    $('resumeMeta').textContent = pct + '% read · ' + total.toLocaleString() + ' words';
    card.hidden = false;
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

  // Resume / discard / new
  $('resumeBtn').addEventListener('click', () => {
    const saved = store.get(KEYS.doc);
    const pos = store.get(KEYS.pos);
    if (!saved) return renderResume();
    doc = saved;
    reader.load(saved.text, pos && pos.id === saved.id ? pos.index : 0);
    showReader();
  });
  $('discardBtn').addEventListener('click', () => {
    store.remove(KEYS.doc);
    store.remove(KEYS.pos);
    renderResume();
  });
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
  el.wpm.addEventListener('input', () => changeSetting('wpm', +el.wpm.value));
  el.size.addEventListener('input', () => changeSetting('size', +el.size.value));
  el.theme.addEventListener('change', () => changeSetting('theme', el.theme.value));
  el.smart.addEventListener('change', () => changeSetting('smart', el.smart.checked));

  document.addEventListener('keydown', (e) => {
    if (el.reader.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && t.type === 'text')) return;
    // Space/Enter on a focused button should activate that button, not toggle playback.
    if ((e.key === ' ' || e.key === 'Enter') && t !== el.stage && (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && t.type === 'checkbox'))) return;
    // Arrow keys on a focused slider adjust that slider natively.
    if (tag === 'INPUT' && t.type === 'range' && e.key.startsWith('Arrow')) return;
    const step = e.shiftKey ? 1 : 10;
    switch (e.key) {
      case ' ': reader.toggle(); break;
      case 'ArrowLeft': reader.skip(-step); break;
      case 'ArrowRight': reader.skip(step); break;
      case 'ArrowUp': changeSetting('wpm', Math.min(1000, settings.wpm + 25)); break;
      case 'ArrowDown': changeSetting('wpm', Math.max(100, settings.wpm - 25)); break;
      case 'Home': reader.seek(0); break;
      case 'Escape': showInput(); break;
      default: return;
    }
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) reader.pause(); });
  window.addEventListener('pagehide', savePosition);

  // ---- init ----
  applySettings();
  renderResume();
})();
