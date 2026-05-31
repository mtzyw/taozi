const EXPRESS_COMPANY_CODES = {
  顺丰: 'SF',
  顺丰速运: 'SF',
  申通: 'STO',
  申通快递: 'STO',
  圆通: 'YTO',
  圆通速递: 'YTO',
  中通: 'ZTO',
  中通快递: 'ZTO',
  韵达: 'YUNDA',
  韵达快递: 'YUNDA',
  EMS: 'EMS',
  ems: 'EMS',
  中国邮政: 'EMS',
  邮政: 'EMS',
  京东: 'JD',
  京东物流: 'JD',
  德邦: 'DBL',
  德邦快递: 'DBL',
  极兔: 'JTSD',
  极兔速递: 'JTSD',
  百世: 'HTKY',
  百世快递: 'HTKY',
  菜鸟: 'CAINIAO',
  丹鸟: 'DANNIAO'
};

function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getConfig() {
  const payEnabled = boolEnv(process.env.WECHAT_PAY_ENABLED, false);
  return {
    enabled: boolEnv(process.env.WECHAT_SHIPPING_ENABLED, payEnabled),
    mchid: process.env.WECHAT_SHIPPING_MCH_ID || process.env.WECHAT_PAY_MCH_ID || '',
    apiBase: process.env.WECHAT_SHIPPING_API_BASE || 'https://api.weixin.qq.com',
    expressCompanyMap: process.env.WECHAT_SHIPPING_EXPRESS_COMPANY_MAP || ''
  };
}

function configStatus() {
  const config = getConfig();
  const missing = [];
  if (!config.mchid) missing.push('WECHAT_SHIPPING_MCH_ID/WECHAT_PAY_MCH_ID');
  return {
    enabled: config.enabled,
    configured: missing.length === 0,
    missing
  };
}

function isEnabled() {
  return getConfig().enabled;
}

function truncateByChars(text, maxChars) {
  const value = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function formatWechatRfc3339(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number, size = 2) => String(number).padStart(size, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
}

function parseExpressCompanyMap(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function normalizeExpressCompanyCode(company) {
  const raw = String(company || '').trim();
  if (!raw) return '';
  const customMap = parseExpressCompanyMap(getConfig().expressCompanyMap);
  if (customMap[raw]) return String(customMap[raw]).trim();
  if (EXPRESS_COMPANY_CODES[raw]) return EXPRESS_COMPANY_CODES[raw];
  const upper = raw.toUpperCase();
  if (EXPRESS_COMPANY_CODES[upper]) return EXPRESS_COMPANY_CODES[upper];
  if (/^[A-Z0-9_-]{2,32}$/.test(upper)) return upper;
  return raw;
}

function maskPhoneForShipping(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^1\d{10}$/.test(digits)) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return truncateByChars(phone, 32);
}

function buildItemDesc(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const parts = items.slice(0, 3).map((item) => {
    const name = item.productName || item.product_name || '商品';
    const sku = item.skuName || item.packageLabel || item.sku_name || item.package_label || '';
    const quantity = Math.max(1, Number(item.quantity || 1));
    return `${name}${sku ? `｜${sku}` : ''}×${quantity}`;
  });
  const suffix = items.length > 3 ? `等${items.length}件` : '';
  return truncateByChars(`${parts.join('；')}${suffix}`, 120) || '桃子订单';
}

function buildShippingPayload(order = {}, uploadTime = new Date()) {
  const config = getConfig();
  if (!config.mchid) throw new Error('未配置微信发货商户号');
  if (!order || !order.id) throw new Error('订单不存在，无法同步微信发货');
  const openid = String(order.wechatOpenid || order.openid || '').trim();
  if (!openid) throw new Error('订单缺少微信 openid，无法同步微信发货');
  const deliveryType = String(order.deliveryType || order.delivery_type || '').trim();
  const itemDesc = buildItemDesc(order);
  const payload = {
    order_key: {
      order_number_type: 1,
      mchid: config.mchid,
      out_trade_no: String(order.id)
    },
    delivery_mode: 1,
    is_all_delivered: true,
    upload_time: formatWechatRfc3339(uploadTime),
    payer: { openid },
    logistics_type: deliveryType === 'express' ? 1 : 4,
    shipping_list: []
  };
  if (deliveryType === 'express') {
    const shipment = order.expressShipment || {};
    const trackingNo = String(shipment.trackingNo || order.trackingNo || order.tracking_no || '').trim();
    const expressCompany = normalizeExpressCompanyCode(shipment.company || order.expressCompany || order.express_company || '');
    if (!trackingNo) throw new Error('快递订单缺少快递单号，无法同步微信发货');
    if (!expressCompany) throw new Error('快递订单缺少快递公司，无法同步微信发货');
    payload.shipping_list.push({
      tracking_no: trackingNo,
      express_company: expressCompany,
      item_desc: itemDesc,
      contact: {
        receiver_contact: maskPhoneForShipping(order.contactPhone || order.buyerPhone || (order.expressInfo && order.expressInfo.phone) || '')
      }
    });
  } else if (deliveryType === 'pickup') {
    payload.shipping_list.push({
      item_desc: truncateByChars(`${itemDesc}｜${order.pickupPointName || '用户自提'}`, 120)
    });
  } else {
    throw new Error('仅支持同步快递订单或自提订单到微信发货');
  }
  return payload;
}

function buildOrderKeyPayload(order = {}) {
  const config = getConfig();
  if (!config.mchid) throw new Error('未配置微信发货商户号');
  if (!order || !order.id) throw new Error('订单不存在，无法查询微信订单');
  return {
    merchant_id: config.mchid,
    merchant_trade_no: String(order.id)
  };
}

function buildOrderConfirmExtraData(order = {}) {
  const payload = buildOrderKeyPayload(order);
  return {
    merchant_id: payload.merchant_id,
    merchant_trade_no: payload.merchant_trade_no
  };
}

async function uploadShippingInfo({ accessToken, order }) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('缺少微信 access_token，无法同步微信发货');
  const payload = buildShippingPayload(order);
  const url = `${getConfig().apiBase}/wxa/sec/order/upload_shipping_info?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
  }
  if (!response.ok || Number(data.errcode || 0) !== 0) {
    const error = new Error(data.errmsg || data.message || data.raw || `微信发货同步失败：HTTP ${response.status}`);
    error.payload = payload;
    error.response = data;
    throw error;
  }
  return {
    payload,
    response: data,
    uploadedAt: payload.upload_time
  };
}

async function getOrder({ accessToken, order }) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('缺少微信 access_token，无法查询微信订单');
  const payload = buildOrderKeyPayload(order);
  const url = `${getConfig().apiBase}/wxa/sec/order/get_order?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
  }
  if (!response.ok || Number(data.errcode || 0) !== 0) {
    const error = new Error(data.errmsg || data.message || data.raw || `微信订单查询失败：HTTP ${response.status}`);
    error.payload = payload;
    error.response = data;
    throw error;
  }
  return {
    payload,
    response: data,
    order: data.order || null,
    orderState: Number(data.order && data.order.order_state || 0)
  };
}

module.exports = {
  configStatus,
  isEnabled,
  normalizeExpressCompanyCode,
  buildOrderConfirmExtraData,
  buildShippingPayload,
  uploadShippingInfo,
  getOrder
};
