#!/bin/bash
set -e

echo "🚀 Deploying to Vultr..."

echo "📤 Pushing to remote..."
git push origin main

LOCAL_COMMIT=$(git rev-parse HEAD)
echo "📌 Local HEAD: $LOCAL_COMMIT"

ssh root@139.180.215.150 << EOF
set -e
ROOT=/root/ai-portfolio-strategist
cd \$ROOT

echo "📥 Pulling latest..."
git pull origin main

echo "🗄️  Syncing DB schema..."
set -a && source \$ROOT/.env && set +a
cd \$ROOT/lib/db && npx drizzle-kit push --config ./drizzle.config.ts

echo "🔨 Building API..."
cd \$ROOT/artifacts/api-server && pnpm build

echo "🔨 Building frontend..."
cd \$ROOT/artifacts/portfolio-strategist && PORT=4173 BASE_PATH=/ pnpm build

echo "♻️  Restarting PM2..."
cd \$ROOT && pm2 restart all
pm2 status

echo "🔍 Verifying commit match..."
SERVER_COMMIT=\$(git -C \$ROOT rev-parse HEAD)
echo "📌 Server HEAD: \$SERVER_COMMIT"
if [ "\$SERVER_COMMIT" != "$LOCAL_COMMIT" ]; then
  echo "❌ COMMIT MISMATCH — local: $LOCAL_COMMIT | server: \$SERVER_COMMIT"
  echo "❌ Deploy FAILED — server is not running the expected code"
  exit 1
fi
echo "✅ Commit verified: \$SERVER_COMMIT"
echo "✅ Deploy complete"
EOF
