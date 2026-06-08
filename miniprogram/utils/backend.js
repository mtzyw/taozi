const apiConfig = require('../config/api');

function normalizeStock(stock) {
  const value = Number(stock);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeServerImageUrl(src) {
  const image = String(src || '').trim();
  if (!image) return '';
  if (/^https?:\/\//i.test(image)) return image;
  if (image.startsWith('/uploads/') || image.startsWith('/assets/')) {
    const publicBaseUrl = String(apiConfig.publicBaseUrl || apiConfig.baseUrl || '').replace(/\/$/, '');
    return publicBaseUrl ? `${publicBaseUrl}${image}` : image;
  }
  return image;
}

function normalizeDeliveryMethods(methods) {
  const filtered = (Array.isArray(methods) ? methods : [])
    .filter((type) => type === 'pickup' || type === 'express');
  return filtered.length ? [...new Set(filtered)] : ['pickup'];
}

function normalizeSkuDeliveryMethods(packageType, methods) {
  if (packageType === 'bag') return ['pickup'];
  return normalizeDeliveryMethods(methods);
}

function mergeSkuDeliveryMethods(skus, fallbackMethods = ['pickup']) {
  const merged = [];
  (skus || []).forEach((sku) => {
    normalizeSkuDeliveryMethods(sku.packageType, sku.deliveryMethods || fallbackMethods).forEach((method) => {
      if (!merged.includes(method)) merged.push(method);
    });
  });
  return merged.length ? merged : normalizeDeliveryMethods(fallbackMethods);
}

function normalizeManualSortOrder(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : null;
}

function normalizeProduct(product) {
  const coverImage = normalizeServerImageUrl(product.coverImage || product.cover_image);
  const productDeliveryMethods = normalizeDeliveryMethods(product.deliveryMethods);
  const skus = Array.isArray(product.skus) ? product.skus.map((sku) => ({
    ...sku,
    price: Number(sku.price || 0),
    salePrice: Number(sku.salePrice || 0),
    stock: normalizeStock(sku.stock),
    remainingStock: normalizeStock(sku.remainingStock ?? sku.stock),
    soldCount: normalizeStock(sku.soldCount),
    lockedCount: normalizeStock(sku.lockedCount),
    initialStock: normalizeStock(sku.initialStock ?? (normalizeStock(sku.stock) + normalizeStock(sku.soldCount) + normalizeStock(sku.lockedCount))),
    deliveryMethods: normalizeSkuDeliveryMethods(sku.packageType, sku.deliveryMethods || productDeliveryMethods)
  })) : [];
  const stock = skus.length ? skus.reduce((sum, sku) => sum + normalizeStock(sku.stock), 0) : normalizeStock(product.stock);
  const soldCount = normalizeStock(product.soldCount);
  const lockedCount = normalizeStock(product.lockedCount);
  const status = stock <= 0 && product.status === 'on_sale' ? 'sold_out_auto' : product.status;
  const manualSortOrder = normalizeManualSortOrder(product.manualSortOrder ?? product.manual_sort_order);
  return {
    ...product,
    saleType: product.saleType === 'direct' ? 'direct' : 'presale',
    coverImage,
    images: Array.isArray(product.images) && product.images.length
      ? product.images.map(normalizeServerImageUrl)
      : (coverImage ? [coverImage] : []),
    price: Number(product.price || 0),
    salePrice: Number(product.salePrice || 0),
    skus,
    stock,
    remainingStock: stock,
    soldCount,
    lockedCount,
    initialStock: normalizeStock(product.initialStock ?? (stock + soldCount + lockedCount)),
    status,
    pickupPointIds: normalizeIdList(product.pickupPointIds || product.pickup_point_ids),
    packageTypes: Array.isArray(product.packageTypes) ? product.packageTypes : [...new Set(skus.map((sku) => sku.packageType))],
    deliveryMethods: mergeSkuDeliveryMethods(skus, productDeliveryMethods),
    tags: Array.isArray(product.tags) ? product.tags : [],
    isOnSale: status === 'on_sale' && stock > 0,
    isSoldOut: stock <= 0 || status === 'sold_out_auto',
    manualSortOrder,
    isManualPriority: manualSortOrder !== null,
    statusChangedAt: product.statusChangedAt || product.status_changed_at || product.updatedAt || product.updated_at || product.listedAt,
    source: 'backend'
  };
}

function normalizePickupPoint(point) {
  return {
    ...point,
    openTime: point.openTime || point.open_time || '',
    packageTypes: Array.isArray(point.packageTypes) ? point.packageTypes : ['box', 'bag'],
    enabled: point.enabled !== false
  };
}

function normalizeAddress(address) {
  return {
    ...address,
    id: address.id || '',
    buyerPhone: address.buyerPhone || '',
    receiver: address.receiver || '',
    phone: address.phone || '',
    address: address.address || '',
    isDefault: Boolean(address.isDefault)
  };
}

function normalizeResponseBody(res) {
  return res && (res.data !== undefined ? res.data : (res.result !== undefined ? res.result : res)) || {};
}

function cloudrunRequest(path, method = 'GET', data = undefined) {
  const cloudrun = apiConfig.cloudrun || {};
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callContainer) {
    return Promise.reject(new Error('cloudrun disabled'));
  }
  if (!cloudrun.env || !cloudrun.serviceName) {
    return Promise.reject(new Error('cloudrun config missing'));
  }
  return wx.cloud.callContainer({
    config: { env: cloudrun.env },
    path,
    method,
    data,
    timeout: apiConfig.timeout,
    header: {
      'content-type': 'application/json',
      'X-WX-SERVICE': cloudrun.serviceName
    }
  }).then((res) => {
    const statusCode = Number(res && res.statusCode || 200);
    const body = normalizeResponseBody(res);
    if (statusCode >= 200 && statusCode < 300) return body;
    throw new Error((body && body.error) || `HTTP ${statusCode}`);
  }).catch((error) => {
    throw new Error(error.message || '云托管连接失败');
  });
}

function httpRequest(path, method = 'GET', data = undefined) {
  if (typeof wx === 'undefined' || !wx.request) {
    return Promise.reject(new Error('backend disabled'));
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiConfig.baseUrl}${path}`,
      method,
      data,
      timeout: apiConfig.timeout,
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {});
          return;
        }
        reject(new Error((res.data && res.data.error) || `HTTP ${res.statusCode}`));
      },
      fail: (error) => reject(new Error(error.errMsg || '后台连接失败'))
    });
  });
}

function request(path, method = 'GET', data = undefined) {
  if (!apiConfig.enabled) return Promise.reject(new Error('backend disabled'));
  if (apiConfig.mode === 'cloudrun') return cloudrunRequest(path, method, data);
  return httpRequest(path, method, data);
}

function appendRefreshQuery(path, refreshKey) {
  if (!refreshKey) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}_refresh=${encodeURIComponent(refreshKey)}`;
}

async function listProducts(options = {}) {
  const data = await request(appendRefreshQuery('/api/storefront/products', options.refreshKey || options.noCache && Date.now()));
  return (data.products || []).map(normalizeProduct);
}

async function getProductById(id, options = {}) {
  const data = await request(appendRefreshQuery(`/api/storefront/products/${encodeURIComponent(id)}`, options.refreshKey || options.noCache && Date.now()));
  return data.product ? normalizeProduct(data.product) : null;
}

async function listPickupPoints() {
  const data = await request('/api/storefront/pickup-points');
  return (data.pickupPoints || []).map(normalizePickupPoint);
}

async function getShippingRule() {
  const data = await request('/api/storefront/shipping-rule');
  return data.shippingRule || null;
}

async function loginWithWechat(code) {
  const data = await request('/api/storefront/wechat-login', 'POST', { code });
  return data.session || null;
}

async function getWechatPhone(payload) {
  const data = await request('/api/storefront/wechat-phone', 'POST', payload);
  return data.phoneInfo || null;
}

async function getWhitelistDiscount(phone, productId = '') {
  const query = `phone=${encodeURIComponent(phone || '')}${productId ? `&productId=${encodeURIComponent(productId)}` : ''}`;
  const data = await request(`/api/storefront/whitelist-discount?${query}`);
  return data.discount || null;
}

async function quoteOrder(order) {
  const data = await request('/api/storefront/quote', 'POST', order);
  return data.quote || null;
}

async function createOrder(order) {
  const data = await request('/api/storefront/orders', 'POST', order);
  return data.order || null;
}

async function payOrder(orderId, payload = {}) {
  return request(`/api/storefront/orders/${encodeURIComponent(orderId)}/pay`, 'POST', payload);
}

async function confirmPayment(orderId) {
  return request(`/api/storefront/orders/${encodeURIComponent(orderId)}/pay-confirm`, 'POST', {});
}

async function listOrders(phone) {
  const query = phone ? `?phone=${encodeURIComponent(phone)}` : '';
  const data = await request(`/api/storefront/orders${query}`);
  return data.orders || [];
}

async function getOrderById(orderId) {
  const data = await request(`/api/storefront/orders/${encodeURIComponent(orderId)}`);
  return data.order || null;
}

async function requestAfterSale(orderId, payload) {
  const data = await request(`/api/storefront/orders/${encodeURIComponent(orderId)}/after-sale`, 'POST', payload);
  return data.order || null;
}

async function confirmWechatReceipt(orderId, payload = {}) {
  return request(`/api/storefront/orders/${encodeURIComponent(orderId)}/wechat-receipt-confirm`, 'POST', payload);
}

async function pickupStaffLogin(payload) {
  const data = await request('/api/storefront/pickup-staff/login', 'POST', payload);
  return data.session || null;
}

async function lookupPickupStaffOrder(payload) {
  const data = await request('/api/storefront/pickup-staff/lookup', 'POST', payload);
  return data.result || null;
}

async function confirmPickupStaffOrder(payload) {
  const data = await request('/api/storefront/pickup-staff/confirm', 'POST', payload);
  return data.result || null;
}

async function listAddresses(phone) {
  const data = await request(`/api/storefront/addresses?phone=${encodeURIComponent(phone || '')}`);
  return (data.addresses || []).map(normalizeAddress);
}

async function upsertAddress(address) {
  const data = await request('/api/storefront/addresses', 'POST', address);
  return data.address ? normalizeAddress(data.address) : null;
}

async function deleteAddress(addressId, phone) {
  const query = phone ? `?phone=${encodeURIComponent(phone)}` : '';
  const data = await request(`/api/storefront/addresses/${encodeURIComponent(addressId)}${query}`, 'DELETE');
  return Boolean(data.ok);
}

module.exports = {
  listProducts,
  getProductById,
  listPickupPoints,
  getShippingRule,
  loginWithWechat,
  getWechatPhone,
  getWhitelistDiscount,
  quoteOrder,
  createOrder,
  payOrder,
  confirmPayment,
  listOrders,
  getOrderById,
  requestAfterSale,
  confirmWechatReceipt,
  pickupStaffLogin,
  lookupPickupStaffOrder,
  confirmPickupStaffOrder,
  listAddresses,
  upsertAddress,
  deleteAddress
};
