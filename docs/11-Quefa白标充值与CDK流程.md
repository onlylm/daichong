# Quefa 白标充值与 CDK 流程

版本：v1（2026-09-26）

> 更新：以下“仅平台收款”“客户只在 Quefa 页提交凭据”为初版方案，已扩展为双模式和可授权代理自建兑换页。以第 15、16 份文档为准；代理须落实客户授权、凭据保护及客户级订单隔离。

## 1. 业务边界

本系统只销售充值服务，不向代理商或客户提供虚拟卡、卡池、供应商后台或供应商接口。对外只有 Quefa：

- 代理商负责展示商品、推广和创建订单；
- Quefa 使用自有支付通道收款；
- 客户只在 Quefa 页面提交充值凭据；
- Quefa 服务端对接供应能力并回传统一状态；
- 代理商赚取“销售价减 Quefa 供货价”的差价。

任何代理商响应、客户页面、Webhook、日志或错误信息都不得出现供应商域名、API Key、供应订单号、卡号或原始兑换码。

## 2. 直接充值

```text
客户 → 代理商商城：选择 direct 商品
代理商服务端 → Quefa：创建订单
客户 → Quefa：完成付款
代理商商城 → 客户：打开 fulfillment_url
客户 → Quefa：提交 Session / Access Token / 邮箱凭据
Quefa → 供应服务：服务端预检、下单、轮询
Quefa → 客户与代理商：只返回 queued/running/succeeded/failed
```

凭据进入 Quefa 后使用 AES-256-GCM 加密，充值进入明确终态后清除密文、IV 与认证标签。代理商无需、也不应接触凭据。

## 3. Quefa CDK

```text
客户 → 代理商商城：购买 cdk 商品
代理商服务端 → Quefa：创建订单
客户 → Quefa：完成付款
Quefa Worker：签发并加密保存底层兑换凭证
Quefa → 代理商/客户：只交付 QF-xxxxx-xxxxx-xxxxx-xxxxx
客户 → Quefa /redeem：提交 QF 码与充值凭据
Quefa → 供应服务：解密底层凭证并完成兑换
Quefa：成功后清除底层凭证，QF 码变为 consumed
```

`QF-` 码是 Quefa 自有的一次性兑换凭证，不是对底层卡密的改前缀展示。两者通过服务端加密映射；客户端永远拿不到原始值。

## 4. 代理商实现要求

1. 服务端保管 `client_secret` 并签名调用 `/v1` 接口。
2. 浏览器展示 `qr_payload` 对应的 Quefa 付款页。
3. 只以查单或验签 Webhook 判断付款成功。
4. 付款成功后打开 `fulfillment_url`；不要在代理商页面收集 Session。
5. `direct` 商品等待充值结果；`cdk` 商品等待 `voucher_code` 或 `cdk.issued`。
6. Webhook 必须验签并按 `event_id` 幂等处理。

## 5. 服务端保密要求

- 供应商 API Key、Webhook 密钥仅通过 Secret Manager/KMS 注入；
- 出站请求只允许 API/Worker 访问供应域名，浏览器 CSP 仅允许连接 Quefa 自身；
- 敏感请求体、充值凭据、底层码和签名头必须日志脱敏；
- 对外失败码统一为 Quefa 业务码，不透传供应商错误正文；
- 对外 Webhook 重新使用 Quefa 独立密钥签名，不转发供应商原始事件；
- 生产使用 PostgreSQL 行锁/唯一约束保证 QF 码只兑换一次，并按供应事件 ID 持久化去重。

供应方回调统一配置到 `https://<Quefa API 域名>/internal/webhooks/recharge`。该地址先用原始请求体验签，再将事件 ID 与请求摘要持久化；处理完成的重复事件直接返回 204，事件 ID 相同但内容不同则拒绝。

## 6. 当前可验收与上线缺口

当前沙箱已实现 direct、QF CDK、加密存储、异步 Worker、状态查询、Webhook 和模拟供应服务，并提供真实供应适配器代码。正式上线前仍需完成：

- 使用供应方沙箱凭证验证真实预检、下单、发码、兑换、轮询与回调；
- 确认固定出口 IP，保证一次 CDK 兑换全程使用同一出口和设备标识；
- 将 SQLite 沙箱仓储替换为 PostgreSQL 生产仓储；
- 接入 Quefa 自有支付宝生产通道；
- 完成 KMS、限流、告警、备份恢复、压测和安全验收。
