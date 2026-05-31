const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const db = require('./db');
const xpyun = require('./xpyun');
const wechatPay = require('./wechat-pay');
const wechatShipping = require('./wechat-shipping');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MINI_ROOT = path.join(__dirname, '..', 'miniprogram');
const UPLOAD_DIR = process.env.PEACH_UPLOAD_DIR || path.join(__dirname, 'uploads');
const SESSION_COOKIE = 'peach_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_USERNAME = process.env.PEACH_ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.PEACH_ADMIN_PASSWORD || '';
const sessions = new Map();
const pickupStaffSessions = new Map();
const WECHAT_APPID = process.env.WECHAT_APPID || process.env.WX_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || process.env.WECHAT_SECRET || '';
const TENCENT_MAP_KEY = process.env.TENCENT_MAP_KEY || process.env.QQ_MAP_KEY || '';
const TENCENT_MAP_SK = process.env.TENCENT_MAP_SK || process.env.QQ_MAP_SK || '';
const wechatSessions = new Map();
let wechatAccessTokenCache = { token: '', expiresAt: 0 };
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-credentials': 'true',
    ...extraHeaders
  });
}

function sendText(res, body, contentTypeValue, filename = '') {
  const headers = {
    'content-type': `${contentTypeValue}; charset=utf-8`,
    'cache-control': 'no-store'
  };
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
  send(res, 200, body, headers);
}

function sendBuffer(res, body, contentTypeValue, filename = '') {
  const headers = {
    'content-type': contentTypeValue,
    'cache-control': 'no-store'
  };
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
  send(res, 200, body, headers);
}

function sendError(res, status, message) {
  sendJson(res, { error: message }, status);
}

async function printOrderLabelWithLog(order, trigger = 'manual') {
  if (!order || !order.id) throw new Error('订单不存在，无法打印');
  try {
    const safeOrderId = String(order.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || Date.now();
    const idempotent = trigger.includes('manual')
      ? `manual_${safeOrderId}_${Date.now()}`.slice(0, 50)
      : `auto_${safeOrderId}`.slice(0, 50);
    const result = await xpyun.printOrderLabel(order, { idempotent });
    const printNo = result && (result.data || result.printId || result.orderId || result.id || '');
    db.addOperationLog({
      action: 'printer.order_label',
      targetType: 'order',
      targetId: order.id,
      detail: JSON.stringify({ trigger, ok: true, printNo, response: result })
    });
    return { ok: true, printNo, result };
  } catch (error) {
    db.addOperationLog({
      action: 'printer.order_label_failed',
      targetType: 'order',
      targetId: order.id,
      detail: JSON.stringify({ trigger, ok: false, error: error.message })
    });
    throw error;
  }
}

function autoPrintPaidOrder(order, trigger = 'auto') {
  if (!order || !order.id || order.status === 'awaiting_payment') return;
  const printerStatus = xpyun.configStatus();
  if (!printerStatus.configured || !printerStatus.autoPrint) return;
  printOrderLabelWithLog(order, trigger).catch(() => {});
}

function canSyncWechatShipping(order) {
  if (!order || !order.id || order.status === 'awaiting_payment') return false;
  if (order.deliveryType === 'express') return order.status === 'shipped' && order.expressShipment && order.expressShipment.trackingNo;
  if (order.deliveryType === 'pickup') {
    return ['pickup_shipped', 'picked_up', 'completed', 'after_sale', 'refunded'].includes(order.status)
      && Boolean(order.pickupArrivedAt || order.shippedAt || order.pickedUpAt);
  }
  return false;
}

function receiptTargetStatus(order) {
  if (!order || !order.id) return '';
  if (order.deliveryType === 'express') {
    return ['shipped', 'completed'].includes(order.status) ? 'completed' : '';
  }
  if (order.deliveryType === 'pickup') {
    return ['pickup_shipped', 'picked_up'].includes(order.status) ? 'picked_up' : '';
  }
  return '';
}

function isWechatReceiptConfirmed(order) {
  return Boolean(order && order.wechatReceipt && order.wechatReceipt.confirmedAt);
}

function canOpenWechatOrderConfirm(order) {
  if (!order || !receiptTargetStatus(order)) return false;
  if (isWechatReceiptConfirmed(order)) return false;
  return order.wechatShipping && order.wechatShipping.status === 'success';
}

function withStorefrontOrderCapabilities(order) {
  if (!order || !order.id) return order;
  const configStatus = wechatShipping.configStatus();
  const enabled = configStatus.enabled && configStatus.configured;
  const available = enabled && canOpenWechatOrderConfirm(order);
  const reason = !enabled
    ? '微信订单确认配置未启用'
    : (isWechatReceiptConfirmed(order)
        ? '微信侧已确认收货'
        : (!receiptTargetStatus(order)
            ? '当前订单状态不需要确认收货'
            : (!order.wechatShipping || order.wechatShipping.status !== 'success'
                ? '微信发货信息同步成功后才能确认收货'
                : '')));
  return {
    ...order,
    wechatOrderConfirm: {
      available,
      reason: available ? '' : reason,
      businessType: 'weappOrderConfirm',
      buttonText: order.deliveryType === 'pickup' ? '确认已领取' : '确认收货',
      extraData: available ? wechatShipping.buildOrderConfirmExtraData(order) : null
    }
  };
}

function publicWechatShippingSyncResult(result) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    status: result.status || '',
    reason: result.reason || '',
    error: result.error || ''
  };
}

function publicWechatRefundResult(result) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    mode: result.mode || '',
    status: result.status || '',
    outRefundNo: result.outRefundNo || '',
    refundId: result.refundId || '',
    message: result.message || '',
    error: result.error || ''
  };
}

function attachWechatOpenidFallback(order) {
  if (!order || order.wechatOpenid) return order;
  const openid = db.findWechatOpenidByPhone(order.buyerPhone || order.contactPhone);
  if (!openid) return order;
  return db.updateOrderWechatOpenid(order.id, openid) || order;
}

async function processOrderRefund(orderId, body = {}) {
  const order = db.getOrder(orderId);
  if (!order) throw new Error('订单不存在');
  const refundAmount = Math.round(Number(body.refundAmountCents ?? body.refundAmount ?? 0));
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效退款金额');
  if (refundAmount > Math.round(Number(order.payAmount || 0))) throw new Error('退款金额不能大于订单实付金额');
  const refundNote = String(body.refundNote ?? body.reason ?? body.detail ?? '').trim();

  if (!wechatPay.isEnabled()) {
    return {
      order: db.updateOrderStatus(orderId, {
        ...body,
        status: 'refunded',
        refundAmount,
        refundNote,
        reason: refundNote,
        detail: refundNote || '退款处理'
      }),
      wechatRefund: { ok: true, mode: 'local', status: 'LOCAL_REFUNDED', message: '本地模拟退款已完成' }
    };
  }

  const payStatus = wechatPay.configStatus();
  if (!payStatus.configured) {
    throw new Error(`微信支付配置不完整：${payStatus.missing.join('、')}`);
  }
  const outRefundNo = order.wechatRefund && order.wechatRefund.outRefundNo
    ? order.wechatRefund.outRefundNo
    : wechatPay.buildRefundNo(order.id);

  db.markWechatRefundRequested(order.id, {
    outRefundNo,
    status: 'PENDING_SUBMIT',
    refundAmount,
    refundNote,
    action: 'wechat_refund_submitting',
    detail: '正在提交微信原路退款'
  });

  try {
    const refund = await wechatPay.createRefund({
      order,
      refundAmountCents: refundAmount,
      reason: refundNote || '订单售后退款',
      outRefundNo
    });
    db.markWechatRefundRequested(order.id, {
      outRefundNo: refund.outRefundNo,
      refundId: refund.refundId,
      status: refund.status || 'PROCESSING',
      response: refund.response,
      refundAmount,
      refundNote,
      allowExistingRefundUpdate: true,
      action: 'wechat_refund_requested',
      detail: '微信原路退款已提交，等待微信退款结果'
    });
    const normalizedStatus = String(refund.status || '').toUpperCase();
    let updatedOrder = db.getOrder(order.id);
    if (normalizedStatus === 'SUCCESS') {
      updatedOrder = db.completeWechatRefund(order.id, {
          outRefundNo: refund.outRefundNo,
          refundId: refund.refundId,
          status: normalizedStatus,
          response: refund.response,
          refundAmount,
          refundNote,
          action: 'wechat_refund_success',
          detail: '微信原路退款成功'
        });
    } else if (['ABNORMAL', 'CLOSED', 'FAILED'].includes(normalizedStatus)) {
      updatedOrder = db.markWechatRefundFailed(order.id, {
        outRefundNo: refund.outRefundNo,
        refundId: refund.refundId,
        status: normalizedStatus,
        response: refund.response,
        error: normalizedStatus === 'CLOSED' ? '微信退款已关闭' : '微信退款状态异常',
        action: 'wechat_refund_failed'
      });
    }
    return {
      order: updatedOrder,
      wechatRefund: {
        ok: true,
        mode: 'wechat',
        status: normalizedStatus || 'PROCESSING',
        outRefundNo: refund.outRefundNo,
        refundId: refund.refundId,
        message: normalizedStatus === 'SUCCESS' ? '微信退款成功' : '微信退款已提交，等待微信回调确认'
      }
    };
  } catch (error) {
    db.markWechatRefundFailed(order.id, {
      status: 'SUBMIT_FAILED',
      error: error.message,
      action: 'wechat_refund_submit_failed'
    });
    throw error;
  }
}

