#!/bin/bash
# 建一个本地 SVN 测试仓库 + 工作副本，并故意制造多种变更状态，用于端到端验证。
set -e

SVNADMIN=/opt/homebrew/bin/svnadmin
SVN=/opt/homebrew/bin/svn
REPO=${1:-/tmp/fastsvn-demo-repo}
WC=${2:-/tmp/fastsvn-demo-wc}

rm -rf "$REPO" "$WC"
"$SVNADMIN" create "$REPO"
"$SVN" mkdir -m "初始化 trunk" "file://$REPO/trunk"
"$SVN" checkout -q "file://$REPO/trunk" "$WC"

cd "$WC"
mkdir -p src/main/java/com/acme/order src/main/resources src/test/java/com/acme/order web/js docs assets/brand

cat > src/main/java/com/acme/order/OrderService.java <<'EOF'
package com.acme.order;

public class OrderService {

    private final OrderMapper orderMapper;
    private final InventoryService inventoryService;

    public OrderService(OrderMapper orderMapper, InventoryService inventoryService) {
        this.orderMapper = orderMapper;
        this.inventoryService = inventoryService;
    }

    public OrderResult submit(OrderRequest req) {
        validate(req);
        Order order = orderMapper.find(req.getOrderId());
        if (order == null) {
            throw new BizException("ORDER_NOT_FOUND");
        }
        return orderMapper.save(order);
    }

    private void validate(OrderRequest req) {
        if (req.getQty() <= 0) {
            throw new BizException("INVALID_QTY");
        }
    }
}
EOF

cat > src/main/resources/application-prod.yml <<'EOF'
server:
  port: 8080

spring:
  datasource:
    url: jdbc:mysql://db-prod:3306/order
    username: order_app
    max-pool-size: 20
    timeout: 3000
EOF

cat > web/js/checkout.js <<'EOF'
function total(items) {
  const n = items.length;
  return items.reduce((s, i) => s + i.price, 0);
}

function render(cart) {
  document.querySelector('.total').textContent = total(cart.items);
}
EOF

cat > docs/接口说明.md <<'EOF'
# 订单接口

## 下单

调用 /api/order 即可。

## 查询

GET /api/order/{id}
EOF

printf 'FastSVN demo logo\n' > assets/brand/logo.txt
printf '*.log\nbuild/\n' > .gitignore

"$SVN" add -q --force . >/dev/null
"$SVN" commit -q -m "初始导入：订单服务与前端"

# 形成一条可读的历史（让日志视图有内容）
cat > README.md <<'EOF'
# 支付网关

内部支付网关服务，Java 17 + Spring Boot 3。

## 本地启动

./gradlew bootRun
EOF
"$SVN" add -q README.md
"$SVN" commit -q -m "补充 README 与本地启动说明"

# ---------- 制造变更 ----------

# 1. 修改（并发相关）
python3 - <<'PY'
import io
p = 'src/main/java/com/acme/order/OrderService.java'
s = open(p, encoding='utf-8').read()
s = s.replace(
"""        Order order = orderMapper.find(req.getOrderId());
        if (order == null) {
            throw new BizException("ORDER_NOT_FOUND");
        }
        return orderMapper.save(order);""",
"""        Order order = orderMapper.findForUpdate(req.getOrderId());
        if (order == null) {
            throw new BizException("ORDER_NOT_FOUND", req.getOrderId());
        }
        // 锁定库存，避免并发超卖
        inventoryService.lock(order);
        return orderMapper.save(order);""")
open(p, 'w', encoding='utf-8').write(s)
PY

# 2. 修改配置文件（带敏感项）
python3 - <<'PY'
p = 'src/main/resources/application-prod.yml'
s = open(p, encoding='utf-8').read()
s = s.replace('max-pool-size: 20', 'max-pool-size: 48')
s = s.replace('    timeout: 3000', '    secret-key: "sk_live_9f2c8a1d"\n    timeout: 3000')
open(p, 'w', encoding='utf-8').write(s)
PY

# 3. 修改前端脚本
cat >> web/js/checkout.js <<'EOF'

// 折扣券在结算前统一计算
function applyCoupon(cart, coupon) {
  if (!coupon) return cart;
  return { ...cart, discount: coupon.value };
}
EOF

# 4. 新增文件
cat > src/test/java/com/acme/order/OrderServiceTest.java <<'EOF'
package com.acme.order;

import org.junit.jupiter.api.Test;

class OrderServiceTest {

    @Test
    void should_lock_inventory_when_submit() {
        var req = OrderRequest.of("SKU-1", 2);
        var res = orderService.submit(req);
        assertThat(res.status()).isEqualTo(PAID);
    }
}
EOF

# 5. 中文文件名新增
cat > docs/接口说明-补充.md <<'EOF'
# 补充说明

并发下单时会锁定库存，失败返回 409。
EOF

# 6. 删除一个文件
rm assets/brand/logo.txt

# 7. 未纳入版本控制 + 敏感文件
printf 'DB_PASSWORD=root\nAPI_TOKEN=abc123\n' > .env.local
printf 'some build output\n' > build.log

# 8. 中文文件名的改动（验证 NFC/NFD）
printf '\n## 变更记录\n\n- 增加库存锁定\n' >> docs/接口说明.md

"$SVN" add -q src/test/java/com/acme/order/OrderServiceTest.java "docs/接口说明-补充.md" 2>/dev/null || true
"$SVN" propset -q svn:ignore '*.log' . 2>/dev/null || true

echo "----------------------------------------"
echo "仓库：$REPO"
echo "工作副本：$WC"
"$SVN" status "$WC"
