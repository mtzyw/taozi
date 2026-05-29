# Kie GPT Image 2 配图工作流

本项目使用 Kie `gpt-image-2-text-to-image` 接口在**开发期**生成配图，然后把图片保存到小程序本地资源目录。

## 为什么不在小程序前端直接调 Kie

微信小程序前端包会暴露代码和请求逻辑，不能放 API Key。Kie Key 只能在本地脚本、后端服务或云函数里使用。

## 生成图片

```bash
KIE_API_KEY="你的 Kie Key" npm run image:generate -- \
  --name hero-cover \
  --title "首页展示图" \
  --aspect-ratio 16:9 \
  --prompt "A clean pastel mini program hero illustration, phone UI showcase frame, soft light, no text"
```

生成完成后会写入：

- `miniprogram/assets/images/generated/<name>.<ext>`
- `miniprogram/utils/generated-images.js`

首页会自动读取 `generated-images.js` 里的图片并展示。

## 只检查请求参数，不调用接口

```bash
npm run image:generate -- --dry-run --name hero-cover --prompt "test prompt"
```

## 官方文档

- Kie GPT Image 2 文生图：https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image
- Kie 查询任务详情：https://docs.kie.ai/market/common/get-task-detail
