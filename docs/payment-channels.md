# 代理商支付通道接入

代理只调用 Quefa 接口，不需要也不能提交平台支付密钥。本指南不改变 API 开通、签名和租户隔离要求。

## 查询可用方式

使用现有 HMAC 认证调用 GET /v1/payment-methods：

```json
{"data":[{"code":"alipay","name":"支付宝"},{"code":"usdt","name":"USDT"}]}
```

只返回平台当前开放的方式。全部关闭或纯模拟模式可能返回空数组；余额采购不依赖此列表。

## 平台代收下单

```json
{
  "merchant_order_no":"your-order-001",
  "product_code":"chatgpt_plus_cdk_1m",
  "quantity":1,
  "sale_amount":"135.00",
  "collection_mode":"platform_collect",
  "payment_channel":"usdt"
}
```

POST /v1/orders，必须按现有规范携带签名和 Idempotency-Key。
payment_channel 可选 alipay / usdt；省略时使用当前首个可用通道，支付宝优先。为了确定性，建议先查询并显式选择。
sale_amount 始终为人民币元字符串，不能填 USDT 数量。旧接入继续把 `qr_payload` 视为 Quefa 付款链接，不能将它当作支付宝当面付二维码。

如需买家全程留在代理商页面，可由平台按代理开通后端直出码能力。代理后端签名调用 `POST /v1/orders/{order_id}/payment-code`，请求体只能为 `{}`，平台返回实际 `payment_code` 及本地生成的 `qr_image_data_url`。金额、有效期和支付配置全部取原订单，不能在取码请求中覆盖。代理前端只请求自己的后端；不得把平台 API 密钥放进浏览器，也不得让买家浏览器请求平台或第三方绘码网站。该新接口不改变 `qr_payload` 的旧含义。

一笔订单锁定一个支付通道，不提供原单切换。不要因超时换订单号重试；先查原单。相同幂等键必须对应相同原始请求体，改变支付通道视为冲突。
选定的通道关闭时新请求会被拒绝；不要在未经客户确认的情况下另建订单以更换支付方式。

## 到账后

客户在 Quefa 收银台支付并等待服务端核对。以 GET /v1/orders/{order_id} 和验签后的 order.paid 通知为依据，不能用浏览器跳转、截图、交易哈希提交或客户口述判断已付。
CDK 商品等待 voucher_code 或 cdk.issued 通知；直充商品可引导至 fulfillment_url，或按已有自建兑换指南调用。付款成功不等于充值完成，仍须看充值任务状态。

## 代理自收款

collection_mode=agent_collect 时，不传 payment_channel。
客户付款由代理自己的支付系统处理，Quefa 仅按供货价扣代理采购余额；平台收款开关不影响这类采购。
该模式的 paid 只代表采购余额扣款成功，不证明客户已经向代理支付。

## 常见异常

- payment_channel_disabled：通道未开启或已关闭。
- merchant_order_conflict / idempotency_conflict：同一订单号/幂等键被用于不同参数。
- payment_query_pending：支付核验暂未完成，等待原单查询，不重复付款。
- 实单白名单或累计限额错误：联系平台，不创建更多订单绕过限额。

平台收款关闭不等于取消已发起付款，也不等于退款。已发起的付款仍核对原订单；如金额、链或付款窗口有异常，请提交工单并保留转账记录。
