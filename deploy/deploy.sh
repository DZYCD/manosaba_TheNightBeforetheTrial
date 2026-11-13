#!/usr/bin/env bash
# ============================================================
# manosaba_TheNightBeforetheTrial 静态站点部署脚本
# ------------------------------------------------------------
# 用法（在目标服务器上执行）：
#   bash deploy.sh                     # 默认装到 /var/www/manosaba
#   WWW_ROOT=/srv/www bash deploy.sh   # 换根目录
#   SUBPATH=game bash deploy.sh        # 换子路径（URL 变成 /game/）
#
# 首次执行会 clone，之后每次执行都是 fetch + 强制对齐到远端分支，
# 所以重复跑是安全的（幂等）。
# ============================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/DZYCD/manosaba_TheNightBeforetheTrial.git}"
BRANCH="${BRANCH:-main}"
WWW_ROOT="${WWW_ROOT:-/var/www}"
SUBPATH="${SUBPATH:-manosaba}"
TARGET="${WWW_ROOT%/}/${SUBPATH%/}"

echo "==> 仓库   : $REPO_URL ($BRANCH)"
echo "==> 目标   : $TARGET"

if ! command -v git >/dev/null 2>&1; then
    echo "!! 未安装 git，请先安装" >&2
    exit 1
fi

mkdir -p "$WWW_ROOT"

if [ -d "$TARGET/.git" ]; then
    echo "==> 已存在，拉取更新"
    git -C "$TARGET" fetch --depth 1 origin "$BRANCH"
    git -C "$TARGET" checkout -f "$BRANCH" 2>/dev/null || git -C "$TARGET" checkout -f -B "$BRANCH" "origin/$BRANCH"
    git -C "$TARGET" reset --hard "origin/$BRANCH"
else
    echo "==> 首次克隆"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TARGET"
fi

# 静态资源权限：目录 755、文件 644，保证 web server 可读
echo "==> 修正权限"
find "$TARGET" -type d -exec chmod 755 {} +
find "$TARGET" -type f -exec chmod 644 {} +
chmod 755 "$TARGET"

# GitHub Pages 不跑 Jekyll 的标记文件，某些静态服务器用不到，这里只确保存在
[ -f "$TARGET/.nojekyll" ] || touch "$TARGET/.nojekyll"

SIZE=$(du -sh "$TARGET" | cut -f1)
FILES=$(find "$TARGET" -type f -not -path '*/.git/*' | wc -l)
echo "==> 完成：$FILES 个文件，$SIZE"
echo "==> 访问地址（需 nginx/apache 配好 $SUBPATH 路径）："
echo "    http://<服务器地址>/$SUBPATH/"
echo
echo "nginx 配置示例见同目录 nginx-manosaba.conf"
