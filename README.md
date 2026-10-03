# FlashReader

A static website that shows text back to you one word at a time (rapid serial visual presentation), with the pivot letter of each word highlighted and aligned so your eyes never move.

**Input:** paste text, upload `.txt` / `.md` / `.pdf` / `.epub` / `.docx`, or enter a web address.
**Reader:** adjustable WPM (100–1000), smart pauses on punctuation and long words, play/pause, ±10-word skip, scrub bar, restart, text size, light/dark theme.
**Keys:** `Space` play/pause · `←`/`→` ±10 words (`Shift` ±1) · `↑`/`↓` speed · `Home` restart · `Esc` exit.

Text, reading position and settings are stored only in your browser's `localStorage`.

## Run it

No build step. Serve the folder with any static server and open it:

```sh
python3 -m http.server 8000
```

`vendor/` holds pinned copies of [pdf.js](https://github.com/mozilla/pdf.js) 3.11.174 (PDF) and [JSZip](https://stuk.github.io/jszip/) 3.10.1 (EPUB/DOCX), so nothing loads from a CDN.

## Web pages

A page is first fetched directly from the browser, which only works for sites that allow cross-origin requests. Otherwise it falls back to the [r.jina.ai](https://jina.ai/reader/) reader service, which receives the address you enter. To avoid the third party, replace `JINA_PROXY` in `js/extract.js` with your own proxy endpoint.
