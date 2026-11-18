#!/bin/bash
# 制造一次真实的三方文本冲突：两个工作副本改同一行，先提交的一方胜出。
# 用时间戳保证两边内容必然不同，可重复执行。
set -e
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8
SVN=/opt/homebrew/bin/svn
REPO=${1:-/tmp/fastsvn-demo-repo}
WC=${2:-/tmp/fastsvn-demo-wc}
WC2=/tmp/fastsvn-demo-wc-other
STAMP=$(date +%s)

"$SVN" update -q "$WC"
rm -rf "$WC2"
"$SVN" checkout -q "file://$REPO/trunk" "$WC2"

python3 - "$WC2/web/js/checkout.js" "  return items.reduce((s, i) => s + i.price * i.qty, 0); // peer-$STAMP" <<'PY'
import re, sys
p, new = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s2, n = re.subn(r'  return items\.reduce\(.*\);[^\n]*\n', new + '\n', s, count=1)
assert n == 1, '对方版本替换失败'
open(p, 'w', encoding='utf-8').write(s2)
PY
"$SVN" commit -q "$WC2" -m "peer change: total by quantity ($STAMP)"

python3 - "$WC/web/js/checkout.js" "  return items.reduce((s, i) => s + i.price * 2, 0); // mine-$STAMP" <<'PY'
import re, sys
p, new = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s2, n = re.subn(r'  return items\.reduce\(.*\);[^\n]*\n', new + '\n', s, count=1)
assert n == 1, '本地版本替换失败'
open(p, 'w', encoding='utf-8').write(s2)
PY

echo "--- 准备完成（stamp=$STAMP）---"
