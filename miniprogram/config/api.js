module.exports = {
  enabled: true,
  // mode 可选：
  // - http：通过 wx.request 访问已配置到「request 合法域名」的 HTTPS 后端
  // - cloudrun：通过 wx.cloud.callContainer 调用微信云托管
  mode: 'http',
  timeout: 8000,
  baseUrl: 'https://taozi.shayudata.com',
  // 用于拼接后端返回的 /uploads 或 /assets 图片地址，体验环境跟接口域名保持一致。
  publicBaseUrl: 'https://taozi.shayudata.com',
  cloudrun: {
    // 在微信云托管控制台创建环境后填写，例如：prod-xxxx
    env: '',
    // 在微信云托管「服务列表」里创建的服务名，部署时建议使用这个名字
    serviceName: 'peach-presale-api'
  }
};
