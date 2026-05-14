#!/bin/bash
set -e

echo "🚀 Deploying to Vultr..."

ssh root@139.180.215.150 << 'EOF'
set -e
ROOT=/root/ai-portfolio-strategist
cd $ROOT

echo "📥 Pulling latest..."
git pull origin main

echo "🗄️  Syncing DB schema..."
set -a && source $ROOT/.env && set +a
cd $ROOT/lib/db && npx drizzle-kit push --config ./drizzle.config.ts

echo "🔨 Building API..."
cd $ROOT/artifacts/api-server && pnpm build

echo "🔨 Building frontend..."
cd $ROOT/artifacts/portfolio-strategist && PORT=4173 BASE_PATH=/ pnpm build

echo "♻️  Restarting PM2..."
cd $ROOT && pm2 restart all
pm2 status
echo "✅ Deploy complete"
EOF
