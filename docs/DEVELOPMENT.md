# Development

日本語版は [DEVELOPMENT.ja.md](DEVELOPMENT.ja.md)。

## Layout

```
src/                     frontend — plain ESM, no bundler, served as Tauri's frontendDist
  index.html  app/shelf.js     library
  reader.html app/reader.js    reader
  app/tts.js                   read-aloud control (foliate's sentence split + highlight,
                               with VOICEVOX swapped in for the audio)
  app/dictionary.js kana.js    reading dictionary and kana utilities (pure, Node-testable)
  app/sleeptimer.js autopager.js timers.js   timers (pure logic + a shared instance)
  app/api.js                   thin wrapper over Tauri commands (falls back to no-ops in a browser)
  app/menu.js                  bridge for the native menu bar
  app/store.js ui-modals.js i18n.js  persistence, modals, translations
  locales/*.json               the single source of UI strings — Rust reads these too
  foliate-js/                  vendored rendering engine (locally modified; see THIRD_PARTY_LICENSES.md)

src-tauri/               Rust — a thin I/O layer
  src/lib.rs                   JSON store, book import, file read, TTS/LLM proxying
  src/menu.rs                  native menu bar, built from src/locales/*.json via include_str!

tests/                   logic tests, the test-bus client, and an E2E smoke test
mcp/testbus-mcp/         the test-bus bridge, also exposed as an MCP server
```

**Design rule**: layout, rendering, and read-aloud control belong to the frontend. Rust
only persists data and proxies HTTP (the TTS engines are called through Rust to avoid
CORS). Anything that can be pure logic is kept DOM-free so it can be tested under Node.

## Content Security Policy

The CSP lives in **two places, deliberately kept identical**: the `<meta>` tags in
`src/index.html` and `src/reader.html`, and `app.security.csp` in
`src-tauri/tauri.conf.json`. The meta tags cover the pages; the conf entry covers anything
Tauri itself renders (error pages, future windows). Change one, change the other.

Note that `script-src 'self'` means `new Function` and `eval` do not work. That is
intentional; do not relax it to make a debugging shortcut work.

## Tests

```bash
node tests/logic.test.mjs          # DOM-free logic (kana, dictionary, timers, …)
cd src-tauri && cargo test --lib   # Rust units (menu translations, path handling, extensions)
```

Both run without a display, a book, or a TTS engine.

## The test bus

The app can be driven and observed from outside — no screenshots, no synthetic clicks.
The frontend long-polls a local bridge, runs whatever command arrives, and posts the
result back.

- `src/app/testbus.js` — the in-app side
- `mcp/testbus-mcp/server.mjs` — the bridge, which is also an MCP server (Node, zero
  dependencies). It serves `POST /cmd` and MCP stdio. If the port is already taken it
  switches to client mode and forwards to the existing bridge, so a standalone bridge and
  an MCP-spawned one never fight.
- `tests/tb.mjs` — a small Node client
- `tests/smoke.mjs` — an end-to-end smoke test
- `tests/shot.mjs` — saves a PNG of the app's actual rendering

**The test bus is off in release builds.** Commands run with the app's own privileges, so
leaving the port open in a distributed build would let any local process that grabs it
first take screenshots or write files through the reader. It is enabled only in debug
builds, or when the app is started with `EPUB_READER_TESTBUS=1`:

```bash
node mcp/testbus-mcp/server.mjs &                       # bridge
EPUB_READER_TESTBUS=1 ./src-tauri/target/release/epub-reader &
curl -s -XPOST http://127.0.0.1:47832/cmd \
  -H 'Content-Type: application/json' -d '{"cmd":"state"}'
node tests/smoke.mjs
```

`capture_window` (the screenshot command) is gated the same way. macOS may ask once for
Screen Recording permission.

Commands include: `ping` `state` `library` `open` `import` `remove` `setSort` `setFilter`
`visible` `collections` `profiles` `sleepTimerStart/Cancel/State` (library) · `page`
`gotoFraction` `gotoHref` `toc` `currentText` `highlightedText` `progressDir`
`getSettings` `setSetting` `computedFont` `rubyInfo` `imagePageInfo`
`ttsPlay/Pause/Resume/Stop/State` `autoPagerStart/Stop` (reader) · `screenshot`
`navigate` (both).

**Via MCP**: `.mcp.json` registers `epub-reader-testbus`, giving tools `tb_state`,
`tb_page`, `tb_toc`, `tb_current_text`, `tb_tts_play`, `tb_screenshot` and friends.

## Adding a menu item

The native menu is built in `src-tauri/src/menu.rs`; clicks are forwarded to the frontend
and dispatched through the handler tables passed to `setupMenu(...)` in `shelf.js` and
`reader.js`.

When you add an item, **check both handler tables**. An item that is `enabled: true` in
`menu.rs` with no matching handler is a dead menu entry — it looks live and does nothing.
To find them:

```bash
# ids emitted by menu.rs
grep -oE '(item|check|raw_check)\("[a-z][^"]*"' src-tauri/src/menu.rs | sed 's/.*("//;s/"//' | sort -u
# handlers per screen
sed -n "/await setupMenu('reader'/,/}, settings.lang/p" src/app/reader.js | grep -oE "'[a-z][a-zA-Z.]*'"
sed -n "/await setupMenu('shelf'/,/}, settings.lang/p"  src/app/shelf.js  | grep -oE "'[a-z][a-zA-Z.]*'"
```

If an item only makes sense on one screen, pass the `reader` / `shelf` flag to `enabled`
so it greys out instead of silently doing nothing.

## Translations

`src/locales/ja.json` and `en.json` are flat key→string maps and must hold **the same set
of keys** — `cargo test --lib` fails if a menu key is missing from either. Never hardcode
a user-visible string in JS; add a key.

## Releasing

```bash
./scripts/package-macos.sh
```

This builds, re-signs ad-hoc (Tauri's own build-time signature leaves resources unsealed
and fails `codesign --verify`), produces a dmg and a zip, and verifies both by extracting
them the way a recipient would. Read the comments in the script before changing it — each
step is there because of a specific way distribution archives break on macOS.
