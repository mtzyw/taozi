const store = require('../../utils/store');
const { parsePhoneImport } = require('../../utils/pricing');
const { formatMoney, statusLabel, maskPhone, deliveryTypeLabel, formatDateTime } = require('../../utils/format');

function createDefaultProductForm() {
  return {
    id: '',
    name: '',
    subtitle: '',
    salePriceYuan: '',
    boxStock: '',
    bagStock: '',
    weightText: '',
    coverImage: '',
    tagsText: '新上架 预售',
    presaleNote: '',
    batchName: '第一批预售',
    saleType: 'presale',
    shipStart: '',
    shipEnd: '',
    orderDeadline: '',
    packageBox: true,
    packageBag: false,
    deliveryPickup: true,
    deliveryExpress: false,
    status: 'on_sale'
  };
}

function createDefaultPickupForm() {
  return {
    id: '',
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    phone: '',
    openTime: '10:00-20:00',
    dailyCapacity: '',
    sortWeight: '0',
    notice: '',
    packageBox: true,
    packageBag: true,
    enabled: true
  };
}

function createShippingRuleForm(rule) {
  return {
    expressBaseFeeYuan: formatMoney(rule.expressBaseFee),
    freeShippingThresholdYuan: formatMoney(rule.freeShippingThreshold),
    pickupFeeYuan: formatMoney(rule.pickupFee),
    note: rule.note || ''
  };
}

function packageLabel(type) {
  return type === 'box' ? '盒装' : '袋装';
}

function deliveryLabel(type) {
  return type === 'express' ? '快递' : '自提';
}

function tagsToText(tags) {
  return (Array.isArray(tags) ? tags : []).join(' ');
}

function toYuanValue(cents) {
  return cents === undefined || cents === null ? '' : formatMoney(cents);
}

function parseAdminDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const hasTime = /[T ]\d{1,2}:\d{2}/.test(text);
  const normalized = text.includes('T')
    ? text
    : hasTime
      ? text.replace(/\s+/, 'T')
      : `${text}T00:00:00`;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function validateProductSchedule(form) {
  if (form.saleType === 'direct') return '';
  const shipStartText = String(form.shipStart || '').trim();
  const shipEndText = String(form.shipEnd || '').trim();
  const orderDeadlineText = String(form.orderDeadline || '').trim();
  if (!orderDeadlineText || !shipStartText || !shipEndText) return '请完整填写截单时间、履约开始、履约结束';

  const shipStart = parseAdminDateTime(shipStartText);
  const shipEnd = parseAdminDateTime(shipEndText);
  const orderDeadline = parseAdminDateTime(orderDeadlineText);
  if (Number.isNaN(shipStart)) return '履约开始时间格式不正确';
  if (Number.isNaN(shipEnd)) return '履约结束时间格式不正确';
  if (Number.isNaN(orderDeadline)) return '截单时间格式不正确';
  if (shipStart && shipEnd && shipEnd <= shipStart) return '履约结束时间必须大于履约开始时间';
  if (orderDeadline && shipStart && orderDeadline >= shipStart) return '截单时间必须小于履约开始时间';
  return '';
}

function buildProductForm(product) {
  const packageTypes = product.packageTypes || [];
  const deliveryMethods = product.deliveryMethods || [];
  const skus = product.skus || [];
  const boxSku = skus.find((sku) => sku.packageType === 'box') || {};
  const bagSku = skus.find((sku) => sku.packageType === 'bag') || {};
  const firstSku = skus[0] || {};
  return {
    id: product.id,
    name: product.name || '',
    subtitle: product.subtitle || '',
    salePriceYuan: toYuanValue(product.salePrice),
    boxStock: boxSku.stock === undefined ? '' : String(boxSku.stock),
    bagStock: bagSku.stock === undefined ? '' : String(bagSku.stock),
    weightText: firstSku.weightText || '',
    coverImage: product.coverImage || '',
    tagsText: tagsToText(product.tags),
    presaleNote: product.presaleNote || '',
    batchName: product.batchName || '当前预售批次',
    saleType: product.saleType === 'direct' ? 'direct' : 'presale',
    shipStart: product.shipStart || '',
    shipEnd: product.shipEnd || '',
    orderDeadline: product.orderDeadline || '',
    packageBox: packageTypes.includes('box'),
    packageBag: packageTypes.includes('bag'),
    deliveryPickup: deliveryMethods.includes('pickup'),
    deliveryExpress: deliveryMethods.includes('express'),
    status: product.status || 'on_sale'
  };
}

