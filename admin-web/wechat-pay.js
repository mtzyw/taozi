const crypto = require('crypto');
const fs = require('fs');

const API_BASE = process.env.WECHAT_PAY_API_BASE || 'https://api.mch.weixin.qq.com';

let privateKeyCache = {
  path: '',
  key: '',
  mtimeMs: 0
};

function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getConfig() {
  const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL || '';
  return {
    enabled: boolEnv(process.env.WECHAT_PAY_ENABLED, false),
    appid: process.env.WECHAT_PAY_APPID || process.env.WECHAT_APPID || process.env.WX_APPID || '',
    mchid: process.env.WECHAT_PAY_MCH_ID || '',
    serialNo: process.env.WECHAT_PAY_MCH_SERIAL_NO || '',
    privateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '',
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
    notifyUrl,
    refundNotifyUrl: process.env.WECHAT_PAY_REFUND_NOTIFY_URL || notifyUrl.replace(/\/notify$/, '/refund-notify'),
    platformCertPath: process.env.WECHAT_PAY_PLATFORM_CERT_PATH || process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH || '',
    platformSerialNo: process.env.WECHAT_PAY_PLATFORM_SERIAL_NO || '',
    verifyNotifySignature: boolEnv(process.env.WECHAT_PAY_VERIFY_NOTIFY_SIGNATURE, false),
    clientConfirm: boolEnv(process.env.WECHAT_PAY_CLIENT_CONFIRM, false)
  };
}

function configStatus() {
  const config = getConfig();
  const missing = [];
  if (!config.appid) missing.push('WECHAT_PAY_APPID/WECHAT_APPID');
  if (!config.mchid) missing.push('WECHAT_PAY_MCH_ID');
  if (!config.serialNo) missing.push('WECHAT_PAY_MCH_SERIAL_NO');
  if (!config.privateKeyPath) missing.push('WECHAT_PAY_PRIVATE_KEY_PATH');
  if (!config.apiV3Key) missing.push('WECHAT_PAY_API_V3_KEY');
  if (!config.notifyUrl) missing.push('WECHAT_PAY_NOTIFY_URL');
  return {
    enabled: config.enabled,
    configured: missing.length === 0,
    missing,
    clientConfirm: config.clientConfirm,
    verifyNotifySignature: config.verifyNotifySignature,
    notificationVerifierConfigured: Boolean(config.platformCertPath)
  };
}

function isEnabled() {
  return getConfig().enabled;
}

function isConfigured() {
  return configStatus().configured;
}

function assertConfigured() {
  const status = configStatus();
  if (!status.enabled) throw new Error('微信支付未启用');
  if (!status.configured) throw new Error(`微信支付配置不完整：${status.missing.join('、')}`);
}

function loadPrivateKey() {
  const keyPath = getConfig().privateKeyPath;
  if (!keyPath) throw new Error('未配置商户私钥路径');
  const stat = fs.statSync(keyPath);
  if (privateKeyCache.path !== keyPath || privateKeyCache.mtimeMs !== stat.mtimeMs || !privateKeyCache.key) {
    privateKeyCache = {
      path: keyPath,
      key: fs.readFileSync(keyPath, 'utf8'),
      mtimeMs: stat.mtimeMs
    };
  }
  return privateKeyCache.key;
}

