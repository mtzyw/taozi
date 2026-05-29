Page({
  data: {
    logs: []
  },

  onLoad() {
    const logs = wx.getStorageSync('logs') || [];
    this.setData({
      logs: logs.map((log) => new Date(log).toLocaleString())
    });
  }
});