function buildPickupForm(point) {
  const packageTypes = point.packageTypes || [];
  return {
    id: point.id,
    name: point.name || '',
    address: point.address || '',
    latitude: point.latitude === '' || point.latitude === undefined ? '' : String(point.latitude),
    longitude: point.longitude === '' || point.longitude === undefined ? '' : String(point.longitude),
    phone: point.phone || '',
    openTime: point.openTime || '',
    dailyCapacity: point.dailyCapacity ? String(point.dailyCapacity) : '',
    sortWeight: point.sortWeight === undefined ? '0' : String(point.sortWeight),
    notice: point.notice || '',
    packageBox: packageTypes.includes('box'),
    packageBag: packageTypes.includes('bag'),
    enabled: point.enabled !== false
  };
}

function hasValidCoordinate(value) {
  return value !== '' && value !== undefined && value !== null && Number.isFinite(Number(value));
}

function yuanToCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue * 100));
}

function presaleWindowText(product) {
  if (product.saleType === 'direct') {
    return product.batchName ? `批次：${product.batchName}｜直售` : '直售';
  }
  return [
    product.batchName ? `批次：${product.batchName}` : '',
    product.shipStart && product.shipEnd ? `履约 ${product.shipStart}~${product.shipEnd}` : '',
    product.orderDeadline ? `截单 ${product.orderDeadline}` : ''
  ].filter(Boolean).join('｜');
}

