const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tempDb = path.join(os.tmpdir(), `peach-admin-${Date.now()}.sqlite`);
const tempUploadDir = path.join(os.tmpdir(), `peach-admin-uploads-${Date.now()}`);
try { fs.unlinkSync(tempDb); } catch (_) {}
process.env.PEACH_DB_PATH = tempDb;
process.env.PEACH_UPLOAD_DIR = tempUploadDir;
delete process.env.WECHAT_APPID;
delete process.env.WX_APPID;
delete process.env.WECHAT_APP_SECRET;
delete process.env.WX_APP_SECRET;
delete process.env.WECHAT_SECRET;
delete process.env.TENCENT_MAP_KEY;
delete process.env.QQ_MAP_KEY;

const adminDb = require('../admin-web/db');
const { server, __test } = require('../admin-web/server');

assert.equal(__test.normalizeTencentMapAddress('双流区东升街道西安路一段142号'), '四川省成都市双流区东升街道西安路一段142号');
assert.equal(__test.normalizeTencentMapAddress('成都市青羊区草堂北路22号'), '成都市青羊区草堂北路22号');
assert.equal(__test.normalizeTencentMapAddress('四川省成都市青羊区草堂北路22号'), '四川省成都市青羊区草堂北路22号');
assert.equal(__test.normalizeTencentMapAddress('重庆市渝中区测试路1号'), '重庆市渝中区测试路1号');

async function listen() {
  await new Promise((resolve) => server.listen(0, resolve));
  return server.address().port;
}

