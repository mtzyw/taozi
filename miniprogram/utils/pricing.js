const coupons = require('../data/coupons');
const discountConfig = require('../data/discount-config');

function roundCents(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function formatCents(value) {
  return (roundCents(value) / 100).toFixed(2);
}

function normalizeStock(stock) {
  const value = Number(stock);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizeProductIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      return normalizeProductIds(JSON.parse(value));
    } catch (_) {}
  }
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeWhitelistEntries(entries) {
  return (entries || [])
    .map((entry) => {
      if (typeof entry === 'string') {
        return { phone: normalizePhone(entry), discountPercent: discountConfig.whitelistDefaultDiscountPercent, productIds: [], source: '导入白名单' };
      }
      return {
        ...entry,
        phone: normalizePhone(entry.phone),
        discountPercent: Number(entry.discountPercent || discountConfig.whitelistDefaultDiscountPercent),
        productIds: normalizeProductIds(entry.productIds || entry.product_ids || entry.product_ids_json),
        source: entry.source || '导入白名单'
      };
    })
    .filter((entry) => /^1\d{10}$/.test(entry.phone));
}

function getWhitelistDiscount(phone, entries, productId = '') {
  const normalizedPhone = normalizePhone(phone);
  if (!/^1\d{10}$/.test(normalizedPhone)) return null;
  const normalizedProductId = String(productId || '').trim();
  const matched = normalizeWhitelistEntries(entries).slice().reverse().find((entry) => {
    if (entry.phone !== normalizedPhone) return false;
    if (!normalizedProductId || !entry.productIds || !entry.productIds.length) return true;
    return entry.productIds.includes(normalizedProductId);
  });
  if (!matched) return null;
  return {
    type: 'whitelist',
    label: matched.label || discountConfig.whitelistLabel,
    percent: matched.discountPercent,
    source: matched.source,
    productIds: matched.productIds || []
  };
}

function isCouponApplicableToProduct(coupon, productId = '') {
  const productIds = normalizeProductIds(coupon && coupon.productIds);
  const normalizedProductId = String(productId || '').trim();
  return !productIds.length || !normalizedProductId || productIds.includes(normalizedProductId);
}

function findCoupon(code, now = new Date()) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) return null;
  const current = now.getTime();
  return coupons.find((coupon) => {
    if (!coupon.enabled || coupon.code !== normalizedCode) return false;
    const startsAt = coupon.startsAt ? new Date(coupon.startsAt).getTime() : 0;
    const endsAt = coupon.endsAt ? new Date(coupon.endsAt).getTime() : Number.MAX_SAFE_INTEGER;
    return current >= startsAt && current <= endsAt;
  }) || null;
}

function applyPercent(amount, percent) {
  return roundCents(amount * Number(percent) / 100);
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

function normalizeSku(product, sku = {}, index = 0) {
  const packageTypes = product.packageTypes || [];
  const packageType = sku.packageType || packageTypes[index] || packageTypes[0] || 'box';
  const price = roundCents(sku.price ?? product.price);
  const salePrice = roundCents(sku.salePrice ?? product.salePrice ?? sku.price ?? product.price);
  return {
    id: sku.id || `${product.id}-${packageType}`,
    packageType,
    label: sku.label || fallbackPackageLabel(packageType),
    name: sku.name || sku.label || fallbackPackageLabel(packageType),
    weightText: sku.weightText || '',
    price,
    salePrice,
    stock: normalizeStock(sku.stock ?? product.stock),
    deliveryMethods: normalizeSkuDeliveryMethods(packageType, sku.deliveryMethods || product.deliveryMethods),
    description: sku.description || ''
  };
}

function getProductSkus(product) {
  if (!product) return [];
  if (Array.isArray(product.skus) && product.skus.length) {
    return product.skus.map((sku, index) => normalizeSku(product, sku, index));
  }
  const packageTypes = product.packageTypes && product.packageTypes.length ? product.packageTypes : ['box'];
  return packageTypes.map((packageType, index) => normalizeSku(product, { packageType }, index));
}

function getProductSku(product, skuIdOrPackageType = '') {
  const skus = getProductSkus(product);
  if (!skus.length) return null;
  const key = String(skuIdOrPackageType || '');
  return skus.find((sku) => sku.id === key || sku.packageType === key) || skus[0];
}

function getSkuPriceRange(product, phone = '', whitelistEntries = []) {
  const skus = getProductSkus(product);
  if (!skus.length) return null;
  const prices = skus.map((sku) => calculateProductPrice({ product, sku, phone, whitelistEntries }).payAmount);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices)
  };
}

