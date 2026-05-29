const crypto = require('crypto');

const API_BASE = 'https://open.xpyun.net/api/openapi/xprinter';

function getConfig() {
  return {
    user: process.env.XPYUN_USER || process.env.XPYUN_ACCOUNT || '',
    userKey: process.env.XPYUN_USER_KEY || process.env.XPYUN_KEY || '',
    sn: process.env.XPYUN_PRINTER_SN || '',
    printerName: process.env.XPYUN_PRINTER_NAME || '桃子预售标签机',
    publicCode: process.env.XPYUN_PRINTER_PUBLIC_CODE || '',
    labelWidth: Number(process.env.XPYUN_LABEL_WIDTH || 80),
    labelHeight: Number(process.env.XPYUN_LABEL_HEIGHT || 60),
    printBarcode: process.env.XPYUN_LABEL_BARCODE === '1',
    autoPrint: process.env.XPYUN_AUTO_PRINT !== '0'
  };
}

function configStatus() {
  const config = getConfig();
  return {
    configured: Boolean(config.user && config.userKey && config.sn),
    user: config.user || '',
    sn: config.sn || '',
    labelWidth: config.labelWidth,
    labelHeight: config.labelHeight,
    printBarcode: config.printBarcode,
    autoPrint: config.autoPrint
  };
}

function requireConfig() {
  const config = getConfig();
  if (!config.user || !config.userKey || !config.sn) {
    throw new Error('未配置芯烨云打印参数，请通过环境变量 XPYUN_USER、XPYUN_USER_KEY、XPYUN_PRINTER_SN 启动后台');
  }
  return config;
}

function signParams(config, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    user: config.user,
    timestamp,
    sign: crypto.createHash('sha1').update(`${config.user}${config.userKey}${timestamp}`).digest('hex'),
    debug: '0',
    ...extra
  };
}

