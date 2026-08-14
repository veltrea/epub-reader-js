// デスクトップ実行のエントリポイント。実体は lib.rs の run()。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    epub_reader_lib::run()
}
