---
name: Shizuka Desktop
source: Google Stitch (2026-07-24)
status: superseded  # この配色は実装で使っていない。下の注記を読む
colors:
  surface: '#131314'
  surface-container-low: '#1b1b1c'
  surface-container: '#1f1f20'
  surface-container-high: '#2a2a2b'
  on-surface: '#e5e2e3'
  primary: '#e65a41'          # 朱色(Muted Vermilion) — 主要アクション・アクティブ状態のみ
  primary-hover: '#f26249'
  secondary: '#3d4251'        # 藍鼠(Indigo-Charcoal) — プレースホルダ・選択状態
  outline: '#2d2d30'
typography:
  headline: 'Noto Serif JP / Hiragino Mincho ProN'   # 見出し・縦書き背表紙・タイトル
  body: 'Noto Sans JP / Hiragino Kaku Gothic ProN'   # UI・本文ラベル
rounded:
  standard: 6-8px             # ボタン・入力
  container: 8-12px           # カード・モーダル
  pill: 999px                 # 検索入力
spacing:
  unit: 8px
  gutter: 20-24px
  header-height: 52px
shadows:
  hover: '0 4px 20px rgba(0,0,0,.2)'
  modal: '0 12px 40px rgba(0,0,0,.4)'
---

# Shizuka Desktop — EPUB リーダーのデザインシステム

> **この配色は、いまの実装では使っていない（2026-09-05 に確認）。**
>
> 上の frontmatter にある朱色 `#e65a41` と温チャコール `#131314` は、画面のどこにも出ていない。
> **実装は macOS のシステム色に従う。** アクセント色は systemBlue（`#007aff` / ダークは `#0a84ff`）、
> 地は systemBackground（`#ffffff` / ダークは黒に近い灰）である。
> 根拠は `src/styles/app.css` の冒頭に書いてある方針で、そこには
> **「見た目の基準は Swift 版。独自のデザイン言語は持たない」**とある。
> 元アプリ（移植元の Swift 版）の画面写真も青である。
>
> **なぜ食い違ったか**: 2026-07-24 に Stitch でこの配色を作って一度当てたあと、
> 「画面は Swift 版そっくりにする」という方針へ変わった。**コードは方針に合わせて直したが、
> この文書は直さなかった。**
>
> **どちらが正しいかを決めるのは人である。** いま朱色へ戻す判断をするなら、
> `src/styles/app.css` を直したうえでこの注記を消す。
> 青のままでよいなら、この文書は経緯の記録として残す。

Google Stitch で生成（プロンプト: 日本の書店/上質な文具店の静かな知的雰囲気）。

## 原則

- **温かみのあるチャコール**: 純黒 (#000) を避け #131314 を基調。紙のような奥行き。
- **朱色は控えめに**: プライマリボタン・アクティブ状態・スライダーつまみ・フォーカスリングのみ。
- **二書体**: UI はゴシック、見出し/タイトル/背表紙は明朝（`--serif`）。ウェイトと書体でヒエラルキーを作り、色数を増やさない。
- **トーナルレイヤー**: 境界は色の段差 + 極めて柔らかいシャドウで表現。ホバーは 2〜3px の浮き上がり。
- **縦書きの美学**: 表紙なし本のプレースホルダは藍鼠グラデーション + 明朝の縦書きで背表紙に見立てる。
- **ガラス質のバー**: ヘッダー/ツールバーは `backdrop-filter: blur(20px)` の半透明。

## テーマ対応

CSS 変数でライト（温白 #faf9f7）/ セピア（#f4ecd8・朱は #b0492f に暗調整）/ ダークの 3 面に展開。
リーダー本文のダーク背景は UI 地より一段持ち上げた #1b1b1c（surface-container-low）。

## コンポーネント

- **Primary ボタン**: 朱色ベタ + 白文字、境界なし。ホバーで #f26249。
- **Secondary ボタン**: 透明 + 1px アウトライン。ホバーで card-hover 面。
- **Ghost（アイコン）**: 背景・境界なし、muted 色 → ホバーで面 + fg 色。
- **検索入力**: ピル型。フォーカスで朱色 1px グロー。
- **ブックカード**: 表紙 radius 8px + 薄いシャドウ、ホバーで translateY(-3px) + shadow-sm。タイトルは 2 行 line-clamp。
  読みかけの本には表紙左下に進捗ピル（黒半透明 + blur）。
- **進捗スライダー**: 3px トラック + 12px 朱色サム（ホバーで 1.25 倍）。RTL 本では鏡像。
- **読みかけヒーロー + アンビエント背景**（本棚、Stitch "Immersive Library View" 由来）:
  最後に読んだ本の表紙を `blur(46px)`・opacity .75 で**本棚スクリーン全面**（`#ambient`, fixed）に敷き、
  上部だけ薄い黒スクリム + 下方で `var(--bg)` へ溶けるグラデーション（94% で完全に地色）。
  ヒーロー自体は箱にせず、この背景の上に表紙（shadow 強め）+ 明朝タイトル + 「{n}% 読了」 +
  朱色「続きを読む」を素で載せる。グリッドのカードもうっすら透ける。
  データ源: `store 'last-read'`（reader が保存）+ `store 'frac-<id>'`（進捗率）。
- **リーダーのバー**（Stitch "Focus Reading Mode" 由来）: 境界線を引かず、
  `backdrop-filter: blur(20px)` + 地色へのグラデーションで本文に溶かす透け感。
- **バー内ボタン**（Stitch "操作系最適化版" 由来）: 微グラデーション + 1px 輪郭 + 薄影の
  浮き出しチップ。再生だけ朱色の丸ボタン（38px、アクセント色のグロー影）で主役化。
  停止・前後送りは 34px の丸チップ。
