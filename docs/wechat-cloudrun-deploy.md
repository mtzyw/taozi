# 桃子预售小程序：微信云托管部署说明

## 目标

小程序端通过 `wx.cloud.callContainer` 调用微信云托管服务，不再依赖「服务器域名」配置。

## 已改动

- 小程序请求层：`miniprogram/utils/backend.js`
  - `mode: 'cloudrun'` 时使用 `wx.cloud.callContainer`。
  - `mode: 'http'` 时保留本地 `wx.request + baseUrl` 调试。
- 小程序云环境初始化：`miniprogram/app.js`
- 云托管镜像配置：`Dockerfile`
- 容器启动命令：`npm run start`

## 你需要填写的配置

打开：`miniprogram/config/api.js`

```js
module.exports = {
  enabled: true,
  mode: 'cloudrun',
  cloudrun: {
    env: '你的云托管环境ID',
    serviceName: 'peach-presale-api'
  }
};
```

- `env`：微信云托管/云开发环境 ID。
- `serviceName`：云托管服务名，建议创建为 `peach-presale-api`。

## 云托管控制台部署步骤

1. 微信开发者工具或微信公众平台进入「云开发 / 云托管」。
2. 创建环境，记录环境 ID。
3. 创建服务，服务名建议：`peach-presale-api`。
4. 部署方式选择 Dockerfile / 代码构建。
5. 上传本项目根目录代码。
6. 端口填写：`3000`。
7. 启动命令使用 Dockerfile 默认命令即可：`npm run start`。
8. 部署成功后，在小程序里填写环境 ID，然后重新上传体验版。

## 重要限制

当前后端仍使用 SQLite，本地文件数据库在云托管容器里适合演示和体验；容器重启、扩容、重新部署时可能丢数据或数据不一致。正式运营建议下一步迁移到云数据库/MySQL。

商品图片建议使用云存储或稳定 HTTPS 图片地址。仅通过 `callContainer` 私有链路访问接口时，`/uploads/...` 这类相对图片路径不能直接给 `<image>` 使用。
