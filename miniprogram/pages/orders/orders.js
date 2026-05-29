const store = require('../../utils/store');
const backend = require('../../utils/backend');
const { formatMoney, maskPhone, statusLabel } = require('../../utils/format');

Page({
  data: {
    orders: [],
    orderTabs: [
      { key: 'all', label: '全部订单' },
      { key: 'pickup_shipped', label: '自提点已到货' },
      { key: 'shipped', label: '已发货' },
      { key: 'awaiting', label: '待发货' },
      { key: 'after_sale', label: '售后中' },
      { key: 'refunded', label: '已退款' },
      { key: 'picked_up', label: '已自提' }
    ],
    activeTab: 'all'
  },

  onShow() {
    this.loadOrders();
  },

  async loadOrders() {
    const currentPhone = store.getCurrentPhone();
    if (!/^1\d{10}$/.test(currentPhone)) {
      this.setData({ orders: [] });
      return;
    }
    let sourceOrders = [];
    try {
      sourceOrders = await backend.listOrders(currentPhone);
    } catch (_) {
      sourceOrders = store.getOrders().filter((order) => order.buyerPhone === currentPhone);
    }
    this.allOrders = sourceOrders.map((order) => {
      const item = order.items && order.items[0] ? order.items[0] : {};
      const shipment = order.expressShipment || null;
      const deliverySummary = order.deliveryType === 'express'
        ? `快递｜${shipment && shipment.trackingNo ? shipment.company + ' ' + shipment.trackingNo : '待发货'}`
        : `自提｜${order.pickupPointName || '未选择自提点'}${order.pickupCode ? '｜核销码 ' + order.pickupCode : ''}`;
      return {
        ...order,
        itemName: item.productName || '未知商品',
        itemSpec: `${item.skuName || item.packageLabel || ''} × ${item.quantity || 1}`,
        statusText: order.statusText || statusLabel(order.status),
        maskedPhone: maskPhone(order.buyerPhone),
        payAmountText: formatMoney(order.payAmount),
        deliverySummary
      };
    });
    this.applyOrderTab();
  },

  orderMatchesTab(order, tab) {
    if (tab === 'all') return true;
    if (tab === 'pickup_shipped') return order.deliveryType === 'pickup' && order.status === 'pickup_shipped';
    if (tab === 'shipped') return order.deliveryType === 'express' && order.status === 'shipped';
    if (tab === 'awaiting') return ['awaiting_shipment', 'awaiting_pickup'].includes(order.status);
    if (tab === 'picked_up') return order.deliveryType === 'pickup' && ['picked_up', 'completed'].includes(order.status);
    return order.status === tab;
  },

  applyOrderTab() {
    const activeTab = this.data.activeTab || 'all';
    const orders = (this.allOrders || []).filter((order) => this.orderMatchesTab(order, activeTab));
    this.setData({ orders });
  },

  onTabTap(event) {
    const activeTab = event.currentTarget.dataset.key || 'all';
    this.setData({ activeTab }, () => this.applyOrderTab());
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' });
  },

  goDetail(event) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?orderId=${event.currentTarget.dataset.id}` });
  }
});
