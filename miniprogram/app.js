const apiConfig = require('./config/api');

App({
  globalData: {
    appName: '桃子预售',
    mockPayment: true
  },

  onLaunch() {
    const logs = wx.getStorageSync('logs') || [];
    logs.unshift(Date.now());
    wx.setStorageSync('logs', logs);
    if (
      apiConfig.enabled
      && apiConfig.mode === 'cloudrun'
      && typeof wx !== 'undefined'
      && typeof wx.cloud !== 'undefined'
      && wx.cloud.init
    ) {
      const env = apiConfig.cloudrun && apiConfig.cloudrun.env;
      wx.cloud.init({
        ...(env ? { env } : {}),
        traceUser: true
      });
    }
  }
});
