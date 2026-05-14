#!/bin/bash
set -e

echo "🚀 Deploying to Vultr..."

ssh root@139.180.215.150 << 'EOF'
set -e
cd /root/ai-portfolio-strategist
echo "📥 Pulling latest..."
git pull origin main

echo "🗄️  Syncing DB schema..."
cd lib/db && npx drizzle-kit push --config ./drizzle.config.ts && cd ../..

echo "🔨 Building API..."
cd artifacts/api-server && pnpm build

echo "🔨 Building frontend..."
cd ../portfolio-strategist && PORT=4173 BASE_PATH=/ pnpm build

echo "♻️  Restarting PM2..."
pm2 restart all
pm2 status
echo "✅ Deploy complete"
EOF
