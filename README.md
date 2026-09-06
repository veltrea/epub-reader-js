# EPUB Reader

A Japanese-first e-book reader for macOS, built on **foliate-js** (layout and rendering)
and **Rust/Tauri** (shell and I/O). It renders Japanese **vertical writing (vertical-rl)
with right-to-left paging** without overflow, and reads books aloud through
**VOICEVOX / AivisSpeech**.

日本語版は [README.ja.md](README.ja.md)。

> **Status**: version 0.4.0, macOS and Windows. Both run on real hardware and are
> driven by an automated test suite, but neither has been through a wide public beta.
> **The Windows build has been checked less thoroughly than the macOS one** — see
> [Known limitations](#known-limitations).
> See [Known limitations](#known-limitations).

## Why

Most readers treat Japanese vertical writing as an afterthought. Here is what that looks
like in practice: **open a vertical book and the text spills off the left and right of the
window.** What spilled off is outside the window, so you cannot see it — and **you cannot
scroll sideways to reach it either.** The reading simply stops there. Every character is
present in the file; you just cannot get to it.

foliate-js cannot spill in the first place. **It decides how much fits on a page, then
pours the text in** (using the CSS column feature). What does not fit is not pushed off the
edge — it **goes on the next page**. Vertical or horizontal, the same.

The intended use is **previewing your own manuscript** — seeing an EPUB the way a reader
will see it. Where a book's data is broken or unusual, this reader errs toward showing
something sensible rather than reporting a defect.

## Features

**Library**
- Import single files, whole folders (recursive), Finder drag-and-drop, or double-click in Finder
- Multiple shelves (separate libraries), collections with sub-collections, favourites
- Gojūon (Japanese syllabary) grouping by author reading, with hand-editable readings
- Sort by recent/title/author/publisher, filter by field, cover thumbnails with a fallback cover

**Reader**
- Automatic vertical / horizontal / RTL layout, decided by how the book actually typesets —
  not only by what the OPF declares
- Table of contents, progress slider (mirrored for RTL), bookmarks, full-text search
- Paging by buttons, arrow keys, wheel, and tap zones
- Font size, line height, forced margins, themes (light / sepia / dark)
- Custom CSS, both global and per-book
- Fixed-layout (FXL) spreads, and spread shifting for photo books whose pages pair up wrong
- Image-only pages (covers, plates) are drawn to fill the page box
- Auto page turn on a timer

**Read-aloud**
- VOICEVOX / AivisSpeech, with voice, speed, and pause-length control
- Per-sentence highlight plus karaoke-style progress within the sentence
- Reads across chapter boundaries; starts from a selection; skips ruby
- A **reading dictionary** for proper nouns the engine mispronounces — register
  spelling → kana with a priority, as a word or a pattern
- Export the current section as audio, or as a video with the text on screen
- Sleep timer (stop reading, then optionally sleep or shut down the computer)

**Other**
- Japanese / English UI, including the native macOS menu bar (one set of translations
  feeds both — the Rust side reads the very same JSON files)
- Optional side-by-side translation via any OpenAI-compatible API — a server on your own
  machine (LM Studio and the like), or a cloud service once you supply an API key

## Supported formats

| Format | State |
|---|---|
| EPUB 2 / 3 (reflowable and fixed-layout) | The main target; verified |
| CBZ, FB2, FBZ | Verified (import, metadata, cover, reading) |
| AZW3, KF8 | Verified (import and reading; vertical writing survives the conversion) |
| MOBI, AZW | Verified (import and reading), but **a vertical book comes out horizontal** — the old MOBI format has nowhere to record vertical writing. The writing-mode button in the toolbar puts it back |

Anything not in this table is ignored: dropping such a file on the window does nothing, and
it does not appear in the file dialog.

## Requirements

- macOS (Apple Silicon or Intel), or Windows 11 (64-bit). Windows needs **WebView2**,
  which ships with Windows 11. There is no Linux build.
- For read-aloud: [VOICEVOX](https://voicevox.hiroshiba.jp/) (`:50021`) or
  [AivisSpeech](https://aivis-project.com/) (`:10101`), running locally. Neither is
  bundled; install them yourself.
- For translation (optional): any OpenAI-compatible API. Run it on your own machine
  ([LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/)) and nothing leaves it;
  enter an API key in the settings and it will talk to a cloud service instead (which does
  send your text there).

**Voice licensing**: audio produced by these engines carries the terms of the individual
voice library. Most require crediting the character's name when you publish the result.
Check the terms of the voice you use before publishing audio or video exported from here.

## Install

### Windows

Download the installer (`.exe` or `.msi`) and run it.

**A blue "Windows protected your PC" screen appears the first time.** This project does
not carry a code-signing certificate; it does not mean the file is unsafe.
**Click "More info", then "Run anyway".**

### macOS

No notarized release is published — this project does not carry an Apple Developer ID.
Build it yourself, or use an ad-hoc-signed release build.

```bash
# prerequisites: Rust (1.77+) and the Tauri CLI
cargo install tauri-cli --version '^2'

git clone https://github.com/veltrea/epub-reader-js
cd epub-reader-js/src-tauri
cargo tauri build --bundles app
# → src-tauri/target/release/bundle/macos/epub-reader.app
```

A build you made yourself carries no quarantine flag and opens normally.

If you instead download a `.dmg` / `.zip` release, macOS will refuse it the first time
("cannot be opened because the developer cannot be verified"). On macOS 15 and later the
right-click → Open trick is gone; use **System Settings → Privacy & Security → Open
Anyway**, or clear the flag yourself:

```bash
xattr -dr com.apple.quarantine /Applications/epub-reader.app
```

To produce a release build with a valid ad-hoc signature and verified archives:

```bash
./scripts/package-macos.sh               # macOS → dist/epub-reader-<version>-macos.{dmg,zip}
./scripts/xbuild-windows.sh --installer  # Windows → dist/windows/*.{exe,msi}
```

## Usage

See [MANUAL.md](MANUAL.md) (日本語: [MANUAL.ja.md](MANUAL.ja.md)) for the full guide.

## Development

```bash
cd src-tauri && cargo tauri dev    # frontend is served as-is; no build step for JS/CSS

node tests/logic.test.mjs          # DOM-free logic tests
cd src-tauri && cargo test --lib   # Rust unit tests
```

The frontend is plain ESM with no bundler: `src/` is served directly as Tauri's
`frontendDist`. Layout, rendering, and read-aloud control live there; Rust does
persistence, file I/O, and HTTP proxying (the TTS engines are called through Rust to avoid
CORS). Logic that can be pure — kana handling, the reading dictionary, timers — is kept
DOM-free and tested under Node.

Architecture and the built-in test bus are described in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- **No Linux build.**
- **Some things are unverified on Windows.**
  - **Dragging and dropping books onto the window** has not been tried by hand
    (the code path is the one Tauri makes uniform across systems).
  - The **file picker and folder picker** have not been seen open.
  - **Sleep and shutdown** (what the read-aloud timer does when it expires) have not
    been run. The code is written.
  - **Launching the speech engine** has not been tried on a machine that has one.
  - The window still follows macOS conventions. **The application menu sits left of
    "File"**, which is not where Windows users expect it.
- **MOBI and AZW cannot come out vertical.** The old MOBI format has no place to record
  vertical writing, so converting a vertical book yields horizontal text. The writing-mode
  button in the toolbar puts it back. AZW3 and KF8 keep vertical writing on their own.
- Importing large fixed-layout books can take tens of seconds while covers are extracted.
  Progress is shown, but the wait is real.
- Spread shifting for photo books is manual — there is no automatic detection yet.
- The side-by-side translation pane works, but its styling has not been reworked to match
  the rest of the UI.
- Translation quality is whatever the model you connect produces — the app asks and lays out
  the answer, it does not translate. Small models break down on dialogue, honorifics and proper
  nouns, and will invent names. **A translation into a language you cannot read cannot be
  checked by reading it.**

## License

BSD-3-Clause — see [LICENSE](LICENSE).

Bundled third-party components (foliate-js, zip.js, fflate) keep their own licenses; each
is listed with its copyright
holder in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) (日本語:
[THIRD_PARTY_LICENSES.ja.md](THIRD_PARTY_LICENSES.ja.md)). The bundled copy of foliate-js
carries local modifications, itemised in the same file.
