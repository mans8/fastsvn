#!/bin/bash
# 校验打包产物里的内嵌 svn 引擎
#   bash scripts/check-embed.sh [build/FastSVN.app] [--with-net]
set -euo pipefail

APP="${1:-build/FastSVN.app}"
SVN="$APP/Contents/Resources/svn/bin/svn"
[ -x "$SVN" ] || { echo "找不到 $SVN"; exit 1; }

echo "引擎：$SVN"
echo "版本：$("$SVN" --version --quiet)"

echo -n "非系统依赖："
NON="$(otool -L "$SVN" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib|/System|@)' || true)"
if [ -z "$NON" ]; then echo "无（静态链接）"; else echo "有 → 不该出现"; echo "$NON"; exit 1; fi

echo -n "RA 模块："
MODS="$("$SVN" --version | grep -E '^\* ra_' | awk '{print $2}' | tr '\n' ' ')"
echo "$MODS"
for m in ra_local ra_svn ra_serf; do
  case "$MODS" in *"$m"*) ;; *) echo "缺少 $m"; exit 1 ;; esac
done

echo -n "隔离环境（env -i）运行："
env -i LC_ALL=en_US.UTF-8 "$SVN" --version --quiet | tr -d '\n'; echo

if [ "${2:-}" = "--with-net" ]; then
  echo -n "https 冒烟测试："
  CA="$APP/Contents/Resources/ca/cacert.pem"
  [ -f "$CA" ] || { echo "缺少 CA 证书 $CA"; exit 1; }
  OUT="$(env -i LC_ALL=en_US.UTF-8 SSL_CERT_FILE="$CA" "$SVN" --non-interactive ls https://svn.apache.org/repos/asf/subversion/trunk 2>&1 | head -1)"
  case "$OUT" in
    *E170013*|*E230001*) echo "失败：${OUT}"; exit 1 ;;
    *) echo "OK：${OUT}" ;;
  esac
fi

echo "全部通过"
