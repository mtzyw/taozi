const store = require('../../utils/store');
const backend = require('../../utils/backend');
const auth = require('../../utils/auth');
const { getSkuPriceRange, getWhitelistDiscount } = require('../../utils/pricing');
const { latestOnSaleProduct, sortProductsForDisplay } = require('../../utils/inventory');
const { formatMoney, statusLabel } = require('../../utils/format');

function stockDisplay(product) {
  const soldCount = Number(product.soldCount || 0);
  return `已售 ${soldCount}｜剩余 ${Number(product.stock || 0)}`;
}

Page({
  data: {
    currentPhone: '',
    isWhitelistUser: false,
    whitelistLabel: '',
    products: [],
    latestProduct: null,
    isBindingPhone: false
  },

  onShow() {
    this.loadPage();
  },

  async loadPage() {
    const loadRequestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = loadRequestId;
    const currentPhone = store.getCurrentPhone();
    const refreshKey = store.getInventoryChangedAt() || Date.now();
    let whitelistEntries = store.getWhitelistEntries();
    let whitelistDiscount = getWhitelistDiscount(currentPhone, whitelistEntries);
    let sourceProducts = [];
    let usingBackend = false;
    try {
      sourceProducts = await backend.listProducts({ refreshKey });
      usingBackend = true;
    } catch (_) {
      sourceProducts = store.getProducts();
    }
    if (usingBackend && /^1\d{10}$/.test(currentPhone)) {
      const backendEntries = [];
      await Promise.all(sourceProducts.map(async (product) => {
        const backendDiscount = await backend.getWhitelistDiscount(currentPhone, product.id).catch(() => null);
        if (!backendDiscount) return;
        if (!whitelistDiscount) whitelistDiscount = backendDiscount;
        backendEntries.push({
          phone: currentPhone,
          discountPercent: backendDiscount.percent,
          label: backendDiscount.label,
          source: backendDiscount.source,
          productIds: [product.id]
        });
      }));
      if (backendEntries.length) whitelistEntries = backendEntries;
    }
    if (loadRequestId !== this.loadRequestId) return;
    const products = sortProductsForDisplay(sourceProducts).map((product) => {
      const range = getSkuPriceRange(product, currentPhone, whitelistEntries);
      const priceText = range && range.min !== range.max
        ? `${formatMoney(range.min)}-${formatMoney(range.max)}`
        : formatMoney(range ? range.min : product.salePrice);
      return {
        ...product,
        statusText: statusLabel(product.status),
        packageText: (product.packageTypes || []).map((type) => type === 'box' ? '盒装' : '袋装').join(' / '),
        stockText: stockDisplay(product),
        priceText: formatMoney(product.price),
        salePriceText: formatMoney(product.salePrice),
        payPriceText: priceText
      };
    });
    const latest = latestOnSaleProduct(products);

    this.setData({
      currentPhone,
      isWhitelistUser: Boolean(whitelistDiscount),
      whitelistLabel: whitelistDiscount ? whitelistDiscount.label : '',
      products,
      latestProduct: latest
    });
  },

  goProduct(event) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${id}` });
  },

  async onBuyPhoneNumber(event) {
    if (this.data.isBindingPhone) return;
    const { id } = event.currentTarget.dataset;
    this.setData({ isBindingPhone: true });
    try {
      await auth.bindPhoneFromEvent(event);
      await this.loadPage();
      wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${id}` });
    } catch (error) {
      wx.showToast({ title: error.message || '手机号授权失败', icon: 'none' });
    } finally {
      this.setData({ isBindingPhone: false });
    }
  },

  stopTap() {},

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  onShareAppMessage(event) {
    const shareId = event && event.target && event.target.dataset && event.target.dataset.id;
    const matchedProduct = shareId
      ? this.data.products.find((item) => String(item.id) === String(shareId))
      : null;
    const product = matchedProduct && matchedProduct.isOnSale ? matchedProduct : this.data.latestProduct;
    if (product) {
      return {
        title: matchedProduct && matchedProduct.isOnSale ? `${product.name}｜桃子预售` : `${product.name}｜桃子预售最新上架`,
        path: `/pages/product-detail/product-detail?id=${product.id}`,
        imageUrl: product.coverImage
      };
    }
    return {
      title: '桃子预售小程序',
      path: '/pages/index/index'
    };
  }
});
