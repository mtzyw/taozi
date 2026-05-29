const assert = require('node:assert/strict');
const products = require('../miniprogram/data/products');
const coupons = require('../miniprogram/data/coupons');
const pickupPoints = require('../miniprogram/data/pickup-points');
const { calculateProductPrice, parsePhoneImport, getProductSku, getSkuPriceRange } = require('../miniprogram/utils/pricing');
const { resolveProduct, sortProductsForDisplay } = require('../miniprogram/utils/inventory');
const { sortPickupPoints } = require('../miniprogram/utils/distance');
const backend = require('../miniprogram/utils/backend');
const store = require('../miniprogram/utils/store');

const product = products[0];
const whitelist = parsePhoneImport('18800000000', 80);
const price = calculateProductPrice({ product, quantity: 1, phone: '18800000000', whitelistEntries: whitelist });
assert.equal(price.payAmount, Math.round(product.salePrice * 0.8));
assert.equal(price.whitelistDiscount.percent, 80);

const normalPrice = calculateProductPrice({ product, quantity: 1, phone: '18800000001', whitelistEntries: whitelist });
assert.equal(normalPrice.payAmount, product.salePrice);
assert.equal(normalPrice.originalTotal, product.salePrice);
assert.equal(normalPrice.trace.some((item) => item.type === 'product_sale'), false);

const productBoundWhitelist = parsePhoneImport('18800000009', 80, [product.id]);
const boundProductPrice = calculateProductPrice({ product, quantity: 1, phone: '18800000009', whitelistEntries: productBoundWhitelist });
assert.equal(boundProductPrice.payAmount, Math.round(product.salePrice * 0.8));
const unrelatedProductPrice = calculateProductPrice({
  product: { ...product, id: 'unrelated-product' },
  quantity: 1,
  phone: '18800000009',
  whitelistEntries: productBoundWhitelist
});
assert.equal(unrelatedProductPrice.whitelistDiscount, null);
assert.equal(unrelatedProductPrice.payAmount, product.salePrice);

const splitWhitelist = [
  ...parsePhoneImport('18800000010', 60, [product.id]),
  ...parsePhoneImport('18800000010', 75, ['another-product'])
];
const splitProductPrice = calculateProductPrice({ product, quantity: 1, phone: '18800000010', whitelistEntries: splitWhitelist });
assert.equal(splitProductPrice.whitelistDiscount.percent, 60);
const splitAnotherPrice = calculateProductPrice({
  product: { ...product, id: 'another-product' },
  quantity: 1,
  phone: '18800000010',
  whitelistEntries: splitWhitelist
});
assert.equal(splitAnotherPrice.whitelistDiscount.percent, 75);

const bagSku = getProductSku(product, 'early-bag-4jin');
assert.equal(bagSku.packageType, 'bag');
assert.equal(bagSku.salePrice, 8800);
assert.deepEqual(bagSku.deliveryMethods, ['pickup']);
const bagPrice = calculateProductPrice({ product, sku: bagSku, quantity: 1 });
assert.equal(bagPrice.payAmount, 8800);
assert.equal(bagPrice.sku.id, 'early-bag-4jin');
const misconfiguredBagSku = getProductSku({
  ...product,
  skus: [{
    id: 'bad-bag',
    packageType: 'bag',
    price: 10000,
    salePrice: 9000,
    stock: 10,
    deliveryMethods: ['pickup', 'express']
  }]
}, 'bad-bag');
assert.deepEqual(misconfiguredBagSku.deliveryMethods, ['pickup']);

