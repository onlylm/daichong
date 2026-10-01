# 停止 USDT 新交易说明

平台当前只经营 Plus、Pro 5x、Pro 20x、Pro 50x 四个充值套餐，平台代收只保留支付宝。

本次收口同时覆盖代理 Open API、代理后台下单、支付设置页面、公开收银路由和 Worker：

- `/v1/payment-methods` 只可能返回 `alipay`；
- 创建订单传入 `payment_channel=usdt` 会被参数校验拒绝；
- 代理后台下单不再接受 USDT 支付方式；
- 支付设置只展示和修改支付宝；
- `/usdt-payments/*` 与 DujiaoPay 回调路由不再注册；
- Worker 不再启动 USDT 支付任务通道。

历史数据类型和已有数据库记录没有删除，便于审计追溯；但它们不再形成新的支付入口，也不会在后台作为可配置产品出现。部署前若生产库存在未完结的历史 USDT 支付，必须先单独列单核对，不能依赖停用后的 Worker 自动处理。
