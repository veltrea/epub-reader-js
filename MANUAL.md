**Read this in other languages:** [日本語](MANUAL.ja.md)

# E-book Reader User Manual

How to use this Japanese-capable e-book reader with high-quality text-to-speech
(VOICEVOX / AivisSpeech). **macOS only** — the menu bar and the Mac sleep / shutdown
integration depend on macOS. Supports both vertical writing (right-to-left page turning)
and horizontal writing.

## Table of contents

1. [Introduction](#1-introduction)
2. [Setup](#2-setup)
3. [Shelf](#3-shelf)
4. [Reader](#4-reader)
5. [Read aloud](#5-read-aloud)
6. [Bilingual pane](#6-bilingual-pane)
7. [Export (audio and video)](#7-export-audio-and-video)
8. [Where data is stored](#8-where-data-is-stored)
9. [Troubleshooting](#9-troubleshooting)
10. [Credits and terms of use](#10-credits-and-terms-of-use)

## 1. Introduction

<!-- fmt:azw fmt:azw3 fmt:cbz fmt:epub fmt:fb2 fmt:fbz fmt:kf8 fmt:mobi -->
- **Supported formats**: EPUB (reflowable and fixed-layout / FXL), CBZ, FB2 / FBZ.
  - **Any other format is ignored.** Such a file does nothing when dropped on the window,
    and does not appear in the file dialog. Reflowable EPUB is where the effort has gone.
  - MOBI / AZW / AZW3 / KF8 open too (checked against books produced with Calibre). Note
    that **MOBI and AZW come out horizontal even for a vertical book**: the old MOBI format
    has nowhere to record vertical writing. The "Writing mode" toolbar button puts it back.
    AZW3 and KF8 keep vertical writing on their own.
- **Read aloud**: connects to VOICEVOX or AivisSpeech for high-quality speech. The sentence
  being read is highlighted, and the part already spoken fills in as it goes (karaoke style).
- **Bilingual pane**: connects to LM Studio (a local LLM) and shows a translation of the
  paragraphs currently on screen, beside the original.
- If you use neither read-aloud nor translation, no external software is required.

<!-- group:setup -->
## 2. Setup

### Launching

Double-click `epub-reader.app`. The first screen is the shelf.

### Preparing a speech engine (only if you want read-aloud)

1. Install and **start** [VOICEVOX](https://voicevox.hiroshiba.jp/) (port `:50021`) or
   [AivisSpeech](https://aivis-project.com/) (port `:10101`).
2. In the app, open Settings (gear icon) → "Speech engine" and pick the one you run.
3. When "Engine status" shows "connected" you are ready. "Test playback" plays a sample.

### Preparing a translator (only if you want the bilingual pane)

The bilingual pane talks to an **OpenAI-compatible API**. A server on your own machine and a
cloud service work exactly the same way — only the address differs.

**On your own machine** (nothing leaves it)

1. Install [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/) and load a model.
2. Start its server (LM Studio defaults to `:1234`, Ollama to `:11434`).
3. In the app, open Settings → "Translation", enter the URL, and once the connection dot turns
   green, pick a model. Leave the model empty to use the first in the list, and leave the API
   key blank.

**With a cloud API**

1. In the same tab, enter that service's OpenAI-compatible endpoint and your API key.
2. **Your text is sent to that service.** Check its terms before translating unpublished work.

Either way, the translator is not bundled with this app — provide your own (see
[section 10](#10-credits-and-terms-of-use)).

<!-- group:shelf -->
## 3. Shelf

The screen you get on launch. It lists the books you have imported.

### Importing books

- **"Add books" button** — choose "Pick files…" or "Add from folder". Picking a folder
  imports every book inside it, including sub-folders.
<!-- feat:reader-drop -->
- **Drag & drop** — drop book files or folders onto the window. **This works while you are
  reading, too.** Drop a single book and it is imported and then **opened straight away**;
  drop several files or a folder and they are imported while you stay on the shelf (there is
  no way to tell which one you meant to read). Dropping a book that is already in the library
  skips the import and opens it.
- Once imported, the cover thumbnail, title and author are shown.
  Note: for fixed-layout books (photo books) extracting the cover can take tens of seconds.
- Bulk imports show progress and can be stopped at any time with "Cancel" — books already
  added stay.

### Working with the list

| Action | How |
|---|---|
| Open a book | Click its cover |
| Filter | Type in the filter box (scope: all / title / author / publisher) |
| Sort | Recently opened, title, author, or publisher |
| View mode | "Grid" or "By author". By-author groups by Japanese syllabary rows plus "Other" |
| Edit the reading (yomi) | **Right-click** a book → "Edit reading". Affects grouping and title sort |
| Favourite | Right-click → "Add to favourites". Collected under "Favourites" in the sidebar |
| Delete | "Delete" from the book's menu (with a confirmation dialog) |

The reading (yomi) is guessed from the book's metadata. If a kanji title lands in "Other",
set it by hand from the right-click menu.

### Collections

Group books from the sidebar. Collections can be **nested**.

- Create with "New collection", then right-click a book → "Add to collection".
- A book can belong to several collections. "Remove from collection" takes it out.
- Deleting a collection **does not delete books**; sub-collections move up one level.
- "All", "Favourites" and "Unfiled" in the sidebar switch the whole view.

### Separate shelves

You can split the library itself (for example "Work" and "Leisure"). Use
**File > New Shelf… / Switch Shelf / Manage Shelves…**.

- Kept per shelf: **books, collections, favourites, reading positions, bookmarks,
  the reading dictionary and the shared CSS**.
- Shared across shelves: application settings (theme, font size, language, speech engine…).
- **The book files themselves are shared.** Deleting a shelf does not delete files;
  its data is kept under `Deleted/`.
- A new shelf starts empty (not even the bundled samples).

<!-- group:reader -->
## 4. Reader

The screen you get when you open a book. Vertical books are laid out vertically with
right-to-left paging automatically.

### Showing the toolbars (read this first)

When a book opens you see **only the text — no controls**. That is deliberate: the page
gets the whole window.

- **Move the pointer to the top or bottom edge** and the toolbars appear. The top one has
  Back to library, Contents, and the display settings; the bottom one has the progress
  slider and the read-aloud controls.
- Move the pointer back over the text and they hide again.
- You never need the toolbars to reach a feature — **everything is in the menu bar**.
  Back to the library is **⌘L**, contents is **⌘T**, search is **⌘F**.

### Turning pages

| How | What happens |
|---|---|
| Click the left/right edge of the screen (tap zones) | One page in that direction |
| "Previous" / "Next" in the toolbar | One page |
| ← / → keys | One page in that direction (matches what you see, even in vertical RTL) |
| Mouse wheel | One page per notch |
| Progress slider at the bottom | Jump anywhere in the book (the slider is also right-to-left for vertical books) |

Your reading position is saved automatically and restored next time.

### Auto page turn

Turns pages by itself at a fixed interval — for reading with your hands busy.
Use **Go > Auto page turn**.

- Presets are **10 / 15 / 20 / 30 / 45 / 60 / 90 seconds**; "Custom Interval…" takes any
  value from 1 to 3600 seconds.
- The remaining seconds are shown while it runs. Turning a page yourself restarts the count.
- Stop it with **Go > Stop auto page turn**.

### Toolbar

| Button | What it does |
|---|---|
| Back to shelf (←) | Return to the shelf (stops read-aloud if running) |
| Contents | Chapter list, click to jump. **Headings with children carry a twist that folds the branch** (below) |
| Search (🔍) | Full-text search with a hit count; click a hit to go there |
| Bilingual | Open / close the translation pane ([section 6](#6-bilingual-pane-lm-studio)) |
| Custom CSS | Override the book's styling. Two boxes: "all books" and "this book only" (applied as you type) |
| Margin | Force a margin on books whose text runs to the very edge |
| Writing mode | Cycles auto (as the book says) → forced vertical → forced horizontal. The icon is tinted while forced |
| A− / A+ | Smaller / larger text (also `-` / `+` keys) |
| Bookmarks | "Bookmark here" to add, pick from the list to return |
| Shift spread | Fixed-layout books only. Fixes books whose spread pairs are off by one page |
| Settings (⚙) | Theme, font size, line height, read-aloud, translation, language |

<!-- feat:toc-fold -->
### Folding the table of contents

In a book whose headings run part → chapter → section, the contents list gets long. So
**every item with children carries a twist, and clicking it folds or unfolds that branch**.

- The twist opens and closes. **Clicking the label jumps** — you can jump to a heading that
  has children as well as to a leaf.
- Items without children show no twist, but the space is kept so the labels stay aligned.
- When the chapter changes, **the branch down to the chapter being read opens by itself**,
  so the highlighted row is never hidden.
- **Branches you opened by hand stay open** when the chapter changes. A list that rearranges
  itself while you are using it is hard to use.

### Forcing vertical / horizontal writing

The writing direction normally follows the EPUB's own `writing-mode`, but you can override it
for books that declare it wrongly, or simply by preference.

- The toolbar's writing-mode button cycles **auto → forced vertical → forced horizontal**.
- The same value is in the settings dialog under **"Writing mode"** (applies to all books,
  saved automatically).
- Switching does not reopen the book, so **your reading position is kept**.
- Paging direction flips with it (vertical = right-to-left, horizontal = left-to-right), and
  so does the progress slider.
- Ruby and `text-combine-upright` (tate-chū-yoko) are preserved.
- The button is hidden for fixed-layout books (photo books, manga), where the page images
  carry their own orientation.

<!-- set:autoPagerSeconds set:binding set:fontScale set:forceMargin set:imageSpread set:lang set:lineHeight set:renderMode set:shelfView set:sortKey set:textSpread set:theme set:userCSS set:writingMode -->
### Display settings

- **Theme**: auto / light / sepia / dark
- **Writing mode**: auto / forced vertical / forced horizontal
- **Binding direction**: auto / right-bound / left-bound
- **Spreads**: auto / always / never, separately for image pages and body text
- **Font size**, **line height**: applied to reflowable books
- **Language**: the app's UI language (Japanese / English, auto-detected by default)

### Menu bar (macOS)

The menu bar **follows the language setting** — Japanese when set to Japanese, English
otherwise ("auto" reads the OS language). Changing the setting rebuilds it immediately.
Items that don't apply to the current screen are greyed out.

<!-- menu:file.import menu:file.importFolder menu:file.newProfile menu:file.profiles menu:file.saveAudio menu:file.saveVideo menu:tts.dict -->

**File**

| Item | What it does | Shortcut |
| --- | --- | --- |
| Open… | Add books (file picker) | ⌘O |
| Add from Folder… | Import every book inside a folder | |
| Export → Save Chapter as Audio… / Save Chapter as Video… | ([section 7](#7-export-audio-and-video)) | |
| Switch Shelf / Manage Shelves… / New Shelf… | Separate shelves ([section 3](#separate-shelves)) | |
| Reading dictionary… | Fix mis-readings ([section 5](#reading-dictionary-fixing-mis-readings)) | |

<!-- menu:view.aspect menu:view.bookmarkAdd menu:view.bookmarks menu:view.css menu:view.fontDec menu:view.fontInc menu:view.fontReset menu:view.lineDec menu:view.lineInc menu:view.lineReset menu:view.margin menu:view.render.friendly menu:view.render.raw menu:view.spread menu:view.theme.auto menu:view.theme.dark menu:view.theme.light menu:view.theme.sepia menu:view.toc menu:view.translate -->

**View**

| Item | What it does | Shortcut |
| --- | --- | --- |
| Contents | Chapter list | ⌘T |
| Bookmarks / Bookmark here | List / add | ⌘B / ⌘D |
| Writing mode | Auto / vertical / horizontal | |
| Binding direction | Auto / right-bound / left-bound | |
| Image Spread / Text Spread | Auto / always / never | |
| Shift Spread | Fix fixed-layout books whose pages pair up wrong | |
| Image Aspect Ratio… | How image pages are fitted to the page box | |
| Toggle Margins | Add a margin to books whose text runs to the edge | |
| Custom CSS… | Two layers: all books, and this book only | |
| Rendering Mode | "Reading-friendly" (sensible defaults for real books) or "As authored" (draw exactly what the EPUB says) | |
| Bigger Text | Increase font size | ⌘= |
| Smaller Text | Decrease font size | ⌘- |
| Reset Text Size | Back to the default | ⌘0 |
| Increase Line Spacing | Wider line height | |
| Decrease Line Spacing | Narrower line height | |
| Reset Line Spacing | Back to the default | |
| Show / hide translation | Bilingual pane ([section 6](#6-bilingual-pane-lm-studio)) | |
| Full Screen | Full-screen display | |

<!-- menu:app.settings menu:edit.find menu:go.autoPager.custom menu:go.autoPager.stop menu:go.next menu:go.prev menu:go.shelf menu:tts.play menu:tts.sleep.action.shutdown menu:tts.sleep.action.sleepSystem menu:tts.sleep.action.stopOnly menu:tts.sleep.cancel menu:tts.sleep.custom menu:tts.stop -->

**Go / Read aloud / other**

| Item | What it does | Shortcut |
| --- | --- | --- |
| Previous Page / Next Page | Paging | ⌘← / ⌘→ |
| Auto Page Turn | Interval presets and stop ([section 4](#auto-page-turn)) | |
| Back to Shelf | Close the book | ⌘L |
| Play / Pause | Start or pause read-aloud | ⌘R |
| Stop Reading | Stop | ⌘. |
| Sleep Timer | Duration and action on expiry ([section 5](#sleep-timer)) | |
| Find in book… | Full-text search | ⌘F |
| Settings… | Settings dialog | ⌘, |

### Spreads in fixed-layout books

- Facing pages are joined seamlessly in the middle. A single wide illustration split across
  two pages shows as one image, as long as the pair is correct.
- If **illustrations appear half-shifted** (because the number of cover pages throws the
  pairing off), press "Shift spread" in the toolbar to move the pairing by one page.
  The setting is saved per book.

<!-- group:tts -->
## 5. Read aloud

### Basics

| Action | How |
|---|---|
| Start | ▶ button, or the **space bar** |
| Pause / resume | The same button (▶ / ⏸) or the space bar |
| Stop | ⏹ button |
| Start from somewhere | **Double-click** the text where you want to begin |

- The current sentence is highlighted and the view follows it. Page and chapter ends are
  turned automatically, so it reads continuously to the end of the book.
- The next sentence is synthesised in the background while the current one plays, so the
  gap between sentences is barely noticeable.
- Ruby (furigana) stays visible but is not read twice.

### Sleep timer

For falling asleep with read-aloud running. Use **Read aloud > Sleep timer**.

- Presets are **15 / 30 / 45 / 60 / 90 / 120 minutes**; "Custom Duration…" takes any number of
  minutes. The remaining time is shown while it runs.
- **The action on expiry** is one of three. Read-aloud always stops, whichever you pick.
  - **Stop read-aloud** — just stop (default)
  - **Put the Mac to sleep** — stop, then sleep the Mac
  - **Shut the Mac down** — stop, then shut the Mac down
- **Shutdown gets a 30-second grace period.** Press "Cancel" during it and nothing happens
  ("Now" skips the wait). This is there so the machine doesn't power off while you are awake.
- "Cancel timer" stops it at any point.
- The timer does not survive quitting the app — so a timer set at bedtime can't come back to
  life the next day and shut the machine down.

> **Note**: "Put the Mac to sleep" and "Shut the Mac down" affect **the whole machine**, not
> just this app. Don't use them with unsaved work in other applications. Shutdown is requested
> through macOS System Events, so it stops if another app refuses to quit.

<!-- set:customBaseUrl set:engine set:pauseLengthScale set:sleepTimerAction set:sleepTimerMinutes set:speaker set:speedScale set:ttsSaveDir -->
### Voice settings

- **Speech engine**: VOICEVOX / AivisSpeech / a custom URL
- **Speaker**: from the list the engine provides
- **Speed**: reading speed
- **Pause length**: how long the pauses at line breaks and punctuation are

### Reading dictionary (fixing mis-readings)

For proper nouns the engine gets wrong ("Reading dictionary" on the shelf).

1. Put the misread word in "Spelling" and the correct reading in "Reading (kana)", then "Add"
2. Adjust "Priority" (higher wins) and the accent position if needed
3. "Register with engine" pushes it to the engine's user dictionary

The dictionary is also registered automatically when read-aloud starts. The reading
dictionary is kept **per shelf**.

<!-- group:trans -->
## 6. Bilingual pane

Translates the paragraphs currently on screen and shows them beside the original. The text
itself is left alone, so vertical writing, spreads and ruby stay exactly as they were.

- Toggle it with the **あA** toolbar button or **View > Show / hide bilingual pane**.
- Turning the page translates only the paragraphs now visible (at most 40 per screen).
- Translated paragraphs are cached, so going back to the same place doesn't re-translate them.
- At the top of the pane, **原** hides the source text and **A－ / A＋** resize the translation.
<!-- feat:tr-flash -->
- **Double-click a row and the paragraph it came from lights up for 1.8 seconds** in the
  text, so you can see where a translation sits. The mark clears when the page changes.

<!-- set:translation -->
### Settings (Settings → "Translation")

| Setting | Default | Notes |
|---|---|---|
| Server URL | `http://127.0.0.1:1234` | An OpenAI-compatible API, local or in the cloud |
| API key | Empty | Leave blank for a local server; cloud services need a key |
| Model | Auto (first in the list) | Chosen from what the server reports |
| Source language | Auto-detect | The language to translate from |
| Target language | Japanese | The language to translate into |
| Variation | 0.20 | Higher gives the model more freedom, lower keeps it literal |
| Passages at once | 2 (1–8) | Higher is faster but loads the machine harder |
| Pass the previous passage as context | On | More consistent translations, more data sent |
| Cut the thinking short | On | See below. **Keep this on for a local server** |
| Cached translations | — | "Clear" throws it all away (the count is shown) |

### About "Cut the thinking short"

Models that think before answering can spend their entire budget on a single passage and
**return nothing at all**. This setting tells the model its thinking is done and to start
writing the translation. Measured on the same passage with the same model, the difference was
**90 seconds and an empty result versus 2 seconds and a translation**.

Keep it on for a server on your own machine. Turn it off only if a cloud API rejects the request.

### About translation quality

The quality is the quality of the model you pick. This app does not translate anything; it
asks, and lays out what comes back.

- Smaller models break down on dialogue, honorifics and proper nouns. They will invent names.
- **Direction matters.** Japanese into English works at a far smaller model size than English
  into Japanese, because *writing* Japanese is much harder for a model than *reading* it.
- A translation into a language you cannot read **cannot be checked by reading it**. Before
  showing such a translation to anyone, have it checked by someone who reads that language, or
  by a substantially larger model.

### If nothing appears

- Check the **connection indicator** in Settings → "Translation". If it will not turn green,
  confirm the server is running and the URL is right (and, for a cloud service, the key).
- Translation cannot start when no model is available.
- If you see "the model only thought and returned no translation", turn on "Cut the thinking short".

<!-- group:export -->
## 7. Export (audio and video)

The chapter you are reading can be saved as a file, from the **File** menu.

- **Save this chapter as audio…** — the whole chapter read aloud, as an audio file.
- **Save this chapter as a video…** — an MP4 combining the rendered text with the read-aloud
  audio. Portrait or landscape is chosen automatically from the writing direction. Progress is
  shown while it renders, and "Cancel" stops it.

Exporting synthesises the entire chapter, so long chapters take a while. If you plan to publish
the exported audio or video, read [section 10](#10-credits-and-terms-of-use) first.

<!-- group:data -->
## 8. Where data is stored

Imported books, settings, bookmarks and dictionaries all live under:

```
~/Library/Application Support/dev.veltrea.epub-reader/
```

- `books/` — the imported book files (shared across shelves)
- `library.json` — the shelf (title, author, reading, cover)
- `settings.json` / `dict.json` — settings and the reading dictionary
- `loc-*` / `bm-*` / `css-*` / `spread-*` — per-book position, bookmarks, CSS, spread shift
- `Deleted/` — data from deleted shelves

Deleting this folder resets the app (imported books go with it).

## 9. Troubleshooting

| Symptom | What to do |
|---|---|
| No sound when you press play | Check the engine (VOICEVOX / AivisSpeech) is running. If "Engine status" says "not connected", start it and press Save again. When the engine cannot be reached, reading stops and "Cannot reach the read-aloud engine" appears at the bottom of the screen |
| A file does nothing when dropped on the window | Its format is not supported. See the formats list in [1. Introduction](#1-introduction). Unsupported files are ignored on purpose, so nothing is added to the library |
| The controls disappeared after opening a book | The toolbars appear when you **move the pointer to the top or bottom edge** — they stay hidden so the page can use the whole window. From the keyboard, **⌘L** goes back to the library |
| A proper noun is misread | Add the spelling and reading to the reading dictionary, then "Register with engine" |
| No translations in the bilingual pane | Check LM Studio's Local Server is running and a model is loaded |
| Translation is slow | Raise "Paragraphs in flight". Turning off "send the previous paragraph as context" also helps |
| Photo-book illustrations are half-shifted | Press "Shift spread" in the toolbar |
| Text is cut off at the edge | Turn on "Margin" in the toolbar, or adjust with custom CSS |
| A vertical book renders horizontally (or vice versa) | Force the direction with the writing-mode button |
| A book lands in the "Other" group | Right-click → "Edit reading" and set the kana |
| An import never finishes | Cover extraction for large fixed-layout books can take tens of seconds. Give it a moment |
| A MOBI / AZW book opens horizontal | The old MOBI format has nowhere to record vertical writing. Use the "Writing mode" toolbar button, or convert to AZW3 / KF8 and import that |

## 10. Credits and terms of use

- **VOICEVOX and AivisSpeech are not bundled.** Get them yourself. The engine and the voice
  libraries (the character voices) are governed by **their own distributors' terms**.
- **If you publish or distribute exported audio or video, most voice libraries require you to
  credit the character** (for example `VOICEVOX:Shikoku Metan`). The exact wording and
  conditions differ per voice library, and so does whether commercial use is allowed — check
  the terms for the voice you used.
- **LM Studio and the translation models are not bundled either.** Each model's licence
  (including how its output may be used) is set by whoever distributes it.
- This application only talks to those engines over HTTP; it does not redistribute any voice
  or model data. For the application's own licence see [LICENSE](LICENSE).
- Rendering uses [foliate-js](https://github.com/johnfactotum/foliate-js).