coupons.push({
  code: 'FULLLOCAL',
  type: 'amount',
  value: 500,
  minOrderAmount: 10000,
  enabled: true
});
const couponBelowThreshold = calculateProductPrice({ product, sku: bagSku, quantity: 1, couponCode: 'FULLLOCAL' });
assert.equal(couponBelowThreshold.payAmount, 8800);
assert.equal(couponBelowThreshold.coupon, null);
assert.match(couponBelowThreshold.couponError, /未达到优惠码使用门槛/);
assert.equal(couponBelowThreshold.trace.some((item) => item.type === 'coupon'), false);
const couponReachedThreshold = calculateProductPrice({ product, sku: bagSku, quantity: 2, couponCode: 'FULLLOCAL' });
assert.equal(couponReachedThreshold.payAmount, 17100);
assert.equal(couponReachedThreshold.coupon.code, 'FULLLOCAL');
assert.ok(couponReachedThreshold.trace.some((item) => item.type === 'coupon' && item.minOrderAmount === 10000));
coupons.push({
  code: 'PRODUCTONLY',
  type: 'amount',
  value: 300,
  minOrderAmount: 0,
  productIds: [product.id],
  enabled: true
});
const productCouponPrice = calculateProductPrice({ product, sku: bagSku, quantity: 1, couponCode: 'PRODUCTONLY' });
assert.equal(productCouponPrice.payAmount, 8500);
assert.equal(productCouponPrice.coupon.code, 'PRODUCTONLY');
const blockedProductCouponPrice = calculateProductPrice({
  product: { ...product, id: 'unrelated-product' },
  sku: bagSku,
  quantity: 1,
  couponCode: 'PRODUCTONLY'
});
assert.equal(blockedProductCouponPrice.coupon, null);
assert.match(blockedProductCouponPrice.couponError, /优惠码不适用于当前商品/);
const whitelistCouponBlocked = calculateProductPrice({
  product,
  sku: bagSku,
  quantity: 2,
  phone: '18800000009',
  whitelistEntries: productBoundWhitelist,
  couponCode: 'FULLLOCAL'
});
assert.match(whitelistCouponBlocked.couponError, /白名单用户不可使用优惠码/);
assert.equal(whitelistCouponBlocked.coupon, null);
assert.equal(whitelistCouponBlocked.trace.some((item) => item.type === 'coupon'), false);

const priceRange = getSkuPriceRange(product);
assert.equal(priceRange.min, 8800);
assert.equal(priceRange.max, 10800);

const soldOut = resolveProduct({
  ...product,
  stock: 0,
  skus: product.skus.map((sku) => ({ ...sku, stock: 0 })),
  status: 'on_sale'
});
assert.equal(soldOut.status, 'sold_out_auto');
assert.equal(soldOut.isOnSale, false);

const sortedProductsForDisplay = sortProductsForDisplay([
  { id: 'new-off', status: 'off_sale_manual', stock: 10, listedAt: '2026-05-17T10:00:00.000Z', statusChangedAt: '2026-05-17T10:30:00.000Z' },
  { id: 'old-on', status: 'on_sale', stock: 1, listedAt: '2026-05-16T10:00:00.000Z' },
  { id: 'new-on', status: 'on_sale', stock: 1, listedAt: '2026-05-17T09:00:00.000Z' },
  { id: 'sold-out', status: 'sold_out_auto', stock: 0, listedAt: '2026-05-15T10:00:00.000Z', statusChangedAt: '2026-05-17T11:00:00.000Z' }
]);
assert.deepEqual(sortedProductsForDisplay.map((item) => item.id), ['new-on', 'old-on', 'sold-out', 'new-off']);

const sorted = sortPickupPoints(pickupPoints, { latitude: 30.657, longitude: 104.066 }, 'box');
assert.equal(sorted[0].id, 'pickup-downtown');
assert.ok(sorted.every((point) => point.packageTypes.includes('box')));
const defaultSortedPickup = sortPickupPoints(pickupPoints, null, 'box');
assert.equal(defaultSortedPickup[0].distanceLabel, '距离未知');

const localFiveShipping = store.calculateShippingFee({
  deliveryType: 'express',
  goodsAmount: 10000,
  expressAddress: '四川省成都市高新区测试路 1 号',
  quantity: 5
});
assert.equal(localFiveShipping.fee, 1200 * 5);
assert.equal(localFiveShipping.quantity, 5);
assert.equal(localFiveShipping.unitFee, 1200);

function loadPageDefinition(modulePath) {
  let pageDefinition = null;
  const previousPageDefinition = global.Page;
  global.Page = (definition) => {
    pageDefinition = definition;
  };
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
  if (previousPageDefinition === undefined) {
    delete global.Page;
  } else {
    global.Page = previousPageDefinition;
  }
  return pageDefinition;
}

const shareableProduct = {
  id: 'share-on-sale',
  name: '可分享桃',
  coverImage: '/assets/images/generated/test-showcase.png',
  status: 'on_sale',
  stock: 5,
  isOnSale: true,
  listedAt: '2026-05-18T10:00:00.000Z'
};
const unavailableProduct = {
  id: 'share-off-sale',
  name: '不可分享桃',
  coverImage: '/assets/images/generated/test-showcase.png',
  status: 'off_sale_manual',
  stock: 5,
  isOnSale: false,
  listedAt: '2026-05-19T10:00:00.000Z'
};
const indexPageDefinition = loadPageDefinition('../miniprogram/pages/index/index.js');
const unavailableIndexShare = indexPageDefinition.onShareAppMessage.call({
  data: {
    products: [unavailableProduct, shareableProduct],
    latestProduct: shareableProduct
  }
}, { target: { dataset: { id: unavailableProduct.id } } });
assert.match(unavailableIndexShare.path, /share-on-sale/);
const shareableIndexShare = indexPageDefinition.onShareAppMessage.call({
  data: {
    products: [unavailableProduct, shareableProduct],
    latestProduct: shareableProduct
  }
}, { target: { dataset: { id: shareableProduct.id } } });
assert.match(shareableIndexShare.path, /share-on-sale/);

