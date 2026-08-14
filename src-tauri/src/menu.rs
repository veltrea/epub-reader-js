// ネイティブメニュー(macOS メニューバー)の構築。
// 文言はフロントと同じ src/locales/*.json を include_str! で取り込み、単一の翻訳ソースにする。
// 言語: 設定の lang('auto'|'ja'|'en')。auto は OS のロケールを見て ja かそれ以外(=en)。
// 項目の有効/無効は「文脈」(shelf=本棚 / reader=リーダー)で切り替える。
// 独自項目はクリック時に "menu" イベントで id をフロントへ投げ、実処理はフロント側が行う。

use serde_json::Value;
use std::collections::HashMap;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

const JA: &str = include_str!("../../src/locales/ja.json");
const EN: &str = include_str!("../../src/locales/en.json");

/// メニュー文言の引き当て。ja に無ければ en、それも無ければキーをそのまま返す。
struct Strings {
    dict: HashMap<String, String>,
    fallback: HashMap<String, String>,
    app_name: String,
}

fn parse_locale(src: &str) -> HashMap<String, String> {
    serde_json::from_str::<Value>(src)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .map(|obj| {
            obj.into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

impl Strings {
    fn new(lang: &str, app_name: &str) -> Self {
        let en = parse_locale(EN);
        let dict = if lang == "ja" { parse_locale(JA) } else { en.clone() };
        Self { dict, fallback: en, app_name: app_name.to_string() }
    }

    fn t(&self, key: &str) -> String {
        self.dict
            .get(key)
            .or_else(|| self.fallback.get(key))
            .cloned()
            .unwrap_or_else(|| key.to_string())
            .replace("{app}", &self.app_name)
    }
}

/// 'auto' のときに OS のロケールから ja / en を決める。
/// 環境変数(LANG 等)→ macOS の `defaults read -g AppleLocale` の順で見る。
/// .app を Finder から起動すると環境変数が空なので、macOS では defaults が実質の判定元。
fn os_lang() -> String {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() && v != "C" && v != "POSIX" {
                return if v.to_lowercase().starts_with("ja") { "ja".into() } else { "en".into() };
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // 表示言語(AppleLanguages の先頭)が本命。取れなければ地域(AppleLocale)で代用。
        if let Some(l) = mac_default("AppleLanguages").and_then(|s| first_quoted(&s)) {
            return if l.starts_with("ja") { "ja".into() } else { "en".into() };
        }
        if let Some(l) = mac_default("AppleLocale") {
            if l.trim().to_lowercase().starts_with("ja") {
                return "ja".into();
            }
        }
    }
    "en".into()
}

#[cfg(target_os = "macos")]
fn mac_default(key: &str) -> Option<String> {
    let out = std::process::Command::new("defaults")
        .args(["read", "-g", key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `defaults read` が返す配列テキストから最初の引用符付き要素を取り出す。
/// 例: "(\n    \"ja-JP\",\n    \"en-US\"\n)" -> "ja-jp"
#[cfg(target_os = "macos")]
fn first_quoted(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| l.starts_with('"'))
        .map(|l| l.trim_matches(|c| c == '"' || c == ',').to_lowercase())
}

/// 設定('auto'|'ja'|'en')を実際の表示言語へ解決する。
pub fn resolve_lang(pref: &str) -> String {
    match pref {
        "ja" => "ja".into(),
        "en" => "en".into(),
        _ => os_lang(),
    }
}

/// 保存済み設定(settings.json)の lang を読む。無ければ 'auto'。
pub fn saved_lang_pref(settings: &Value) -> String {
    settings
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string()
}

/// メニューへ写す「いま効いている値」。
///
/// チェックマークは押した瞬間の値を出したいので、フロントが状態を変えるたびに
/// `sync_menu` で渡し直す。Rust 側はここに載っているものしか知らない。
struct State<'a>(&'a Value);

impl<'a> State<'a> {
    fn str(&self, key: &str, fallback: &str) -> String {
        self.0
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(fallback)
            .to_string()
    }
    fn bool(&self, key: &str) -> bool {
        self.0.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
    fn i64(&self, key: &str, fallback: i64) -> i64 {
        self.0.get(key).and_then(|v| v.as_i64()).unwrap_or(fallback)
    }
    /// 書棚の一覧 [(id, name)]。空なら「書棚を切り替える」は出さない。
    fn profiles(&self) -> Vec<(String, String)> {
        self.0
            .get("profiles")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        Some((
                            p.get("id")?.as_str()?.to_string(),
                            p.get("name")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// メニューを組み立てる。ctx は "shelf"(本棚) か "reader"(リーダー)。
/// リーダー専用の項目は本棚では無効化する(macOS の作法どおり、消さずにグレーアウト)。
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    lang: &str,
    ctx: &str,
    state: &Value,
) -> tauri::Result<Menu<R>> {
    let app_name = app.package_info().name.clone();
    let s = Strings::new(lang, &app_name);
    let st = State(state);
    let reader = ctx == "reader";
    let shelf = ctx == "shelf";

    // 独自項目(クリックで "menu" イベントを飛ばすもの)
    let item = |id: &str, key: &str, accel: Option<&str>, enabled: bool| {
        let mut b = MenuItemBuilder::with_id(id, s.t(key)).enabled(enabled);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    // いま効いている値にチェックが付く選択式の項目。
    let check = |id: &str, key: &str, on: bool, enabled: bool| {
        CheckMenuItemBuilder::with_id(id, s.t(key))
            .checked(on)
            .enabled(enabled)
            .build(app)
    };
    let raw_check = |id: &str, text: &str, on: bool, enabled: bool| {
        CheckMenuItemBuilder::with_id(id, text)
            .checked(on)
            .enabled(enabled)
            .build(app)
    };

    // ---- アプリメニュー ----
    let settings = item("app.settings", "menu.app.settings", Some("CmdOrCtrl+,"), true)?;
    let app_menu = SubmenuBuilder::new(app, &app_name)
        .about_with_text(s.t("menu.app.about"), None)
        .separator()
        .item(&settings)
        .separator()
        .services_with_text(s.t("menu.app.services"))
        .separator()
        .hide_with_text(s.t("menu.app.hide"))
        .hide_others_with_text(s.t("menu.app.hideOthers"))
        .show_all_with_text(s.t("menu.app.showAll"))
        .separator()
        .quit_with_text(s.t("menu.app.quit"))
        .build()?;

    // ---- ファイル ----
    let import = item("file.import", "menu.file.import", Some("CmdOrCtrl+O"), shelf)?;
    let import_folder = item(
        "file.importFolder",
        "menu.file.importFolder",
        Some("CmdOrCtrl+Shift+O"),
        shelf,
    )?;
    // 書き出しは「いま読んでいる章」が対象。読み上げ中・書き出し中は同じ合成経路を使うので淡色。
    let can_export = reader && st.bool("canExport");
    let save_audio = item("file.saveAudio", "menu.file.saveAudio", None, can_export)?;
    let save_video = item("file.saveVideo", "menu.file.saveVideo", None, can_export)?;
    let export_menu = SubmenuBuilder::new(app, s.t("menu.file.export"))
        .item(&save_audio)
        .item(&save_video)
        .build()?;

    // 書棚の切り替えは「どの蔵書を読むか」の選択なので、開く・書き出しと同じファイル側に置く。
    let profiles = st.profiles();
    let current_profile = st.str("currentProfile", "");
    let mut shelf_menu = SubmenuBuilder::new(app, s.t("menu.file.switchShelf"));
    let profile_items: Vec<_> = profiles
        .iter()
        .map(|(id, name)| raw_check(&format!("file.profile.{id}"), name, *id == current_profile, true))
        .collect::<Result<Vec<_>, _>>()?;
    for it in &profile_items {
        shelf_menu = shelf_menu.item(it);
    }
    let shelf_menu = shelf_menu.build()?;
    let manage_profiles = item("file.profiles", "menu.file.manageShelves", None, true)?;
    // 「新規書棚…」。管理シートを開かずに、その場で空の書棚を作って移る。
    let new_profile = item("file.newProfile", "menu.file.newShelf", None, true)?;

    // 並びは Swift 版と同じ。書棚の切り替えは「どの蔵書を読むか」の選択で、
    // 開く・書き出しより前に決めるものなので**先頭**に置く。
    let file_menu = SubmenuBuilder::new(app, s.t("menu.file"))
        .item(&new_profile)
        .item(&manage_profiles)
        .separator()
        .item(&shelf_menu)
        .separator()
        .item(&import)
        .item(&import_folder)
        .separator()
        .close_window_with_text(s.t("menu.file.close"))
        .separator()
        .item(&export_menu)
        .build()?;

    // ---- 編集 ----
    let find = item("edit.find", "menu.edit.find", Some("CmdOrCtrl+F"), reader)?;
    let edit_menu = SubmenuBuilder::new(app, s.t("menu.edit"))
        .undo_with_text(s.t("menu.edit.undo"))
        .redo_with_text(s.t("menu.edit.redo"))
        .separator()
        .cut_with_text(s.t("menu.edit.cut"))
        .copy_with_text(s.t("menu.edit.copy"))
        .paste_with_text(s.t("menu.edit.paste"))
        .select_all_with_text(s.t("menu.edit.selectAll"))
        .separator()
        .item(&find)
        .build()?;

    // ---- 表示 ----
    // 文字サイズ・行間・テーマ・表示モードは全書籍共通の設定を、書字方向・綴じ方向・見開きは
    // 「いま開いている本の指定」を書き換える(書棚にいるときはどれも全書籍の既定を書き換える)。
    let font_inc = item("view.fontInc", "menu.view.fontInc", Some("CmdOrCtrl+="), true)?;
    let font_dec = item("view.fontDec", "menu.view.fontDec", Some("CmdOrCtrl+Shift+-"), true)?;
    let font_reset = item("view.fontReset", "menu.view.fontReset", Some("CmdOrCtrl+0"), true)?;
    let line_inc = item("view.lineInc", "menu.view.lineInc", None, true)?;
    let line_dec = item("view.lineDec", "menu.view.lineDec", None, true)?;
    let line_reset = item("view.lineReset", "menu.view.lineReset", None, true)?;

    // テーマ(自動・ライト・セピア・ダーク)
    let theme = st.str("theme", "auto");
    let theme_items = [
        check("view.theme.auto", "settings.theme.auto", theme == "auto", true)?,
        check("view.theme.light", "settings.theme.light", theme == "light", true)?,
        check("view.theme.sepia", "settings.theme.sepia", theme == "sepia", true)?,
        check("view.theme.dark", "settings.theme.dark", theme == "dark", true)?,
    ];
    let mut theme_menu = SubmenuBuilder::new(app, s.t("settings.theme"));
    for it in &theme_items {
        theme_menu = theme_menu.item(it);
    }
    let theme_menu = theme_menu.build()?;

    // 表示モード(読みやすさ優先 / EPUB のまま)
    let render_mode = st.str("renderMode", "friendly");
    let render_items = [
        check("view.render.friendly", "menu.value.friendly", render_mode == "friendly", true)?,
        check("view.render.raw", "menu.value.raw", render_mode == "raw", true)?,
    ];
    let mut render_menu = SubmenuBuilder::new(app, s.t("menu.view.render"));
    for it in &render_items {
        render_menu = render_menu.item(it);
    }
    let render_menu = render_menu.build()?;

    // 3 択の選択式メニュー(書字方向・綴じ方向・見開き)をまとめて作る。
    // 値のラベルは短い共通のもの(menu.value.*)を使う。ツールバーの説明文
    // (reader.writing.auto = 「本文の向き: 自動（本の指定）」)は、既に見出しの付いた
    // サブメニューの中では冗長になる。
    let triple = |title_key: &str, id_base: &str, values: [&str; 3], cur: &str| {
        let items: Vec<_> = values
            .iter()
            .map(|v| {
                check(&format!("{id_base}.{v}"), &format!("menu.value.{v}"), *v == cur, true)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut m = SubmenuBuilder::new(app, s.t(title_key));
        for it in &items {
            m = m.item(it);
        }
        m.build()
    };
    let writing_menu = triple(
        "menu.view.writing",
        "view.writing",
        ["auto", "vertical", "horizontal"],
        &st.str("writingMode", "auto"),
    )?;
    let binding_menu = triple(
        "menu.view.binding",
        "view.binding",
        ["auto", "rtl", "ltr"],
        &st.str("binding", "auto"),
    )?;
    let image_spread_menu = triple(
        "menu.view.imageSpread",
        "view.imageSpread",
        ["auto", "always", "never"],
        &st.str("imageSpread", "auto"),
    )?;
    let text_spread_menu = triple(
        "menu.view.textSpread",
        "view.textSpread",
        ["auto", "always", "never"],
        &st.str("textSpread", "auto"),
    )?;

    let aspect = item("view.aspect", "menu.view.aspect", None, reader)?;
    let toc = item("view.toc", "menu.view.toc", Some("CmdOrCtrl+T"), reader)?;
    let translate = item("view.translate", "menu.view.translate", None, reader)?;
    let margin = item("view.margin", "menu.view.margin", None, reader)?;
    let spread = item("view.spread", "menu.view.spread", None, reader)?;
    let css = item("view.css", "menu.view.css", None, reader)?;
    let view_menu = SubmenuBuilder::new(app, s.t("menu.view"))
        .item(&font_inc)
        .item(&font_dec)
        .item(&font_reset)
        .separator()
        .item(&line_inc)
        .item(&line_dec)
        .item(&line_reset)
        .separator()
        .item(&theme_menu)
        .item(&render_menu)
        .separator()
        .item(&writing_menu)
        .item(&binding_menu)
        .item(&image_spread_menu)
        .item(&text_spread_menu)
        .item(&aspect)
        .separator()
        .item(&toc)
        .item(&translate)
        .item(&margin)
        .item(&spread)
        .item(&css)
        .separator()
        .fullscreen_with_text(s.t("menu.view.fullscreen"))
        .build()?;

    // ---- 移動 ----
    // 「次／前」は本の綴じ方向に依らない**論理的な向き**。左右の意味は縦書き・右綴じで反転する
    // ので、どちらへ動かすかはフロント(effectiveDir)が決める。
    let next = item("go.next", "menu.go.next", Some("CmdOrCtrl+]"), reader)?;
    let prev = item("go.prev", "menu.go.prev", Some("CmdOrCtrl+["), reader)?;
    let bookmark_add = item("view.bookmarkAdd", "menu.view.bookmarkAdd", Some("CmdOrCtrl+D"), reader)?;
    let bookmarks = item("view.bookmarks", "menu.view.bookmarks", Some("CmdOrCtrl+B"), reader)?;

    // 自動ページ送り。稼働中の状態(残り・停止)は本を閉じても見えるようにしておく。
    let pager_running = st.bool("autoPagerRunning");
    let pager_seconds = st.i64("autoPagerSeconds", 30);
    let pager_presets: Vec<_> = [10, 15, 20, 30, 45, 60, 90]
        .iter()
        .map(|n| {
            raw_check(
                &format!("go.autoPager.{n}"),
                &s.t("menu.go.autoPagerSeconds").replace("{n}", &n.to_string()),
                pager_running && *n == pager_seconds,
                reader,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let pager_custom = item("go.autoPager.custom", "menu.go.autoPagerCustom", None, reader)?;
    let pager_stop = item("go.autoPager.stop", "menu.go.autoPagerStop", None, pager_running)?;
    let mut pager_menu = SubmenuBuilder::new(app, s.t("menu.go.autoPager"));
    for it in &pager_presets {
        pager_menu = pager_menu.item(it);
    }
    let pager_menu = pager_menu.item(&pager_custom).separator().item(&pager_stop).build()?;

    let shelf_item = item("go.shelf", "menu.go.shelf", Some("CmdOrCtrl+L"), reader)?;
    let go_menu = SubmenuBuilder::new(app, s.t("menu.go"))
        .item(&next)
        .item(&prev)
        .separator()
        .item(&bookmark_add)
        .item(&bookmarks)
        .separator()
        .item(&pager_menu)
        .separator()
        .item(&shelf_item)
        .build()?;

    // ---- 読み上げ ----
    let play = item("tts.play", "menu.tts.play", Some("CmdOrCtrl+R"), reader)?;
    let stop = item("tts.stop", "menu.tts.stop", Some("CmdOrCtrl+."), reader)?;
    let tts_dict = item("tts.dict", "menu.file.dict", None, true)?;

    // スリープタイマー。本を開いていなくても操作できる(走っているタイマーを書棚へ戻ってから
    // 解除したい、という場面があるため)。
    let sleep_running = st.bool("sleepTimerRunning");
    let sleep_minutes = st.i64("sleepTimerMinutes", 30);
    let sleep_presets: Vec<_> = [15, 30, 45, 60, 90, 120]
        .iter()
        .map(|n| {
            raw_check(
                &format!("tts.sleep.{n}"),
                &s.t("menu.tts.sleepMinutes").replace("{n}", &n.to_string()),
                sleep_running && *n == sleep_minutes,
                true,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let sleep_custom = item("tts.sleep.custom", "menu.tts.sleepCustom", None, true)?;
    let sleep_cancel = item("tts.sleep.cancel", "menu.tts.sleepCancel", None, sleep_running)?;
    let sleep_action = st.str("sleepTimerAction", "stopOnly");
    let sleep_actions = [
        check("tts.sleep.action.stopOnly", "menu.tts.sleepStopOnly", sleep_action == "stopOnly", true)?,
        check("tts.sleep.action.sleepSystem", "menu.tts.sleepSystem", sleep_action == "sleepSystem", true)?,
        check("tts.sleep.action.shutdown", "menu.tts.sleepShutdown", sleep_action == "shutdown", true)?,
    ];
    let mut sleep_menu = SubmenuBuilder::new(app, s.t("menu.tts.sleepTimer"));
    for it in &sleep_presets {
        sleep_menu = sleep_menu.item(it);
    }
    sleep_menu = sleep_menu.item(&sleep_custom).separator().item(&sleep_cancel).separator();
    for it in &sleep_actions {
        sleep_menu = sleep_menu.item(it);
    }
    let sleep_menu = sleep_menu.build()?;

    let tts_menu = SubmenuBuilder::new(app, s.t("menu.tts"))
        .item(&play)
        .item(&stop)
        .separator()
        .item(&tts_dict)
        .separator()
        .item(&sleep_menu)
        .build()?;

    // ---- ウインドウ ----
    let window_menu = SubmenuBuilder::new(app, s.t("menu.window"))
        .minimize_with_text(s.t("menu.window.minimize"))
        .maximize_with_text(s.t("menu.window.zoom"))
        .separator()
        .build()?;
    // macOS ではウインドウ一覧を OS が差し込む
    #[cfg(target_os = "macos")]
    let _ = window_menu.set_as_windows_menu_for_nsapp();

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &go_menu, &tts_menu, &window_menu])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    // メニューで引く全キー。locales に無いものがあれば(=キー名がそのまま出る)ここで落とす。
    const KEYS: &[&str] = &[
        "menu.app.about", "menu.app.settings", "menu.app.services", "menu.app.hide",
        "menu.app.hideOthers", "menu.app.showAll", "menu.app.quit",
        "menu.file", "menu.file.import", "menu.file.importFolder", "menu.file.dict",
        "menu.file.export", "menu.file.saveAudio", "menu.file.saveVideo",
        "menu.file.switchShelf", "menu.file.manageShelves", "menu.file.newShelf",
        "menu.file.close",
        "menu.edit", "menu.edit.undo", "menu.edit.redo", "menu.edit.cut", "menu.edit.copy",
        "menu.edit.paste", "menu.edit.selectAll", "menu.edit.find",
        "menu.view", "menu.view.toc", "menu.view.bookmarks", "menu.view.bookmarkAdd",
        "menu.view.writing", "menu.view.binding", "menu.view.render",
        "menu.view.imageSpread", "menu.view.textSpread", "menu.view.aspect",
        "menu.view.margin", "menu.view.spread", "menu.view.css",
        "menu.view.fontInc", "menu.view.fontDec", "menu.view.fontReset",
        "menu.view.lineInc", "menu.view.lineDec", "menu.view.lineReset",
        "menu.view.fullscreen",
        "settings.theme", "settings.theme.auto", "settings.theme.light",
        "settings.theme.sepia", "settings.theme.dark",
        "menu.value.auto", "menu.value.vertical", "menu.value.horizontal",
        "menu.value.rtl", "menu.value.ltr", "menu.value.always", "menu.value.never",
        "menu.value.friendly", "menu.value.raw",
        "menu.go", "menu.go.prev", "menu.go.next", "menu.go.shelf",
        "menu.go.autoPager", "menu.go.autoPagerSeconds", "menu.go.autoPagerCustom",
        "menu.go.autoPagerStop",
        "menu.tts", "menu.tts.play", "menu.tts.stop",
        "menu.tts.sleepTimer", "menu.tts.sleepMinutes", "menu.tts.sleepCustom",
        "menu.tts.sleepCancel", "menu.tts.sleepStopOnly", "menu.tts.sleepSystem",
        "menu.tts.sleepShutdown",
        "menu.window", "menu.window.minimize", "menu.window.zoom",
    ];

    #[test]
    fn locales_cover_every_menu_key() {
        for lang in ["ja", "en"] {
            let s = Strings::new(lang, "epub-reader");
            for k in KEYS {
                assert_ne!(&s.t(k), k, "{lang}: 訳が無い: {k}");
            }
        }
    }

    #[test]
    fn ja_and_en_differ_and_app_name_is_substituted() {
        let ja = Strings::new("ja", "epub-reader");
        let en = Strings::new("en", "epub-reader");
        assert_eq!(ja.t("menu.file"), "ファイル");
        assert_eq!(en.t("menu.file"), "File");
        assert_eq!(ja.t("menu.app.quit"), "epub-reader を終了");
        assert_eq!(en.t("menu.app.quit"), "Quit epub-reader");
    }

    #[test]
    fn unknown_lang_falls_back_to_english() {
        let s = Strings::new("fr", "epub-reader");
        assert_eq!(s.t("menu.view"), "View");
    }

    #[test]
    fn explicit_lang_pref_wins_over_os() {
        assert_eq!(resolve_lang("ja"), "ja");
        assert_eq!(resolve_lang("en"), "en");
        // auto は OS 依存なので ja/en のどちらかであることだけ確かめる
        assert!(matches!(resolve_lang("auto").as_str(), "ja" | "en"));
    }

    #[test]
    fn saved_lang_pref_defaults_to_auto() {
        assert_eq!(saved_lang_pref(&Value::Null), "auto");
        assert_eq!(saved_lang_pref(&serde_json::json!({})), "auto");
        assert_eq!(saved_lang_pref(&serde_json::json!({ "lang": "en" })), "en");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_defaults_array() {
        let s = "(\n    \"ja-JP\",\n    \"en-US\"\n)\n";
        assert_eq!(first_quoted(s).as_deref(), Some("ja-jp"));
    }
}

/// 現在の言語・文脈・状態でメニューを作り直して差し替える。
pub fn apply<R: Runtime>(
    app: &AppHandle<R>,
    lang_pref: &str,
    ctx: &str,
    state: &Value,
) -> tauri::Result<()> {
    let lang = resolve_lang(lang_pref);
    let menu = build(app, &lang, ctx, state)?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    strip_injected_edit_items(app);
    Ok(())
}

/// 「編集」メニューの末尾に AppKit が勝手に差し込む項目を取り除く。
///
/// macOS は主メニューを立てたとき、編集メニューへ**アプリが頼んでいない項目**を足す:
/// 「作文ツール」「自動入力」「音声入力を開始…」「絵文字と記号」。どれも受け皿が
/// NSTextView / NSTextField のときのための項目で、本文が WebView のこのアプリでは
/// 押しても何も起きない。
///
/// プロトタイプ(Swift + Mac Catalyst)ではこれを外せなかった——UIKit がメニューを
/// 組み終わった後に AppKit が差し込むので `buildMenu` の時点では存在せず、
/// `NSDisabledDictationMenuItem` / `NSDisabledCharacterPaletteMenuItem` も効かなかった。
/// こちらは素の AppKit アプリなので、組み上がった NSMenu を直接刈り取れる。
///
/// 刈り方は「**自分が入れた数より後ろを消す**」。項目名や selector で狙い撃ちすると、
/// OS の版が変わって名前や顔ぶれが変わったときに取りこぼす。自分が何個入れたかは
/// 確実に分かるので、そこから先は全部 AppKit の差し込みだと判断できる。
#[cfg(target_os = "macos")]
fn strip_injected_edit_items<R: Runtime>(app: &AppHandle<R>) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    // 自前で「編集」へ入れた項目数(取り消す/やり直す/---/カット/コピー/ペースト/
    // すべてを選択/---/検索…)。build() を増減したらここも合わせること。
    const OWN_EDIT_ITEMS: isize = 9;

    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let app = NSApplication::sharedApplication(mtm);
        let Some(main_menu) = app.mainMenu() else { return };
        let count = main_menu.numberOfItems();
        for i in 0..count {
            let item: Retained<_> = main_menu.itemAtIndex(i).unwrap();
            let Some(sub) = item.submenu() else { continue };
            // 編集メニューは「すべてを選択(selectAll:)」を持つ唯一のメニュー。
            // 題名で探すと言語ごとに変わるので、項目の action で見分ける。
            let n = sub.numberOfItems();
            let is_edit = (0..n).any(|j| {
                let it: Retained<_> = sub.itemAtIndex(j).unwrap();
                it.action()
                    .map(|sel| sel.name().to_bytes() == b"selectAll:")
                    .unwrap_or(false)
            });
            if !is_edit {
                continue;
            }
            // 自分が入れたぶんより後ろを末尾から削る。
            let mut k = sub.numberOfItems() - 1;
            while k >= OWN_EDIT_ITEMS {
                sub.removeItemAtIndex(k);
                k -= 1;
            }
            break;
        }
    });
}
