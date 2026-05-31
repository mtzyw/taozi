const apiConfig = require('./config/api');

App({
  globalData: {
    appName: '桃子预售',
    mockPayment: true,
    wechatOrderConfirmResult: null
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
  },

  onShow(options = {}) {
    const referrerInfo = options.referrerInfo || {};
    let extraData = referrerInfo.extraData || {};
    if (typeof extraData === 'string') {
      try {
        extraData = JSON.parse(extraData);
      } catch (_) {
        extraData = {};
      }
    }
    let reqExtraData = extraData.req_extradata || extraData.reqExtraData || null;
    if (typeof reqExtraData === 'string') {
      try {
        reqExtraData = JSON.parse(reqExtraData);
      } catch (_) {
        reqExtraData = null;
      }
    }
    if (referrerInfo.appId === 'wx1183b055aeec94d1' && reqExtraData) {
      this.globalData.wechatOrderConfirmResult = {
        status: extraData.status || '',
        errormsg: extraData.errormsg || '',
        reqExtraData,
        receivedAt: Date.now()
      };
    }
  }
});
