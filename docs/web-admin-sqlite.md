# 桃子预售网页管理后台（SQLite 本地版）

## 启动方式

```bash
npm run admin:init
npm run admin:start
```

如果要启用网页后台登录保护，启动时设置本地环境变量：

```bash
PEACH_ADMIN_PASSWORD='你的后台密码' npm run admin:start
```

未设置 `PEACH_ADMIN_PASSWORD` 时为本地开发模式，后台 API 不要求登录。

启动后打开：

```text
http://localhost:3000
```

默认数据库文件：

```text
admin-web/data/peach-admin.sqlite
```

该文件已加入 `.gitignore`，不会提交到代码仓库。

商品图片上传目录：

```text
admin-web/uploads/
```

网页后台选择图片后会上传到本地服务器，并把商品主图保存为：

```text
/uploads/product-xxxx.png
```

上传图片同样已加入 `.gitignore`，避免把本地经营素材误提交到代码仓库。小程序联调时，后台 API 会把 `/uploads/...` 转换为 `http://127.0.0.1:3000/uploads/...` 供图片组件加载。

## 当前能力

- 商品新增、编辑、上下架、删除
- 商品主图本地上传，支持 PNG/JPG/WEBP，最大 5MB
- 商品图册和商品详情/预售规则维护
- 盒装/袋装独立库存
- 预售批次、采摘时间、履约时间、截单时间
- 自提点新增、编辑、启停、删除
- 运费、满额包邮、自提服务费配置
- 运营看板：销售额、待支付、待发货、待自提、低库存、优惠码抵扣、热卖商品、自提点分布
- 小程序下单由服务端权威计算：商品价、白名单折扣、优惠码、运费、实付金额
- 支持待支付订单锁库存，超时后可在后台释放库存
- 支付成功后服务端扣减/确认库存，并写入库存流水
- 订单履约状态接口：发货、自提、完成、售后、退款、取消；取消/退款会自动回补库存且只回补一次
- 自提核销：后台输入核销码即可把订单标记为已自提
- 优惠码后台管理：新增、启停、删除、使用次数、每手机号限制、使用金额追踪
- 订单打印：网页后台可按当前筛选结果调用浏览器打印
- 订单导出：当前筛选结果可导出 CSV，Excel 可直接打开
- 售后基础流程：买家端申请售后，后台处理售后/退款状态
- 服务端地址簿：小程序优先读取/保存 SQLite 地址，失败时回退本地
- 操作日志：记录后台商品、白名单、优惠码、订单处理等关键操作
- SQLite 表：products、product_skus、pickup_points、shipping_rules、orders、order_items、fulfillment_logs、whitelist_entries、coupons、coupon_usages、inventory_movements、addresses、operation_logs

## 小程序管理员入口

小程序端已经关闭管理员入口，`app.json` 不再注册 `pages/admin/admin`，个人中心不再显示管理员登录。

## 后续建议

当前小程序买家端仍然使用本地 mock store。下一阶段建议把小程序商品、下单、订单列表逐步改为请求本地/云端 API，这样买家端和网页后台就会共享同一份 SQLite/后端数据。

## 小程序买家端联调

小程序已新增 API 客户端：

```text
miniprogram/config/api.js
miniprogram/utils/backend.js
```

默认请求：

```text
http://127.0.0.1:3000
```

已接入页面：

- 首页商品列表
- 商品列表页
- 商品详情页
- 结算页自提点/运费/下单
- 支付成功页
- 我的订单
- 订单详情
- 个人中心订单统计

如果网页后台没有启动，小程序会自动回退到原本本地 mock 数据。

在微信开发者工具本地联调时，需要允许开发环境请求本地 HTTP 地址；如遇到请求失败，请在开发者工具里勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”。
