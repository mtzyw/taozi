const store = require('../../utils/store');
const backend = require('../../utils/backend');
const auth = require('../../utils/auth');
const { calculateProductPrice, normalizePhone, getProductSku } = require('../../utils/pricing');
const { canPurchase } = require('../../utils/inventory');
const { sortPickupPoints } = require('../../utils/distance');
const { getUserLocation, locationErrorMessage } = require('../../utils/location');
const { formatMoney, packageTypeLabel, deliveryTypeLabel, maskPhone } = require('../../utils/format');

const DELIVERY_LABELS = {
  pickup: '自提',
  express: '快递'
};

function makePickupCode() {
  return String(Date.now()).slice(-6).padStart(6, '0');
}

function makeClientOrderId() {
  return `${Date.now()}${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;
}

function requestWechatPayment(payment) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.requestPayment !== 'function') {
      reject(new Error('当前环境不支持微信支付'));
      return;
    }
    wx.requestPayment({
      timeStamp: String(payment.timeStamp || ''),
      nonceStr: payment.nonceStr || '',
      package: payment.package || '',
      signType: payment.signType || 'RSA',
      paySign: payment.paySign || '',
      success: resolve,
      fail(error) {
        reject(new Error(error && error.errMsg || '支付未完成'));
      }
    });
  });
}

function buildDeliveryOptions(enabledMethods) {
  const methods = enabledMethods && enabledMethods.length ? enabledMethods : ['pickup'];
  return ['pickup', 'express'].map((type) => ({
    type,
    label: DELIVERY_LABELS[type],
    enabled: methods.includes(type)
  }));
}

function getSkuDeliveryMethods(sku, product) {
  if (sku && sku.packageType === 'bag') return ['pickup'];
  const methods = sku && Array.isArray(sku.deliveryMethods) && sku.deliveryMethods.length
    ? sku.deliveryMethods
    : product && Array.isArray(product.deliveryMethods) && product.deliveryMethods.length
      ? product.deliveryMethods
      : ['pickup'];
  return methods.filter((type) => type === 'pickup' || type === 'express');
}

function detectExpressZone(address, rule = {}) {
  const localRegions = Array.isArray(rule.localRegions) && rule.localRegions.length
    ? rule.localRegions
    : ['成都', '成都市', '重庆', '重庆市'];
  const text = String(address || '').replace(/\s+/g, '');
  if (text && localRegions.some((region) => region && text.includes(region))) return 'local';
  return 'remote';
}

function calculateShippingFee(rule, deliveryType, goodsAmount, expressAddress = '', quantity = 1) {
  if (!rule) return store.calculateShippingFee({ deliveryType, goodsAmount, expressAddress, quantity });
  if (deliveryType !== 'express') {
    const fee = Number(rule.pickupFee || 0);
    return {
      fee,
      label: fee > 0 ? '自提服务费' : '自提免运费',
      rule
    };
  }
  const amount = Number(goodsAmount || 0);
  if (Number(rule.freeShippingThreshold || 0) > 0 && amount >= Number(rule.freeShippingThreshold)) {
    return { fee: 0, label: '已满足快递包邮', rule };
  }
  const zone = detectExpressZone(expressAddress, rule);
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  const unitFee = zone === 'local'
    ? Number(rule.localExpressFee ?? rule.expressBaseFee ?? 0)
    : Number(rule.remoteExpressFee ?? rule.expressBaseFee ?? 0);
  const fee = unitFee * count;
  return {
    fee,
    unitFee,
    quantity: count,
    label: fee > 0 ? (zone === 'local' ? '本地快递运费' : '省外快递运费') : '快递免运费',
    zone,
    rule
  };
}

function parseQuantityInput(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  const quantity = Math.floor(Number(digits));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : '';
}

function normalizeQuantity(value, fallback = 1) {
  const quantity = Math.floor(Number(value));
  if (!Number.isFinite(quantity) || quantity < 1) return fallback;
  return quantity;
}

function normalizeDiscountTrace(trace = []) {
  return trace.filter((item) => item.type !== 'product_sale').map((item) => ({
    ...item,
    amountText: formatMoney(item.amount)
  }));
}

function filterPickupPointsForProduct(points, product) {
  const pickupPointIds = Array.isArray(product && product.pickupPointIds)
    ? product.pickupPointIds.map((id) => String(id))
    : [];
  if (!pickupPointIds.length) return points;
  return (points || []).filter((point) => pickupPointIds.includes(String(point.id)));
}

function sortAvailablePickupPoints(points, product, userLocation, packageType) {
  return sortPickupPoints(filterPickupPointsForProduct(points, product), userLocation, packageType);
}

function defaultPickupId(sortedPoints, currentSelectedId, shouldKeepCurrent) {
  const selectedPickupExists = sortedPoints.some((point) => point.id === currentSelectedId);
  if (shouldKeepCurrent && selectedPickupExists) return currentSelectedId;
  return (sortedPoints[0] && sortedPoints[0].id) || '';
}

Page({
  data: {
    product: null,
    skuId: '',
    sku: null,
    skuName: '',
    skuWeightText: '',
    skuSalePriceText: '0.00',
    skuStock: 0,
    packageType: 'box',
    packageLabel: '盒装',
    quantity: 1,
    phone: '',
    couponCode: '',
    deliveryType: 'pickup',
    deliveryOptions: buildDeliveryOptions(['pickup']),
    pickupPoints: [],
    selectedPickupId: '',
    price: null,
    trace: [],
    couponError: '',
    note: '',
    addresses: [],
    selectedAddressId: '',
    expressReceiver: '',
    expressPhone: '',
    expressAddress: '',
    saveAddressToBook: true,
    isPaying: false,
    isBindingPhone: false,
    isLocating: false,
    userLocation: null,
    locationStatus: 'idle',
    locationTip: '授权定位后，自提点会按距离由近到远排序。',
    usingBackend: false,
    shippingRule: null,
    backendDiscount: null,
    backendDiscountPhone: '',
    backendDiscountProductId: ''
  },

  onLoad(options) {
    this.productId = options.id;
    this.skuId = options.skuId || options.packageType || '';
    this.setData({
      skuId: this.skuId,
      packageType: options.packageType || 'box',
      packageLabel: packageTypeLabel(options.packageType || 'box'),
      phone: store.getCurrentPhone()
    });
    this.loadCheckout();
  },

  onShow() {
    if (this.productId) this.loadAddressBook(false);
  },

  async loadAddressBook(shouldPrefill = true) {
    const ownerPhone = normalizePhone(this.data.phone || store.getCurrentPhone());
    let sourceAddresses = [];
    let loadedFromBackend = false;
    try {
      if (/^1\d{10}$/.test(ownerPhone)) {
        sourceAddresses = await backend.listAddresses(ownerPhone);
        loadedFromBackend = true;
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
    const patch = { addresses };
    const selectedAddress = addresses.find((address) => address.id === this.data.selectedAddressId);
    const defaultAddress = addresses.find((address) => address.isDefault) || addresses[0] || (loadedFromBackend ? null : store.getDefaultAddress());
    if (this.data.deliveryType === 'express' && selectedAddress) {
      Object.assign(patch, {
        selectedAddressId: selectedAddress.id,
        expressReceiver: selectedAddress.receiver,
        expressPhone: selectedAddress.phone,
        expressAddress: selectedAddress.address
      });
    } else if (this.data.deliveryType === 'express' && this.data.selectedAddressId && !selectedAddress) {
      Object.assign(patch, {
        selectedAddressId: '',
        expressReceiver: '',
        expressPhone: '',
        expressAddress: ''
      });
    } else if (shouldPrefill && this.data.deliveryType === 'express' && defaultAddress && !this.data.expressAddress) {
      Object.assign(patch, {
        selectedAddressId: defaultAddress.id,
        expressReceiver: defaultAddress.receiver,
        expressPhone: defaultAddress.phone,
        expressAddress: defaultAddress.address
      });
    }
    const shouldRecalculate = Object.prototype.hasOwnProperty.call(patch, 'expressAddress');
    this.setData(patch);
    if (shouldRecalculate) this.recalculate();
  },

  async loadCheckout() {
    let product = null;
    let pickupPoints = [];
    let shippingRule = null;
    let usingBackend = false;
    const refreshKey = store.getInventoryChangedAt() || Date.now();
    try {
      product = await backend.getProductById(this.productId, { refreshKey });
      pickupPoints = await backend.listPickupPoints();
      shippingRule = await backend.getShippingRule().catch(() => null);
      usingBackend = Boolean(product);
    } catch (_) {
      product = store.getProductById(this.productId);
      pickupPoints = store.getPickupPoints();
      shippingRule = store.getShippingRule();
    }
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' });
      return;
    }

    const sku = getProductSku(product, this.data.skuId || this.skuId || this.data.packageType);
    const packageType = sku ? sku.packageType : this.data.packageType;
    const packageLabel = sku ? sku.label : packageTypeLabel(packageType);
    const enabledMethods = getSkuDeliveryMethods(sku, product);
    const deliveryType = enabledMethods.includes(this.data.deliveryType) ? this.data.deliveryType : enabledMethods[0];
    let backendDiscount = null;
    const phone = normalizePhone(this.data.phone);
    if (usingBackend && /^1\d{10}$/.test(phone)) {
      backendDiscount = await backend.getWhitelistDiscount(phone, product.id).catch(() => null);
      this.setData({
        backendDiscount,
        backendDiscountPhone: phone,
        backendDiscountProductId: product.id
      });
    }
    this.allPickupPoints = pickupPoints;
    const sortedPoints = sortAvailablePickupPoints(pickupPoints, product, this.data.userLocation, packageType);
    const selectedPickupId = defaultPickupId(sortedPoints, this.data.selectedPickupId, Boolean(this.pickupManuallySelected));

    this.setData({
      product: {
        ...product,
        payPriceText: formatMoney(sku ? sku.salePrice : product.salePrice),
        statusText: product.status
      },
      skuId: sku ? sku.id : '',
      sku,
      skuName: sku ? sku.name : packageLabel,
      skuWeightText: sku ? sku.weightText : '',
      skuSalePriceText: formatMoney(sku ? sku.salePrice : product.salePrice),
      skuStock: sku ? sku.stock : product.stock,
      packageType,
      packageLabel,
      deliveryType,
      deliveryOptions: buildDeliveryOptions(enabledMethods),
      pickupPoints: sortedPoints,
      selectedPickupId,
      usingBackend,
      shippingRule
    });
    this.loadAddressBook(true);
    this.recalculate();
    if (deliveryType === 'pickup' && !this.locationRequested && !this.data.userLocation) {
      this.refreshUserLocation(false);
    }
  },

  applyPickupPointSorting(userLocation = this.data.userLocation) {
    const product = this.data.product || store.getProductById(this.productId);
    if (!product) return;
    const packageType = this.data.packageType;
    const sourcePoints = this.allPickupPoints || this.data.pickupPoints || [];
    const sortedPoints = sortAvailablePickupPoints(sourcePoints, product, userLocation, packageType);
    const selectedPickupId = defaultPickupId(sortedPoints, this.data.selectedPickupId, Boolean(this.pickupManuallySelected));
    this.setData({
      pickupPoints: sortedPoints,
      selectedPickupId
    });
  },

  async refreshUserLocation(eventOrShowToast = true) {
    const showToast = eventOrShowToast !== false;
    if (this.data.isLocating) return;
    this.locationRequested = true;
    this.setData({
      isLocating: true,
      locationStatus: 'locating',
      locationTip: '正在获取你的位置，用于按距离排序自提点…'
    });
    try {
      const userLocation = await getUserLocation();
      this.setData({
        userLocation,
        isLocating: false,
        locationStatus: 'located',
        locationTip: '已按你当前位置由近到远排序。'
      });
      this.applyPickupPointSorting(userLocation);
      if (showToast) wx.showToast({ title: '已按距离排序', icon: 'success' });
    } catch (error) {
      const tip = locationErrorMessage(error);
      this.setData({
        isLocating: false,
        locationStatus: 'failed',
        locationTip: tip
      });
      if (showToast) wx.showToast({ title: tip, icon: 'none' });
    }
  },

  async recalculate() {
    const quoteRequestId = (this.quoteRequestId || 0) + 1;
    this.quoteRequestId = quoteRequestId;
    const product = this.data.product || store.getProductById(this.productId);
    if (!product) return;
    const sku = getProductSku(product, this.data.skuId || this.data.packageType);
    const quantity = normalizeQuantity(this.data.quantity, 1);
    let whitelistEntries = store.getWhitelistEntries();
    const phone = normalizePhone(this.data.phone);
    if (this.data.usingBackend && /^1\d{10}$/.test(phone)) {
      let backendDiscount = this.data.backendDiscountPhone === phone && this.data.backendDiscountProductId === product.id
        ? this.data.backendDiscount
        : null;
      if (!backendDiscount) {
        backendDiscount = await backend.getWhitelistDiscount(phone, product.id).catch(() => null);
        this.setData({ backendDiscount, backendDiscountPhone: phone, backendDiscountProductId: product.id });
      }
      if (backendDiscount) {
        whitelistEntries = [{
          phone,
          discountPercent: backendDiscount.percent,
          label: backendDiscount.label,
          source: backendDiscount.source,
          productIds: [product.id]
        }];
      }
    }
    let price = calculateProductPrice({
      product,
      sku,
      quantity,
      phone,
      whitelistEntries,
      couponCode: this.data.couponCode
    });
    let shipping = calculateShippingFee(this.data.shippingRule, this.data.deliveryType, price.payAmount, this.data.expressAddress, quantity);
    let couponError = price.couponError || '';

    if (this.data.usingBackend && sku) {
      try {
        const quote = await backend.quoteOrder({
          buyerPhone: phone,
          items: [{
            productId: product.id,
            skuId: sku.id,
            packageType: sku.packageType,
            quantity
          }],
          deliveryType: this.data.deliveryType,
          pickupPointId: this.data.selectedPickupId,
          expressInfo: this.data.deliveryType === 'express' ? {
            receiver: this.data.expressReceiver,
            phone: this.data.expressPhone || phone,
            address: this.data.expressAddress
          } : undefined,
          couponCode: this.data.couponCode
        });
        if (quoteRequestId !== this.quoteRequestId) return;
        if (quote) {
          price = {
            originalTotal: quote.originalTotal,
            saleTotal: quote.saleTotal,
            payAmount: quote.goodsAmount,
            quantity,
            unitPrice: quote.unitPrice,
            sku,
            trace: quote.discountTrace || [],
            whitelistDiscount: null,
            coupon: quote.couponCode ? { code: quote.couponCode } : null,
            couponError: ''
          };
          shipping = quote.shipping || shipping;
          couponError = '';
        }
      } catch (error) {
        if (quoteRequestId !== this.quoteRequestId) return;
        couponError = this.data.couponCode ? (error.message || '优惠码暂不可用') : '';
      }
    }

    if (quoteRequestId !== this.quoteRequestId) return;
    const payAmount = price.payAmount + shipping.fee;
    this.setData({
      price: {
        ...price,
        goodsPayAmount: price.payAmount,
        shippingFee: shipping.fee,
        shippingLabel: shipping.label,
        shippingRuleNote: shipping.rule && shipping.rule.note ? shipping.rule.note : '',
        originalTotalText: formatMoney(price.originalTotal),
        saleTotalText: formatMoney(price.saleTotal),
        goodsPayAmountText: formatMoney(price.payAmount),
        shippingFeeText: formatMoney(shipping.fee),
        payAmount,
        payAmountText: formatMoney(payAmount)
      },
      trace: normalizeDiscountTrace(price.trace),
      couponError
    });
  },

  onQuantityInput(event) {
    const quantity = parseQuantityInput(event.detail.value);
    this.setData({ quantity });
    if (quantity === '') return;
    this.recalculate();
  },

  onQuantityBlur() {
    const quantity = normalizeQuantity(this.data.quantity, 1);
    this.setData({ quantity });
    this.recalculate();
  },

  onPhoneInput(event) {
    this.setData({ phone: event.detail.value });
    this.recalculate();
    if (this.data.deliveryType === 'express') this.loadAddressBook(false);
  },

  async bindPhoneFromEvent(event) {
    if (this.data.isBindingPhone) return;
    this.setData({ isBindingPhone: true });
    try {
      const phone = await auth.bindPhoneFromEvent(event);
      this.setData({
        phone,
        backendDiscount: null,
        backendDiscountPhone: '',
        backendDiscountProductId: ''
      });
      await this.recalculate();
      if (this.data.deliveryType === 'express') await this.loadAddressBook(false);
      wx.showToast({ title: '手机号已绑定', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '手机号授权失败', icon: 'none' });
    } finally {
      this.setData({ isBindingPhone: false });
    }
  },

  async onSubmitPhoneNumber(event) {
    await this.bindPhoneFromEvent(event);
    if (/^1\d{10}$/.test(normalizePhone(this.data.phone))) {
      await this.simulatePay();
    }
  },

  onCouponInput(event) {
    this.setData({ couponCode: event.detail.value.toUpperCase() });
    this.recalculate();
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  onExpressReceiverInput(event) {
    this.setData({ expressReceiver: event.detail.value, selectedAddressId: '' });
  },

  onExpressPhoneInput(event) {
    this.setData({ expressPhone: event.detail.value, selectedAddressId: '' });
  },

  onExpressAddressInput(event) {
    this.setData({ expressAddress: event.detail.value, selectedAddressId: '' });
    this.recalculate();
  },

  onSaveAddressSwitch(event) {
    this.setData({ saveAddressToBook: event.detail.value });
  },

  selectDelivery(event) {
    const type = event.currentTarget.dataset.type;
    const option = this.data.deliveryOptions.find((item) => item.type === type);
    if (!option || !option.enabled) {
      wx.showToast({ title: '当前规格不支持该配送方式', icon: 'none' });
      return;
    }
    this.setData({ deliveryType: type }, () => {
      if (type === 'express') this.loadAddressBook(true);
      this.recalculate();
    });
  },

  selectPickup(event) {
    this.pickupManuallySelected = true;
    this.setData({ selectedPickupId: event.currentTarget.dataset.id });
  },

  selectAddress(event) {
    const address = (this.data.addresses || []).find((item) => item.id === event.currentTarget.dataset.id)
      || store.getAddresses().find((item) => item.id === event.currentTarget.dataset.id);
    if (!address) return;
    this.setData({
      selectedAddressId: address.id,
      expressReceiver: address.receiver,
      expressPhone: address.phone,
      expressAddress: address.address
    }, () => this.recalculate());
  },

  goAddress() {
    wx.navigateTo({ url: '/pages/address/address' });
  },

  async simulatePay() {
    if (this.submitLock || this.data.isPaying) return;
    this.submitLock = true;
    this.setData({ isPaying: true });
    let shouldUnlockSubmit = true;
    try {
    const phone = normalizePhone(this.data.phone);
    const product = this.data.product || store.getProductById(this.productId);
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' });
      return;
    }
    const sku = getProductSku(product, this.data.skuId || this.data.packageType);
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入正确手机号', icon: 'none' });
      return;
    }
    const quantity = normalizeQuantity(this.data.quantity, 0);
    if (!quantity) {
      wx.showToast({ title: '请输入购买数量', icon: 'none' });
      return;
    }
    this.setData({ quantity });
    if (!canPurchase(product, quantity, sku ? sku.id : this.data.packageType)) {
      wx.showToast({ title: '库存不足或已下架', icon: 'none' });
      return;
    }
    await this.recalculate();
    if (this.data.deliveryType === 'pickup' && !this.data.selectedPickupId) {
      wx.showToast({ title: '请选择自提点', icon: 'none' });
      return;
    }
    if (this.data.couponError) {
      wx.showToast({ title: this.data.couponError, icon: 'none' });
      return;
    }
    if (this.data.deliveryType === 'express') {
      const expressPhone = normalizePhone(this.data.expressPhone || phone);
      if (!this.data.expressReceiver.trim()) {
        wx.showToast({ title: '请填写收货人', icon: 'none' });
        return;
      }
      if (!/^1\d{10}$/.test(expressPhone)) {
        wx.showToast({ title: '请填写收货手机号', icon: 'none' });
        return;
      }
      if (!this.data.expressAddress.trim()) {
        wx.showToast({ title: '请填写快递地址', icon: 'none' });
        return;
      }
      if (this.data.saveAddressToBook) {
        const addressPayload = {
          id: this.data.selectedAddressId,
          buyerPhone: phone,
          receiver: this.data.expressReceiver,
          phone: expressPhone,
          address: this.data.expressAddress,
          isDefault: true
        };
        if (this.data.usingBackend) {
          const savedAddress = await backend.upsertAddress(addressPayload).catch(() => null);
          store.upsertAddress(savedAddress || addressPayload);
        } else {
          store.upsertAddress(addressPayload);
        }
      }
    }

    store.setCurrentPhone(phone);
    const pickup = this.data.pickupPoints.find((point) => point.id === this.data.selectedPickupId) || null;
    const expressInfo = this.data.deliveryType === 'express' ? {
      receiver: this.data.expressReceiver.trim(),
      phone: normalizePhone(this.data.expressPhone || phone),
      address: this.data.expressAddress.trim()
    } : null;
    const isExpress = this.data.deliveryType === 'express';
    const now = new Date().toISOString();
    const backendPayFlow = Boolean(this.data.usingBackend);
    const status = backendPayFlow ? 'awaiting_payment' : (isExpress ? 'awaiting_shipment' : 'awaiting_pickup');
    const orderDraft = {
      buyerPhone: phone,
      items: [{
        productId: product.id,
        productName: product.name,
        skuId: sku ? sku.id : '',
        skuName: sku ? sku.name : this.data.packageLabel,
        weightText: sku ? sku.weightText : '',
        packageType: this.data.packageType,
        packageLabel: this.data.packageLabel,
        quantity,
        unitPrice: this.data.price.unitPrice
      }],
      deliveryType: this.data.deliveryType,
      deliveryLabel: deliveryTypeLabel(this.data.deliveryType),
      saleType: product.saleType === 'direct' ? 'direct' : 'presale',
      pickupPointId: pickup ? pickup.id : '',
      pickupPointName: pickup ? pickup.name : '',
      customerContact: product.customerContact || '',
      customerPhone: product.customerPhone || '',
      pickupValidHours: this.data.deliveryType === 'pickup' ? Number(product.pickupValidHours || 0) : 0,
      fulfillmentStart: product.saleType === 'direct' ? '' : product.shipStart || '',
      fulfillmentEnd: product.saleType === 'direct' ? '' : product.shipEnd || '',
      expressInfo,
      couponCode: this.data.usingBackend || (this.data.price && this.data.price.coupon) ? this.data.couponCode : '',
      discountTrace: this.data.trace,
      totalAmount: this.data.price.saleTotal,
      goodsAmount: this.data.price.goodsPayAmount,
      shippingFee: this.data.price.shippingFee,
      shippingLabel: this.data.price.shippingLabel,
      shippingRuleSnapshot: store.getShippingRule(),
      payAmount: this.data.price.payAmount,
      pickupCode: isExpress ? '' : makePickupCode(),
      status,
      statusText: backendPayFlow ? '待支付' : (isExpress ? '待发货' : '备货中'),
      paidAt: backendPayFlow ? '' : now,
      note: this.data.note,
      fulfillmentLogs: backendPayFlow ? [{
        action: 'stock_locked',
        detail: '已锁定库存，等待支付',
        createdAt: now
      }] : [{
        action: 'mock_paid',
        detail: '支付成功',
        createdAt: now
      }],
      payNow: !backendPayFlow
    };

    const orderId = this.submitOrderId || makeClientOrderId();
    this.submitOrderId = orderId;
    orderDraft.id = orderId;
    let order = null;
    try {
      if (this.data.usingBackend) {
        order = await backend.createOrder(orderDraft);
        const session = await auth.ensureWechatSession().catch(() => null);
        const payResult = await backend.payOrder(order.id, {
          sessionId: session && session.sessionId || ''
        });
        if (payResult && payResult.payment) {
          await requestWechatPayment(payResult.payment);
          const confirmResult = await backend.confirmPayment(order.id).catch(() => null);
          order = (confirmResult && confirmResult.order) || (payResult && payResult.order) || order;
        } else {
          order = (payResult && payResult.order) || order;
        }
      } else {
        order = store.createOrder(orderDraft);
        store.decrementStock(product.id, quantity, sku ? sku.id : this.data.packageType);
      }
      store.markInventoryChanged();
    } catch (error) {
      const message = error.message || '下单失败';
      wx.showToast({ title: /requestPayment:fail cancel/i.test(message) ? '已取消支付' : message, icon: 'none' });
      return;
    }

    shouldUnlockSubmit = false;
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/payment-success/payment-success?orderId=${order.id}` });
      }, 500);
    } finally {
      if (shouldUnlockSubmit) {
        this.submitOrderId = '';
        this.submitLock = false;
        this.setData({ isPaying: false });
      }
    }
  }
});
