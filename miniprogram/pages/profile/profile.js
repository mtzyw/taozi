const store = require('../../utils/store');
const backend = require('../../utils/backend');
const auth = require('../../utils/auth');
const { getWhitelistDiscount } = require('../../utils/pricing');
const { maskPhone, formatMoney } = require('../../utils/format');

Page({
  data: {
    currentPhone: '',
    maskedPhone: '',
    isWhitelistUser: false,
    whitelistLabel: '',
    orderCount: 0,
    totalPaidText: '0.00',
    isBindingPhone: false
  },

  onShow() {
    this.loadProfile();
  },

  async loadProfile() {
    const currentPhone = store.getCurrentPhone();
    let whitelistDiscount = getWhitelistDiscount(currentPhone, store.getWhitelistEntries());
    let orders = store.getOrders().filter((order) => currentPhone && order.buyerPhone === currentPhone);
    try {
      const backendDiscount = await backend.getWhitelistDiscount(currentPhone);
      if (backendDiscount) whitelistDiscount = backendDiscount;
      if (/^1\d{10}$/.test(currentPhone)) {
        orders = await backend.listOrders(currentPhone);
      }
    } catch (_) {}
    const totalPaid = orders.reduce((sum, order) => sum + Number(order.payAmount || 0), 0);
    this.setData({
      currentPhone,
      maskedPhone: maskPhone(currentPhone),
      isWhitelistUser: Boolean(whitelistDiscount),
      whitelistLabel: whitelistDiscount ? whitelistDiscount.label : '',
      orderCount: orders.length,
      totalPaidText: formatMoney(totalPaid)
    });
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goAddress() {
    wx.navigateTo({ url: '/pages/address/address' });
  },

  goPickupStaff() {
    wx.navigateTo({ url: '/pages/pickup-staff/pickup-staff' });
  },

  logout() {
    auth.logout();
    wx.showToast({ title: '已退出登录', icon: 'success' });
    this.loadProfile();
  },

  async onGetPhoneNumber(event) {
    if (this.data.isBindingPhone) return;
    this.setData({ isBindingPhone: true });
    try {
      await auth.bindPhoneFromEvent(event);
      wx.showToast({ title: '手机号已绑定', icon: 'success' });
      await this.loadProfile();
    } catch (error) {
      wx.showToast({ title: error.message || '手机号授权失败', icon: 'none' });
    } finally {
      this.setData({ isBindingPhone: false });
    }
  }
});