async function confirmWechatReceiptForOrder(orderId, payload = {}) {
  let order = db.getOrder(orderId);
  if (!order) return { confirmed: false, error: '订单不存在' };
  const targetStatus = receiptTargetStatus(order);
  if (!targetStatus) {
    return {
      confirmed: isWechatReceiptConfirmed(order),
      skipped: true,
      message: isWechatReceiptConfirmed(order) ? '微信侧已确认收货' : '当前订单状态不能确认收货',
      order: withStorefrontOrderCapabilities(order)
    };
  }
  if (isWechatReceiptConfirmed(order)) {
    return {
      confirmed: true,
      skipped: true,
      message: '微信侧已确认收货',
      order: withStorefrontOrderCapabilities(order)
    };
  }

  const session = getWechatSession(payload.sessionId);
  if (!session || !session.openid) throw new Error('请先完成微信登录后再确认收货');
  order = attachWechatOpenidFallback(order);
  if (order.wechatOpenid && order.wechatOpenid !== session.openid) {
    throw new Error('当前微信账号与订单支付账号不一致，不能确认该订单');
  }

  const configStatus = wechatShipping.configStatus();
  if (!configStatus.enabled) throw new Error('微信订单确认未启用');
  if (!configStatus.configured) {
    throw new Error(`微信订单确认配置不完整：${configStatus.missing.join('、')}`);
  }
  if (!order.wechatShipping || order.wechatShipping.status !== 'success') {
    throw new Error('该订单还没有成功同步微信发货信息，暂不能确认收货');
  }

  const accessToken = await getWechatAccessToken();
  const wechatOrder = await wechatShipping.getOrder({ accessToken, order });
  const confirmedStates = [3, 4, 6];
  if (!confirmedStates.includes(Number(wechatOrder.orderState || 0))) {
    return {
      confirmed: false,
      wechatOrderState: wechatOrder.orderState,
      message: '微信侧尚未完成确认收货，请在弹出的微信确认收货组件中完成确认。',
      order: withStorefrontOrderCapabilities(order)
    };
  }

  const detail = order.deliveryType === 'pickup'
    ? '用户通过微信确认收货组件确认已领取'
    : '用户通过微信确认收货组件确认收货';
  db.markWechatReceiptConfirmed(order.id, {
    orderState: wechatOrder.orderState,
    response: wechatOrder.response
  });
  const updated = order.status === targetStatus
    ? db.getOrder(order.id)
    : db.updateOrderStatus(order.id, {
        status: targetStatus,
        action: 'wechat_receipt_confirmed',
        detail
      });
  db.addOperationLog({
    action: 'wechat_receipt.confirmed',
    targetType: 'order',
    targetId: order.id,
    detail: JSON.stringify({ orderState: wechatOrder.orderState })
  });
  return {
    confirmed: true,
    wechatOrderState: wechatOrder.orderState,
    order: withStorefrontOrderCapabilities(updated)
  };
}

async function syncWechatShippingForOrder(orderOrId, trigger = 'manual') {
  let order = typeof orderOrId === 'string' ? db.getOrder(orderOrId) : orderOrId;
  if (!order || !order.id) return { ok: false, skipped: true, reason: '订单不存在' };
  const configStatus = wechatShipping.configStatus();
  if (!configStatus.enabled) return { ok: true, skipped: true, reason: '微信发货同步未启用' };
  if (!configStatus.configured) {
    return { ok: false, skipped: true, reason: `微信发货配置不完整：${configStatus.missing.join('、')}` };
  }
  order = attachWechatOpenidFallback(order);
  if (!canSyncWechatShipping(order)) {
    return { ok: true, skipped: true, reason: '当前订单状态暂不需要同步微信发货' };
  }
  if (order.wechatShipping && order.wechatShipping.status === 'success') {
    return { ok: true, skipped: true, reason: '已同步微信发货' };
  }
  try {
    const accessToken = await getWechatAccessToken();
    const result = await wechatShipping.uploadShippingInfo({ accessToken, order });
    db.markWechatShippingSync(order.id, {
      status: 'success',
      logisticsType: result.payload.logistics_type,
      payload: result.payload,
      response: result.response,
      syncedAt: result.uploadedAt
    });
    db.addOperationLog({
      action: 'wechat_shipping.sync_success',
      targetType: 'order',
      targetId: order.id,
      detail: JSON.stringify({ trigger, logisticsType: result.payload.logistics_type })
    });
    return { ok: true, skipped: false, status: 'success' };
  } catch (error) {
    db.markWechatShippingSync(order.id, {
      status: 'failed',
      logisticsType: order.deliveryType === 'express' ? 1 : 4,
      payload: error.payload || null,
      response: error.response || null,
      error: error.message
    });
    db.addOperationLog({
      action: 'wechat_shipping.sync_failed',
      targetType: 'order',
      targetId: order.id,
      detail: JSON.stringify({ trigger, error: error.message })
    });
    return { ok: false, skipped: false, status: 'failed', error: error.message };
  }
}

async function syncWechatShippingForMatchedOrders(result, trigger) {
  if (!result || !Array.isArray(result.matched)) return result;
  for (const item of result.matched) {
    item.wechatShipping = publicWechatShippingSyncResult(await syncWechatShippingForOrder(item.orderId, trigger));
  }
  return result;
}

function hasWechatConfig() {
  return Boolean(WECHAT_APPID && WECHAT_SECRET);
}

function createWechatSession(openid) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  wechatSessions.set(sessionId, {
    openid,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sessionId;
}

function getWechatSession(sessionId) {
  const session = wechatSessions.get(String(sessionId || ''));
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    wechatSessions.delete(String(sessionId || ''));
    return null;
  }
  return session;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.errmsg || data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeWechatLoginCode(code) {
  const jsCode = String(code || '').trim();
  if (!jsCode) throw new Error('微信登录 code 不能为空');
  if (!hasWechatConfig()) {
    return {
      openid: `dev_${crypto.createHash('sha1').update(jsCode).digest('hex').slice(0, 24)}`,
      unionid: '',
      mock: true
    };
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', WECHAT_APPID);
  url.searchParams.set('secret', WECHAT_SECRET);
  url.searchParams.set('js_code', jsCode);
  url.searchParams.set('grant_type', 'authorization_code');
  const data = await fetchJson(url.toString());
  if (data.errcode) throw new Error(data.errmsg || '微信登录失败');
  if (!data.openid) throw new Error('微信登录未返回 openid');
  return {
    openid: data.openid,
    unionid: data.unionid || '',
    mock: false
  };
}

async function getWechatAccessToken() {
  if (!hasWechatConfig()) throw new Error('服务器未配置微信 AppID/AppSecret');
  if (wechatAccessTokenCache.token && wechatAccessTokenCache.expiresAt > Date.now() + 60 * 1000) {
    return wechatAccessTokenCache.token;
  }
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', WECHAT_APPID);
  url.searchParams.set('secret', WECHAT_SECRET);
  const data = await fetchJson(url.toString());
  if (data.errcode) throw new Error(data.errmsg || '获取微信 access_token 失败');
  if (!data.access_token) throw new Error('微信未返回 access_token');
  wechatAccessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 7200) - 300) * 1000
  };
  return data.access_token;
}

async function exchangeWechatPhoneCode(code) {
  const phoneCode = String(code || '').trim();
  if (!phoneCode) throw new Error('手机号授权 code 不能为空');
  const accessToken = await getWechatAccessToken();
  const url = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: phoneCode })
  });
  if (data.errcode) throw new Error(data.errmsg || '微信手机号授权失败');
  const phoneInfo = data.phone_info || {};
  const phoneNumber = String(phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(phoneNumber)) throw new Error('微信未返回有效手机号');
  return {
    phoneNumber,
    purePhoneNumber: String(phoneInfo.purePhoneNumber || phoneNumber).replace(/\D/g, ''),
    countryCode: phoneInfo.countryCode || '86'
  };
}

function makeTencentMapUrl(pathname, params) {
  const search = new URLSearchParams(params);
  if (TENCENT_MAP_SK) {
    const rawQuery = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const raw = `${pathname}?${rawQuery}${TENCENT_MAP_SK}`;
    search.set('sig', crypto.createHash('md5').update(raw).digest('hex'));
  }
  const url = new URL(`https://apis.map.qq.com${pathname}`);
  url.search = search.toString();
  return url;
}

function normalizeTencentMapAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return raw;
  if (/^(四川省)?成都市/.test(raw)) return raw;
  if (/^(四川省|重庆市|北京市|上海市|天津市|[^省]+省|[^区]+自治区|[^市]+市)/.test(raw)) return raw;
  return `四川省成都市${raw}`;
}