function orderMatchesKeyword(order, keyword) {
  if (!keyword) return true;
  const item = order.items && order.items[0] ? order.items[0] : {};
  const text = [
    order.id,
    order.buyerPhone,
    order.pickupPointName,
    order.pickupCode,
    item.productName,
    item.skuName,
    item.packageLabel
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes(keyword.toLowerCase());
}

Page({
  data: {
    authorized: false,
    currentAdminText: '',
    canSetupAdmin: false,
    setupAdminText: '',
    adminAuthDesc: '请先回到“我的”页面绑定手机号。若本机还没有管理员，进入本页时会显示首次管理员设置入口。',
    productForm: createDefaultProductForm(),
    pickupForm: createDefaultPickupForm(),
    shippingRuleForm: createShippingRuleForm(store.getShippingRule()),
    importText: '',
    discountPercent: 80,
    whitelistEntries: [],
    products: [],
    pickupPoints: [],
    orders: [],
    stockInputs: {},
    shipmentInputs: {},
    afterSaleInputs: {},
    imageSaving: false,
    orderFilter: {
      status: 'all',
      deliveryType: 'all',
      keyword: ''
    },
    orderStatusFilters: [
      { key: 'all', label: '全部' },
      { key: 'awaiting_shipment', label: '待发货' },
      { key: 'awaiting_pickup', label: '待自提' },
      { key: 'pickup_shipped', label: '自提点已到货' },
      { key: 'shipped', label: '已发货' },
      { key: 'picked_up', label: '已自提' },
      { key: 'completed', label: '已完成' },
      { key: 'after_sale', label: '售后中' },
      { key: 'refunded', label: '已退款' }
    ],
    orderDeliveryFilters: [
      { key: 'all', label: '全部配送' },
      { key: 'pickup', label: '自提' },
      { key: 'express', label: '快递' }
    ]
  },

  onShow() {
    if (!this.ensureAdmin()) return;
    this.loadAdmin();
  },

  ensureAdmin() {
    const currentPhone = store.getCurrentPhone();
    const authorized = store.isAdminPhone(currentPhone);
    const hasCurrentPhone = /^1\d{10}$/.test(currentPhone);
    const hasAdmins = store.hasAdminPhones();

    if (!authorized && hasCurrentPhone && !hasAdmins) {
      store.addAdminPhone(currentPhone);
      this.setData({
        authorized: true,
        currentAdminText: maskPhone(currentPhone),
        canSetupAdmin: false,
        setupAdminText: '',
        adminAuthDesc: ''
      });
      wx.showToast({ title: '已设为管理员', icon: 'success' });
      return true;
    }

    const adminAuthDesc = hasCurrentPhone
      ? hasAdmins
        ? `当前手机号 ${maskPhone(currentPhone)} 还不是本机管理员，开发期可先追加为管理员后进入。`
        : `本机还没有管理员，可将当前手机号 ${maskPhone(currentPhone)} 设为首次管理员。`
      : '请先回到“我的”页面授权或本地绑定手机号，再进入管理员后台。';
    this.setData({
      authorized,
      currentAdminText: authorized ? maskPhone(currentPhone) : '',
      canSetupAdmin: !authorized && hasCurrentPhone,
      setupAdminText: hasAdmins ? '追加本机管理员' : '设为本机管理员',
      adminAuthDesc
    });

    if (authorized) return true;
    return false;
  },

  setupCurrentAsAdmin() {
    const currentPhone = store.getCurrentPhone();
    if (!/^1\d{10}$/.test(currentPhone)) {
      wx.showToast({ title: '请先绑定手机号', icon: 'none' });
      wx.switchTab({ url: '/pages/profile/profile' });
      return;
    }

    store.addAdminPhone(currentPhone);
    this.setData({
      authorized: true,
      currentAdminText: maskPhone(currentPhone),
      canSetupAdmin: false,
      setupAdminText: ''
    });
    this.loadAdmin();
    wx.showToast({ title: '管理员已设置', icon: 'success' });
  },

  loadAdmin() {
    const products = store.getProducts().map((product) => ({
      ...product,
      statusText: statusLabel(product.status),
      priceText: formatMoney(product.salePrice),
      packageText: (product.packageTypes || []).map(packageLabel).join(' / '),
      deliveryText: (product.deliveryMethods || []).map(deliveryLabel).join(' / '),
      stockSummaryText: `累计库存 ${product.initialStock || product.stock}｜已售 ${product.soldCount || 0}｜剩余 ${product.stock}${product.lockedCount ? `｜锁定 ${product.lockedCount}` : ''}`,
      sourceText: product.source === 'custom' ? '后台创建' : '系统示例',
      presaleWindowText: presaleWindowText(product) || '未设置预售批次',
      stockRows: (product.skus || []).map((sku) => ({
        productId: product.id,
        skuId: sku.id,
        inputKey: `${product.id}__${sku.id}`,
        name: sku.name || sku.label || packageLabel(sku.packageType),
        packageLabel: sku.label || packageLabel(sku.packageType),
        stock: sku.stock,
        stockSummaryText: `累计 ${sku.initialStock || sku.stock}｜已售 ${sku.soldCount || 0}｜剩余 ${sku.stock}${sku.lockedCount ? `｜锁定 ${sku.lockedCount}` : ''}`
      }))
    }));
    const whitelistEntries = store.getWhitelistEntries().map((entry) => ({
      ...entry,
      maskedPhone: maskPhone(entry.phone),
      label: `${entry.discountPercent}折白名单`
    }));
    const pickupPoints = store.getPickupPoints().map((point) => ({
      ...point,
      packageText: (point.packageTypes || []).map(packageLabel).join(' / '),
      enabledText: point.enabled ? '启用' : '停用',
      sourceText: point.source === 'default' ? '系统默认' : '后台维护',
      capacityText: point.dailyCapacity > 0 ? `${point.dailyCapacity} 单/日` : '不限量',
      locationText: hasValidCoordinate(point.latitude) && hasValidCoordinate(point.longitude)
        ? `${point.latitude}, ${point.longitude}`
        : '未配置经纬度'
    }));
    const shipmentInputs = this.data.shipmentInputs || {};
    const afterSaleInputs = this.data.afterSaleInputs || {};
    const filter = this.data.orderFilter || { status: 'all', deliveryType: 'all', keyword: '' };
    const sourceOrders = store.getOrders().filter((order) => {
      const statusMatched = filter.status === 'all' || order.status === filter.status;
      const deliveryMatched = filter.deliveryType === 'all' || order.deliveryType === filter.deliveryType;
      const keywordMatched = orderMatchesKeyword(order, String(filter.keyword || '').trim());
      return statusMatched && deliveryMatched && keywordMatched;
    });
    const orders = sourceOrders.slice(0, 30).map((order) => {
      const item = order.items && order.items[0] ? order.items[0] : {};
      const shipment = order.expressShipment || {};
      const companyKey = `${order.id}__company`;
      const trackingKey = `${order.id}__trackingNo`;
      const afterSaleKey = `${order.id}__reason`;
      return {
        ...order,
        maskedPhone: maskPhone(order.buyerPhone),
        hasShippingFee: order.shippingFee !== undefined && order.shippingFee !== null,
        payAmountText: formatMoney(order.payAmount),
        shippingFeeText: formatMoney(order.shippingFee),
        itemName: item.productName || '未知商品',
        itemSpec: `${item.skuName || item.packageLabel || '默认规格'} × ${item.quantity || 1}`,
        statusText: order.statusText || statusLabel(order.status),
        deliveryText: deliveryTypeLabel(order.deliveryType),
        createdAtText: formatDateTime(order.createdAt),
        canShip: order.deliveryType === 'express' && !['completed', 'cancelled', 'refunded'].includes(order.status),
        canPickup: order.deliveryType === 'pickup' && ['awaiting_pickup', 'pickup_shipped'].includes(order.status),
        canComplete: ['shipped', 'picked_up'].includes(order.status),
        canAfterSale: store.canOrderApplyAfterSale(order),
        canRefund: order.status === 'after_sale',
        canCancel: ['awaiting_shipment', 'awaiting_pickup'].includes(order.status),
        shipmentCompanyInput: shipmentInputs[companyKey] !== undefined ? shipmentInputs[companyKey] : (shipment.company || ''),
        shipmentTrackingInput: shipmentInputs[trackingKey] !== undefined ? shipmentInputs[trackingKey] : (shipment.trackingNo || ''),
        afterSaleReasonInput: afterSaleInputs[afterSaleKey] || '',
        shippedText: shipment.shippedAt ? formatDateTime(shipment.shippedAt) : '',
        pickupCodeText: order.pickupCode || '未生成'
      };
    });
    this.setData({
      products,
      whitelistEntries,
      pickupPoints,
      orders,
      shippingRuleForm: createShippingRuleForm(store.getShippingRule())
    });
  },

  onImportInput(event) {
    this.setData({ importText: event.detail.value });
  },

  onDiscountInput(event) {
    this.setData({ discountPercent: Number(event.detail.value) || 80 });
  },

  saveWhitelist() {
    if (!this.ensureAdmin()) return;
    const entries = parsePhoneImport(this.data.importText, this.data.discountPercent);
    if (entries.length === 0) {
      wx.showToast({ title: '没有有效手机号', icon: 'none' });
      return;
    }
    store.appendWhitelistEntries(entries);
    this.setData({ importText: '' });
    this.loadAdmin();
    wx.showToast({ title: `已导入 ${entries.length} 个`, icon: 'success' });
  },

  onShippingRuleInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({
      shippingRuleForm: {
        ...this.data.shippingRuleForm,
        [field]: event.detail.value
      }
    });
  },

  saveShippingRule() {
    if (!this.ensureAdmin()) return;
    const form = this.data.shippingRuleForm;
    store.saveShippingRule({
      expressBaseFee: yuanToCents(form.expressBaseFeeYuan),
      freeShippingThreshold: yuanToCents(form.freeShippingThresholdYuan),
      pickupFee: yuanToCents(form.pickupFeeYuan),
      note: form.note
    });
    this.loadAdmin();
    wx.showToast({ title: '运费规则已保存', icon: 'success' });
  },

  onProductFormInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({
      productForm: {
        ...this.data.productForm,
        [field]: event.detail.value
      }
    });
  },

  chooseProductImage() {
    if (!this.ensureAdmin()) return;
    if (!wx.chooseMedia) {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const filePath = res.tempFilePaths && res.tempFilePaths[0];
          if (filePath) this.saveProductImage(filePath);
        }
      });
      return;
    }

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (filePath) this.saveProductImage(filePath);
      }
    });
  },

  saveProductImage(filePath) {
    this.setData({ imageSaving: true });
    const applyImage = (imagePath) => {
      this.setData({
        imageSaving: false,
        productForm: {
          ...this.data.productForm,
          coverImage: imagePath
        }
      });
      wx.showToast({ title: '主图已选择', icon: 'success' });
    };

    if (!wx.saveFile) {
      applyImage(filePath);
      return;
    }

    wx.saveFile({
      tempFilePath: filePath,
      success: (res) => applyImage(res.savedFilePath || filePath),
      fail: () => applyImage(filePath)
    });
  },

  removeProductImage() {
    this.setData({
      productForm: {
        ...this.data.productForm,
        coverImage: ''
      }
    });
  },

  toggleProductOption(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    const nextForm = {
      ...this.data.productForm,
      [field]: !this.data.productForm[field]
    };
    if (!nextForm.packageBox && !nextForm.packageBag) {
      wx.showToast({ title: '至少选择一种包装', icon: 'none' });
      return;
    }
    if (!nextForm.deliveryPickup && !nextForm.deliveryExpress) {
      wx.showToast({ title: '至少选择一种配送', icon: 'none' });
      return;
    }
    this.setData({ productForm: nextForm });
  },

  setProductSaleType(event) {
    const saleType = event.currentTarget.dataset.type === 'direct' ? 'direct' : 'presale';
    const currentTags = String(this.data.productForm.tagsText || '').trim();
    const nextTags = saleType === 'direct' && currentTags === '新上架 预售'
      ? '新上架 直售'
      : saleType === 'presale' && currentTags === '新上架 直售'
        ? '新上架 预售'
        : currentTags;
    this.setData({
      productForm: {
        ...this.data.productForm,
        saleType,
        tagsText: nextTags,
        shipStart: saleType === 'direct' ? '' : this.data.productForm.shipStart,
        shipEnd: saleType === 'direct' ? '' : this.data.productForm.shipEnd,
        orderDeadline: saleType === 'direct' ? '' : this.data.productForm.orderDeadline
      }
    });
  },

  resetProductForm() {
    this.setData({ productForm: createDefaultProductForm() });
  },

  editProduct(event) {
    if (!this.ensureAdmin()) return;
    const product = store.getProductById(event.currentTarget.dataset.id);
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' });
      return;
    }
    this.setData({ productForm: buildProductForm(product) });
    wx.showToast({ title: '已载入商品编辑', icon: 'none' });
  },

  validateProductForm() {
    const form = this.data.productForm;
    const name = String(form.name || '').trim();
    const salePrice = Number(form.salePriceYuan);
    const price = salePrice;
    const boxStock = Number(form.boxStock || 0);
    const bagStock = Number(form.bagStock || 0);

    if (!name) {
      wx.showToast({ title: '请输入商品名称', icon: 'none' });
      return null;
    }
    if (!form.packageBox && !form.packageBag) {
      wx.showToast({ title: '至少选择一种包装', icon: 'none' });
      return null;
    }
    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      wx.showToast({ title: '请输入价格', icon: 'none' });
      return null;
    }
    const scheduleError = validateProductSchedule(form);
    if (scheduleError) {
      wx.showToast({ title: scheduleError, icon: 'none' });
      return null;
    }
    if (form.packageBox && (!Number.isFinite(boxStock) || boxStock <= 0)) {
      wx.showToast({ title: '盒装库存必须大于0', icon: 'none' });
      return null;
    }
    if (form.packageBag && (!Number.isFinite(bagStock) || bagStock <= 0)) {
      wx.showToast({ title: '袋装库存必须大于0', icon: 'none' });
      return null;
    }
    if (!form.deliveryPickup && !form.deliveryExpress) {
      wx.showToast({ title: '至少选择一种配送', icon: 'none' });
      return null;
    }

    return {
      ...form,
      name,
      packageTypes: [
        ...(form.packageBox ? ['box'] : []),
        ...(form.packageBag ? ['bag'] : [])
      ],
      deliveryMethods: [
        ...(form.deliveryPickup ? ['pickup'] : []),
        ...(form.deliveryExpress ? ['express'] : [])
      ],
      saleType: form.saleType === 'direct' ? 'direct' : 'presale',
      shipStart: form.saleType === 'direct' ? '' : form.shipStart,
      shipEnd: form.saleType === 'direct' ? '' : form.shipEnd,
      orderDeadline: form.saleType === 'direct' ? '' : form.orderDeadline,
      salePriceYuan: salePrice,
      boxStock,
      bagStock,
      coverImage: form.coverImage
    };
  },

  saveProduct() {
    if (!this.ensureAdmin()) return;
    const payload = this.validateProductForm();
    if (!payload) return;
    if (payload.id) {
      store.updateProduct(payload.id, payload);
      wx.showToast({ title: '商品已保存', icon: 'success' });
    } else {
      store.createProduct(payload);
      wx.showToast({ title: '商品已新增', icon: 'success' });
    }
    this.setData({ productForm: createDefaultProductForm() });
    this.loadAdmin();
  },

  createProduct() {
    this.saveProduct();
  },

  deleteProduct(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const product = store.getProductById(id);
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除商品',
      content: `确定删除“${product.name}”吗？删除后买家端不再展示，本地 mock 数据不可恢复。`,
      confirmText: '删除',
      confirmColor: '#d93025',
      success: (res) => {
        if (!res.confirm) return;
        store.deleteProduct(id);
        if (this.data.productForm.id === id) this.resetProductForm();
        this.loadAdmin();
        wx.showToast({ title: '商品已删除', icon: 'success' });
      }
    });
  },

  manualOff(event) {
    if (!this.ensureAdmin()) return;
    store.updateProductOverride(event.currentTarget.dataset.id, { status: 'off_sale_manual' });
    this.loadAdmin();
  },

  manualOn(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const product = store.getProductById(id);
    if (!product || product.stock <= 0) {
      wx.showToast({ title: '请先给规格补货', icon: 'none' });
      return;
    }
    store.updateProductOverride(id, { status: 'on_sale' });
    this.loadAdmin();
  },

  zeroStock(event) {
    if (!this.ensureAdmin()) return;
    store.zeroProductSkuStocks(event.currentTarget.dataset.id);
    this.loadAdmin();
  },

  onStockInput(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    this.setData({
      stockInputs: {
        ...this.data.stockInputs,
        [key]: event.detail.value
      }
    });
  },

  applyStock(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const skuId = event.currentTarget.dataset.skuid;
    const key = event.currentTarget.dataset.key;
    const rawValue = this.data.stockInputs[key];
    if (rawValue === undefined || rawValue === '') {
      wx.showToast({ title: '请输入规格库存', icon: 'none' });
      return;
    }
    const numberValue = Number(rawValue);
    if (!Number.isFinite(numberValue) || numberValue < 0) {
      wx.showToast({ title: '库存不能为负数', icon: 'none' });
      return;
    }
    const value = Math.floor(numberValue);
    store.updateSkuStock(id, skuId, value);
    this.loadAdmin();
    this.setData({
      stockInputs: {
        ...this.data.stockInputs,
        [key]: ''
      }
    });
    wx.showToast({ title: '规格库存已更新', icon: 'success' });
  },

  addStock(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const skuId = event.currentTarget.dataset.skuid;
    const key = event.currentTarget.dataset.key;
    const delta = Math.max(0, Math.floor(Number(this.data.stockInputs[key]) || 0));
    if (!skuId || delta <= 0) {
      wx.showToast({ title: '请输入入库数量', icon: 'none' });
      return;
    }
    store.addSkuStock(id, skuId, delta);
    this.loadAdmin();
    this.setData({
      stockInputs: {
        ...this.data.stockInputs,
        [key]: ''
      }
    });
    wx.showToast({ title: `已入库 ${delta}`, icon: 'success' });
  },

  onPickupFormInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({
      pickupForm: {
        ...this.data.pickupForm,
        [field]: event.detail.value
      }
    });
  },

  togglePickupOption(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    const nextForm = {
      ...this.data.pickupForm,
      [field]: !this.data.pickupForm[field]
    };
    if (!nextForm.packageBox && !nextForm.packageBag) {
      wx.showToast({ title: '至少选择一种支持包装', icon: 'none' });
      return;
    }
    this.setData({ pickupForm: nextForm });
  },

  editPickupPoint(event) {
    if (!this.ensureAdmin()) return;
    const point = store.getPickupPointById(event.currentTarget.dataset.id);
    if (!point) {
      wx.showToast({ title: '自提点不存在', icon: 'none' });
      return;
    }
    this.setData({ pickupForm: buildPickupForm(point) });
    wx.showToast({ title: '已载入编辑', icon: 'none' });
  },

  resetPickupForm() {
    this.setData({ pickupForm: createDefaultPickupForm() });
  },

  savePickupPoint() {
    if (!this.ensureAdmin()) return;
    const form = this.data.pickupForm;
    const name = String(form.name || '').trim();
    const address = String(form.address || '').trim();
    const latitude = String(form.latitude || '').trim();
    const longitude = String(form.longitude || '').trim();
    const dailyCapacity = Number(form.dailyCapacity || 0);
    const sortWeight = Number(form.sortWeight || 0);

    if (!name) {
      wx.showToast({ title: '请输入自提点名称', icon: 'none' });
      return;
    }
    if (!address) {
      wx.showToast({ title: '请输入自提点地址', icon: 'none' });
      return;
    }
    if ((latitude || longitude) && (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)))) {
      wx.showToast({ title: '经纬度需同时为数字', icon: 'none' });
      return;
    }
    if (!form.packageBox && !form.packageBag) {
      wx.showToast({ title: '至少选择一种支持包装', icon: 'none' });
      return;
    }
    if (!Number.isFinite(dailyCapacity) || dailyCapacity < 0) {
      wx.showToast({ title: '每日容量不能为负数', icon: 'none' });
      return;
    }
    if (!Number.isFinite(sortWeight)) {
      wx.showToast({ title: '排序权重需为数字', icon: 'none' });
      return;
    }

    store.upsertPickupPoint({
      id: form.id,
      name,
      address,
      latitude: latitude ? Number(latitude) : '',
      longitude: longitude ? Number(longitude) : '',
      phone: form.phone,
      openTime: form.openTime,
      dailyCapacity,
      sortWeight,
      notice: form.notice,
      packageTypes: [
        ...(form.packageBox ? ['box'] : []),
        ...(form.packageBag ? ['bag'] : [])
      ],
      enabled: form.enabled
    });
    this.setData({ pickupForm: createDefaultPickupForm() });
    this.loadAdmin();
    wx.showToast({ title: '自提点已保存', icon: 'success' });
  },

  togglePickupEnabled(event) {
    if (!this.ensureAdmin()) return;
    const point = store.getPickupPointById(event.currentTarget.dataset.id);
    if (!point) {
      wx.showToast({ title: '自提点不存在', icon: 'none' });
      return;
    }
    store.togglePickupPoint(point.id, !point.enabled);
    this.loadAdmin();
  },

  deletePickupPoint(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const point = store.getPickupPointById(id);
    if (!point) {
      wx.showToast({ title: '自提点不存在', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除自提点',
      content: `确定删除“${point.name}”吗？买家端将不再展示该点位。`,
      confirmText: '删除',
      confirmColor: '#d93025',
      success: (res) => {
        if (!res.confirm) return;
        store.deletePickupPoint(id);
        if (this.data.pickupForm.id === id) this.resetPickupForm();
        this.loadAdmin();
        wx.showToast({ title: '自提点已删除', icon: 'success' });
      }
    });
  },

  onOrderKeywordInput(event) {
    this.setData({
      orderFilter: {
        ...this.data.orderFilter,
        keyword: event.detail.value
      }
    });
    this.loadAdmin();
  },

  setOrderStatusFilter(event) {
    this.setData({
      orderFilter: {
        ...this.data.orderFilter,
        status: event.currentTarget.dataset.status
      }
    });
    this.loadAdmin();
  },

  setOrderDeliveryFilter(event) {
    this.setData({
      orderFilter: {
        ...this.data.orderFilter,
        deliveryType: event.currentTarget.dataset.delivery
      }
    });
    this.loadAdmin();
  },

  onShipmentInput(event) {
    const id = event.currentTarget.dataset.id;
    const field = event.currentTarget.dataset.field;
    if (!id || !field) return;
    this.setData({
      shipmentInputs: {
        ...this.data.shipmentInputs,
        [`${id}__${field}`]: event.detail.value
      }
    });
  },

  onAfterSaleInput(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    this.setData({
      afterSaleInputs: {
        ...this.data.afterSaleInputs,
        [`${id}__reason`]: event.detail.value
      }
    });
  },

  shipOrder(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const order = store.getOrderById(id);
    if (!order || order.deliveryType !== 'express') {
      wx.showToast({ title: '不是快递订单', icon: 'none' });
      return;
    }
    const company = String(this.data.shipmentInputs[`${id}__company`] || (order.expressShipment && order.expressShipment.company) || '').trim();
    const trackingNo = String(this.data.shipmentInputs[`${id}__trackingNo`] || (order.expressShipment && order.expressShipment.trackingNo) || '').trim();
    if (!company) {
      wx.showToast({ title: '请输入快递公司', icon: 'none' });
      return;
    }
    if (!trackingNo) {
      wx.showToast({ title: '请输入快递单号', icon: 'none' });
      return;
    }
    store.markOrderShipped(id, { company, trackingNo });
    this.loadAdmin();
    wx.showToast({ title: '已标记发货', icon: 'success' });
  },

  markPickedUp(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const order = store.getOrderById(id);
    if (!order || order.deliveryType !== 'pickup') {
      wx.showToast({ title: '不是自提订单', icon: 'none' });
      return;
    }
    store.markOrderPickedUp(id);
    this.loadAdmin();
    wx.showToast({ title: '已核销自提', icon: 'success' });
  },

  completeOrder(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const order = store.getOrderById(id);
    if (!order) {
      wx.showToast({ title: '订单不存在', icon: 'none' });
      return;
    }
    store.markOrderCompleted(id);
    this.loadAdmin();
    wx.showToast({ title: '订单已完成', icon: 'success' });
  },

  markAfterSale(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    const reason = this.data.afterSaleInputs[`${id}__reason`] || '客户售后处理中';
    const updatedOrder = store.markOrderAfterSale(id, reason);
    if (!updatedOrder) {
      wx.showToast({ title: '当前订单状态不可售后', icon: 'none' });
      return;
    }
    this.loadAdmin();
    wx.showToast({ title: '已标记售后', icon: 'success' });
  },

  markRefunded(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    store.markOrderRefunded(id);
    this.loadAdmin();
    wx.showToast({ title: '已标记退款', icon: 'success' });
  },

  cancelOrder(event) {
    if (!this.ensureAdmin()) return;
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '取消订单',
      content: '确定将该订单标记为已取消吗？当前为本地 mock，不会自动回补库存。',
      confirmText: '取消订单',
      confirmColor: '#d93025',
      success: (res) => {
        if (!res.confirm) return;
        store.cancelOrder(id);
        this.loadAdmin();
        wx.showToast({ title: '订单已取消', icon: 'success' });
      }
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/profile/profile' });
  }
});
