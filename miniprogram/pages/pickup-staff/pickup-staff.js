const backend = require('../../utils/backend');

const STORAGE_KEY = 'peach.pickupStaffSession';

function resultMeta(status) {
  const map = {
    ready: { title: '可以领取', level: 'success' },
    picked: { title: '核销成功', level: 'success' },
    already_picked: { title: '已领取', level: 'warn' },
    wrong_pickup_point: { title: '自提点不匹配', level: 'warn' },
    not_arrived: { title: '暂未到货', level: 'warn' },
    not_found: { title: '未查到订单', level: 'danger' },
    unavailable: { title: '不可核销', level: 'danger' }
  };
  return map[status] || { title: '查询结果', level: 'warn' };
}

Page({
  data: {
    account: '',
    password: '',
    sessionId: '',
    pickupPoint: null,
    phoneTail: '',
    pickupCode: '',
    result: null,
    resultTitle: '',
    resultLevel: '',
    canConfirm: false,
    isLoggingIn: false,
    isQuerying: false,
    isConfirming: false
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE_KEY) || {};
    if (saved.sessionId && saved.pickupPoint) {
      this.setData({
        sessionId: saved.sessionId,
        pickupPoint: saved.pickupPoint
      });
    }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    let value = event.detail.value || '';
    if (field === 'phoneTail') value = value.replace(/\D/g, '').slice(0, 4);
    if (field === 'pickupCode') value = value.replace(/\D/g, '').slice(0, 12);
    this.setData({ [field]: value });
  },

  async login() {
    if (this.data.isLoggingIn) return;
    const account = String(this.data.account || '').trim();
    const password = String(this.data.password || '');
    if (!account || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }
    this.setData({ isLoggingIn: true });
    try {
      const session = await backend.pickupStaffLogin({ account, password });
      if (!session || !session.sessionId) throw new Error('登录失败');
      wx.setStorageSync(STORAGE_KEY, session);
      this.setData({
        sessionId: session.sessionId,
        pickupPoint: session.pickupPoint,
        password: '',
        result: null,
        resultTitle: '',
        resultLevel: '',
        canConfirm: false
      });
      wx.showToast({ title: '登录成功', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    } finally {
      this.setData({ isLoggingIn: false });
    }
  },

  logout() {
    wx.removeStorageSync(STORAGE_KEY);
    this.setData({
      sessionId: '',
      pickupPoint: null,
      phoneTail: '',
      pickupCode: '',
      result: null,
      resultTitle: '',
      resultLevel: '',
      canConfirm: false
    });
  },

  setResult(result) {
    const meta = resultMeta(result && result.status);
    this.setData({
      result,
      resultTitle: meta.title,
      resultLevel: meta.level,
      canConfirm: result && result.status === 'ready'
    });
  },

  validateLookupFields() {
    if (!this.data.sessionId) {
      wx.showToast({ title: '请先登录自提点', icon: 'none' });
      return false;
    }
    if (!/^\d{4}$/.test(this.data.phoneTail)) {
      wx.showToast({ title: '请输入手机号后4位', icon: 'none' });
      return false;
    }
    if (!this.data.pickupCode) {
      wx.showToast({ title: '请输入核销码', icon: 'none' });
      return false;
    }
    return true;
  },

  async lookupOrder() {
    if (this.data.isQuerying || !this.validateLookupFields()) return;
    this.setData({ isQuerying: true, result: null, canConfirm: false });
    try {
      const result = await backend.lookupPickupStaffOrder({
        sessionId: this.data.sessionId,
        phoneTail: this.data.phoneTail,
        pickupCode: this.data.pickupCode
      });
      this.setResult(result);
    } catch (error) {
      if (/登录已过期/.test(error.message || '')) this.logout();
      wx.showToast({ title: error.message || '查询失败', icon: 'none' });
    } finally {
      this.setData({ isQuerying: false });
    }
  },

  async confirmPickup() {
    if (this.data.isConfirming || !this.validateLookupFields()) return;
    this.setData({ isConfirming: true });
    try {
      const result = await backend.confirmPickupStaffOrder({
        sessionId: this.data.sessionId,
        phoneTail: this.data.phoneTail,
        pickupCode: this.data.pickupCode
      });
      this.setResult(result);
      if (result && result.status === 'picked') {
        wx.showToast({ title: '核销成功', icon: 'success' });
      }
    } catch (error) {
      if (/登录已过期/.test(error.message || '')) this.logout();
      wx.showToast({ title: error.message || '核销失败', icon: 'none' });
    } finally {
      this.setData({ isConfirming: false });
    }
  }
});
