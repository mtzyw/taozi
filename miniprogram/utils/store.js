const products = require('../data/products');
const defaultWhitelist = require('../data/whitelist');
const defaultPickupPoints = require('../data/pickup-points');
const apiConfig = require('../config/api');
const { resolveProducts, normalizeStock, findSku, sortProductsForDisplay } = require('./inventory');
const { normalizePhone, normalizeWhitelistEntries } = require('./pricing');

const KEYS = {
  phone: 'peach.currentPhone',
  whitelist: 'peach.whitelistEntries',
  orders: 'peach.orders',
  customProducts: 'peach.customProducts',
  deletedProductIds: 'peach.deletedProductIds',
  productOverrides: 'peach.productOverrides',
  addresses: 'peach.addresses',
  adminPhones: 'peach.adminPhones',
  pickupPoints: 'peach.pickupPoints',
  deletedPickupPointIds: 'peach.deletedPickupPointIds',
  shippingRule: 'peach.shippingRule',
  inventoryChangedAt: 'peach.inventoryChangedAt'
};

const DEFAULT_SHIPPING_RULE = {
  expressBaseFee: 1200,
  localExpressFee: 1200,
  remoteExpressFee: 1200,
  freeShippingThreshold: 19800,
  pickupFee: 0,
  localRegions: ['成都', '成都市', '重庆', '重庆市'],
  note: '自提免运费，成都/重庆按本地快递费，其他地址按省外快递费；快递费按件计算，满 198 元包邮。'
};

