const store = require('../../utils/store');
const backend = require('../../utils/backend');
const auth = require('../../utils/auth');
const { calculateProductPrice, getProductSkus, getProductSku, getWhitelistDiscount } = require('../../utils/pricing');
const { latestOnSaleProduct } = require('../../utils/inventory');
const { formatMoney, packageTypeLabel, statusLabel } = require('../../utils/format');

Page({
  data: {
    product: null,
    selectedPackage: '',
    selectedSkuId: '',
    selectedSku: null,
    selectedSkuStock: 0,
    priceInfo: null,
    packageOptions: [],
    latestProduct: null,
    currentPhone: '',
    isBindingPhone: false,
    isWhitelistUser: false,
    whitelistLabel: ''
  },

  onLoad(options) {
    this.productId = options.id;
    this.loadProduct();
  },

  onShow() {
    if (this.productId) this.loadProduct();
  },

  async loadProduct() {
    const loadRequestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = loadRequestId;
    let product = null;
    let shippingRule = null;
    const refreshKey = store.getInventoryChangedAt() || Date.now();
    try {
      product = await backend.getProductById(this.productId, { refreshKey });
      shippingRule = await backend.getShippingRule().catch(() => null);
    } catch (_) {
      product = store.getProductById(this.productId);
    }
    if (loadRequestId !== this.loadRequestId) return;
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' });
      return;
    }
    const skus = getProductSkus(product);
    const selectedSku = getProductSku(product, this.data.selectedSkuId || this.data.selectedPackage);
    const selectedPackage = selectedSku ? selectedSku.packageType : product.packageTypes[0];
    const phone = store.getCurrentPhone();
    let whitelistEntries = store.getWhitelistEntries();
    let whitelistDiscount = getWhitelistDiscount(phone, whitelistEntries, product.id);
    try {
      const backendDiscount = await backend.getWhitelistDiscount(phone, product.id);
      if (backendDiscount) {
        whitelistDiscount = backendDiscount;
        whitelistEntries = [{
          phone,
          discountPercent: backendDiscount.percent,
          label: backendDiscount.label,
          source: backendDiscount.source,
          productIds: [product.id]
        }];
      }
    } catch (_) {}
    const price = calculateProductPrice({ product, sku: selectedSku, phone, whitelistEntries });
    let latestProduct = product.isOnSale ? product : null;
    if (!latestProduct) {
      try {
        latestProduct = latestOnSaleProduct(await backend.listProducts({ refreshKey }));
      } catch (_) {
        latestProduct = latestOnSaleProduct(store.getProducts());
      }
    }
    const presaleWindow = product.saleType === 'direct'
      ? '现货销售，下单后按订单顺序安排发货/自提。'
      : [
        product.shipStart && product.shipEnd ? `履约：${product.shipStart} 至 ${product.shipEnd}` : '',
        product.orderDeadline ? `截单：${product.orderDeadline}` : ''
      ].filter(Boolean).join('｜');
    if (!shippingRule) shippingRule = store.getShippingRule();

    this.setData({
      product: {
        ...product,
        images: Array.isArray(product.images) && product.images.length ? product.images : [product.coverImage],
        priceText: formatMoney(selectedSku ? selectedSku.price : product.price),
        salePriceText: formatMoney(selectedSku ? selectedSku.salePrice : product.salePrice),
        payPriceText: formatMoney(price.payAmount),
        statusText: statusLabel(product.status),
        deliveryText: (selectedSku && selectedSku.deliveryMethods || product.deliveryMethods || []).map((type) => type === 'express' ? '快递' : '自提').join(' / '),
        presaleWindow,
        shippingRuleText: shippingRule.note
      },
      selectedPackage,
      selectedSkuId: selectedSku ? selectedSku.id : '',
      selectedSku,
      selectedSkuStock: selectedSku ? selectedSku.stock : product.stock,
      latestProduct,
      priceInfo: {
        ...price,
        payAmountText: formatMoney(price.payAmount),
        saleTotalText: formatMoney(price.saleTotal)
      },
      packageOptions: skus.map((sku) => {
        const skuPrice = calculateProductPrice({ product, sku, phone, whitelistEntries });
        return {
          ...sku,
          type: sku.packageType,
          packageLabel: packageTypeLabel(sku.packageType),
          payPriceText: formatMoney(skuPrice.payAmount),
          salePriceText: formatMoney(sku.salePrice),
          stock: sku.stock,
          deliveryText: (sku.deliveryMethods || []).map((type) => type === 'express' ? '快递' : '自提').join(' / ')
        };
      }),
      currentPhone: phone,
      isWhitelistUser: Boolean(whitelistDiscount),
      whitelistLabel: whitelistDiscount ? whitelistDiscount.label : ''
    });
  },

  selectPackage(event) {
    this.setData({
      selectedPackage: event.currentTarget.dataset.type,
      selectedSkuId: event.currentTarget.dataset.skuid
    });
    this.loadProduct();
  },

  goCheckout() {
    this.navigateCheckout();
  },

  navigateCheckout() {
    const { product, selectedPackage, selectedSkuStock } = this.data;
    if (!product || !product.isOnSale) {
      wx.showToast({ title: '商品暂不可买', icon: 'none' });
      return;
    }
    if (selectedSkuStock <= 0) {
      wx.showToast({ title: '当前规格库存不足', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/checkout/checkout?id=${product.id}&packageType=${selectedPackage}&skuId=${this.data.selectedSkuId}`
    });
  },

  async onCheckoutPhoneNumber(event) {
    if (this.data.isBindingPhone) return;
    this.setData({ isBindingPhone: true });
    try {
      const phone = await auth.bindPhoneFromEvent(event);
      this.setData({ currentPhone: phone });
      wx.showToast({ title: '手机号已绑定', icon: 'success' });
      this.navigateCheckout();
    } catch (error) {
      wx.showToast({ title: error.message || '手机号授权失败', icon: 'none' });
    } finally {
      this.setData({ isBindingPhone: false });
    }
  },

  onShareTouch() {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  onShareAppMessage() {
    const currentProduct = this.data.product;
    const product = currentProduct && currentProduct.isOnSale ? currentProduct : this.data.latestProduct;
    return {
      title: product ? `${product.name}｜桃子预售${currentProduct && currentProduct.id !== product.id ? '最新上架' : ''}` : '桃子预售',
      path: product ? `/pages/product-detail/product-detail?id=${product.id}` : '/pages/index/index',
      imageUrl: product ? product.coverImage : ''
    };
  }
});
