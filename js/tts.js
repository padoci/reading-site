/* "Listen" mode: reads the text aloud while the RSVP display follows the voice.
   Engine 1: Kokoro-82M neural TTS in a worker (natural voices, ~90 MB one-time download).
   Engine 2: the browser's built-in speechSynthesis, used if Kokoro can't load. */
(function (global) {
  'use strict';

  const VOICES = [
    ['af_heart', 'Heart (US, female)'], ['af_bella', 'Bella (US, female)'], ['af_nicole', 'Nicole (US, female)'],
    ['am_michael', 'Michael (US, male)'], ['am_fenrir', 'Fenrir (US, male)'],
    ['bf_emma', 'Emma (UK, female)'], ['bm_george', 'George (UK, male)'],
  ];
  const MAX_CHUNK = 40;
  const SOFT_CHUNK = 24;

  /** Split words[from..] into speakable chunks: [{ start, end, text, offsets }] (end exclusive), lazily. */
  function chunkAt(words, paras, start) {
    let end = start;
    while (end < words.length) {
      const w = words[end];
      end++;
      const n = end - start;
      const tail = w.replace(/["'’”)\]}*]+$/, '');
      if (/[.!?…]$/.test(tail) || paras.has(end - 1)) break;
      if (n >= SOFT_CHUNK && /[,;:—–]$/.test(tail)) break;
      if (n >= MAX_CHUNK) break;
    }
    const offsets = [];
    let text = '';
    for (let i = start; i < end; i++) {
      if (i > start) text += ' ';
      offsets.push(text.length);
      text += words[i];
    }
    return { start, end, text, offsets };
  }

  /** Relative spoken duration of a word, used to time the display against the audio. */
  function spokenWeight(w) {
    const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length;
    let x = 2 + letters;
    const tail = w.replace(/["'’”)\]}*]+$/, '');
    if (/[.!?…]$/.test(tail)) x += 6;
    else if (/[;:—–]$/.test(tail)) x += 4;
    else if (/,$/.test(tail)) x += 3;
    return x;
  }

  class Narrator {
    /** h: { getWords(), getParas(), onWord(i), onState(listening), onStatus(msg, isError), onEnd() } */
    constructor(h) {
      this.h = h;
      this.voice = 'af_heart';
      this.wpm = 300;
      this.active = false; // user wants audio (playing or paused)
      this.paused = false;
      this.engine = null; // 'kokoro' | 'browser'
      this.worker = null;
      this.ready = null; // promise for the Kokoro load
      this.ctx = null;
      this.run = 0; // bumped to cancel everything in flight
      this.pending = new Map(); // gen id → { resolve, reject }
      this.nextId = 1;
      this.cur = null; // { chunk, startAt, dur, buffer } for the chunk being played
      this.raf = 0;
    }

    /** Narration speed: Kokoro's natural pace is ~165 wpm at speed 1. */
    get speed() { return Math.max(0.6, Math.min(2, this.wpm / 165)); }

    // ---- Kokoro worker ----
    _load() {
      if (this.ready) return this.ready;
      this.ready = new Promise((resolve, reject) => {
        let w;
        try { w = new Worker('js/tts-worker.js', { type: 'module' }); } catch (e) { reject(e); return; }
        this.worker = w;
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') resolve();
          else if (m.type === 'progress') {
            if (m.total) this.h.onStatus('Downloading voice model… ' + Math.round((m.loaded / m.total) * 100) + '%');
          } else if (m.type === 'audio') {
            const p = this.pending.get(m.id);
            if (p) { this.pending.delete(m.id); p.resolve(m); }
          } else if (m.type === 'error') {
            const p = this.pending.get(m.id);
            if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); } else reject(new Error(m.message));
          }
        };
        w.onerror = (e) => reject(new Error(e.message || 'Voice worker failed'));
        w.postMessage({ type: 'load' });
      });
      this.ready.catch(() => { this.ready = null; if (this.worker) this.worker.terminate(); this.worker = null; });
      return this.ready;
    }

    _generate(text) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'gen', id, text, voice: this.voice, speed: this.speed });
      });
    }

    // ---- control ----
    async start(index) {
      this.stop();
      this.active = true;
      this.paused = false;
      const run = ++this.run;
      this.h.onState(true);
      if (!this.engine) {
        this.h.onStatus('Loading voice…');
        try {
          await this._load();
          this.engine = 'kokoro';
        } catch (err) {
          console.warn('Kokoro unavailable, using browser voice:', err);
          if (!('speechSynthesis' in window)) {
            this.h.onStatus('Text-to-speech is not available in this browser.', true);
            this.stop();
            return;
          }
          this.engine = 'browser';
          this.h.onStatus('Natural voice unavailable — using your browser’s voice.');
        }
        if (run !== this.run) return;
      }
      this.h.onStatus('');
      if (this.engine === 'kokoro') this._playKokoro(index, run);
      else this._playBrowser(index, run);
    }

    stop() {
      this.run++;
      this.active = false;
      this.paused = false;
      cancelAnimationFrame(this.raf);
      this.cur = null;
      if (this.src) { try { this.src.onended = null; this.src.stop(); } catch (_) { /* already stopped */ } this.src = null; }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      for (const p of this.pending.values()) p.reject(new Error('cancelled'));
      this.pending.clear();
      this.h.onState(false);
    }

    pause() {
      if (!this.active || this.paused) return;
      this.paused = true;
      if (this.engine === 'kokoro' && this.ctx) this.ctx.suspend();
      else if (this.engine === 'browser') speechSynthesis.pause();
      this.h.onState(false, true);
    }

    resume() {
      if (!this.active || !this.paused) return;
      this.paused = false;
      if (this.engine === 'kokoro' && this.ctx) this.ctx.resume();
      else if (this.engine === 'browser') speechSynthesis.resume();
      this.h.onState(true);
    }

    /** Jump (while listening) to another word: restarts speech from there. */
    seek(index) { if (this.active) this.start(index); }

    /** Speed or voice changed: restart from the current word so it takes effect. */
    restartAt(index) { if (this.active && !this.paused) this.start(index); }

    // ---- Kokoro playback: generate chunk n+1 while chunk n plays ----
    async _playKokoro(index, run) {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      try { await this.ctx.resume(); } catch (_) { /* needs gesture; start() came from one */ }
      const words = this.h.getWords();
      const paras = this.h.getParas();
      let chunk = chunkAt(words, paras, index);
      let next = this._generate(chunk.text);
      while (run === this.run) {
        let audio;
        try { audio = await next; } catch (err) {
          if (run !== this.run) return;
          this.h.onStatus('Voice error: ' + err.message, true);
          this.stop();
          return;
        }
        if (run !== this.run) return;
        const nextChunk = chunk.end < words.length ? chunkAt(words, paras, chunk.end) : null;
        next = nextChunk ? this._generate(nextChunk.text) : null;
        if (next) next.catch(() => {}); // surfaced when awaited
        await this._playBuffer(chunk, audio, run);
        if (run !== this.run) return;
        if (!nextChunk) { this.stop(); this.h.onEnd(); return; }
        chunk = nextChunk;
      }
    }

    _playBuffer(chunk, audio, run) {
      return new Promise((resolve) => {
        const buf = this.ctx.createBuffer(1, audio.samples.length, audio.rate);
        buf.copyToChannel(audio.samples, 0);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        const words = this.h.getWords();
        const weights = [];
        let total = 0;
        for (let i = chunk.start; i < chunk.end; i++) { const w = spokenWeight(words[i]); weights.push(w); total += w; }
        const startAt = this.ctx.currentTime + 0.05;
        this.cur = { startAt, dur: buf.duration };
        this.src = src;
        src.onended = () => { if (this.src === src) this.src = null; cancelAnimationFrame(this.raf); resolve(); };
        src.start(startAt);
        let shown = -1;
        const frame = () => {
          if (run !== this.run) return;
          const t = Math.max(0, this.ctx.currentTime - startAt) / buf.duration * total;
          let acc = 0, k = 0;
          while (k < weights.length - 1 && acc + weights[k] <= t) { acc += weights[k]; k++; }
          if (k !== shown) { shown = k; this.h.onWord(chunk.start + k); }
          this.raf = requestAnimationFrame(frame);
        };
        frame();
      });
    }

    // ---- browser speechSynthesis fallback ----
    _playBrowser(index, run) {
      const words = this.h.getWords();
      const paras = this.h.getParas();
      const speakChunk = (chunk) => {
        if (run !== this.run) return;
        const u = new SpeechSynthesisUtterance(chunk.text);
        u.rate = Math.max(0.5, Math.min(2.5, this.wpm / 165));
        const v = this._pickBrowserVoice();
        if (v) { u.voice = v; u.lang = v.lang; }
        u.onboundary = (e) => {
          if (run !== this.run || e.name === 'sentence') return;
          let k = 0;
          while (k < chunk.offsets.length - 1 && chunk.offsets[k + 1] <= e.charIndex) k++;
          this.h.onWord(chunk.start + k);
        };
        u.onstart = () => this.h.onWord(chunk.start);
        u.onend = () => {
          if (run !== this.run) return;
          if (chunk.end >= words.length) { this.stop(); this.h.onEnd(); } else speakChunk(chunkAt(words, paras, chunk.end));
        };
        u.onerror = (e) => {
          if (run !== this.run || e.error === 'canceled' || e.error === 'interrupted') return;
          this.h.onStatus('Voice error: ' + e.error, true);
          this.stop();
        };
        speechSynthesis.speak(u);
      };
      speechSynthesis.cancel();
      speakChunk(chunkAt(words, paras, index));
    }

    _pickBrowserVoice() {
      const list = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
      return list.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ||
        list.find((v) => /google|samantha|daniel|karen/i.test(v.name)) || list[0] || null;
    }
  }

  global.Tts = { Narrator, VOICES, chunkAt, spokenWeight };
})(window);