async function geocodePickupPointIfNeeded(payload = {}) {
  const hasLatitude = payload.latitude !== undefined && payload.latitude !== '';
  const hasLongitude = payload.longitude !== undefined && payload.longitude !== '';
  if ((hasLatitude && hasLongitude) || !TENCENT_MAP_KEY || !payload.address) return payload;
  const url = makeTencentMapUrl('/ws/geocoder/v1/', {
    address: normalizeTencentMapAddress(payload.address),
    key: TENCENT_MAP_KEY
  });
  const data = await fetchJson(url.toString()).catch(() => null);
  const location = data && data.status === 0 && data.result && data.result.location;
  if (!location) return payload;
  return {
    ...payload,
    latitude: location.lat,
    longitude: location.lng
  };
}

function safeJoin(root, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^([/\\])+/, '');
  const fullPath = path.join(root, normalized);
  if (!fullPath.startsWith(root)) return null;
  return fullPath;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
  };
  return types[ext] || 'application/octet-stream';
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, index));
      const value = decodeURIComponent(part.slice(index + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function makeCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function isAuthRequired() {
  return Boolean(ADMIN_PASSWORD);
}

function safeUsernameEquals(input) {
  if (!ADMIN_USERNAME) return true;
  const inputBuffer = Buffer.from(String(input || ''));
  const expectedBuffer = Buffer.from(ADMIN_USERNAME);
  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function safePasswordEquals(input) {
  const inputBuffer = Buffer.from(String(input || ''));
  const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function createPickupStaffSession(pickupPointId) {
  const token = crypto.randomBytes(24).toString('hex');
  pickupStaffSessions.set(token, {
    pickupPointId,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getPickupStaffSession(sessionId) {
  const token = String(sessionId || '').trim();
  const session = pickupStaffSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    pickupStaffSessions.delete(token);
    return null;
  }
  return session;
}

function isAuthenticated(req) {
  if (!isAuthRequired()) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function clearSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
}

function isPublicApi(pathname) {
  return pathname.startsWith('/api/storefront/')
    || pathname === '/api/session'
    || pathname === '/api/login'
    || pathname === '/api/logout';
}

function normalizeIdList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,，;；]+/);
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function productDeliveryMethods(payload = {}) {
  const packageTypes = productPackageTypes(payload);
  const rawMethods = Array.isArray(payload.deliveryMethods)
    ? payload.deliveryMethods
    : [payload.deliveryPickup ? 'pickup' : '', payload.deliveryExpress ? 'express' : ''];
  const methods = rawMethods.filter((type) => type === 'pickup' || type === 'express');
  if (packageTypes.includes('bag') && !methods.includes('pickup')) methods.unshift('pickup');
  if (packageTypes.length === 1 && packageTypes[0] === 'bag') return ['pickup'];
  if (methods.length) return [...new Set(methods)];
  return ['pickup'];
}

function productPackageTypes(payload = {}) {
  if (Array.isArray(payload.packageTypes)) return normalizeIdList(payload.packageTypes).filter((type) => type === 'box' || type === 'bag');
  const types = [];
  if (payload.packageBox) types.push('box');
  if (payload.packageBag) types.push('bag');
  if (types.length) return types;
  if (Array.isArray(payload.skus)) {
    return [...new Set(payload.skus.map((sku) => sku.packageType || sku.package_type).filter((type) => type === 'box' || type === 'bag'))];
  }
  return [];
}

function packageTypeLabel(type) {
  return type === 'box' ? '盒装' : '袋装';
}

function normalizeSaleType(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'direct' || text === '直售' || text === '现货' || text === 'spot' ? 'direct' : 'presale';
}

function saleTypeText(value) {
  return normalizeSaleType(value) === 'direct' ? '直售' : '预售';
}

function validateProductPackageTypes(payload = {}) {
  const packageTypes = productPackageTypes(payload);
  if (!packageTypes.length) throw new Error('至少选择一种包装');
}

function parseAdminDateTime(value, dateOnlyEndOfDay = false) {
  const text = String(value || '').trim();
  if (!text) return null;
  const hasTime = /[T ]\d{1,2}:\d{2}/.test(text);
  const normalized = text.includes('T')
    ? text
    : hasTime
      ? text.replace(/\s+/, 'T')
      : `${text}T${dateOnlyEndOfDay ? '23:59:59' : '00:00:00'}`;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function validateProductSchedule(payload = {}) {
  if (normalizeSaleType(payload.saleType ?? payload.sale_type) === 'direct') return;
  const shipStartText = String(payload.shipStart ?? payload.ship_start ?? '').trim();
  const shipEndText = String(payload.shipEnd ?? payload.ship_end ?? '').trim();
  const orderDeadlineText = String(payload.orderDeadline ?? payload.order_deadline ?? '').trim();
  if (!orderDeadlineText || !shipStartText || !shipEndText) {
    throw new Error('请完整填写截单时间、履约开始、履约结束');
  }

  const shipStart = parseAdminDateTime(shipStartText);
  const shipEnd = parseAdminDateTime(shipEndText);
  const orderDeadline = parseAdminDateTime(orderDeadlineText);

  if (Number.isNaN(shipStart)) throw new Error('履约开始时间格式不正确');
  if (Number.isNaN(shipEnd)) throw new Error('履约结束时间格式不正确');
  if (Number.isNaN(orderDeadline)) throw new Error('截单时间格式不正确');
  if (shipStart && shipEnd && shipEnd <= shipStart) throw new Error('履约结束时间必须大于履约开始时间');
  if (orderDeadline && shipStart && orderDeadline >= shipStart) throw new Error('截单时间必须小于履约开始时间');
}

function inputCents(value, isYuan = false) {
  if (value === undefined || value === null || value === '') return 0;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.round(numberValue * (isYuan ? 100 : 1)));
}

function payloadPriceCents(payload = {}, centsKeys = [], yuanKeys = []) {
  for (const key of centsKeys) {
    const cents = inputCents(payload[key]);
    if (cents > 0) return cents;
  }
  for (const key of yuanKeys) {
    const cents = inputCents(payload[key], true);
    if (cents > 0) return cents;
  }
  return 0;
}

function skuPriceCents(sku = {}) {
  return payloadPriceCents(
    sku,
    ['salePriceCents', 'sale_price_cents', 'salePrice', 'sale_price', 'priceCents', 'price_cents', 'price'],
    ['salePriceYuan', 'sale_price_yuan', 'priceYuan', 'price_yuan']
  );
}

function validateProductPrices(payload = {}) {
  const packageTypes = productPackageTypes(payload);
  const skus = Array.isArray(payload.skus) ? payload.skus : [];
  const fallbackPrice = payloadPriceCents(
    payload,
    ['salePriceCents', 'sale_price_cents', 'priceCents', 'price_cents'],
    ['salePriceYuan', 'sale_price_yuan', 'priceYuan', 'price_yuan']
  );
  const missingLabels = [];
  packageTypes.forEach((type) => {
    const sku = skus.find((item) => (item.packageType || item.package_type) === type);
    const price = sku
      ? skuPriceCents(sku)
      : payloadPriceCents(
        payload,
        type === 'box'
          ? ['boxSalePriceCents', 'box_sale_price_cents', 'boxPriceCents', 'box_price_cents']
          : ['bagSalePriceCents', 'bag_sale_price_cents', 'bagPriceCents', 'bag_price_cents'],
        type === 'box'
          ? ['boxSalePriceYuan', 'box_sale_price_yuan', 'boxPriceYuan', 'box_price_yuan']
          : ['bagSalePriceYuan', 'bag_sale_price_yuan', 'bagPriceYuan', 'bag_price_yuan']
      ) || fallbackPrice;
    if (price <= 0) missingLabels.push(packageTypeLabel(type));
  });
  if (missingLabels.length) throw new Error(`${missingLabels.join('、')}价格必须大于 0`);
}

function skuStockValue(sku = {}) {
  if (sku.stock !== undefined && sku.stock !== '') return Number(sku.stock);
  if (sku.stockCount !== undefined && sku.stockCount !== '') return Number(sku.stockCount);
  if (sku.stock_count !== undefined && sku.stock_count !== '') return Number(sku.stock_count);
  return 0;
}

function validateProductStock(payload = {}) {
  const packageTypes = productPackageTypes(payload);
  const skus = Array.isArray(payload.skus) ? payload.skus : [];
  const missingLabels = [];
  packageTypes.forEach((type) => {
    const sku = skus.find((item) => (item.packageType || item.package_type) === type);
    const stock = sku
      ? skuStockValue(sku)
      : Number(type === 'box' ? payload.boxStock ?? payload.box_stock ?? 0 : payload.bagStock ?? payload.bag_stock ?? 0);
    if (!Number.isFinite(stock) || stock <= 0) missingLabels.push(packageTypeLabel(type));
  });
  if (missingLabels.length) throw new Error(`${missingLabels.join('、')}库存必须大于 0`);
}

function validateProductPickupSelection(payload = {}) {
  if (!productDeliveryMethods(payload).includes('pickup')) return;
  const selectedPickupIds = normalizeIdList(payload.pickupPointIds || payload.pickup_point_ids || payload.pickupPointIdsText);
  const pickupPoints = db.listPickupPoints().filter((point) => point.enabled);
  if (pickupPoints.length > 0 && !selectedPickupIds.length) {
    throw new Error('请选择该商品适用的自提点');
  }
  const packageTypes = productPackageTypes(payload);
  const selectedIdSet = new Set(selectedPickupIds.map(String));
  const incompatiblePoints = pickupPoints.filter((point) => {
    if (!selectedIdSet.has(String(point.id))) return false;
    const pointPackageTypes = normalizeIdList(point.packageTypes);
    return pointPackageTypes.length && !pointPackageTypes.some((type) => packageTypes.includes(type));
  });
  if (incompatiblePoints.length) {
    throw new Error(`以下自提点不支持当前商品包装（${packageTypes.map(packageTypeLabel).join('/')}）：${incompatiblePoints.map((point) => point.name).join('、')}`);
  }
}

function validateProductPickupValidity(payload = {}) {
  if (!productDeliveryMethods(payload).includes('pickup')) return;
  const hours = Number(payload.pickupValidHours ?? payload.pickup_valid_hours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('请填写自提有效期时长');
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendError(res, 404, 'Not found');
      return;
    }
    send(res, 200, buffer, { 'content-type': contentType(filePath) });
  });
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('图片不能超过 5MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getMultipartBoundary(req) {
  const contentTypeHeader = String(req.headers['content-type'] || '');
  const matched = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return matched ? matched[1] || matched[2] : '';
}

function parseMultipartImage(req, bodyBuffer) {
  const boundaryValue = getMultipartBoundary(req);
  if (!boundaryValue) throw new Error('上传请求格式错误');
  const raw = bodyBuffer.toString('latin1');
  const boundary = `--${boundaryValue}`;
  const parts = raw.split(boundary).slice(1, -1);
  for (const part of parts) {
    const normalizedPart = part.startsWith('\r\n') ? part.slice(2) : part;
    const separatorIndex = normalizedPart.indexOf('\r\n\r\n');
    if (separatorIndex === -1) continue;
    const headersText = normalizedPart.slice(0, separatorIndex);
    let fileText = normalizedPart.slice(separatorIndex + 4);
    if (fileText.endsWith('\r\n')) fileText = fileText.slice(0, -2);
    const disposition = headersText.match(/content-disposition:[^\r\n]+/i);
    if (!disposition || !/name="file"/i.test(disposition[0]) || !/filename="/i.test(disposition[0])) continue;
    const filename = (disposition[0].match(/filename="([^"]*)"/i) || [])[1] || 'upload';
    const mimeType = (headersText.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || '';
    return {
      filename,
      mimeType: mimeType.trim().toLowerCase(),
      buffer: Buffer.from(fileText, 'latin1')
    };
  }
  throw new Error('请选择要上传的图片');
}

function detectImageExt(buffer, mimeType) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return '';
}

async function saveUploadedImage(req) {
  const body = await readRawBody(req);
  const file = parseMultipartImage(req, body);
  if (!file.buffer.length) throw new Error('图片内容为空');
  const ext = detectImageExt(file.buffer, file.mimeType);
  if (!ext) throw new Error('仅支持 PNG、JPG、WEBP 图片');
  const basename = `product-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filepath = path.join(UPLOAD_DIR, basename);
  fs.writeFileSync(filepath, file.buffer);
  return {
    url: `/uploads/${basename}`,
    filename: basename,
    originalName: path.basename(file.filename),
    mimeType: IMAGE_MIME_BY_EXT[ext],
    size: file.buffer.length
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function displayDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

function orderExportRows(orders) {
  const header = ['批次名称', '销售类型', '订单联系人', '手机号', '订单编号', '配送方式', '自提点/快递地址', '订单状态', '履约开始', '履约截止', '商品', '规格', '数量', '实付元', '快递公司', '快递单号', '下单时间', '付款时间'];
  const rows = orders.map((order) => {
    const item = (order.items || [])[0] || {};
    const shipment = order.expressShipment || {};
    return [
      order.batchName || item.batchName || '',
      saleTypeText(order.saleType || item.saleType),
      order.contactName || '',
      order.contactPhone || order.buyerPhone,
      order.id,
      order.deliveryType === 'express' ? '快递' : '自提',
      order.destinationText || order.pickupPointName || (order.expressInfo && order.expressInfo.address) || '',
      order.statusText || order.status,
      order.fulfillmentStart || '',
      order.fulfillmentEnd || '',
      item.productName || '',
      item.skuName || item.packageLabel || '',
      item.quantity || 1,
      db.centsToYuan(order.payAmount),
      shipment.company || '',
      shipment.trackingNo || '',
      displayDateTime(order.createdAt),
      displayDateTime(order.paidAt)
    ];
  });
  return [header, ...rows];
}

function ordersToCsv(orders) {
  return `\uFEFF${orderExportRows(orders).map((row) => row.map(csvCell).join(',')).join('\n')}`;
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  }[char]));
}

function xmlUnescape(value) {
  return String(value ?? '').replace(/&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-f]+);/gi, (entity, name) => {
    const normalized = String(name || '').toLowerCase();
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'amp') return '&';
    if (normalized === 'apos') return "'";
    if (normalized === 'quot') return '"';
    if (normalized.startsWith('#x')) return String.fromCharCode(parseInt(normalized.slice(2), 16));
    if (normalized.startsWith('#')) return String.fromCharCode(parseInt(normalized.slice(1), 10));
    return entity;
  });
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function zipFiles(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = zipDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sheetXml(rows, options = {}) {
  const colWidths = [16, 14, 16, 22, 10, 28, 14, 24, 16, 8, 12, 14, 18, 22];
  const textColumns = new Set(options.textColumns || []);
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : textColumns.has(colIndex) ? ' s="2"' : '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${colWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>
  <sheetData>${sheetRows}</sheetData>
  <autoFilter ref="A1:${columnName(rows[0].length - 1)}${Math.max(1, rows.length)}"/>
</worksheet>`;
}

function safeSheetName(sheetName) {
  return String(sheetName || 'Sheet1').replace(/[\[\]*?:/\\]/g, '').slice(0, 31) || 'Sheet1';
}

function rowsToXlsxBuffer(rows, sheetName = 'Sheet1', options = {}) {
  const name = safeSheetName(sheetName);
  const now = new Date().toISOString();
  return zipFiles([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`
    },
    {
      name: 'docProps/core.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Peach Admin</dc:creator>
  <cp:lastModifiedBy>Peach Admin</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
    },
    {
      name: 'docProps/app.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Peach Admin</Application>
</Properties>`
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    {
      name: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`
    },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml(rows, options) }
  ]);
}

function ordersToXlsxBuffer(orders) {
  return rowsToXlsxBuffer(orderExportRows(orders), '订单筛选结果');
}

function supplyOrdersToXlsxBuffer(orders) {
  return rowsToXlsxBuffer(orderExportRows(orders), '供货单');
}

function statsBucketLabel(bucket) {
  return {
    completed1: '已完成1',
    completed2: '已完成2',
    expressSent: '已发快递',
    pickupSent: '已发自提',
    refunded: '退款',
    all: '全部统计'
  }[bucket] || bucket || '全部统计';
}

function statsBucketOrders(bucket, filters = {}) {
  const orders = db.listOrders(filters);
  if (!bucket || bucket === 'all') return orders;
  const stats = db.orderBusinessStats(filters);
  const bucketStats = stats[bucket] || {};
  const ids = new Set(bucketStats.orderIds || []);
  return orders.filter((order) => ids.has(order.id));
}

function statsOrdersToXlsxBuffer(orders, bucket) {
  return rowsToXlsxBuffer(orderExportRows(orders), `统计-${statsBucketLabel(bucket)}`);
}

function shipmentTemplateRows(type) {
  return type === 'express'
    ? [
      ['订单编号', '快递公司', '快递单号', '备注（选填）'],
      ['177912345678901234', '顺丰速运', 'SF123456789', '示例行：导入前请替换成真实订单信息']
    ]
    : [
      ['订单编号', '备注'],
      ['177912345678901234', '示例行：已贴单并交给自提点，导入前请替换成真实订单信息']
    ];
}

function shipmentTemplateCsv(type) {
  const rows = shipmentTemplateRows(type);
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`;
}

function shipmentTemplateXlsxBuffer(type) {
  return rowsToXlsxBuffer(
    shipmentTemplateRows(type),
    type === 'express' ? '快递发货模板' : '自提发货模板',
    { textColumns: type === 'express' ? [0, 2] : [0] }
  );
}

function whitelistTemplateXlsxBuffer() {
  return rowsToXlsxBuffer([
    ['手机号'],
    ['18048123692'],
    ['18800000001']
  ], '白名单导入模板');
}

function extractPhonesFromText(text) {
  const phones = [];
  const addPhone = (value) => {
    const phone = String(value || '').replace(/\D/g, '');
    if (/^1\d{10}$/.test(phone)) phones.push(phone);
  };
  const value = String(text || '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0　]/g, ' ');
  (value.match(/1\d{10}/g) || []).forEach(addPhone);
  (value.match(/1(?:[\d\s\-–—_,，、.·]){10,28}/g) || []).forEach((item) => {
    const phone = String(item || '').replace(/\D/g, '');
    if (phone.length === 11) addPhone(phone);
  });
  (value.match(/\b1(?:\.\d+)?e\+?10\b/gi) || []).forEach((item) => {
    const phone = String(Math.round(Number(item)));
    addPhone(phone);
  });
  (value.match(/\d{11,}/g) || []).forEach((item) => {
    for (let index = 0; index + 11 <= item.length; index += 11) addPhone(item.slice(index, index + 11));
  });
  return [...new Set(phones.filter((phone) => /^1\d{10}$/.test(phone)))];
}

function findZipEnd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function unzipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('Excel 文件格式不正确');
  const endOffset = findZipEnd(buffer);
  if (endOffset < 0) throw new Error('Excel 文件格式不正确');
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = {};
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      centralOffset += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries[name] = compressed;
    else if (method === 8) entries[name] = zlib.inflateRawSync(compressed);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractPhonesFromXlsx(buffer) {
  const entries = unzipEntries(buffer);
  const xmlParts = Object.entries(entries)
    .filter(([name]) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/.+\.xml$/i.test(name))
    .map(([, content]) => content.toString('utf8'));
  let rowText = '';
  try {
    rowText = extractRowsFromXlsx(buffer).flat().join('\n');
  } catch (_) {
    rowText = '';
  }
  return extractPhonesFromText(`${rowText}\n${xmlParts.join('\n')}`);
}

function xmlTextContent(xml) {
  return [...String(xml || '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => xmlUnescape(match[1]))
    .join('');
}

function parseXlsxSharedStrings(entries) {
  const xml = entries['xl/sharedStrings.xml'];
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => xmlTextContent(match[1]));
}

function cellColumnIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/i);
  if (!letters) return -1;
  return letters[0].toUpperCase().split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(cellAttrs, cellXml, sharedStrings) {
  const type = ((cellAttrs || '').match(/\bt="([^"]+)"/) || [])[1] || '';
  if (type === 'inlineStr') return xmlTextContent(cellXml);
  const rawValue = ((cellXml || '').match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '';
  if (type === 's') return sharedStrings[Number(rawValue)] || '';
  if (type === 'b') return rawValue === '1' ? 'TRUE' : 'FALSE';
  return xmlUnescape(rawValue);
}

function extractRowsFromXlsx(buffer) {
  const entries = unzipEntries(buffer);
  const sharedStrings = parseXlsxSharedStrings(entries);
  const sheetEntry = entries['xl/worksheets/sheet1.xml']
    ? ['xl/worksheets/sheet1.xml', entries['xl/worksheets/sheet1.xml']]
    : Object.entries(entries).find(([name]) => /^xl\/worksheets\/.+\.xml$/i.test(name));
  if (!sheetEntry) throw new Error('Excel 文件里没有找到工作表');
  const sheetXmlText = sheetEntry[1].toString('utf8');
  const rows = [];
  for (const rowMatch of sheetXmlText.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] || '';
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || '';
      const colIndex = cellColumnIndex(ref);
      if (colIndex < 0) continue;
      cells[colIndex] = cellValue(attrs, cellMatch[2], sharedStrings).trim();
    }
    while (cells.length && !String(cells[cells.length - 1] || '').trim()) cells.pop();
    if (cells.some((cell) => String(cell || '').trim())) rows.push(cells.map((cell) => String(cell || '').trim()));
  }
  return rows;
}

function splitImportLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if ((char === ',' || char === '\t') && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function shipmentRowsFromTableRows(rows, type) {
  const tableRows = (rows || [])
    .map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell || '').trim()))
    .filter((row) => row.some(Boolean));
  if (!tableRows.length) return [];
  const first = tableRows[0];
  const headerLike = first.some((cell) => /订单|order|快递|物流|运单|公司|备注|贴单/i.test(cell));
  const headers = headerLike ? first : [];
  const dataRows = headerLike ? tableRows.slice(1) : tableRows;
  return dataRows.map((cells) => {
    if (headers.length) {
      return headers.reduce((row, header, index) => {
        row[header] = cells[index] || '';
        return row;
      }, {});
    }
    return type === 'express'
      ? { orderId: cells[0] || '', company: cells[1] || '', trackingNo: cells[2] || '' }
      : { orderId: cells[0] || '', detail: cells.slice(1).join(' ') || '导入自提发货信息' };
  });
}

function parseShipmentRowsFromText(text, type) {
  const rows = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(splitImportLine);
  return shipmentRowsFromTableRows(rows, type);
}

function shipmentRowsFromUpload(body = {}, type) {
  if (Array.isArray(body.rows)) return body.rows;
  const filename = String(body.filename || '').toLowerCase();
  const base64 = String(body.contentBase64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return [];
  const buffer = Buffer.from(base64, 'base64');
  const isXlsx = filename.endsWith('.xlsx') || buffer.subarray(0, 2).toString('utf8') === 'PK';
  return isXlsx
    ? shipmentRowsFromTableRows(extractRowsFromXlsx(buffer), type)
    : parseShipmentRowsFromText(buffer.toString('utf8'), type);
}

function extractWhitelistPhonesFromUpload(body = {}) {
  const filename = String(body.filename || '').toLowerCase();
  if (body.text) return extractPhonesFromText(body.text);
  const base64 = String(body.contentBase64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return [];
  const buffer = Buffer.from(base64, 'base64');
  const isXlsx = filename.endsWith('.xlsx') || buffer.subarray(0, 2).toString('utf8') === 'PK';
  return isXlsx ? extractPhonesFromXlsx(buffer) : extractPhonesFromText(buffer.toString('utf8'));
}

function orderFiltersFromUrl(url) {
  return {
    buyerPhone: url.searchParams.get('phone') || '',
    status: url.searchParams.get('status') || 'all',
    deliveryType: url.searchParams.get('deliveryType') || 'all',
    saleType: url.searchParams.get('saleType') || 'all',
    batchName: url.searchParams.get('batchName') || '',
    destination: url.searchParams.get('destination') || '',
    fulfillmentStart: url.searchParams.get('fulfillmentStart') || '',
    fulfillmentEnd: url.searchParams.get('fulfillmentEnd') || '',
    keyword: url.searchParams.get('keyword') || '',
    excludeAwaitingPayment: url.searchParams.get('excludeAwaitingPayment') === '1'
  };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    sendJson(res, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/session') {
    sendJson(res, {
      authRequired: isAuthRequired(),
      usernameRequired: Boolean(ADMIN_USERNAME),
      authenticated: isAuthenticated(req)
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    if (!isAuthRequired()) {
      sendJson(res, { authRequired: false, authenticated: true });
      return;
    }
    if (!safeUsernameEquals(body.username) || !safePasswordEquals(body.password)) {
      sendError(res, 401, '管理员账号或密码错误');
      return;
    }
    const token = createSession();
    sendJson(res, {
      authRequired: true,
      usernameRequired: Boolean(ADMIN_USERNAME),
      authenticated: true
    }, 200, { 'set-cookie': makeCookie(token, Math.floor(SESSION_TTL_MS / 1000)) });
    return;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    clearSession(req);
    sendJson(res, {
      authRequired: isAuthRequired(),
      authenticated: !isAuthRequired()
    }, 200, { 'set-cookie': makeCookie('', 0) });
    return;
  }

  if (!isPublicApi(pathname) && !isAuthenticated(req)) {
    sendError(res, 401, '请先登录管理员后台');
    return;
  }

  if (method === 'POST' && pathname === '/api/uploads') {
    sendJson(res, { file: await saveUploadedImage(req) }, 201);
    return;
  }

  if (method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(res, db.bootstrap());
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/bootstrap') {
    sendJson(res, {
      products: db.listProducts(),
      pickupPoints: db.listPickupPoints().filter((point) => point.enabled),
      shippingRule: db.getShippingRule()
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/wechat-login') {
    const body = await readBody(req);
    const auth = await exchangeWechatLoginCode(body.code);
    const user = db.upsertWechatUser(auth);
    const sessionId = createWechatSession(auth.openid);
    sendJson(res, {
      session: {
        sessionId,
        openid: auth.mock ? auth.openid : '',
        unionid: auth.unionid || '',
        phone: user && user.phone || '',
        mock: Boolean(auth.mock)
      }
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/wechat-phone') {
    const body = await readBody(req);
    const phoneInfo = await exchangeWechatPhoneCode(body.code);
    const session = getWechatSession(body.sessionId);
    if (session && session.openid) db.bindWechatUserPhone(session.openid, phoneInfo.phoneNumber);
    sendJson(res, { phoneInfo });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/products') {
    sendJson(res, { products: db.listProducts() });
    return;
  }

  const storefrontProductMatch = pathname.match(/^\/api\/storefront\/products\/([^/]+)$/);
  if (storefrontProductMatch && method === 'GET') {
    const product = db.getProduct(decodeURIComponent(storefrontProductMatch[1]));
    if (!product) {
      sendError(res, 404, '商品不存在');
      return;
    }
    sendJson(res, { product });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/pickup-points') {
    sendJson(res, { pickupPoints: db.listPickupPoints().filter((point) => point.enabled) });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/pickup-staff/login') {
    const body = await readBody(req);
    const pickupPoint = db.authenticatePickupPoint(body.account, body.password);
    if (!pickupPoint) {
      sendError(res, 401, '自提点账号或密码错误');
      return;
    }
    const sessionId = createPickupStaffSession(pickupPoint.id);
    sendJson(res, {
      session: {
        sessionId,
        pickupPoint
      }
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/pickup-staff/lookup') {
    const body = await readBody(req);
    const session = getPickupStaffSession(body.sessionId);
    if (!session) {
      sendError(res, 401, '自提点登录已过期，请重新登录');
      return;
    }
    sendJson(res, {
      result: db.lookupPickupStaffOrder({ ...body, pickupPointId: session.pickupPointId })
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/pickup-staff/confirm') {
    const body = await readBody(req);
    const session = getPickupStaffSession(body.sessionId);
    if (!session) {
      sendError(res, 401, '自提点登录已过期，请重新登录');
      return;
    }
    const result = db.confirmPickupStaffOrder({ ...body, pickupPointId: session.pickupPointId });
    if (result.order && result.status === 'picked') {
      db.addOperationLog({ action: 'order.pickup.staff_verify', targetType: 'order', targetId: result.order.id, detail: result.message });
    }
    sendJson(res, { result });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/shipping-rule') {
    sendJson(res, { shippingRule: db.getShippingRule() });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/whitelist-discount') {
    sendJson(res, {
      discount: db.getWhitelistDiscount(url.searchParams.get('phone'), url.searchParams.get('productId') || '')
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/quote') {
    const body = await readBody(req);
    sendJson(res, { quote: db.quoteStorefrontOrder(body) });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/addresses') {
    sendJson(res, { addresses: db.listAddresses(url.searchParams.get('phone')) });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/addresses') {
    const body = await readBody(req);
    const address = db.upsertAddress(body);
    sendJson(res, { address, addresses: db.listAddresses(body.buyerPhone || body.ownerPhone) }, 201);
    return;
  }

  const storefrontAddressMatch = pathname.match(/^\/api\/storefront\/addresses\/([^/]+)$/);
  if (storefrontAddressMatch && method === 'DELETE') {
    sendJson(res, {
      ok: db.deleteAddress(decodeURIComponent(storefrontAddressMatch[1]), url.searchParams.get('phone') || '')
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/storefront/orders') {
    sendJson(res, {
      orders: db.listOrders({
        buyerPhone: url.searchParams.get('phone') || '',
        status: url.searchParams.get('status') || 'all',
        deliveryType: url.searchParams.get('deliveryType') || 'all',
        keyword: url.searchParams.get('keyword') || ''
      })
    });
    return;
  }

  const storefrontOrderMatch = pathname.match(/^\/api\/storefront\/orders\/([^/]+)$/);
  if (storefrontOrderMatch && method === 'GET') {
    const order = db.getOrder(decodeURIComponent(storefrontOrderMatch[1]));
    if (!order) {
      sendError(res, 404, '订单不存在');
      return;
    }
    sendJson(res, { order: withStorefrontOrderCapabilities(order) });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/orders') {
    const body = await readBody(req);
    const requestedOrderId = String(body.id || '').trim();
    const existingOrder = requestedOrderId ? db.getOrder(requestedOrderId) : null;
    const order = db.createStorefrontOrder(body);
    if (!existingOrder) {
      autoPrintPaidOrder(order, 'storefront.create');
    }
    sendJson(res, { order }, 201);
    return;
  }

  const storefrontAfterSaleMatch = pathname.match(/^\/api\/storefront\/orders\/([^/]+)\/after-sale$/);
  if (storefrontAfterSaleMatch && method === 'POST') {
    const body = await readBody(req);
    sendJson(res, {
      order: db.requestAfterSale({ ...body, orderId: decodeURIComponent(storefrontAfterSaleMatch[1]) })
    });
    return;
  }

  const storefrontConfirmReceiptMatch = pathname.match(/^\/api\/storefront\/orders\/([^/]+)\/wechat-receipt-confirm$/);
  if (storefrontConfirmReceiptMatch && method === 'POST') {
    const body = await readBody(req);
    const result = await confirmWechatReceiptForOrder(decodeURIComponent(storefrontConfirmReceiptMatch[1]), body);
    sendJson(res, result);
    return;
  }

  const storefrontPayMatch = pathname.match(/^\/api\/storefront\/orders\/([^/]+)\/pay$/);
  if (storefrontPayMatch && method === 'POST') {
    const body = await readBody(req);
    const orderId = decodeURIComponent(storefrontPayMatch[1]);
    const beforeOrder = db.getOrder(orderId);
    if (!beforeOrder) {
      sendError(res, 404, '订单不存在');
      return;
    }
    if (wechatPay.isEnabled()) {
      const payStatus = wechatPay.configStatus();
      if (!payStatus.configured) {
        sendError(res, 500, `微信支付配置不完整：${payStatus.missing.join('、')}`);
        return;
      }
      if (beforeOrder.status !== 'awaiting_payment') {
        sendJson(res, { order: beforeOrder, paymentMode: 'already_paid' });
        return;
      }
      const session = getWechatSession(body.sessionId);
      if (!session || !session.openid) {
        sendError(res, 401, '请先完成微信登录后再支付');
        return;
      }
      const orderForPayment = db.updateOrderWechatOpenid(orderId, session.openid) || beforeOrder;
      const payment = await wechatPay.createJsapiPayment({ order: orderForPayment, openid: session.openid });
      db.addOperationLog({ action: 'wechat_pay.prepay', targetType: 'order', targetId: orderId, detail: payment.prepayId });
      sendJson(res, { order: orderForPayment, payment: payment.params, paymentMode: 'wechat' });
      return;
    }
    const order = db.payOrder(orderId);
    if (beforeOrder.status === 'awaiting_payment') {
      autoPrintPaidOrder(order, 'storefront.pay');
    }
    sendJson(res, { order, paymentMode: 'mock' });
    return;
  }

  const storefrontPayConfirmMatch = pathname.match(/^\/api\/storefront\/orders\/([^/]+)\/pay-confirm$/);
  if (storefrontPayConfirmMatch && method === 'POST') {
    const orderId = decodeURIComponent(storefrontPayConfirmMatch[1]);
    const beforeOrder = db.getOrder(orderId);
    if (!beforeOrder) {
      sendError(res, 404, '订单不存在');
      return;
    }
    if (!wechatPay.isEnabled() || wechatPay.configStatus().clientConfirm) {
      const order = db.payOrder(orderId, { action: wechatPay.isEnabled() ? 'wechat_client_confirmed' : 'mock_paid', detail: '客户端确认支付成功' });
      if (beforeOrder.status === 'awaiting_payment') autoPrintPaidOrder(order, 'storefront.pay_confirm');
      sendJson(res, { order, confirmed: true });
      return;
    }
    sendJson(res, { order: beforeOrder, confirmed: false, message: '正式支付以微信支付通知为准' });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/wechat-pay/notify') {
    const rawBody = await readRawBody(req, 64 * 1024);
    const rawText = rawBody.toString('utf8');
    wechatPay.verifyNotifySignature(req.headers, rawText);
    const body = rawText ? JSON.parse(rawText) : {};
    const transaction = wechatPay.parsePaymentNotify(body);
    const outTradeNo = String(transaction.out_trade_no || '').trim();
    if (!outTradeNo) throw new Error('微信支付通知缺少商户订单号');
    if (String(transaction.trade_state || '').toUpperCase() === 'SUCCESS') {
      const beforeOrder = db.getOrder(outTradeNo);
      const order = db.payOrder(outTradeNo, {
        action: 'wechat_paid',
        detail: `微信支付成功${transaction.transaction_id ? `：${transaction.transaction_id}` : ''}`,
        wechatOpenid: transaction.payer && transaction.payer.openid || '',
        wechatTransactionId: transaction.transaction_id || ''
      });
      db.addOperationLog({ action: 'wechat_pay.notify_success', targetType: 'order', targetId: outTradeNo, detail: JSON.stringify({ transactionId: transaction.transaction_id || '', tradeState: transaction.trade_state || '' }) });
      if (beforeOrder && beforeOrder.status === 'awaiting_payment') autoPrintPaidOrder(order, 'wechat.notify');
    } else {
      db.addOperationLog({ action: 'wechat_pay.notify_ignored', targetType: 'order', targetId: outTradeNo, detail: JSON.stringify({ tradeState: transaction.trade_state || '' }) });
    }
    sendJson(res, { code: 'SUCCESS', message: '成功' });
    return;
  }

  if (method === 'POST' && pathname === '/api/storefront/wechat-pay/refund-notify') {
    const rawBody = await readRawBody(req, 64 * 1024);
    const rawText = rawBody.toString('utf8');
    wechatPay.verifyNotifySignature(req.headers, rawText);
    const body = rawText ? JSON.parse(rawText) : {};
    const refund = wechatPay.parseRefundNotify(body);
    const outTradeNo = String(refund.out_trade_no || '').trim();
    if (!outTradeNo) throw new Error('微信退款通知缺少商户订单号');
    const refundStatus = String(refund.refund_status || refund.status || '').toUpperCase();
    const refundAmount = refund.amount && Number(refund.amount.refund || 0) || 0;
    if (refundStatus === 'SUCCESS') {
      db.completeWechatRefund(outTradeNo, {
        outRefundNo: refund.out_refund_no || '',
        refundId: refund.refund_id || '',
        status: refundStatus,
        response: refund,
        ...(refundAmount > 0 ? { refundAmount } : {}),
        action: 'wechat_refund_notify_success',
        detail: '微信退款回调确认成功'
      });
      db.addOperationLog({ action: 'wechat_refund.notify_success', targetType: 'order', targetId: outTradeNo, detail: JSON.stringify({ refundId: refund.refund_id || '', outRefundNo: refund.out_refund_no || '' }) });
    } else if (['ABNORMAL', 'CLOSED', 'FAILED'].includes(refundStatus)) {
      db.markWechatRefundFailed(outTradeNo, {
        refundId: refund.refund_id || '',
        status: refundStatus,
        response: refund,
        error: refundStatus === 'CLOSED' ? '微信退款已关闭' : '微信退款状态异常',
        action: 'wechat_refund_notify_failed'
      });
      db.addOperationLog({ action: 'wechat_refund.notify_failed', targetType: 'order', targetId: outTradeNo, detail: JSON.stringify({ refundStatus, refundId: refund.refund_id || '' }) });
    } else {
      db.addOperationLog({ action: 'wechat_refund.notify_ignored', targetType: 'order', targetId: outTradeNo, detail: JSON.stringify({ refundStatus, refundId: refund.refund_id || '' }) });
    }
    sendJson(res, { code: 'SUCCESS', message: '成功' });
    return;
  }

  if (method === 'GET' && pathname === '/api/products') {
    sendJson(res, { products: db.listProducts() });
    return;
  }

  if (method === 'POST' && pathname === '/api/products') {
    const body = await readBody(req);
    if (!body.name) throw new Error('商品名称不能为空');
    validateProductPackageTypes(body);
    validateProductPrices(body);
    validateProductStock(body);
    validateProductSchedule(body);
    validateProductPickupSelection(body);
    validateProductPickupValidity(body);
    const product = db.upsertProduct(body);
    db.addOperationLog({ action: 'product.create', targetType: 'product', targetId: product.id, detail: product.name });
    sendJson(res, { product }, 201);
    return;
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && method === 'PUT') {
    const body = await readBody(req);
    if (!body.name) throw new Error('商品名称不能为空');
    validateProductPackageTypes(body);
    validateProductPrices(body);
    validateProductStock(body);
    validateProductSchedule(body);
    validateProductPickupSelection(body);
    validateProductPickupValidity(body);
    const product = db.upsertProduct({ ...body, id: decodeURIComponent(productMatch[1]) });
    db.addOperationLog({ action: 'product.update', targetType: 'product', targetId: product.id, detail: product.name });
    sendJson(res, { product });
    return;
  }
  if (productMatch && method === 'DELETE') {
    const productId = decodeURIComponent(productMatch[1]);
    const ok = db.deleteProduct(productId);
    db.addOperationLog({ action: 'product.delete', targetType: 'product', targetId: productId });
    sendJson(res, { ok });
    return;
  }

  const productStatusMatch = pathname.match(/^\/api\/products\/([^/]+)\/status$/);
  if (productStatusMatch && method === 'POST') {
    const body = await readBody(req);
    const product = db.updateProductStatus(decodeURIComponent(productStatusMatch[1]), body.status);
    db.addOperationLog({ action: 'product.status', targetType: 'product', targetId: productStatusMatch[1], detail: body.status });
    sendJson(res, { product });
    return;
  }

  const productSkuStockMatch = pathname.match(/^\/api\/products\/([^/]+)\/skus\/([^/]+)\/stock$/);
  if (productSkuStockMatch && method === 'POST') {
    const body = await readBody(req);
    const productId = decodeURIComponent(productSkuStockMatch[1]);
    const skuId = decodeURIComponent(productSkuStockMatch[2]);
    const product = db.updateProductSkuStock(productId, skuId, body);
    db.addOperationLog({
      action: body.mode === 'add' ? 'product.stock.restock' : 'product.stock.set',
      targetType: 'product',
      targetId: productId,
      detail: `${skuId} ${body.mode === 'add' ? '补货' : '设为'} ${body.quantity ?? body.stock ?? body.delta ?? 0}`
    });
    sendJson(res, { product });
    return;
  }

  if (method === 'POST' && pathname === '/api/pickup-points') {
    const body = await readBody(req);
    if (!body.name || !body.address) throw new Error('自提点名称和地址不能为空');
    sendJson(res, { pickupPoint: db.upsertPickupPoint(await geocodePickupPointIfNeeded(body)) }, 201);
    return;
  }

  const pickupMatch = pathname.match(/^\/api\/pickup-points\/([^/]+)$/);
  if (pickupMatch && method === 'PUT') {
    const body = await readBody(req);
    if (!body.name || !body.address) throw new Error('自提点名称和地址不能为空');
    sendJson(res, { pickupPoint: db.upsertPickupPoint(await geocodePickupPointIfNeeded({ ...body, id: decodeURIComponent(pickupMatch[1]) })) });
    return;
  }
  if (pickupMatch && method === 'DELETE') {
    sendJson(res, { ok: db.deletePickupPoint(decodeURIComponent(pickupMatch[1])) });
    return;
  }

  const pickupToggleMatch = pathname.match(/^\/api\/pickup-points\/([^/]+)\/toggle$/);
  if (pickupToggleMatch && method === 'POST') {
    const body = await readBody(req);
    sendJson(res, { pickupPoint: db.togglePickupPoint(decodeURIComponent(pickupToggleMatch[1]), Boolean(body.enabled)) });
    return;
  }

  if (method === 'PUT' && pathname === '/api/shipping-rule') {
    const body = await readBody(req);
    sendJson(res, { shippingRule: db.saveShippingRule(body) });
    return;
  }

  if (method === 'GET' && pathname === '/api/whitelist') {
    sendJson(res, { whitelistEntries: db.listWhitelistEntries() });
    return;
  }

  if (method === 'GET' && pathname === '/api/whitelist/template.xlsx') {
    sendBuffer(
      res,
      whitelistTemplateXlsxBuffer(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'peach-whitelist-template.xlsx'
    );
    return;
  }

  if (method === 'POST' && pathname === '/api/whitelist/import-file') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const phones = extractWhitelistPhonesFromUpload(body);
    if (!phones.length) throw new Error('文件里没有识别到有效手机号');
    sendJson(res, { phones, count: phones.length });
    return;
  }

  if (method === 'POST' && pathname === '/api/whitelist') {
    const body = await readBody(req);
    if (!Array.isArray(body.productIds) || !body.productIds.filter(Boolean).length) {
      throw new Error('请选择白名单适用商品');
    }
    if (body.phonesText) {
      const whitelistEntries = db.importWhitelistEntries(body.phonesText, body.discountPercent, body.label, body.productIds || []);
      db.addOperationLog({ action: 'whitelist.import', targetType: 'whitelist', detail: body.label || '批量导入' });
      sendJson(res, {
        whitelistEntries
      }, 201);
      return;
    }
    const phone = db.upsertWhitelistEntry(body);
    if (!phone) throw new Error('请输入有效手机号');
    db.addOperationLog({ action: 'whitelist.upsert', targetType: 'whitelist', targetId: phone });
    sendJson(res, { whitelistEntries: db.listWhitelistEntries() }, 201);
    return;
  }

  const whitelistRuleMatch = pathname.match(/^\/api\/whitelist\/([^/]+)\/rules\/([^/]+)$/);
  if (whitelistRuleMatch && method === 'DELETE') {
    const phone = decodeURIComponent(whitelistRuleMatch[1]);
    const ruleId = decodeURIComponent(whitelistRuleMatch[2]);
    const ok = db.deleteWhitelistRule(phone, ruleId);
    db.addOperationLog({ action: 'whitelist.rule.delete', targetType: 'whitelist', targetId: `${phone}:${ruleId}` });
    sendJson(res, { ok, whitelistEntries: db.listWhitelistEntries() });
    return;
  }

  const whitelistMatch = pathname.match(/^\/api\/whitelist\/([^/]+)$/);
  if (whitelistMatch && method === 'DELETE') {
    const phone = decodeURIComponent(whitelistMatch[1]);
    const ok = db.deleteWhitelistEntry(phone);
    db.addOperationLog({ action: 'whitelist.delete', targetType: 'whitelist', targetId: phone });
    sendJson(res, { ok });
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/export.csv') {
    const orders = db.listOrders(orderFiltersFromUrl(url));
    sendText(res, ordersToCsv(orders), 'text/csv', `peach-orders-${Date.now()}.csv`);
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/export.xlsx') {
    const orders = db.listOrders(orderFiltersFromUrl(url));
    sendBuffer(
      res,
      ordersToXlsxBuffer(orders),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `peach-orders-${Date.now()}.xlsx`
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/supply.xlsx') {
    const limit = Math.max(1, Number(url.searchParams.get('limit') || 20) || 20);
    const orders = db.listOrders(orderFiltersFromUrl(url)).slice(0, limit);
    sendBuffer(
      res,
      supplyOrdersToXlsxBuffer(orders),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `peach-supply-orders-${Date.now()}.xlsx`
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/import-express-template.csv') {
    sendText(res, shipmentTemplateCsv('express'), 'text/csv', 'peach-express-shipment-template.csv');
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/import-express-template.xlsx') {
    sendBuffer(
      res,
      shipmentTemplateXlsxBuffer('express'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'peach-express-shipment-template.xlsx'
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/import-pickup-template.csv') {
    sendText(res, shipmentTemplateCsv('pickup'), 'text/csv', 'peach-pickup-shipment-template.csv');
    return;
  }

  if (method === 'GET' && pathname === '/api/orders/import-pickup-template.xlsx') {
    sendBuffer(
      res,
      shipmentTemplateXlsxBuffer('pickup'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'peach-pickup-shipment-template.xlsx'
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/order-stats') {
    sendJson(res, { orderBusinessStats: db.orderBusinessStats(orderFiltersFromUrl(url)) });
    return;
  }

  if (method === 'GET' && pathname === '/api/order-stats/export.xlsx') {
    const bucket = url.searchParams.get('bucket') || 'all';
    const orders = statsBucketOrders(bucket, orderFiltersFromUrl(url));
    sendBuffer(
      res,
      statsOrdersToXlsxBuffer(orders, bucket),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `peach-stats-${bucket}-${Date.now()}.xlsx`
    );
    return;
  }

  if (method === 'POST' && pathname === '/api/orders/import-express-shipments') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const result = db.importExpressShipments(shipmentRowsFromUpload(body, 'express'));
    await syncWechatShippingForMatchedOrders(result, 'import.express');
    db.addOperationLog({
      action: 'order.import.express',
      targetType: 'order',
      detail: `快递导入：匹配 ${result.matched.length}，未匹配 ${result.unmatched.length}，跳过 ${result.skipped.length}`
    });
    sendJson(res, { result, orders: db.listOrders() });
    return;
  }

  if (method === 'POST' && pathname === '/api/orders/import-pickup-shipments') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const result = db.importPickupShipments(shipmentRowsFromUpload(body, 'pickup'));
    await syncWechatShippingForMatchedOrders(result, 'import.pickup');
    db.addOperationLog({
      action: 'order.import.pickup',
      targetType: 'order',
      detail: `自提导入：匹配 ${result.matched.length}，未匹配 ${result.unmatched.length}，跳过 ${result.skipped.length}`
    });
    sendJson(res, { result, orders: db.listOrders() });
    return;
  }

  if (method === 'GET' && pathname === '/api/operation-logs') {
    sendJson(res, { operationLogs: db.listOperationLogs(Number(url.searchParams.get('limit') || 100)) });
    return;
  }

  if (method === 'GET' && pathname === '/api/coupons') {
    sendJson(res, { coupons: db.listCoupons() });
    return;
  }

  if (method === 'POST' && pathname === '/api/coupons') {
    const body = await readBody(req);
    if (!body.code) throw new Error('优惠码不能为空');
    if (!Array.isArray(body.productIds) || !body.productIds.filter(Boolean).length) {
      throw new Error('请选择优惠码适用商品');
    }
    const code = String(body.code || '').trim().toUpperCase();
    const originalCode = String(body.originalCode || '').trim().toUpperCase();
    if (originalCode && originalCode !== code) throw new Error('编辑已有优惠码时不能修改优惠码，请删除后新建');
    if (originalCode && !db.getCoupon(originalCode)) throw new Error('优惠码不存在，请重新选择');
    if (!originalCode && db.getCoupon(code)) throw new Error('优惠码已存在，请重新输入');
    db.upsertCoupon(body);
    db.addOperationLog({ action: 'coupon.upsert', targetType: 'coupon', targetId: body.code });
    sendJson(res, { coupons: db.listCoupons() }, 201);
    return;
  }

  const couponMatch = pathname.match(/^\/api\/coupons\/([^/]+)$/);
  if (couponMatch && method === 'DELETE') {
    const code = decodeURIComponent(couponMatch[1]);
    const ok = db.deleteCoupon(code);
    db.addOperationLog({ action: 'coupon.delete', targetType: 'coupon', targetId: code });
    sendJson(res, { ok, coupons: db.listCoupons() });
    return;
  }

  const couponStatusMatch = pathname.match(/^\/api\/coupons\/([^/]+)\/status$/);
  if (couponStatusMatch && method === 'POST') {
    const body = await readBody(req);
    const code = decodeURIComponent(couponStatusMatch[1]);
    const coupon = db.updateCouponStatus(code, Boolean(body.enabled));
    db.addOperationLog({ action: 'coupon.status', targetType: 'coupon', targetId: code, detail: body.enabled ? '启用' : '停用' });
    sendJson(res, {
      coupon,
      coupons: db.listCoupons()
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/orders/verify-pickup') {
    const body = await readBody(req);
    const order = db.verifyPickupCode(body);
    db.addOperationLog({ action: 'order.pickup.verify', targetType: 'order', targetId: order.id, detail: order.pickupCode });
    sendJson(res, { order });
    return;
  }


  if (method === 'GET' && pathname === '/api/printer/status') {
    sendJson(res, { printer: xpyun.configStatus() });
    return;
  }

  if (method === 'POST' && pathname === '/api/printer/add') {
    const result = await xpyun.addPrinter();
    db.addOperationLog({ action: 'printer.add', targetType: 'printer', targetId: xpyun.configStatus().sn, detail: JSON.stringify(result) });
    sendJson(res, { ok: true, result });
    return;
  }

  if (method === 'GET' && pathname === '/api/printer/cloud-status') {
    sendJson(res, { printer: xpyun.configStatus(), cloud: await xpyun.queryPrinterStatus() });
    return;
  }

  const orderPrintMatch = pathname.match(/^\/api\/orders\/([^/]+)\/print-label$/);
  if (orderPrintMatch && method === 'POST') {
    const orderId = decodeURIComponent(orderPrintMatch[1]);
    const order = db.getOrder(orderId);
    if (!order) {
      sendError(res, 404, '订单不存在');
      return;
    }
    const result = await printOrderLabelWithLog(order, 'admin.manual');
    sendJson(res, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/orders/release-expired') {
    const result = db.releaseExpiredPaymentOrders();
    db.addOperationLog({ action: 'order.release_expired', targetType: 'order', detail: `释放 ${result.releasedCount || 0} 单` });
    sendJson(res, result);
    return;
  }

  const orderPayMatch = pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (orderPayMatch && method === 'POST') {
    const orderId = decodeURIComponent(orderPayMatch[1]);
    const beforeOrder = db.getOrder(orderId);
    const order = db.payOrder(orderId);
    db.addOperationLog({ action: 'order.pay', targetType: 'order', targetId: orderId });
    if (beforeOrder && beforeOrder.status === 'awaiting_payment') {
      autoPrintPaidOrder(order, 'admin.pay');
    }
    sendJson(res, { order });
    return;
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (orderStatusMatch && method === 'POST') {
    const body = await readBody(req);
    const orderId = decodeURIComponent(orderStatusMatch[1]);
    if (body.status === 'refunded') {
      const result = await processOrderRefund(orderId, body);
      db.addOperationLog({ action: 'order.refund', targetType: 'order', targetId: orderId, detail: body.refundNote || body.reason || '' });
      sendJson(res, {
        order: result.order,
        wechatRefund: publicWechatRefundResult(result.wechatRefund)
      });
      return;
    }
    const order = db.updateOrderStatus(orderId, body);
    const wechatShippingResult = (body.status === 'shipped' || body.status === 'pickup_shipped')
      ? await syncWechatShippingForOrder(order, `status.${body.status}`)
      : null;
    db.addOperationLog({ action: 'order.status', targetType: 'order', targetId: orderId, detail: body.status });
    sendJson(res, { order: db.getOrder(orderId), wechatShipping: publicWechatShippingSyncResult(wechatShippingResult) });
    return;
  }

  const orderWechatShippingMatch = pathname.match(/^\/api\/orders\/([^/]+)\/wechat-shipping-sync$/);
  if (orderWechatShippingMatch && method === 'POST') {
    const orderId = decodeURIComponent(orderWechatShippingMatch[1]);
    const result = await syncWechatShippingForOrder(orderId, 'admin.retry');
    sendJson(res, { order: db.getOrder(orderId), wechatShipping: publicWechatShippingSyncResult(result) });
    return;
  }

  sendError(res, 404, 'API not found');
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      const assetPath = safeJoin(MINI_ROOT, url.pathname);
      if (!assetPath) {
        sendError(res, 403, 'Forbidden');
        return;
      }
      serveFile(res, assetPath);
      return;
    }

    if (url.pathname.startsWith('/uploads/')) {
      const uploadPath = safeJoin(UPLOAD_DIR, decodeURIComponent(url.pathname.replace(/^\/uploads\//, '')));
      if (!uploadPath) {
        sendError(res, 403, 'Forbidden');
        return;
      }
      serveFile(res, uploadPath);
      return;
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = safeJoin(PUBLIC_DIR, requestPath);
    if (!filePath) {
      sendError(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, filePath);
  } catch (error) {
    sendError(res, 400, error.message || 'Request failed');
  }
}

const dbPath = db.initDb();
const server = http.createServer(handle);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`桃子预售网页管理后台已启动: http://localhost:${PORT}`);
    console.log(`SQLite 数据库: ${dbPath}`);
  });
}

module.exports = {
  server,
  __test: {
    normalizeTencentMapAddress,
    rowsToXlsxBuffer
  }
};
