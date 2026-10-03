/* RSVP engine: tokenizing, pivot (ORP) calculation, and drift-corrected playback timing. */
(function (global) {
  'use strict';

  const MAX_WORD = 24; // longer tokens (URLs, etc.) are split into chunks
  const CHUNK = 12;

  /** Split text into display tokens. `paras` holds indices of words that end a paragraph. */
  function tokenize(text) {
    const words = [];
    const paras = new Set();
    const re = /(\S+)(\s*)/g;
    let m;
    while ((m = re.exec(text))) {
      const pieces = m[1].split(/(?<=[—–])(?=.)/u);
      for (const piece of pieces) {
        if (piece.length > MAX_WORD) {
          for (let i = 0; i < piece.length; i += CHUNK) words.push(piece.slice(i, i + CHUNK));
        } else {
          words.push(piece);
        }
      }
      if ((m[2].match(/\n/g) || []).length >= 2) paras.add(words.length - 1);
    }
    return { words, paras };
  }

  /** Index of the "optimal recognition point" letter, ignoring leading/trailing punctuation. */
  function pivotIndex(word) {
    const lead = (word.match(/^[^\p{L}\p{N}]*/u) || [''])[0].length;
    const core = (word.slice(lead).match(/^[\p{L}\p{N}][\s\S]*[\p{L}\p{N}]|^[\p{L}\p{N}]/u) || [''])[0].length;
    const len = core || word.length;
    const p = len <= 1 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : len <= 13 ? 3 : 4;
    return Math.min(lead + p, word.length - 1);
  }

  /** Relative display time for a word: >1 for punctuation, long words and paragraph ends. */
  function weight(word, endsParagraph) {
    let w = 1;
    const tail = word.replace(/["'’”)\]}*]+$/, '');
    if (/[.!?…]$/.test(tail)) w += 1.2;
    else if (/[;:—–]$/.test(tail)) w += 0.7;
    else if (/,$/.test(tail)) w += 0.5;
    const len = word.replace(/[^\p{L}\p{N}]/gu, '').length;
    if (len > 12) w += 0.6;
    else if (len > 8) w += 0.3;
    if (endsParagraph) w += 1.0;
    return w;
  }

  class Reader {
    constructor(handlers) {
      this.h = handlers; // { onWord(i, word), onState(playing), onEnd() }
      this.words = [];
      this.paras = new Set();
      this.index = 0;
      this.wpm = 300;
      this.smart = true;
      this.playing = false;
      this._timer = null;
      this._nextAt = 0;
    }

    load(text, index) {
      this.pause();
      const t = tokenize(text);
      this.words = t.words;
      this.paras = t.paras;
      this.index = Math.max(0, Math.min(index || 0, this.words.length - 1));
      this.h.onWord(this.index, this.words[this.index] || '');
    }

    get length() { return this.words.length; }
    get atEnd() { return this.index >= this.words.length - 1; }

    delayFor(i) {
      const base = 60000 / this.wpm;
      return this.smart ? base * weight(this.words[i], this.paras.has(i)) : base;
    }

    /** Estimated seconds left, using the average weight of the next words. */
    secondsLeft() {
      const left = this.words.length - 1 - this.index;
      if (left <= 0) return 0;
      let mult = 1;
      if (this.smart) {
        const n = Math.min(left, 500);
        let sum = 0;
        for (let i = 1; i <= n; i++) sum += weight(this.words[this.index + i], this.paras.has(this.index + i));
        mult = sum / n;
      }
      return (left * 60 * mult) / this.wpm;
    }

    play() {
      if (this.playing || !this.words.length) return;
      if (this.atEnd) this.index = 0;
      this.playing = true;
      this.h.onState(true);
      this._nextAt = performance.now();
      this._tick();
    }

    pause() {
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
      if (this.playing) {
        this.playing = false;
        this.h.onState(false);
      }
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    _tick() {
      this.h.onWord(this.index, this.words[this.index]);
      this._nextAt += this.delayFor(this.index);
      const wait = Math.max(0, this._nextAt - performance.now());
      if (wait === 0 && performance.now() - this._nextAt > 250) this._nextAt = performance.now(); // resync after stalls
      this._timer = setTimeout(() => {
        if (this.atEnd) {
          this.pause();
          this.h.onEnd();
        } else {
          this.index++;
          this._tick();
        }
      }, wait);
    }

    seek(i) {
      const wasPlaying = this.playing;
      if (wasPlaying) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this.index = Math.max(0, Math.min(i, this.words.length - 1));
      if (wasPlaying) {
        this._nextAt = performance.now();
        this._tick();
      } else {
        this.h.onWord(this.index, this.words[this.index] || '');
      }
    }

    skip(delta) { this.seek(this.index + delta); }

    setWpm(wpm) { this.wpm = wpm; }
  }

  global.Rsvp = { Reader, tokenize, pivotIndex, weight };
})(window);
