/* Kokoro-82M text-to-speech running in a worker (ONNX/WASM, entirely in the browser).
   The library and model are fetched on first use (jsDelivr + Hugging Face), then cached by the browser. */
const KOKORO_JS = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;

async function load() {
  if (tts) return;
  const { KokoroTTS } = await import(KOKORO_JS);
  const files = new Map();
  tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (!p || !p.file) return;
      if (p.status === 'progress') {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
        let l = 0, t = 0;
        for (const f of files.values()) { l += f.loaded; t += f.total; }
        postMessage({ type: 'progress', loaded: l, total: t });
      }
    },
  });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load();
      postMessage({ type: 'ready' });
    } else if (m.type === 'gen') {
      await load();
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      const samples = out.audio;
      postMessage({ type: 'audio', id: m.id, samples, rate: out.sampling_rate }, [samples.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
