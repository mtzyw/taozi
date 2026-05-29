const store = require('../../utils/store');
const backend = require('../../utils/backend');
const { formatMoney, maskPhone, statusLabel, formatDateTime } = require('../../utils/format');

function fulfillmentActionLabel(action) {
  const labels = {
    mock_paid: '支付成功',
    pickup_shipped: '自提点已到货，可领取',
    shipped: '导入快递发货',
    picked_up: '自提核销',
    completed: '订单完成',
    after_sale: '售后处理',
    refunded: '退款完成',
    cancelled: '订单取消'
  };
  return labels[action] || action || '履约更新';
}

function normalizeDiscountTrace(trace = []) {
  return trace.filter((item) => item.type !== 'product_sale').map((item) => ({
    ...item,
    amountText: formatMoney(item.amount)
  }));
}

function canApplyAfterSale(order) {
  if (!order || order.afterSaleInfo) return false;
  if (order.status === 'completed') return true;
  if (order.deliveryType === 'pickup') return order.status === 'picked_up';
  if (order.deliveryType === 'express') return order.status === 'completed';
  return false;
}

function getAfterSaleTip(order) {
  if (!order || order.afterSaleInfo || canApplyAfterSale(order)) return '';
  if (order.status === 'awaiting_pickup') return '订单正在备货中，暂未到自提点，完成自提核销后才能申请售后。';
  if (order.status === 'awaiting_shipment') return '订单仍待发货，商家发货后才能申请售后。';
  if (order.status === 'awaiting_payment') return '订单尚未支付，暂不能申请售后。';
  if (['cancelled', 'refunded', 'after_sale'].includes(order.status)) return '当前订单状态不可申请售后。';
  return '';
}

