# 代理商自有品牌商城与自动直充接入指南

版本：2026-10-02（文档校准，生产能力以已部署版本及代理授权为准）
对象：使用本平台后端、开发自有品牌网站的代理商

## 1. 你要实现的客户体验

本指南只适用于选择 API 自建品牌商城的代理商；不开发网站的代理商可以直接使用 Quefa 代理工作台，不需要完成本指南。自建模式下平台提供后端能力，不接管你的品牌前端。推荐体验是：

1. 客户在你的商城选择 GPT 套餐。
2. 你的站点收集联系邮箱并创建本站订单。
3. 客户在你的站点付款；付款结果由你的后端验签或向平台查单确认。
4. 你的订单链接显示“提交 Session / Access Token”。
5. 客户主动确认账号并提交，页面显示“待提交、处理中、成功或失败”。
6. 成功后展示脱敏账号、完成时间和售后入口。
7. 明确失败且 `retry_allowed=true` 后仍留在你的订单链接，允许客户按提示重新提交；不显示平台品牌，不展示明文 CDK。

页面域名、Logo、文案、客服、订单链接和用户鉴权都由代理商负责。正确拓扑：

```text
客户浏览器 → 代理商前端 → 代理商后端 → 平台 /v1 API → CDK 供应与兑换
```

浏览器不能直接调用平台签名 API，也不能持有 `client_secret`。

## 2. 两种交付方式

正式商品仅为 Plus、Pro 5x、Pro 20x、Pro 50x，底层均为 CDK；可售状态、供货价与授权以 `GET /v1/products` 为准。固定 1 元的 `POST /v1/payment-tests` 是独立纯支付联调用途，不是第五款套餐，不进入 CDK 或上游履约。代理商创建正式订单时显式选择：

### 2.1 直接交付 CDK

请求传 `delivery_mode=cdk`。付款或采购扣款确认后，轮询订单或接收 `cdk.issued`；`voucher_code` 就绪后交给客户。它是代理配置的品牌公开号，必须作为不透明字符串完整保存和传递，不得假定固定前缀、分组或分隔符；上游原始卡密不返回。

### 2.2 自动直充

请求传 `delivery_mode=auto_recharge`。平台领取并绑定 CDK，但不向代理商浏览器、订单 API或 Webhook 返回明文码。客户在你的订单页提交凭据，你的后端用 `order_id` 调用自动直充接口。

仅上游明确失败且允许重提后，查询最近任务返回：

```json
{"fallback_recharge_available": true, "retry_allowed": true, "next_action": "resubmit"}
```

含义是“你的订单页可以再次展示充值输入框”，不是“显示 CDK”，也不是“跳到平台页面”。重新提交前让客户核对账号和失败原因，并使用新的业务幂等键；原订单不重复扣款。

## 3. 创建订单

先调用 `GET /v1/products`，只展示 `available=true` 的商品，并读取 `delivery_modes`。创建订单：

```http
POST /v1/orders
Idempotency-Key: order:SHOP-20260928-0001
```

```json
{
  "merchant_order_no": "SHOP-20260928-0001",
  "product_code": "chatgpt_plus_cdk_1m",
  "quantity": 1,
  "sale_amount": "168.00",
  "collection_mode": "agent_collect",
  "delivery_mode": "auto_recharge",
  "metadata": {"local_user_id": "u_1024"}
}
```

`collection_mode=agent_collect` 表示代理商自己收客户零售款，平台立即从采购余额扣供货价；`paid` 只证明采购款已扣，不证明客户已向代理付款。`platform_collect` 表示使用平台支付通道，必须以平台查单/Webhook 确认付款。

请在代理数据库保存：

```text
本站订单号 ↔ 平台 order_id ↔ 本站用户 ↔ delivery_mode ↔ 当前 redemption_id
```

不要把 Session、Token 或邮箱密码放入订单 `metadata`。

### 3.1 在自己的页面展示付款码