async function request(base, pathname, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: isFormData ? (options.headers || {}) : {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

(async () => {
  adminDb.initDb();
  const product = adminDb.upsertProduct({
    name: '网页后台测试桃',
    subtitle: 'SQLite 测试',
    priceCents: 12000,
    salePriceCents: 9900,
    packageBox: true,
    packageBag: true,
    deliveryPickup: true,
    deliveryExpress: true,
    boxStock: 6,
    bagStock: 4,
    batchName: '测试批次',
    harvestStart: '2026-06-20',
    harvestEnd: '2026-06-30'
  });
  assert.equal(product.stock, 10);
  assert.equal(product.batchName, '测试批次');
  assert.deepEqual(product.skus.find((sku) => sku.packageType === 'bag').deliveryMethods, ['pickup']);

  const point = adminDb.upsertPickupPoint({
    name: '网页测试自提点',
    address: '测试路 1 号',
    packageBox: true,
    packageBag: true,
    enabled: true
  });
  assert.equal(point.enabled, true);
  const validSchedule = {
    batchName: '测试批次',
    pickupValidHours: 48,
    shipStart: '2026-06-22',
    shipEnd: '2026-06-23',
    orderDeadline: '2026-06-21 22:00'
  };

  const rule = adminDb.saveShippingRule({
    localExpressFee: 800,
    remoteExpressFee: 1800,
    freeShippingThreshold: 20000,
    pickupFee: 0,
    localRegionsText: '成都 重庆',
    note: '测试规则'
  });
  assert.equal(rule.localExpressFee, 800);
  assert.equal(rule.remoteExpressFee, 1800);
  assert.ok(rule.localRegions.includes('成都'));

  const raw = new DatabaseSync(tempDb);
  raw.exec('PRAGMA foreign_keys = ON');
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO orders (id, buyer_phone, status, status_text, delivery_type, pay_amount_cents, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('order_test_1', '18800000000', 'awaiting_shipment', '待发货', 'express', 11400, now, now);
  raw.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, sku_name, quantity, unit_price_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('order_test_1', product.id, product.name, '盒装', 1, 9900);
  raw.prepare(`
    INSERT INTO orders (id, buyer_phone, status, status_text, delivery_type, express_receiver, express_phone, express_address, pay_amount_cents, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('order_import_express', '18800000010', 'awaiting_shipment', '待发货', 'express', '导入测试', '18800000010', '成都市测试路 66 号', 9900, now, now);
  raw.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, sku_name, quantity, unit_price_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('order_import_express', product.id, product.name, '盒装', 1, 9900);
  raw.close();

  const port = await listen();
  const base = `http://127.0.0.1:${port}`;
  const session = await request(base, '/api/session');
  assert.equal(session.authRequired, false);
  assert.equal(session.authenticated, true);

  const bootstrap = await request(base, '/api/bootstrap');
  assert.ok(bootstrap.products.length >= 1);
  assert.ok(bootstrap.pickupPoints.length >= 1);
  assert.ok(bootstrap.coupons.some((coupon) => coupon.code === 'PEACH10'));

  const nineWhitelistPhones = Array.from({ length: 9 }, (_, index) => `1880000100${index + 1}`);
  const whitelistPhoneWorkbook = __test.rowsToXlsxBuffer([
    ['手机号'],
    ...nineWhitelistPhones.map((phone) => [phone])
  ], '白名单手机号');
  const whitelistImportPreview = await request(base, '/api/whitelist/import-file', {
    method: 'POST',
    body: JSON.stringify({
      filename: '白名单手机号.xlsx',
      contentBase64: whitelistPhoneWorkbook.toString('base64')
    })
  });
  assert.equal(whitelistImportPreview.count, 9);
  assert.deepEqual(whitelistImportPreview.phones, nineWhitelistPhones);

  const pickupPointWithLogin = await request(base, `/api/pickup-points/${encodeURIComponent(point.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: point.name,
      address: point.address,
      phone: point.phone,
      openTime: point.openTime,
      dailyCapacity: point.dailyCapacity,
      sortWeight: point.sortWeight,
      notice: point.notice,
      packageBox: true,
      packageBag: true,
      enabled: true,
      loginAccount: 'pickup-a',
      loginPassword: '123456'
    })
  });
  assert.equal(pickupPointWithLogin.pickupPoint.loginAccount, 'pickup-a');
  assert.equal(pickupPointWithLogin.pickupPoint.hasLoginPassword, true);

  const otherPickupPoint = await request(base, '/api/pickup-points', {
    method: 'POST',
    body: JSON.stringify({
      name: '核销测试B自提点',
      address: '测试路 2 号',
      packageBox: true,
      packageBag: true,
      enabled: true,
      loginAccount: 'pickup-b',
      loginPassword: '123456'
    })
  });

  await assert.rejects(
    request(base, '/api/pickup-points', {
      method: 'POST',
      body: JSON.stringify({
        name: '重复核销账号自提点',
        address: '测试路 3 号',
        packageBox: true,
        loginAccount: 'pickup-a',
        loginPassword: '123456'
      })
    }),
    /自提点登录账号已被其他自提点使用/
  );

  const wechatLogin = await request(base, '/api/storefront/wechat-login', {
    method: 'POST',
    body: JSON.stringify({ code: 'test-login-code' })
  });
  assert.ok(wechatLogin.session.sessionId);
  assert.equal(wechatLogin.session.mock, true);

  const imageForm = new FormData();
  imageForm.append('file', new Blob([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgB9WmN0AAAAASUVORK5CYII=', 'base64')
  ], { type: 'image/png' }), 'peach.png');
  const uploadedImage = await request(base, '/api/uploads', {
    method: 'POST',
    body: imageForm
  });
  assert.match(uploadedImage.file.url, /^\/uploads\/product-/);
  const imageResponse = await fetch(`${base}${uploadedImage.file.url}`);
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type') || '', /image\/png/);

  const duplicatePickupPayload = {
    name: '重复点击自提点',
    address: '重复测试路 8 号',
    packageBox: true,
    packageBag: true,
    enabled: true
  };
  const firstDuplicatePickup = await request(base, '/api/pickup-points', {
    method: 'POST',
    body: JSON.stringify(duplicatePickupPayload)
  });
  const secondDuplicatePickup = await request(base, '/api/pickup-points', {
    method: 'POST',
    body: JSON.stringify(duplicatePickupPayload)
  });
  assert.equal(secondDuplicatePickup.pickupPoint.id, firstDuplicatePickup.pickupPoint.id);
  const bootstrapAfterDuplicatePickup = await request(base, '/api/bootstrap');
  assert.equal(
    bootstrapAfterDuplicatePickup.pickupPoints.filter((item) => item.name === duplicatePickupPayload.name && item.address === duplicatePickupPayload.address).length,
    1
  );

  await assert.rejects(
    request(base, '/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: '未填批次测试桃',
        priceCents: 10000,
        salePriceCents: 9000,
        ...validSchedule,
        batchName: '',
        packageBox: true,
        deliveryExpress: true,
        boxStock: 1
      })
    }),
    /请输入批次名称/
  );

  await assert.rejects(
    request(base, '/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: '未选包装测试桃',
        priceCents: 10000,
        salePriceCents: 9000,
        ...validSchedule,
        deliveryExpress: true,
        boxStock: 1
      })
    }),
    /至少选择一种包装/
  );

  await assert.rejects(
    request(base, '/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: '未选自提点测试桃',
        priceCents: 10000,
        salePriceCents: 9000,
        ...validSchedule,
        packageBox: true,
        deliveryPickup: true,
        boxStock: 1
      })
    }),
    /请选择该商品适用的自提点/
  );
  await assert.rejects(
    request(base, '/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: '自提点包装不匹配测试桃',
        priceCents: 10000,
        salePriceCents: 9000,
        ...validSchedule,
        packageBox: true,
        deliveryPickup: true,
        pickupPointIds: ['pickup-east'],
        boxStock: 1
      })
    }),
    /不支持当前商品包装/
  );

  const created = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '接口创建桃',
      coverImage: uploadedImage.file.url,
      imagesText: `${uploadedImage.file.url}\n/uploads/detail-test.png`,
      detailText: '测试商品详情\n支持多图和预售规则',
      priceCents: 10000,
      salePriceCents: 8800,
      ...validSchedule,
      packageBox: true,
      deliveryPickup: true,
      pickupPointIds: [point.id],
      boxStock: 3
    })
  });
  assert.equal(created.product.name, '接口创建桃');
  assert.equal(created.product.coverImage, uploadedImage.file.url);
  assert.equal(created.product.images.length, 2);
  assert.match(created.product.detailText, /测试商品详情/);
  assert.equal(created.product.initialStock, 3);
  assert.equal(created.product.soldCount, 0);
  assert.equal(created.product.saleType, 'presale');

  const directProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '直售现货桃',
      saleType: 'direct',
      priceCents: 6800,
      salePriceCents: 6800,
      batchName: '现货批次',
      packageBox: true,
      deliveryExpress: true,
      boxStock: 3
    })
  });
  assert.equal(directProduct.product.saleType, 'direct');
  assert.equal(directProduct.product.shipStart, '');
  assert.equal(directProduct.product.shipEnd, '');
  assert.equal(directProduct.product.orderDeadline, '');
  const directOrder = adminDb.createStorefrontOrder({
    id: 'order_direct_sale_test',
    buyerPhone: '18800009999',
    items: [{
      productId: directProduct.product.id,
      skuId: directProduct.product.skus[0].id,
      quantity: 1
    }],
    deliveryType: 'express',
    expressInfo: {
      receiver: '直售客人',
      phone: '18800009999',
      address: '四川省成都市高新区现货路1号'
    }
  });
  assert.equal(directOrder.saleType, 'direct');
  assert.equal(directOrder.fulfillmentStart, '');
  assert.equal(directOrder.fulfillmentEnd, '');
  assert.ok(adminDb.listOrders({ saleType: 'direct' }).some((order) => order.id === directOrder.id));

  const dualPriceProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '双规格价格测试桃',
      priceCents: 8000,
      salePriceCents: 7000,
      ...validSchedule,
      packageBox: true,
      packageBag: true,
      deliveryPickup: true,
      pickupPointIds: [point.id],
      skus: [
        { packageType: 'box', name: '6斤盒装', price: 12800, salePrice: 10800, stock: 2 },
        { packageType: 'bag', name: '4斤袋装', price: 8800, salePrice: 7600, stock: 3 }
      ]
    })
  });
  const dualBoxSku = dualPriceProduct.product.skus.find((sku) => sku.packageType === 'box');
  const dualBagSku = dualPriceProduct.product.skus.find((sku) => sku.packageType === 'bag');
  assert.equal(dualBoxSku.price, 10800);
  assert.equal(dualBoxSku.salePrice, 10800);
  assert.equal(dualBagSku.price, 7600);
  assert.equal(dualBagSku.salePrice, 7600);

  const bagOnlyProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '袋装禁快递测试桃',
      priceCents: 9000,
      salePriceCents: 8000,
      ...validSchedule,
      packageBag: true,
      deliveryPickup: true,
      deliveryExpress: true,
      pickupPointIds: [point.id],
      bagStock: 5
    })
  });
  const bagOnlySku = bagOnlyProduct.product.skus.find((sku) => sku.packageType === 'bag');
  assert.deepEqual(bagOnlySku.deliveryMethods, ['pickup']);
  assert.deepEqual(bagOnlyProduct.product.deliveryMethods, ['pickup']);
  await assert.rejects(
    request(base, '/api/storefront/quote', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000008',
        items: [{
          productId: bagOnlyProduct.product.id,
          skuId: bagOnlySku.id,
          quantity: 1
        }],
        deliveryType: 'express',
        expressInfo: {
          receiver: '李四',
          phone: '18800000008',
          address: '四川省成都市高新区测试路 1 号'
        }
      })
    }),
    /当前规格不支持该配送方式/
  );

  const newerOffSale = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '排序下架测试桃',
      priceCents: 10000,
      salePriceCents: 9000,
      ...validSchedule,
      packageBox: true,
      deliveryPickup: true,
      pickupPointIds: [point.id],
      boxStock: 1
    })
  });
  const offSaleResult = await request(base, `/api/products/${encodeURIComponent(newerOffSale.product.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'off_sale_manual' })
  });
  assert.equal(offSaleResult.product.status, 'off_sale_manual');
  assert.ok(offSaleResult.product.statusChangedAt);
  const sortedProducts = await request(base, '/api/products');
  const createdIndex = sortedProducts.products.findIndex((item) => item.id === created.product.id);
  const offSaleIndex = sortedProducts.products.findIndex((item) => item.id === newerOffSale.product.id);
  assert.ok(createdIndex >= 0 && offSaleIndex >= 0);
  assert.ok(createdIndex < offSaleIndex);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const relisted = await request(base, `/api/products/${encodeURIComponent(newerOffSale.product.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'on_sale' })
  });
  assert.equal(relisted.product.status, 'on_sale');
  assert.ok(new Date(relisted.product.listedAt).getTime() >= new Date(newerOffSale.product.listedAt).getTime());
  const relistedProducts = await request(base, '/api/products');
  const relistedIndex = relistedProducts.products.findIndex((item) => item.id === newerOffSale.product.id);
  const originalCreatedIndex = relistedProducts.products.findIndex((item) => item.id === created.product.id);
  assert.ok(relistedIndex >= 0 && originalCreatedIndex >= 0);
  assert.ok(relistedIndex < originalCreatedIndex);

  await request(base, `/api/products/${encodeURIComponent(newerOffSale.product.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'off_sale_manual' })
  });
  await request(base, `/api/products/${encodeURIComponent(newerOffSale.product.id)}/skus/${encodeURIComponent(relisted.product.skus[0].id)}/stock`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'set', quantity: 0 })
  });
  const zeroStockRelist = await fetch(`${base}/api/products/${encodeURIComponent(newerOffSale.product.id)}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'on_sale' })
  });
  assert.equal(zeroStockRelist.status, 400);
  assert.match((await zeroStockRelist.json()).error, /库存必须大于 0/);

  const stockOpsProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '库存统计测试桃',
      priceCents: 10000,
      salePriceCents: 9000,
      ...validSchedule,
      packageBox: true,
      deliveryPickup: true,
      pickupPointIds: [point.id],
      boxStock: 2
    })
  });
  assert.equal(stockOpsProduct.product.stock, 2);
  assert.equal(stockOpsProduct.product.initialStock, 2);
  const stockOpsSkuId = stockOpsProduct.product.skus[0].id;
  const restockedProduct = await request(base, `/api/products/${encodeURIComponent(stockOpsProduct.product.id)}/skus/${encodeURIComponent(stockOpsSkuId)}/stock`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'add', quantity: 5 })
  });
  assert.equal(restockedProduct.product.stock, 7);
  assert.equal(restockedProduct.product.initialStock, 7);
  const adjustedProduct = await request(base, `/api/products/${encodeURIComponent(stockOpsProduct.product.id)}/skus/${encodeURIComponent(stockOpsSkuId)}/stock`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'set', quantity: 4 })
  });
  assert.equal(adjustedProduct.product.stock, 4);
  assert.equal(adjustedProduct.product.initialStock, 7);
  const idempotentOrderPayload = {
    id: 'order_idempotent_test',
    buyerPhone: '18800000009',
    items: [{
      productId: stockOpsProduct.product.id,
      skuId: stockOpsSkuId,
      quantity: 1
    }],
    deliveryType: 'pickup',
    pickupPointId: point.id
  };
  const firstIdempotentOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify(idempotentOrderPayload)
  });
  const secondIdempotentOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify(idempotentOrderPayload)
  });
  assert.equal(firstIdempotentOrder.order.id, 'order_idempotent_test');
  assert.equal(secondIdempotentOrder.order.id, 'order_idempotent_test');
  const afterIdempotentOrder = await request(base, `/api/storefront/products/${encodeURIComponent(stockOpsProduct.product.id)}`);
  assert.equal(afterIdempotentOrder.product.skus[0].stock, 3);

  const pickupStaffLogin = await request(base, '/api/storefront/pickup-staff/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'pickup-a', password: '123456' })
  });
  assert.ok(pickupStaffLogin.session.sessionId);
  assert.equal(pickupStaffLogin.session.pickupPoint.id, point.id);
  await assert.rejects(
    request(base, '/api/storefront/pickup-staff/login', {
      method: 'POST',
      body: JSON.stringify({ account: 'pickup-a', password: 'wrong' })
    }),
    /自提点账号或密码错误/
  );
  const otherPickupStaffLogin = await request(base, '/api/storefront/pickup-staff/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'pickup-b', password: '123456' })
  });
  const staffReadyOrder = adminDb.createStorefrontOrder({
    id: 'order_pickup_staff_ready',
    buyerPhone: '18800001234',
    items: [{
      productId: product.id,
      skuId: product.skus[0].id,
      quantity: 1
    }],
    deliveryType: 'pickup',
    pickupPointId: point.id,
    pickupCode: '333444'
  });
  adminDb.updateOrderStatus(staffReadyOrder.id, { status: 'pickup_shipped', detail: '测试自提点已到货' });
  const staffPendingOrder = adminDb.createStorefrontOrder({
    id: 'order_pickup_staff_pending',
    buyerPhone: '18800005678',
    items: [{
      productId: product.id,
      skuId: product.skus[0].id,
      quantity: 1
    }],
    deliveryType: 'pickup',
    pickupPointId: point.id,
    pickupCode: '555666'
  });
  const staffNotFound = await request(base, '/api/storefront/pickup-staff/lookup', {
    method: 'POST',
    body: JSON.stringify({ sessionId: pickupStaffLogin.session.sessionId, phoneTail: '9999', pickupCode: '333444' })
  });
  assert.equal(staffNotFound.result.status, 'not_found');
  const staffWrongPoint = await request(base, '/api/storefront/pickup-staff/lookup', {
    method: 'POST',
    body: JSON.stringify({ sessionId: otherPickupStaffLogin.session.sessionId, phoneTail: '1234', pickupCode: '333444' })
  });
  assert.equal(staffWrongPoint.result.status, 'wrong_pickup_point');
  assert.match(staffWrongPoint.result.message, /网页测试自提点/);
  const staffNotArrived = await request(base, '/api/storefront/pickup-staff/lookup', {
    method: 'POST',
    body: JSON.stringify({ sessionId: pickupStaffLogin.session.sessionId, phoneTail: '5678', pickupCode: '555666' })
  });
  assert.equal(staffNotArrived.result.status, 'not_arrived');
  const staffReady = await request(base, '/api/storefront/pickup-staff/lookup', {
    method: 'POST',
    body: JSON.stringify({ sessionId: pickupStaffLogin.session.sessionId, phoneTail: '1234', pickupCode: '333444' })
  });
  assert.equal(staffReady.result.status, 'ready');
  const staffPicked = await request(base, '/api/storefront/pickup-staff/confirm', {
    method: 'POST',
    body: JSON.stringify({ sessionId: pickupStaffLogin.session.sessionId, phoneTail: '1234', pickupCode: '333444' })
  });
  assert.equal(staffPicked.result.status, 'picked');
  const staffAlreadyPicked = await request(base, '/api/storefront/pickup-staff/confirm', {
    method: 'POST',
    body: JSON.stringify({ sessionId: pickupStaffLogin.session.sessionId, phoneTail: '1234', pickupCode: '333444' })
  });
  assert.equal(staffAlreadyPicked.result.status, 'already_picked');
  const staffPickedOrder = await request(base, `/api/storefront/orders/${encodeURIComponent(staffReadyOrder.id)}`);
  assert.equal(staffPickedOrder.order.status, 'picked_up');
  assert.equal(staffPendingOrder.status, 'awaiting_pickup');

  const addressSaved = await request(base, '/api/storefront/addresses', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000001',
      receiver: '张三',
      phone: '18800000001',
      address: '测试省测试市测试路 9 号',
      isDefault: true
    })
  });
  assert.equal(addressSaved.address.receiver, '张三');
  const addressList = await request(base, '/api/storefront/addresses?phone=18800000001');
  assert.equal(addressList.addresses.length, 1);
  const duplicateAddressSaved = await request(base, '/api/storefront/addresses', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000001',
      receiver: '张三',
      phone: '18800000001',
      address: '测试省测试市测试路 9 号',
      isDefault: true
    })
  });
  assert.equal(duplicateAddressSaved.address.id, addressSaved.address.id);
  const dedupedAddressList = await request(base, '/api/storefront/addresses?phone=18800000001');
  assert.equal(dedupedAddressList.addresses.length, 1);
  const rawAddressDuplicate = new DatabaseSync(tempDb);
  rawAddressDuplicate.prepare(`
    INSERT INTO addresses (id, buyer_phone, receiver, phone, address, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('addr_duplicate_raw', '18800000001', '张三', '18800000001', '测试省测试市测试路 9 号', 0, now, now);
  rawAddressDuplicate.close();
  const dedupedRawAddressList = await request(base, '/api/storefront/addresses?phone=18800000001');
  assert.equal(dedupedRawAddressList.addresses.length, 1);
  await request(base, '/api/storefront/addresses', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000001',
      receiver: '张三',
      phone: '18800000001',
      address: '测试省测试市测试路 9 号',
      isDefault: true
    })
  });
  const rawAddressCount = new DatabaseSync(tempDb);
  const duplicateAddressCount = rawAddressCount.prepare(`
    SELECT COUNT(*) AS count FROM addresses
    WHERE buyer_phone = ? AND receiver = ? AND phone = ? AND address = ?
  `).get('18800000001', '张三', '18800000001', '测试省测试市测试路 9 号').count;
  rawAddressCount.close();
  assert.equal(duplicateAddressCount, 1);

  const localExpressQuote = await request(base, '/api/storefront/quote', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000004',
      items: [{
        productId: product.id,
        skuId: product.skus[0].id,
        quantity: 1
      }],
      deliveryType: 'express',
      expressInfo: {
        receiver: '李四',
        phone: '18800000004',
        address: '四川省成都市高新区测试路 1 号'
      }
    })
  });
  assert.equal(localExpressQuote.quote.shipping.fee, 800);
  assert.equal(localExpressQuote.quote.shipping.zone, 'local');
  assert.equal(localExpressQuote.quote.payAmount, 9900 + 800);

  const localExpressMultiQuote = await request(base, '/api/storefront/quote', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000004',
      items: [{
        productId: product.id,
        skuId: product.skus[0].id,
        quantity: 2
      }],
      deliveryType: 'express',
      expressInfo: {
        receiver: '李四',
        phone: '18800000004',
        address: '四川省成都市高新区测试路 1 号'
      }
    })
  });
  assert.equal(localExpressMultiQuote.quote.shipping.fee, 800 * 2);
  assert.equal(localExpressMultiQuote.quote.shipping.quantity, 2);
  assert.equal(localExpressMultiQuote.quote.shipping.unitFee, 800);
  assert.equal(localExpressMultiQuote.quote.payAmount, 9900 * 2 + 800 * 2);

  const remoteExpressQuote = await request(base, '/api/storefront/quote', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000004',
      items: [{
        productId: product.id,
        skuId: product.skus[0].id,
        quantity: 1
      }],
      deliveryType: 'express',
      expressInfo: {
        receiver: '李四',
        phone: '18800000004',
        address: '浙江省杭州市西湖区测试路 2 号'
      }
    })
  });
  assert.equal(remoteExpressQuote.quote.shipping.fee, 1800);
  assert.equal(remoteExpressQuote.quote.shipping.zone, 'remote');
  assert.equal(remoteExpressQuote.quote.payAmount, 9900 + 1800);

  const freeExpressQuote = await request(base, '/api/storefront/quote', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000004',
      items: [{
        productId: product.id,
        skuId: product.skus[0].id,
        quantity: 3
      }],
      deliveryType: 'express',
      expressInfo: {
        receiver: '李四',
        phone: '18800000004',
        address: '重庆市渝中区测试路 3 号'
      }
    })
  });
  assert.equal(freeExpressQuote.quote.shipping.fee, 0);
  assert.equal(freeExpressQuote.quote.payAmount, 9900 * 3);

  const whitelistWithoutProducts = await fetch(`${base}/api/whitelist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phonesText: '18800000001',
      discountPercent: 75,
      label: '未选商品白名单'
    })
  });
  assert.equal(whitelistWithoutProducts.status, 400);
  assert.match((await whitelistWithoutProducts.json()).error, /请选择白名单适用商品/);

  const whitelist = await request(base, '/api/whitelist', {
    method: 'POST',
    body: JSON.stringify({
      phonesText: '18800000001 18800000002',
      discountPercent: 75,
      label: '测试白名单',
      productIds: [created.product.id]
    })
  });
  assert.ok(whitelist.whitelistEntries.some((entry) => entry.phone === '18800000001' && entry.discountPercent === 75 && entry.productIds.includes(created.product.id)));
  const discount = await request(base, `/api/storefront/whitelist-discount?phone=18800000001&productId=${encodeURIComponent(created.product.id)}`);
  assert.equal(discount.discount.percent, 75);
  const unrelatedDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000001&productId=${encodeURIComponent(stockOpsProduct.product.id)}`);
  assert.equal(unrelatedDiscount.discount, null);
  const secondWhitelist = await request(base, '/api/whitelist', {
    method: 'POST',
    body: JSON.stringify({
      phonesText: '18800000001',
      discountPercent: 60,
      label: '第二批白名单',
      productIds: [stockOpsProduct.product.id]
    })
  });
  assert.ok(secondWhitelist.whitelistEntries.some((entry) => entry.phone === '18800000001' && entry.discountPercent === 75 && entry.productIds.includes(created.product.id)));
  assert.ok(secondWhitelist.whitelistEntries.some((entry) => entry.phone === '18800000001' && entry.discountPercent === 60 && entry.productIds.includes(stockOpsProduct.product.id)));
  const originalRuleDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000001&productId=${encodeURIComponent(created.product.id)}`);
  assert.equal(originalRuleDiscount.discount.percent, 75);
  const secondRuleDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000001&productId=${encodeURIComponent(stockOpsProduct.product.id)}`);
  assert.equal(secondRuleDiscount.discount.percent, 60);
  const stillUnrelatedDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000001&productId=${encodeURIComponent(product.id)}`);
  assert.equal(stillUnrelatedDiscount.discount, null);

  await request(base, '/api/whitelist', {
    method: 'POST',
    body: JSON.stringify({
      phonesText: '18800000011',
      discountPercent: 70,
      label: '规则删除测试 A',
      productIds: [created.product.id]
    })
  });
  const deleteRuleSetup = await request(base, '/api/whitelist', {
    method: 'POST',
    body: JSON.stringify({
      phonesText: '18800000011',
      discountPercent: 60,
      label: '规则删除测试 B',
      productIds: [stockOpsProduct.product.id]
    })
  });
  const firstRule = deleteRuleSetup.whitelistEntries.find((entry) => (
    entry.phone === '18800000011' && entry.productIds.includes(created.product.id)
  ));
  const secondRule = deleteRuleSetup.whitelistEntries.find((entry) => (
    entry.phone === '18800000011' && entry.productIds.includes(stockOpsProduct.product.id)
  ));
  assert.ok(firstRule && firstRule.ruleId);
  assert.ok(secondRule && secondRule.ruleId);
  const deleteRuleResult = await request(base, `/api/whitelist/${encodeURIComponent('18800000011')}/rules/${encodeURIComponent(firstRule.ruleId)}`, {
    method: 'DELETE'
  });
  assert.equal(deleteRuleResult.ok, true);
  const deletedRuleDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000011&productId=${encodeURIComponent(created.product.id)}`);
  assert.equal(deletedRuleDiscount.discount, null);
  const preservedRuleDiscount = await request(base, `/api/storefront/whitelist-discount?phone=18800000011&productId=${encodeURIComponent(stockOpsProduct.product.id)}`);
  assert.equal(preservedRuleDiscount.discount.percent, 60);
  const afterRuleDeleteList = await request(base, '/api/whitelist');
  assert.equal(afterRuleDeleteList.whitelistEntries.some((entry) => entry.ruleId === firstRule.ruleId), false);
  assert.equal(afterRuleDeleteList.whitelistEntries.some((entry) => entry.ruleId === secondRule.ruleId), true);

  let couponResult = await request(base, '/api/coupons', {
    method: 'POST',
    body: JSON.stringify({
      code: 'TEST5',
      type: 'amount',
      value: 500,
      source: '自动化测试',
      productIds: [created.product.id],
      enabled: true,
      usageLimit: 10,
      perPhoneLimit: 1
    })
  });
  assert.ok(couponResult.coupons.some((coupon) => coupon.code === 'TEST5' && coupon.value === 500 && coupon.productIds.includes(created.product.id)));
  const couponWithoutProducts = await fetch(`${base}/api/coupons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'NOPRODUCT',
      type: 'amount',
      value: 500,
      enabled: true
    })
  });
  assert.equal(couponWithoutProducts.status, 400);
  assert.match((await couponWithoutProducts.json()).error, /请选择优惠码适用商品/);
  await assert.rejects(
    request(base, '/api/coupons', {
      method: 'POST',
      body: JSON.stringify({
        code: 'TEST5',
        type: 'amount',
        value: 600,
        source: '重复优惠码测试',
        productIds: [stockOpsProduct.product.id],
        enabled: true
      })
    }),
    /优惠码已存在，请重新输入/
  );
  let couponListAfterDuplicateCreate = await request(base, '/api/coupons');
  let test5AfterDuplicateCreate = couponListAfterDuplicateCreate.coupons.find((coupon) => coupon.code === 'TEST5');
  assert.deepEqual(test5AfterDuplicateCreate.productIds, [created.product.id]);
  await request(base, '/api/coupons', {
    method: 'POST',
    body: JSON.stringify({
      originalCode: 'TEST5',
      code: 'TEST5',
      type: 'amount',
      value: 500,
      source: '自动化测试编辑',
      productIds: [created.product.id],
      enabled: true,
      usageLimit: 10,
      perPhoneLimit: 1
    })
  });
  couponListAfterDuplicateCreate = await request(base, '/api/coupons');
  test5AfterDuplicateCreate = couponListAfterDuplicateCreate.coupons.find((coupon) => coupon.code === 'TEST5');
  assert.ok(test5AfterDuplicateCreate.productIds.includes(created.product.id));
  assert.equal(test5AfterDuplicateCreate.productIds.includes(stockOpsProduct.product.id), false);
  assert.equal(test5AfterDuplicateCreate.source, '自动化测试编辑');
  couponResult = await request(base, '/api/coupons/TEST5/status', {
    method: 'POST',
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(couponResult.coupon.enabled, false);
  couponResult = await request(base, '/api/coupons/TEST5/status', {
    method: 'POST',
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(couponResult.coupon.enabled, true);
  await assert.rejects(
    request(base, '/api/storefront/quote', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000005',
        items: [{
          productId: stockOpsProduct.product.id,
          skuId: stockOpsProduct.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: point.id,
        couponCode: 'TEST5'
      })
    }),
    /优惠码不适用于当前商品/
  );

  const thresholdProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '满减门槛测试桃',
      priceCents: 7000,
      salePriceCents: 6000,
      ...validSchedule,
      packageBox: true,
      deliveryPickup: true,
      pickupPointIds: [point.id],
      boxStock: 4
    })
  });
  couponResult = await request(base, '/api/coupons', {
    method: 'POST',
    body: JSON.stringify({
      code: 'FULL100',
      type: 'amount',
      value: 1200,
      minOrderAmount: 10000,
      source: '满减测试',
      productIds: [thresholdProduct.product.id],
      enabled: true,
      usageLimit: 10,
      perPhoneLimit: 0
    })
  });
  const thresholdCoupon = couponResult.coupons.find((coupon) => coupon.code === 'FULL100');
  assert.equal(thresholdCoupon.minOrderAmount, 10000);
  assert.match(thresholdCoupon.minOrderAmountText, /100\.00/);

  await assert.rejects(
    request(base, '/api/storefront/orders', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000006',
        items: [{
          productId: thresholdProduct.product.id,
          skuId: thresholdProduct.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: point.id,
        couponCode: 'FULL100'
      })
    }),
    /未达到优惠码使用门槛/
  );
  let thresholdProductAfterFail = await request(base, `/api/storefront/products/${encodeURIComponent(thresholdProduct.product.id)}`);
  assert.equal(thresholdProductAfterFail.product.skus[0].stock, 4);

  await assert.rejects(
    request(base, '/api/storefront/quote', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000006',
        items: [{
          productId: thresholdProduct.product.id,
          skuId: thresholdProduct.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        couponCode: 'FULL100'
      })
    }),
    /未达到优惠码使用门槛/
  );
  const thresholdQuote = await request(base, '/api/storefront/quote', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000006',
      items: [{
        productId: thresholdProduct.product.id,
        skuId: thresholdProduct.product.skus[0].id,
        quantity: 2
      }],
      deliveryType: 'pickup',
      couponCode: 'FULL100'
    })
  });
  assert.equal(thresholdQuote.quote.goodsAmount, 10800);
  assert.equal(thresholdQuote.quote.payAmount, 10800);
  assert.equal(thresholdQuote.quote.couponCode, 'FULL100');

  const thresholdOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000006',
      items: [{
        productId: thresholdProduct.product.id,
        skuId: thresholdProduct.product.skus[0].id,
        quantity: 2
      }],
      deliveryType: 'pickup',
      pickupPointId: point.id,
      couponCode: 'FULL100'
    })
  });
  assert.equal(thresholdOrder.order.payAmount, 10800);
  assert.equal(thresholdOrder.order.couponCode, 'FULL100');
  assert.ok(thresholdOrder.order.discountTrace.some((item) => item.type === 'coupon' && item.minOrderAmount === 10000));
  thresholdProductAfterFail = await request(base, `/api/storefront/products/${encodeURIComponent(thresholdProduct.product.id)}`);
  assert.equal(thresholdProductAfterFail.product.skus[0].stock, 2);

  await assert.rejects(
    request(base, '/api/storefront/quote', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000001',
        items: [{
          productId: created.product.id,
          skuId: created.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: point.id,
        couponCode: 'PEACH10'
      })
    }),
    /白名单用户不可使用优惠码/
  );

  await assert.rejects(
    request(base, '/api/storefront/orders', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000001',
        items: [{
          productId: created.product.id,
          skuId: created.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: point.id,
        couponCode: 'PEACH10'
      })
    }),
    /白名单用户不可使用优惠码/
  );

  const blockedPoint = await request(base, '/api/pickup-points', {
    method: 'POST',
    body: JSON.stringify({
      name: '不适用自提点',
      address: '测试路 2 号',
      packageBox: true,
      packageBag: true,
      enabled: true
    })
  });
  const pickupBoundProduct = await request(base, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: '自提点绑定测试桃',
      priceCents: 9000,
      salePriceCents: 8000,
      ...validSchedule,
      packageBox: true,
      deliveryPickup: true,
      boxStock: 2,
      pickupPointIds: [point.id]
    })
  });
  assert.deepEqual(pickupBoundProduct.product.pickupPointIds, [point.id]);
  await assert.rejects(
    request(base, '/api/storefront/quote', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000007',
        items: [{
          productId: pickupBoundProduct.product.id,
          skuId: pickupBoundProduct.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: blockedPoint.pickupPoint.id
      })
    }),
    /该商品不支持当前自提点/
  );
  await assert.rejects(
    request(base, '/api/storefront/orders', {
      method: 'POST',
      body: JSON.stringify({
        buyerPhone: '18800000007',
        items: [{
          productId: pickupBoundProduct.product.id,
          skuId: pickupBoundProduct.product.skus[0].id,
          quantity: 1
        }],
        deliveryType: 'pickup',
        pickupPointId: blockedPoint.pickupPoint.id
      })
    }),
    /该商品不支持当前自提点/
  );
  const pickupBoundOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000007',
      items: [{
        productId: pickupBoundProduct.product.id,
        skuId: pickupBoundProduct.product.skus[0].id,
        quantity: 1
      }],
      deliveryType: 'pickup',
      pickupPointId: point.id
    })
  });
  assert.equal(pickupBoundOrder.order.status, 'awaiting_pickup');

  const pickupImport = await request(base, '/api/orders/import-pickup-shipments', {
    method: 'POST',
    body: JSON.stringify({ rows: [{ orderId: pickupBoundOrder.order.id, detail: '测试贴单已发' }] })
  });
  assert.equal(pickupImport.result.matched.length, 1);
  const importedPickupOrder = await request(base, `/api/storefront/orders/${encodeURIComponent(pickupBoundOrder.order.id)}`);
  assert.equal(importedPickupOrder.order.status, 'pickup_shipped');
  const verifiedImportedPickup = await request(base, '/api/orders/verify-pickup', {
    method: 'POST',
    body: JSON.stringify({ pickupCode: importedPickupOrder.order.pickupCode })
  });
  assert.equal(verifiedImportedPickup.order.status, 'picked_up');

  const storefrontOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000001',
      items: [{
        productId: created.product.id,
        skuId: created.product.skus[0].id,
        quantity: 1,
        unitPrice: created.product.skus[0].salePrice
      }],
      deliveryType: 'pickup',
      pickupPointId: point.id,
      pickupPointName: point.name,
      goodsAmount: 8800,
      totalAmount: 8800,
      payAmount: 8800
    })
  });
  assert.equal(storefrontOrder.order.status, 'awaiting_pickup');
  assert.equal(storefrontOrder.order.items[0].productId, created.product.id);
  assert.equal(storefrontOrder.order.goodsAmount, 6600);
  assert.equal(storefrontOrder.order.payAmount, 6600);
  assert.equal(storefrontOrder.order.couponCode, '');
  assert.ok(storefrontOrder.order.discountTrace.some((item) => item.type === 'whitelist'));
  assert.equal(storefrontOrder.order.discountTrace.some((item) => item.type === 'coupon'), false);

  const afterDeduct = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterDeduct.product.skus[0].stock, 2);
  assert.equal(afterDeduct.product.soldCount, 1);
  assert.equal(afterDeduct.product.initialStock, 3);

  const cancelled = await request(base, `/api/orders/${encodeURIComponent(storefrontOrder.order.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'cancelled', detail: '测试取消回补库存' })
  });
  assert.equal(cancelled.order.status, 'cancelled');
  assert.ok(cancelled.order.inventoryRestockedAt);
  const afterRestock = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterRestock.product.skus[0].stock, 3);
  assert.equal(afterRestock.product.soldCount, 0);
  assert.equal(afterRestock.product.initialStock, 3);

  await request(base, `/api/orders/${encodeURIComponent(storefrontOrder.order.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'cancelled', detail: '重复取消不应重复回补' })
  });
  const afterSecondCancel = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterSecondCancel.product.skus[0].stock, 3);

  const pendingOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000003',
      payNow: false,
      items: [{
        productId: created.product.id,
        skuId: created.product.skus[0].id,
        quantity: 1
      }],
      deliveryType: 'pickup',
      pickupPointId: point.id,
      couponCode: 'TEST5'
    })
  });
  assert.equal(pendingOrder.order.status, 'awaiting_payment');
  assert.ok(pendingOrder.order.paymentExpiresAt);
  assert.equal(pendingOrder.order.payAmount, 8300);
  let afterPendingLock = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterPendingLock.product.skus[0].stock, 2);
  assert.equal(afterPendingLock.product.lockedCount, 1);
  assert.equal(afterPendingLock.product.soldCount, 0);
  assert.equal(afterPendingLock.product.initialStock, 3);

  const paidPending = await request(base, `/api/storefront/orders/${encodeURIComponent(pendingOrder.order.id)}/pay`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(paidPending.order.status, 'awaiting_pickup');
  assert.ok(paidPending.order.paidAt);
  const afterPendingPay = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterPendingPay.product.lockedCount, 0);
  assert.equal(afterPendingPay.product.soldCount, 1);
  assert.equal(afterPendingPay.product.initialStock, 3);
  const couponListAfterPay = await request(base, '/api/coupons');
  const testCoupon = couponListAfterPay.coupons.find((coupon) => coupon.code === 'TEST5');
  assert.equal(testCoupon.usedCount, 1);
  assert.equal(testCoupon.usedAmount, 500);

  const prematureAfterSale = await fetch(`${base}/api/storefront/orders/${encodeURIComponent(paidPending.order.id)}/after-sale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyerPhone: '18800000003',
      reason: '未自提前售后'
    })
  });
  assert.equal(prematureAfterSale.status, 400);
  assert.match((await prematureAfterSale.json()).error, /当前订单状态不可申请售后/);

  const prematureAdminAfterSale = await fetch(`${base}/api/orders/${encodeURIComponent(paidPending.order.id)}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'after_sale', reason: '未自提前后台售后' })
  });
  assert.equal(prematureAdminAfterSale.status, 400);
  assert.match((await prematureAdminAfterSale.json()).error, /当前订单状态不可申请售后/);

  const verified = await request(base, '/api/orders/verify-pickup', {
    method: 'POST',
    body: JSON.stringify({ pickupCode: paidPending.order.pickupCode })
  });
  assert.equal(verified.order.status, 'picked_up');

  const refundWithoutAfterSale = await fetch(`${base}/api/orders/${encodeURIComponent(paidPending.order.id)}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'refunded', reason: '无售后直接退款', refundAmount: 8300 })
  });
  assert.equal(refundWithoutAfterSale.status, 400);
  assert.match((await refundWithoutAfterSale.json()).error, /暂无售后申请/);

  const afterSale = await request(base, `/api/storefront/orders/${encodeURIComponent(paidPending.order.id)}/after-sale`, {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000003',
      reason: '测试售后申请'
    })
  });
  assert.equal(afterSale.order.status, 'after_sale');
  assert.equal(afterSale.order.afterSaleInfo.status, 'requested');

  const refunded = await request(base, `/api/orders/${encodeURIComponent(paidPending.order.id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'refunded', reason: '测试退款完成', refundAmount: 8300 })
  });
  assert.equal(refunded.order.status, 'refunded');
  assert.equal(refunded.order.afterSaleInfo.status, 'refunded');
  assert.equal(refunded.order.afterSaleInfo.reason, '测试售后申请');
  assert.equal(refunded.order.afterSaleInfo.refundNote, '测试退款完成');
  assert.ok(refunded.order.afterSaleInfo.handledAt, '退款后售后处理时间应写入');
  const afterRefundRestock = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterRefundRestock.product.soldCount, 0);
  assert.equal(afterRefundRestock.product.skus[0].stock, 3);

  const expiringOrder = await request(base, '/api/storefront/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000004',
      payNow: false,
      items: [{
        productId: created.product.id,
        skuId: created.product.skus[0].id,
        quantity: 1
      }],
      deliveryType: 'pickup',
      pickupPointId: point.id
    })
  });
  assert.equal(expiringOrder.order.status, 'awaiting_payment');
  const rawExpire = new DatabaseSync(tempDb);
  rawExpire.prepare('UPDATE orders SET payment_expires_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', expiringOrder.order.id);
  rawExpire.close();
  const released = await request(base, '/api/orders/release-expired', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.ok(released.releasedCount >= 1);
  afterPendingLock = await request(base, `/api/storefront/products/${encodeURIComponent(created.product.id)}`);
  assert.equal(afterPendingLock.product.skus[0].stock, 3);

  const expressImport = await request(base, '/api/orders/import-express-shipments', {
    method: 'POST',
    body: JSON.stringify({
      rows: [
        { orderId: 'order_import_express', company: '顺丰', trackingNo: 'SFIMPORT1' },
        { orderId: 'order_not_exists', company: '顺丰', trackingNo: 'SF404' }
      ]
    })
  });
  assert.equal(expressImport.result.matched.length, 1);
  assert.equal(expressImport.result.unmatched.length, 1);
  const importedExpressOrder = await request(base, '/api/storefront/orders/order_import_express');
  assert.equal(importedExpressOrder.order.status, 'shipped');
  assert.equal(importedExpressOrder.order.expressShipment.trackingNo, 'SFIMPORT1');

  const prematureExpressAfterSale = await fetch(`${base}/api/storefront/orders/order_test_1/after-sale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyerPhone: '18800000000',
      reason: '未发货前售后'
    })
  });
  assert.equal(prematureExpressAfterSale.status, 400);
  assert.match((await prematureExpressAfterSale.json()).error, /当前订单状态不可申请售后/);

  const shipped = await request(base, '/api/orders/order_test_1/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'shipped', company: '顺丰', trackingNo: 'SF123', detail: '顺丰 SF123' })
  });
  assert.equal(shipped.order.status, 'shipped');
  assert.equal(shipped.order.expressShipment.trackingNo, 'SF123');

  const shippedExpressAfterSale = await fetch(`${base}/api/storefront/orders/order_test_1/after-sale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyerPhone: '18800000000',
      reason: '已发货未领取售后'
    })
  });
  assert.equal(shippedExpressAfterSale.status, 400);
  assert.match((await shippedExpressAfterSale.json()).error, /当前订单状态不可申请售后/);

  await assert.rejects(
    request(base, '/api/orders/order_test_1/status', {
      method: 'POST',
      body: JSON.stringify({ status: 'shipped', company: '', trackingNo: '' })
    }),
    /请填写快递公司和快递单号/
  );

  const delivered = await request(base, '/api/orders/order_test_1/status', {
    method: 'POST',
    body: JSON.stringify({ status: 'completed', detail: '快递签收' })
  });
  assert.equal(delivered.order.status, 'completed');

  const expressAfterSale = await request(base, '/api/storefront/orders/order_test_1/after-sale', {
    method: 'POST',
    body: JSON.stringify({
      buyerPhone: '18800000000',
      reason: '已领取后售后'
    })
  });
  assert.equal(expressAfterSale.order.status, 'after_sale');
  assert.equal(expressAfterSale.order.afterSaleInfo.status, 'requested');

  const latestBootstrap = await request(base, '/api/bootstrap');
  assert.ok(latestBootstrap.stats.pendingPaymentCount >= 0);
  assert.ok(latestBootstrap.stats.awaitingPickupCount >= 0);
  assert.ok(Array.isArray(latestBootstrap.stats.topProducts));
  assert.ok(latestBootstrap.orderBusinessStats.totalOrders >= 1);
  assert.ok(latestBootstrap.operationLogs.some((log) => log.action === 'order.status'));

  const orderStats = await request(base, '/api/order-stats');
  assert.ok(orderStats.orderBusinessStats.expressSent.count >= 1);
  assert.ok(orderStats.orderBusinessStats.pickupSent.count >= 1);

  const printerStatus = await request(base, '/api/printer/status');
  assert.equal(printerStatus.printer.configured, false);
  const printerMissingOrder = await fetch(`${base}/api/orders/order_not_found/print-label`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(printerMissingOrder.status, 404);
  await assert.rejects(
    request(base, '/api/printer/add', { method: 'POST', body: JSON.stringify({}) }),
    /未配置芯烨云打印参数/
  );
  await assert.rejects(
    request(base, '/api/printer/cloud-status'),
    /未配置芯烨云打印参数/
  );
  await assert.rejects(
    request(base, '/api/orders/order_test_1/print-label', { method: 'POST', body: JSON.stringify({}) }),
    /未配置芯烨云打印参数/
  );

  const exportResponse = await fetch(`${base}/api/orders/export.csv?status=all&deliveryType=all`);
  assert.equal(exportResponse.status, 200);
  const csvText = await exportResponse.text();
  assert.match(csvText, /订单编号/);
  assert.match(csvText, /销售类型/);
  assert.match(csvText, /下单时间/);
  assert.match(csvText, /接口创建桃|网页后台测试桃/);

  const xlsxExportResponse = await fetch(`${base}/api/orders/export.xlsx?status=all&deliveryType=all&saleType=all`);
  assert.equal(xlsxExportResponse.status, 200);
  assert.match(xlsxExportResponse.headers.get('content-disposition') || '', /peach-orders-.*\.xlsx/);
  const xlsxExportBuffer = Buffer.from(await xlsxExportResponse.arrayBuffer());
  assert.equal(xlsxExportBuffer.subarray(0, 2).toString('utf8'), 'PK');

  const expressTemplateResponse = await fetch(`${base}/api/orders/import-express-template.xlsx`);
  assert.equal(expressTemplateResponse.status, 200);
  assert.match(expressTemplateResponse.headers.get('content-disposition') || '', /peach-express-shipment-template\.xlsx/);
  const expressTemplateBuffer = Buffer.from(await expressTemplateResponse.arrayBuffer());
  const expressTemplateImport = await request(base, '/api/orders/import-express-shipments', {
    method: 'POST',
    body: JSON.stringify({
      filename: 'peach-express-shipment-template.xlsx',
      contentBase64: expressTemplateBuffer.toString('base64')
    })
  });
  assert.equal(expressTemplateImport.result.total, 1);
  assert.equal(expressTemplateImport.result.unmatched[0].orderId, '177912345678901234');

  const pickupTemplateResponse = await fetch(`${base}/api/orders/import-pickup-template.xlsx`);
  assert.equal(pickupTemplateResponse.status, 200);
  assert.match(pickupTemplateResponse.headers.get('content-disposition') || '', /peach-pickup-shipment-template\.xlsx/);
  const pickupTemplateBuffer = Buffer.from(await pickupTemplateResponse.arrayBuffer());
  const pickupTemplateImport = await request(base, '/api/orders/import-pickup-shipments', {
    method: 'POST',
    body: JSON.stringify({
      filename: 'peach-pickup-shipment-template.xlsx',
      contentBase64: pickupTemplateBuffer.toString('base64')
    })
  });
  assert.equal(pickupTemplateImport.result.total, 1);
  assert.equal(pickupTemplateImport.result.unmatched[0].orderId, '177912345678901234');

  const addressDeleted = await request(base, `/api/storefront/addresses/${encodeURIComponent(addressSaved.address.id)}?phone=18800000001`, {
    method: 'DELETE'
  });
  assert.equal(addressDeleted.ok, true);

  await new Promise((resolve) => server.close(resolve));

  await runAuthRequiredSmokeTest();
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.rmSync(tempUploadDir, { recursive: true, force: true }); } catch (_) {}
  console.log('网页后台 SQLite/API 校验通过');
})().catch(async (error) => {
  try { await new Promise((resolve) => server.close(resolve)); } catch (_) {}
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.rmSync(tempUploadDir, { recursive: true, force: true }); } catch (_) {}
  console.error(error);
  process.exit(1);
});

function runAuthRequiredSmokeTest() {
  const authDb = path.join(os.tmpdir(), `peach-admin-auth-${Date.now()}.sqlite`);
  const authUploadDir = path.join(os.tmpdir(), `peach-admin-auth-uploads-${Date.now()}`);
  try { fs.unlinkSync(authDb); } catch (_) {}
  const code = `
    const assert = require('node:assert/strict');
    process.env.PEACH_DB_PATH = ${JSON.stringify(authDb)};
    process.env.PEACH_UPLOAD_DIR = ${JSON.stringify(authUploadDir)};
    process.env.PEACH_ADMIN_USERNAME = 'admin-user';
    process.env.PEACH_ADMIN_PASSWORD = 'secret-pass';
    const db = require('./admin-web/db');
    const { server } = require('./admin-web/server');
    db.initDb();
    server.listen(0, async () => {
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        let res = await fetch(base + '/api/bootstrap');
        assert.equal(res.status, 401);
        res = await fetch(base + '/api/uploads', { method: 'POST' });
        assert.equal(res.status, 401);
        res = await fetch(base + '/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'wrong-user', password: 'secret-pass' })
        });
        assert.equal(res.status, 401);
        res = await fetch(base + '/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'admin-user', password: 'secret-pass' })
        });
        assert.equal(res.status, 200);
        const cookie = res.headers.get('set-cookie');
        assert.ok(cookie && cookie.includes('peach_admin_session='));
        res = await fetch(base + '/api/bootstrap', { headers: { cookie } });
        assert.equal(res.status, 200);
        server.close(() => process.exit(0));
      } catch (error) {
        console.error(error);
        server.close(() => process.exit(1));
      }
    });
  `;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', code], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (codeNumber) => {
      try { fs.unlinkSync(authDb); } catch (_) {}
      try { fs.rmSync(authUploadDir, { recursive: true, force: true }); } catch (_) {}
      if (codeNumber === 0) resolve();
      else reject(new Error(stderr || `auth smoke test exited ${codeNumber}`));
    });
  });
}
