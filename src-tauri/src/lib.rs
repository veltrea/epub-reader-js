// epub-reader バックエンド。
// 役割は最小限:
//  - 汎用 JSON ストア(ライブラリ/辞書/設定の永続化)
//  - EPUB の取り込み(ネイティブダイアログ)とファイル読み込み(base64)
//  - VOICEVOX/AivisSpeech への HTTP プロキシ(CORS 回避のため Rust 経由)
// 組版・表示・読み上げ制御は全部フロント(foliate-js)側。ここは薄いI/O層。

mod menu;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

// ---- アプリのデータ置き場 (~/Library/Application Support/dev.veltrea.epub-reader) ----

fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("dev.veltrea.epub-reader");
    let _ = fs::create_dir_all(dir.join("books"));
    dir
}

fn store_path(name: &str) -> PathBuf {
    // name はキー名のみ許可(パス区切りを除去)。
    // '#' は書棚(プロファイル)ごとのキー `library#<uuid>` に使うので通す(profiles.js を参照)。
    let safe: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '#'))
        .collect();
    data_dir().join(format!("{safe}.json"))
}

// ---- 汎用 JSON ストア ----

#[tauri::command]
fn store_get(name: String) -> Value {
    let p = store_path(&name);
    match fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

#[tauri::command]
fn store_set(name: String, value: Value) -> Result<(), String> {
    let p = store_path(&name);
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&p, bytes).map_err(|e| e.to_string())
}

// ---- EPUB 取り込み / 読み込み ----

/// ネイティブダイアログで EPUB を複数選択。選ばれた元ファイルのパスを返す。
#[tauri::command]
async fn pick_epubs(app: tauri::AppHandle) -> Vec<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Books", BOOK_EXTENSIONS)
        .pick_files(move |paths| {
            let list: Vec<String> = paths
                .map(|ps| ps.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            let _ = tx.send(list);
        });
    rx.recv().unwrap_or_default()
}

/// 任意ファイルを base64 で読む(webview に EPUB バイト列を渡す用)。
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(B64.encode(bytes))
}

// ---- フォルダからのまとめ取り込み ----

/// 一度に取り込む上限。フォルダを取り違えてホームディレクトリ全体を落とされても、
/// 走査と登録が果てしなく続かないようにする。
const COLLECT_LIMIT: usize = 5_000;

/// 自然順の比較(数字は数として比べる)。Finder と同じ感覚の並びにするため。
/// 書棚は追加順に積むので、この並びがそのまま「1巻→2巻→…」の並びになる。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let na: String = collect_digits(&mut ia);
                    let nb: String = collect_digits(&mut ib);
                    // 桁数が違えば大きいほうが後。同じなら文字列比較(先頭の 0 を無視するため)。
                    let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                    let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                } else {
                    let ord = ca.to_lowercase().cmp(cb.to_lowercase());
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}

fn collect_digits(it: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        s.push(c);
        it.next();
    }
    s
}

/// 書棚に入れられる形式。**ここだけが対応形式の定義**——ダイアログのフィルタ・
/// フォルダ走査・ドロップの展開・ファイル関連付けが食い違わないように 1 か所へ集める。
///
/// 中身を読むのは同梱の foliate-js で、EPUB / CBZ(画像アーカイブ) / FB2・FBZ /
/// MOBI・AZW3(KF8) を見分けられる(`src/foliate-js/view.js` の `makeBook`)。
/// **判定は拡張子にも依る**(CBZ と FBZ は ZIP なので、名前を見ないと EPUB と区別できない)。
/// だから取り込んだ本は `books/<id>.<元の拡張子>` と、拡張子を保ったまま置く。
pub const BOOK_EXTENSIONS: &[&str] = &[
    "epub", // EPUB 2/3
    "cbz",  // 画像アーカイブ(漫画)
    "fb2", "fbz", // FictionBook
    "mobi", "azw", "azw3", "kf8", // Kindle 系
];

