#!/bin/bash
# 从 Apache 官方源码编译 FastSVN 用的 svn 引擎（内嵌 libsvn）
#
#   bash scripts/build-svn.sh [输出目录]
#
# 产物：<输出目录>/bin/svn —— 一个 7MB 左右的可执行文件，
# 第三方库（apr / apr-util / serf / openssl / utf8proc / sqlite）全部静态链接，
# 只依赖 macOS 自带的系统库，所以打包时不需要再带一堆 dylib。
#
# 版本锁定：subversion 1.14.5 / serf 1.3.10 / openssl 3.0.16 / utf8proc 2.8.0
# 许可：均为 Apache-2.0 或 MIT/BSD 系，详见 native/svn/NOTICE.txt
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/native/svn}"
WORK="${FASTSVN_SVN_BUILD_DIR:-/tmp/fastsvn-svn-build}"
PREFIX="$WORK/prefix"
SDK="$(xcrun --show-sdk-path)"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# 新版 clang 把老 autoconf 测试里的隐式声明当错误，这里是给上游打的补丁级开关
CFLAGS_COMPAT="-O2 -Wno-implicit-function-declaration -Wno-implicit-int -Wno-int-conversion -Wno-return-type"

mkdir -p "$WORK"
cd "$WORK"

fetch() { # url 文件名
  local url="$1" file="$2"
  [ -s "$file" ] && return 0
  echo "    下载 $(basename "$file")"
  curl -fsSL --retry 3 --max-time 1800 -o "$file" "$url"
}

echo "==> 1/6 OpenSSL（静态）"
if [ ! -f "$PREFIX/lib/libssl.a" ]; then
  fetch https://github.com/openssl/openssl/releases/download/openssl-3.0.16/openssl-3.0.16.tar.gz openssl.tar.gz
  [ -d openssl-3.0.16 ] || tar xzf openssl.tar.gz
  ( cd openssl-3.0.16 \
    && ./Configure darwin64-arm64-cc no-shared no-tests no-legacy --prefix="$PREFIX" --openssldir="$PREFIX/ssl" \
    && make -j"$JOBS" && make install_sw )
fi

echo "==> 2/6 Subversion 源码 + 官方依赖脚本"
if [ ! -d subversion-1.14.5 ]; then
  fetch https://archive.apache.org/dist/subversion/subversion-1.14.5.tar.bz2 svn.tar.bz2
  tar xjf svn.tar.bz2
fi
cd subversion-1.14.5
[ -d apr ] || ./get-deps.sh >/dev/null

echo "==> 3/6 APR / APR-Util（静态）"
if [ ! -f "$PREFIX/lib/libapr-1.a" ]; then
  ( cd apr && make distclean >/dev/null 2>&1 || true
    CFLAGS="$CFLAGS_COMPAT" ./configure --prefix="$PREFIX" --disable-shared --enable-static
    make -j"$JOBS" && make install )
fi
if [ ! -f "$PREFIX/lib/libaprutil-1.a" ]; then
  ( cd apr-util
    CFLAGS="$CFLAGS_COMPAT" ./configure --prefix="$PREFIX" --with-apr="$PREFIX" \
      --disable-shared --enable-static --without-berkeley-db --without-ldap \
      --without-pgsql --without-sqlite3 --without-mysql --without-oracle --without-odbc
    make -j"$JOBS" && make install )
fi

echo "==> 4/6 serf 1.3.10（静态，需要 scons）"
if [ ! -f "$PREFIX/lib/libserf-1.a" ]; then
  fetch https://archive.apache.org/dist/serf/serf-1.3.10.tar.bz2 serf.tar.bz2
  [ -d "$WORK/serf-1.3.10" ] || tar xjf serf.tar.bz2
  SCONS="$(command -v scons || true)"
  [ -n "$SCONS" ] || { python3 -m pip install --user scons; SCONS="$HOME/.local/bin/scons"; }
  ( cd "$WORK/serf-1.3.10" \
    && "$SCONS" PREFIX="$PREFIX" LIBDIR="$PREFIX/lib" \
         APR="$PREFIX" APU="$PREFIX" OPENSSL="$PREFIX" ZLIB="$SDK/usr" APR_STATIC=True install )
fi

echo "==> 5/6 utf8proc 2.8.0"
if [ ! -f "$PREFIX/lib/libutf8proc.a" ]; then
  fetch https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v2.8.0.tar.gz utf8proc.tar.gz
  [ -d utf8proc-2.8.0 ] || tar xzf utf8proc.tar.gz
  ( cd utf8proc-2.8.0 && make -j"$JOBS" && make install prefix="$PREFIX" )
fi

echo "==> 6/6 Subversion（静态链接上面这些）"
# serf/utf8proc 同时产出了 dylib，先挪开，强制 ld 选 .a
mkdir -p "$WORK/dylib-stash"
mv "$PREFIX"/lib/*.dylib "$WORK/dylib-stash"/ 2>/dev/null || true

LIBS="-lssl -lcrypto -liconv -lz" \
CFLAGS="$CFLAGS_COMPAT" \
CPPFLAGS="-I$PREFIX/include" \
LDFLAGS="-L$PREFIX/lib" \
./configure --prefix="$PREFIX" \
  --with-apr="$PREFIX" --with-apr-util="$PREFIX" --with-serf="$PREFIX" \
  --with-utf8proc="$PREFIX" --with-zlib="$SDK/usr" --with-lz4=internal \
  --without-apxs --without-berkeley-db --disable-nls --disable-shared --enable-static
make -j"$JOBS"

echo "==> 收集产物"
mkdir -p "$OUT_DIR/bin"
cp subversion/svn/svn "$OUT_DIR/bin/svn"
chmod +x "$OUT_DIR/bin/svn"
codesign --force --sign - "$OUT_DIR/bin/svn" >/dev/null 2>&1 || true
# 开发模式下也能持久化仓库凭据；正式 app 构建会重新编译到 Resources。
CREDENTIAL_HELPER="$(dirname "$OUT_DIR")/svn-credential-store"
swiftc -O -o "$CREDENTIAL_HELPER" "$ROOT/app/keychain-credentials.swift" \
  -sdk "$SDK" -target arm64-apple-macosx13.0 -framework Security
codesign --force --sign - "$CREDENTIAL_HELPER" >/dev/null 2>&1 || true

echo ""
echo "==> 完成：$OUT_DIR/bin/svn"
"$OUT_DIR/bin/svn" --version | head -2
echo "    动态依赖（应当只剩系统库）："
otool -L "$OUT_DIR/bin/svn" | tail -n +2 | awk '{print "      " $1}'
