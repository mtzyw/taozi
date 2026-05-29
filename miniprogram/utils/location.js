function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.getLocation) {
      reject(new Error('当前环境不支持定位'));
      return;
    }
    wx.getLocation({
      type: 'gcj02',
      success(res) {
        const latitude = Number(res && res.latitude);
        const longitude = Number(res && res.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          resolve({ latitude, longitude });
          return;
        }
        reject(new Error('定位结果无效'));
      },
      fail(error) {
        reject(new Error(error && error.errMsg || '定位失败'));
      }
    });
  });
}

function locationErrorMessage(error) {
  const message = String(error && error.message || error || '定位失败');
  if (/auth deny|authorize|denied|cancel/i.test(message)) return '未授权定位，当前按后台默认顺序展示自提点。';
  if (/fail/i.test(message)) return '暂时无法获取定位，当前按后台默认顺序展示自提点。';
  return message;
}

module.exports = {
  getUserLocation,
  locationErrorMessage
};