fn is_book(p: &Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|e| BOOK_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

/// 取り込み済みの本の実体。拡張子は形式によって変わるので `books/<id>.*` を探す。
fn book_path(id: &str) -> Option<PathBuf> {
    let safe: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
    if safe.is_empty() {
        return None;
    }
    let dir = data_dir().join("books");
    for ext in BOOK_EXTENSIONS {
        let p = dir.join(format!("{safe}.{ext}"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 保存するときの拡張子。未知のものは epub 扱いにする(以前の挙動と同じ)。
fn book_ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| BOOK_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or_else(|| "epub".to_string())
}

/// フォルダを再帰的にたどって EPUB を集める。隠しファイルは見ない。
/// `.epub` という名前の**フォルダ**を本と取り違えないよう、実体がファイルかを確かめる。
fn collect_epubs(root: &Path, out: &mut Vec<String>) {
    if out.len() >= COLLECT_LIMIT {
        return;
    }
    let Ok(rd) = fs::read_dir(root) else { return };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        let hidden = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false);
        if hidden {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => dirs.push(p),
            Ok(t) if t.is_file() && is_book(&p) => {
                out.push(p.to_string_lossy().to_string());
                if out.len() >= COLLECT_LIMIT {
                    return;
                }
            }
            _ => {}
        }
    }
    for d in dirs {
        collect_epubs(&d, out);
        if out.len() >= COLLECT_LIMIT {
            return;
        }
    }
}

/// 渡されたパスの並びを「取り込めるファイル」の並びへ展開する。
/// フォルダはその中身に置き換え、重複(同じ本がフォルダ経由とファイル経由の両方で来た等)は落とす。
#[tauri::command]
fn expand_book_paths(paths: Vec<String>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for raw in paths {
        let p = PathBuf::from(&raw);
        if p.is_dir() {
            collect_epubs(&p, &mut found);
        } else if p.is_file() && is_book(&p) {
            found.push(raw);
        }
    }
    found.sort_by(|a, b| natural_cmp(a, b));
    found.dedup();
    found.truncate(COLLECT_LIMIT);
    found
}

/// ネイティブダイアログでフォルダを選ばせ、その中の EPUB をまとめて返す。
#[tauri::command]
async fn pick_folder_epubs(app: tauri::AppHandle) -> Vec<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
    });
    match rx.recv().unwrap_or(None) {
        Some(dir) => expand_book_paths(vec![dir.to_string_lossy().to_string()]),
        None => Vec::new(),
    }
}

// ---- 電源操作(スリープタイマーの満了動作) ----

/// Mac をスリープさせる。`pmset sleepnow` は管理者権限も追加の許可も要らない。
#[tauri::command]
fn system_sleep() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/pmset")
            .arg("sleepnow")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("sleep is only implemented on macOS".to_string())
}

/// Mac をシャットダウンする。
/// `shutdown -h now` は root が要るが、System Events 経由ならログイン中のユーザー権限で
/// 正規の終了処理(各アプリへの終了問い合わせ)が走る。代わりに**初回だけ**
/// 「"System Events" を操作する許可」の OS ダイアログが出る。
#[tauri::command]
fn system_shutdown() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/osascript")
            .args(["-e", "tell application \"System Events\" to shut down"])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("shutdown is only implemented on macOS".to_string())
}

// ---- 書棚(プロファイル)の後始末 ----

/// 消した書棚のデータを `Deleted/` へ寄せる(**消さない**)。
///
/// 中身は「どの本を登録したか・どこまで読んだか・どう分類したか」で、EPUB 本体と違って
/// 作り直せない。取り違えて消したときに戻せるよう、名前を変えて残すだけにする。
/// 対象は `<key>#<id>.json` の形のファイルだけ——接尾辞の付いていないキーは
/// **最初からある書棚のもの**なので絶対に触らない。
#[tauri::command]
fn retire_profile_data(id: String) -> Result<u32, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();
    if safe.is_empty() {
        return Err("empty profile id".to_string());
    }
    let dir = data_dir();
    let graveyard = dir.join("Deleted");
    fs::create_dir_all(&graveyard).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let suffix = format!("#{safe}.json");
    let mut moved = 0u32;
    let Ok(rd) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(&suffix) {
            continue;
        }
        let dest = graveyard.join(format!("{stamp}-{name}"));
        if fs::rename(entry.path(), &dest).is_ok() {
            moved += 1;
        }
    }
    Ok(moved)
}

