# 食事管理アプリ — スキル

## デプロイ手順（GitHub Pages）

コード変更後、以下の手順でデプロイする:

```bash
cd "/Volumes/KIOXIA/キャットフード研究室/食事管理アプリ"

# 1. ビルド
npx vite build

# 2. mainにコミット・プッシュ
git add -A && git commit -m "変更内容" && git push origin main

# 3. gh-pagesブランチにデプロイ
find . -name '._*' -delete
git checkout gh-pages
rm -rf assets index.html
git checkout main -- dist/
cp -r dist/* .
find . -name '._*' -delete
git add index.html assets/
git commit -m "Deploy: 変更内容"
git push origin gh-pages
git checkout main
```

## 公開URL
https://qoo0902.github.io/cat-food-app/

## リポジトリ
https://github.com/Qoo0902/cat-food-app

## 技術スタック
- React 19 + Tailwind CSS v4
- Vite 8（ビルドツール）
- データ保存: localStorage（window.storage フォールバック）
- ホスティング: GitHub Pages（gh-pagesブランチ）

## ファイル構成
- `App.jsx` — メインコンポーネント（全ロジック・UI）
- `src/main.jsx` — エントリーポイント
- `src/index.css` — Tailwind読み込み
- `vite.config.js` — Vite設定（base: /cat-food-app/）

## デプロイ手順（改良版 — クリーンデプロイ）

gh-pagesに古いassetsが蓄積する問題があるため、`rm -rf assets index.html dist` で全削除してからコピーする:

```bash
cd "/Volumes/KIOXIA/キャットフード研究室/食事管理アプリ"
find . -name '._*' -delete && npx vite build
git add App.jsx dist/ && git commit -m "変更内容" && git push origin main
find . -name '._*' -delete && git checkout gh-pages
rm -rf assets index.html dist
git checkout main -- dist/
cp -r dist/* .
find . -name '._*' -delete
git add -A && git commit -m "Deploy: 変更内容" && git push origin gh-pages
git checkout main
```

## 主要機能一覧（2026-04-12時点）
- ペット情報（名前・体重）→ DER自動計算
- フードマスター（商品登録・編集・削除）
- 「水」デフォルト登録（水分100%、id: `__water__`）
- 総合栄養食チェックボックス（isCompleteフラグ）
- メニュー作成（給餌量入力→カロリー・水分自動計算）
- サマリー（カロリー差異・水分差異・DER比±%・総合栄養食/一般食カロリー割合バー）
- DM（乾物量ベース）表示
- メニュー保存・読み込み・上書き
- CSVエクスポート（総合栄養食列付き）
- CSVインポート（ヘッダー行自動検出・合計行以降自動除外）
- 成分表画像読み取り（Tesseract.js登録不要 / Gemini 2.5-flash高精度モード）
- ⚙設定（Gemini APIキー管理、localStorageに保存）

## Gemini API
- モデル: `gemini-2.5-flash`（2.0-flashは廃止済み）
- エンドポイント: `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
- APIキーはlocalStorageの `gemini-api-key` に保存

## CSVインポートの仕様
- ヘッダー行: 「商品名」を含む行を自動検出（1行目固定ではない）
- データ行: ヘッダー行の次行から読み取り
- 終了条件: 「合計」行を見つけたらそこで終了（集計行を除外）
- 重複: 同名商品はスキップ
- エクスポートCSVをそのままインポート可能

## 注意事項
- macOSメタデータ `._*` ファイルはデプロイ前に必ず削除する
- gh-pagesブランチはdistの中身だけを配置する（node_modulesやソースは含めない）
- gh-pagesに古いassets蓄積注意 → クリーンデプロイ手順を使う
- ビルド時にcwdがずれると`npx vite build`が失敗する → `npm install`してから再実行
