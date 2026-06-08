const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const defaultProducts = require('../miniprogram/data/products');
const defaultPickupPoints = require('../miniprogram/data/pickup-points');
const defaultWhitelist = require('../miniprogram/data/whitelist');
const defaultCoupons = require('../miniprogram/data/coupons');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.PEACH_DB_PATH || path.join(DATA_DIR, 'peach-admin.sqlite');
const DEFAULT_SHIPPING_RULE = {
  expressBaseFee: 1200,
  localExpressFee: 1200,
  remoteExpressFee: 1200,
  freeShippingThreshold: 19800,
  pickupFee: 0,
  localRegions: ['四川', '四川省', '重庆', '重庆市', '成都', '成都市', '绵阳', '绵阳市', '德阳', '德阳市', '广元', '广元市', '遂宁', '遂宁市', '内江', '内江市', '乐山', '乐山市', '南充', '南充市', '眉山', '眉山市', '宜宾', '宜宾市', '广安', '广安市', '达州', '达州市', '雅安', '雅安市', '巴中', '巴中市', '资阳', '资阳市', '自贡', '自贡市', '攀枝花', '攀枝花市', '泸州', '泸州市', '甘孜', '甘孜州', '甘孜藏族自治州', '阿坝', '阿坝州', '阿坝藏族羌族自治州', '凉山', '凉山州', '凉山彝族自治州', '万州', '万州区', '黔江', '黔江区', '涪陵', '涪陵区', '渝中', '渝中区', '大渡口', '大渡口区', '江北区', '沙坪坝', '沙坪坝区', '九龙坡', '九龙坡区', '南岸区', '北碚', '北碚区', '渝北', '渝北区', '巴南', '巴南区', '长寿', '长寿区', '江津', '江津区', '合川', '合川区', '永川', '永川区', '南川', '南川区', '綦江', '綦江区', '大足', '大足区', '璧山', '璧山区', '铜梁', '铜梁区', '潼南', '潼南区', '荣昌', '荣昌区', '开州', '开州区', '梁平', '梁平区', '武隆', '武隆区', '城口', '城口县', '丰都', '丰都县', '垫江', '垫江县', '忠县', '云阳', '云阳县', '奉节', '奉节县', '巫山', '巫山县', '巫溪', '巫溪县', '石柱', '石柱县', '秀山', '秀山县', '酉阳', '酉阳县', '彭水', '彭水县'],
  note: '自提免运费，四川/重庆按省内快递费，其他地址按省外快递费；快递费按件计算，满 198 元包邮。'
};
const INBOUND_INVENTORY_TYPES = ['initial_stock', 'stock_restock', 'stock_adjust_in'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');

function shouldSeedDemoData() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PEACH_SEED_DEMO_DATA || '').trim().toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(value, minutes) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() + Math.max(1, Number(minutes) || 15) * 60 * 1000).toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function makeOrderId() {
  return `${Date.now()}${crypto.randomInt(0, 100000).toString().padStart(5, '0')}`;
}

function makeUniqueOrderId() {
  for (let index = 0; index < 10; index += 1) {
    const id = makeOrderId();
    if (!db.prepare('SELECT id FROM orders WHERE id = ?').get(id)) return id;
  }
  return `${Date.now()}${crypto.randomInt(0, 100000000).toString().padStart(8, '0')}`;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value || []);
}

function hashPickupPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.createHash('sha256').update(`${salt}:${String(password || '')}`).digest('hex');
  return { salt, hash };
}

function isPickupPasswordMatch(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const { hash } = hashPickupPassword(password, salt);
  const actual = Buffer.from(hash);
  const expected = Buffer.from(String(expectedHash));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizeCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue));
}

function yuanToCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue * 100));
}

function centsToYuan(cents) {
  return (normalizeCents(cents) / 100).toFixed(2);
}

function normalizePackageTypes(payload) {
  const list = Array.isArray(payload.packageTypes)
    ? payload.packageTypes
    : [payload.packageBox ? 'box' : '', payload.packageBag ? 'bag' : ''];
  const filtered = list.filter((type) => type === 'box' || type === 'bag');
  return filtered.length ? [...new Set(filtered)] : ['box'];
}

function normalizeDeliveryMethods(payload) {
  const list = Array.isArray(payload.deliveryMethods)
    ? payload.deliveryMethods
    : [payload.deliveryPickup ? 'pickup' : '', payload.deliveryExpress ? 'express' : ''];
  const filtered = list.filter((type) => type === 'pickup' || type === 'express');
  return filtered.length ? [...new Set(filtered)] : ['pickup'];
}

function normalizeSkuDeliveryMethods(packageType, methods) {
  if (packageType === 'bag') return ['pickup'];
  const filtered = (Array.isArray(methods) ? methods : [])
    .filter((type) => type === 'pickup' || type === 'express');
  return filtered.length ? [...new Set(filtered)] : ['pickup'];
}

function mergeSkuDeliveryMethods(skus, fallbackMethods = ['pickup']) {
  const merged = [];
  (skus || []).forEach((sku) => {
    normalizeSkuDeliveryMethods(sku.packageType || sku.package_type, sku.deliveryMethods || sku.delivery_methods || fallbackMethods)
      .forEach((method) => {
        if (!merged.includes(method)) merged.push(method);
      });
  });
  return merged.length ? merged : normalizeDeliveryMethods({ deliveryMethods: fallbackMethods });
}