const productsPageDefinition = loadPageDefinition('../miniprogram/pages/products/products.js');
const unavailableProductsShare = productsPageDefinition.onShareAppMessage.call({
  data: {
    products: [unavailableProduct],
    latestProduct: shareableProduct
  }
}, { target: { dataset: { id: unavailableProduct.id } } });
assert.match(unavailableProductsShare.path, /share-on-sale/);

const detailPageDefinition = loadPageDefinition('../miniprogram/pages/product-detail/product-detail.js');
const unavailableDetailShare = detailPageDefinition.onShareAppMessage.call({
  data: {
    product: unavailableProduct,
    latestProduct: shareableProduct
  }
});
assert.match(unavailableDetailShare.path, /share-on-sale/);

let checkoutPageDefinition = null;
const previousPage = global.Page;
global.Page = (definition) => {
  checkoutPageDefinition = definition;
};
require('../miniprogram/pages/checkout/checkout.js');
if (previousPage === undefined) {
  delete global.Page;
} else {
  global.Page = previousPage;
}
const quantityContext = {
  data: { quantity: 1 },
  recalculations: 0,
  setData(patch) { Object.assign(this.data, patch); },
  recalculate() { this.recalculations += 1; }
};
checkoutPageDefinition.onQuantityInput.call(quantityContext, { detail: { value: '' } });
assert.equal(quantityContext.data.quantity, '');
assert.equal(quantityContext.recalculations, 0);
checkoutPageDefinition.onQuantityInput.call(quantityContext, { detail: { value: '2' } });
assert.equal(quantityContext.data.quantity, 2);
assert.equal(quantityContext.recalculations, 1);
checkoutPageDefinition.onQuantityInput.call(quantityContext, { detail: { value: '' } });
checkoutPageDefinition.onQuantityBlur.call(quantityContext);
assert.equal(quantityContext.data.quantity, 1);

async function runCheckoutAddressRefreshTest() {
  const originalWx = global.wx;
  const originalListAddresses = backend.listAddresses;
const storage = {};
global.wx = {
  getStorageSync(key) {
      return storage[key] === undefined ? '' : storage[key];
    },
    setStorageSync(key, value) {
      storage[key] = value;
  }
};
store.saveAddresses([]);
const localAddress = store.upsertAddress({
  receiver: '杨总',
  phone: '13618002828',
  address: '成都市成华区电子科大产业园703',
  isDefault: true
});
const localDuplicateAddress = store.upsertAddress({
  receiver: '杨总',
  phone: '13618002828',
  address: '成都市成华区电子科大产业园703',
  isDefault: true
});
assert.equal(localDuplicateAddress.id, localAddress.id);
assert.equal(store.getAddresses().length, 1);
const localOrder = store.createOrder({ id: 'local_order_once', buyerPhone: '18800000001', status: 'awaiting_pickup' });
const localDuplicateOrder = store.createOrder({ id: 'local_order_once', buyerPhone: '18800000001', status: 'awaiting_pickup' });
assert.equal(localDuplicateOrder.id, localOrder.id);
assert.equal(store.getOrders().length, 1);
store.saveAddresses([]);
backend.listAddresses = async () => [{
    id: 'addr-new',
    buyerPhone: '18800000001',
    receiver: '李四',
    phone: '18800000002',
    address: '新地址 2 号',
    isDefault: true
  }];
  try {
    const addressContext = {
      data: {
        phone: '18800000001',
        deliveryType: 'express',
        selectedAddressId: 'addr-old',
        expressReceiver: '张三',
        expressPhone: '18800000003',
        expressAddress: '已删除地址 1 号'
      },
      recalculations: 0,
      setData(patch) { Object.assign(this.data, patch); },
      recalculate() { this.recalculations += 1; }
    };
    await checkoutPageDefinition.loadAddressBook.call(addressContext, false);
    assert.deepEqual(addressContext.data.addresses.map((address) => address.id), ['addr-new']);
    assert.equal(addressContext.data.selectedAddressId, '');
    assert.equal(addressContext.data.expressAddress, '');
    assert.equal(addressContext.recalculations, 1);
    assert.deepEqual(store.getAddresses().map((address) => address.id), ['addr-new']);
  } finally {
    backend.listAddresses = originalListAddresses;
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  }
}

runCheckoutAddressRefreshTest()
  .then(() => {
    console.log('业务逻辑校验通过');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