function safeGet(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function safeSet(key, value) {
  wx.setStorageSync(key, value);
}

function makeLocalId(prefix) {
  if (prefix === 'order') {
    return `${Date.now()}${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getCurrentPhone() {
  return safeGet(KEYS.phone, '');
}

function setCurrentPhone(phone) {
  safeSet(KEYS.phone, String(phone || '').replace(/\D/g, ''));
}

function markInventoryChanged() {
  const changedAt = Date.now();
  safeSet(KEYS.inventoryChangedAt, changedAt);
  return changedAt;
}

function getInventoryChangedAt() {
  return Number(safeGet(KEYS.inventoryChangedAt, 0)) || 0;
}

function getWhitelistEntries() {
  const imported = safeGet(KEYS.whitelist, []);
  return normalizeWhitelistEntries([...defaultWhitelist, ...(Array.isArray(imported) ? imported : [])]);
}

function saveWhitelistEntries(entries) {
  safeSet(KEYS.whitelist, normalizeWhitelistEntries(entries));
}

function appendWhitelistEntries(entries) {
  const current = getWhitelistEntries();
  const next = normalizeWhitelistEntries([...current, ...(entries || [])]);
  const map = {};
  next.forEach((entry) => {
    const productKey = (entry.productIds || []).map(String).sort().join(',');
    map[`${entry.phone}::${productKey}`] = entry;
  });
  const deduped = Object.values(map);
  saveWhitelistEntries(deduped);
  return deduped;
}

function getProductOverrides() {
  return safeGet(KEYS.productOverrides, {}) || {};
}

function saveProductOverrides(overrides) {
  safeSet(KEYS.productOverrides, overrides || {});
}

function getFallbackProductImage() {
  return (products[0] && products[0].coverImage) || '/assets/images/generated/test-showcase.png';
}

function normalizeImageUrl(src) {
  const image = String(src || '').trim();
  if (!image) return '';
  if (/^https?:\/\//i.test(image)) return image;
  if (image.startsWith('/uploads/') || image.startsWith('/assets/')) {
    const publicBaseUrl = String(apiConfig.publicBaseUrl || apiConfig.baseUrl || '').replace(/\/$/, '');
    return publicBaseUrl ? `${publicBaseUrl}${image}` : image;
  }
  return image;
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

function normalizeLocalRegions(value) {
  const regions = normalizeIdList(value);
  return regions.length ? regions : DEFAULT_SHIPPING_RULE.localRegions;
}

function detectExpressZone(address, rule = DEFAULT_SHIPPING_RULE) {
  const text = String(address || '').replace(/\s+/g, '');
  const localRegions = normalizeLocalRegions(rule.localRegions);
  if (!text) return 'local';
  if (text && localRegions.some((region) => region && text.includes(region))) return 'local';
  return 'remote';
}

function normalizeMoneyToCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue * 100));
}

function normalizeCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue));
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

function sumSkuStock(skus) {
  return (skus || []).reduce((sum, sku) => sum + normalizeStock(sku.stock), 0);
}

function normalizeProductRecord(product) {
  const normalizedPackageTypes = Array.isArray(product.packageTypes)
    ? product.packageTypes.filter((type) => type === 'box' || type === 'bag')
    : [];
  const normalizedDeliveryMethods = normalizeDeliveryMethods(product.deliveryMethods);
  const packageTypes = normalizedPackageTypes.length ? normalizedPackageTypes : ['box'];
  const id = product.id || makeLocalId('custom');
  const price = Math.max(0, Math.round(Number(product.price) || 0));
  const salePrice = Math.max(0, Math.round(Number(product.salePrice ?? product.price) || 0));
  const coverImage = normalizeImageUrl(product.coverImage || getFallbackProductImage());
  const rawSkus = Array.isArray(product.skus) && product.skus.length ? product.skus : packageTypes.map((packageType) => ({
    id: `${id}-${packageType}`,
    packageType,
    label: packageType === 'box' ? '盒装' : '袋装',
    name: packageType === 'box' ? '默认盒装规格' : '默认袋装规格',
    weightText: '',
    price,
    salePrice,
    deliveryMethods: normalizeSkuDeliveryMethods(packageType, normalizedDeliveryMethods)
  }));
  const skus = rawSkus.map((sku) => ({
    ...sku,
    deliveryMethods: normalizeSkuDeliveryMethods(sku.packageType, sku.deliveryMethods || normalizedDeliveryMethods)
  }));
  const deliveryMethods = mergeSkuDeliveryMethods(skus, normalizedDeliveryMethods);
  const hasSkuStock = skus.some((sku) => sku.stock !== undefined && sku.stock !== null);
  const stock = hasSkuStock ? sumSkuStock(skus) : normalizeStock(product.stock);
  return {
    id,
    source: product.source || 'custom',
    saleType: product.saleType === 'direct' ? 'direct' : 'presale',
    name: String(product.name || '').trim(),
    subtitle: String(product.subtitle || '').trim(),
    coverImage,
    images: Array.isArray(product.images) && product.images.length ? product.images.map(normalizeImageUrl) : [coverImage],
    packageTypes,
    price,
    salePrice,
    skus,
    stock,
    status: product.status || 'on_sale',
    deliveryMethods,
    pickupPointIds: normalizeIdList(product.pickupPointIds || product.pickup_point_ids),
    presaleNote: String(product.presaleNote || (product.saleType === 'direct' ? '现货销售，下单后按订单顺序安排发货/自提。' : '预售商品，具体发货/自提时间以商家通知为准。')).trim(),
    batchName: String(product.batchName || '当前预售批次').trim(),
    harvestStart: String(product.harvestStart || '').trim(),
    harvestEnd: String(product.harvestEnd || '').trim(),
    shipStart: String(product.shipStart || '').trim(),
    shipEnd: String(product.shipEnd || '').trim(),
    orderDeadline: String(product.orderDeadline || '').trim(),
    listedAt: product.listedAt || new Date().toISOString(),
    updatedAt: product.updatedAt || '',
    tags: Array.isArray(product.tags) && product.tags.length ? product.tags : ['新上架', product.saleType === 'direct' ? '直售' : '预售']
  };
}

function parseTags(text) {
  return String(text || '')
    .split(/[\s,，;；]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getDraftPackageTypes(draft) {
  if (Array.isArray(draft.packageTypes) && draft.packageTypes.length) {
    return draft.packageTypes.filter((type) => type === 'box' || type === 'bag');
  }
  const packageTypes = [];
  if (draft.packageBox) packageTypes.push('box');
  if (draft.packageBag) packageTypes.push('bag');
  if (packageTypes.length) return packageTypes;
  if (draft.packageMode === 'both') return ['box', 'bag'];
  return [draft.packageMode === 'bag' ? 'bag' : 'box'];
}

function getDraftDeliveryMethods(draft) {
  if (Array.isArray(draft.deliveryMethods) && draft.deliveryMethods.length) {
    return draft.deliveryMethods.filter((type) => type === 'pickup' || type === 'express');
  }
  const deliveryMethods = [];
  if (draft.deliveryPickup) deliveryMethods.push('pickup');
  if (draft.deliveryExpress) deliveryMethods.push('express');
  if (deliveryMethods.length) return deliveryMethods;
  return draft.deliveryMode === 'pickup_express' ? ['pickup', 'express'] : ['pickup'];
}

function getDraftStockByPackage(draft, packageTypes) {
  const fallbackTotal = normalizeStock(draft.stock);
  const hasBoxStock = draft.boxStock !== undefined && draft.boxStock !== '';
  const hasBagStock = draft.bagStock !== undefined && draft.bagStock !== '';
  const result = {};

  if (packageTypes.includes('box') && hasBoxStock) {
    result.box = normalizeStock(draft.boxStock);
  }
  if (packageTypes.includes('bag') && hasBagStock) {
    result.bag = normalizeStock(draft.bagStock);
  }

  const missing = packageTypes.filter((type) => result[type] === undefined);
  if (missing.length && fallbackTotal > 0) {
    const base = Math.floor(fallbackTotal / packageTypes.length);
    const remainder = fallbackTotal % packageTypes.length;
    packageTypes.forEach((type, index) => {
      if (result[type] === undefined) {
        result[type] = base + (index < remainder ? 1 : 0);
      }
    });
  }

  packageTypes.forEach((type) => {
    if (result[type] === undefined) result[type] = 0;
  });
  return result;
}

function buildProductRecordFromDraft(draft, id, baseProduct = null) {
  const packageTypes = getDraftPackageTypes(draft);
  const deliveryMethods = getDraftDeliveryMethods(draft);
  const salePrice = normalizeMoneyToCents(draft.salePriceYuan || draft.priceYuan);
  const price = salePrice;
  const stockByPackage = getDraftStockByPackage(draft, packageTypes);
  const stock = packageTypes.reduce((sum, packageType) => sum + normalizeStock(stockByPackage[packageType]), 0);
  const tags = parseTags(draft.tagsText);
  const weightText = String(draft.weightText || '').trim();
  const existingSkusByPackage = {};
  ((baseProduct && baseProduct.skus) || []).forEach((sku) => {
    if (sku.packageType) existingSkusByPackage[sku.packageType] = sku;
  });
  const previousStatus = draft.status || (baseProduct && baseProduct.status) || 'on_sale';
  const nextStatus = stock > 0
    ? (previousStatus === 'sold_out_auto' ? 'on_sale' : previousStatus)
    : 'sold_out_auto';

  return normalizeProductRecord({
    id,
    source: (baseProduct && baseProduct.source) || 'custom',
    saleType: draft.saleType === 'direct' ? 'direct' : 'presale',
    name: draft.name,
    subtitle: draft.subtitle,
    packageTypes,
    price,
    salePrice,
    stock,
    coverImage: draft.coverImage,
    images: draft.coverImage ? [draft.coverImage] : draft.images,
    status: nextStatus,
    deliveryMethods,
    pickupPointIds: draft.pickupPointIds || (baseProduct && baseProduct.pickupPointIds) || [],
    presaleNote: draft.presaleNote,
    batchName: draft.batchName,
    harvestStart: draft.harvestStart,
    harvestEnd: draft.harvestEnd,
    shipStart: draft.shipStart,
    shipEnd: draft.shipEnd,
    orderDeadline: draft.orderDeadline,
    listedAt: (baseProduct && baseProduct.listedAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: tags.length ? tags : ['新上架', draft.saleType === 'direct' ? '直售' : '预售'],
    skus: packageTypes.map((packageType) => {
      const existingSku = existingSkusByPackage[packageType] || {};
      return {
        ...existingSku,
        id: existingSku.id || `${id}-${packageType}`,
        packageType,
        label: packageType === 'box' ? '盒装' : '袋装',
        name: `${weightText || existingSku.weightText || '默认规格'}${packageType === 'box' ? '盒装' : '袋装'}`,
        weightText: weightText || existingSku.weightText || '',
        price,
        salePrice,
        stock: normalizeStock(stockByPackage[packageType]),
        deliveryMethods
      };
    })
  });
}

function getCustomProducts() {
  const customProducts = safeGet(KEYS.customProducts, []);
  return (Array.isArray(customProducts) ? customProducts : [])
    .map(normalizeProductRecord)
    .filter((product) => product.name && product.salePrice > 0);
}

function saveCustomProducts(customProducts) {
  safeSet(KEYS.customProducts, (customProducts || []).map(normalizeProductRecord));
}

function getDeletedProductIds() {
  const ids = safeGet(KEYS.deletedProductIds, []);
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '')).filter(Boolean))];
}

function saveDeletedProductIds(ids) {
  safeSet(KEYS.deletedProductIds, [...new Set((ids || []).map((id) => String(id || '')).filter(Boolean))]);
}

function getProductSalesStatsBySku(productId) {
  const stats = {};
  getOrders().forEach((order) => {
    const status = order.status || '';
    const isLocked = status === 'awaiting_payment';
    const isSold = !['awaiting_payment', 'cancelled', 'refunded'].includes(status);
    if (!isLocked && !isSold) return;
    (order.items || []).forEach((item) => {
      if (String(item.productId || '') !== String(productId || '')) return;
      const skuId = String(item.skuId || item.packageType || 'default');
      if (!stats[skuId]) stats[skuId] = { soldCount: 0, lockedCount: 0 };
      const quantity = normalizeStock(item.quantity || 1);
      if (isLocked) stats[skuId].lockedCount += quantity;
      if (isSold) stats[skuId].soldCount += quantity;
    });
  });
  return stats;
}

function applyProductSalesStats(product) {
  const statsBySku = getProductSalesStatsBySku(product.id);
  const skus = (product.skus || []).map((sku) => {
    const stats = statsBySku[sku.id] || statsBySku[sku.packageType] || { soldCount: 0, lockedCount: 0 };
    const stock = normalizeStock(sku.stock);
    const soldCount = normalizeStock(stats.soldCount);
    const lockedCount = normalizeStock(stats.lockedCount);
    return {
      ...sku,
      soldCount,
      lockedCount,
      initialStock: stock + soldCount + lockedCount,
      remainingStock: stock
    };
  });
  const soldCount = skus.reduce((sum, sku) => sum + normalizeStock(sku.soldCount), 0);
  const lockedCount = skus.reduce((sum, sku) => sum + normalizeStock(sku.lockedCount), 0);
  const stock = skus.reduce((sum, sku) => sum + normalizeStock(sku.stock), 0);
  return {
    ...product,
    skus,
    stock,
    remainingStock: stock,
    soldCount,
    lockedCount,
    initialStock: stock + soldCount + lockedCount
  };
}

function getProducts() {
  const deletedIds = getDeletedProductIds();
  const allProducts = [...getCustomProducts(), ...products].filter((product) => !deletedIds.includes(product.id));
  return sortProductsForDisplay(resolveProducts(allProducts, getProductOverrides()).map(applyProductSalesStats));
}

function getProductById(id) {
  return getProducts().find((product) => product.id === id) || null;
}

function updateProductOverride(productId, patch) {
  const overrides = getProductOverrides();
  const currentProduct = getProductById(productId);
  const previousStatus = overrides[productId] && overrides[productId].status || currentProduct && currentProduct.status;
  const nextPatch = { ...patch };
  if (patch.status && patch.status !== previousStatus) {
    nextPatch.statusChangedAt = new Date().toISOString();
    if (patch.status === 'on_sale') nextPatch.listedAt = nextPatch.statusChangedAt;
  }
  overrides[productId] = {
    ...(overrides[productId] || {}),
    ...nextPatch
  };
  saveProductOverrides(overrides);
  return getProductById(productId);
}

function createProduct(draft) {
  const id = makeLocalId('custom');
  const product = buildProductRecordFromDraft(draft, id);
  const next = [product, ...getCustomProducts()];
  saveCustomProducts(next);
  return product;
}

function updateProduct(productId, draft) {
  const baseProduct = getProductById(productId);
  if (!baseProduct) return null;
  const product = buildProductRecordFromDraft({
    ...draft,
    status: draft.status || baseProduct.status
  }, baseProduct.id, baseProduct);
  const skuStocks = {};
  (product.skus || []).forEach((sku) => {
    skuStocks[sku.id] = normalizeStock(sku.stock);
  });
  return updateProductOverride(baseProduct.id, {
    ...product,
    id: baseProduct.id,
    source: baseProduct.source,
    listedAt: baseProduct.listedAt,
    skuStocks
  });
}

function deleteProduct(productId) {
  const id = String(productId || '');
  if (!id) return getProducts();

  const customProducts = getCustomProducts();
  const nextCustomProducts = customProducts.filter((product) => product.id !== id);
  const isCustomProduct = nextCustomProducts.length !== customProducts.length;
  if (isCustomProduct) {
    saveCustomProducts(nextCustomProducts);
  } else if (products.some((product) => product.id === id)) {
    saveDeletedProductIds([...getDeletedProductIds(), id]);
  }

  const overrides = getProductOverrides();
  if (overrides[id]) {
    delete overrides[id];
    saveProductOverrides(overrides);
  }
  return getProducts();
}

function getSkuStockMap(product) {
  const map = {};
  (product.skus || []).forEach((sku) => {
    map[sku.id] = normalizeStock(sku.stock);
  });
  return map;
}

function updateSkuStock(productId, skuIdOrPackageType, stock) {
  const product = getProductById(productId);
  if (!product) return null;
  const sku = findSku(product, skuIdOrPackageType);
  if (!sku) return null;
  const skuStocks = getSkuStockMap(product);
  skuStocks[sku.id] = normalizeStock(stock);
  const totalStock = Object.values(skuStocks).reduce((sum, value) => sum + normalizeStock(value), 0);
  return updateProductOverride(productId, {
    skuStocks,
    status: totalStock > 0 ? 'on_sale' : 'sold_out_auto'
  });
}

function addSkuStock(productId, skuIdOrPackageType, delta) {
  const product = getProductById(productId);
  if (!product) return null;
  const sku = findSku(product, skuIdOrPackageType);
  if (!sku) return null;
  return updateSkuStock(productId, sku.id, normalizeStock(sku.stock) + normalizeStock(delta));
}

function zeroProductSkuStocks(productId) {
  const product = getProductById(productId);
  if (!product) return null;
  const skuStocks = {};
  (product.skus || []).forEach((sku) => {
    skuStocks[sku.id] = 0;
  });
  return updateProductOverride(productId, { skuStocks, status: 'sold_out_auto' });
}

function decrementStock(productId, quantity, skuIdOrPackageType = '') {
  const product = getProductById(productId);
  if (!product) return null;
  const sku = findSku(product, skuIdOrPackageType);
  if (!sku) return null;
  const skuStocks = getSkuStockMap(product);
  skuStocks[sku.id] = Math.max(0, normalizeStock(sku.stock) - normalizeStock(quantity));
  const totalStock = Object.values(skuStocks).reduce((sum, value) => sum + normalizeStock(value), 0);
  return updateProductOverride(productId, {
    skuStocks,
    status: totalStock <= 0 ? 'sold_out_auto' : product.status
  });
}

function normalizePackageTypes(packageTypes) {
  const normalized = (Array.isArray(packageTypes) ? packageTypes : [])
    .filter((type) => type === 'box' || type === 'bag');
  return normalized.length ? [...new Set(normalized)] : ['box', 'bag'];
}

function normalizePickupPoint(point) {
  const id = point.id || makeLocalId('pickup');
  return {
    id,
    name: String(point.name || '').trim(),
    address: String(point.address || '').trim(),
    latitude: point.latitude === '' || point.latitude === undefined || point.latitude === null ? '' : Number(point.latitude),
    longitude: point.longitude === '' || point.longitude === undefined || point.longitude === null ? '' : Number(point.longitude),
    phone: String(point.phone || '').trim(),
    openTime: String(point.openTime || '').trim(),
    packageTypes: normalizePackageTypes(point.packageTypes),
    enabled: point.enabled !== false,
    dailyCapacity: Math.max(0, Math.floor(Number(point.dailyCapacity) || 0)),
    sortWeight: Math.floor(Number(point.sortWeight) || 0),
    notice: String(point.notice || '').trim(),
    source: point.source || 'custom',
    updatedAt: point.updatedAt || new Date().toISOString()
  };
}

function getCustomPickupPoints() {
  const pickupPoints = safeGet(KEYS.pickupPoints, []);
  return (Array.isArray(pickupPoints) ? pickupPoints : [])
    .map(normalizePickupPoint)
    .filter((point) => point.name && point.address);
}

function saveCustomPickupPoints(pickupPoints) {
  safeSet(KEYS.pickupPoints, (pickupPoints || []).map(normalizePickupPoint));
}

function getDeletedPickupPointIds() {
  const ids = safeGet(KEYS.deletedPickupPointIds, []);
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '')).filter(Boolean))];
}

function saveDeletedPickupPointIds(ids) {
  safeSet(KEYS.deletedPickupPointIds, [...new Set((ids || []).map((id) => String(id || '')).filter(Boolean))]);
}

function getPickupPoints() {
  const customPickupPoints = getCustomPickupPoints();
  const customIds = new Set(customPickupPoints.map((point) => point.id));
  const deletedIds = getDeletedPickupPointIds();
  const normalizedDefaults = (defaultPickupPoints || [])
    .map((point, index) => normalizePickupPoint({
      dailyCapacity: 0,
      sortWeight: index,
      notice: '',
      ...point,
      source: 'default'
    }))
    .filter((point) => !customIds.has(point.id) && !deletedIds.includes(point.id));

  return [...customPickupPoints, ...normalizedDefaults].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.sortWeight !== b.sortWeight) return a.sortWeight - b.sortWeight;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  });
}

function getPickupPointById(id) {
  return getPickupPoints().find((point) => point.id === id) || null;
}

function upsertPickupPoint(point) {
  const normalized = normalizePickupPoint({
    ...point,
    id: point.id || makeLocalId('pickup'),
    source: 'custom',
    updatedAt: new Date().toISOString()
  });
  const current = getCustomPickupPoints();
  const next = current.some((item) => item.id === normalized.id)
    ? current.map((item) => item.id === normalized.id ? normalized : item)
    : [normalized, ...current];
  saveCustomPickupPoints(next);
  saveDeletedPickupPointIds(getDeletedPickupPointIds().filter((id) => id !== normalized.id));
  return normalized;
}

function deletePickupPoint(id) {
  const pointId = String(id || '');
  if (!pointId) return getPickupPoints();

  const customPickupPoints = getCustomPickupPoints();
  const nextCustomPickupPoints = customPickupPoints.filter((point) => point.id !== pointId);
  const isDefaultPickupPoint = (defaultPickupPoints || []).some((point) => point.id === pointId);
  if (nextCustomPickupPoints.length !== customPickupPoints.length) {
    saveCustomPickupPoints(nextCustomPickupPoints);
    if (isDefaultPickupPoint) {
      saveDeletedPickupPointIds([...getDeletedPickupPointIds(), pointId]);
    }
  } else if (isDefaultPickupPoint) {
    saveDeletedPickupPointIds([...getDeletedPickupPointIds(), pointId]);
  }
  return getPickupPoints();
}

function togglePickupPoint(id, enabled) {
  const point = getPickupPointById(id);
  if (!point) return null;
  return upsertPickupPoint({ ...point, enabled: Boolean(enabled) });
}

function getOrders() {
  return safeGet(KEYS.orders, []) || [];
}

function saveOrders(orders) {
  safeSet(KEYS.orders, orders || []);
}

function createOrder(order) {
  const orders = getOrders();
  if (order && order.id) {
    const existing = orders.find((item) => item.id === order.id);
    if (existing) return existing;
  }
  const nextOrder = {
    ...order,
    id: order.id || makeLocalId('order'),
    createdAt: new Date().toISOString()
  };
  saveOrders([nextOrder, ...orders]);
  return nextOrder;
}

function getOrderById(orderId) {
  return getOrders().find((order) => order.id === orderId) || null;
}

function appendFulfillmentLog(order, action, detail) {
  const logs = Array.isArray(order.fulfillmentLogs) ? order.fulfillmentLogs : [];
  return [
    {
      action,
      detail: String(detail || ''),
      createdAt: new Date().toISOString()
    },
    ...logs
  ];
}

function updateOrder(orderId, patch) {
  let updatedOrder = null;
  const nextOrders = getOrders().map((order) => {
    if (order.id !== orderId) return order;
    updatedOrder = {
      ...order,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return updatedOrder;
  });
  saveOrders(nextOrders);
  return updatedOrder;
}

function markOrderShipped(orderId, shipment) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const company = String(shipment && shipment.company || '').trim();
  const trackingNo = String(shipment && shipment.trackingNo || '').trim();
  const shippedAt = new Date().toISOString();
  return updateOrder(orderId, {
    status: 'shipped',
    statusText: '已发货',
    expressShipment: {
      company,
      trackingNo,
      shippedAt
    },
    fulfillmentLogs: appendFulfillmentLog(order, 'shipped', `${company} ${trackingNo}`.trim())
  });
}

function markOrderPickedUp(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  return updateOrder(orderId, {
    status: 'picked_up',
    statusText: '已自提',
    pickedUpAt: new Date().toISOString(),
    fulfillmentLogs: appendFulfillmentLog(order, 'picked_up', order.pickupPointName || '自提核销')
  });
}

function markOrderCompleted(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  return updateOrder(orderId, {
    status: 'completed',
    statusText: '已完成',
    completedAt: new Date().toISOString(),
    fulfillmentLogs: appendFulfillmentLog(order, 'completed', '订单完成')
  });
}

function canOrderApplyAfterSale(order) {
  if (!order || order.afterSaleInfo) return false;
  if (order.status === 'completed') return true;
  if (order.deliveryType === 'pickup') return order.status === 'picked_up';
  if (order.deliveryType === 'express') return order.status === 'completed';
  return false;
}

function markOrderAfterSale(orderId, reason) {
  const order = getOrderById(orderId);
  if (!order) return null;
  if (!canOrderApplyAfterSale(order)) return null;
  const detail = String(reason || '售后处理中').trim();
  return updateOrder(orderId, {
    status: 'after_sale',
    statusText: '售后中',
    afterSaleInfo: {
      reason: detail,
      requestedAt: new Date().toISOString()
    },
    fulfillmentLogs: appendFulfillmentLog(order, 'after_sale', detail)
  });
}

function markOrderRefunded(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  return updateOrder(orderId, {
    status: 'refunded',
    statusText: '已退款',
    refundedAt: new Date().toISOString(),
    fulfillmentLogs: appendFulfillmentLog(order, 'refunded', '退款完成')
  });
}

function cancelOrder(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  return updateOrder(orderId, {
    status: 'cancelled',
    statusText: '已取消',
    cancelledAt: new Date().toISOString(),
    fulfillmentLogs: appendFulfillmentLog(order, 'cancelled', '订单取消')
  });
}

function normalizeShippingRule(rule = {}) {
  const legacyExpressFee = normalizeCents(rule.expressBaseFee ?? DEFAULT_SHIPPING_RULE.expressBaseFee);
  const localExpressFee = normalizeCents(rule.localExpressFee ?? legacyExpressFee);
  const remoteExpressFee = normalizeCents(rule.remoteExpressFee ?? legacyExpressFee);
  return {
    expressBaseFee: remoteExpressFee,
    localExpressFee,
    remoteExpressFee,
    freeShippingThreshold: normalizeCents(rule.freeShippingThreshold ?? DEFAULT_SHIPPING_RULE.freeShippingThreshold),
    pickupFee: normalizeCents(rule.pickupFee ?? DEFAULT_SHIPPING_RULE.pickupFee),
    localRegions: normalizeLocalRegions(rule.localRegions || rule.localRegionsText),
    note: String(rule.note || DEFAULT_SHIPPING_RULE.note).trim(),
    updatedAt: rule.updatedAt || ''
  };
}

function getShippingRule() {
  return normalizeShippingRule(safeGet(KEYS.shippingRule, DEFAULT_SHIPPING_RULE));
}

function saveShippingRule(rule) {
  const normalized = normalizeShippingRule({
    ...rule,
    updatedAt: new Date().toISOString()
  });
  safeSet(KEYS.shippingRule, normalized);
  return normalized;
}

function calculateShippingFee({ deliveryType, goodsAmount, expressAddress = '', expressInfo = null, quantity = 1 }) {
  const rule = getShippingRule();
  const amount = normalizeCents(goodsAmount);
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  if (deliveryType !== 'express') {
    return {
      fee: rule.pickupFee,
      isFree: rule.pickupFee <= 0,
      label: rule.pickupFee > 0 ? '自提服务费' : '自提免运费',
      rule
    };
  }
  const address = expressAddress || (expressInfo && expressInfo.address) || '';
  const zone = detectExpressZone(address, rule);
  const unitFee = zone === 'local' ? rule.localExpressFee : rule.remoteExpressFee;
  const fee = unitFee * count;
  if (rule.freeShippingThreshold > 0 && amount >= rule.freeShippingThreshold) {
    return {
      fee: 0,
      isFree: true,
      label: '已满足快递包邮',
      zone,
      rule
    };
  }
  return {
    fee,
    unitFee,
    quantity: count,
    isFree: fee <= 0,
    label: fee > 0 ? (zone === 'local' ? '本地快递运费' : '省外快递运费') : '快递免运费',
    zone,
    rule
  };
}

function normalizeAddress(address) {
  return {
    id: address.id || makeLocalId('addr'),
    receiver: String(address.receiver || '').trim(),
    phone: String(address.phone || '').replace(/\D/g, ''),
    address: String(address.address || '').trim(),
    isDefault: Boolean(address.isDefault),
    updatedAt: address.updatedAt || new Date().toISOString()
  };
}

function addressContentKey(address) {
  return [
    String(address && address.receiver || '').trim(),
    String(address && address.phone || '').replace(/\D/g, ''),
    String(address && address.address || '').trim()
  ].join('|');
}

function dedupeAddresses(addresses = []) {
  const seen = new Set();
  return addresses.filter((address) => {
    const key = addressContentKey(address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getAddresses() {
  const addresses = safeGet(KEYS.addresses, []);
  return dedupeAddresses((Array.isArray(addresses) ? addresses : [])
    .map(normalizeAddress)
    .filter((address) => address.receiver && /^1\d{10}$/.test(address.phone) && address.address));
}

function saveAddresses(addresses) {
  safeSet(KEYS.addresses, dedupeAddresses((addresses || []).map(normalizeAddress)));
}

function sameAddressContent(left, right) {
  return addressContentKey(left) === addressContentKey(right);
}

function upsertAddress(address) {
  const normalized = normalizeAddress({ ...address, updatedAt: new Date().toISOString() });
  const current = getAddresses();
  const existing = current.find((item) => item.id === normalized.id) || current.find((item) => sameAddressContent(item, normalized));
  const merged = existing ? { ...normalized, id: existing.id } : normalized;
  let next = existing
    ? current.map((item) => item.id === existing.id ? merged : item)
    : [merged, ...current];
  if (normalized.isDefault || next.length === 1) {
    next = next.map((item) => ({ ...item, isDefault: item.id === merged.id }));
  }
  saveAddresses(next);
  return merged;
}

function deleteAddress(addressId) {
  const next = getAddresses().filter((address) => address.id !== addressId);
  saveAddresses(next);
  return next;
}

function getDefaultAddress() {
  const addresses = getAddresses();
  return addresses.find((address) => address.isDefault) || addresses[0] || null;
}

function getAdminPhones() {
  const phones = safeGet(KEYS.adminPhones, []);
  return [...new Set((Array.isArray(phones) ? phones : [])
    .map(normalizePhone)
    .filter((phone) => /^1\d{10}$/.test(phone)))];
}

function hasAdminPhones() {
  return getAdminPhones().length > 0;
}

function isAdminPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  return /^1\d{10}$/.test(normalizedPhone) && getAdminPhones().includes(normalizedPhone);
}

function addAdminPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!/^1\d{10}$/.test(normalizedPhone)) return getAdminPhones();
  const next = [...new Set([...getAdminPhones(), normalizedPhone])];
  safeSet(KEYS.adminPhones, next);
  return next;
}

module.exports = {
  getCurrentPhone,
  setCurrentPhone,
  markInventoryChanged,
  getInventoryChangedAt,
  getWhitelistEntries,
  appendWhitelistEntries,
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateProductOverride,
  updateSkuStock,
  addSkuStock,
  zeroProductSkuStocks,
  decrementStock,
  getPickupPoints,
  getPickupPointById,
  upsertPickupPoint,
  deletePickupPoint,
  togglePickupPoint,
  getOrders,
  createOrder,
  getOrderById,
  updateOrder,
  markOrderShipped,
  markOrderPickedUp,
  markOrderCompleted,
  canOrderApplyAfterSale,
  markOrderAfterSale,
  markOrderRefunded,
  cancelOrder,
  getShippingRule,
  saveShippingRule,
  calculateShippingFee,
  getAddresses,
  saveAddresses,
  upsertAddress,
  deleteAddress,
  getDefaultAddress,
  getAdminPhones,
  hasAdminPhones,
  isAdminPhone,
  addAdminPhone
};