function normalizeTags(payload) {
  if (Array.isArray(payload.tags)) return payload.tags.filter(Boolean);
  return String(payload.tagsText || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeImages(payload) {
  const values = Array.isArray(payload.images)
    ? payload.images
    : String(payload.imagesText || '')
      .split(/[\n,，;；]+/);
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeIdList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,，;；]+/);
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeLocalRegions(value) {
  const regions = normalizeIdList(value);
  return [...new Set([...DEFAULT_SHIPPING_RULE.localRegions, ...regions])];
}

function detectExpressZone(address, rule = getShippingRule()) {
  const text = String(address || '').replace(/\s+/g, '');
  const localRegions = normalizeLocalRegions(rule.localRegions);
  if (!text) return 'local';
  if (text && localRegions.some((region) => region && text.includes(region))) return 'local';
  return 'remote';
}

function getPriceCents(payload, key, fallbackKey) {
  if (payload[key] !== undefined && payload[key] !== '') return normalizeCents(payload[key]);
  const yuanKey = `${key.replace(/Cents$/, '')}Yuan`;
  if (payload[yuanKey] !== undefined && payload[yuanKey] !== '') return yuanToCents(payload[yuanKey]);
  if (fallbackKey && payload[fallbackKey] !== undefined && payload[fallbackKey] !== '') return normalizeCents(payload[fallbackKey]);
  return 0;
}

function normalizeSaleType(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'direct' || text === '直售' || text === '现货' || text === 'spot' ? 'direct' : 'presale';
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      price_cents INTEGER NOT NULL DEFAULT 0,
      sale_price_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'on_sale',
      sale_type TEXT NOT NULL DEFAULT 'presale',
      delivery_methods_json TEXT NOT NULL DEFAULT '[]',
      pickup_point_ids_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      presale_note TEXT DEFAULT '',
      customer_contact TEXT DEFAULT '',
      customer_phone TEXT DEFAULT '',
      pickup_valid_hours INTEGER NOT NULL DEFAULT 0,
      batch_name TEXT DEFAULT '',
      harvest_start TEXT DEFAULT '',
      harvest_end TEXT DEFAULT '',
      ship_start TEXT DEFAULT '',
      ship_end TEXT DEFAULT '',
      order_deadline TEXT DEFAULT '',
      detail_text TEXT DEFAULT '',
      listed_at TEXT NOT NULL,
      status_changed_at TEXT DEFAULT '',
      manual_sort_order INTEGER DEFAULT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_skus (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      package_type TEXT NOT NULL,
      label TEXT DEFAULT '',
      name TEXT DEFAULT '',
      weight_text TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      sale_price_cents INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      delivery_methods_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pickup_points (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      phone TEXT DEFAULT '',
      open_time TEXT DEFAULT '',
      package_types_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      daily_capacity INTEGER NOT NULL DEFAULT 0,
      sort_weight INTEGER NOT NULL DEFAULT 0,
      notice TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipping_rules (
      id TEXT PRIMARY KEY DEFAULT 'default',
      express_base_fee_cents INTEGER NOT NULL DEFAULT 1200,
      local_express_fee_cents INTEGER NOT NULL DEFAULT 1200,
      remote_express_fee_cents INTEGER NOT NULL DEFAULT 1200,
      local_regions_json TEXT NOT NULL DEFAULT '[]',
      free_shipping_threshold_cents INTEGER NOT NULL DEFAULT 19800,
      pickup_fee_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wechat_users (
      openid TEXT PRIMARY KEY,
      unionid TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whitelist_entries (
      phone TEXT PRIMARY KEY,
      discount_percent INTEGER NOT NULL DEFAULT 80,
      label TEXT DEFAULT '白名单折扣',
      source TEXT DEFAULT '网页后台导入',
      product_ids_json TEXT NOT NULL DEFAULT '[]',
      rules_json TEXT NOT NULL DEFAULT '[]',
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      min_order_amount_cents INTEGER NOT NULL DEFAULT 0,
      source TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      starts_at TEXT DEFAULT '',
      ends_at TEXT DEFAULT '',
      product_ids_json TEXT NOT NULL DEFAULT '[]',
      usage_limit INTEGER NOT NULL DEFAULT 0,
      per_phone_limit INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupon_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_code TEXT NOT NULL,
      order_id TEXT NOT NULL,
      buyer_phone TEXT DEFAULT '',
      discount_amount_cents INTEGER NOT NULL DEFAULT 0,
      used_at TEXT NOT NULL,
      UNIQUE(coupon_code, order_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      buyer_phone TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'awaiting_shipment',
      status_text TEXT DEFAULT '',
      sale_type TEXT NOT NULL DEFAULT 'presale',
      wechat_openid TEXT DEFAULT '',
      wechat_transaction_id TEXT DEFAULT '',
      wechat_shipping_status TEXT DEFAULT '',
      wechat_shipping_synced_at TEXT DEFAULT '',
      wechat_shipping_error TEXT DEFAULT '',
      wechat_shipping_type INTEGER NOT NULL DEFAULT 0,
      wechat_shipping_payload_json TEXT DEFAULT '',
      wechat_shipping_response_json TEXT DEFAULT '',
      wechat_receipt_confirmed_at TEXT DEFAULT '',
      wechat_receipt_state INTEGER NOT NULL DEFAULT 0,
      wechat_receipt_response_json TEXT DEFAULT '',
      wechat_refund_no TEXT DEFAULT '',
      wechat_refund_id TEXT DEFAULT '',
      wechat_refund_status TEXT DEFAULT '',
      wechat_refund_requested_at TEXT DEFAULT '',
      wechat_refund_success_at TEXT DEFAULT '',
      wechat_refund_response_json TEXT DEFAULT '',
      wechat_refund_error TEXT DEFAULT '',
      delivery_type TEXT NOT NULL DEFAULT 'pickup',
      pickup_point_id TEXT DEFAULT '',
      pickup_point_name TEXT DEFAULT '',
      pickup_code TEXT DEFAULT '',
      express_receiver TEXT DEFAULT '',
      express_phone TEXT DEFAULT '',
      express_address TEXT DEFAULT '',
      express_company TEXT DEFAULT '',
      tracking_no TEXT DEFAULT '',
      shipping_fee_cents INTEGER NOT NULL DEFAULT 0,
      shipping_label TEXT DEFAULT '',
      goods_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_amount_cents INTEGER NOT NULL DEFAULT 0,
      pay_amount_cents INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT DEFAULT '',
      discount_trace_json TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      after_sale_reason TEXT DEFAULT '',
      after_sale_status TEXT DEFAULT '',
      refund_amount_cents INTEGER NOT NULL DEFAULT 0,
      after_sale_refund_note TEXT DEFAULT '',
      after_sale_requested_at TEXT DEFAULT '',
      after_sale_handled_at TEXT DEFAULT '',
      customer_contact TEXT DEFAULT '',
      customer_phone TEXT DEFAULT '',
      pickup_valid_hours INTEGER NOT NULL DEFAULT 0,
      fulfillment_start TEXT DEFAULT '',
      fulfillment_end TEXT DEFAULT '',
      shipped_at TEXT DEFAULT '',
      picked_up_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      refunded_at TEXT DEFAULT '',
      cancelled_at TEXT DEFAULT '',
      paid_at TEXT DEFAULT '',
      payment_expires_at TEXT DEFAULT '',
      inventory_restocked_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT,
      product_name TEXT DEFAULT '',
      sku_id TEXT DEFAULT '',
      sku_name TEXT DEFAULT '',
      package_type TEXT DEFAULT '',
      package_label TEXT DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fulfillment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      order_id TEXT DEFAULT '',
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      before_stock INTEGER NOT NULL,
      after_stock INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT DEFAULT 'admin',
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS addresses (
      id TEXT PRIMARY KEY,
      buyer_phone TEXT NOT NULL,
      receiver TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumn('products', 'images_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('products', 'detail_text', "TEXT DEFAULT ''");
  ensureColumn('products', 'pickup_point_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('products', 'status_changed_at', "TEXT DEFAULT ''");
  ensureColumn('products', 'manual_sort_order', "INTEGER DEFAULT NULL");
  ensureColumn('products', 'sale_type', "TEXT NOT NULL DEFAULT 'presale'");
  ensureColumn('products', 'customer_contact', "TEXT DEFAULT ''");
  ensureColumn('products', 'customer_phone', "TEXT DEFAULT ''");
  ensureColumn('products', 'pickup_valid_hours', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('whitelist_entries', 'product_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('whitelist_entries', 'rules_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('shipping_rules', 'local_express_fee_cents', "INTEGER DEFAULT NULL");
  ensureColumn('shipping_rules', 'remote_express_fee_cents', "INTEGER DEFAULT NULL");
  ensureColumn('shipping_rules', 'local_regions_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('orders', 'discount_trace_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('orders', 'inventory_restocked_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'paid_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'payment_expires_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'sale_type', "TEXT NOT NULL DEFAULT 'presale'");
  ensureColumn('orders', 'wechat_openid', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_transaction_id', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_shipping_status', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_shipping_synced_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_shipping_error', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_shipping_type', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('orders', 'wechat_shipping_payload_json', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_shipping_response_json', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_receipt_confirmed_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_receipt_state', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('orders', 'wechat_receipt_response_json', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_no', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_id', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_status', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_requested_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_success_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_response_json', "TEXT DEFAULT ''");
  ensureColumn('orders', 'wechat_refund_error', "TEXT DEFAULT ''");
  ensureColumn('orders', 'after_sale_status', "TEXT DEFAULT ''");
  ensureColumn('orders', 'refund_amount_cents', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('orders', 'after_sale_refund_note', "TEXT DEFAULT ''");
  ensureColumn('orders', 'after_sale_requested_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'after_sale_handled_at', "TEXT DEFAULT ''");
  ensureColumn('orders', 'customer_contact', "TEXT DEFAULT ''");
  ensureColumn('orders', 'customer_phone', "TEXT DEFAULT ''");
  ensureColumn('orders', 'pickup_valid_hours', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('orders', 'fulfillment_start', "TEXT DEFAULT ''");
  ensureColumn('orders', 'fulfillment_end', "TEXT DEFAULT ''");
  ensureColumn('pickup_points', 'login_account', "TEXT DEFAULT ''");
  ensureColumn('pickup_points', 'password_hash', "TEXT DEFAULT ''");
  ensureColumn('pickup_points', 'password_salt', "TEXT DEFAULT ''");
  ensureColumn('coupons', 'min_order_amount_cents', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('coupons', 'product_ids_json', "TEXT NOT NULL DEFAULT '[]'");
}

function seedProductsIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (count > 0) return;
  for (const product of defaultProducts) {
    upsertProduct({
      id: product.id,
      name: product.name,
      subtitle: product.subtitle,
      coverImage: product.coverImage,
      images: product.images,
      priceCents: product.price,
      salePriceCents: product.salePrice,
      status: product.status,
      deliveryMethods: product.deliveryMethods,
      tags: product.tags,
      presaleNote: product.presaleNote,
      batchName: product.batchName || '默认预售批次',
      harvestStart: product.harvestStart || '',
      harvestEnd: product.harvestEnd || '',
      shipStart: product.shipStart || '',
      shipEnd: product.shipEnd || '',
      orderDeadline: product.orderDeadline || '',
      listedAt: product.listedAt,
      skus: product.skus
    });
  }
}

function repairExpiredSeedProductImages() {
  for (const product of defaultProducts) {
    const coverImage = String(product.coverImage || '').trim();
    if (!coverImage.startsWith('/uploads/seed-images/')) continue;
    const row = db.prepare('SELECT cover_image, images_json FROM products WHERE id = ?').get(product.id);
    if (!row) continue;
    const currentCover = String(row.cover_image || '');
    const currentImages = parseJson(row.images_json, []);
    const hasExpiredImage = currentCover.includes('uguu.se')
      || currentImages.some((image) => String(image || '').includes('uguu.se'));
    if (!hasExpiredImage) continue;
    db.prepare('UPDATE products SET cover_image = ?, images_json = ?, updated_at = ? WHERE id = ?')
      .run(coverImage, json([coverImage]), nowIso(), product.id);
  }
}

function ensureInitialInventoryMovementsIfNeeded() {
  const salesStatsCache = new Map();
  const skus = db.prepare('SELECT id, product_id, stock FROM product_skus').all();
  for (const sku of skus) {
    const existingInbound = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inventory_movements
      WHERE product_id = ? AND sku_id = ? AND type IN (${INBOUND_INVENTORY_TYPES.map(() => '?').join(',')})
    `).get(sku.product_id, sku.id, ...INBOUND_INVENTORY_TYPES).count;
    if (existingInbound > 0) continue;
    if (!salesStatsCache.has(sku.product_id)) {
      salesStatsCache.set(sku.product_id, getProductSalesStatsBySku(sku.product_id));
    }
    const stats = salesStatsCache.get(sku.product_id)[sku.id] || { soldCount: 0, lockedCount: 0 };
    const inferredInitialStock = Number(sku.stock || 0) + Number(stats.soldCount || 0) + Number(stats.lockedCount || 0);
    if (inferredInitialStock <= 0) continue;
    addInventoryMovement({
      productId: sku.product_id,
      skuId: sku.id,
      type: 'initial_stock',
      quantity: inferredInitialStock,
      beforeStock: 0,
      afterStock: Number(sku.stock || 0),
      note: '系统补录初始库存'
    });
  }
}

function seedPickupPointsIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM pickup_points').get().count;
  if (count > 0) return;
  defaultPickupPoints.forEach((point, index) => {
    upsertPickupPoint({ ...point, sortWeight: index });
  });
}

function seedShippingRuleIfNeeded() {
  const row = db.prepare('SELECT id FROM shipping_rules WHERE id = ?').get('default');
  if (row) return;
  saveShippingRule(DEFAULT_SHIPPING_RULE);
}

function seedWhitelistIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM whitelist_entries').get().count;
  if (count > 0) return;
  for (const entry of defaultWhitelist || []) {
    upsertWhitelistEntry(entry);
  }
}

function seedCouponsIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM coupons').get().count;
  if (count > 0) return;
  for (const coupon of defaultCoupons || []) {
    upsertCoupon(coupon);
  }
}

function initDb() {
  migrate();
  seedShippingRuleIfNeeded();
  if (shouldSeedDemoData()) {
    seedProductsIfNeeded();
    repairExpiredSeedProductImages();
    seedPickupPointsIfNeeded();
    seedWhitelistIfNeeded();
    seedCouponsIfNeeded();
  }
  ensureInitialInventoryMovementsIfNeeded();
  return DB_PATH;
}

function rowToProduct(row) {
  const salesStatsBySku = getProductSalesStatsBySku(row.id);
  const inventoryStatsBySku = getProductInventoryStatsBySku(row.id);
  const skus = listProductSkus(row.id).map((sku) => {
    const stats = salesStatsBySku[sku.id] || { soldCount: 0, lockedCount: 0 };
    const inventoryStats = inventoryStatsBySku[sku.id] || { inboundCount: 0, adjustedOutCount: 0 };
    const stock = Number(sku.stock || 0);
    const soldCount = Number(stats.soldCount || 0);
    const lockedCount = Number(stats.lockedCount || 0);
    const initialStock = inventoryStats.inboundCount > 0
      ? Number(inventoryStats.inboundCount)
      : stock + soldCount + lockedCount;
    return {
      ...sku,
      soldCount,
      lockedCount,
      initialStock,
      adjustedOutCount: Number(inventoryStats.adjustedOutCount || 0),
      remainingStock: stock
    };
  });
  const packageTypes = [...new Set(skus.map((sku) => sku.packageType))];
  const stock = skus.reduce((sum, sku) => sum + Number(sku.stock || 0), 0);
  const soldCount = skus.reduce((sum, sku) => sum + Number(sku.soldCount || 0), 0);
  const lockedCount = skus.reduce((sum, sku) => sum + Number(sku.lockedCount || 0), 0);
  const initialStock = skus.reduce((sum, sku) => sum + Number(sku.initialStock || 0), 0);
  const status = stock <= 0 && row.status === 'on_sale' ? 'sold_out_auto' : row.status;
  const images = parseJson(row.images_json, []);
  const normalizedImages = images.length ? images : (row.cover_image ? [row.cover_image] : []);
  const deliveryMethods = mergeSkuDeliveryMethods(skus, parseJson(row.delivery_methods_json, []));
  const manualSortOrder = Number(row.manual_sort_order);
  const normalizedManualSortOrder = Number.isFinite(manualSortOrder) && manualSortOrder > 0
    ? Math.floor(manualSortOrder)
    : null;
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle || '',
    coverImage: row.cover_image || '',
    images: normalizedImages,
    packageTypes,
    price: row.price_cents,
    salePrice: row.sale_price_cents,
    priceText: centsToYuan(row.price_cents),
    salePriceText: centsToYuan(row.sale_price_cents),
    saleType: normalizeSaleType(row.sale_type),
    stock,
    remainingStock: stock,
    soldCount,
    lockedCount,
    initialStock,
    status,
    deliveryMethods,
    pickupPointIds: parseJson(row.pickup_point_ids_json, []),
    tags: parseJson(row.tags_json, []),
    presaleNote: row.presale_note || '',
    customerContact: row.customer_contact || '',
    customerPhone: row.customer_phone || '',
    pickupValidHours: Math.max(0, Number(row.pickup_valid_hours || 0)),
    batchName: row.batch_name || '',
    harvestStart: row.harvest_start || '',
    harvestEnd: row.harvest_end || '',
    shipStart: row.ship_start || '',
    shipEnd: row.ship_end || '',
    orderDeadline: row.order_deadline || '',
    detailText: row.detail_text || '',
    listedAt: row.listed_at,
    statusChangedAt: row.status_changed_at || row.updated_at || row.listed_at,
    manualSortOrder: normalizedManualSortOrder,
    isManualPriority: normalizedManualSortOrder !== null,
    updatedAt: row.updated_at,
    skus,
    isOnSale: status === 'on_sale' && stock > 0,
    isSoldOut: stock <= 0 || status === 'sold_out_auto'
  };
}

function rowToSku(row) {
  const deliveryMethods = normalizeSkuDeliveryMethods(row.package_type, parseJson(row.delivery_methods_json, []));
  return {
    id: row.id,
    productId: row.product_id,
    packageType: row.package_type,
    label: row.label || (row.package_type === 'box' ? '盒装' : '袋装'),
    name: row.name || '',
    weightText: row.weight_text || '',
    price: row.price_cents,
    salePrice: row.sale_price_cents,
    priceText: centsToYuan(row.price_cents),
    salePriceText: centsToYuan(row.sale_price_cents),
    stock: row.stock,
    deliveryMethods
  };
}

function listProductSkus(productId) {
  return db.prepare('SELECT * FROM product_skus WHERE product_id = ? ORDER BY sort_order, id').all(productId).map(rowToSku);
}

function getProductSalesStatsBySku(productId) {
  const rows = db.prepare(`
    SELECT
      oi.sku_id AS sku_id,
      SUM(CASE WHEN o.status = 'awaiting_payment' THEN oi.quantity ELSE 0 END) AS locked_count,
      SUM(CASE WHEN o.status NOT IN ('awaiting_payment', 'cancelled', 'refunded') THEN oi.quantity ELSE 0 END) AS sold_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ?
    GROUP BY oi.sku_id
  `).all(productId);
  return rows.reduce((map, row) => {
    map[row.sku_id] = {
      lockedCount: Math.max(0, Number(row.locked_count || 0)),
      soldCount: Math.max(0, Number(row.sold_count || 0))
    };
    return map;
  }, {});
}

function getProductInventoryStatsBySku(productId) {
  const inboundTypes = INBOUND_INVENTORY_TYPES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      sku_id,
      SUM(CASE WHEN type IN (${inboundTypes}) THEN quantity ELSE 0 END) AS inbound_count,
      SUM(CASE WHEN type = 'stock_adjust_out' THEN ABS(quantity) ELSE 0 END) AS adjusted_out_count
    FROM inventory_movements
    WHERE product_id = ?
    GROUP BY sku_id
  `).all(...INBOUND_INVENTORY_TYPES, productId);
  return rows.reduce((map, row) => {
    map[row.sku_id] = {
      inboundCount: Math.max(0, Number(row.inbound_count || 0)),
      adjustedOutCount: Math.max(0, Number(row.adjusted_out_count || 0))
    };
    return map;
  }, {});
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
  return Boolean(product && (product.isOnSale || (product.status === 'on_sale' && Number(product.stock || 0) > 0)));
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

function listProducts() {
  return sortProductsForDisplay(db.prepare('SELECT * FROM products').all().map(rowToProduct));
}

function getProduct(id) {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  return row ? rowToProduct(row) : null;
}

function upsertProduct(payload) {
  const id = payload.id || makeId('product');
  const now = nowIso();
  const existing = db.prepare('SELECT id, listed_at, status, status_changed_at FROM products WHERE id = ?').get(id);
  const nextStatus = payload.status || existing && existing.status || 'on_sale';
  const statusChangedAt = !existing || existing.status !== nextStatus
    ? now
    : (existing.status_changed_at || now);
  const listedAt = existing
    ? (existing.status !== 'on_sale' && nextStatus === 'on_sale' ? now : existing.listed_at)
    : (payload.listedAt || now);
  const oldSkuRows = existing
    ? db.prepare('SELECT id, package_type, stock FROM product_skus WHERE product_id = ?').all(id)
    : [];
  const oldSkusById = oldSkuRows.reduce((map, sku) => {
    map[sku.id] = sku;
    return map;
  }, {});
  const oldSkusByPackage = oldSkuRows.reduce((map, sku) => {
    if (sku.package_type && !map[sku.package_type]) map[sku.package_type] = sku;
    return map;
  }, {});
  const salePriceCents = getPriceCents(payload, 'salePriceCents') || getPriceCents(payload, 'priceCents');
  const priceCents = salePriceCents;
  const saleType = normalizeSaleType(payload.saleType || payload.sale_type);
  const requestedDeliveryMethods = normalizeDeliveryMethods(payload);
  const pickupPointIds = normalizeIdList(payload.pickupPointIds || payload.pickup_point_ids || payload.pickupPointIdsText);
  const tags = normalizeTags(payload);
  const batchName = String(payload.batchName || payload.batch_name || '').trim();
  if (!batchName) throw new Error('请输入批次名称');
  const pickupValidHours = Math.max(0, Math.floor(Number(payload.pickupValidHours ?? payload.pickup_valid_hours ?? 0)));
  const coverImage = String(payload.coverImage || payload.cover_image || '').trim();
  const images = normalizeImages(payload);
  if (coverImage && !images.includes(coverImage)) images.unshift(coverImage);
  const packageTypes = normalizePackageTypes(payload);
  const rawSkus = Array.isArray(payload.skus) && payload.skus.length
    ? payload.skus
    : packageTypes.map((packageType, index) => ({
      id: `${id}-${packageType}`,
      packageType,
      label: packageType === 'box' ? '盒装' : '袋装',
      name: `${payload.weightText || '默认规格'}${packageType === 'box' ? '盒装' : '袋装'}`,
      weightText: payload.weightText || '',
      price: priceCents,
      salePrice: salePriceCents,
      stock: packageType === 'box' ? Number(payload.boxStock || 0) : Number(payload.bagStock || 0),
      deliveryMethods: normalizeSkuDeliveryMethods(packageType, requestedDeliveryMethods),
      sortOrder: index
    }));
  const skus = rawSkus.map((sku, index) => {
    const packageType = sku.packageType || sku.package_type || packageTypes[index] || 'box';
    return {
      ...sku,
      packageType,
      deliveryMethods: normalizeSkuDeliveryMethods(packageType, sku.deliveryMethods || sku.delivery_methods || requestedDeliveryMethods)
    };
  });
  const deliveryMethods = mergeSkuDeliveryMethods(skus, requestedDeliveryMethods);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO products (
        id, name, subtitle, cover_image, images_json, price_cents, sale_price_cents, status, sale_type,
        delivery_methods_json, pickup_point_ids_json, tags_json, presale_note, customer_contact,
        customer_phone, pickup_valid_hours, batch_name, harvest_start,
        harvest_end, ship_start, ship_end, order_deadline, detail_text, listed_at, status_changed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        subtitle = excluded.subtitle,
        cover_image = excluded.cover_image,
        images_json = excluded.images_json,
        price_cents = excluded.price_cents,
        sale_price_cents = excluded.sale_price_cents,
        status = excluded.status,
        sale_type = excluded.sale_type,
        delivery_methods_json = excluded.delivery_methods_json,
        pickup_point_ids_json = excluded.pickup_point_ids_json,
        tags_json = excluded.tags_json,
        presale_note = excluded.presale_note,
        customer_contact = excluded.customer_contact,
        customer_phone = excluded.customer_phone,
        pickup_valid_hours = excluded.pickup_valid_hours,
        batch_name = excluded.batch_name,
        harvest_start = excluded.harvest_start,
        harvest_end = excluded.harvest_end,
        ship_start = excluded.ship_start,
        ship_end = excluded.ship_end,
        order_deadline = excluded.order_deadline,
        detail_text = excluded.detail_text,
        status_changed_at = excluded.status_changed_at,
        updated_at = excluded.updated_at
    `).run(
      id,
      String(payload.name || '').trim(),
      String(payload.subtitle || '').trim(),
      coverImage,
      json(images),
      priceCents,
      salePriceCents,
      nextStatus,
      saleType,
      json(deliveryMethods),
      json(pickupPointIds),
      json(tags.length ? tags : ['新上架', saleType === 'direct' ? '直售' : '预售']),
      String(payload.presaleNote || payload.presale_note || '').trim(),
      String(payload.customerContact || payload.customer_contact || '').trim(),
      String(payload.customerPhone || payload.customer_phone || '').trim(),
      pickupValidHours,
      batchName,
      String(payload.harvestStart || payload.harvest_start || '').trim(),
      String(payload.harvestEnd || payload.harvest_end || '').trim(),
      saleType === 'direct' ? '' : String(payload.shipStart || payload.ship_start || '').trim(),
      saleType === 'direct' ? '' : String(payload.shipEnd || payload.ship_end || '').trim(),
      saleType === 'direct' ? '' : String(payload.orderDeadline || payload.order_deadline || '').trim(),
      String(payload.detailText || payload.detail_text || '').trim(),
      listedAt,
      statusChangedAt,
      now
    );

    db.prepare('DELETE FROM product_skus WHERE product_id = ?').run(id);
    const skuStmt = db.prepare(`
      INSERT INTO product_skus (
        id, product_id, package_type, label, name, weight_text, price_cents,
        sale_price_cents, stock, delivery_methods_json, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const matchedOldSkuIds = new Set();
    skus.forEach((sku, index) => {
      const packageType = sku.packageType || sku.package_type || packageTypes[index] || 'box';
      const skuId = sku.id || `${id}-${packageType}`;
      const skuSalePrice = normalizeCents(sku.salePriceCents ?? sku.salePrice ?? sku.sale_price ?? sku.priceCents ?? sku.price ?? salePriceCents);
      const skuPrice = skuSalePrice;
      const newStock = Math.max(0, Math.floor(Number(sku.stock || 0)));
      const oldSku = oldSkusById[skuId] || oldSkusByPackage[packageType] || null;
      const beforeStock = oldSku ? Math.max(0, Math.floor(Number(oldSku.stock || 0))) : 0;
      const stockDelta = newStock - beforeStock;
      skuStmt.run(
        skuId,
        id,
        packageType,
        sku.label || (packageType === 'box' ? '盒装' : '袋装'),
        sku.name || `${sku.weightText || payload.weightText || '默认规格'}${packageType === 'box' ? '盒装' : '袋装'}`,
        sku.weightText || sku.weight_text || payload.weightText || '',
        skuPrice,
        skuSalePrice,
        newStock,
        json(normalizeSkuDeliveryMethods(packageType, sku.deliveryMethods || deliveryMethods)),
        Number(sku.sortOrder ?? index)
      );
      if (oldSku) matchedOldSkuIds.add(oldSku.id);
      if (!existing && newStock > 0) {
        addInventoryMovement({
          productId: id,
          skuId,
          type: 'initial_stock',
          quantity: newStock,
          beforeStock: 0,
          afterStock: newStock,
          note: '商品创建初始库存',
          createdAt: now
        });
      } else if (existing && stockDelta !== 0) {
        addInventoryMovement({
          productId: id,
          skuId,
          type: stockDelta > 0 ? 'stock_adjust_in' : 'stock_adjust_out',
          quantity: stockDelta,
          beforeStock,
          afterStock: newStock,
          note: stockDelta > 0 ? '后台编辑调增库存' : '后台编辑调减库存',
          createdAt: now
        });
      }
    });
    oldSkuRows.forEach((oldSku) => {
      const beforeStock = Math.max(0, Math.floor(Number(oldSku.stock || 0)));
      if (!matchedOldSkuIds.has(oldSku.id) && beforeStock > 0) {
        addInventoryMovement({
          productId: id,
          skuId: oldSku.id,
          type: 'stock_adjust_out',
          quantity: -beforeStock,
          beforeStock,
          afterStock: 0,
          note: '后台编辑移除规格库存',
          createdAt: now
        });
      }
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getProduct(id);
}

function updateProductStatus(id, status) {
  if (!['on_sale', 'off_sale_manual'].includes(status)) throw new Error('不支持的商品状态');
  if (status === 'on_sale') {
    const skus = db.prepare('SELECT package_type, label, name, stock FROM product_skus WHERE product_id = ? ORDER BY sort_order ASC').all(id);
    if (!skus.length) throw new Error('商品没有可售规格，不能上架');
    const emptySkus = skus.filter((sku) => Number(sku.stock || 0) <= 0);
    if (emptySkus.length) {
      const names = emptySkus.map((sku) => sku.name || sku.label || (sku.package_type === 'box' ? '盒装' : '袋装')).join('、');
      throw new Error(`${names}库存必须大于 0 才能上架`);
    }
  }
  const now = nowIso();
  const existing = db.prepare('SELECT status FROM products WHERE id = ?').get(id);
  if (!existing) return null;
  const shouldRefreshListedAt = existing && existing.status !== 'on_sale' && status === 'on_sale';
  if (shouldRefreshListedAt) {
    db.prepare('UPDATE products SET status = ?, listed_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(status, now, now, now, id);
  } else {
    db.prepare('UPDATE products SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(status, now, now, id);
  }
  return getProduct(id);
}

function deleteProduct(id) {
  return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0;
}

function compactProductPriorityOrders() {
  const rows = db.prepare(`
    SELECT id
    FROM products
    WHERE manual_sort_order IS NOT NULL AND manual_sort_order > 0
    ORDER BY manual_sort_order ASC, listed_at DESC, updated_at DESC, id ASC
  `).all();
  const now = nowIso();
  const stmt = db.prepare('UPDATE products SET manual_sort_order = ?, updated_at = ? WHERE id = ?');
  rows.forEach((row, index) => {
    stmt.run(index + 1, now, row.id);
  });
}

function updateProductPriority(id, action = 'set') {
  const normalizedAction = String(action || 'set').trim();
  if (!['set', 'up', 'down', 'clear'].includes(normalizedAction)) throw new Error('不支持的排序操作');
  const product = getProduct(id);
  if (!product) throw new Error('商品不存在');
  const now = nowIso();
  const currentOrder = productManualSortOrder(product);

  if (normalizedAction === 'clear') {
    db.prepare('UPDATE products SET manual_sort_order = NULL, updated_at = ? WHERE id = ?').run(now, id);
    compactProductPriorityOrders();
    return getProduct(id);
  }

  if (normalizedAction === 'set') {
    if (currentOrder !== null) return product;
    compactProductPriorityOrders();
    const maxRow = db.prepare('SELECT COALESCE(MAX(manual_sort_order), 0) AS max_order FROM products').get();
    db.prepare('UPDATE products SET manual_sort_order = ?, updated_at = ? WHERE id = ?').run(Number(maxRow.max_order || 0) + 1, now, id);
    return getProduct(id);
  }

  if (currentOrder === null) throw new Error('请先将商品设为优先排序');
  compactProductPriorityOrders();
  const currentProduct = getProduct(id);
  const currentOnSale = productIsOnSaleForSort(currentProduct);
  const priorityProducts = listProducts().filter((item) => (
    productManualSortOrder(item) !== null && productIsOnSaleForSort(item) === currentOnSale
  ));
  const currentIndex = priorityProducts.findIndex((item) => item.id === id);
  if (currentIndex < 0) return currentProduct;
  const nextIndex = normalizedAction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= priorityProducts.length) return currentProduct;
  const target = priorityProducts[nextIndex];
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE products SET manual_sort_order = ?, updated_at = ? WHERE id = ?')
      .run(productManualSortOrder(target), now, id);
    db.prepare('UPDATE products SET manual_sort_order = ?, updated_at = ? WHERE id = ?')
      .run(productManualSortOrder(currentProduct), now, target.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getProduct(id);
}

function refreshProductStockStatus(productId, now = nowIso()) {
  const product = db.prepare('SELECT status FROM products WHERE id = ?').get(productId);
  if (!product) return;
  const totalStock = db.prepare('SELECT COALESCE(SUM(stock), 0) AS stock FROM product_skus WHERE product_id = ?').get(productId).stock;
  let nextStatus = product.status;
  if (Number(totalStock || 0) <= 0 && nextStatus === 'on_sale') nextStatus = 'sold_out_auto';
  if (Number(totalStock || 0) > 0 && nextStatus === 'sold_out_auto') nextStatus = 'on_sale';
  const statusChangedAt = nextStatus !== product.status ? now : null;
  if (statusChangedAt) {
    if (nextStatus === 'on_sale') {
      db.prepare('UPDATE products SET status = ?, listed_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(nextStatus, now, statusChangedAt, now, productId);
    } else {
      db.prepare('UPDATE products SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(nextStatus, statusChangedAt, now, productId);
    }
  } else {
    db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now, productId);
  }
}

function updateProductSkuStock(productId, skuId, payload = {}) {
  const mode = payload.mode === 'add' || payload.action === 'add' ? 'add' : 'set';
  const rawValue = payload.quantity ?? payload.stock ?? payload.delta ?? 0;
  const quantity = Math.floor(Number(rawValue));
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('库存数量不能为负数');
  if (mode === 'add' && quantity <= 0) throw new Error('补货数量必须大于 0');

  const sku = db.prepare('SELECT * FROM product_skus WHERE product_id = ? AND id = ?').get(productId, skuId);
  if (!sku) throw new Error('商品规格不存在');
  const beforeStock = Math.max(0, Math.floor(Number(sku.stock || 0)));
  const afterStock = mode === 'add' ? beforeStock + quantity : quantity;
  const delta = afterStock - beforeStock;
  const now = nowIso();

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE product_skus SET stock = ? WHERE product_id = ? AND id = ?').run(afterStock, productId, skuId);
    if (delta !== 0) {
      addInventoryMovement({
        productId,
        skuId,
        type: mode === 'add' ? 'stock_restock' : (delta > 0 ? 'stock_adjust_in' : 'stock_adjust_out'),
        quantity: delta,
        beforeStock,
        afterStock,
        note: payload.note || (mode === 'add' ? '后台补货入库' : '后台设为库存'),
        createdAt: now
      });
    }
    refreshProductStockStatus(productId, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getProduct(productId);
}

function rowToPickupPoint(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    phone: row.phone || '',
    openTime: row.open_time || '',
    packageTypes: parseJson(row.package_types_json, []),
    loginAccount: row.login_account || '',
    hasLoginPassword: Boolean(row.login_account && row.password_hash),
    enabled: Boolean(row.enabled),
    dailyCapacity: row.daily_capacity,
    sortWeight: row.sort_weight,
    notice: row.notice || '',
    updatedAt: row.updated_at
  };
}

function listPickupPoints() {
  return db.prepare('SELECT * FROM pickup_points ORDER BY enabled DESC, sort_weight, name').all().map(rowToPickupPoint);
}

function getPickupPoint(id) {
  const row = db.prepare('SELECT * FROM pickup_points WHERE id = ?').get(id);
  return row ? rowToPickupPoint(row) : null;
}

function getPickupPointByContent(name, address) {
  const row = db.prepare(`
    SELECT * FROM pickup_points
    WHERE name = ? AND address = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(String(name || '').trim(), String(address || '').trim());
  return row ? rowToPickupPoint(row) : null;
}

function upsertPickupPoint(payload) {
  const name = String(payload.name || '').trim();
  const address = String(payload.address || '').trim();
  const existing = payload.id ? getPickupPoint(payload.id) : getPickupPointByContent(name, address);
  const id = payload.id || existing && existing.id || makeId('pickup');
  const existingRaw = db.prepare('SELECT * FROM pickup_points WHERE id = ?').get(id);
  const hasLatitude = Object.prototype.hasOwnProperty.call(payload, 'latitude');
  const hasLongitude = Object.prototype.hasOwnProperty.call(payload, 'longitude');
  const packageTypes = Array.isArray(payload.packageTypes)
    ? payload.packageTypes
    : [payload.packageBox ? 'box' : '', payload.packageBag ? 'bag' : ''].filter(Boolean);
  const loginAccount = String(payload.loginAccount || payload.login_account || '').trim();
  const loginPassword = String(payload.loginPassword || payload.login_password || payload.password || '');
  const duplicatedAccount = loginAccount
    ? db.prepare('SELECT id FROM pickup_points WHERE login_account = ? AND id != ?').get(loginAccount, id)
    : null;
  if (duplicatedAccount) throw new Error('自提点登录账号已被其他自提点使用');
  if (!loginAccount && loginPassword) throw new Error('请先填写自提点登录账号');
  if (loginAccount && !loginPassword && !(existingRaw && existingRaw.password_hash)) {
    throw new Error('请填写自提点登录密码');
  }
  const passwordPair = loginPassword ? hashPickupPassword(loginPassword) : null;
  const passwordHash = loginAccount ? (passwordPair ? passwordPair.hash : existingRaw && existingRaw.password_hash || '') : '';
  const passwordSalt = loginAccount ? (passwordPair ? passwordPair.salt : existingRaw && existingRaw.password_salt || '') : '';
  db.prepare(`
    INSERT INTO pickup_points (
      id, name, address, latitude, longitude, phone, open_time, package_types_json,
      login_account, password_hash, password_salt, enabled, daily_capacity, sort_weight, notice, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      address = excluded.address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      phone = excluded.phone,
      open_time = excluded.open_time,
      package_types_json = excluded.package_types_json,
      login_account = excluded.login_account,
      password_hash = excluded.password_hash,
      password_salt = excluded.password_salt,
      enabled = excluded.enabled,
      daily_capacity = excluded.daily_capacity,
      sort_weight = excluded.sort_weight,
      notice = excluded.notice,
      updated_at = excluded.updated_at
  `).run(
    id,
    name,
    address,
    hasLatitude ? (payload.latitude === '' || payload.latitude === undefined ? null : Number(payload.latitude)) : (existing ? existing.latitude : null),
    hasLongitude ? (payload.longitude === '' || payload.longitude === undefined ? null : Number(payload.longitude)) : (existing ? existing.longitude : null),
    String(payload.phone || '').trim(),
    String(payload.openTime || payload.open_time || '').trim(),
    json(packageTypes.length ? packageTypes : ['box', 'bag']),
    loginAccount,
    passwordHash,
    passwordSalt,
    payload.enabled === false ? 0 : 1,
    Math.max(0, Math.floor(Number(payload.dailyCapacity || payload.daily_capacity || 0))),
    Math.floor(Number(payload.sortWeight || payload.sort_weight || 0)),
    String(payload.notice || '').trim(),
    nowIso()
  );
  return getPickupPoint(id);
}

function authenticatePickupPoint(account, password) {
  const loginAccount = String(account || '').trim();
  const loginPassword = String(password || '');
  if (!loginAccount || !loginPassword) return null;
  const row = db.prepare('SELECT * FROM pickup_points WHERE login_account = ? AND enabled = 1').get(loginAccount);
  if (!row || !isPickupPasswordMatch(loginPassword, row.password_salt, row.password_hash)) return null;
  return rowToPickupPoint(row);
}

function pickupPointBlockingProducts(id) {
  const pickupId = String(id || '').trim();
  if (!pickupId) return [];
  return listProducts().filter((product) => (
    product.status === 'on_sale'
    && (product.deliveryMethods || []).includes('pickup')
    && (!(product.pickupPointIds || []).length || (product.pickupPointIds || []).map(String).includes(pickupId))
  ));
}

function assertPickupPointCanBeDisabled(id) {
  const products = pickupPointBlockingProducts(id);
  if (!products.length) return;
  const names = products.slice(0, 8).map((product) => product.name).join('、');
  const more = products.length > 8 ? `等 ${products.length} 个商品` : '';
  throw new Error(`该自提点仍被上架商品使用：${names}${more}，请先调整商品适用自提点或下架商品`);
}

function togglePickupPoint(id, enabled) {
  if (!enabled) assertPickupPointCanBeDisabled(id);
  db.prepare('UPDATE pickup_points SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), id);
  return getPickupPoint(id);
}

function deletePickupPoint(id) {
  const pickupId = String(id || '').trim();
  assertPickupPointCanBeDisabled(pickupId);
  return db.prepare('UPDATE pickup_points SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), pickupId).changes > 0;
}

function upsertWechatUser(payload = {}) {
  const openid = String(payload.openid || '').trim();
  if (!openid) return null;
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM wechat_users WHERE openid = ?').get(openid);
  db.prepare(`
    INSERT INTO wechat_users (openid, unionid, phone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(openid) DO UPDATE SET
      unionid = CASE WHEN excluded.unionid != '' THEN excluded.unionid ELSE wechat_users.unionid END,
      phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE wechat_users.phone END,
      updated_at = excluded.updated_at
  `).run(
    openid,
    String(payload.unionid || '').trim(),
    String(payload.phone || existing && existing.phone || '').replace(/\D/g, ''),
    existing ? existing.created_at : now,
    now
  );
  return getWechatUser(openid);
}

function getWechatUser(openid) {
  const row = db.prepare('SELECT * FROM wechat_users WHERE openid = ?').get(String(openid || '').trim());
  if (!row) return null;
  return {
    openid: row.openid,
    unionid: row.unionid || '',
    phone: row.phone || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function bindWechatUserPhone(openid, phone) {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (!openid || !/^1\d{10}$/.test(normalizedPhone)) return null;
  return upsertWechatUser({ openid, phone: normalizedPhone });
}

function findWechatOpenidByPhone(phone) {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(normalizedPhone)) return '';
  const rows = db.prepare('SELECT openid FROM wechat_users WHERE phone = ? ORDER BY datetime(updated_at) DESC').all(normalizedPhone);
  const uniqueOpenids = [...new Set(rows.map((row) => String(row.openid || '').trim()).filter(Boolean))];
  return uniqueOpenids.length === 1 ? uniqueOpenids[0] : '';
}

function updateOrderWechatOpenid(id, openid) {
  const orderId = String(id || '').trim();
  const value = String(openid || '').trim();
  if (!orderId || !value) return getOrder(orderId);
  const current = db.prepare('SELECT wechat_openid FROM orders WHERE id = ?').get(orderId);
  if (!current) return null;
  if (current.wechat_openid && current.wechat_openid !== value) return getOrder(orderId);
  db.prepare('UPDATE orders SET wechat_openid = ?, updated_at = ? WHERE id = ?').run(value, nowIso(), orderId);
  return getOrder(orderId);
}

function getShippingRule() {
  const row = db.prepare('SELECT * FROM shipping_rules WHERE id = ?').get('default');
  if (!row) return DEFAULT_SHIPPING_RULE;
  const legacyExpressFee = normalizeCents(row.express_base_fee_cents ?? DEFAULT_SHIPPING_RULE.expressBaseFee);
  const localExpressFee = normalizeCents(row.local_express_fee_cents ?? legacyExpressFee);
  const remoteExpressFee = normalizeCents(row.remote_express_fee_cents ?? legacyExpressFee);
  return {
    expressBaseFee: remoteExpressFee,
    localExpressFee,
    remoteExpressFee,
    localRegions: normalizeLocalRegions(parseJson(row.local_regions_json, DEFAULT_SHIPPING_RULE.localRegions)),
    freeShippingThreshold: row.free_shipping_threshold_cents,
    pickupFee: row.pickup_fee_cents,
    note: row.note || DEFAULT_SHIPPING_RULE.note,
    updatedAt: row.updated_at
  };
}

function getExpressAddress(expressInfo = {}) {
  if (typeof expressInfo === 'string') return expressInfo;
  return String(expressInfo.address || expressInfo.expressAddress || '');
}

function calculateShippingFee(deliveryType, goodsAmountCents, expressInfo = {}, quantity = 1) {
  const rule = getShippingRule();
  const goodsAmount = normalizeCents(goodsAmountCents);
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  if (deliveryType !== 'express') {
    return {
      fee: rule.pickupFee,
      label: rule.pickupFee > 0 ? '自提服务费' : '自提免运费',
      rule
    };
  }
  const zone = detectExpressZone(getExpressAddress(expressInfo), rule);
  const unitFee = zone === 'local' ? rule.localExpressFee : rule.remoteExpressFee;
  const fee = unitFee * count;
  if (rule.freeShippingThreshold > 0 && goodsAmount >= rule.freeShippingThreshold) {
    return {
      fee: 0,
      label: '已满足快递包邮',
      zone,
      rule
    };
  }
  return {
    fee,
    unitFee,
    quantity: count,
    label: fee > 0 ? (zone === 'local' ? '省内快递运费' : '省外快递运费') : '快递免运费',
    zone,
    rule
  };
}

function saveShippingRule(payload) {
  const legacyExpressFee = normalizeCents(payload.expressBaseFee ?? payload.expressBaseFeeCents ?? DEFAULT_SHIPPING_RULE.expressBaseFee);
  const localExpressFee = normalizeCents(payload.localExpressFee ?? payload.localExpressFeeCents ?? legacyExpressFee);
  const remoteExpressFee = normalizeCents(payload.remoteExpressFee ?? payload.remoteExpressFeeCents ?? legacyExpressFee);
  const rule = {
    expressBaseFee: remoteExpressFee,
    localExpressFee,
    remoteExpressFee,
    localRegions: normalizeLocalRegions(payload.localRegions || payload.localRegionsText),
    freeShippingThreshold: normalizeCents(payload.freeShippingThreshold ?? payload.freeShippingThresholdCents ?? DEFAULT_SHIPPING_RULE.freeShippingThreshold),
    pickupFee: normalizeCents(payload.pickupFee ?? payload.pickupFeeCents ?? DEFAULT_SHIPPING_RULE.pickupFee),
    note: String(payload.note || DEFAULT_SHIPPING_RULE.note).trim()
  };
  db.prepare(`
    INSERT INTO shipping_rules (
      id, express_base_fee_cents, local_express_fee_cents, remote_express_fee_cents,
      local_regions_json, free_shipping_threshold_cents, pickup_fee_cents, note, updated_at
    )
    VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      express_base_fee_cents = excluded.express_base_fee_cents,
      local_express_fee_cents = excluded.local_express_fee_cents,
      remote_express_fee_cents = excluded.remote_express_fee_cents,
      local_regions_json = excluded.local_regions_json,
      free_shipping_threshold_cents = excluded.free_shipping_threshold_cents,
      pickup_fee_cents = excluded.pickup_fee_cents,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(
    rule.remoteExpressFee,
    rule.localExpressFee,
    rule.remoteExpressFee,
    json(rule.localRegions),
    rule.freeShippingThreshold,
    rule.pickupFee,
    rule.note,
    nowIso()
  );
  return getShippingRule();
}

function makeWhitelistRuleId(entry = {}, row = null) {
  const phone = String(entry.phone || row && row.phone || '').replace(/\D/g, '');
  const productIds = normalizeIdList(entry.productIds || entry.product_ids || entry.productIdsText || row && row.product_ids_json || [])
    .sort()
    .join(',');
  const raw = [
    phone,
    productIds,
    entry.discountPercent || entry.discount_percent || row && row.discount_percent || 80,
    entry.label || row && row.label || '白名单折扣',
    entry.importedAt || entry.imported_at || row && row.imported_at || ''
  ].join('|');
  return `white_${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

function makeWhitelistRule(entry, row = null) {
  return {
    id: entry.id || makeWhitelistRuleId(entry, row),
    discountPercent: Number(entry.discountPercent || entry.discount_percent || row && row.discount_percent || 80),
    label: String(entry.label || row && row.label || '白名单折扣'),
    source: String(entry.source || row && row.source || '网页后台导入'),
    productIds: normalizeIdList(entry.productIds || entry.product_ids || entry.productIdsText || []),
    importedAt: entry.importedAt || entry.imported_at || row && row.imported_at || nowIso()
  };
}

function normalizeWhitelistRules(rules, row = null) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => makeWhitelistRule(rule, row))
    .filter((rule) => Number(rule.discountPercent) > 0);
}

function rowToWhitelistRules(row) {
  const storedRules = normalizeWhitelistRules(parseJson(row.rules_json, []), row);
  if (storedRules.length) return storedRules;
  return [makeWhitelistRule({
    phone: row.phone,
    discountPercent: row.discount_percent,
    label: row.label,
    source: row.source,
    productIds: parseJson(row.product_ids_json, []),
    importedAt: row.imported_at
  }, row)];
}

function mergeWhitelistRules(existingRules, nextRule) {
  if (!nextRule.productIds.length) return [nextRule];
  const nextIds = new Set(nextRule.productIds);
  const merged = [];
  for (const rule of existingRules) {
    if (!rule.productIds.length) {
      merged.push(rule);
      continue;
    }
    const remainingProductIds = rule.productIds.filter((id) => !nextIds.has(id));
    if (remainingProductIds.length) merged.push({ ...rule, productIds: remainingProductIds });
  }
  merged.push(nextRule);
  return merged;
}

function upsertWhitelistEntry(entry) {
  const phone = String(entry.phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(phone)) return null;
  const productIds = normalizeIdList(entry.productIds || entry.product_ids || entry.productIdsText || []);
  if (!productIds.length) throw new Error('请选择白名单适用商品');
  const existing = db.prepare('SELECT * FROM whitelist_entries WHERE phone = ?').get(phone);
  const nextRule = makeWhitelistRule({ ...entry, productIds });
  const rules = mergeWhitelistRules(existing ? rowToWhitelistRules(existing) : [], nextRule);
  db.prepare(`
    INSERT INTO whitelist_entries (phone, discount_percent, label, source, product_ids_json, rules_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      discount_percent = excluded.discount_percent,
      label = excluded.label,
      source = excluded.source,
      product_ids_json = excluded.product_ids_json,
      rules_json = excluded.rules_json,
      imported_at = excluded.imported_at
  `).run(
    phone,
    nextRule.discountPercent,
    nextRule.label,
    nextRule.source,
    json(nextRule.productIds),
    json(rules),
    nextRule.importedAt
  );
  return phone;
}

function listWhitelistEntries() {
  const entries = [];
  db.prepare('SELECT * FROM whitelist_entries ORDER BY imported_at DESC').all().forEach((row) => {
    rowToWhitelistRules(row).forEach((rule) => {
      entries.push({
        phone: row.phone,
        ruleId: rule.id,
        discountPercent: rule.discountPercent,
        label: rule.label,
        source: rule.source,
        productIds: rule.productIds,
        importedAt: rule.importedAt
      });
    });
  });
  return entries.sort((a, b) => new Date(b.importedAt || 0).getTime() - new Date(a.importedAt || 0).getTime());
}

function importWhitelistEntries(text, discountPercent = 80, label = '白名单折扣', productIds = []) {
  const normalizedProductIds = normalizeIdList(productIds);
  if (!normalizedProductIds.length) throw new Error('请选择白名单适用商品');
  const phones = String(text || '')
    .split(/[\s,，;；]+/)
    .map((phone) => phone.replace(/\D/g, ''))
    .filter((phone) => /^1\d{10}$/.test(phone));
  const uniquePhones = [...new Set(phones)];
  uniquePhones.forEach((phone) => {
    upsertWhitelistEntry({
      phone,
      discountPercent,
      label,
      productIds: normalizedProductIds,
      source: '网页后台导入',
      importedAt: nowIso()
    });
  });
  return listWhitelistEntries();
}

function deleteWhitelistEntry(phone) {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  return db.prepare('DELETE FROM whitelist_entries WHERE phone = ?').run(normalizedPhone).changes > 0;
}

function deleteWhitelistRule(phone, ruleId) {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const normalizedRuleId = String(ruleId || '').trim();
  if (!/^1\d{10}$/.test(normalizedPhone) || !normalizedRuleId) return false;
  const row = db.prepare('SELECT * FROM whitelist_entries WHERE phone = ?').get(normalizedPhone);
  if (!row) return false;
  const rules = rowToWhitelistRules(row);
  const remainingRules = rules.filter((rule) => String(rule.id) !== normalizedRuleId);
  if (remainingRules.length === rules.length) return false;
  if (!remainingRules.length) {
    return deleteWhitelistEntry(normalizedPhone);
  }
  const latestRule = remainingRules.reduce((latest, rule) => {
    const latestTime = new Date(latest.importedAt || 0).getTime();
    const ruleTime = new Date(rule.importedAt || 0).getTime();
    return ruleTime >= latestTime ? rule : latest;
  }, remainingRules[0]);
  db.prepare(`
    UPDATE whitelist_entries
    SET discount_percent = ?, label = ?, source = ?, product_ids_json = ?, rules_json = ?, imported_at = ?
    WHERE phone = ?
  `).run(
    latestRule.discountPercent,
    latestRule.label,
    latestRule.source,
    json(latestRule.productIds),
    json(remainingRules),
    latestRule.importedAt,
    normalizedPhone
  );
  return true;
}

function getWhitelistDiscount(phone, productId = '') {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(normalizedPhone)) return null;
  const row = db.prepare('SELECT * FROM whitelist_entries WHERE phone = ?').get(normalizedPhone);
  if (!row) return null;
  const normalizedProductId = String(productId || '').trim();
  const rules = rowToWhitelistRules(row);
  const matched = [...rules].reverse().find((rule) => {
    if (!normalizedProductId || !rule.productIds.length) return true;
    return rule.productIds.includes(normalizedProductId);
  });
  if (!matched) return null;
  return {
    type: 'whitelist',
    label: matched.label || '白名单折扣',
    percent: matched.discountPercent,
    source: matched.source,
    productIds: matched.productIds
  };
}

function applyPercent(amount, percent) {
  return normalizeCents(normalizeCents(amount) * Number(percent) / 100);
}

function normalizeCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

function rowToCoupon(row) {
  const usage = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(discount_amount_cents), 0) AS amount
    FROM coupon_usages
    WHERE coupon_code = ?
  `).get(row.code);
  return {
    code: row.code,
    type: row.type,
    value: row.value,
    valueText: row.type === 'amount' ? centsToYuan(row.value) : String(row.value),
    minOrderAmount: row.min_order_amount_cents || 0,
    minOrderAmountText: centsToYuan(row.min_order_amount_cents || 0),
    source: row.source || '',
    enabled: Boolean(row.enabled),
    startsAt: row.starts_at || '',
    endsAt: row.ends_at || '',
    productIds: parseJson(row.product_ids_json, []),
    usageLimit: row.usage_limit,
    perPhoneLimit: row.per_phone_limit,
    usedCount: usage.count,
    usedAmount: usage.amount,
    usedAmountText: centsToYuan(usage.amount),
    remainingCount: row.usage_limit > 0 ? Math.max(0, row.usage_limit - usage.count) : null,
    updatedAt: row.updated_at
  };
}

function upsertCoupon(coupon) {
  const code = normalizeCouponCode(coupon.code);
  if (!code) return null;
  const type = coupon.type === 'percent' ? 'percent' : 'amount';
  const value = normalizeCents(coupon.value);
  const minOrderAmount = normalizeCents(
    coupon.minOrderAmount
      ?? coupon.minOrderAmountCents
      ?? coupon.min_order_amount_cents
      ?? 0
  );
  const productIds = normalizeIdList(coupon.productIds || coupon.product_ids || coupon.productIdsText);
  db.prepare(`
    INSERT INTO coupons (
      code, type, value, min_order_amount_cents, source, enabled, starts_at, ends_at,
      product_ids_json, usage_limit, per_phone_limit, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      type = excluded.type,
      value = excluded.value,
      min_order_amount_cents = excluded.min_order_amount_cents,
      source = excluded.source,
      enabled = excluded.enabled,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      product_ids_json = excluded.product_ids_json,
      usage_limit = excluded.usage_limit,
      per_phone_limit = excluded.per_phone_limit,
      updated_at = excluded.updated_at
  `).run(
    code,
    type,
    value,
    minOrderAmount,
    String(coupon.source || '').trim(),
    coupon.enabled === false ? 0 : 1,
    coupon.startsAt || coupon.starts_at || '',
    coupon.endsAt || coupon.ends_at || '',
    json(productIds),
    Math.max(0, Math.floor(Number(coupon.usageLimit ?? coupon.usage_limit ?? 0))),
    Math.max(0, Math.floor(Number(coupon.perPhoneLimit ?? coupon.per_phone_limit ?? 0))),
    nowIso()
  );
  return code;
}

function listCoupons() {
  return db.prepare('SELECT * FROM coupons ORDER BY updated_at DESC, code').all().map(rowToCoupon);
}

function deleteCoupon(code) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return false;
  return db.prepare('DELETE FROM coupons WHERE code = ?').run(normalizedCode).changes > 0;
}

function updateCouponStatus(code, enabled) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return null;
  db.prepare('UPDATE coupons SET enabled = ?, updated_at = ? WHERE code = ?')
    .run(enabled ? 1 : 0, nowIso(), normalizedCode);
  return getCoupon(normalizedCode);
}

function getCoupon(code) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return null;
  const row = db.prepare('SELECT * FROM coupons WHERE code = ?').get(normalizedCode);
  return row ? rowToCoupon(row) : null;
}

function isCouponApplicableToProduct(coupon, productId = '') {
  const productIds = normalizeIdList(coupon && coupon.productIds);
  const normalizedProductId = String(productId || '').trim();
  return !productIds.length || !normalizedProductId || productIds.includes(normalizedProductId);
}

function findActiveCoupon(code, now = new Date()) {
  const coupon = getCoupon(code);
  if (!coupon || !coupon.enabled) return null;
  const current = now.getTime();
  const startsAt = coupon.startsAt ? new Date(coupon.startsAt).getTime() : 0;
  const endsAt = coupon.endsAt ? new Date(coupon.endsAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(startsAt) && current < startsAt) return null;
  if (Number.isFinite(endsAt) && current > endsAt) return null;
  return coupon;
}

function getCouponUsageCount(code) {
  return db.prepare('SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = ?')
    .get(normalizeCouponCode(code)).count;
}

function getCouponPhoneUsageCount(code, phone) {
  return db.prepare('SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = ? AND buyer_phone = ?')
    .get(normalizeCouponCode(code), String(phone || '').replace(/\D/g, '')).count;
}

function calculateOrderQuote({ product, sku, quantity, buyerPhone, couponCode, deliveryType, expressInfo }) {
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  const saleUnitPrice = normalizeCents(sku.salePrice || sku.price);
  const originalTotal = saleUnitPrice * count;
  const saleTotal = saleUnitPrice * count;
  let goodsAmount = saleTotal;
  const trace = [];

  const normalizedPhone = String(buyerPhone || '').replace(/\D/g, '');
  const whitelistDiscount = getWhitelistDiscount(normalizedPhone, product && product.id);
  if (whitelistDiscount) {
    const before = goodsAmount;
    goodsAmount = applyPercent(goodsAmount, whitelistDiscount.percent);
    trace.push({
      type: 'whitelist',
      label: whitelistDiscount.label,
      source: whitelistDiscount.source,
      percent: whitelistDiscount.percent,
      amount: before - goodsAmount
    });
  }

  const normalizedCouponCode = normalizeCouponCode(couponCode);
  let coupon = null;
  if (normalizedCouponCode) {
    if (whitelistDiscount) throw new Error('白名单用户不可使用优惠码');
    coupon = findActiveCoupon(normalizedCouponCode);
    if (!coupon) throw new Error('优惠码无效或已过期');
    if (!isCouponApplicableToProduct(coupon, product && product.id)) throw new Error('优惠码不适用于当前商品');
    if (coupon.usageLimit > 0 && getCouponUsageCount(coupon.code) >= coupon.usageLimit) {
      throw new Error('优惠码已被使用完');
    }
    if (coupon.perPhoneLimit > 0 && getCouponPhoneUsageCount(coupon.code, normalizedPhone) >= coupon.perPhoneLimit) {
      throw new Error('该手机号已使用过此优惠码');
    }
    const minOrderAmount = normalizeCents(coupon.minOrderAmount);
    if (minOrderAmount > 0 && goodsAmount < minOrderAmount) {
      throw new Error(`未达到优惠码使用门槛：满 ${centsToYuan(minOrderAmount)} 元可用`);
    }
    const before = goodsAmount;
    if (coupon.type === 'amount') {
      goodsAmount = Math.max(0, goodsAmount - normalizeCents(coupon.value));
    } else if (coupon.type === 'percent') {
      goodsAmount = applyPercent(goodsAmount, coupon.value);
    }
    trace.push({
      type: 'coupon',
      label: `优惠码 ${coupon.code}`,
      source: coupon.source,
      code: coupon.code,
      minOrderAmount,
      amount: before - goodsAmount
    });
  }

  const shipping = calculateShippingFee(deliveryType, goodsAmount, expressInfo, count);
  return {
    originalTotal,
    saleTotal,
    goodsAmount,
    totalAmount: saleTotal,
    shipping,
    payAmount: goodsAmount + shipping.fee,
    unitPrice: saleUnitPrice,
    coupon,
    couponCode: coupon ? coupon.code : '',
    discountTrace: trace
  };
}

function rowToOrder(row) {
  const items = listOrderItems(row.id);
  const primaryItem = items[0] || {};
  const expressInfo = row.express_receiver ? {
    receiver: row.express_receiver,
    phone: row.express_phone,
    address: row.express_address
  } : null;
  const contactName = expressInfo && expressInfo.receiver ? expressInfo.receiver : '';
  const contactPhone = expressInfo && expressInfo.phone ? expressInfo.phone : row.buyer_phone;
  const destinationText = row.delivery_type === 'express'
    ? row.express_address
    : row.pickup_point_name;
  return {
    id: row.id,
    buyerPhone: row.buyer_phone,
    status: row.status,
    statusText: row.status_text || row.status,
    saleType: normalizeSaleType(row.sale_type || primaryItem.saleType),
    wechatOpenid: row.wechat_openid || '',
    wechatPayment: {
      transactionId: row.wechat_transaction_id || ''
    },
    wechatShipping: {
      status: row.wechat_shipping_status || '',
      syncedAt: row.wechat_shipping_synced_at || '',
      error: row.wechat_shipping_error || '',
      logisticsType: Number(row.wechat_shipping_type || 0)
    },
    wechatReceipt: {
      confirmedAt: row.wechat_receipt_confirmed_at || '',
      state: Number(row.wechat_receipt_state || 0)
    },
    wechatRefund: {
      outRefundNo: row.wechat_refund_no || '',
      refundId: row.wechat_refund_id || '',
      status: row.wechat_refund_status || '',
      requestedAt: row.wechat_refund_requested_at || '',
      successAt: row.wechat_refund_success_at || '',
      error: row.wechat_refund_error || ''
    },
    deliveryType: row.delivery_type,
    pickupPointId: row.pickup_point_id,
    pickupPointName: row.pickup_point_name,
    pickupCode: row.pickup_code,
    batchName: primaryItem.batchName || '',
    customerContact: row.customer_contact || primaryItem.customerContact || '',
    customerPhone: row.customer_phone || primaryItem.customerPhone || '',
    pickupValidHours: Math.max(0, Number(row.pickup_valid_hours || primaryItem.pickupValidHours || 0)),
    fulfillmentStart: row.fulfillment_start || primaryItem.shipStart || '',
    fulfillmentEnd: row.fulfillment_end || primaryItem.shipEnd || '',
    contactName,
    contactPhone,
    destinationText,
    expressInfo,
    expressShipment: row.tracking_no ? {
      company: row.express_company,
      trackingNo: row.tracking_no,
      shippedAt: row.shipped_at
    } : null,
    pickupArrivedAt: row.delivery_type === 'pickup' ? row.shipped_at : '',
    shippingFee: row.shipping_fee_cents,
    shippingLabel: row.shipping_label,
    goodsAmount: row.goods_amount_cents,
    totalAmount: row.total_amount_cents,
    payAmount: row.pay_amount_cents,
    couponCode: row.coupon_code,
    discountTrace: parseJson(row.discount_trace_json, []),
    note: row.note,
    afterSaleInfo: row.after_sale_reason || row.after_sale_status || row.after_sale_refund_note ? {
      reason: row.after_sale_reason,
      status: row.after_sale_status,
      refundAmount: row.refund_amount_cents,
      refundAmountText: centsToYuan(row.refund_amount_cents),
      refundNote: row.after_sale_refund_note || '',
      requestedAt: row.after_sale_requested_at,
      handledAt: row.after_sale_handled_at || (row.after_sale_status === 'refunded' ? row.refunded_at : '')
    } : null,
    shippedAt: row.shipped_at,
    pickedUpAt: row.picked_up_at,
    completedAt: row.completed_at,
    refundedAt: row.refunded_at,
    cancelledAt: row.cancelled_at,
    paidAt: row.paid_at || '',
    paymentExpiresAt: row.payment_expires_at || '',
    inventoryRestockedAt: row.inventory_restocked_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    fulfillmentLogs: listFulfillmentLogs(row.id)
  };
}

function listOrderItems(orderId) {
  return db.prepare(`
    SELECT oi.*, p.batch_name, p.sale_type, p.ship_start, p.ship_end, p.customer_contact, p.customer_phone, p.pickup_valid_hours
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `).all(orderId).map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    batchName: row.batch_name || '',
    saleType: normalizeSaleType(row.sale_type),
    shipStart: row.ship_start || '',
    shipEnd: row.ship_end || '',
    customerContact: row.customer_contact || '',
    customerPhone: row.customer_phone || '',
    pickupValidHours: Math.max(0, Number(row.pickup_valid_hours || 0)),
    skuId: row.sku_id,
    skuName: row.sku_name,
    packageType: row.package_type,
    packageLabel: row.package_label,
    quantity: row.quantity,
    unitPrice: row.unit_price_cents
  }));
}

function listFulfillmentLogs(orderId) {
  return db.prepare('SELECT * FROM fulfillment_logs WHERE order_id = ? ORDER BY datetime(created_at) DESC, id DESC').all(orderId).map((row) => ({
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

function appendOrderStatusFilter(clauses, params, status) {
  if (!status || status === 'all') return;
  if (status === 'express_awaiting_shipment') {
    clauses.push('delivery_type = ? AND status = ?');
    params.push('express', 'awaiting_shipment');
    return;
  }
  if (status === 'pickup_awaiting_shipment') {
    clauses.push('delivery_type = ? AND status IN (?, ?)');
    params.push('pickup', 'awaiting_shipment', 'awaiting_pickup');
    return;
  }
  if (status === 'pickup_shipped') {
    clauses.push('delivery_type = ? AND status = ?');
    params.push('pickup', 'pickup_shipped');
    return;
  }
  if (status === 'shipped') {
    clauses.push('delivery_type = ? AND status = ?');
    params.push('express', 'shipped');
    return;
  }
  if (status === 'express_received') {
    clauses.push(`delivery_type = ? AND (
      status IN (?, ?)
      OR (status IN (?, ?) AND (picked_up_at != '' OR completed_at != ''))
    )`);
    params.push('express', 'picked_up', 'completed', 'after_sale', 'refunded');
    return;
  }
  if (status === 'pickup_received') {
    clauses.push(`delivery_type = ? AND (
      status IN (?, ?)
      OR (status IN (?, ?) AND (picked_up_at != '' OR completed_at != ''))
    )`);
    params.push('pickup', 'picked_up', 'completed', 'after_sale', 'refunded');
    return;
  }
  clauses.push('status = ?');
  params.push(status);
}

function listOrders(filters = {}) {
  const clauses = [];
  const params = [];
  appendOrderStatusFilter(clauses, params, filters.status);
  if (filters.excludeAwaitingPayment) {
    clauses.push('status != ?');
    params.push('awaiting_payment');
  }
  if (filters.deliveryType && filters.deliveryType !== 'all') {
    clauses.push('delivery_type = ?');
    params.push(filters.deliveryType);
  }
  if (filters.saleType && filters.saleType !== 'all') {
    clauses.push('sale_type = ?');
    params.push(normalizeSaleType(filters.saleType));
  }
  if (filters.batchName) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = orders.id AND (p.batch_name LIKE ? OR oi.product_name LIKE ?)
    )`);
    const batchKeyword = `%${filters.batchName}%`;
    params.push(batchKeyword, batchKeyword);
  }
  if (filters.destination) {
    clauses.push('(pickup_point_name LIKE ? OR express_address LIKE ?)');
    const destinationKeyword = `%${filters.destination}%`;
    params.push(destinationKeyword, destinationKeyword);
  }
  if (filters.fulfillmentStart) {
    clauses.push(`COALESCE(NULLIF(fulfillment_start, ''), (
      SELECT p.ship_start
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = orders.id
      ORDER BY oi.id
      LIMIT 1
    ), '') >= ?`);
    params.push(String(filters.fulfillmentStart).trim());
  }
  if (filters.fulfillmentEnd) {
    clauses.push(`COALESCE(NULLIF(fulfillment_end, ''), (
      SELECT p.ship_end
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = orders.id
      ORDER BY oi.id
      LIMIT 1
    ), '') != '' AND COALESCE(NULLIF(fulfillment_end, ''), (
      SELECT p.ship_end
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = orders.id
      ORDER BY oi.id
      LIMIT 1
    ), '') <= ?`);
    params.push(String(filters.fulfillmentEnd).trim());
  }
  if (filters.buyerPhone) {
    clauses.push('buyer_phone = ?');
    params.push(String(filters.buyerPhone).replace(/\D/g, ''));
  }
  if (filters.keyword) {
    clauses.push(`(
      id LIKE ? OR buyer_phone LIKE ? OR pickup_code LIKE ? OR pickup_point_name LIKE ?
      OR express_receiver LIKE ? OR express_phone LIKE ? OR express_address LIKE ?
      OR express_company LIKE ? OR tracking_no LIKE ?
    )`);
    const keyword = `%${filters.keyword}%`;
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM orders ${where} ORDER BY datetime(created_at) DESC LIMIT 5000`).all(...params).map(rowToOrder);
}

function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? rowToOrder(row) : null;
}

function addFulfillmentLog(orderId, action, detail) {
  db.prepare('INSERT INTO fulfillment_logs (order_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(orderId, action, String(detail || ''), nowIso());
}

function addInventoryMovement({ productId, skuId, orderId, type, quantity, beforeStock, afterStock, note, createdAt }) {
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, sku_id, order_id, type, quantity, before_stock, after_stock, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    skuId,
    orderId || '',
    type,
    Number(quantity || 0),
    Number(beforeStock || 0),
    Number(afterStock || 0),
    String(note || ''),
    createdAt || nowIso()
  );
}

function addOperationLog({ actor = 'admin', action, targetType = '', targetId = '', detail = '' }) {
  if (!action) return null;
  return db.prepare(`
    INSERT INTO operation_logs (actor, action, target_type, target_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(actor || 'admin'),
    String(action),
    String(targetType || ''),
    String(targetId || ''),
    typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    nowIso()
  ).lastInsertRowid;
}

function listOperationLogs(limit = 100) {
  return db.prepare('SELECT * FROM operation_logs ORDER BY datetime(created_at) DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(300, Number(limit) || 100)))
    .map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail,
      createdAt: row.created_at
    }));
}

function rowToAddress(row) {
  return {
    id: row.id,
    buyerPhone: row.buyer_phone,
    receiver: row.receiver,
    phone: row.phone,
    address: row.address,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function addressContentKey(address) {
  return [
    String(address.buyerPhone || address.buyer_phone || '').replace(/\D/g, ''),
    String(address.receiver || '').trim(),
    String(address.phone || '').replace(/\D/g, ''),
    String(address.address || '').trim()
  ].join('|');
}

function dedupeAddresses(addresses) {
  const seen = new Set();
  return (addresses || []).filter((address) => {
    const key = addressContentKey(address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listAddresses(buyerPhone) {
  const normalizedPhone = String(buyerPhone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(normalizedPhone)) return [];
  return dedupeAddresses(db.prepare(`
    SELECT * FROM addresses
    WHERE buyer_phone = ?
    ORDER BY is_default DESC, datetime(updated_at) DESC
  `).all(normalizedPhone).map(rowToAddress));
}

function upsertAddress(payload) {
  const buyerPhone = String(payload.buyerPhone || payload.ownerPhone || payload.buyer_phone || '').replace(/\D/g, '');
  const phone = String(payload.phone || '').replace(/\D/g, '');
  const receiver = String(payload.receiver || '').trim();
  const addressText = String(payload.address || '').trim();
  if (!/^1\d{10}$/.test(buyerPhone)) throw new Error('缺少有效用户手机号');
  if (!receiver) throw new Error('收货人不能为空');
  if (!/^1\d{10}$/.test(phone)) throw new Error('收货手机号不正确');
  if (!addressText) throw new Error('收货地址不能为空');
  const existingById = payload.id
    ? db.prepare('SELECT id, created_at FROM addresses WHERE id = ? AND buyer_phone = ?').get(payload.id, buyerPhone)
    : null;
  const existingByContent = db.prepare(`
    SELECT id, created_at FROM addresses
    WHERE buyer_phone = ? AND receiver = ? AND phone = ? AND address = ?
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `).get(buyerPhone, receiver, phone, addressText);
  const existing = existingById || existingByContent;
  const id = existing && existing.id || payload.id || makeId('addr');
  const now = nowIso();
  db.exec('BEGIN');
  try {
    if (payload.isDefault || payload.is_default) {
      db.prepare('UPDATE addresses SET is_default = 0 WHERE buyer_phone = ?').run(buyerPhone);
    }
    db.prepare(`
      INSERT INTO addresses (id, buyer_phone, receiver, phone, address, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        receiver = excluded.receiver,
        phone = excluded.phone,
        address = excluded.address,
        is_default = excluded.is_default,
        updated_at = excluded.updated_at
    `).run(
      id,
      buyerPhone,
      receiver,
      phone,
      addressText,
      payload.isDefault || payload.is_default ? 1 : 0,
      existing ? existing.created_at : now,
      now
    );
    db.prepare(`
      DELETE FROM addresses
      WHERE buyer_phone = ? AND receiver = ? AND phone = ? AND address = ? AND id <> ?
    `).run(buyerPhone, receiver, phone, addressText, id);
    const count = db.prepare('SELECT COUNT(*) AS count FROM addresses WHERE buyer_phone = ?').get(buyerPhone).count;
    if (count === 1) db.prepare('UPDATE addresses SET is_default = 1 WHERE buyer_phone = ?').run(buyerPhone);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listAddresses(buyerPhone).find((item) => item.id === id) || null;
}

function deleteAddress(id, buyerPhone = '') {
  const normalizedPhone = String(buyerPhone || '').replace(/\D/g, '');
  const row = normalizedPhone
    ? db.prepare('SELECT * FROM addresses WHERE id = ? AND buyer_phone = ?').get(id, normalizedPhone)
    : db.prepare('SELECT * FROM addresses WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM addresses WHERE id = ?').run(id);
  const remaining = listAddresses(row.buyer_phone);
  if (row.is_default && remaining.length) {
    db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').run(remaining[0].id);
  }
  return true;
}

function recordCouponUsageForOrder(row) {
  if (!row || !row.coupon_code) return false;
  const couponCode = normalizeCouponCode(row.coupon_code);
  const existing = db.prepare('SELECT id FROM coupon_usages WHERE coupon_code = ? AND order_id = ?').get(couponCode, row.id);
  if (existing) return false;
  const coupon = getCoupon(couponCode);
  if (!coupon) throw new Error('优惠码不存在，无法完成支付');
  if (coupon.usageLimit > 0 && getCouponUsageCount(coupon.code) >= coupon.usageLimit) {
    throw new Error('优惠码已被使用完，无法完成支付');
  }
  if (coupon.perPhoneLimit > 0 && getCouponPhoneUsageCount(coupon.code, row.buyer_phone) >= coupon.perPhoneLimit) {
    throw new Error('该手机号已使用过此优惠码，无法完成支付');
  }
  const trace = parseJson(row.discount_trace_json, []);
  const couponDiscount = trace
    .filter((item) => item.type === 'coupon' && item.code === coupon.code)
    .reduce((sum, item) => sum + normalizeCents(item.amount), 0);
  db.prepare(`
    INSERT INTO coupon_usages (coupon_code, order_id, buyer_phone, discount_amount_cents, used_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(coupon.code, row.id, row.buyer_phone || '', couponDiscount, nowIso());
  return true;
}

function restockOrderItems(id, status) {
  const current = db.prepare('SELECT inventory_restocked_at FROM orders WHERE id = ?').get(id);
  if (!current || current.inventory_restocked_at) return false;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  const now = nowIso();
  const movementType = status === 'refunded' ? 'restock_refund' : 'restock_cancel';
  for (const item of items) {
    if (!item.product_id || !item.sku_id) continue;
    const sku = db.prepare('SELECT stock FROM product_skus WHERE id = ? AND product_id = ?').get(item.sku_id, item.product_id);
    if (!sku) continue;
    const beforeStock = Number(sku.stock || 0);
    const afterStock = beforeStock + Math.max(0, Number(item.quantity || 0));
    db.prepare('UPDATE product_skus SET stock = ? WHERE id = ? AND product_id = ?')
      .run(afterStock, item.sku_id, item.product_id);
    addInventoryMovement({
      productId: item.product_id,
      skuId: item.sku_id,
      orderId: id,
      type: movementType,
      quantity: Math.max(0, Number(item.quantity || 0)),
      beforeStock,
      afterStock,
      note: status === 'refunded' ? '订单退款库存回补' : '订单取消库存回补',
      createdAt: now
    });
  }
  db.prepare('UPDATE orders SET inventory_restocked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  return true;
}

function resolveStorefrontOrderContext(payload, { validateDestination = true } = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const firstItem = items[0] || {};
  const product = getProduct(firstItem.productId || payload.productId);
  if (!product) throw new Error('商品不存在');
  const sku = (product.skus || []).find((item) => item.id === (firstItem.skuId || payload.skuId) || item.packageType === (firstItem.packageType || payload.packageType)) || product.skus[0];
  if (!sku) throw new Error('商品规格不存在');
  const quantity = Math.max(1, Math.floor(Number(firstItem.quantity || payload.quantity || 1)));
  if (!product.isOnSale || sku.stock < quantity) throw new Error('库存不足或商品已下架');

  const deliveryType = payload.deliveryType === 'express' ? 'express' : 'pickup';
  const buyerPhone = String(payload.buyerPhone || '').replace(/\D/g, '');
  if (validateDestination && !/^1\d{10}$/.test(buyerPhone)) throw new Error('请输入有效手机号');
  const supportedDeliveryMethods = sku.deliveryMethods && sku.deliveryMethods.length ? sku.deliveryMethods : product.deliveryMethods || ['pickup'];
  if (!supportedDeliveryMethods.includes(deliveryType)) throw new Error('当前规格不支持该配送方式');
  const expressInfo = { ...(payload.expressInfo || {}) };
  let pickupPoint = null;
  if (deliveryType === 'pickup') {
    pickupPoint = payload.pickupPointId ? getPickupPoint(payload.pickupPointId) : null;
    if (validateDestination && (!pickupPoint || !pickupPoint.enabled)) throw new Error('请选择有效自提点');
    if (pickupPoint && pickupPoint.packageTypes && pickupPoint.packageTypes.length && !pickupPoint.packageTypes.includes(sku.packageType)) {
      throw new Error('该自提点不支持当前包装规格');
    }
    const productPickupPointIds = Array.isArray(product.pickupPointIds) ? product.pickupPointIds.map(String) : [];
    if (pickupPoint && productPickupPointIds.length && !productPickupPointIds.includes(String(pickupPoint.id))) {
      throw new Error('该商品不支持当前自提点');
    }
  } else if (validateDestination) {
    const expressPhone = String(expressInfo.phone || buyerPhone).replace(/\D/g, '');
    if (!String(expressInfo.receiver || '').trim()) throw new Error('请填写收货人');
    if (!/^1\d{10}$/.test(expressPhone)) throw new Error('请填写正确收货手机号');
    if (!String(expressInfo.address || '').trim()) throw new Error('请填写快递地址');
    expressInfo.phone = expressPhone;
  }
  return { product, sku, quantity, deliveryType, buyerPhone, expressInfo, pickupPoint };
}

function quoteStorefrontOrder(payload) {
  const { product, sku, quantity, deliveryType, buyerPhone, expressInfo } = resolveStorefrontOrderContext(payload, {
    validateDestination: false
  });
  const quote = calculateOrderQuote({
    product,
    sku,
    quantity,
    buyerPhone,
    couponCode: payload.couponCode,
    deliveryType,
    expressInfo
  });
  return {
    originalTotal: quote.originalTotal,
    saleTotal: quote.saleTotal,
    goodsAmount: quote.goodsAmount,
    totalAmount: quote.totalAmount,
    shipping: quote.shipping,
    payAmount: quote.payAmount,
    unitPrice: quote.unitPrice,
    couponCode: quote.couponCode,
    discountTrace: quote.discountTrace
  };
}

function createStorefrontOrder(payload) {
  const id = String(payload.id || '').trim() || makeUniqueOrderId();
  const existingOrder = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
  if (existingOrder) return getOrder(id);
  const {
    product,
    sku,
    quantity,
    deliveryType,
    buyerPhone,
    expressInfo,
    pickupPoint
  } = resolveStorefrontOrderContext(payload, { validateDestination: true });
  const quote = calculateOrderQuote({
    product,
    sku,
    quantity,
    buyerPhone,
    couponCode: payload.couponCode,
    deliveryType,
    expressInfo
  });
  const now = nowIso();
  const payNow = payload.payNow !== false && payload.status !== 'awaiting_payment';
  const paymentTtlMinutes = Math.max(1, Number(payload.paymentTtlMinutes || 15));
  const status = payNow ? (deliveryType === 'express' ? 'awaiting_shipment' : 'awaiting_pickup') : 'awaiting_payment';
  const statusText = payNow ? (deliveryType === 'express' ? '待发货' : '待自提') : '待支付';
  const paidAt = payNow ? now : '';
  const paymentExpiresAt = payNow ? '' : addMinutesIso(now, paymentTtlMinutes);
  const pickupCode = deliveryType === 'pickup' ? (payload.pickupCode || String(Date.now()).slice(-6).padStart(6, '0')) : '';

  db.exec('BEGIN');
  try {
    const currentSku = db.prepare('SELECT stock FROM product_skus WHERE id = ? AND product_id = ?').get(sku.id, product.id);
    if (!currentSku || currentSku.stock < quantity) throw new Error('库存不足或商品已下架');
    const beforeStock = Number(currentSku.stock || 0);
    const afterStock = beforeStock - quantity;
    db.prepare('UPDATE product_skus SET stock = ? WHERE id = ? AND product_id = ?').run(afterStock, sku.id, product.id);
    addInventoryMovement({
      productId: product.id,
      skuId: sku.id,
      orderId: id,
      type: payNow ? 'sale_deduct' : 'stock_lock',
      quantity: -quantity,
      beforeStock,
      afterStock,
      note: payNow ? '支付成功扣减库存' : '待支付订单锁定库存',
      createdAt: now
    });

    db.prepare(`
      INSERT INTO orders (
        id, buyer_phone, status, status_text, sale_type, delivery_type, pickup_point_id, pickup_point_name,
        pickup_code, express_receiver, express_phone, express_address, shipping_fee_cents,
        shipping_label, goods_amount_cents, total_amount_cents, pay_amount_cents, coupon_code,
        discount_trace_json, note, customer_contact, customer_phone, pickup_valid_hours,
        fulfillment_start, fulfillment_end, paid_at, payment_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      buyerPhone,
      status,
      statusText,
      normalizeSaleType(product.saleType),
      deliveryType,
      pickupPoint ? pickupPoint.id : '',
      pickupPoint ? pickupPoint.name : '',
      pickupCode,
      expressInfo.receiver || '',
      String(expressInfo.phone || '').replace(/\D/g, ''),
      expressInfo.address || '',
      quote.shipping.fee,
      quote.shipping.label,
      quote.goodsAmount,
      quote.totalAmount,
      quote.payAmount,
      quote.couponCode,
      json(quote.discountTrace),
      payload.note || '',
      product.customerContact || '',
      product.customerPhone || '',
      deliveryType === 'pickup' ? Math.max(0, Number(product.pickupValidHours || 0)) : 0,
      normalizeSaleType(product.saleType) === 'direct' ? '' : product.shipStart || '',
      normalizeSaleType(product.saleType) === 'direct' ? '' : product.shipEnd || '',
      paidAt,
      paymentExpiresAt,
      now,
      now
    );

    db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, product_name, sku_id, sku_name, package_type,
        package_label, quantity, unit_price_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      product.id,
      product.name,
      sku.id,
      sku.name,
      sku.packageType,
      sku.label,
      quantity,
      quote.unitPrice
    );
    if (payNow && quote.coupon) recordCouponUsageForOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
    db.prepare('INSERT INTO fulfillment_logs (order_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(id, payNow ? 'mock_paid' : 'stock_locked', payNow ? '支付成功' : '已锁定库存，等待支付', now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getOrder(id);
}

function canOrderApplyAfterSale(row) {
  if (!row || row.after_sale_reason || row.after_sale_status) return false;
  if (row.status === 'completed') return true;
  if (row.delivery_type === 'pickup') return row.status === 'picked_up';
  if (row.delivery_type === 'express') return row.status === 'completed';
  return false;
}

function hasOrderAfterSaleRequest(row) {
  return Boolean(row && (
    row.after_sale_reason
    || row.after_sale_status
    || row.after_sale_refund_note
    || row.after_sale_requested_at
    || Number(row.refund_amount_cents || 0) > 0
  ));
}

function updateOrderStatus(id, payload) {
  const action = payload.action || payload.status;
  const now = nowIso();
  const statusMap = {
    pickup_shipped: '自提点已到货',
    shipped: '已发货',
    picked_up: '已自提',
    completed: '已完成',
    after_sale: '售后中',
    refunded: '已退款',
    cancelled: '已取消'
  };
  const status = payload.status;
  if (!statusMap[status]) throw new Error(`Unsupported order status: ${status}`);
  const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!current) return null;
  if (status === 'refunded' && (
    current.status === 'refunded'
    || current.refunded_at
    || current.after_sale_status === 'refunded'
  )) {
    throw new Error('该订单已退款，不能重复退款处理');
  }
  if (status === 'refunded' && !hasOrderAfterSaleRequest(current)) {
    throw new Error('该订单暂无售后申请，不能退款处理');
  }
  if (status === 'after_sale' && !canOrderApplyAfterSale(current)) {
    throw new Error('当前订单状态不可申请售后');
  }
  if (status === 'shipped') {
    if (current.delivery_type !== 'express') throw new Error('自提订单不能标记发货');
    const nextCompany = String(payload.company ?? current.express_company ?? '').trim();
    const nextTrackingNo = String(payload.trackingNo ?? current.tracking_no ?? '').trim();
    if (!nextCompany || !nextTrackingNo) throw new Error('请填写快递公司和快递单号');
  }
  if (status === 'pickup_shipped' && current.delivery_type !== 'pickup') {
    throw new Error('快递订单不能标记自提点已到货');
  }

  const patch = {
    shipped_at: (status === 'shipped' || status === 'pickup_shipped') ? now : undefined,
    picked_up_at: status === 'picked_up' ? now : undefined,
    completed_at: status === 'completed' ? now : undefined,
    refunded_at: status === 'refunded' ? now : undefined,
    cancelled_at: status === 'cancelled' ? now : undefined,
    after_sale_requested_at: status === 'after_sale' && !current.after_sale_requested_at ? now : undefined,
    after_sale_handled_at: status === 'refunded'
      ? now
      : (['completed', 'cancelled'].includes(status) && current.after_sale_status ? now : undefined)
  };
  const refundNote = status === 'refunded'
    ? String(payload.refundNote ?? payload.reason ?? payload.detail ?? current.after_sale_refund_note ?? '').trim()
    : String(payload.refundNote ?? current.after_sale_refund_note ?? '').trim();

  const next = {
    expressCompany: payload.company ?? current.express_company,
    trackingNo: payload.trackingNo ?? current.tracking_no,
    afterSaleReason: status === 'refunded' ? current.after_sale_reason : (payload.reason ?? current.after_sale_reason),
    afterSaleStatus: payload.afterSaleStatus ?? (
      status === 'after_sale' ? 'processing'
        : status === 'refunded' ? 'refunded'
          : current.after_sale_status
    ),
    refundAmount: normalizeCents(payload.refundAmountCents ?? payload.refundAmount ?? current.refund_amount_cents),
    afterSaleRefundNote: refundNote,
    afterSaleRequestedAt: patch.after_sale_requested_at ?? current.after_sale_requested_at,
    afterSaleHandledAt: patch.after_sale_handled_at ?? current.after_sale_handled_at,
    shippedAt: patch.shipped_at ?? current.shipped_at,
    pickedUpAt: patch.picked_up_at ?? current.picked_up_at,
    completedAt: patch.completed_at ?? current.completed_at,
    refundedAt: patch.refunded_at ?? current.refunded_at,
    cancelledAt: patch.cancelled_at ?? current.cancelled_at
  };

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE orders SET
        status = ?,
        status_text = ?,
        express_company = ?,
        tracking_no = ?,
        after_sale_reason = ?,
        after_sale_status = ?,
        refund_amount_cents = ?,
        after_sale_refund_note = ?,
        after_sale_requested_at = ?,
        after_sale_handled_at = ?,
        shipped_at = ?,
        picked_up_at = ?,
        completed_at = ?,
        refunded_at = ?,
        cancelled_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      statusMap[status],
      next.expressCompany,
      next.trackingNo,
      next.afterSaleReason,
      next.afterSaleStatus,
      next.refundAmount,
      next.afterSaleRefundNote,
      next.afterSaleRequestedAt,
      next.afterSaleHandledAt,
      next.shippedAt,
      next.pickedUpAt,
      next.completedAt,
      next.refundedAt,
      next.cancelledAt,
      now,
      id
    );
    addFulfillmentLog(id, action, payload.detail || statusMap[status]);
    if (status === 'refunded' || status === 'cancelled') {
      const didRestock = restockOrderItems(id, status);
      if (didRestock) {
        addFulfillmentLog(id, 'inventory_restock', status === 'refunded' ? '退款库存已回补' : '取消库存已回补');
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? rowToOrder(row) : null;
}

function markWechatShippingSync(id, payload = {}) {
  const orderId = String(id || '').trim();
  if (!orderId) return null;
  const now = nowIso();
  const status = String(payload.status || '').trim();
  const syncedAt = payload.syncedAt || (status === 'success' ? now : '');
  const error = status === 'success' ? '' : String(payload.error || '').slice(0, 1000);
  const payloadJson = payload.payload ? JSON.stringify(payload.payload) : '';
  const responseJson = payload.response ? JSON.stringify(payload.response) : '';
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE orders SET
        wechat_shipping_status = ?,
        wechat_shipping_synced_at = ?,
        wechat_shipping_error = ?,
        wechat_shipping_type = ?,
        wechat_shipping_payload_json = ?,
        wechat_shipping_response_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      syncedAt,
      error,
      Number(payload.logisticsType || 0),
      payloadJson,
      responseJson,
      now,
      orderId
    );
    addFulfillmentLog(
      orderId,
      status === 'success' ? 'wechat_shipping_synced' : 'wechat_shipping_failed',
      status === 'success' ? '微信小程序订单发货信息已同步' : `微信小程序订单发货同步失败：${error || '未知错误'}`
    );
    db.exec('COMMIT');
  } catch (errorObject) {
    db.exec('ROLLBACK');
    throw errorObject;
  }
  return getOrder(orderId);
}


function markWechatReceiptConfirmed(id, payload = {}) {
  const orderId = String(id || '').trim();
  if (!orderId) return null;
  const now = nowIso();
  const responseJson = payload.response ? JSON.stringify(payload.response) : '';
  db.prepare(`
    UPDATE orders SET
      wechat_receipt_confirmed_at = ?,
      wechat_receipt_state = ?,
      wechat_receipt_response_json = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    payload.confirmedAt || now,
    Number(payload.orderState || 0),
    responseJson,
    now,
    orderId
  );
  return getOrder(orderId);
}

function stringifyPayload(value) {
  if (!value) return '';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value).slice(0, 2000);
  }
}

function markWechatRefundRequested(id, payload = {}) {
  const orderId = String(id || '').trim();
  if (!orderId) return null;
  const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!current) return null;
  if (current.status === 'refunded' || current.refunded_at || current.after_sale_status === 'refunded') {
    throw new Error('该订单已退款，不能重复退款处理');
  }
  if (!hasOrderAfterSaleRequest(current)) {
    throw new Error('该订单暂无售后申请，不能退款处理');
  }
  if (current.status !== 'after_sale') {
    throw new Error('只有售后中的订单才能发起退款处理');
  }
  const existingRefundStatus = String(current.wechat_refund_status || '').toUpperCase();
  const nextRefundNo = String(payload.outRefundNo || '').trim();
  const allowExistingRefundUpdate = Boolean(payload.allowExistingRefundUpdate)
    && nextRefundNo
    && current.wechat_refund_no === nextRefundNo
    && ['PENDING_SUBMIT'].includes(existingRefundStatus);
  if (current.wechat_refund_no && ['PENDING_SUBMIT', 'PROCESSING', 'SUCCESS', 'ABNORMAL'].includes(existingRefundStatus) && !allowExistingRefundUpdate) {
    throw new Error(existingRefundStatus === 'SUCCESS' ? '该订单微信退款已成功' : '该订单已有微信退款单，不能重复提交');
  }
  const now = nowIso();
  const refundAmount = normalizeCents(payload.refundAmountCents ?? payload.refundAmount ?? current.refund_amount_cents);
  if (refundAmount <= 0) throw new Error('请输入有效退款金额');
  const refundNote = String(payload.refundNote ?? payload.reason ?? current.after_sale_refund_note ?? '').trim();
  db.prepare(`
    UPDATE orders SET
      after_sale_status = ?,
      refund_amount_cents = ?,
      after_sale_refund_note = ?,
      wechat_refund_no = ?,
      wechat_refund_id = ?,
      wechat_refund_status = ?,
      wechat_refund_requested_at = ?,
      wechat_refund_response_json = ?,
      wechat_refund_error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    'refund_processing',
    refundAmount,
    refundNote,
    nextRefundNo,
    String(payload.refundId || '').trim(),
    String(payload.status || 'PROCESSING').trim(),
    payload.requestedAt || now,
    stringifyPayload(payload.response),
    '',
    now,
    orderId
  );
  addFulfillmentLog(orderId, payload.action || 'wechat_refund_requested', payload.detail || '微信退款已提交，等待退款结果');
  return getOrder(orderId);
}

function markWechatRefundFailed(id, payload = {}) {
  const orderId = String(id || '').trim();
  if (!orderId) return null;
  const now = nowIso();
  const error = String(payload.error || payload.message || '').slice(0, 1000);
  db.prepare(`
    UPDATE orders SET
      after_sale_status = CASE WHEN after_sale_status = 'refund_processing' THEN 'processing' ELSE after_sale_status END,
      wechat_refund_id = CASE WHEN ? != '' THEN ? ELSE wechat_refund_id END,
      wechat_refund_status = ?,
      wechat_refund_response_json = ?,
      wechat_refund_error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    String(payload.refundId || '').trim(),
    String(payload.refundId || '').trim(),
    String(payload.status || 'FAILED').trim(),
    stringifyPayload(payload.response),
    error,
    now,
    orderId
  );
  addFulfillmentLog(orderId, payload.action || 'wechat_refund_failed', error ? `微信退款失败：${error}` : '微信退款状态异常');
  return getOrder(orderId);
}

function completeWechatRefund(id, payload = {}) {
  const orderId = String(id || '').trim();
  if (!orderId) return null;
  const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!current) return null;
  if (!(current.status === 'refunded' || current.refunded_at || current.after_sale_status === 'refunded')) {
    updateOrderStatus(orderId, {
      status: 'refunded',
      action: payload.action || 'wechat_refund_success',
      detail: payload.detail || '微信原路退款成功',
      refundAmount: payload.refundAmountCents ?? payload.refundAmount ?? current.refund_amount_cents,
      refundNote: payload.refundNote ?? current.after_sale_refund_note,
      allowRefundProcessingCompletion: true
    });
  }
  const now = nowIso();
  db.prepare(`
    UPDATE orders SET
      wechat_refund_no = CASE WHEN ? != '' THEN ? ELSE wechat_refund_no END,
      wechat_refund_id = CASE WHEN ? != '' THEN ? ELSE wechat_refund_id END,
      wechat_refund_status = ?,
      wechat_refund_success_at = ?,
      wechat_refund_response_json = ?,
      wechat_refund_error = '',
      updated_at = ?
    WHERE id = ?
  `).run(
    String(payload.outRefundNo || '').trim(),
    String(payload.outRefundNo || '').trim(),
    String(payload.refundId || '').trim(),
    String(payload.refundId || '').trim(),
    String(payload.status || 'SUCCESS').trim(),
    payload.successAt || now,
    stringifyPayload(payload.response),
    now,
    orderId
  );
  return getOrder(orderId);
}

function importedRowValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

function importExpressShipments(rows = []) {
  const result = {
    total: Array.isArray(rows) ? rows.length : 0,
    matched: [],
    unmatched: [],
    skipped: []
  };
  if (!Array.isArray(rows)) return result;
  for (const rawRow of rows) {
    const orderId = importedRowValue(rawRow, ['orderId', 'order_id', 'id', '订单号', '订单编号']);
    const company = importedRowValue(rawRow, ['company', 'expressCompany', 'express_company', '快递公司', '物流公司']);
    const trackingNo = importedRowValue(rawRow, ['trackingNo', 'tracking_no', 'tracking', '快递单号', '运单号', '物流单号']);
    if (!orderId) {
      result.skipped.push({ row: rawRow, reason: '缺少订单编号' });
      continue;
    }
    const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!current) {
      result.unmatched.push({ orderId, company, trackingNo, reason: '订单不存在' });
      continue;
    }
    if (current.delivery_type !== 'express') {
      result.unmatched.push({ orderId, company, trackingNo, reason: '该订单不是快递订单' });
      continue;
    }
    if (!company || !trackingNo) {
      result.skipped.push({ orderId, company, trackingNo, reason: '缺少快递公司或快递单号' });
      continue;
    }
    try {
      const order = updateOrderStatus(orderId, {
        status: 'shipped',
        company,
        trackingNo,
        detail: `导入快递发货：${company} ${trackingNo}`
      });
      result.matched.push({ orderId, company, trackingNo, status: order.status });
    } catch (error) {
      result.unmatched.push({ orderId, company, trackingNo, reason: error.message });
    }
  }
  return result;
}

function importPickupShipments(rows = []) {
  const result = {
    total: Array.isArray(rows) ? rows.length : 0,
    matched: [],
    unmatched: [],
    skipped: []
  };
  if (!Array.isArray(rows)) return result;
  for (const rawRow of rows) {
    const orderId = importedRowValue(rawRow, ['orderId', 'order_id', 'id', '订单号', '订单编号']);
    const detail = importedRowValue(rawRow, ['detail', 'remark', '备注', '自提信息', '贴单信息']) || '导入自提发货信息';
    if (!orderId) {
      result.skipped.push({ row: rawRow, reason: '缺少订单编号' });
      continue;
    }
    const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!current) {
      result.unmatched.push({ orderId, detail, reason: '订单不存在' });
      continue;
    }
    if (current.delivery_type !== 'pickup') {
      result.unmatched.push({ orderId, detail, reason: '该订单不是自提订单' });
      continue;
    }
    if (['picked_up', 'completed', 'refunded', 'cancelled'].includes(current.status)) {
      result.skipped.push({ orderId, detail, reason: `当前状态为${current.status_text || current.status}，不需要标记自提点已到货` });
      continue;
    }
    try {
      const order = updateOrderStatus(orderId, {
        status: 'pickup_shipped',
        detail
      });
      result.matched.push({ orderId, detail, status: order.status });
    } catch (error) {
      result.unmatched.push({ orderId, detail, reason: error.message });
    }
  }
  return result;
}

function receivedAtTime(order) {
  const time = new Date(order.pickedUpAt || order.completedAt || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function isOrderReceived(order) {
  if (!order) return false;
  if (order.status === 'completed' || order.status === 'picked_up') return true;
  if (order.status === 'after_sale' && receivedAtTime(order) > 0) return true;
  return false;
}

function isAfterSalePending(order) {
  const info = order && order.afterSaleInfo;
  if (!info) return false;
  return !['refunded', 'rejected'].includes(String(info.status || ''));
}

function isFinalRefundedOrder(order) {
  return Boolean(order && (
    order.status === 'refunded'
    || order.refundedAt
    || String(order.afterSaleInfo && order.afterSaleInfo.status || '') === 'refunded'
  ));
}

function orderBusinessStats(filters = {}) {
  const orders = listOrders(filters);
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const completed1 = orders.filter((order) => (
    isOrderReceived(order)
    && receivedAtTime(order) > 0
    && !order.afterSaleInfo
    && now - receivedAtTime(order) >= oneDayMs
  ));
  const completed2 = orders.filter((order) => (
    (isOrderReceived(order) && receivedAtTime(order) > 0 && now - receivedAtTime(order) < oneDayMs)
    || isAfterSalePending(order)
  ));
  const expressSent = orders.filter((order) => (
    order.deliveryType === 'express'
    && !['awaiting_payment', 'awaiting_shipment', 'cancelled'].includes(order.status)
    && (order.status !== 'refunded' || order.expressShipment)
  ));
  const expressReceived = expressSent.filter((order) => isOrderReceived(order));
  const expressUnreceived = expressSent.filter((order) => !isOrderReceived(order) && order.status !== 'refunded');
  const pickupSent = orders.filter((order) => (
    order.deliveryType === 'pickup'
    && ['pickup_shipped', 'picked_up', 'completed', 'after_sale', 'refunded'].includes(order.status)
  ));
  const pickupReceived = pickupSent.filter((order) => isOrderReceived(order));
  const pickupUnreceived = pickupSent.filter((order) => order.status === 'pickup_shipped');
  const refunded = orders.filter((order) => isFinalRefundedOrder(order));
  const paidOrders = orders.filter((order) => !['awaiting_payment', 'cancelled'].includes(order.status));
  const totalReceipts = paidOrders.reduce((sum, order) => sum + normalizeCents(order.payAmount), 0);
  const totalRefund = refunded.reduce((sum, order) => {
    const refundAmount = order.afterSaleInfo ? order.afterSaleInfo.refundAmount : 0;
    return sum + normalizeCents(refundAmount || order.payAmount);
  }, 0);
  const actualIncome = Math.max(0, totalReceipts - totalRefund);
  return {
    totalOrders: orders.length,
    completed1: { count: completed1.length, orderIds: completed1.map((order) => order.id) },
    completed2: { count: completed2.length, orderIds: completed2.map((order) => order.id) },
    expressSent: {
      count: expressSent.length,
      received: expressReceived.length,
      unreceived: expressUnreceived.length,
      orderIds: expressSent.map((order) => order.id)
    },
    pickupSent: {
      count: pickupSent.length,
      received: pickupReceived.length,
      unreceived: pickupUnreceived.length,
      orderIds: pickupSent.map((order) => order.id)
    },
    refunded: { count: refunded.length, orderIds: refunded.map((order) => order.id) },
    totalReceipts,
    totalReceiptsText: centsToYuan(totalReceipts),
    totalRefund,
    totalRefundText: centsToYuan(totalRefund),
    actualIncome,
    actualIncomeText: centsToYuan(actualIncome)
  };
}

function releasePaymentOrder(row, releasedAt) {
  if (!row || row.status !== 'awaiting_payment') return false;
  db.prepare(`
    UPDATE orders SET
      status = 'cancelled',
      status_text = '支付超时已取消',
      cancelled_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(releasedAt, releasedAt, row.id);
  addFulfillmentLog(row.id, 'payment_timeout', '支付超时，库存已释放');
  restockOrderItems(row.id, 'cancelled');
  return true;
}

function releaseExpiredPaymentOrders(referenceTime = nowIso()) {
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'awaiting_payment'
      AND payment_expires_at != ''
      AND datetime(payment_expires_at) <= datetime(?)
    ORDER BY datetime(payment_expires_at) ASC
  `).all(referenceTime);
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      releasePaymentOrder(row, referenceTime);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    releasedCount: rows.length,
    orderIds: rows.map((row) => row.id)
  };
}

function payOrder(id, options = {}) {
  const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!current) return null;
  const optionWechatOpenid = String(options.wechatOpenid || options.openid || '').trim();
  const optionWechatTransactionId = String(options.wechatTransactionId || options.transactionId || '').trim();
  if (current.status !== 'awaiting_payment') {
    const nextWechatOpenid = optionWechatOpenid && !current.wechat_openid ? optionWechatOpenid : current.wechat_openid;
    const nextWechatTransactionId = optionWechatTransactionId && !current.wechat_transaction_id ? optionWechatTransactionId : current.wechat_transaction_id;
    if (nextWechatOpenid !== current.wechat_openid || nextWechatTransactionId !== current.wechat_transaction_id) {
      db.prepare('UPDATE orders SET wechat_openid = ?, wechat_transaction_id = ?, updated_at = ? WHERE id = ?')
        .run(nextWechatOpenid, nextWechatTransactionId, nowIso(), id);
      return getOrder(id);
    }
    return rowToOrder(current);
  }
  const now = nowIso();
  if (current.payment_expires_at && new Date(current.payment_expires_at).getTime() <= new Date(now).getTime()) {
    db.exec('BEGIN');
    try {
      releasePaymentOrder(current, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    throw new Error('订单支付超时，库存已释放，请重新下单');
  }
  const nextStatus = current.delivery_type === 'express' ? 'awaiting_shipment' : 'awaiting_pickup';
  const nextStatusText = current.delivery_type === 'express' ? '待发货' : '待自提';
  const nextWechatOpenid = String(optionWechatOpenid || current.wechat_openid || '').trim();
  const nextWechatTransactionId = String(optionWechatTransactionId || current.wechat_transaction_id || '').trim();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE orders SET
        status = ?,
        status_text = ?,
        paid_at = ?,
        wechat_openid = ?,
        wechat_transaction_id = ?,
        updated_at = ?
      WHERE id = ?
    `).run(nextStatus, nextStatusText, now, nextWechatOpenid, nextWechatTransactionId, now, id);
    const paidRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    recordCouponUsageForOrder(paidRow);
    addFulfillmentLog(id, options.action || 'mock_paid', options.detail || '支付成功');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getOrder(id);
}

function verifyPickupCode(payload) {
  const pickupCode = String(payload.pickupCode || payload.code || '').replace(/\D/g, '');
  const orderId = String(payload.orderId || '').trim();
  if (!pickupCode && !orderId) throw new Error('请输入自提核销码或订单号');
  const row = orderId
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
    : db.prepare('SELECT * FROM orders WHERE pickup_code = ? AND delivery_type = ? ORDER BY datetime(created_at) DESC').get(pickupCode, 'pickup');
  if (!row) throw new Error('未找到匹配的自提订单');
  if (row.delivery_type !== 'pickup') throw new Error('该订单不是自提订单');
  if (row.status === 'picked_up' || row.status === 'completed') return rowToOrder(row);
  if (!['awaiting_pickup', 'pickup_shipped'].includes(row.status)) throw new Error(`当前订单状态为${row.status_text || row.status}，不可核销`);
  return updateOrderStatus(row.id, {
    status: 'picked_up',
    detail: `自提核销码 ${row.pickup_code || pickupCode}`
  });
}

function pickupStaffPublicOrder(rowOrOrder) {
  const order = rowOrOrder && rowOrOrder.items ? rowOrOrder : rowToOrder(rowOrOrder);
  const item = (order.items || [])[0] || {};
  return {
    id: order.id,
    status: order.status,
    statusText: order.statusText,
    buyerPhoneTail: String(order.buyerPhone || '').slice(-4),
    pickupPointId: order.pickupPointId,
    pickupPointName: order.pickupPointName,
    pickupCode: order.pickupCode,
    itemName: item.productName || '',
    skuName: item.skuName || item.packageLabel || '',
    quantity: item.quantity || 1,
    pickedUpAt: order.pickedUpAt || ''
  };
}

function lookupPickupStaffOrder(payload = {}) {
  const pickupPointId = String(payload.pickupPointId || '').trim();
  const phoneTail = String(payload.phoneTail || payload.phoneLast4 || '').replace(/\D/g, '').slice(-4);
  const pickupCode = String(payload.pickupCode || payload.code || '').replace(/\D/g, '');
  if (!pickupPointId) throw new Error('自提点登录已失效，请重新登录');
  if (phoneTail.length !== 4) throw new Error('请输入下单手机号后4位');
  if (!pickupCode) throw new Error('请输入自提核销码');
  const row = db.prepare(`
    SELECT * FROM orders
    WHERE pickup_code = ?
      AND delivery_type = 'pickup'
      AND substr(buyer_phone, -4) = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(pickupCode, phoneTail);
  if (!row) {
    return {
      status: 'not_found',
      message: '没有查到该自提订单，请核对手机号后4位和核销码。'
    };
  }
  const publicOrder = pickupStaffPublicOrder(row);
  if (String(row.pickup_point_id || '') !== pickupPointId) {
    return {
      status: 'wrong_pickup_point',
      message: `该订单属于「${row.pickup_point_name || '其他自提点'}」，不在当前登录自提点，请提醒领取人到对应自提点取货。`,
      order: publicOrder,
      expectedPickupPointName: row.pickup_point_name || ''
    };
  }
  if (['picked_up', 'completed'].includes(row.status)) {
    return {
      status: 'already_picked',
      message: row.picked_up_at ? `该订单已领取，领取时间：${row.picked_up_at}，不能重复核销。` : '该订单已领取，不能重复核销。',
      order: publicOrder
    };
  }
  if (['refunded', 'cancelled', 'after_sale'].includes(row.status)) {
    return {
      status: 'unavailable',
      message: `该订单当前状态为「${row.status_text || row.status}」，不能核销领取。`,
      order: publicOrder
    };
  }
  if (row.status !== 'pickup_shipped') {
    return {
      status: 'not_arrived',
      message: '该订单货品还未到当前自提点，请提醒领取人等待老板通知后再来领取。',
      order: publicOrder
    };
  }
  return {
    status: 'ready',
    message: '订单已到货且未领取，确认核对无误后可以核销。',
    order: publicOrder
  };
}

function confirmPickupStaffOrder(payload = {}) {
  const lookup = lookupPickupStaffOrder(payload);
  if (lookup.status !== 'ready') return lookup;
  const order = updateOrderStatus(lookup.order.id, {
    status: 'picked_up',
    detail: `自提点核销：手机号后4位 ${String(payload.phoneTail || payload.phoneLast4 || '').replace(/\D/g, '').slice(-4)}`
  });
  return {
    status: 'picked',
    message: '核销成功，订单已标记为已领取。',
    order: pickupStaffPublicOrder(order)
  };
}

function requestAfterSale(payload) {
  const orderId = String(payload.orderId || payload.id || '').trim();
  const buyerPhone = String(payload.buyerPhone || '').replace(/\D/g, '');
  const reason = String(payload.reason || '').trim();
  if (!orderId) throw new Error('订单号不能为空');
  if (!reason) throw new Error('请填写售后原因');
  const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!current) throw new Error('订单不存在');
  if (buyerPhone && current.buyer_phone !== buyerPhone) throw new Error('订单手机号不匹配');
  if (!canOrderApplyAfterSale(current)) {
    throw new Error('当前订单状态不可申请售后');
  }
  const refundAmount = normalizeCents(payload.refundAmountCents ?? payload.refundAmount ?? current.pay_amount_cents);
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE orders SET
        status = 'after_sale',
        status_text = '售后中',
        after_sale_reason = ?,
        after_sale_status = 'requested',
        refund_amount_cents = ?,
        after_sale_requested_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(reason, refundAmount, now, now, orderId);
    addFulfillmentLog(orderId, 'after_sale_requested', reason);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getOrder(orderId);
}

function stats() {
  const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  const pickupCount = db.prepare('SELECT COUNT(*) AS count FROM pickup_points WHERE enabled = 1').get().count;
  const orderCount = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  const paidOrderCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE status NOT IN (\'awaiting_payment\', \'cancelled\', \'refunded\')').get().count;
  const pendingPaymentCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE status = \'awaiting_payment\'').get().count;
  const awaitingShipmentCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE status = \'awaiting_shipment\'').get().count;
  const awaitingPickupCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE status = \'awaiting_pickup\'').get().count;
  const lowStockSkuCount = db.prepare('SELECT COUNT(*) AS count FROM product_skus WHERE stock > 0 AND stock <= 10').get().count;
  const soldOutSkuCount = db.prepare('SELECT COUNT(*) AS count FROM product_skus WHERE stock <= 0').get().count;
  const revenue = db.prepare('SELECT COALESCE(SUM(pay_amount_cents), 0) AS total FROM orders WHERE status NOT IN (\'awaiting_payment\', \'cancelled\', \'refunded\')').get().total;
  const couponDiscount = db.prepare('SELECT COALESCE(SUM(discount_amount_cents), 0) AS total FROM coupon_usages').get().total;
  const whitelistCount = db.prepare('SELECT COUNT(*) AS count FROM whitelist_entries').get().count;
  const couponCount = db.prepare('SELECT COUNT(*) AS count FROM coupons').get().count;
  const orderStatusRows = db.prepare('SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC').all();
  const topProducts = db.prepare(`
    SELECT oi.product_name AS name, SUM(oi.quantity) AS quantity, COALESCE(SUM(o.pay_amount_cents), 0) AS amount
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status NOT IN ('awaiting_payment', 'cancelled', 'refunded')
    GROUP BY oi.product_name
    ORDER BY quantity DESC, amount DESC
    LIMIT 5
  `).all().map((row) => ({
    name: row.name || '未知商品',
    quantity: row.quantity,
    amount: row.amount,
    amountText: centsToYuan(row.amount)
  }));
  const pickupPointStats = db.prepare(`
    SELECT pickup_point_name AS name, COUNT(*) AS count
    FROM orders
    WHERE delivery_type = 'pickup' AND pickup_point_name != '' AND status NOT IN ('cancelled', 'refunded')
    GROUP BY pickup_point_name
    ORDER BY count DESC
    LIMIT 5
  `).all();
  return {
    productCount,
    pickupCount,
    orderCount,
    paidOrderCount,
    pendingPaymentCount,
    awaitingShipmentCount,
    awaitingPickupCount,
    lowStockSkuCount,
    soldOutSkuCount,
    revenue,
    revenueText: centsToYuan(revenue),
    couponDiscount,
    couponDiscountText: centsToYuan(couponDiscount),
    whitelistCount,
    couponCount,
    orderStatusRows,
    topProducts,
    pickupPointStats
  };
}

function bootstrap() {
  return {
    dbPath: DB_PATH,
    stats: stats(),
    products: listProducts(),
    pickupPoints: listPickupPoints(),
    shippingRule: getShippingRule(),
    whitelistEntries: listWhitelistEntries(),
    coupons: listCoupons(),
    orders: listOrders(),
    orderBusinessStats: orderBusinessStats(),
    operationLogs: listOperationLogs(80)
  };
}

module.exports = {
  DB_PATH,
  initDb,
  bootstrap,
  listProducts,
  getProduct,
  upsertProduct,
  updateProductStatus,
  updateProductPriority,
  updateProductSkuStock,
  deleteProduct,
  listPickupPoints,
  upsertPickupPoint,
  authenticatePickupPoint,
  togglePickupPoint,
  deletePickupPoint,
  upsertWechatUser,
  getWechatUser,
  bindWechatUserPhone,
  findWechatOpenidByPhone,
  updateOrderWechatOpenid,
  getShippingRule,
  saveShippingRule,
  listWhitelistEntries,
  upsertWhitelistEntry,
  importWhitelistEntries,
  deleteWhitelistEntry,
  deleteWhitelistRule,
  getWhitelistDiscount,
  listAddresses,
  upsertAddress,
  deleteAddress,
  listCoupons,
  getCoupon,
  upsertCoupon,
  updateCouponStatus,
  deleteCoupon,
  quoteStorefrontOrder,
  listOperationLogs,
  addOperationLog,
  listOrders,
  getOrder,
  createStorefrontOrder,
  payOrder,
  updateOrderStatus,
  markWechatShippingSync,
  markWechatReceiptConfirmed,
  markWechatRefundRequested,
  markWechatRefundFailed,
  completeWechatRefund,
  importExpressShipments,
  importPickupShipments,
  orderBusinessStats,
  verifyPickupCode,
  lookupPickupStaffOrder,
  confirmPickupStaffOrder,
  requestAfterSale,
  releaseExpiredPaymentOrders,
  calculateShippingFee,
  stats,
  centsToYuan,
  yuanToCents
};
