const store = require('../../utils/store');
const backend = require('../../utils/backend');
const { formatMoney, maskPhone, statusLabel } = require('../../utils/format');

Page({
  data: {
    order: null,
    orderId: ''
  },

  async onLoad(options) {
    this.setData({ orderId: options.orderId || '' });
    let order = null;
    try {
      order = await backend.getOrderById(options.orderId);
    } catch (_) {
      order = store.getOrderById(options.orderId);
    }
    if (!order) {
      wx.showToast({ title: '订单不存在', icon: 'none' });
      return;
    }
    const expressText = order.expressInfo
      ? `${order.expressInfo.receiver}｜${maskPhone(order.expressInfo.phone)}｜${order.expressInfo.address}`
      : '';
    this.setData({
      order: {
        ...order,
        maskedPhone: maskPhone(order.buyerPhone),
        statusText: order.statusText || statusLabel(order.status),
        payAmountText: formatMoney(order.payAmount),
        totalAmountText: formatMoney(order.totalAmount),
        goodsAmountText: formatMoney(order.goodsAmount !== undefined ? order.goodsAmount : order.payAmount),
        shippingFeeText: formatMoney(order.shippingFee),
        fulfillmentText: order.deliveryType === 'express' ? '快递配送' : `${order.deliveryLabel || '自提'}${order.pickupPointName ? '｜' + order.pickupPointName : ''}`,
        expressText,
        pickupCodeText: order.pickupCode || ''
      }
    });
  },

  backHome() {
    wx.switchTab ? wx.switchTab({ url: '/pages/index/index' }) : wx.redirectTo({ url: '/pages/index/index' });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goOrderDetail() {
    wx.redirectTo({ url: `/pages/order-detail/order-detail?orderId=${this.data.orderId}` });
  }
});
