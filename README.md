# voxo

voxo is an Electron app that reads web pages, pasted text, and text-based PDFs
aloud with local text-to-speech (Piper, Kokoro or Bark through `tts.py`).

- **Reader mode:** Mozilla Readability, the same library behind Firefox reader mode.
  Menus, ads, comments and footers are dropped. Pages that build their text with
  JavaScript are loaded in a hidden window as a fallback.
- **Follow along:** the paragraph being read is tinted and marked in the margin.
  Click any paragraph to start from there.
- **Local speech:** `tts.py` runs as one long-lived worker, so the voice model
  loads once. The next paragraphs are prepared while the current one plays.
- **Custom text and PDFs:** paste text into the app or open a PDF from disk. PDF
  text and page previews are extracted locally; scanned PDFs can be viewed but
  need OCR before their text can be read aloud.

## Set up

You need Node 20 or newer and Python 3.10 or newer.

```bash
cd voxo
npm install

# Python side (inside the tts folder, so the app finds it automatically)
cd tts
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install numpy kokoro-onnx piper-tts      # add: torch "transformers<5"  for Bark
deactivate
cd ..
```

Run it:

```bash
npm start
npm start -- https://example.com/some-article    # open a page straight away
```

### First run: downloading voices

Nothing is downloaded unless you allow it. Open **Voice** in the app, turn on
**Allow model downloads**, and press play. The voice or model is fetched once
(Kokoro is about 300 MB). Turn the option off again afterwards if you like.

### Reusing your existing setup

If you already have a working folder with a venv, `voices/` and `models/`, point
the app at it instead of setting up again. Replace that folder's `tts.py` with
the one in `tts/tts.py` (it adds the worker mode), then:

```bash
TTS_SCRIPT=~/Projects/Audio/tts.py \
TTS_PYTHON=~/Projects/Audio/venv/bin/python \
npm start
```

## Using it

| Action | How |
|---|---|
| Open a page | Paste an address and press Enter (Cmd or Ctrl + L focuses the box) |
| Read custom text | Select **Paste text**, enter or paste text, then select **Read text** |
| Read a PDF | Select **Open PDF** and choose a file |
| Play or pause | Space, or the round button |
| Previous or next paragraph | Left and right arrow keys |
| Start from a paragraph | Click it |
| Change speed | The speed menu in the player (changes apply immediately) |
| Change engine or voice | **Voice** button at the top right |

Images, code blocks, and image captions are shown but not read. Footnote markers
like `[1]` and long web addresses are dropped from the spoken text.

## Build and ship

The installer includes the Electron app and a frozen `voxo-tts` executable with
the Python runtime and Kokoro, Piper, and Bark speech libraries. Kokoro is the
default engine and runs through ONNX on CPU on every platform. Its model files
download on first use after the user enables **Allow model downloads** in
**Voice**. The app stores downloaded models in its writable user data
directory. Piper's default voice is included. End users do not need Python
installed; Python is needed only on the build machine to create the frozen
speech executable.

These commands create installable release files: a drag-to-install DMG for
macOS and a Windows NSIS setup `.exe`. Build on the target OS and architecture.
PyInstaller cannot cross-compile the speech executable, so build each target on
its matching machine:

| Target | Build machine | Command | Output |
|---|---|---|---|
| Apple Silicon Mac | Apple Silicon Mac | `npm run dist:mac:arm64` | `dist/voxo-<version>-mac-arm64.dmg` |
| Intel Mac | Intel Mac | `npm run dist:mac:x64` | `dist/voxo-<version>-mac-x64.dmg` |
| Windows 10/11 x64 | Windows x64 | `npm run dist:win:x64` | `dist/voxo-<version>-win-x64.exe` |

Each build needs Node 22 and Python 3.12. In a clean checkout, install the
packaging dependencies once, then run the command for that machine:

```bash
npm ci
python3.12 -m venv .venv-build
source .venv-build/bin/activate
python -m pip install -r packaging/requirements-tts.txt
npm run dist:mac:arm64
```

Use `npm run dist:mac:x64` on an Intel Mac, or `npm run dist:win:x64` on
Windows x64. These `dist:*` commands build the Python speech runtime first and
then create the installer. You can also run just `npm run package:mac:arm64`,
`npm run package:mac:x64`, or `npm run package:win:x64` when
`build/tts/voxo-tts/voxo-tts` (or `build/tts/voxo-tts/voxo-tts.exe` on Windows)
has already been built.

On Windows, create and activate the venv with `py -3.12 -m venv .venv-build`
and `.venv-build\\Scripts\\Activate.ps1`, then run the same pip and npm
commands with `npm run dist:win:x64`. Build Intel Mac installers on an Intel
Mac; Windows and macOS binaries must be frozen on their native platforms.

For automatic builds, push a version tag such as `v0.1.0`. The GitHub Actions
workflow builds Apple Silicon Mac, Intel Mac, and Windows x64 installers,
smoke-checks the frozen Piper worker, and publishes the files on a GitHub
Release. A manually started workflow run builds downloadable artifacts but
does not publish a release.

Without signing secrets, the generated installers are unsigned. For signed
releases, add `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` for a Developer ID
Application certificate, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` for notarization. Add `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` for an Authenticode certificate. Store these as GitHub
Actions secrets before publishing broadly.

The Intel Mac build pins PyTorch 2.2.2 and ONNX Runtime 1.23.2 because those
are the final upstream releases with Intel macOS wheels. Kokoro ONNX runs on
CPU and is used on Apple Silicon, Intel Mac, and Windows.

## Tests

```bash
npm test
```

Covers article extraction, the fetch-then-render fallback and the speech worker
protocol (with a fake engine, so no models are needed).

## Notes and limits

- **Tested here:** the extraction, the worker protocol, and the whole app running
  in a real Electron window on Linux, with a fake speech engine standing in for
  the models. It has not been run on macOS or with the real Piper, Kokoro or
  Bark engines.
- **Bark is slow.** If it can't keep ahead of playback you will see "Preparing
  the voice…" between paragraphs. Piper and Kokoro should keep up.
- **Text only.** Images are not shown. Pages behind a login or paywall can't be
  read, because the app doesn't sign in.
- **Privacy.** Page and visible image fetches are the network use; image requests
  omit the page referrer. Speech is generated on your computer. For
  script-built pages the app runs the page's own JavaScript in a hidden,
  sandboxed window with audio muted.
- **Development vs. release.** `npm start` runs the Electron development shell.
  Use the release commands above to produce a standalone app with the bundled
  Python speech worker. Model downloads remain optional.
- **Environment variables:** `TTS_PYTHON` (Python to use) and `TTS_SCRIPT` (path
  to `tts.py`).

## Layout

```
main.js              window, page fetching, speech worker, IPC
preload.js           the small, safe API the page can call
lib/extract.js       HTML to reader blocks and speech chunks
lib/loader.js        fetch, then render if the page is an empty shell
lib/tts-worker.js    manages `tts.py --serve`
renderer/            reader view and player
tts/tts.py           speech engines (also usable on its own from the terminal)
test/                tests and a fake speech engine
assets/icon.svg      editable voxo icon artwork
assets/icon.png      app and Linux icon
assets/icon.icns     macOS app icon
assets/icon.ico      Windows app icon
packaging/           frozen Python runtime spec and dependencies
.github/workflows/   native macOS and Windows release builds
```
