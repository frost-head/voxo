# voxo

voxo is a desktop reader for web pages, pasted text, and text-based PDFs. Speech
is generated locally with Kokoro using the JavaScript runtime; the app does not
require Python.

- **Reader mode:** Mozilla Readability removes page furniture. JavaScript-built
  pages are loaded in a hidden window when needed.
- **Follow along:** the current paragraph is highlighted. Click a paragraph to
  start reading there.
- **Custom text and PDFs:** paste text or open a PDF. Text extraction and PDF
  previews run locally; scanned PDFs need OCR before they can be read aloud.
- **Local speech:** Kokoro runs through Transformers.js and ONNX Runtime on the
  CPU. The model is downloaded on first use and cached on the computer.

## Run from source

Requirements: Node.js 22 or newer.

```bash
npm ci
npm start
```

The Kokoro model is not downloaded until you allow its download in **Voice**
settings and start playback. Once cached, voxo can use it without an internet
connection. No Python installation or virtual environment is used.

## Use voxo

| Action | How |
|---|---|
| Open an article | Paste a link and press Enter (Cmd/Ctrl+L focuses the link field) |
| Add your own text | Select **Add text**, enter text, then select **Open in reader** |
| Open a PDF | Select **Open PDF** and choose a file |
| Play or pause | Space, or the round button |
| Move between paragraphs | Left and right arrow keys |
| Start at a paragraph | Click it |
| Change speed | Move the speed slider in the player |
| Tune the page | Use **Reading** to change theme, font, size, width, and spacing |
| Change voice | Use the **Voice** menu |

Images and code blocks are shown but not read. Footnote markers and long web
addresses are omitted from spoken text.

## Build installers

Build on the target operating system and architecture. Electron’s native ONNX
Runtime package is included in the app, and end users do not need Node.js or
Python installed.

| Target | Build machine | Command | Output |
|---|---|---|---|
| Apple Silicon Mac | Apple Silicon Mac | `npm run dist:mac:arm64` | `dist/voxo-<version>-mac-arm64.dmg` |
| Intel Mac | Intel Mac | `npm run dist:mac:x64` | `dist/voxo-<version>-mac-x64.dmg` |
| Windows 10/11 x64 | Windows x64 | `npm run dist:win:x64` | `dist/voxo-<version>-win-x64.exe` |

On each build machine:

```bash
npm ci
npm run dist:mac:arm64
```

Use the matching `dist:*` command from the table for Windows or Intel Macs.
There is no Python build step. For automatic releases, push a version tag such
as `v0.1.0`; GitHub Actions builds the three platform installers.

Installers are unsigned unless signing credentials are configured. For signed
releases, configure the macOS Developer ID/notarization secrets or the Windows
Authenticode secrets in GitHub Actions.

## Project layout

```text
main.js                    Electron main process and IPC
preload.js                 Renderer API bridge
lib/tts-worker.js           Kokoro utility process and request queue
lib/tts-engine-worker.js    JavaScript Kokoro inference
lib/extract.js              HTML article extraction and speech chunking
lib/loader.js               Web fetching and render fallback
renderer/                   Reader UI and playback
assets/                     App icons
test/                       Text extraction and page loading tests
```
