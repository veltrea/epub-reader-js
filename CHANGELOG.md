# Changelog

日本語版は [CHANGELOG.ja.md](CHANGELOG.ja.md)。

This project follows [Semantic Versioning](https://semver.org/). The human-facing version
is bumped by hand; the build number in `src-tauri/build-number` is incremented by
`scripts/package-macos.sh` on every packaged build.

## Unreleased

### Changed

- **The license is now MIT instead of BSD-3-Clause.** Everything bundled (foliate-js, zip.js,
  fflate, Tauri and so on) is under a permissive license. Copies released up to 1.0.0 remain
  under BSD-3-Clause.

## 1.0.0 — 2026-09-13

### Added

- **The reader now runs on Windows 11.** It was macOS-only before. Opening a book,
  reading it vertically, bookmarking, searching, changing settings, and going back to
  the shelf all work on Windows. **The interface appears in Japanese there too.**
  Installers (`.exe` and `.msi`) can be built as well.
  - **Vertical text is typeset the same way as on macOS.** Ruby, tate-chu-yoko and
    emphasis dots all work. The engines differ (WebKit on macOS, Chromium on Windows),
    so ruby renders at a slightly different size, but reading is unaffected.
  - **Some things are still unverified**: drag-and-drop import, the file and folder
    pickers, sleep and shutdown, and launching the speech engine. See "Known
    limitations" in the README.
  - **The window still follows macOS conventions.** The application menu sits left of
    "File", which is not where Windows users expect it.
- **A reading can now be tied to one spot in the text.** Select a word, right-click, and
  choose "Add a reading for this spot only". **The position is a hint; what gets replaced is
  decided by matching the text.** Character counts differ between tools, so trusting a
  position outright would replace a spot one character off. Instead the app looks for the
  same text near the given position and replaces the nearest single match. If the same word
  appears twice nearby, the one you did not point at is left alone. The window (characters
  before and after, 40 by default) can be changed per entry.
- **Conditions on the surrounding characters, in plain words.** "Preceded by" and
  "Followed by" in the entry screen offer hiragana / katakana / a kanji / not a kanji /
  a digit, so the common case needs no regular expression. **This is the fix for a
  single-kanji entry eating compounds**: give 行 the condition "not a kanji" before it and
  銀行 and 旅行 stay as they are. Internally these become lookbehind and lookahead.
- **Patterns can now put conditions on the surroundings (lookbehind and lookahead).**
  Spelling `(?<=[ぁ-ん])行った` replaces only when preceded by hiragana; `(?<![一-龥])行`
  only when *not* preceded by a kanji, so 銀行 and 旅行 are left alone and only the
  standalone 行 changes. **This is how a single-kanji entry stops eating compounds.**
  Such patterns could be written before but never matched: the code re-applied the
  expression to the matched fragment alone, where the surrounding characters are gone,
  so a zero-width condition always failed.
- **Captured groups in a pattern reading are now converted to katakana.** With spelling
  `([ぁ-ん])行った` and reading `$1オコナッタ`, とり行った now reads トリオコナッタ; the
  captured character used to stay in hiragana. `$&` (the whole match) works too. This makes
  "keep the preceding kana, replace only the kanji" expressible.
- **The reading dictionary is split into "All books" and "This book only".** Readings that
  belong to one work — character names and the like — can now be registered without carrying
  them into every other book. When the same text appears in both, "This book only" wins;
  delete it and the "All books" reading comes back. Each entry has an "Applies to" control
  for moving it between the two. On the shelf (no book open) only "All books" is shown.
- **Registering a reading and browsing what is saved are now two separate screens.** One
  screen used to do both, with every saved entry listed right there, so adding a single word
  meant scrolling past the whole dictionary. Now registering from the text, or from
  **Read aloud > Add to reading dictionary…**, opens a screen with **only the text, the
  reading, and the options** — no list. "Done" saves and closes it. To review and edit what
  is saved, choose **Read aloud > Edit reading dictionary…** (or "Browse saved entries"
  at the bottom of the registration screen).
- **Registering a word you registered before opens it with the saved reading filled in.**
  No second empty entry is created — two entries with the same text would leave you guessing
  which one is in effect. The heading then reads "Edit a saved reading". The search order
  matches read-aloud: "This book only" first, then "All books".
- **Which half an entry goes into is now chosen on the registration screen.** "Applies to"
  puts "All books" and "This book only" side by side; tap one. It used to depend on which
  section's "+" you pressed in the list.
- **The speech engine now starts by itself.** If VOICEVOX or AivisSpeech is not running when
  you press read-aloud, the app starts it and waits until it can speak. Starting can take a
  dozen seconds or so; meanwhile the bar at the bottom says "Starting the speech engine…".
  Only VOICEVOX and AivisSpeech can be started this way — with "Custom URL" the app cannot
  tell which program to run, so start it yourself as before.

### Fixed

- **Fixed reader settings not reaching the text on Windows.** Changing the font size,
  line height or theme had no visible effect. The cause is that Windows' web view
  (WebView2) ignores a style element created after the page has loaded. Switching to a
  different way of applying the styles fixed it. **macOS was never affected.**
- **The test bus no longer goes dead after a page reload.** Right after a reload the path to
  the backend is not ready yet, so the "may I use the test bus" query can fail once. Giving
  up there left that page unreachable from outside. It now retries briefly, but only on a
  failed query — a plain "no" is still taken as the answer.
- **The read-aloud band no longer follows the shape of the line box.** The sentence being read
  was also being *selected*, so the OS selection band was painted on top of our own band.
  A selection band fills the whole line box, so it drifted sideways from the glyphs, ran past
  the end of the text, bulged toward the ruby side, and merged into one block across two lines.
  The cause was passing the "treat this as a selection" flag when scrolling to the reading
  position; the prototype never passed it.
- Ruby annotations are excluded from the band. Ruby made the rects double up, and two
  translucent bands stacked there, darkening just that spot.
- The band is now the same thickness whether a sentence fits on one line or spans two.

## 0.4.0 — 2026-08-14 (first public release)

### Removed

- **PDF support has been withdrawn.** The app no longer accepts PDF files at all: they are
  gone from the import filter, the file dialog, and the Finder file associations, and the
  bundled copy of pdf.js has been deleted.

  It was withdrawn because **the design was wrong**. Instead of giving PDF its own display
  layer, PDF was forced into the machinery that displays EPUB: one PDF page was passed off
  as one EPUB chapter, the table of contents and the cover were filled in with fabricated
  data, and the whole thing was handed to the same entry point EPUB uses. As a result the
  EPUB column layout, page turning, and chapter loading were applied to PDF as well. The
  glue written for that came to roughly 400 lines including the test scaffolding. Four
  problems appeared at once: the cover could not be extracted, the text could not be
  searched, the page stayed blank, and opening several files froze the app. "The drawing
  step never finished", which this entry used to give as the reason, was one of those
  symptoms — not the cause.

  The right approach was to put a PDF layer over the window and hand the file straight to a
  library that displays PDF. A separate PDF reader, built as its own project to check that,
  displayed pages without trouble. So the PDF code that lived here was not something to
  repair; it was something to throw away whole. Refusing the file is kinder than accepting
  it and showing a blank page.

  Three things got smaller as a result: the bundle lost 13 MB (pdf.js accounted for about
  70% of the tracked files), four third-party attributions are no longer needed (pdf.js,
  Adobe CMaps, Liberation fonts, Foxit fonts), and the local modifications to foliate-js
  went from three down to one.

  If PDF comes back, it will not be rebuilt inside this app's display machinery: it will be
  a separate window driven by a PDF-only library. The removal commit is a record rather
  than something to revert.

### Added

- **The bilingual pane is now reachable.** 0.3.0 shipped the implementation without exposing
  it; there is now a "Translation" tab in Settings, an **あA** toolbar button, and
  **View > Show / hide bilingual pane** in the menu bar.
- **API key authentication for OpenAI-compatible APIs.** The server URL and API key are set in
  Settings, so a server on your own machine (LM Studio, Ollama) and a cloud service both work
  through the same path.
- The number of cached translations is shown in Settings, and can be cleared there.
- **Books can be dropped on the window while you are reading.** Until now only the shelf
  accepted a drop. Drop a single book and it is imported and then **opened straight away**;
  drop several files or a folder and they are imported while you stay on the shelf, since
  there is no way to tell which one you meant to read.
- **The table of contents folds branch by branch.** In a book with three levels of headings
  the list grew long enough that reaching the chapter you wanted meant scrolling past
  everything else. Items with children now carry a twist that opens and closes them. Opening
  follows only the chapter being read; **branches you opened by hand stay open**, so the list
  does not move under you while you are using it.

### Fixed

- **Models that think before answering returned nothing at all when asked to translate.**
  Neither `chat_template_kwargs`, nor `reasoning_effort`, nor `/no_think` had any effect — the
  model spent every token it was given on thinking. Telling it its thinking is already done
  turned the same passage on the same model from **90 seconds and an empty result into 2
  seconds and a translation**.
- A preamble such as "English:" was left in place when translating into a language other than
  Japanese.
- The translation cache key did not include the source language, so changing it kept serving
  the earlier translation.
- **On a picture page the image used only half the window and sat against one side.** In a
  1099 × 696 window the picture box came out 696 × 696 — square — leaving 403 pixels unused
  every time: at the right edge in vertical writing, at the left edge in horizontal. The box
  was sized by the column width, and the column width equals the window height, so a wide
  window always produced a square.
- **Double-clicking a row in the bilingual pane did nothing.** It asked the text to jump to
  the paragraph the row came from, but the pane is built only from paragraphs **already in
  view**, so the destination was always on screen. Instead of jumping, the paragraph is now
  **highlighted for 1.8 seconds**. The mark clears when the page changes.

### Corrected in the documentation

- **The README called MOBI, AZW, AZW3 and KF8 unverified.** All four were made and opened:
  all four work. `.azw3` and `.kf8` keep vertical writing. `.mobi` and `.azw` come out
  horizontal, because the old MOBI format has nowhere to record vertical writing (the
  writing-mode button in the toolbar puts it back).

## 0.3.0 — 2026-08-07

First release intended for other people to use.

### Added

- **Multiple shelves.** Separate libraries with their own books, collections, and reading
  positions. Deleting a shelf moves its data to `Deleted/` rather than erasing it.
- **Collections and favourites.** Nested collections, drag-free assignment from the book
  menu, and an "unfiled" scope.
- **Folder import.** Pick a folder and take in every book under it, recursively, with
  progress and a cancel button.
- **Auto page turn** on an interval, which yields to read-aloud and to manual paging.
- **Sleep timer.** Stop reading after N minutes, then optionally sleep or shut down the
  Mac. Shutdown waits out a 30-second grace period you can cancel.
- **More formats**: CBZ, FB2, FBZ, and the Kindle family (MOBI/AZW/AZW3/KF8) alongside
  EPUB. Double-clicking a book in Finder opens it.
- **Export** the current section as audio, or as a video with the text on screen.
- **Side-by-side translation** through any OpenAI-compatible local server.
- Every feature is reachable by name from the native menu bar.
- Fallback covers for books that have none; the shelf backdrop uses the cover of whatever
  you were last reading.

### Changed

- Vertical/horizontal/RTL is now decided by **how the book actually typesets**, not only
  by what the OPF declares. Arrow keys, tap zones, and the progress slider all follow that
  same answer.
- Image-only pages (covers, plates) fill the page box instead of floating at their
  intrinsic size.
- The UI was reworked to match the Swift prototype it was ported from.

### Fixed

- **The sleep timer can be operated from the library.** Its menu items were live there but
  did nothing, and the timer itself was destroyed when you closed a book. It now survives
  the move between library and reader, and can be cancelled from either.
- Removed dead menu handlers for a menu item that no longer exists (`file.dict`).
- Karaoke-style highlighting left painted residue in vertical multi-column layouts.

### Security

- **The test bus is disabled in release builds.** It long-polls a local port and executes
  whatever arrives with the app's own privileges, so a distributed build left it open to
  any local process that grabbed the port first — including screen capture and writing
  files to arbitrary paths. It now requires a debug build or `EPUB_READER_TESTBUS=1`.
  `capture_window` is gated the same way.
- The Content Security Policy is now declared in `tauri.conf.json` as well as in the page
  `<meta>` tags, so it also covers anything Tauri itself renders.

### Packaging

- `scripts/package-macos.sh` builds, re-signs ad-hoc, and produces a dmg and a zip, then
  verifies both the way a recipient would extract them. Tauri's build-time signature
  leaves resources unsealed, and a plain `ditto` zip smuggles AppleDouble files that break
  the seal on `unzip`; the script exists to catch both.
- Added `LICENSE` (BSD-3-Clause) and `THIRD_PARTY_LICENSES.md`, which itemises every
  bundled component and the local modifications made to foliate-js.
- Sample images under `test-books/` are now generated by
  `scripts/make-sample-images.py` instead of being photographs of unclear provenance.

## 0.2.0 — 2026-07-27 (not released)

Ported display, dictionary, and translation features from the reference specification.

## 0.1.0 — 2026-07-26 (not released)

Initial build: library, reader with vertical writing, VOICEVOX read-aloud with
sentence-level highlight tracking, and the reading dictionary.
