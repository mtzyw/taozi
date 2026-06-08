function normalizeStock(stock) {
  const value = Number(stock);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function fallbackPackageLabel(packageType) {
  return packageType === 'box' ? '盒装' : '袋装';
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

function buildFallbackSkus(product) {
  const packageTypes = product.packageTypes && product.packageTypes.length ? product.packageTypes : ['box'];
  return packageTypes.map((packageType) => ({
    id: `${product.id}-${packageType}`,
    packageType,
    label: fallbackPackageLabel(packageType),
    name: fallbackPackageLabel(packageType),
    weightText: '',
    price: product.price,
    salePrice: product.salePrice,
    deliveryMethods: normalizeSkuDeliveryMethods(packageType, product.deliveryMethods)
  }));
}

function distributeStock(totalStock, count) {
  const safeCount = Math.max(1, Number(count) || 1);
  const total = normalizeStock(totalStock);
  const base = Math.floor(total / safeCount);
  const remainder = total % safeCount;
  return Array.from({ length: safeCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function resolveSkus(product, override = {}) {
  const rawSkus = Array.isArray(override.skus) && override.skus.length
    ? override.skus
    : Array.isArray(product.skus) && product.skus.length
      ? product.skus
      : buildFallbackSkus(product);
  const overrideSkuStocks = override.skuStocks || {};
  const fallbackStocks = distributeStock(override.stock ?? product.stock, rawSkus.length);
  const useLegacyTotalOverride = override.stock !== undefined && override.skuStocks === undefined;
  const hasExplicitSkuStock = !useLegacyTotalOverride && rawSkus.some((sku) => sku.stock !== undefined && sku.stock !== null);

  return rawSkus.map((sku, index) => {
    const skuId = sku.id || `${product.id}-${sku.packageType || index}`;
    const stock = overrideSkuStocks[skuId] !== undefined
      ? overrideSkuStocks[skuId]
      : hasExplicitSkuStock
        ? sku.stock
        : fallbackStocks[index];
    return {
      ...sku,
      id: skuId,
      stock: normalizeStock(stock),
      deliveryMethods: normalizeSkuDeliveryMethods(sku.packageType, sku.deliveryMethods || product.deliveryMethods)
    };
  });
}

function getSkuStockTotal(skus) {
  return (skus || []).reduce((sum, sku) => sum + normalizeStock(sku.stock), 0);
}

function findSku(product, skuIdOrPackageType = '') {
  const key = String(skuIdOrPackageType || '');
  const skus = Array.isArray(product.skus) ? product.skus : [];
  if (!skus.length) return null;
  if (!key) return skus[0];
  return skus.find((sku) => sku.id === key || sku.packageType === key) || skus[0];
}

function resolveProduct(product, override = {}) {
  const skus = resolveSkus(product, override);
  const stock = getSkuStockTotal(skus);
  let status = override.status || product.status || 'draft';

  if (stock <= 0 && status === 'on_sale') {
    status = 'sold_out_auto';
  }

  return {
    ...product,
    ...override,
    skus,
    stock,
    status,
    statusChangedAt: override.statusChangedAt || product.statusChangedAt || override.updatedAt || product.updatedAt || product.listedAt,
    isOnSale: status === 'on_sale' && stock > 0,
    isSoldOut: stock <= 0 || status === 'sold_out_auto'
  };
}

function resolveProducts(products, overrides = {}) {
  return products.map((product) => resolveProduct(product, overrides[product.id] || {}));
}

function productSortTime(product, key, fallbackKey = 'updatedAt') {
  const value = new Date(product[key] || product[fallbackKey] || product.listedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function productManualSortOrder(product) {
  const value = Number(product && (product.manualSortOrder ?? product.manual_sort_order));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function productIsOnSaleForSort(product) {
  return Boolean(product && (product.isOnSale || (product.status === 'on_sale' && normalizeStock(product.stock) > 0)));
}

function sortProductsForDisplay(products) {
  return [...(products || [])].sort((a, b) => {
    const aOnSale = productIsOnSaleForSort(a);
    const bOnSale = productIsOnSaleForSort(b);
    if (aOnSale !== bOnSale) return aOnSale ? -1 : 1;
    const aPriority = productManualSortOrder(a);
    const bPriority = productManualSortOrder(b);
    const aManual = aPriority !== null;
    const bManual = bPriority !== null;
    if (aManual !== bManual) return aManual ? -1 : 1;
    if (aManual && bManual && aPriority !== bPriority) return aPriority - bPriority;
    const timeDiff = aOnSale
      ? productSortTime(b, 'listedAt') - productSortTime(a, 'listedAt')
      : productSortTime(b, 'statusChangedAt') - productSortTime(a, 'statusChangedAt');
    if (timeDiff) return timeDiff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function latestOnSaleProduct(products) {
  return sortProductsForDisplay(products)
    .find((product) => productIsOnSaleForSort(product)) || null;
}

function canPurchase(product, quantity, skuIdOrPackageType = '') {
  const sku = skuIdOrPackageType ? findSku(product, skuIdOrPackageType) : null;
  const stock = normalizeStock(sku ? sku.stock : product.stock);
  const count = normalizeStock(quantity);
  return product.status === 'on_sale' && count > 0 && stock >= count;
}

module.exports = {
  normalizeStock,
  resolveSkus,
  getSkuStockTotal,
  findSku,
  resolveProduct,
  resolveProducts,
  sortProductsForDisplay,
  latestOnSaleProduct,
  canPurchase
};