function randomNonce(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function signRsaSha256(message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(loadPrivateKey(), 'base64');
}

function buildAuthorization(method, urlPathWithQuery, bodyText) {
  const config = getConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce();
  const message = `${method.toUpperCase()}\n${urlPathWithQuery}\n${timestamp}\n${nonce}\n${bodyText || ''}\n`;
  const signature = signRsaSha256(message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.serialNo}"`;
}

function truncateByChars(text, maxChars) {
  const value = String(text || '').replace(/[\r\n\t]+/g, ' ').trim();
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function yuanCents(value) {
  const cents = Math.round(Number(value || 0));
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('微信支付金额必须大于 0');
  return cents;
}

function buildDescription(order = {}) {
  const item = Array.isArray(order.items) && order.items[0] || {};
  return truncateByChars(item.productName || order.batchName || `桃子订单${order.id || ''}`, 42) || '桃子预售订单';
}

async function requestWechatPay(method, pathname, payload) {
  assertConfigured();
  const bodyText = payload ? JSON.stringify(payload) : '';
  const authorization = buildAuthorization(method, pathname, bodyText);
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      authorization,
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: bodyText || undefined
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
  if (!response.ok) {
    throw new Error(data.message || data.error || data.raw || `微信支付接口异常：HTTP ${response.status}`);
  }
  return data;
}

function buildMiniProgramPayParams(prepayId) {
  const config = getConfig();
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce();
  const paymentPackage = `prepay_id=${prepayId}`;
  const message = `${config.appid}\n${timeStamp}\n${nonceStr}\n${paymentPackage}\n`;
  return {
    timeStamp,
    nonceStr,
    package: paymentPackage,
    signType: 'RSA',
    paySign: signRsaSha256(message)
  };
}

async function createJsapiPayment({ order, openid }) {
  assertConfigured();
  const config = getConfig();
  const payerOpenid = String(openid || '').trim();
  if (!payerOpenid) throw new Error('缺少微信 openid，无法发起小程序支付');
  if (!order || !order.id) throw new Error('订单不存在，无法发起支付');
  const payload = {
    appid: config.appid,
    mchid: config.mchid,
    description: buildDescription(order),
    out_trade_no: String(order.id),
    notify_url: config.notifyUrl,
    amount: {
      total: yuanCents(order.payAmount),
      currency: 'CNY'
    },
    payer: {
      openid: payerOpenid
    }
  };
  const data = await requestWechatPay('POST', '/v3/pay/transactions/jsapi', payload);
  if (!data.prepay_id) throw new Error('微信支付未返回 prepay_id');
  return {
    prepayId: data.prepay_id,
    params: buildMiniProgramPayParams(data.prepay_id)
  };
}

function buildRefundNo(orderId) {
  const safeId = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 52);
  if (!safeId) throw new Error('缺少订单号，无法生成退款单号');
  return `refund_${safeId}`.slice(0, 64);
}

async function createRefund({ order, refundAmountCents, reason, outRefundNo }) {
  assertConfigured();
  const config = getConfig();
  if (!order || !order.id) throw new Error('订单不存在，无法发起微信退款');
  const refund = yuanCents(refundAmountCents);
  const total = yuanCents(order.payAmount);
  if (refund > total) throw new Error('退款金额不能大于订单实付金额');
  const payload = {
    out_trade_no: String(order.id),
    out_refund_no: String(outRefundNo || buildRefundNo(order.id)),
    reason: truncateByChars(reason || '订单售后退款', 80),
    amount: {
      refund,
      total,
      currency: 'CNY'
    }
  };
  if (config.refundNotifyUrl) payload.notify_url = config.refundNotifyUrl;
  const data = await requestWechatPay('POST', '/v3/refund/domestic/refunds', payload);
  return {
    outRefundNo: payload.out_refund_no,
    refundId: data.refund_id || '',
    status: data.status || '',
    response: data
  };
}

function decryptNotifyResource(resource = {}) {
  const config = getConfig();
  const key = Buffer.from(config.apiV3Key || '', 'utf8');
  if (key.length !== 32) throw new Error('WECHAT_PAY_API_V3_KEY 必须是 32 位 APIv3 密钥');
  const ciphertext = Buffer.from(String(resource.ciphertext || ''), 'base64');
  if (ciphertext.length <= 16) throw new Error('微信支付通知密文为空');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, String(resource.nonce || ''));
  if (resource.associated_data) decipher.setAAD(Buffer.from(String(resource.associated_data), 'utf8'));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}


function verifyNotifySignature(headers = {}, rawBodyText = '') {
  const config = getConfig();
  const timestamp = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const signature = String(headers['wechatpay-signature'] || '');
  const serial = String(headers['wechatpay-serial'] || '');
  if (!timestamp || !nonce || !signature) {
    if (config.verifyNotifySignature) throw new Error('微信支付通知缺少验签请求头');
    return false;
  }
  if (config.platformSerialNo && serial && config.platformSerialNo !== serial) {
    throw new Error('微信支付通知平台证书序列号不匹配');
  }
  if (!config.platformCertPath) {
    if (config.verifyNotifySignature) throw new Error('未配置微信支付平台证书/公钥路径，无法验签支付通知');
    return false;
  }
  const message = `${timestamp}
${nonce}
${rawBodyText}
`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(message);
  const ok = verifier.verify(fs.readFileSync(config.platformCertPath, 'utf8'), signature, 'base64');
  if (!ok) throw new Error('微信支付通知验签失败');
  return true;
}

function parsePaymentNotify(body = {}) {
  assertConfigured();
  if (!body || typeof body !== 'object') throw new Error('微信支付通知内容为空');
  if (body.resource && body.resource.ciphertext) return decryptNotifyResource(body.resource);
  return body;
}

function parseRefundNotify(body = {}) {
  assertConfigured();
  if (!body || typeof body !== 'object') throw new Error('微信退款通知内容为空');
  if (body.resource && body.resource.ciphertext) return decryptNotifyResource(body.resource);
  return body;
}

module.exports = {
  configStatus,
  isEnabled,
  isConfigured,
  createJsapiPayment,
  createRefund,
  buildRefundNo,
  verifyNotifySignature,
  parsePaymentNotify,
  parseRefundNotify
};
