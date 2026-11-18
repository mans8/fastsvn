#!/bin/bash
# 把 svn 可执行文件放进 app。
#
#   bash scripts/bundle-svn.sh <svn 可执行文件> <输出目录>
#
# 两种情形：
#   1. 官方源码自建（scripts/build-svn.sh）→ 第三方库全是静态的，只拷一个可执行文件；
#   2. 系统/Homebrew 的 svn → 连同它的非系统 dylib 一起拷，并把 install_name
#      改写成 @executable_path / @loader_path 相对路径。
set -euo pipefail

SRC_SVN="${1:-}"
OUT="${2:-}"
if [ -z "$SRC_SVN" ] || [ -z "$OUT" ]; then
  echo "用法: bundle-svn.sh /path/to/svn /path/to/Resources/svn" >&2
  exit 1
fi
if [ ! -x "$SRC_SVN" ]; then
  echo "不是可执行文件：$SRC_SVN" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/bin"
cp "$SRC_SVN" "$OUT/bin/svn"
chmod +x "$OUT/bin/svn"
codesign --force --sign - "$OUT/bin/svn" >/dev/null 2>&1 || true

is_system() {
  case "$1" in
    /usr/lib/*|/System/*|/Library/Apple/*) return 0 ;;
    @*) return 0 ;;
    *) return 1 ;;
  esac
}

# 除了系统库之外还有没有依赖？没有就是自建的静态版本
NON_SYSTEM="$(otool -L "$OUT/bin/svn" | tail -n +2 | awk '{print $1}' | while read -r dep; do
  [ -n "$dep" ] || continue
  if ! is_system "$dep"; then echo "$dep"; fi
done)"

if [ -z "$NON_SYSTEM" ]; then
  echo "    内嵌 svn：$("$OUT/bin/svn" --version --quiet)（静态，$(du -sk "$OUT" | awk '{print $1}') KB，只依赖系统库）"
  exit 0
fi

mkdir -p "$OUT/lib"

# 递归收集非系统依赖（Homebrew 的 dylib 之间还会互相引用）
collect() {
  local file="$1" dep base
  while read -r dep; do
    [ -n "$dep" ] || continue
    if is_system "$dep"; then continue; fi
    base="$(basename "$dep")"
    if [ ! -f "$OUT/lib/$base" ]; then
      cp "$dep" "$OUT/lib/$base"
      collect "$dep"
    fi
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
}
collect "$OUT/bin/svn"

for lib in "$OUT"/lib/*.dylib; do
  install_name_tool -id "@loader_path/$(basename "$lib")" "$lib" 2>/dev/null
done

patch_refs() {
  local file="$1" prefix="$2" dep
  while read -r dep; do
    [ -n "$dep" ] || continue
    if is_system "$dep"; then continue; fi
    install_name_tool -change "$dep" "$prefix/$(basename "$dep")" "$file" 2>/dev/null
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
}
patch_refs "$OUT/bin/svn" "@executable_path/../lib"
for lib in "$OUT"/lib/*.dylib; do
  patch_refs "$lib" "@loader_path"
done

for f in "$OUT/bin/svn" "$OUT"/lib/*.dylib; do
  codesign --force --sign - "$f" >/dev/null 2>&1 || true
done

LEFTOVER="$(otool -L "$OUT/bin/svn" "$OUT"/lib/*.dylib | grep -E '/opt/homebrew|/usr/local' || true)"
if [ -n "$LEFTOVER" ]; then
  echo "还有未处理的依赖：" >&2
  echo "$LEFTOVER" >&2
  exit 1
fi

echo "    内嵌 svn：$("$OUT/bin/svn" --version --quiet)（动态，$(( $(du -sk "$OUT" | awk '{print $1}') / 1024 )) MB，$(ls "$OUT"/lib/*.dylib | wc -l | tr -d ' ') 个依赖库）"
