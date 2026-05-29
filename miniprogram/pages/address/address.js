const store = require('../../utils/store');
const backend = require('../../utils/backend');
const { normalizePhone } = require('../../utils/pricing');
const { maskPhone } = require('../../utils/format');

Page({
  data: {
    addressId: '',
    receiver: '',
    phone: '',
    address: '',
    isDefault: true,
    isSaving: false,
    operatingAddressId: '',
    addresses: []
  },

  onShow() {
    this.loadAddresses();
  },

  async loadAddresses() {
    const ownerPhone = store.getCurrentPhone();
    let sourceAddresses = [];
    try {
      if (/^1\d{10}$/.test(ownerPhone)) {
        sourceAddresses = await backend.listAddresses(ownerPhone);
        store.saveAddresses(sourceAddresses);
      } else {
        sourceAddresses = store.getAddresses();
      }
    } catch (_) {
      sourceAddresses = store.getAddresses();
    }
    const addresses = sourceAddresses.map((address) => ({
      ...address,
      maskedPhone: maskPhone(address.phone)
    }));
    this.setData({ addresses });
  },

  onReceiverInput(event) {
    this.setData({ receiver: event.detail.value });
  },

  onPhoneInput(event) {
    this.setData({ phone: event.detail.value });
  },

  onAddressInput(event) {
    this.setData({ address: event.detail.value });
  },

  onDefaultSwitch(event) {
    this.setData({ isDefault: event.detail.value });
  },

  resetForm() {
    this.setData({
      addressId: '',
      receiver: '',
      phone: '',
      address: '',
      isDefault: this.data.addresses.length === 0
    });
  },

  async saveAddress() {
    if (this.saveLock || this.data.isSaving) return;
    this.saveLock = true;
    this.setData({ isSaving: true });
    try {
    const phone = normalizePhone(this.data.phone);
    const ownerPhone = store.getCurrentPhone() || phone;
    if (!this.data.receiver.trim()) {
      wx.showToast({ title: '请填写收货人', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填写正确手机号', icon: 'none' });
      return;
    }
    if (!this.data.address.trim()) {
      wx.showToast({ title: '请填写详细地址', icon: 'none' });
      return;
    }

    const payload = {
      id: this.data.addressId,
      buyerPhone: ownerPhone,
      receiver: this.data.receiver,
      phone,
      address: this.data.address,
      isDefault: this.data.isDefault
    };
    try {
      if (/^1\d{10}$/.test(ownerPhone)) {
        const savedAddress = await backend.upsertAddress(payload);
        store.upsertAddress(savedAddress || payload);
      } else {
        store.upsertAddress(payload);
      }
    } catch (_) {
      store.upsertAddress(payload);
    }
    store.setCurrentPhone(ownerPhone);
    this.resetForm();
    await this.loadAddresses();
    wx.showToast({ title: '地址已保存', icon: 'success' });
    } finally {
      this.saveLock = false;
      this.setData({ isSaving: false });
    }
  },

  editAddress(event) {
    const id = event.currentTarget.dataset.id;
    const address = this.data.addresses.find((item) => item.id === id) || store.getAddresses().find((item) => item.id === id);
    if (!address) return;
    this.setData({
      addressId: address.id,
      receiver: address.receiver,
      phone: address.phone,
      address: address.address,
      isDefault: address.isDefault
    });
  },

  async setDefault(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.operatingAddressId === id) return;
    const address = this.data.addresses.find((item) => item.id === id) || store.getAddresses().find((item) => item.id === id);
    if (!address) return;
    this.setData({ operatingAddressId: id });
    try {
      const savedAddress = await backend.upsertAddress({ ...address, buyerPhone: store.getCurrentPhone() || address.buyerPhone || address.phone, isDefault: true });
      store.upsertAddress(savedAddress || { ...address, isDefault: true });
    } catch (_) {
      store.upsertAddress({ ...address, isDefault: true });
    } finally {
      this.setData({ operatingAddressId: '' });
    }
    this.loadAddresses();
  },

  deleteAddress(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.operatingAddressId === id) return;
    wx.showModal({
      title: '删除地址',
      content: '确定删除这个收货地址吗？',
      confirmColor: '#e54862',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ operatingAddressId: id });
        try {
          await backend.deleteAddress(id, store.getCurrentPhone());
        } catch (_) {
        }
        store.deleteAddress(id);
        await this.loadAddresses();
        if (this.data.addressId === id) this.resetForm();
        this.setData({ operatingAddressId: '' });
      }
    });
  }
});