平台按代理开通直出付款码后，代理后端用 HMAC 签名和 `Idempotency-Key` 调用 `POST /v1/orders/{order_id}/payment-code`，请求体固定为 `{}`。返回 `payment_code` 及 `qr_image_data_url`，代理后端将图片数据转交自己的前端，或使用付款码在本地绘码；买家浏览器不直连平台或第三方绘码服务。

未开通返回 `403 direct_payment_code_disabled`。金额、币种、有效期及收款配置只取服务端原订单，不接受请求覆盖。同键重放及首次返回前都会复验待付款状态、有效期和代理直出码开关，旧码不能绕过已付、到期或停用状态。旧 `qr_payload` 仍为平台付款页链接，不是实际支付宝付款码。字段与示例见 [支付通道接入](/developers/doc/payment-channels)。付款确认后再开放下面的充值入口，不能把取码成功当作到账。

## 4. 自动直充接口

客户在你的订单页主动确认账号后，由你的后端调用：

```http
POST /v1/redemptions
Idempotency-Key: recharge:SHOP-20260928-0001:attempt-1
```

```json
{
  "mode": "auto_recharge",
  "order_id": "ord_example",
  "credential": {
    "mode": "session",
    "session": "<客户本次授权的完整 Session JSON>"
  },
  "customer_confirmed_email": true
}
```

凭据类型三选一：

```json
{"mode":"session","session":"..."}
{"mode":"access_token","access_token":"..."}
{"mode":"mailbox","email":"buyer@example.com","password":"..."}
```

HTTP 202 与 `status=queued` 仅表示受理。保存 `redemption_id`，不要显示成功，也不要重复创建订单。

## 5. 状态页实现

你的前端只访问你自己的状态接口；你的后端签名调用：

```http
GET /v1/redemptions/{redemption_id}
```

建议页面状态映射：

| API 状态 | 你的页面 |
|---|---|
| `queued` | 已提交，等待处理 |
| `running` | 正在核对或执行充值；可刷新查进度，但不可取消或重复提交 |
| `succeeded` | 已完成，展示脱敏账号与完成时间 |
| `failed` | 展示白标错误提示；仅最新任务 retry_allowed=true 才显示“重新提交资料”按钮 |
| `cancelled` | 任务确认取消；不能仅凭取消标签自行重提，必须检查最新任务 retry_allowed 与平台处理选择 |

示例终态：

```json
{
  "data": {
    "redemption_id": "ful_example",
    "order_id": "ord_example",
    "fulfillment_mode": "cdk",
    "status": "failed",
    "failure_code": "session_invalid",
    "message": "登录凭据已失效，请重新登录后提交",
    "account_email_masked": "b***@example.com",
    "fallback_recharge_available": true,
    "retry_allowed": true,
    "next_action": "resubmit",
    "created_at": "2026-09-28T10:00:00.000Z",
    "finished_at": "2026-09-28T10:01:10.000Z"
  }
}
```

前 2 分钟可每 3–5 秒查询，之后退避到 15–30 秒。订阅 `fulfillment.updated` 获取阶段变化，`fulfillment.succeeded/failed/cancelled` 获取终态；通知必须先验签、按 `event_id` 去重，再签名查当前任务确认。

### 5.1 把进度和失败原因同步到你的页面

你的后端应保存当前任务号，持续同步安全业务反馈，而不是只保存“已提交”。`status/message/failure_code/retry_allowed/next_action` 是基础反馈字段；细分 `result_code/result_stage` 当前需平台按代理开放，没有返回时显示基础状态。

`error_category` 提供脱敏业务分类（`credential/account/product/resource/service/confirmation/unknown` 或 null），不能替代任务终态或重提授权。未知新错误、超时、无效响应均不能当作可重提失败；必须继续查询原任务。平台选择退款后的失败／取消任务，查询和回调统一给 `next_action=none`、`retry_allowed=false`；展示退款处理入口，不能重新开放充值表单，也不能据此宣称已经退款到账。