function pickupValidityText(order) {
  if (!order || order.deliveryType !== 'pickup' || order.status !== 'pickup_shipped') return '';
  const validHours = Number(order.pickupValidHours || 0);
  const arrivedAt = order.pickupArrivedAt || order.shippedAt || '';
  const arrivedTime = new Date(arrivedAt).getTime();
  if (!validHours || !Number.isFinite(arrivedTime)) return '';
  const remainingMs = arrivedTime + validHours * 60 * 60 * 1000 - Date.now();
  if (remainingMs <= 0) return '自提有效期已超时';
  const totalMinutes = Math.ceil(remainingMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `自提有效期还剩 ${hours}小时${minutes ? `${minutes}分` : ''}`;
}

function normalizeLogDetail(log) {
  const detail = String(log && log.detail || '').trim();
  if (log && log.action === 'shipped') return detail.replace(/^手动发货[:：]?/, '导入快递发货：');
  return detail;
}

function normalizeFulfillmentLogs(logs = []) {
  const hasImportedShipment = logs.some((log) => log.action === 'shipped' && /导入快递发货/.test(String(log.detail || '')));
  return logs.filter((log) => !(hasImportedShipment && log.action === 'shipped' && /手动发货/.test(String(log.detail || ''))));
}

Page({
  data: {
    order: null,
    afterSaleReason: '',
    isSubmittingAfterSale: false,
    pickupValidityText: ''
  },

  onLoad(options) {
    this.orderId = options.orderId;
    this.loadOrder();
  },

  onShow() {
    if (this.orderId) this.loadOrder();
  },

  onHide() {
    this.clearPickupTimer();
  },

  onUnload() {
    this.clearPickupTimer();
  },

  clearPickupTimer() {
    if (this.pickupTimer) {
      clearInterval(this.pickupTimer);
      this.pickupTimer = null;
    }
  },

  startPickupTimer() {
    this.clearPickupTimer();
    this.updatePickupValidityText();
    const order = this.data.order;
    if (!order || !order.pickupValidityText) return;
    this.pickupTimer = setInterval(() => this.updatePickupValidityText(), 60 * 1000);
  },

  updatePickupValidityText() {
    const order = this.data.order;
    const text = pickupValidityText(order);
    this.setData({ pickupValidityText: text });
  },

  async loadOrder() {
    let order = null;
    try {
      order = await backend.getOrderById(this.orderId);
    } catch (_) {
      order = store.getOrderById(this.orderId);
    }
    if (!order) {
      wx.showToast({ title: '订单不存在', icon: 'none' });
      return;
    }

    const item = order.items && order.items[0] ? order.items[0] : {};
    const expressInfo = order.expressInfo || null;
    const expressShipment = order.expressShipment || null;
    const expressCompany = expressShipment && expressShipment.company ? expressShipment.company : '';
    const expressTrackingNo = expressShipment && expressShipment.trackingNo ? expressShipment.trackingNo : '';
    const deliverySummary = order.deliveryType === 'express'
      ? '快递配送'
      : `${order.deliveryLabel || '自提'}${order.pickupPointName ? '｜' + order.pickupPointName : ''}`;

    this.setData({
      order: {
        ...order,
        statusText: order.statusText || statusLabel(order.status),
        createdAtText: formatDateTime(order.createdAt),
        maskedPhone: maskPhone(order.buyerPhone),
        itemName: item.productName || '未知商品',
        skuName: item.skuName || item.packageLabel || '默认规格',
        skuMeta: [item.packageLabel, item.weightText].filter(Boolean).join('｜'),
        quantity: item.quantity || 1,
        unitPriceText: formatMoney(item.unitPrice),
        totalAmountText: formatMoney(order.totalAmount),
        originalTotalText: formatMoney(order.totalAmount),
        goodsAmountText: formatMoney(order.goodsAmount !== undefined ? order.goodsAmount : order.payAmount),
        shippingFeeText: formatMoney(order.shippingFee),
        payAmountText: formatMoney(order.payAmount),
        deliverySummary,
        expressText: expressInfo ? `${expressInfo.receiver}｜${maskPhone(expressInfo.phone)}` : '',
        expressAddress: expressInfo ? expressInfo.address : '',
        expressCompany,
        expressTrackingNo,
        hasExpressShipment: Boolean(expressTrackingNo),
        expressShipmentText: expressTrackingNo ? `${expressCompany || '快递'}｜${expressTrackingNo}` : '',
        shippedAtText: expressShipment && expressShipment.shippedAt ? formatDateTime(expressShipment.shippedAt) : '',
        pickupCodeText: order.pickupCode || '',
        pickedUpAtText: order.pickedUpAt ? formatDateTime(order.pickedUpAt) : '',
        completedAtText: order.completedAt ? formatDateTime(order.completedAt) : '',
        refundedAtText: order.refundedAt ? formatDateTime(order.refundedAt) : '',
        cancelledAtText: order.cancelledAt ? formatDateTime(order.cancelledAt) : '',
        serviceText: `客服：${order.customerContact || ''}${order.customerContact && order.customerPhone ? '｜' : ''}联系电话：${order.customerPhone || ''}`,
        pickupValidityText: pickupValidityText(order),
        canApplyAfterSale: canApplyAfterSale(order),
        afterSaleTip: getAfterSaleTip(order),
        trace: normalizeDiscountTrace(order.discountTrace || []),
        fulfillmentLogs: normalizeFulfillmentLogs(order.fulfillmentLogs || []).map((log) => ({
          ...log,
          actionText: fulfillmentActionLabel(log.action),
          detail: normalizeLogDetail(log),
          createdAtText: formatDateTime(log.createdAt)
        }))
      }
    });
    this.startPickupTimer();
  },

  backOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' });
  },

  copyTrackingNo(event) {
    const datasetNo = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.trackingNo
      : '';
    const trackingNo = String(datasetNo || (this.data.order && this.data.order.expressTrackingNo) || '').trim();
    if (!trackingNo) {
      wx.showToast({ title: '暂无快递单号', icon: 'none' });
      return;
    }
    if (!wx.setClipboardData) {
      wx.showModal({ title: '快递单号', content: trackingNo, showCancel: false });
      return;
    }
    wx.setClipboardData({
      data: trackingNo,
      success: () => wx.showToast({ title: '单号已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请长按单号复制', icon: 'none' })
    });
  },

  onAfterSaleReasonInput(event) {
    this.setData({ afterSaleReason: event.detail.value });
  },

  async applyAfterSale() {
    if (!this.data.order || !this.data.order.canApplyAfterSale) {
      wx.showToast({ title: this.data.order && this.data.order.afterSaleTip ? this.data.order.afterSaleTip : '当前订单状态不可申请售后', icon: 'none' });
      return;
    }
    const reason = String(this.data.afterSaleReason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请填写售后原因', icon: 'none' });
      return;
    }
    this.setData({ isSubmittingAfterSale: true });
    try {
      const order = await backend.requestAfterSale(this.orderId, {
        buyerPhone: this.data.order.buyerPhone,
        reason
      });
      if (!order) throw new Error('提交失败');
      this.setData({ afterSaleReason: '' });
      await this.loadOrder();
      wx.showToast({ title: '售后已提交', icon: 'success' });
    } catch (error) {
      const localOrder = store.markOrderAfterSale(this.orderId, reason);
      if (localOrder) {
        this.setData({ afterSaleReason: '' });
        await this.loadOrder();
        wx.showToast({ title: '售后已提交', icon: 'success' });
      } else {
        wx.showToast({ title: error.message || '提交失败', icon: 'none' });
      }
    } finally {
      this.setData({ isSubmittingAfterSale: false });
    }
  }
});