// ---- 読み上げ音声のファイル保存 ----

/// ネイティブダイアログでフォルダを1つ選ばせる。選ばれたパス(なければ null)を返す。
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p.and_then(|fp| fp.into_path().ok()).map(|p| p.to_string_lossy().to_string()));
    });
    rx.recv().unwrap_or(None)
}

/// macOS 標準の保存パネル(NSSavePanel)を出し、ユーザーが決めた保存先フルパスを返す。
/// default_name は初期ファイル名、ext は拡張子フィルタ(空可)。
#[tauri::command]
async fn save_file_dialog(app: tauri::AppHandle, default_name: String, ext: String) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().set_file_name(&default_name);
    if !ext.is_empty() {
        builder = builder.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    builder.save_file(move |p| {
        let _ = tx.send(p.and_then(|fp| fp.into_path().ok()).map(|p| p.to_string_lossy().to_string()));
    });
    rx.recv().unwrap_or(None)
}

/// base64 のバイト列を指定フルパスへ書き出す。保存したパスを返す。
#[tauri::command]
fn write_bytes(path: String, data_b64: String) -> Result<String, String> {
    let bytes = B64.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// base64 のバイト列を dir/filename に書き出す。保存した絶対パスを返す。
/// filename はパス区切り(/ \ :)を除去してディレクトリ外への書き込みを防ぐ。
#[tauri::command]
fn save_bytes(dir: String, filename: String, data_b64: String) -> Result<String, String> {
    let safe_name: String = filename
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':'))
        .collect();
    if safe_name.is_empty() {
        return Err("empty filename".to_string());
    }
    let dir_path = Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("directory not found: {dir}"));
    }
    let bytes = B64.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    let dest = dir_path.join(&safe_name);
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// 取り込み: 元 EPUB を books/<id>.epub に複製する。id は呼び出し側が採番。
#[tauri::command]
fn import_book(src_path: String, id: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    if !src.exists() {
        return Err(format!("not found: {src_path}"));
    }
    let safe: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
    let dest = data_dir().join("books").join(format!("{safe}.{}", book_ext_of(src)));
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// バイト列そのものを books/<id>.epub として取り込む。
/// 元パスを持てないもの(アプリに同梱したサンプルなど)のための入口。
#[tauri::command]
fn import_book_bytes(id: String, data_b64: String, ext: Option<String>) -> Result<String, String> {
    let safe: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
    if safe.is_empty() {
        return Err("empty id".to_string());
    }
    let ext = ext
        .map(|e| e.to_lowercase())
        .filter(|e| BOOK_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or_else(|| "epub".to_string());
    let bytes = B64.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    let dest = data_dir().join("books").join(format!("{safe}.{ext}"));
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// 取り込み済みの本を base64 で返す(リーダーで開く用)。
/// **拡張子も一緒に返す**——CBZ と FBZ は ZIP なので、名前が無いと EPUB と区別できない。
#[tauri::command]
fn read_book_b64(id: String) -> Result<Value, String> {
    let p = book_path(&id).ok_or_else(|| format!("not found: {id}"))?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ext": book_ext_of(&p),
        "data": B64.encode(bytes),
    }))
}

