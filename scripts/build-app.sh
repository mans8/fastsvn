#!/bin/bash
# 把 FastSVN 打成可双击运行的 .app
# 用法：bash scripts/build-app.sh
set -e
export LC_ALL=en_US.UTF-8

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="FastSVN"
BUILD="$ROOT/build"
APP="$BUILD/$APP_NAME.app"
SDK=$(xcrun --show-sdk-path)
NODE_BIN="$(command -v node)"

echo "==> 清理"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> 编译启动器"
swiftc -O \
  -o "$APP/Contents/MacOS/$APP_NAME" \
  "$ROOT/app/main.swift" \
  -sdk "$SDK" \
  -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit
echo "    $(ls -lh "$APP/Contents/MacOS/$APP_NAME" | awk '{print $5}')"

echo "==> 构建前端（React + Vite + BoardUI）"
# 网页 favicon 跟着品牌源走，避免换了 logo 忘了同步这一份
if [ -f "$ROOT/assets/brand/AppIcon.svg" ]; then
  mkdir -p "$ROOT/web/public"
  cp "$ROOT/assets/brand/AppIcon.svg" "$ROOT/web/public/favicon.svg"
fi
if [ ! -d "$ROOT/web/node_modules" ]; then
  echo "    web/node_modules 不存在，先安装依赖"
  (cd "$ROOT/web" && npm install --no-audit --no-fund >/dev/null)
fi
(cd "$ROOT/web" && npx vite build 2>&1 | tail -4 | sed 's/^/    /')

echo "==> 复制运行时与资源"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"
cp "$ROOT/server.js" "$APP/Contents/Resources/server.js"
# SVN 账号密码只持久化到 macOS Keychain，不落明文配置文件
swiftc -O \
  -o "$APP/Contents/Resources/svn-credential-store" \
  "$ROOT/app/keychain-credentials.swift" \
  -sdk "$SDK" -target arm64-apple-macosx13.0 -framework Security
chmod +x "$APP/Contents/Resources/svn-credential-store"
cp -R "$ROOT/lib" "$APP/Contents/Resources/lib"
# App 图标：品牌资产在 assets/brand/（SVG 是设计源，PNG 是 1024 位图，ICNS 是多尺寸）
# 有 .icns 就直接用；只有 PNG 时现场生成，换 logo 后重新构建即可生效
ICON_DIR="$ROOT/assets/brand"
if [ -f "$ICON_DIR/AppIcon.icns" ]; then
  cp "$ICON_DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
elif [ -f "$ICON_DIR/AppIcon.png" ]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$ICON_DIR/AppIcon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$ICON_DIR/AppIcon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
else
  echo "    警告：assets/brand 下没有 AppIcon.icns / AppIcon.png，应用将显示默认图标"
fi
# CA 根证书：内嵌 OpenSSL 靠它校验 https 仓库
cp -R "$ROOT/ca" "$APP/Contents/Resources/ca"
mkdir -p "$APP/Contents/Resources/web"
cp -R "$ROOT/web/dist" "$APP/Contents/Resources/web/dist"
mkdir -p "$APP/Contents/Resources/data"

echo "==> 内嵌 svn 引擎"
# 优先用官方源码自建的（native/svn/bin/svn，静态、可商用分发）；
# 没有就退回机器上装的 svn，方便只改前端的日常构建。
SVN_BIN="$ROOT/native/svn/bin/svn"
if [ ! -x "$SVN_BIN" ]; then
  SVN_BIN="$(command -v svn || true)"
  [ -n "$SVN_BIN" ] && echo "    native/svn 不存在，暂用系统 svn：$SVN_BIN"
fi
if [ -z "$SVN_BIN" ]; then
  echo "    没找到 svn，跳过（应用会回退到系统 svn）"
else
  bash "$ROOT/scripts/bundle-svn.sh" "$SVN_BIN" "$APP/Contents/Resources/svn" | sed 's/^/    /'
fi

echo "==> 写 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>FastSVN</string>
  <key>CFBundleIdentifier</key><string>com.fastsvn.app</string>
  <key>CFBundleName</key><string>FastSVN</string>
  <key>CFBundleDisplayName</key><string>FastSVN</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.6.27</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> 签名（ad-hoc）"
codesign --force --deep --sign - "$APP" 2>&1 | sed 's/^/    /' || echo "    签名失败（可忽略，本机运行不受影响）"

SIZE=$(du -sh "$APP" | awk '{print $1}')
echo ""
echo "==> 完成：$APP（$SIZE）"
echo "    双击打开，或运行：open \"$APP\""
echo "    日志：~/Library/Logs/FastSVN.log"