已返回的阶段可显示为“验证登录资料”“准备充值资源”“安排充值”“结果确认中”。`plus_paid` 表示升级仍在进行，`review/pending/requires_action` 不代表失败或成功；没有验证链接字段时不要自行拼接上游入口。不得模拟百分比或预计完成时间。

本版本支持 `fulfillment.updated` 进度推送，平台部署同版后生效。通知和查询都带 `attempt_no/progress_stage/progress_version/progress_updated_at/recovery_action`；统一公开阶段不需要开放上游敏感字段。回调需订阅该事件或 `*`。相同状态轮询不会重复通知；同任务按版本去旧，原订单按尝试序号去旧。

一次查询失败保留最近状态，并提示“进度暂未更新，正在核对原任务”。页面应允许随时手动刷新，但刷新仍查询原订单或原任务，不能重新开单。按任务合并查询并退避，Webhook 作为加速、查询作为兜底。所有通知验签、去重并入库后快速返回，再由后端查询该订单的当前尝试，防止旧通知把新尝试改回失败。

失败页展示安全原因、本站订单号和下一步动作。只有最近尝试允许重提、自动直充恢复标记为 true，原单无退款锁定且仍可履约，才显示“重新提交资料”并链接到你自己的品牌订单页；不显示 CDK。原订单号不变，新尝试使用新幂等键，网络重传使用原键。

邮箱模式也必须经过真实登录预检。`mailbox_login_failed` 表示邮箱登录失败，不是服务繁忙；请提示检查邮箱和密码，或切换 Session / Access Token。已受理的任务只有明确失败并返回可重提标志后，才能在原订单重提。全额退款后的未派发任务关闭并返回 `next_action=none`，不得继续显示排队或重新开放充值入口。

平台管理员取消尚未派发的任务后也可开放此入口，不重新收费；如果平台选择退款，入口关闭。平台代收退客户原付款，代理自收采购退采购余额。已派发或结果未知时，不能本地强制取消后重提或退款，代理也不能主动取消。

代理工作台保留平台订单号、任务号和 `X-Request-Id` 便于联系平台，客户页面只展示本站客服与本站订单信息。通知、工单和错误监控不得包含 Session、密码、密钥、上游原始码和原始错误体。

### 5.2 按示例实现重提和取消后的反馈

自动直充最近尝试明确失败且 `retry_allowed=true`、`next_action=resubmit`、`fallback_recharge_available=true` 时，客户在你自己的品牌页修正资料。你的后端仍调用 `POST /v1/redemptions`，请求 `mode=auto_recharge`、原 `order_id`、新的本次授权凭据及 `customer_confirmed_email=true`；使用例如 `recharge:SHOP-20260930-0001:attempt-2` 的新幂等键。保存返回的新任务号与尝试序号，不另建订单、不再次收款、不展示 CDK。

平台选择 `recovery_action=retry` 后，只有上述条件均满足才开放本站恢复入口。平台选择 `recovery_action=refund` 后关闭入口，提示退款处理中；收到 `refund.succeeded` 并核对退款单才显示到账完成。`procurement.refunded` 仅代表代理采购余额退回，不代表代理客户的零售款已退款。代理不调用平台管理员的取消或退款执行接口。