function calculateProductPrice({ product, sku = null, skuId = '', packageType = '', quantity = 1, phone = '', whitelistEntries = [], couponCode = '', globalDiscountPercent = discountConfig.globalDiscountPercent }) {
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  const activeSku = sku || getProductSku(product, skuId || packageType);
  const activeUnitPrice = roundCents(activeSku ? activeSku.salePrice : product.salePrice ?? product.price);
  let subtotal = activeUnitPrice * count;
  const trace = [];

  const whitelistDiscount = getWhitelistDiscount(phone, whitelistEntries, product && product.id);
  if (whitelistDiscount) {
    const before = subtotal;
    subtotal = applyPercent(subtotal, whitelistDiscount.percent);
    trace.push({
      type: 'whitelist',
      label: whitelistDiscount.label,
      source: whitelistDiscount.source,
      percent: whitelistDiscount.percent,
      amount: before - subtotal
    });
  }

  const globalPercent = Number(globalDiscountPercent || 100);
  if (globalPercent > 0 && globalPercent < 100) {
    const before = subtotal;
    subtotal = applyPercent(subtotal, globalPercent);
    trace.push({ type: 'global', label: `全场 ${globalPercent} 折`, percent: globalPercent, amount: before - subtotal });
  }

  const coupon = findCoupon(couponCode);
  let appliedCoupon = null;
  let couponError = '';
  if (whitelistDiscount && String(couponCode || '').trim()) {
    couponError = '白名单用户不可使用优惠码';
  } else if (coupon && !isCouponApplicableToProduct(coupon, product && product.id)) {
    couponError = '优惠码不适用于当前商品';
  } else if (coupon) {
    const minOrderAmount = roundCents(
      coupon.minOrderAmount
        ?? coupon.minOrderAmountCents
        ?? coupon.min_order_amount_cents
        ?? 0
    );
    if (minOrderAmount > 0 && subtotal < minOrderAmount) {
      couponError = `未达到优惠码使用门槛：满 ${formatCents(minOrderAmount)} 元可用`;
    } else {
      const before = subtotal;
      if (coupon.type === 'amount') {
        subtotal = Math.max(0, subtotal - roundCents(coupon.value));
      } else if (coupon.type === 'percent') {
        subtotal = applyPercent(subtotal, coupon.value);
      }
      appliedCoupon = { ...coupon, minOrderAmount };
      trace.push({
        type: 'coupon',
        label: `优惠码 ${coupon.code}`,
        source: coupon.source,
        minOrderAmount,
        amount: before - subtotal
      });
    }
  }

  return {
    originalTotal: activeUnitPrice * count,
    saleTotal: activeUnitPrice * count,
    payAmount: roundCents(subtotal),
    quantity: count,
    unitPrice: activeUnitPrice,
    sku: activeSku,
    trace,
    whitelistDiscount,
    coupon: appliedCoupon,
    couponError
  };
}

function parsePhoneImport(text, discountPercent = discountConfig.whitelistDefaultDiscountPercent, productIds = []) {
  const phones = String(text || '')
    .split(/[\s,，;；]+/)
    .map(normalizePhone)
    .filter((phone) => /^1\d{10}$/.test(phone));
  const uniquePhones = [...new Set(phones)];
  return uniquePhones.map((phone) => ({
    phone,
    discountPercent: Number(discountPercent) || discountConfig.whitelistDefaultDiscountPercent,
    productIds: normalizeProductIds(productIds),
    source: '小程序管理后台导入',
    importedAt: new Date().toISOString()
  }));
}

module.exports = {
  normalizePhone,
  normalizeWhitelistEntries,
  getWhitelistDiscount,
  findCoupon,
  isCouponApplicableToProduct,
  getProductSkus,
  getProductSku,
  getSkuPriceRange,
  calculateProductPrice,
  parsePhoneImport
};
