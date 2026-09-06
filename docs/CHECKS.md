# The checks

日本語: [CHECKS.ja.md](CHECKS.ja.md)

```bash
./scripts/check.sh
```

Seven checks, run together; CI runs the same set. One failure prints
"検査に失敗があります" in red and exits non-zero.

**Only checks whose answer is decided without asking anyone belong here.**
Anything needing judgement — whether a design is right, what may be published,
which licence to pick — stays out. A warning that stops a person every time is a
warning nobody reads.

**A check is not an accusation; it tells you what to do next.** Each one names
its own fix when it stops. Do what it says and move on.

---

## 1. Logic unit tests

```bash
node tests/logic.test.mjs
```

**What it tests.** Only what runs without a screen: kana conversion, the
gojūon buckets, the reading dictionary's substitutions, binding direction,
typesetting corrections, the auto-pager, the sleep timer, bilingual mode.
162 of them as of 2026-08-30.

**Why no screen.** A screen needs a book and a speech engine too. That is slow,
fragile, and tells you nothing about which part broke. Logic kept apart from the
screen can be called directly.

**When it stops.** You get the failing test's name, what it expected, and what it
got. Fix the logic, or fix the test if the test is the stale one.

**When you add a feature.** Write a test for any logic that does not touch the
screen. **Keeping it testable is the real work:** logic buried inside screen code
cannot be tested at all. Pull it out as a plain function.

---

## 2. Menu wiring (items that do nothing)

```bash
node scripts/check-menu-wiring.mjs
```

**What it finds.** A menu item that exists but does nothing when clicked.

**Why it matters.** You cannot see this by looking. The menu builds, the click
raises no error, and nothing happens. **It is the most visible kind of bug in a
release build.**

**How it decides.** It collects every item id `src-tauri/src/menu.rs` emits. If an
id is enabled on a screen but absent from that screen's handler table, it is a
hole.

| How menu.rs declares it | Where a handler is required |
|---|---|
| `enabled: true` | **both** the reader and the shelf |
| `enabled: reader` | the reader only |
| `enabled: shelf` | the shelf only |
| any other expression (can_export, …) | warns if absent from both |

**When it stops.** Add the handler to the table in `reader.js` / `shelf.js`. If
the item only means something on one screen, pass `reader` or `shelf` to `enabled`
in `menu.rs` so it greys out on the other. **Never leave it silently inert.**

---

## 3. Hard-coded UI strings

```bash
node scripts/check-ui-strings.mjs
```

**What it finds.** Japanese text written straight into the code instead of going
through the locale files.

**Why it does not search for Japanese.** Kana handling and sentence splitting
contain Japanese literals legitimately — the gojūon table, punctuation. Searching
for "is there Japanese here" produces so many false hits that nobody reads the
output. It watches **the sinks that put text on screen** instead.

Both strings that escaped in the past take this shape:

```
ui-modals.js   alert('再生に失敗しました: ' + e)
dnd.js         el.textContent = '本をここにドロップ'
```

**When it stops.** Add the key to **both** `src/locales/ja.json` and `en.json`,
then call `t('key')`. **One file alone fails the Rust test**, which requires the
two key sets to match.

---

## 4. Config, version and private paths

```bash
node scripts/check-config.mjs
```

**What it looks at.** Five things.

| Item | What it checks |
|---|---|
| Version | `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` agree |
| Build number | the number bumped per package is paired with the version |
| Content-Security-Policy | declared in the config, not only in a meta tag |
| Private paths | nothing meant to stay local is tracked by git |
| Text files | no NUL bytes have crept into files that should be text |

It also warns about menu items missing from the manual. That warning does not
stop the run.

**When it stops.** Fix what it names. Every one of these has exactly one answer.

---

## 5. Feature inventory (what belongs in the docs)

```bash
node scripts/feature-inventory.mjs          # compare against the record
node scripts/feature-inventory.mjs --write  # rewrite the record
```

**What it does.** Extracts the feature list from the code and compares it with
`docs/feature-inventory.json`: menu ids, setting keys, test-bus commands,
supported extensions, backend commands.

**Why not have an AI read the code and count.** The list is not something to infer
— the code already declares it. Extracting is a grep; the diff is git's job.
**Only the prose needs a person (or an AI), so there is no need to read everything
every time.**

**When it stops.** The diff it prints *is* the list of things to document.

1. Write the new entries into the manual (and the README for larger features)
2. Run `node scripts/feature-inventory.mjs --write`

**Order matters.** Running `--write` first erases the list you were meant to write
about.

---

## 6. Symbol matching (code against docs)

```bash
node scripts/check-symbols.mjs         # stops on a mismatch
node scripts/check-symbols.mjs --soft  # counts only, never fails (for migrations)
```

**What it compares.** Code and documents, four ways, by set subtraction.

| Comparison | What a break means |
|---|---|
| code groups ⊆ document groups | a whole section is undocumented |
| code features ⊆ document marks | that feature has no explanation |
| document marks ⊆ code features | an explanation outlived its feature |
| Japanese marks = English marks | only one language was updated |

The document side carries invisible marks of the form `<!-- menu:xxx -->`, so they
never get in a reader's way.

**When it stops.** Mark the passage that explains the feature. Delete explanations
whose feature no longer exists.

**Green does not mean done.** All it proves is that the same name appears
somewhere at least once. Length, accuracy and appearance are all out of scope.
Look at it yourself at the end.

---

## 7. Labels quoted in documents

```bash
node scripts/check-manual-labels.mjs
```

**What it compares.** Labels quoted in the documents against what the app actually
shows. The authority is `src/locales/ja.json` — every label lives there, since
check 3 forbids writing one into the code.

**Why it matters.** The manual began as a copy of the Swift prototype's, so names
from that build survive in it. Eleven were found on 2026-08-30.

| The document said | The app says |
|---|---|
| EpubReaderSpike | epub-reader |
| 環境設定… | 設定… |
| オーディオを書き出し… | この章を音声ファイルに保存… |
| 移動 > しおりを開く | 移動 > しおり |
| 任意の比率… | 自由入力 |

**Reading cannot catch these.** It takes holding each sentence next to the running
app.

**Only two shapes are read out of the prose.**

| Shape | Example |
|---|---|
| a word ending in … | `読み上げ辞書を編集…` |
| `menu > item` | `移動 > 現在地をしおり` |

Descriptions such as `自動／縦書き／横書き` are left alone. **The net is
deliberately tight** — a check that cries wolf stops being read.

**Japanese documents only.** English uses … as a mid-sentence ellipsis, so
`Open the engine…` would be read as an item named `engine…`.

**When it stops.** Make the quote match `ja.json`. **If the app's own label is the
wrong one, fix that first.**

---

## When a check gets in the way

**Decide first whether the check is wrong or the code is.** If the code is newer,
the code wins — fix the document or the record instead.

To take something out of a check's net, add it to that check's skip list **with
the reason written beside it**. A skip with no reason is one nobody can ever
remove.

Delete a check that has stopped earning its place, but **say why in the commit**.
"Too noisy" is not a reason: noise means either the net is too wide or the code
really does disagree.

## Adding a check

Two questions before you write one.

1. **Is there exactly one right answer?** If people would disagree, it does not
   belong here.
2. **Would anyone notice by looking?** What people notice gets fixed anyway. A
   check earns its place on what **nobody can see** — an inert menu item, a
   prototype's name in the prose, a translation done in one language only.

Once written, **break something on purpose and confirm it stops.** A check that
never fires is the same as no check at all.
