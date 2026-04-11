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

## 注意事項
- macOSメタデータ `._*` ファイルはデプロイ前に必ず削除する
- gh-pagesブランチはdistの中身だけを配置する（node_modulesやソースは含めない）