完整的 Webhook JSON、验签接收步骤、查询路径、二次提交正文和分流表见 [开放平台接入文档第 7.5 节](https://tibo.ink/developers/doc/integration)。已有回调若仅订阅终态，请新增 `fulfillment.updated` 或使用 `*`；通知不保证严格顺序，按订单尝试号和任务进度版本处理，必要时查询当前尝试。

## 6. 直接 CDK 模式

创建订单时使用 `delivery_mode=cdk`。订单付款后，`GET /v1/orders/{id}` 的 `voucher_code` 由空变为代理品牌公开号；也会收到 `cdk.issued`。

自动直充订单的 `voucher_code` 永远是 `null`，失败后也不会泄露 CDK。不要依赖、抓取或展示上游原始码。

代理主账号可在合作设置选择 2–8 位品牌前缀，并配置受控模板，例如 `{PREFIX}_{RANDOM:10}-{RANDOM:10}`。模板必须且只能包含一个 `{PREFIX}`；每个随机段为 4–12 位，随机位合计至少 20 位。变更只作用于新签发码，历史码继续有效。接入方应把接口返回的完整 `voucher_code` 当作不透明字符串处理，不能硬编码前缀、分组或分隔符。

如你允许客户在自有页面手工输入已购买的公开号，可调用：

```json
{
  "mode": "cdk",
  "code": "SHOP-A1B2C-D3E4F-56789-ABCDE",
  "credential": {"mode":"session","session":"..."},
  "customer_confirmed_email": true
}
```

## 7. 签名与幂等

每个请求发送：`X-Partner-Id`、`X-Key-Id`、`X-Timestamp`、`X-Nonce`、`X-Signature`。写请求还必须发送 `Idempotency-Key`。

签名原文为八行：

```text
METHOD
PATH
CANONICAL_QUERY
TIMESTAMP
NONCE
KEY_ID
IDEMPOTENCY_KEY
SHA256_HEX(RAW_BODY)
```

使用 `client_secret` 做 HMAC-SHA256，输出小写十六进制。JSON 只序列化一次，签名和发送必须使用完全相同的字节。网络超时后更新时间戳和 Nonce，保留原幂等键与原请求体；同键不同内容会返回 409。

完整字段以 `/developers/openapi.yaml` 为准。

## 8. Session 页面建议

可以参照成熟品牌站的体验，但使用自己的品牌：

- 下单前只收联系邮箱，用于发送随机订单链接。
- 付款确认后才显示 Session 输入区。
- 页面解释如何从 `https://chatgpt.com/api/auth/session` 取得完整 JSON。
- Session 输入框禁止第三方埋点、录屏、自动补全和日志采集。
- 提交后立即清空浏览器中的原始凭据，只保留任务号。
- 订单链接必须是高熵随机能力令牌，并绑定本站用户或邮箱验证，不能只靠平台 `order_id` 授权。
- 处理页展示阶段进度，但 `queued/running/review` 都不能显示成功。
- 最终成功显示脱敏账号、完成时间、复制本站订单号和联系本站客服。
- 失败显示平台白标 `message`；最新任务 `retry_allowed=true` 且 `next_action=resubmit` 时展示你自己的“重新提交”入口。超时和未知状态继续查询，不代表失败。

## 9. 安全硬规则

1. `client_secret` 和 Webhook 密钥只放代理后端秘密配置。
2. Session/Token/邮箱密码不得写日志、数据库明文字段、客服工单、错误监控或前端分析工具。
3. 代理后端必须验证本站客户对本站订单的所有权，再映射平台 `order_id`。
4. 不把供货价、平台内部订单、上游身份、上游订单号或原始错误体返回客户。
5. 只有 `succeeded` 才显示成功；HTTP 202、跳转返回和浏览器自报付款都不算成功。
6. 状态未知先查原任务；不要自动创建新订单、重新扣款或使用新幂等键盲重试。
7. 自动直充失败不返回 CDK。仅上游明确失败且最新任务允许重提时，才在代理商自有订单页重新提交；不能主动取消进行中任务。

## 10. 上线验收

- 商品目录只显示授权且启用的 GPT 商品。
- 两种 `delivery_mode` 都完成一笔沙箱订单。
- 自动直充全程看不到明文 CDK。
- 上游明确拒绝失效 Session 后返回 `retry_allowed=true`，页面回到自有输入入口；超时或未知状态仍禁止重提。
- 同幂等键重试只产生一个任务；同键不同内容被拒绝。
- 页面刷新、换设备和代理商自有订单链接都能恢复任务状态；平台不发送邮件。
- Webhook 验签、去重、乱序处理和主动查单通过。
- 浏览器网络面板、前端源码、日志和监控中没有 API 密钥或充值凭据。
- 成功、失败、取消、超时、上游暂不可用和售后入口均有明确页面状态。
