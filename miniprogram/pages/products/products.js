const store = require('../../utils/store');
const backend = require('../../utils/backend');
const { getSkuPriceRange, getProductSkus, getWhitelistDiscount } = require('../../utils/pricing');
const { latestOnSaleProduct, sortProductsForDisplay } = require('../../utils/inventory');
const { formatMoney, statusLabel } = require('../../utils/format');

function stockDisplay(product) {
  const soldCount = Number(product.soldCount || 0);
  return `已售 ${soldCount}｜剩余 ${Number(product.stock || 0)}`;
}

Page({
  data: {
    filters: [
      { key: 'all', label: '全部' },
      { key: 'on_sale', label: '上架中' },
      { key: 'sold_out', label: '售罄' },
      { key: 'bag', label: '袋装' },
      { key: 'box', label: '盒装' }
    ],
    activeFilter: 'all',
    products: [],
    latestProduct: null,
    isWhitelistUser: false,
    whitelistLabel: ''
  },

  onShow() {
    this.loadProducts();
  },

  async loadProducts() {
    const loadRequestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = loadRequestId;
    const phone = store.getCurrentPhone();
    const refreshKey = store.getInventoryChangedAt() || Date.now();
    let whitelistEntries = store.getWhitelistEntries();
    let whitelistDiscount = getWhitelistDiscount(phone, whitelistEntries);
    const activeFilter = this.data.activeFilter;
    let products = [];
    let usingBackend = false;
    try {
      products = await backend.listProducts({ refreshKey });
      usingBackend = true;
    } catch (_) {
      products = store.getProducts();
    }
    if (usingBackend && /^1\d{10}$/.test(phone)) {
      const backendEntries = [];
      await Promise.all(products.map(async (product) => {
        const backendDiscount = await backend.getWhitelistDiscount(phone, product.id).catch(() => null);
        if (!backendDiscount) return;
        if (!whitelistDiscount) whitelistDiscount = backendDiscount;
        backendEntries.push({
          phone,
          discountPercent: backendDiscount.percent,
          label: backendDiscount.label,
          source: backendDiscount.source,
          productIds: [product.id]
        });
      }));
      if (backendEntries.length) whitelistEntries = backendEntries;
    }
    if (loadRequestId !== this.loadRequestId) return;

    const decoratedProducts = sortProductsForDisplay(products).map((product) => {
      const range = getSkuPriceRange(product, phone, whitelistEntries);
      const priceText = range && range.min !== range.max
        ? `${formatMoney(range.min)}-${formatMoney(range.max)}`
        : formatMoney(range ? range.min : product.salePrice);
      return {
        ...product,
        statusText: statusLabel(product.status),
        payPriceText: priceText,
        salePriceText: formatMoney(product.salePrice),
        priceText: formatMoney(product.price),
        packageText: getProductSkus(product).map((sku) => sku.name).join(' / '),
        stockText: stockDisplay(product)
      };
    });
    const latest = latestOnSaleProduct(decoratedProducts);
    products = decoratedProducts;
    if (activeFilter === 'on_sale') products = products.filter((item) => item.isOnSale);
    if (activeFilter === 'sold_out') products = products.filter((item) => item.isSoldOut || item.status !== 'on_sale');
    if (activeFilter === 'bag' || activeFilter === 'box') products = products.filter((item) => (item.packageTypes || []).includes(activeFilter));

    this.setData({
      products,
      latestProduct: latest,
      isWhitelistUser: Boolean(whitelistDiscount),
      whitelistLabel: whitelistDiscount ? whitelistDiscount.label : ''
    });
  },

  switchFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.key });
    this.loadProducts();
  },

  goProduct(event) {
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${event.currentTarget.dataset.id}` });
  },

  stopTap() {},

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
