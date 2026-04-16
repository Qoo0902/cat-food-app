#!/bin/bash
# メンバーコード発行スクリプト
# 使い方:
#   ./issue_member_code.sh              # 今月分を自動発行
#   ./issue_member_code.sh 2026-06       # 指定月分を発行
#
# 動作: ランダム6文字のコードを生成し、Cloudflare KVに登録。
# 先生はこのコードをYouTubeメンバーシップの会員限定投稿で配布する。

set -e
cd "$(dirname "$0")"

# 発行対象月
MONTH="${1:-$(date +%Y-%m)}"
YEAR=$(echo "$MONTH" | cut -d- -f1)
MONTH_NUM=$(echo "$MONTH" | cut -d- -f2)

# ランダム6文字（大文字英数字、紛らわしい0/O/I/1は除外）
CHARS="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
RANDOM_PART=""
for i in {1..6}; do
  RANDOM_PART="${RANDOM_PART}${CHARS:$((RANDOM % ${#CHARS})):1}"
done
CODE="CM-${RANDOM_PART}"

# 有効期限: 発行月の翌月末日 23:59:59 UTC (日本時間の翌々月1日 8:59:59 まで有効)
NEXT_MONTH=$(date -j -v+1m -f "%Y-%m" "$MONTH" "+%Y-%m" 2>/dev/null || date -d "$MONTH-01 +1 month" +%Y-%m)
EXPIRES_AT="${NEXT_MONTH}-01T00:00:00Z"

# KVに登録
JSON="{\"type\":\"member\",\"month\":\"${MONTH}\",\"expiresAt\":\"${EXPIRES_AT}\",\"devices\":[]}"

echo "発行対象: ${MONTH}"
echo "コード:   ${CODE}"
echo "有効期限: ${EXPIRES_AT}"
echo "ペイロード: ${JSON}"
echo

read -p "このコードをKVに登録しますか？ (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "キャンセルしました"
  exit 0
fi

npx wrangler@latest kv key put --binding=RATE_LIMIT "license:${CODE}" "$JSON" --remote

echo
echo "✅ 登録完了: ${CODE}"
echo
echo "📋 YouTubeメンバーシップ会員向けに以下の文面で告知してください："
echo "─────────────────────────────────────────"
echo "食事管理アプリ ${MONTH} 月のアクセスコード"
echo
echo "${CODE}"
echo
echo "※ 有効期限: ${EXPIRES_AT}"
echo "※ 1コードあたり3デバイスまで"
echo "※ アプリURL: https://qoo0902.github.io/cat-food-app/"
echo "─────────────────────────────────────────"