async function postXpyun(pathname, params, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(params)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data.errmsg || data.msg || data.error || data.raw || `芯烨云接口 HTTP ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  const code = data && data.code !== undefined ? Number(data.code) : 0;
  if (code !== 0 && !(options.acceptCodes || []).includes(code)) {
    throw new Error(data.msg || data.errmsg || `芯烨云接口返回错误：${data.code}`);
  }
  return data;
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&'"\n\r]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
    '\n': ' ',
    '\r': ' '
  }[char]));
}

function textLine(x, y, text, size = 1) {
  return `<TEXT x="${x}" y="${y}" font="9" w="${size}" h="${size}" r="0">${xmlEscape(text)}</TEXT>`;
}

function barcode(x, y, value) {
  return `<BC128 x="${x}" y="${y}" h="52" s="1" n="1" w="2" r="0">${xmlEscape(value)}</BC128>`;
}

function money(cents = 0) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function moneyLabel(cents = 0) {
  return `${money(cents)}元`;
}

function maskPhone(phone = '') {
  const text = String(phone || '');
  return text.length >= 7 ? `${text.slice(0, 3)}****${text.slice(-4)}` : text;
}

function phoneTail(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits || '-';
}

function orderContact(order = {}) {
  if (order.deliveryType === 'express' && order.expressInfo) {
    return {
      name: order.expressInfo.receiver || '',
      phone: order.expressInfo.phone || order.buyerPhone || '',
      address: order.expressInfo.address || ''
    };
  }
  return {
    name: order.pickupPointName || '自提订单',
    phone: order.buyerPhone || '',
    address: order.pickupPointName || ''
  };
}

function textUnits(value) {
  return [...String(value || '')].reduce((sum, char) => sum + (/[\x00-\x7F]/.test(char) ? 1 : 2), 0);
}

function clipText(value, maxUnits) {
  const text = String(value || '').trim();
  let output = '';
  let units = 0;
  for (const char of text) {
    const charUnits = /[\x00-\x7F]/.test(char) ? 1 : 2;
    if (units + charUnits > maxUnits) break;
    output += char;
    units += charUnits;
  }
  return output.length < text.length ? `${output}…` : output;
}

function splitText(value, maxUnits, maxLines = 2) {
  const text = String(value || '').trim();
  const lines = [];
  let current = '';
  let units = 0;
  for (const char of text) {
    const charUnits = /[\x00-\x7F]/.test(char) ? 1 : 2;
    if (units + charUnits > maxUnits && current) {
      lines.push(current);
      current = '';
      units = 0;
      if (lines.length >= maxLines) break;
    }
    current += char;
    units += charUnits;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (textUnits(lines.join('')) < textUnits(text) && lines.length) {
    lines[lines.length - 1] = clipText(lines[lines.length - 1], Math.max(0, maxUnits - 2));
  }
  return lines;
}

function formatLabelTime(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const localMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (localMatch && !/[zZ]$/.test(text)) {
    return `${localMatch[2]}-${localMatch[3]} ${localMatch[4]}:${localMatch[5]}`;
  }
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((map, part) => {
      map[part.type] = part.value;
      return map;
    }, {});
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  return clipText(text.replace('T', ' ').replace(/\.\d+Z?$/i, ''), 16);
}

function compactProductName(value) {
  const text = String(value || '桃子订单')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, '')
    .trim();
  const parts = text.split(/~~|~|｜|\|/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : text;
}

function getPrimaryItem(order = {}) {
  const item = (order.items || [])[0] || {};
  return {
    title: item.productName || '桃子订单',
    spec: [item.skuName || item.packageLabel || '', `x${item.quantity || 1}`].filter(Boolean).join(' ')
  };
}

function saleTypeText(type) {
  return String(type || '').trim() === 'direct' ? '直售' : '预售';
}

function deliveryTypeText(type) {
  return String(type || '').trim() === 'express' ? '快递' : '自提';
}

function orderStatusText(order = {}) {
  if (order.status === 'refunded') return '已退款';
  if (order.status === 'cancelled') return '已取消';
  if (order.status === 'after_sale') return '售后中';
  if (order.status === 'awaiting_payment') return '待支付';
  if (order.deliveryType === 'express') {
    if (order.status === 'awaiting_shipment') return '快递待发';
    if (order.status === 'shipped') return '快递已发';
    if (['picked_up', 'completed'].includes(order.status)) return '快递已签收';
  }
  if (order.deliveryType === 'pickup') {
    if (['awaiting_shipment', 'awaiting_pickup'].includes(order.status)) return '自提待发';
    if (order.status === 'pickup_shipped') return '自提点已到货';
    if (['picked_up', 'completed'].includes(order.status)) return '自提已领取';
  }
  return order.statusText || '未知';
}

function fulfillmentText(order = {}) {
  return [order.fulfillmentStart, order.fulfillmentEnd].filter(Boolean).join(' 至 ') || '-';
}

function paidBreakdown(order = {}) {
  const shippingFee = Number(order.shippingFee || 0);
  const goodsAmount = Number(order.goodsAmount || Math.max(0, Number(order.payAmount || 0) - shippingFee));
  return `商品 ${moneyLabel(goodsAmount)} 运费 ${moneyLabel(shippingFee)}`;
}

function pushWrapped(rows, prefix, value, maxLines = 2, maxUnits = 47) {
  const safePrefix = String(prefix || '');
  const lines = splitText(value || '-', Math.max(8, maxUnits - textUnits(safePrefix)), maxLines);
  rows.push(`${safePrefix}${lines[0] || '-'}`);
  for (const line of lines.slice(1)) rows.push(`  ${line}`);
}

function buildOrderDetailLabel(order = {}, config = getConfig()) {
  const { title, spec } = getPrimaryItem(order);
  const contact = orderContact(order);
  const orderId = String(order.id || '');
  const contactName = order.deliveryType === 'express' ? contact.name : (order.contactName || '');
  const contactPhone = order.contactPhone || contact.phone || order.buyerPhone || '';
  const destination = order.deliveryType === 'express'
    ? contact.address
    : (order.pickupPointName || order.destinationText || '-');
  const productText = [title, spec].filter(Boolean).join(' | ');
  const rows = ['订单详情'];
  pushWrapped(rows, '订单编号：', orderId, 1, 50);
  pushWrapped(rows, '批次名称：', order.batchName || '-', 1, 50);
  pushWrapped(rows, '销售类型：', saleTypeText(order.saleType), 1, 50);
  pushWrapped(rows, '联系人：', `${contactName || '-'} | ${maskPhone(contactPhone)}`, 1, 50);
  pushWrapped(rows, '配送方式：', deliveryTypeText(order.deliveryType), 1, 50);
  pushWrapped(rows, '自提点/地址：', destination, 2, 50);
  pushWrapped(rows, '履约时间：', fulfillmentText(order), 1, 50);
  pushWrapped(rows, '商品：', productText, 2, 50);
  pushWrapped(rows, '实付：', `${moneyLabel(order.payAmount)} (${paidBreakdown(order)})`, 1, 50);
  pushWrapped(rows, '状态：', orderStatusText(order), 1, 50);

  let y = 10;
  const left = 16;
  const titleGap = 58;
  const rowGap = 34;
  const content = [
    '<PAGE>',
    `<SIZE>${config.labelWidth},${config.labelHeight}</SIZE>`,
  ];
  rows.forEach((row, index) => {
    const isTitle = index === 0;
    content.push(textLine(left, y, clipText(row, isTitle ? 24 : 52), isTitle ? 2 : 1));
    y += isTitle ? titleGap : rowGap;
  });
  if (config.printBarcode && orderId && y < 410) content.push(barcode(left, y + 6, clipText(orderId, 48)));
  content.push('</PAGE>');
  return content.join('');
}

function buildLabelContent(order = {}, config = getConfig()) {
  return buildOrderDetailLabel(order, config);
}

async function addPrinter() {
  const config = requireConfig();
  const item = { sn: config.sn, name: config.printerName };
  const result = await postXpyun('/addPrinters', signParams(config, {
    items: [item]
  }));
  const failMsg = (result && result.data && Array.isArray(result.data.failMsg)) ? result.data.failMsg : [];
  const fail = (result && result.data && Array.isArray(result.data.fail)) ? result.data.fail : [];
  if (fail.length && failMsg.every((message) => String(message).includes(':1011'))) {
    return { ...result, alreadyBound: true };
  }
  if (fail.length) {
    throw new Error(`打印机绑定失败：${failMsg.join('；') || fail.join('、')}`);
  }
  return result;
}

function printerCloudStatusText(value) {
  const status = Number(value);
  if (status === 1) return '在线正常';
  if (status === 2) return '在线异常（可能缺纸或设备异常）';
  return '离线';
}

async function queryPrinterStatus() {
  const config = requireConfig();
  const result = await postXpyun('/queryPrinterStatus', signParams(config, {
    sn: config.sn
  }));
  return {
    ...result,
    statusText: printerCloudStatusText(result.data)
  };
}

async function printOrderLabel(order, options = {}) {
  const config = requireConfig();
  const content = options.content || buildLabelContent(order, config);
  const copies = String(Math.max(1, Math.floor(Number(options.copies || 1))));
  const idempotent = String(options.idempotent || `order_${order.id || Date.now()}`).slice(0, 50);
  return postXpyun('/printLabel', signParams(config, {
    sn: options.sn || config.sn,
    content,
    copies,
    voice: Number(options.voice ?? 2),
    mode: Number(options.mode ?? 1),
    expiresIn: Number(options.expiresIn ?? 86400),
    idempotent,
    money: money(order.payAmount)
  }), { acceptCodes: [1013] });
}

module.exports = {
  getConfig,
  configStatus,
  buildLabelContent,
  addPrinter,
  queryPrinterStatus,
  printOrderLabel
};
