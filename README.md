# EPUB Reader

A Japanese-first e-book reader for macOS, built on **foliate-js** (layout and rendering)
and **Rust/Tauri** (shell and I/O). It renders Japanese **vertical writing (vertical-rl)
with right-to-left paging** without overflow, and reads books aloud through
**VOICEVOX / AivisSpeech**.

日本語版は [README.ja.md](README.ja.md)。

> **Status**: version 0.4.0, macOS only. It runs on real hardware (WKWebView) and is
> driven by an automated test suite, but it has not been through a wide public beta.
> See [Known limitations](#known-limitations).

## Why

Most readers treat Japanese vertical writing as an afterthought: they fall back to scroll
mode, and text runs past the edge of the viewport. foliate-js paginates with CSS columns,
so that class of overflow cannot happen structurally — vertical or horizontal, a page is a
discrete box.

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
- Sleep timer (stop reading, then optionally sleep or shut down the Mac)

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

- macOS (Apple Silicon or Intel). There is no Windows or Linux build — the menu bar and
  the sleep/shutdown paths are macOS-specific.
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
./scripts/package-macos.sh   # → dist/epub-reader-<version>-macos.{dmg,zip}
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

- **macOS only.** No Windows or Linux build.
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
