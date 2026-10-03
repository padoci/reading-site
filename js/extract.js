/* Text extraction: turns files and URLs into plain text. Everything runs in the browser. */
(function (global) {
  'use strict';

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'BR', 'HR', 'FIGCAPTION', 'DD', 'DT', 'DL', 'HEADER',
    'FOOTER', 'MAIN', 'BODY',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME']);
  const CHROME_SELECTOR = 'nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';

  const JINA_PROXY = 'https://r.jina.ai/';

  /** Collapse whitespace but keep blank lines as paragraph breaks. */
  function normalizeText(s) {
    return s
      .replace(/\r\n?/g, '\n')
      .replace(/[ ​]/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function stripMarkdown(s) {
    return s
      .replace(/^```.*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/`([^`\n]+)`/g, '$1');
  }

  /** Convert a DOM subtree to text, inserting paragraph breaks around block elements. */
  function domToText(root) {
    const out = [];
    (function walk(node) {
      if (node.nodeType === 3) {
        out.push(node.nodeValue.replace(/\s+/g, ' '));
      } else if (node.nodeType === 1) {
        const tag = (node.localName || node.tagName).toUpperCase();
        if (SKIP_TAGS.has(tag)) return;
        const block = BLOCK_TAGS.has(tag);
        if (block) out.push('\n\n');
        for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
        if (block) out.push('\n\n');
      }
    })(root);
    return normalizeText(out.join(''));
  }

  /** Heuristic "reader mode" extraction from a parsed HTML document. */
  function articleFromDocument(doc) {
    const title =
      (doc.querySelector('meta[property="og:title"]') || {}).content ||
      (doc.querySelector('h1') || {}).textContent ||
      doc.title ||
      '';
    doc.querySelectorAll([...SKIP_TAGS].join(',')).forEach((n) => n.remove());

    const candidates = [doc.querySelector('article'), doc.querySelector('main, [role="main"]')];
    let container = null;
    for (const c of candidates) {
      if (c && c.textContent.trim().length > 500) { container = c; break; }
    }
    const fallback = !container;
    if (fallback) container = doc.body || doc.documentElement;

    container.querySelectorAll(CHROME_SELECTOR).forEach((n) => { if (n !== container) n.remove(); });

    const SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre';
    const parts = [];
    container.querySelectorAll(SEL).forEach((el) => {
      if (el.querySelector(SEL)) return; // keep innermost elements only
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const isHeading = /^H[1-6]$/.test(el.tagName);
      if (fallback && !isHeading && text.length < 40) return; // drop menu/link fragments
      parts.push(text);
    });
    return { title: title.trim(), text: normalizeText(parts.join('\n\n')) };
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function requireLib(name, obj) {
    if (!obj) throw new Error(name + ' failed to load. Check your connection and reload the page.');
  }

  // ---- File formats -------------------------------------------------------

  async function fromPdf(buffer) {
    requireLib('The PDF reader', global.pdfjsLib);
    global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await global.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Group text items into lines by baseline; a big vertical gap marks a paragraph break.
      const lines = [];
      let line = '';
      let lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        const h = item.height || 12;
        if (lastY !== null && Math.abs(y - lastY) > 0.5 * h && line.trim()) {
          lines.push(line.trim());
          if (Math.abs(y - lastY) > 1.8 * h) lines.push('');
          line = '';
        }
        line += item.str;
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.join('\n').replace(/(\w)-\n(?=[a-z])/g, '$1'));
    }
    let title = '';
    try {
      const meta = await pdf.getMetadata();
      title = (meta.info && meta.info.Title) || '';
    } catch (_) { /* metadata is optional */ }
    return { title, text: normalizeText(pages.join('\n')) };
  }

  async function fromDocx(buffer) {
    requireLib('The DOCX reader', global.JSZip);
    const zip = await global.JSZip.loadAsync(buffer);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('This does not look like a valid .docx file.');
    const xml = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paras = [];
    Array.prototype.forEach.call(xml.getElementsByTagNameNS(W, 'p'), collect);
    function collect(p) {
      let s = '';
      (function walk(n) {
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          if (c.namespaceURI === W && c.localName === 't') s += c.textContent;
          else if (c.namespaceURI === W && (c.localName === 'tab' || c.localName === 'br')) s += ' ';
          else walk(c);
        }
      })(p);
      if (s.trim()) paras.push(s.trim());
    }
    let title = '';
    const core = zip.file('docProps/core.xml');
    if (core) {
      const m = (await core.async('string')).match(/<dc:title>([^<]*)<\/dc:title>/);
      if (m) title = m[1];
    }
    return { title, text: normalizeText(paras.join('\n\n')) };
  }

  function resolvePath(base, href) {
    const parts = (base ? base.split('/').slice(0, -1) : []).concat(decodeURIComponent(href.split('#')[0]).split('/'));
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  }

  async function fromEpub(buffer) {
    requireLib('The EPUB reader', global.JSZip);
    const zip = await global.JSZip.loadAsync(buffer);
    const parse = (s, type) => new DOMParser().parseFromString(s, type);
    const container = zip.file('META-INF/container.xml');
    if (!container) throw new Error('This does not look like a valid .epub file.');
    const rootEl = parse(await container.async('string'), 'application/xml').querySelector('rootfile');
    const opfPath = rootEl && rootEl.getAttribute('full-path');
    const opfFile = opfPath && zip.file(opfPath);
    if (!opfFile) throw new Error('Could not find the book contents in this .epub file.');
    const opf = parse(await opfFile.async('string'), 'application/xml');

    const manifest = {};
    opf.querySelectorAll('manifest > item').forEach((it) => { manifest[it.getAttribute('id')] = it.getAttribute('href'); });
    const titleEl = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
    const title = titleEl ? titleEl.textContent.trim() : '';

    const chapters = [];
    for (const ref of opf.querySelectorAll('spine > itemref')) {
      if (ref.getAttribute('linear') === 'no') continue;
      const href = manifest[ref.getAttribute('idref')];
      const file = href && zip.file(resolvePath(opfPath, href));
      if (!file) continue;
      const html = await file.async('string');
      let doc = parse(html, 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) doc = parse(html, 'text/html');
      const body = doc.querySelector('body') || doc.documentElement;
      const text = domToText(body);
      if (text) chapters.push(text);
    }
    return { title, text: normalizeText(chapters.join('\n\n')) };
  }

  /** Extract text from a File object based on its type/extension. */
  async function fromFile(file) {
    const name = file.name || '';
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    let result;
    if (ext === 'pdf' || file.type === 'application/pdf') {
      result = await fromPdf(await file.arrayBuffer());
    } else if (ext === 'docx') {
      result = await fromDocx(await file.arrayBuffer());
    } else if (ext === 'epub') {
      result = await fromEpub(await file.arrayBuffer());
    } else if (ext === 'md' || ext === 'markdown') {
      result = { title: '', text: normalizeText(stripMarkdown(await file.text())) };
    } else if (ext === 'doc' || ext === 'pages' || ext === 'rtf') {
      throw new Error('.' + ext + ' files are not supported. Save as .docx or .txt first.');
    } else {
      result = { title: '', text: normalizeText(await file.text()) };
    }
    return { title: (result.title || '').trim() || baseName(name), text: result.text };
  }

  // ---- URLs ---------------------------------------------------------------

  function normalizeUrl(input) {
    let s = input.trim();
    if (!s) throw new Error('Enter a web address first.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let url;
    try { url = new URL(s); } catch (_) { throw new Error('That does not look like a valid web address.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses are supported.');
    if (/\s|%20/.test(url.hostname) || (!/[.:]/.test(url.hostname) && url.hostname !== 'localhost')) {
      throw new Error('That does not look like a valid web address.');
    }
    return url;
  }

  async function timedFetch(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  /** Reader-style output from r.jina.ai: "Title: ...\n\nURL Source: ...\n\nMarkdown Content:\n..." */
  function parseJina(raw) {
    const idx = raw.indexOf('Markdown Content:');
    const header = idx >= 0 ? raw.slice(0, idx) : '';
    const body = idx >= 0 ? raw.slice(idx + 'Markdown Content:'.length) : raw;
    const m = header.match(/^Title:\s*(.+)$/m);
    return { title: m ? m[1].trim() : '', text: normalizeText(stripMarkdown(body)) };
  }

  /**
   * Fetch a web page and return its readable text. Tries the page directly first (works for
   * sites that allow cross-origin requests), then falls back to the r.jina.ai reader proxy.
   */
  async function fromUrl(input) {
    const url = normalizeUrl(input);
    const host = url.hostname.replace(/^www\./, '');
    let result = null;

    try {
      const res = await timedFetch(url.href, { credentials: 'omit' }, 8000);
      if (res.ok) {
        const type = res.headers.get('content-type') || '';
        if (/pdf/i.test(type)) {
          result = await fromPdf(await res.arrayBuffer());
        } else if (/text\/plain/i.test(type)) {
          result = { title: '', text: normalizeText(await res.text()) };
        } else {
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
          result = articleFromDocument(doc);
        }
      }
    } catch (_) { /* blocked by CORS or network; fall through to the proxy */ }

    if (!result || result.text.split(/\s+/).length < 20) {
      let res;
      try {
        res = await timedFetch(JINA_PROXY + url.href, { headers: { Accept: 'text/plain' } }, 25000);
      } catch (_) {
        throw new Error('Could not load that page. Check the address and your connection.');
      }
      if (!res.ok) throw new Error('Could not load that page (error ' + res.status + ').');
      result = parseJina(await res.text());
    }
    return { title: result.title || host, text: result.text };
  }

  global.Extract = { fromFile, fromUrl, normalizeText, stripMarkdown };
})(window);