/// 取り込み済み EPUB を削除。
/// 取り込み済みの本(books/<id>.epub)の id 一覧。
/// 書棚が「ファイルが見つかりません」を出すための実在判定に使う。
#[tauri::command]
fn list_books() -> Vec<String> {
    let dir = data_dir().join("books");
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if is_book(&p) {
                p.file_stem().and_then(|s| s.to_str()).map(str::to_string)
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
fn delete_book(id: String) -> Result<(), String> {
    if let Some(p) = book_path(&id) {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- テストバス(開発・自動テスト専用) ----
//
// フロントの `app/testbus.js` は 127.0.0.1:47832 のブリッジを長ポーリングし、届いた命令を
// **アプリの権限で**実行する。開発では手放せないが、配布版で常時つないでおくと
// 「そのポートを先に掴んだローカルのプロセス」がリーダーの権限(画面のキャプチャ・任意パスへの
// 書き出し・電源操作)をそのまま借りられてしまう。したがって既定は**無効**にし、
//   - デバッグビルド、または
//   - 環境変数 `EPUB_READER_TESTBUS=1` を付けて起動したとき
// だけ有効にする。リリースビルドを検証したいときは
//   `EPUB_READER_TESTBUS=1 ./target/release/epub-reader`
// のように立ち上げる。
fn testbus_allowed() -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    matches!(
        std::env::var("EPUB_READER_TESTBUS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// フロントがテストバスを起動してよいか。false なら長ポーリングを始めない。
#[tauri::command]
fn testbus_enabled() -> bool {
    testbus_allowed()
}

// ---- ウィンドウのスクリーンショット(テスト用・computer-use 非依存) ----
// 自アプリのウィンドウを xcap でキャプチャして PNG(base64) を返す。
// macOS では初回に「画面収録」権限の付与が必要(epub-reader に対して一度だけ)。
// テストバスと同じ理由で、配布版では無効(上の `testbus_allowed` を参照)。
#[tauri::command]
fn capture_window() -> Result<String, String> {
    if !testbus_allowed() {
        return Err("capture_window is disabled in release builds \
                    (set EPUB_READER_TESTBUS=1 to enable)"
            .to_string());
    }
    use xcap::Window;
    let windows = Window::all().map_err(|e| e.to_string())?;
    let target = windows.into_iter().find(|w| {
        let app = w.app_name().unwrap_or_default().to_lowercase();
        let title = w.title().unwrap_or_default().to_lowercase();
        app.contains("epub-reader") || app.contains("epub reader") || title.contains("epub reader")
    });
    let win = target.ok_or_else(|| "epub-reader のウィンドウが見つかりません".to_string())?;
    let img = win.capture_image().map_err(|e| e.to_string())?;
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, xcap::image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(B64.encode(buf.into_inner()))
}

// ---- VOICEVOX / AivisSpeech プロキシ ----

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// 疎通確認。エンジンのバージョン文字列を返す。
#[tauri::command]
async fn voicevox_version(base_url: String) -> Result<String, String> {
    let url = format!("{}/version", base_url.trim_end_matches('/'));
    let resp = client().get(&url).send().await.map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// 話者一覧(JSON をそのまま返す)。
#[tauri::command]
async fn voicevox_speakers(base_url: String) -> Result<Value, String> {
    let url = format!("{}/speakers", base_url.trim_end_matches('/'));
    let resp = client().get(&url).send().await.map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

/// 読み辞書が挿入した語境界だけを無音化する(SPECIFICATION.ja.md §10.2)。
///
/// 境界に空白を入れると隣接語との結合解析は断ち切れるが、代わりに約 0.45 秒の無音が入って
/// 朗読が途切れる。そこで audio_query の応答で pause_mora を持つ accent_phrase を
/// 先頭から数え、フロントが記録した序数に一致するものだけ vowel_length を 0 にする。
///
/// 数え方が食い違ったら(pause 数 != フロントが数えた区切り数)何もしない。
/// 無音が残るだけで読みは壊れない、という安全側に倒す。
fn silence_inserted_gaps(query: &mut Value, gap_count: i64, silence_gaps: &[i64]) {
    if silence_gaps.is_empty() {
        return;
    }
    let Some(phrases) = query.get_mut("accent_phrases").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let pause_total = phrases
        .iter()
        .filter(|p| p.get("pause_mora").map(|m| !m.is_null()).unwrap_or(false))
        .count() as i64;
    if gap_count >= 0 && pause_total != gap_count {
        return;
    }
    let mut ordinal: i64 = 0;
    for p in phrases.iter_mut() {
        let Some(mora) = p.get_mut("pause_mora") else { continue };
        if mora.is_null() {
            continue;
        }
        if silence_gaps.contains(&ordinal) {
            if let Some(obj) = mora.as_object_mut() {
                obj.insert("vowel_length".into(), serde_json::json!(0.0));
            }
        }
        ordinal += 1;
    }
}

/// テキストを合成して WAV を base64 で返す。
/// audio_query → (speedScale / pauseLengthScale / 挿入境界の無音化) → synthesis。
#[tauri::command]
async fn voicevox_synthesize(
    base_url: String,
    text: String,
    speaker: i64,
    speed_scale: f64,
    pause_length_scale: f64,
    gap_count: Option<i64>,
    silence_gaps: Option<Vec<i64>>,
) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    let c = client();

    // 1) audio_query
    let q_url = format!("{base}/audio_query");
    let q_resp = c
        .post(&q_url)
        .query(&[("text", text.as_str()), ("speaker", &speaker.to_string())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !q_resp.status().is_success() {
        return Err(format!("audio_query: HTTP {}", q_resp.status()));
    }
    let mut query: Value = q_resp.json().await.map_err(|e| e.to_string())?;

    // 2) 速度 / 無音長スケールを適用
    if let Some(obj) = query.as_object_mut() {
        obj.insert("speedScale".into(), serde_json::json!(speed_scale));
        // pauseLengthScale はエンジンが対応している場合のみ存在する
        if obj.contains_key("pauseLengthScale") {
            obj.insert("pauseLengthScale".into(), serde_json::json!(pause_length_scale));
        }
    }
    // 2b) 読み辞書が挿入した語境界の無音化
    if let Some(gaps) = silence_gaps.as_deref() {
        silence_inserted_gaps(&mut query, gap_count.unwrap_or(-1), gaps);
    }

    // 3) synthesis
    let s_url = format!("{base}/synthesis");
    let s_resp = c
        .post(&s_url)
        .query(&[("speaker", &speaker.to_string())])
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&query).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !s_resp.status().is_success() {
        return Err(format!("synthesis: HTTP {}", s_resp.status()));
    }
    let wav = s_resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(B64.encode(wav))
}

/// 読み上げ辞書にユーザー単語を登録(「斎ひとし問題」対策)。
/// pronunciation はカタカナ(ひらがなは呼び出し側で変換済み前提だが、両対応にする)。
#[tauri::command]
async fn voicevox_register_word(
    base_url: String,
    surface: String,
    pronunciation: String,
    accent_type: i64,
    priority: i64,
) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    let kana = hiragana_to_katakana(&pronunciation);
    let url = format!("{base}/user_dict_word");
    let resp = client()
        .post(&url)
        .query(&[
            ("surface", surface.as_str()),
            ("pronunciation", kana.as_str()),
            ("accent_type", &accent_type.to_string()),
            ("word_type", "PROPER_NOUN"),
            ("priority", &priority.to_string()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("user_dict_word: HTTP {}", resp.status()));
    }
    // 成功時は登録された uuid(文字列)が返る
    resp.text().await.map_err(|e| e.to_string())
}

fn hiragana_to_katakana(s: &str) -> String {
    s.chars()
        .map(|ch| {
            let u = ch as u32;
            if (0x3041..=0x3096).contains(&u) {
                char::from_u32(u + 0x60).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect()
}

// ---- 対訳(LM Studio / OpenAI 互換) ----
//
// 翻訳リクエストは必ずネイティブから出す。WebView からローカル LLM へは
// CSP(connect-src) でも CORS でも届かない(VOICEVOX で実証済みの制約)。

/// base URL の末尾が v1 なら二重に付けない。
fn lm_url(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1") {
        format!("{b}{path}")
    } else {
        format!("{b}/v1{path}")
    }
}

/// エラー本文を UI に載る長さへ畳む。**キーそのものは載せない**(本文にキーは入らないが、
/// 長い JSON をそのまま出すと画面が壊れるので頭だけ採る)。
fn truncate_detail(s: &str) -> String {
    let t = s.trim().replace(['\n', '\r'], " ");
    if t.chars().count() <= 200 {
        t
    } else {
        t.chars().take(200).collect::<String>() + "…"
    }
}

/// API キーがあれば Authorization ヘッダを足す(ローカルは空でよい)。
fn with_auth(req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        req
    } else {
        req.header("Authorization", format!("Bearer {}", api_key.trim()))
    }
}

/// 利用可能なモデル id 一覧。埋め込み専用モデル(id に embed を含む)は翻訳に使えないので除く。
#[tauri::command]
async fn lm_models(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = with_auth(
        client.get(lm_url(&base_url, "/models")),
        api_key.as_deref().unwrap_or(""),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        // キーの誤り(401)や権限(403)は本文に理由が入る。原因を UI に出せるよう畳んで返す。
        let code = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("models: HTTP {code} {}", truncate_detail(&detail)));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str())
                .filter(|id| !id.to_lowercase().contains("embed"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// 1 段落を翻訳する。戻り値は choices[0].message.content(整形はフロント側で行う)。
///
/// 引数が 8 個あって clippy の上限(7 個)を超えるが、まとめられない。
/// tauri::command の引数はフロントとの受け渡しの形そのもので、名前で 1 個ずつ届く。
/// 構造体にまとめるとフロント側の呼び出しも書き換えることになり、直す理由に見合わない。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn lm_chat(
    base_url: String,
    model: String,
    system: String,
    user: String,
    temperature: f64,
    disable_thinking: bool,
    api_key: Option<String>,
    prefill_think: Option<bool>,
) -> Result<String, String> {
    let max_tokens = user.chars().count().clamp(512, 4096);
    let mut messages = vec![
        serde_json::json!({"role": "system", "content": system}),
        serde_json::json!({"role": "user", "content": user}),
    ];
    if prefill_think.unwrap_or(false) {
        // 思考を済ませたことにして発話を継続させる。**推論モデルにはこれだけが効く。**
        // 実測(2026-08-09, qwen3.5-9b): chat_template_kwargs / reasoning_effort / /no_think は
        // どれも無効で、max_tokens 4000 を全部思考に使い切り本文が空になった。これを入れると
        // 同じ段落が 90 秒 → 2 秒で返る。prefill を受けないクラウド API 用に切れるようにしてある。
        messages.push(serde_json::json!({"role": "assistant", "content": "<think>\n\n</think>\n\n"}));
    }
    let mut body = serde_json::json!({
        "model": model,
        "temperature": temperature,
        "stream": false,
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if disable_thinking {
        // 効くモデルには効く(効かない場合の本命は上の prefill_think)。
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = with_auth(
        client
            .post(lm_url(&base_url, "/chat/completions"))
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?),
        api_key.as_deref().unwrap_or(""),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let code = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("chat: HTTP {code} {}", truncate_detail(&detail)));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let msg = &v["choices"][0]["message"];
    let content = msg["content"].as_str().unwrap_or("");
    if content.trim().is_empty() {
        // 推論モデルは思考に max_tokens を使い切り、content が空のまま返すことがある
        // (実測: 2 語の訳に思考数百トークン)。フロントで案内できるようコードで返す。
        if msg["reasoning_content"].is_string() {
            return Err("THINKING_ONLY".to_string());
        }
        return Err("EMPTY_COMPLETION".to_string());
    }
    Ok(content.to_string())
}

// ---- ネイティブメニュー ----

/// フロントからメニューを言語・文脈に合わせて作り直す。
/// lang は設定値そのまま('auto'|'ja'|'en')、ctx は 'shelf' か 'reader'。
/// state は「いま効いている値」(テーマ・書字方向・タイマーの稼働状況・書棚の一覧など)。
/// チェックマークを実際の値に合わせるため、フロントは値を変えるたびにこれを呼び直す。
#[tauri::command]
fn sync_menu(
    app: tauri::AppHandle,
    lang: String,
    ctx: String,
    state: Option<Value>,
) -> Result<(), String> {
    menu::apply(&app, &lang, &ctx, &state.unwrap_or(Value::Null)).map_err(|e| e.to_string())
}

// ---- Finder からのファイル起動(ダブルクリック / ドロップ) ----

/// まだフロントへ渡していない「開いてほしいファイル」。
///
/// 起動時のダブルクリックは webview が出来上がる前に届くので、その場では投げずに溜める。
/// フロントは画面が立ち上がったところで `take_pending_open` を 1 回引く。実行中に届いたぶんは
/// `open-files` イベントでも流すが、取りこぼしても次の起動で拾えるようここにも積む。
static PENDING_OPEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn push_pending_open(paths: Vec<String>) {
    if let Ok(mut q) = PENDING_OPEN.lock() {
        for p in paths {
            if !q.contains(&p) {
                q.push(p);
            }
        }
    }
}

/// 溜まっているファイルを取り出して空にする(同じ本を二度取り込まないため)。
#[tauri::command]
fn take_pending_open() -> Vec<String> {
    PENDING_OPEN
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 起動時は保存済み設定の言語で本棚メニューを組む。
            // 画面ロード後にフロントが sync_menu で正確な言語・文脈へ更新する。
            let settings = store_get("settings".into());
            let pref = menu::saved_lang_pref(&settings);
            menu::apply(app.handle(), &pref, "shelf", &settings)?;
            Ok(())
        })
        // 独自項目は実処理をフロントへ委譲(定義済み項目は OS が処理するのでここには来ない)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            sync_menu,
            store_get,
            store_set,
            pick_epubs,
            pick_folder_epubs,
            expand_book_paths,
            take_pending_open,
            system_sleep,
            system_shutdown,
            retire_profile_data,
            read_file_b64,
            pick_directory,
            save_bytes,
            save_file_dialog,
            write_bytes,
            import_book,
            import_book_bytes,
            read_book_b64,
            list_books,
            delete_book,
            testbus_enabled,
            capture_window,
            voicevox_version,
            voicevox_speakers,
            voicevox_synthesize,
            voicevox_register_word,
            lm_models,
            lm_chat,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Finder で EPUB をダブルクリック／アイコンへドロップしたときに届く。
        // 起動と同時のぶんは webview がまだ無いので、溜めておいてフロントに引かせる。
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if paths.is_empty() {
                    return;
                }
                push_pending_open(paths.clone());
                let _ = app.emit("open-files", paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_counts_digits_as_numbers() {
        let mut v = vec!["b10.epub".to_string(), "b9.epub".to_string(), "b1.epub".to_string()];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["b1.epub", "b9.epub", "b10.epub"]);
    }

    #[test]
    fn natural_order_ignores_leading_zeros_but_keeps_stable() {
        assert_eq!(natural_cmp("a007", "a7"), std::cmp::Ordering::Equal);
        assert_eq!(natural_cmp("a2", "a10"), std::cmp::Ordering::Less);
    }

    #[test]
    fn readable_extensions_are_importable() {
        for ok in ["/x/y.EPUB", "/x/y.epub", "/x/y.cbz", "/x/y.fb2", "/x/y.fbz",
                   "/x/y.mobi", "/x/y.azw3"] {
            assert!(is_book(Path::new(ok)), "{ok}");
        }
        for ng in ["/x/y.zip", "/x/y.txt", "/x/y"] {
            assert!(!is_book(Path::new(ng)), "{ng}");
        }
    }

    #[test]
    fn stored_extension_follows_the_source() {
        // CBZ と FBZ は ZIP なので、拡張子を落とすと EPUB と区別できなくなる。
        assert_eq!(book_ext_of(Path::new("/x/y.CBZ")), "cbz");
        assert_eq!(book_ext_of(Path::new("/x/y.fbz")), "fbz");
        // 未知のものは以前どおり epub 扱い。
        assert_eq!(book_ext_of(Path::new("/x/y.bin")), "epub");
    }

    #[test]
    fn store_path_keeps_the_profile_suffix() {
        let p = store_path("library#00000000-0000-0000-0000-00000000e9b0");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "library#00000000-0000-0000-0000-00000000e9b0.json");
    }

    #[test]
    fn store_path_strips_path_separators() {
        let p = store_path("../../etc/passwd");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "etcpasswd.json");
    }
}
