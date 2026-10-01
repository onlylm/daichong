# 代理商完整联调示例

本示例同时包含代理商自有商城前端、代理商服务端签名代理和 Webhook 接收器。`client_secret` 只存在 Node.js 服务端，浏览器无法读取。

示例采用当前推荐链路：

1. 代理后端创建 `delivery_mode=auto_recharge` 的平台收款订单；
2. 代理后端调用 `/v1/orders/{order_id}/payment-code`，只把本地二维码图片数据交给自己的页面；
3. 买家始终在代理商页面扫码、查付款状态和提交充值资料，不跳转平台页面；
4. 代理后端调用 `mode=auto_recharge` 的 `/v1/redemptions` 并把安全进度返回自有页面；
5. 原始订单返回中的供货价、代理利润、平台 URL、内部任务编号和签名密钥均不透传给浏览器。

启动 Quefa 沙箱后，在另一个终端运行：

```powershell
$env:QUEFA_BASE_URL='http://127.0.0.1:3200'
$env:QUEFA_PARTNER_ID='pt_demo_a'
$env:QUEFA_KEY_ID='key_demo_a_01'
$env:QUEFA_CLIENT_SECRET='replace-with-demo-secret-at-least-32-chars'
$env:QUEFA_WEBHOOK_SECRET='replace-demo-webhook-secret'
$env:QUEFA_REGISTERED_WEBHOOK_URL='http://host.docker.internal:3300/webhooks/quefa'
$env:PARTNER_DEMO_BIND='0.0.0.0' # 仅供本机 Docker 回调；不要暴露公网
$env:PARTNER_DEMO_ALLOW_MOCK_PAY='true' # 仅限本机模拟 API
node examples/partner-demo/server.mjs
```

浏览器打开 `http://127.0.0.1:3300`，依次创建订单、在当前页面显示付款码、确认付款、查询支付、提交自动直充并查看 Webhook。

使用支付宝沙箱付款码时，管理员需先为该测试应用开启“后端直出付款码”，并配置可用的支付宝沙箱通道。若应用未开启，取码接口会返回 `direct_payment_code_disabled`；不要退回到把客户跳转平台页的旧实现。默认本地 Mock 环境可显式设置 `PARTNER_DEMO_ALLOW_MOCK_PAY=true`，此时只显示代理页面内的“沙箱模拟付款”按钮；该开关仅在 `QUEFA_BASE_URL` 为本机 HTTP 地址时生效，不能用于生产。

若 Quefa API 不在 Docker 中运行，把 `.env` 和上述 `QUEFA_REGISTERED_WEBHOOK_URL` 同时改成 `http://127.0.0.1:3300/webhooks/quefa`，两端必须完全一致。

这只是联调样例。生产必须增加客户登录、订单归属校验、CSRF、防重放、数据库持久化、查询凭证过期、请求限速、告警和 HTTPS；充值凭据不得写日志或保存到代理数据库。
