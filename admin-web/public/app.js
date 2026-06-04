const ORDER_SETTINGS_KEYS = {
  showPendingPaymentOrders: 'peach.admin.showPendingPaymentOrders'
};

function readBoolSetting(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === 'true';
  } catch (_) {
    return fallback;
  }
}

function writeBoolSetting(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value ? 'true' : 'false');
  } catch (_) {}
}

const state = {
  products: [],
  pickupPoints: [],
  orders: [],
  whitelistEntries: [],
  coupons: [],
  operationLogs: [],
  shippingRule: null,
  stats: null,
  orderBusinessStats: null,
  dbPath: '',
  session: {
    authRequired: false,
    authenticated: false
  },
  orderPage: 1,
  orderPageSize: 20,
  showPendingPaymentOrders: readBoolSetting(ORDER_SETTINGS_KEYS.showPendingPaymentOrders, true)
};

let orderTabSecretClicks = 0;
let orderTabSecretTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const DEFAULT_UPLOAD_HINT = '支持 PNG/JPG/WEBP，最大 5MB；图片保存在本地服务器。';

function money(cents = 0) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function centsFromYuan(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) : fallback;
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
  if (normalizeSaleType(payload.saleType || payload.sale_type) === 'direct') return '';
  const shipStartText = String(payload.shipStart || '').trim();
  const shipEndText = String(payload.shipEnd || '').trim();
  const orderDeadlineText = String(payload.orderDeadline || '').trim();
  if (!orderDeadlineText || !shipStartText || !shipEndText) return '请完整填写截单时间、履约开始、履约结束';

  const shipStart = parseAdminDateTime(shipStartText);
  const shipEnd = parseAdminDateTime(shipEndText);
  const orderDeadline = parseAdminDateTime(orderDeadlineText);

  if (Number.isNaN(shipStart)) return '履约开始时间格式不正确';
  if (Number.isNaN(shipEnd)) return '履约结束时间格式不正确';
  if (Number.isNaN(orderDeadline)) return '截单时间格式不正确';
  if (shipStart && shipEnd && shipEnd <= shipStart) return '履约结束时间必须大于履约开始时间';
  if (orderDeadline && shipStart && orderDeadline >= shipStart) return '截单时间必须小于履约开始时间';
  return '';
}

function normalizeSaleType(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'direct' || text === '直售' || text === '现货' || text === 'spot' ? 'direct' : 'presale';
}

function validateProductPrices(payload = {}) {
  const invalidSkus = (payload.skus || []).filter((sku) => Number(sku.salePrice || sku.price || 0) <= 0);
  if (!invalidSkus.length) return '';
  return `${invalidSkus.map((sku) => sku.label || sku.name || '规格').join('、')}价格必须大于 0`;
}

function validateProductStock(payload = {}) {
  const invalidSkus = (payload.skus || []).filter((sku) => {
    const stock = Number(sku.stock);
    return !Number.isFinite(stock) || stock <= 0;
  });
  if (!invalidSkus.length) return '';
  return `${invalidSkus.map((sku) => sku.label || sku.name || '规格').join('、')}库存必须大于 0`;
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function checkedValues(selector) {
  return $$(selector)
    .filter((input) => input.checked)
    .map((input) => input.value)
    .filter(Boolean);
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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function mergeWhitelistPhones(phones) {
  const form = $('#whitelistForm');
  const field = form && form.elements.phonesText;
  if (!field) return 0;
  const merged = [...new Set([...extractPhonesFromText(field.value), ...(phones || [])])];
  field.value = merged.join('\n');
  return merged.length;
}

function setChoiceChecked(selector, checked) {
  $$(selector).forEach((input) => {
    input.checked = checked;
  });
}

function safeImageSrc(src = '') {
  const image = String(src || '').trim();
  if (/^https?:\/\//i.test(image) || image.startsWith('/uploads/') || image.startsWith('/assets/')) return image;
  return '';
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

let activeModalClose = null;

function fieldAttribute(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return ` ${name}="${escapeHtml(value)}"`;
}

function buildModalBody({ message = '', details = [], fields = [] }) {
  const blocks = [];
  if (message) {
    blocks.push(`<p class="modal-message">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`);
  }
  if (details.length) {
    blocks.push(`<div class="modal-detail-grid">${details.map((item) => `
      <div class="modal-detail-row">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value || '-')}</strong>
      </div>
    `).join('')}</div>`);
  }
  if (fields.length) {
    blocks.push(`<div class="modal-form">${fields.map((field) => {
      const inputAttrs = [
        `data-modal-field="${escapeHtml(field.name)}"`,
        field.required ? 'required' : '',
        fieldAttribute('placeholder', field.placeholder),
        fieldAttribute('min', field.min),
        fieldAttribute('max', field.max),
        fieldAttribute('step', field.step)
      ].filter(Boolean).join(' ');
      if (field.type === 'checkbox') {
        return `
          <label class="modal-switch-field">
            <input ${inputAttrs} type="checkbox" ${field.value ? 'checked' : ''} />
            <span>
              <strong>${escapeHtml(field.label || field.name)}</strong>
              ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ''}
            </span>
          </label>
        `;
      }
      const control = field.type === 'textarea'
        ? `<textarea ${inputAttrs} rows="${escapeHtml(field.rows || 4)}">${escapeHtml(field.value || '')}</textarea>`
        : `<input ${inputAttrs} type="${escapeHtml(field.type || 'text')}" value="${escapeHtml(field.value || '')}" />`;
      return `
        <label class="modal-field">
          <span>${escapeHtml(field.label || field.name)}${field.required ? '<em>必填</em>' : ''}</span>
          ${control}
        </label>
      `;
    }).join('')}</div>`);
  }
  return blocks.join('') || '<p class="modal-message">请确认当前操作。</p>';
}

function openModal(config = {}) {
  const root = $('#appModal');
  if (!root) return Promise.resolve({ confirmed: false, values: {} });
  if (activeModalClose) activeModalClose({ confirmed: false, values: {} });

  const title = $('#appModalTitle');
  const eyebrow = $('#appModalEyebrow');
  const body = $('#appModalBody');
  const error = $('#appModalError');
  const cancelBtn = $('#appModalCancel');
  const confirmBtn = $('#appModalConfirm');
  const closeBtn = $('#appModalClose');
  const previousActive = document.activeElement;
  const fields = config.fields || [];

  title.textContent = config.title || '提示';
  eyebrow.textContent = config.eyebrow || (fields.length ? '填写信息' : '操作确认');
  body.innerHTML = buildModalBody(config);
  error.hidden = true;
  error.textContent = '';
  cancelBtn.hidden = config.showCancel === false;
  cancelBtn.textContent = config.cancelText || '取消';
  confirmBtn.textContent = config.confirmText || '确定';
  confirmBtn.classList.toggle('danger', Boolean(config.danger));
  root.hidden = false;
  document.body.classList.add('modal-open');

  return new Promise((resolve) => {
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      root.hidden = true;
      document.body.classList.remove('modal-open');
      root.removeEventListener('click', onBackdrop);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      closeBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeydown);
      activeModalClose = null;
      if (previousActive && previousActive.focus) previousActive.focus();
      resolve(result);
    };
    const showError = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const onCancel = () => close({ confirmed: false, values: {} });
    const onBackdrop = (event) => {
      if (event.target === root) onCancel();
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && !event.target.matches('textarea')) {
        event.preventDefault();
        onConfirm();
      }
    };
    const onConfirm = () => {
      const values = {};
      for (const field of fields) {
        const input = body.querySelector(`[data-modal-field="${String(field.name).replace(/"/g, '\\"')}"]`);
        const value = input && input.type === 'checkbox' ? input.checked : (input ? input.value : '');
        if (field.required && !String(value || '').trim()) {
          showError(`${field.label || field.name}不能为空`);
          if (input && input.focus) input.focus();
          return;
        }
        values[field.name] = value;
      }
      close({ confirmed: true, values });
    };

    activeModalClose = close;
    root.addEventListener('click', onBackdrop);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    closeBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);

    setTimeout(() => {
      const firstField = body.querySelector('[data-modal-field]');
      (firstField || confirmBtn).focus();
    }, 0);
  });
}

async function showInfo(title, options = {}) {
  await openModal({
    title,
    eyebrow: options.eyebrow || '详情信息',
    message: options.message || '',
    details: options.details || [],
    showCancel: false,
    confirmText: options.confirmText || '知道了'
  });
}

async function showConfirm(message, options = {}) {
  const result = await openModal({
    title: options.title || '请确认',
    eyebrow: options.eyebrow || '操作确认',
    message,
    confirmText: options.confirmText || '确认',
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger)
  });
  return result.confirmed;
}

async function showForm(options = {}) {
  const result = await openModal({
    title: options.title || '填写信息',
    eyebrow: options.eyebrow || '需要补充信息',
    message: options.message || '',
    fields: options.fields || [],
    confirmText: options.confirmText || '提交',
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger)
  });
  return result.confirmed ? result.values : null;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') showLogin('登录已过期，请重新输入管理员密码');
    throw new Error(data.error || '请求失败');
  }
  return data;
}

async function withFormLock(form, busyText, task) {
  if (!form || form.dataset.saving === 'true') return;
  const submitButton = form.querySelector('button[type="submit"]');
  const originalText = submitButton ? submitButton.textContent : '';
  form.dataset.saving = 'true';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = busyText || '处理中...';
  }
  try {
    await task();
  } catch (error) {
    toast(error.message);
  } finally {
    form.dataset.saving = 'false';
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalText || '提交';
    }
  }
}

async function withButtonLock(button, busyText, task) {
  if (!button || button.dataset.running === 'true') return;
  const originalText = button.textContent;
  button.dataset.running = 'true';
  button.disabled = true;
  if (busyText) button.textContent = busyText;
  try {
    await task();
  } catch (error) {
    toast(error.message);
  } finally {
    button.dataset.running = 'false';
    button.disabled = false;
    if (busyText) button.textContent = originalText;
  }
}

async function uploadImage(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/uploads', {
    method: 'POST',
    body: form,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) showLogin('登录已过期，请重新输入管理员密码');
    throw new Error(data.error || '图片上传失败');
  }
  return data.file;
}

function setAdminVisible(visible) {
  const main = $('#adminMain');
  const login = $('#loginPanel');
  if (main) main.hidden = !visible;
  if (login) login.hidden = visible;
}

function showLogin(message = '') {
  setAdminVisible(false);
  if (message) toast(message);
  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) logoutBtn.hidden = true;
}

function showAdmin(session) {
  state.session = session;
  setAdminVisible(true);
  const logoutBtn = $('#logoutBtn');
  if (session.authRequired) {
    if (logoutBtn) logoutBtn.hidden = false;
  } else {
    if (logoutBtn) logoutBtn.hidden = true;
  }
}

async function ensureSession() {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  const session = await response.json().catch(() => ({ authRequired: true, authenticated: false }));
  if (session.authRequired && !session.authenticated) {
    showLogin();
    return false;
  }
  showAdmin(session);
  return true;
}

function formData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) {
    data[checkbox.name] = checkbox.checked;
  }
  return data;
}

function fillForm(form, data) {
  for (const [key, value] of Object.entries(data || {})) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  }
}

function syncProductSaleTypeFields(form = $('#productForm')) {
  if (!form) return;
  const saleType = normalizeSaleType(form.elements.saleType && form.elements.saleType.value);
  form.querySelectorAll('.presale-only').forEach((wrapper) => {
    const hideSchedule = saleType === 'direct';
    wrapper.hidden = hideSchedule;
    wrapper.classList.toggle('field-hidden', hideSchedule);
    wrapper.style.display = hideSchedule ? 'none' : '';
    wrapper.querySelectorAll('input, textarea, select').forEach((field) => {
      if (saleType === 'direct') {
        field.required = false;
        field.removeAttribute('required');
      } else {
        field.required = true;
        field.setAttribute('required', 'required');
      }
      field.disabled = saleType === 'direct';
      if (saleType === 'direct') field.value = '';
    });
  });
  const tagsField = form.elements.tagsText;
  if (tagsField) {
    const tagsText = String(tagsField.value || '').trim();
    if (saleType === 'direct' && tagsText === '新上架 预售') tagsField.value = '新上架 直售';
    if (saleType === 'presale' && tagsText === '新上架 直售') tagsField.value = '新上架 预售';
  }
}

function updateCoverPreview(src) {
  const preview = $('#coverPreview');
  if (!preview) return;
  const imageSrc = String(src || '').trim();
  preview.hidden = !imageSrc;
  preview.src = imageSrc || '';
}

function resetUploadHint() {
  const uploadHint = $('#uploadHint');
  if (uploadHint) uploadHint.textContent = DEFAULT_UPLOAD_HINT;
  const galleryUploadHint = $('#galleryUploadHint');
  if (galleryUploadHint) galleryUploadHint.textContent = '可上传多张详情图，上传成功后自动追加到图册地址。';
}

function statusText(status) {
  return {
    on_sale: '上架中',
    off_sale_manual: '手动下架',
    sold_out_auto: '售罄',
    awaiting_payment: '待支付',
    awaiting_shipment: '快递待发',
    awaiting_pickup: '自提待发',
    pickup_shipped: '自提点已到货',
    shipped: '快递已发',
    picked_up: '自提已领取',
    completed: '快递已签收',
    after_sale: '售后中',
    refunded: '已退款',
    cancelled: '已取消'
  }[status] || '未知';
}

function deliveryTypeText(type) {
  return {
    pickup: '自提',
    express: '快递'
  }[type] || '未知配送';
}

function saleTypeText(type) {
  return normalizeSaleType(type) === 'direct' ? '直售' : '预售';
}

function discountTypeText(type) {
  return {
    product_sale: '',
    whitelist: '白名单折扣',
    global: '全场折扣',
    coupon: '优惠码',
    shipping: '运费优惠'
  }[type] || '优惠';
}

function afterSaleStatusText(status) {
  return {
    requested: '已申请',
    processing: '处理中',
    refund_processing: '退款处理中',
    approved: '已同意',
    rejected: '已拒绝',
    refunded: '已退款'
  }[status] || '处理中';
}

function canApplyAfterSale(order) {
  if (!order || order.afterSaleInfo) return false;
  if (order.status === 'completed') return true;
  if (order.deliveryType === 'pickup') return order.status === 'picked_up';
  if (order.deliveryType === 'express') return order.status === 'completed';
  return false;
}

function renderStats() {
  const stats = state.stats || {};
  $('#stats').innerHTML = [
    ['商品数', stats.productCount || 0],
    ['启用自提点', stats.pickupCount || 0],
    ['订单数', stats.orderCount || 0],
    ['未退款销售额', `¥${stats.revenueText || '0.00'}`]
  ].map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
}

function renderDashboard() {
  const stats = state.stats || {};
  const dashboardItems = [
    ['未退款销售额', `¥${stats.revenueText || '0.00'}`, '只看还没退款的订单'],
    ['已支付订单', stats.paidOrderCount || 0, `总订单 ${stats.orderCount || 0}`],
    ['待支付锁单', stats.pendingPaymentCount || 0, '可释放超时库存'],
    ['待发货', stats.awaitingShipmentCount || 0, '快递履约'],
    ['待自提', stats.awaitingPickupCount || 0, '需要核销'],
    ['低库存 SKU', stats.lowStockSkuCount || 0, '库存 ≤ 10'],
    ['优惠码抵扣', `¥${stats.couponDiscountText || '0.00'}`, `优惠码 ${stats.couponCount || 0} 个`],
    ['白名单人数', stats.whitelistCount || 0, '折扣人群']
  ];
  const dashboard = $('#dashboardGrid');
  if (dashboard) {
    dashboard.innerHTML = dashboardItems.map(([label, value, desc]) => `
      <div class="stat dashboard-stat"><b>${value}</b><span>${label}</span><em>${desc}</em></div>
    `).join('');
  }
  const renderMiniList = (selector, rows, emptyText, formatter) => {
    const target = $(selector);
    if (!target) return;
    target.innerHTML = rows && rows.length
      ? rows.map(formatter).join('')
      : `<div class="meta">${emptyText}</div>`;
  };
  renderMiniList('#topProductsList', stats.topProducts, '暂无已支付商品数据', (row) => `
    <div class="mini-row"><span>${escapeHtml(row.name)}</span><strong>${escapeHtml(row.quantity)} 件｜¥${escapeHtml(row.amountText)}</strong></div>
  `);
  renderMiniList('#pickupStatsList', stats.pickupPointStats, '暂无自提订单数据', (row) => `
    <div class="mini-row"><span>${escapeHtml(row.name)}</span><strong>${escapeHtml(row.count)} 单</strong></div>
  `);
  renderMiniList('#statusStatsList', stats.orderStatusRows, '暂无订单状态数据', (row) => `
    <div class="mini-row"><span>${escapeHtml(statusText(row.status))}</span><strong>${escapeHtml(row.count)} 单</strong></div>
  `);
  renderMiniList('#operationLogsList', state.operationLogs, '暂无操作日志', (row) => `
    <div class="mini-row"><span>${escapeHtml(row.action)}｜${escapeHtml(row.targetId || row.targetType || '-')}</span><strong>${escapeHtml(row.createdAt || '')}</strong></div>
  `);
}

function renderOrderBusinessStats() {
  const stats = state.orderBusinessStats || {};
  const target = $('#orderStatsGrid');
  if (!target) return;
  const rows = [
    ['已完成1', `${stats.completed1 && stats.completed1.count || 0} 单`, '已领取超过24小时且无售后退款', 'completed1'],
    ['已完成2', `${stats.completed2 && stats.completed2.count || 0} 单`, '已领取未超过24小时或售后未处理', 'completed2'],
    ['已发快递', `${stats.expressSent && stats.expressSent.count || 0} 单`, `已领取 ${stats.expressSent && stats.expressSent.received || 0}｜未领取 ${stats.expressSent && stats.expressSent.unreceived || 0}`, 'expressSent'],
    ['已发自提', `${stats.pickupSent && stats.pickupSent.count || 0} 单`, `已领取 ${stats.pickupSent && stats.pickupSent.received || 0}｜未领取 ${stats.pickupSent && stats.pickupSent.unreceived || 0}`, 'pickupSent'],
    ['退款', `${stats.refunded && stats.refunded.count || 0} 单`, '仅统计已退款订单', 'refunded'],
    ['累计收款', `¥${stats.totalReceiptsText || '0.00'}`, '已支付订单一共收了多少', 'all'],
    ['已退金额', `¥${stats.totalRefundText || '0.00'}`, '实际退给客户的钱', 'refunded'],
    ['净收入', `¥${stats.actualIncomeText || '0.00'}`, '累计收款 - 已退金额', 'all']
  ];
  target.innerHTML = rows.map(([label, value, desc, bucket]) => `
    <div class="stat order-stat-card">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
      <em>${escapeHtml(desc)}</em>
      <button class="ghost small" data-action="export-stats-bucket" data-bucket="${escapeHtml(bucket)}">导出</button>
    </div>
  `).join('');
}

function productName(productId) {
  const product = state.products.find((item) => String(item.id) === String(productId));
  return product ? product.name : productId;
}

function pickupPointName(pointId) {
  const point = state.pickupPoints.find((item) => String(item.id) === String(pointId));
  return point ? point.name : pointId;
}

function formatProductScope(productIds = []) {
  const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [];
  return ids.length ? ids.map(productName).join('、') : '全部商品';
}

function formatPickupPointScope(pointIds = []) {
  const ids = Array.isArray(pointIds) ? pointIds.filter(Boolean) : [];
  return ids.length ? ids.map(pickupPointName).join('、') : '全部启用自提点';
}

function packageTypeLabel(type) {
  if (type === 'box') return '盒装';
  if (type === 'bag') return '袋装';
  return '未知包装';
}

function packageTypesText(types = []) {
  const values = Array.isArray(types) ? types : [];
  return values.length ? values.map(packageTypeLabel).join(' / ') : '未设置';
}

function productPackageTypesFromPayload(payload = {}) {
  const types = [];
  if (payload.packageBox) types.push('box');
  if (payload.packageBag) types.push('bag');
  return types.length ? types : ['box'];
}

function findIncompatiblePickupPoints(payload = {}) {
  const packageTypes = productPackageTypesFromPayload(payload);
  const selectedIds = new Set((payload.pickupPointIds || []).map(String));
  return state.pickupPoints.filter((point) => {
    if (!point.enabled || !selectedIds.has(String(point.id))) return false;
    const pointPackageTypes = Array.isArray(point.packageTypes) ? point.packageTypes : [];
    return pointPackageTypes.length && !pointPackageTypes.some((type) => packageTypes.includes(type));
  });
}

function renderCheckboxChoices(selector, items, selectedIds, emptyText, buildLabel, inputName) {
  const target = $(selector);
  if (!target) return;
  const selected = new Set((selectedIds || []).map((id) => String(id)));
  target.innerHTML = (items || []).length
    ? items.map((item) => {
      const itemId = String(item.id);
      return `
        <label class="choice-card">
          <input type="checkbox" name="${escapeHtml(inputName)}" value="${escapeHtml(itemId)}" ${selected.has(itemId) ? 'checked' : ''} />
          <span>${buildLabel(item)}</span>
        </label>
      `;
    }).join('')
    : `<div class="meta">${escapeHtml(emptyText)}</div>`;
}

function selectableProducts() {
  return state.products.filter((product) => (
    product.isOnSale || (product.status === 'on_sale' && Number(product.stock || 0) > 0)
  ));
}

function renderWhitelistProductChoices(selectedIds = []) {
  renderCheckboxChoices(
    '#whitelistProductChoices',
    selectableProducts(),
    selectedIds,
    '暂无可选商品，上架且有库存的商品才可绑定白名单。',
    (product) => `${escapeHtml(product.name)}<small>${escapeHtml(statusText(product.status))}｜库存 ${escapeHtml(product.stock || 0)}</small>`,
    'whitelistProductId'
  );
}

function renderCouponProductChoices(selectedIds = []) {
  renderCheckboxChoices(
    '#couponProductChoices',
    selectableProducts(),
    selectedIds,
    '暂无可选商品，上架且有库存的商品才可绑定优惠码。',
    (product) => `${escapeHtml(product.name)}<small>${escapeHtml(statusText(product.status))}｜库存 ${escapeHtml(product.stock || 0)}</small>`,
    'couponProductId'
  );
}

function renderProductPickupPointChoices(selectedIds = []) {
  renderCheckboxChoices(
    '#productPickupPointChoices',
    state.pickupPoints.filter((point) => point.enabled),
    selectedIds,
    '暂无启用自提点，创建自提点后可绑定商品。',
    (point) => `${escapeHtml(point.name)}<small>${escapeHtml(point.address || '')}｜${escapeHtml(packageTypesText(point.packageTypes))}</small>`,
    'productPickupPointId'
  );
}

function productCanBeListed(product) {
  const skus = Array.isArray(product && product.skus) ? product.skus : [];
  return skus.length > 0 && skus.every((sku) => Number(sku.stock || 0) > 0);
}

function renderProducts() {
  $('#productsList').innerHTML = state.products.map((product) => {
    const stock = (product.skus || []).reduce((sum, sku) => sum + Number(sku.stock || 0), 0);
    const soldCount = Number(product.soldCount || 0);
    const lockedCount = Number(product.lockedCount || 0);
    const initialStock = Number(product.initialStock || stock);
    const skuText = (product.skus || []).map((sku) => {
      const skuLocked = Number(sku.lockedCount || 0);
      const lockedText = skuLocked ? `｜锁定 ${skuLocked}` : '';
      return `${escapeHtml(sku.name)} 价格 ¥${money(sku.salePrice)}｜累计 ${escapeHtml(sku.initialStock || sku.stock)}｜已售 ${escapeHtml(sku.soldCount || 0)}｜剩余 ${escapeHtml(sku.stock)}${lockedText}`;
    }).join(' / ');
    const saleType = product.saleType || 'presale';
    const batch = saleType === 'direct'
      ? [product.batchName, '直售'].filter(Boolean).join('｜')
      : [
        product.batchName,
        product.shipStart && product.shipEnd ? `履约 ${product.shipStart}~${product.shipEnd}` : '',
        product.orderDeadline ? `截单 ${product.orderDeadline}` : ''
      ].filter(Boolean).join('｜');
    const productId = escapeHtml(product.id);
    const isOnSaleStatus = product.status === 'on_sale';
    const isSoldOutStatus = product.status === 'sold_out_auto';
    const canList = productCanBeListed(product);
    const listDisabled = isOnSaleStatus;
    const unlistDisabled = product.status === 'off_sale_manual' || isSoldOutStatus;
    const listTitle = !listDisabled && !canList ? '上架前需要所有规格库存都大于 0' : '';
    return `
      <article class="item">
        <img class="thumb" src="${escapeHtml(safeImageSrc(product.coverImage))}" alt="" />
        <div>
          <h3>${escapeHtml(product.name)}</h3>
          <div class="meta">${escapeHtml(product.subtitle || '')}</div>
          <div class="meta">价格 ¥${money(product.salePrice)}｜${escapeHtml(saleTypeText(saleType))}｜<span class="${product.status === 'on_sale' ? 'status-on' : 'status-off'}">${escapeHtml(statusText(product.status))}</span></div>
          <div class="meta">累计库存 ${escapeHtml(initialStock)}｜已售 ${escapeHtml(soldCount)}｜剩余 ${escapeHtml(stock)}${lockedCount ? `｜锁定 ${escapeHtml(lockedCount)}` : ''}</div>
          <div class="meta">${skuText}</div>
          <div class="meta">${escapeHtml(batch || '未设置预售批次')}</div>
          <div class="meta">适用自提点：${escapeHtml(formatPickupPointScope(product.pickupPointIds))}</div>
          <div class="meta">图册 ${(product.images || []).length} 张｜${product.detailText ? '已填写详情' : '未填写详情'}</div>
          <div class="tags">${(product.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <div class="actions">
          <button class="ghost" data-action="edit-product" data-id="${productId}">编辑</button>
          <button class="ghost" data-action="status-product" data-status="on_sale" data-id="${productId}" ${listDisabled ? 'disabled' : ''} title="${escapeHtml(listTitle)}">上架</button>
          <button class="ghost" data-action="status-product" data-status="off_sale_manual" data-id="${productId}" ${unlistDisabled ? 'disabled' : ''}>下架</button>
          <button class="danger" data-action="delete-product" data-id="${productId}">删除</button>
        </div>
      </article>
    `;
  }).join('') || '<div class="card">暂无商品</div>';
}

function productToForm(product) {
  const boxSku = (product.skus || []).find((sku) => sku.packageType === 'box') || {};
  const bagSku = (product.skus || []).find((sku) => sku.packageType === 'bag') || {};
  const firstSku = (product.skus || [])[0] || {};
  return {
    id: product.id,
    name: product.name,
    subtitle: product.subtitle,
    coverImage: product.coverImage,
    imagesText: (product.images || []).join('\n'),
    boxSalePriceYuan: boxSku.salePrice === undefined ? '' : money(boxSku.salePrice),
    bagSalePriceYuan: bagSku.salePrice === undefined ? '' : money(bagSku.salePrice),
    weightText: firstSku.weightText || '',
    boxStock: boxSku.stock ?? 0,
    bagStock: bagSku.stock ?? 0,
    saleType: product.saleType || 'presale',
    tagsText: (product.tags || []).join(' '),
    batchName: product.batchName,
    customerContact: product.customerContact || '',
    customerPhone: product.customerPhone || '',
    pickupValidHours: product.pickupValidHours || '',
    shipStart: product.shipStart,
    shipEnd: product.shipEnd,
    orderDeadline: product.orderDeadline,
    presaleNote: product.presaleNote,
    detailText: product.detailText,
    packageBox: (product.packageTypes || []).includes('box'),
    packageBag: (product.packageTypes || []).includes('bag'),
    deliveryPickup: (product.deliveryMethods || []).includes('pickup'),
    deliveryExpress: (product.deliveryMethods || []).includes('express'),
    pickupPointIds: product.pickupPointIds || []
  };
}

function renderPickupPoints() {
  $('#pickupList').innerHTML = state.pickupPoints.map((point) => `
    <article class="item no-image ${point.enabled ? '' : 'pickup-disabled'}">
      <div>
        <h3>${escapeHtml(point.name)}</h3>
        <div class="meta">${escapeHtml(point.address)}</div>
        <div class="meta">${escapeHtml(point.openTime || '未设置时间')}｜${escapeHtml(point.phone || '未设置电话')}｜${point.enabled ? '启用' : '停用'}</div>
        <div class="meta">包装：${escapeHtml(packageTypesText(point.packageTypes))}｜容量：${escapeHtml(point.dailyCapacity || '不限')}｜排序：${escapeHtml(point.sortWeight)}</div>
        <div class="meta">核销账号：${escapeHtml(point.loginAccount || '未设置')}</div>
        <div class="meta">${escapeHtml(point.notice || '')}</div>
      </div>
      <div class="actions">
        <button class="ghost" data-action="edit-pickup" data-id="${escapeHtml(point.id)}">编辑</button>
        <button class="ghost" data-action="toggle-pickup" data-id="${escapeHtml(point.id)}" data-enabled="${!point.enabled}">${point.enabled ? '停用' : '启用'}</button>
        <button class="danger" data-action="delete-pickup" data-id="${escapeHtml(point.id)}" ${point.enabled ? '' : 'disabled'}>停用</button>
      </div>
    </article>
  `).join('') || '<div class="card">暂无自提点</div>';
}

function pickupToForm(point) {
  return {
    id: point.id,
    name: point.name,
    address: point.address,
    phone: point.phone,
    openTime: point.openTime,
    loginAccount: point.loginAccount || '',
    loginPassword: '',
    dailyCapacity: point.dailyCapacity,
    sortWeight: point.sortWeight,
    notice: point.notice,
    packageBox: (point.packageTypes || []).includes('box'),
    packageBag: (point.packageTypes || []).includes('bag'),
    enabled: point.enabled
  };
}

function renderShippingRule() {
  const rule = state.shippingRule || {};
  fillForm($('#shippingForm'), {
    localExpressFeeYuan: money(rule.localExpressFee ?? rule.expressBaseFee),
    remoteExpressFeeYuan: money(rule.remoteExpressFee ?? rule.expressBaseFee),
    freeShippingThresholdYuan: money(rule.freeShippingThreshold),
    pickupFeeYuan: money(rule.pickupFee),
    localRegionsText: (rule.localRegions || ['成都', '成都市', '重庆', '重庆市']).join(' '),
    note: rule.note || ''
  });
}

function orderPrimaryItem(order) {
  return (order.items || [])[0] || {};
}

function orderSearchText(order) {
  const item = orderPrimaryItem(order);
  const shipment = order.expressShipment || {};
  const expressInfo = order.expressInfo || {};
  return [
    order.id,
    saleTypeText(order.saleType),
    order.buyerPhone,
    order.pickupCode,
    order.pickupPointName,
    item.productName,
    item.skuName,
    item.packageLabel,
    shipment.company,
    shipment.trackingNo,
    expressInfo.receiver,
    expressInfo.phone,
    expressInfo.address,
    orderFulfillmentText(order)
  ].filter(Boolean).join(' ').toLowerCase();
}

function orderBatchName(order) {
  const item = orderPrimaryItem(order);
  return order.batchName || item.batchName || '未设置批次';
}

function orderContactName(order) {
  const expressInfo = order.expressInfo || {};
  return order.contactName || expressInfo.receiver || '-';
}

function orderContactPhone(order) {
  const expressInfo = order.expressInfo || {};
  return order.contactPhone || expressInfo.phone || order.buyerPhone || '';
}

function orderDestinationText(order) {
  const expressInfo = order.expressInfo || {};
  return order.destinationText || (order.deliveryType === 'express'
    ? expressInfo.address
    : order.pickupPointName) || '-';
}

function orderFulfillmentText(order) {
  return [order.fulfillmentStart, order.fulfillmentEnd].filter(Boolean).join(' 至 ') || '-';
}

function displayDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

function isTextDateInRange(value, start, end) {
  const text = String(value || '').trim();
  if (!text) return !start && !end;
  if (start && text < start) return false;
  if (end && text > end) return false;
  return true;
}

function orderFulfillmentStatusText(order) {
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
    if (order.status === 'awaiting_shipment') return '自提待发';
    if (order.status === 'pickup_shipped') return '自提点已到货';
    if (order.status === 'awaiting_pickup') return '自提待发';
    if (['picked_up', 'completed'].includes(order.status)) return '自提已领取';
  }
  return statusText(order.status);
}

function hasReceivedRecord(order) {
  return Boolean(order && (order.pickedUpAt || order.completedAt));
}

function orderIsReceivedForDelivery(order, deliveryType) {
  if (!order || order.deliveryType !== deliveryType) return false;
  if (['picked_up', 'completed'].includes(order.status)) return true;
  return ['after_sale', 'refunded'].includes(order.status) && hasReceivedRecord(order);
}

function orderMatchesStatusFilter(order, statusFilter) {
  if (!statusFilter || statusFilter === 'all') return true;
  if (statusFilter === 'express_awaiting_shipment') {
    return order.deliveryType === 'express' && order.status === 'awaiting_shipment';
  }
  if (statusFilter === 'pickup_awaiting_shipment') {
    return order.deliveryType === 'pickup' && ['awaiting_shipment', 'awaiting_pickup'].includes(order.status);
  }
  if (statusFilter === 'pickup_shipped') {
    return order.deliveryType === 'pickup' && order.status === 'pickup_shipped';
  }
  if (statusFilter === 'shipped') {
    return order.deliveryType === 'express' && order.status === 'shipped';
  }
  if (statusFilter === 'express_received') {
    return orderIsReceivedForDelivery(order, 'express');
  }
  if (statusFilter === 'pickup_received') {
    return orderIsReceivedForDelivery(order, 'pickup');
  }
  return order.status === statusFilter;
}

function orderMatchesStatsBucket(order, bucket) {
  const receivedAt = new Date(order.pickedUpAt || order.completedAt || '').getTime();
  const received = ['picked_up', 'completed'].includes(order.status) || (order.status === 'after_sale' && Number.isFinite(receivedAt));
  const afterSalePending = order.afterSaleInfo && !['refunded', 'rejected'].includes(String(order.afterSaleInfo.status || ''));
  if (bucket === 'completed1') return received && !order.afterSaleInfo && Number.isFinite(receivedAt) && Date.now() - receivedAt >= 24 * 60 * 60 * 1000;
  if (bucket === 'completed2') return (received && Number.isFinite(receivedAt) && Date.now() - receivedAt < 24 * 60 * 60 * 1000) || afterSalePending;
  if (bucket === 'expressSent') return order.deliveryType === 'express' && !['awaiting_payment', 'awaiting_shipment', 'cancelled'].includes(order.status);
  if (bucket === 'pickupSent') return order.deliveryType === 'pickup' && ['pickup_shipped', 'picked_up', 'completed', 'after_sale', 'refunded'].includes(order.status);
  if (bucket === 'refunded') return isOrderRefundProcessed(order);
  return true;
}

function isOrderRefundProcessed(order) {
  return Boolean(order && (
    order.status === 'refunded'
    || order.refundedAt
    || String(order.afterSaleInfo && order.afterSaleInfo.status || '') === 'refunded'
    || String(order.wechatRefund && order.wechatRefund.status || '').toUpperCase() === 'SUCCESS'
  ));
}

function isOrderRefundProcessing(order) {
  const status = String(order && order.wechatRefund && order.wechatRefund.status || '').toUpperCase();
  return Boolean(order && (
    String(order.afterSaleInfo && order.afterSaleInfo.status || '') === 'refund_processing'
    || ['PENDING_SUBMIT', 'PROCESSING'].includes(status)
  ));
}

function hasAfterSaleRequest(order) {
  const info = order && order.afterSaleInfo;
  return Boolean(info && (
    info.reason
    || info.status
    || info.requestedAt
    || Number(info.refundAmount || 0) > 0
  ));
}

function canShowAfterSaleInfo(order) {
  return hasAfterSaleRequest(order) && ['after_sale', 'refunded'].includes(String(order.status || ''));
}

function canProcessRefund(order) {
  return hasAfterSaleRequest(order) && String(order.status || '') === 'after_sale' && !isOrderRefundProcessed(order) && !isOrderRefundProcessing(order);
}

function syncPendingPaymentVisibility() {
  const filter = $('#orderStatusFilter');
  const option = filter ? filter.querySelector('option[value="awaiting_payment"]') : null;
  if (!filter || !option) return;
  option.hidden = !state.showPendingPaymentOrders;
  option.disabled = !state.showPendingPaymentOrders;
  option.style.display = state.showPendingPaymentOrders ? '' : 'none';
  if (!state.showPendingPaymentOrders && filter.value === 'awaiting_payment') {
    filter.value = 'all';
  }
}

async function showPendingPaymentOrdersSetting() {
  const values = await showForm({
    title: '待支付订单显示',
    eyebrow: '隐藏设置',
    message: '关闭后仅隐藏后台展示，不会删除数据库里的待支付订单。',
    fields: [{
      name: 'showPendingPaymentOrders',
      label: '显示待支付订单',
      type: 'checkbox',
      value: state.showPendingPaymentOrders,
      help: '开启后和现在一样；关闭后下拉不显示“待支付”，全部状态表格也过滤待支付订单。'
    }],
    confirmText: '保存设置'
  });
  if (!values) return;
  state.showPendingPaymentOrders = Boolean(values.showPendingPaymentOrders);
  writeBoolSetting(ORDER_SETTINGS_KEYS.showPendingPaymentOrders, state.showPendingPaymentOrders);
  syncPendingPaymentVisibility();
  state.orderPage = 1;
  renderOrders();
  toast(state.showPendingPaymentOrders ? '已显示待支付订单' : '已隐藏待支付订单');
}

function handleOrderTabSecretClick() {
  orderTabSecretClicks += 1;
  clearTimeout(orderTabSecretTimer);
  orderTabSecretTimer = setTimeout(() => {
    orderTabSecretClicks = 0;
  }, 5000);
  if (orderTabSecretClicks < 5) return;
  orderTabSecretClicks = 0;
  clearTimeout(orderTabSecretTimer);
  showPendingPaymentOrdersSetting();
}

function filteredOrders() {
  syncPendingPaymentVisibility();
  const statusFilter = $('#orderStatusFilter') ? $('#orderStatusFilter').value : 'all';
  const deliveryFilter = $('#orderDeliveryFilter') ? $('#orderDeliveryFilter').value : 'all';
  const saleTypeFilter = $('#orderSaleTypeFilter') ? $('#orderSaleTypeFilter').value : 'all';
  const batchFilter = ($('#orderBatchFilter') ? $('#orderBatchFilter').value : '').trim().toLowerCase();
  const destinationFilter = ($('#orderDestinationFilter') ? $('#orderDestinationFilter').value : '').trim().toLowerCase();
  const fulfillmentStartFilter = ($('#orderFulfillmentStartFilter') ? $('#orderFulfillmentStartFilter').value : '').trim();
  const fulfillmentEndFilter = ($('#orderFulfillmentEndFilter') ? $('#orderFulfillmentEndFilter').value : '').trim();
  const keyword = ($('#orderKeyword') ? $('#orderKeyword').value : '').trim().toLowerCase();
  return state.orders.filter((order) => {
    if (!state.showPendingPaymentOrders && order.status === 'awaiting_payment') return false;
    if (!orderMatchesStatusFilter(order, statusFilter)) return false;
    if (deliveryFilter !== 'all' && order.deliveryType !== deliveryFilter) return false;
    if (saleTypeFilter !== 'all' && (order.saleType || 'presale') !== saleTypeFilter) return false;
    if (batchFilter && !orderBatchName(order).toLowerCase().includes(batchFilter)) return false;
    if (destinationFilter && !orderDestinationText(order).toLowerCase().includes(destinationFilter)) return false;
    if (!isTextDateInRange(order.fulfillmentStart, fulfillmentStartFilter, '')) return false;
    if (!isTextDateInRange(order.fulfillmentEnd, '', fulfillmentEndFilter)) return false;
    if (!keyword) return true;
    return orderSearchText(order).includes(keyword);
  });
}

function renderOrdersPagination(total) {
  const target = $('#ordersPagination');
  if (!target) return;
  const pageSize = Math.max(1, Number(state.orderPageSize || 20));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  state.orderPage = Math.min(Math.max(1, Number(state.orderPage || 1)), totalPages);
  target.innerHTML = `
    <button class="ghost small" data-action="order-page" data-page="${state.orderPage - 1}" ${state.orderPage <= 1 ? 'disabled' : ''}>上一页</button>
    <span>第 ${state.orderPage} / ${totalPages} 页</span>
    <button class="ghost small" data-action="order-page" data-page="${state.orderPage + 1}" ${state.orderPage >= totalPages ? 'disabled' : ''}>下一页</button>
  `;
}

function renderOrders() {
  const orders = filteredOrders();
  const pageSize = Math.max(1, Number(state.orderPageSize || 20));
  const totalPages = Math.max(1, Math.ceil(orders.length / pageSize));
  state.orderPage = Math.min(Math.max(1, Number(state.orderPage || 1)), totalPages);
  const pageOrders = orders.slice((state.orderPage - 1) * pageSize, state.orderPage * pageSize);
  const toolbar = $('#ordersToolbar');
  if (toolbar) {
    const start = orders.length ? (state.orderPage - 1) * pageSize + 1 : 0;
    const end = Math.min(state.orderPage * pageSize, orders.length);
    toolbar.innerHTML = `
      <div>
        <strong>订单数据表</strong>
        <span>筛选后 ${orders.length} 单，当前 ${start}-${end} 单</span>
      </div>
      <div class="table-hint">横向滚动查看完整字段；一行就是一个订单。</div>
    `;
  }
  renderOrdersPagination(orders.length);
  if (!pageOrders.length) {
    $('#ordersList').innerHTML = '<div class="card">暂无匹配订单。可以调整筛选条件或刷新订单。</div>';
    return;
  }
  $('#ordersList').innerHTML = `
    <div class="table-card data-grid-card">
      <table class="admin-table orders-table data-grid-table">
        <colgroup>
          <col style="width: 105px" />
          <col style="width: 76px" />
          <col style="width: 86px" />
          <col style="width: 104px" />
          <col style="width: 220px" />
          <col style="width: 72px" />
          <col style="width: 270px" />
          <col style="width: 90px" />
          <col style="width: 112px" />
          <col style="width: 112px" />
          <col style="width: 176px" />
          <col style="width: 176px" />
          <col style="width: 210px" />
        </colgroup>
        <thead>
          <tr>
            <th>批次名称</th>
            <th>销售类型</th>
            <th>订单联系人</th>
            <th>手机号</th>
            <th>订单编号</th>
            <th>配送方式</th>
            <th>自提点/快递地址</th>
            <th>订单状态</th>
            <th>履约开始</th>
            <th>履约截止</th>
            <th>下单时间</th>
            <th>付款时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${pageOrders.map((order) => {
    const item = orderPrimaryItem(order);
    const shipment = order.expressShipment || {};
    const orderId = escapeHtml(order.id);
    const itemText = [item.productName, item.skuName || item.packageLabel, `× ${item.quantity || 1}`, `实付 ¥${money(order.payAmount)}`].filter(Boolean).join('｜');
    const destination = orderDestinationText(order);
    const shipmentText = order.deliveryType === 'express'
      ? [shipment.company, shipment.trackingNo].filter(Boolean).join('｜')
      : (order.pickupCode ? `核销码 ${order.pickupCode}` : '');
    const destinationTitle = [destination, shipmentText, itemText].filter(Boolean).join('｜');
    const showAfterSaleInfo = canShowAfterSaleInfo(order);
    const afterSaleText = showAfterSaleInfo
      ? `${afterSaleStatusText(order.afterSaleInfo.status)}｜${order.afterSaleInfo.reason || ''}｜退款 ¥${money(order.afterSaleInfo.refundAmount)}`
      : '暂无售后';
    const canMarkPickupReceived = order.deliveryType === 'pickup' && order.status === 'pickup_shipped';
    return `
      <tr title="${escapeHtml(itemText)}">
        <td class="cell-ellipsis" title="${escapeHtml(orderBatchName(order))}">${escapeHtml(orderBatchName(order))}</td>
        <td>${escapeHtml(saleTypeText(order.saleType))}</td>
        <td class="cell-ellipsis" title="${escapeHtml(orderContactName(order))}">${escapeHtml(orderContactName(order))}</td>
        <td class="cell-mono">${escapeHtml(maskPhone(orderContactPhone(order)))}</td>
        <td class="cell-mono cell-ellipsis" title="${orderId}">${orderId}</td>
        <td>${escapeHtml(deliveryTypeText(order.deliveryType))}</td>
        <td class="cell-ellipsis" title="${escapeHtml(destinationTitle)}">${escapeHtml(destination)}</td>
        <td title="${escapeHtml(afterSaleText)}"><span class="status-pill">${escapeHtml(orderFulfillmentStatusText(order))}</span></td>
        <td class="cell-ellipsis" title="${escapeHtml(order.fulfillmentStart || '-')}">${escapeHtml(order.fulfillmentStart || '-')}</td>
        <td class="cell-ellipsis" title="${escapeHtml(order.fulfillmentEnd || '-')}">${escapeHtml(order.fulfillmentEnd || '-')}</td>
        <td class="cell-time" title="${escapeHtml(displayDateTime(order.createdAt))}">${escapeHtml(displayDateTime(order.createdAt))}</td>
        <td class="cell-time" title="${escapeHtml(displayDateTime(order.paidAt))}">${escapeHtml(displayDateTime(order.paidAt))}</td>
        <td>
          <div class="order-table-actions">
            <button class="link-btn" data-action="view-order" data-id="${orderId}">查看详情</button>
            ${showAfterSaleInfo ? `<button class="link-btn" data-action="order-after-sale" data-id="${orderId}">售后信息</button>` : ''}
            ${canProcessRefund(order) ? `<button class="link-btn danger-link" data-action="order-refund" data-id="${orderId}">退款处理</button>` : ''}
            ${order.status === 'awaiting_payment' ? `<button class="link-btn" data-action="order-pay" data-id="${orderId}">确认支付</button>` : ''}
            ${order.deliveryType === 'pickup' && order.status === 'awaiting_pickup' ? `<button class="link-btn" data-action="order-status" data-status="pickup_shipped" data-id="${orderId}">确认到货</button>` : ''}
            ${canMarkPickupReceived ? `<button class="link-btn" data-action="order-status" data-status="picked_up" data-id="${orderId}">已领取</button>` : ''}
            ${order.status !== 'awaiting_payment' ? `<button class="link-btn" data-action="order-print-label" data-id="${orderId}">重打标签</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function maskPhone(phone) {
  const text = String(phone || '');
  return /^1\d{10}$/.test(text) ? `${text.slice(0, 3)}****${text.slice(7)}` : text;
}

function canSyncWechatShipping(order) {
  if (!order || order.status === 'awaiting_payment') return false;
  if (order.deliveryType === 'express') return order.status === 'shipped' && order.expressShipment && order.expressShipment.trackingNo;
  if (order.deliveryType === 'pickup') return ['pickup_shipped', 'picked_up', 'completed', 'after_sale', 'refunded'].includes(order.status);
  return false;
}

function wechatShippingStatusText(order) {
  const info = order && order.wechatShipping || {};
  if (info.status === 'success') return `已同步${info.syncedAt ? `｜${displayDateTime(info.syncedAt)}` : ''}`;
  if (info.status === 'failed') return `同步失败｜${info.error || '请重试'}`;
  if (canSyncWechatShipping(order)) return '待同步';
  return '暂不需要同步';
}

function renderWhitelist() {
  const target = $('#whitelistList');
  if (!target) return;
  target.innerHTML = (state.whitelistEntries || []).map((entry) => `
    <article class="item no-image">
      <div>
        <h3>${escapeHtml(maskPhone(entry.phone))}</h3>
        <div class="meta">${escapeHtml(entry.label || '白名单折扣')}｜${escapeHtml(entry.discountPercent)} 折｜${escapeHtml(entry.source || '')}</div>
        <div class="meta">适用商品：${escapeHtml(formatProductScope(entry.productIds))}</div>
        <div class="meta">导入时间：${escapeHtml(entry.importedAt || '-')}</div>
      </div>
      <div class="actions">
        <button class="danger" data-action="delete-whitelist-rule" data-phone="${escapeHtml(entry.phone)}" data-rule-id="${escapeHtml(entry.ruleId || '')}">删除本规则</button>
      </div>
    </article>
  `).join('') || '<div class="card">暂无白名单手机号</div>';
}

function renderCoupons() {
  const target = $('#couponsList');
  if (!target) return;
  target.innerHTML = (state.coupons || []).map((coupon) => {
    const value = coupon.type === 'amount' ? `¥${money(coupon.value)}` : `${coupon.value} 折扣百分比`;
    const threshold = Number(coupon.minOrderAmount || 0) > 0 ? `满 ¥${money(coupon.minOrderAmount)} 可用` : '无门槛';
    const limit = coupon.usageLimit > 0 ? `${coupon.usedCount || 0}/${coupon.usageLimit}` : `${coupon.usedCount || 0}/不限`;
    const validity = [coupon.startsAt ? `开始 ${coupon.startsAt}` : '', coupon.endsAt ? `结束 ${coupon.endsAt}` : ''].filter(Boolean).join('｜') || '长期有效';
    return `
      <article class="item no-image">
        <div>
          <h3>${escapeHtml(coupon.code)}｜${coupon.enabled ? '启用' : '停用'}</h3>
          <div class="meta">${coupon.type === 'amount' ? '金额券' : '折扣券'}｜优惠值 ${escapeHtml(value)}｜${escapeHtml(threshold)}｜来源：${escapeHtml(coupon.source || '-')}</div>
          <div class="meta">适用商品：${escapeHtml(formatProductScope(coupon.productIds))}</div>
          <div class="meta">使用：${limit}｜每手机号 ${coupon.perPhoneLimit || '不限'} 次｜累计抵扣 ¥${money(coupon.usedAmount)}</div>
          <div class="meta">${escapeHtml(validity)}</div>
        </div>
        <div class="actions">
          <button class="ghost" data-action="edit-coupon" data-code="${escapeHtml(coupon.code)}">编辑</button>
          <button class="ghost" data-action="toggle-coupon" data-code="${escapeHtml(coupon.code)}" data-enabled="${!coupon.enabled}">${coupon.enabled ? '停用' : '启用'}</button>
          <button class="danger" data-action="delete-coupon" data-code="${escapeHtml(coupon.code)}">删除</button>
        </div>
      </article>
    `;
  }).join('') || '<div class="card">暂无优惠码</div>';
}

function renderAll() {
  renderStats();
  renderDashboard();
  renderOrderBusinessStats();
  renderProducts();
  renderPickupPoints();
  renderProductPickupPointChoices(checkedValues('#productPickupPointChoices input[type="checkbox"]:checked'));
  renderWhitelistProductChoices(checkedValues('#whitelistProductChoices input[type="checkbox"]:checked'));
  renderCouponProductChoices(checkedValues('#couponProductChoices input[type="checkbox"]:checked'));
  renderShippingRule();
  renderWhitelist();
  renderCoupons();
  renderOrders();
}

async function load() {
  const data = await api('/api/bootstrap');
  Object.assign(state, data);
  renderAll();
}

function productPayload(form) {
  const data = formData(form);
  const saleType = normalizeSaleType(data.saleType);
  const selectedDeliveryMethods = [data.deliveryPickup ? 'pickup' : '', data.deliveryExpress ? 'express' : ''].filter(Boolean);
  const boxDeliveryMethods = selectedDeliveryMethods.length ? selectedDeliveryMethods : ['pickup'];
  const bagDeliveryMethods = ['pickup'];
  const skus = [];
  if (data.packageBox) {
    const price = centsFromYuan(data.boxSalePriceYuan);
    skus.push({
      packageType: 'box',
      label: '盒装',
      name: `${data.weightText || '默认规格'}盒装`,
      weightText: data.weightText,
      price,
      salePrice: price,
      stock: Number(data.boxStock || 0),
      deliveryMethods: boxDeliveryMethods
    });
  }
  if (data.packageBag) {
    const price = centsFromYuan(data.bagSalePriceYuan);
    skus.push({
      packageType: 'bag',
      label: '袋装',
      name: `${data.weightText || '默认规格'}袋装`,
      weightText: data.weightText,
      price,
      salePrice: price,
      stock: Number(data.bagStock || 0),
      deliveryMethods: bagDeliveryMethods
    });
  }
  const deliveryMethods = [...new Set(skus.flatMap((sku) => sku.deliveryMethods || []))];
  const productPriceCents = skus.length ? Math.min(...skus.map((sku) => sku.price)) : 0;
  const productSalePriceCents = skus.length ? Math.min(...skus.map((sku) => sku.salePrice)) : 0;
  return {
    id: data.id || undefined,
    name: data.name,
    subtitle: data.subtitle,
    coverImage: data.coverImage,
    imagesText: data.imagesText,
    priceCents: productPriceCents,
    salePriceCents: productSalePriceCents,
    saleType,
    weightText: data.weightText,
    boxStock: Number(data.boxStock || 0),
    bagStock: Number(data.bagStock || 0),
    skus,
    tagsText: data.tagsText,
    batchName: String(data.batchName || '').trim(),
    customerContact: String(data.customerContact || '').trim(),
    customerPhone: String(data.customerPhone || '').trim(),
    pickupValidHours: Math.max(0, Math.floor(Number(data.pickupValidHours || 0))),
    shipStart: saleType === 'direct' ? '' : data.shipStart,
    shipEnd: saleType === 'direct' ? '' : data.shipEnd,
    orderDeadline: saleType === 'direct' ? '' : data.orderDeadline,
    presaleNote: data.presaleNote,
    detailText: data.detailText,
    packageBox: data.packageBox,
    packageBag: data.packageBag,
    deliveryPickup: data.deliveryPickup,
    deliveryExpress: data.deliveryExpress,
    pickupPointIds: checkedValues('#productPickupPointChoices input[type="checkbox"]:checked'),
    status: 'on_sale'
  };
}

function pickupPayload(form) {
  const data = formData(form);
  return {
    id: data.id || undefined,
    name: data.name,
    address: data.address,
    phone: data.phone,
    openTime: data.openTime,
    loginAccount: data.loginAccount,
    loginPassword: data.loginPassword,
    dailyCapacity: Number(data.dailyCapacity || 0),
    sortWeight: Number(data.sortWeight || 0),
    notice: data.notice,
    packageBox: data.packageBox,
    packageBag: data.packageBag,
    enabled: data.enabled
  };
}

function couponPayload(form) {
  const data = formData(form);
  const type = data.type === 'percent' ? 'percent' : 'amount';
  const rawValue = Number(data.valueText || 0);
  return {
    originalCode: String(data.originalCode || '').trim().toUpperCase(),
    code: String(data.code || '').trim().toUpperCase(),
    type,
    value: type === 'amount' ? Math.round(rawValue * 100) : Math.round(rawValue),
    minOrderAmount: Math.round(Number(data.minOrderAmountYuan || 0) * 100),
    source: data.source,
    productIds: checkedValues('#couponProductChoices input[type="checkbox"]:checked'),
    enabled: data.enabled,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    usageLimit: Number(data.usageLimit || 0),
    perPhoneLimit: Number(data.perPhoneLimit || 0)
  };
}

function couponToForm(coupon) {
  return {
    originalCode: coupon.code,
    code: coupon.code,
    type: coupon.type,
    valueText: coupon.type === 'amount' ? money(coupon.value) : coupon.value,
    minOrderAmountYuan: money(coupon.minOrderAmount),
    source: coupon.source,
    productIds: coupon.productIds || [],
    enabled: coupon.enabled,
    startsAt: coupon.startsAt,
    endsAt: coupon.endsAt,
    usageLimit: coupon.usageLimit,
    perPhoneLimit: coupon.perPhoneLimit
  };
}

function resetCouponForm() {
  const form = $('#couponForm');
  if (!form) return;
  form.reset();
  form.elements.type.value = 'amount';
  form.elements.minOrderAmountYuan.value = 0;
  form.elements.usageLimit.value = 0;
  form.elements.perPhoneLimit.value = 1;
  form.elements.enabled.checked = true;
  form.elements.originalCode.value = '';
  form.elements.code.readOnly = false;
  renderCouponProductChoices([]);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ordersToCsvText(orders) {
  const header = ['批次名称', '销售类型', '订单联系人', '手机号', '订单编号', '配送方式', '自提点/快递地址', '订单状态', '商品', '规格', '数量', '实付元', '下单时间', '付款时间'];
  const rows = (orders || []).map((order) => {
    const item = orderPrimaryItem(order);
    return [
      orderBatchName(order),
      saleTypeText(order.saleType),
      orderContactName(order),
      orderContactPhone(order),
      order.id,
      deliveryTypeText(order.deliveryType),
      orderDestinationText(order),
      orderFulfillmentStatusText(order),
      item.productName || '',
      item.skuName || item.packageLabel || '',
      item.quantity || 1,
      money(order.payAmount),
      displayDateTime(order.createdAt),
      displayDateTime(order.paidAt)
    ];
  });
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n')}`;
}

function downloadText(filename, text, mimeType = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function splitCsvLine(line) {
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

function parseImportRows(text, type) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const first = splitCsvLine(lines[0]);
  const headerLike = first.some((cell) => /订单|order|快递|物流|运单|公司|备注|贴单/i.test(cell));
  const headers = headerLike ? first : [];
  const dataLines = headerLike ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cells = splitCsvLine(line);
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function importShipmentFile(file, type) {
  const filename = file && file.name || '';
  if (!/\.xlsx$/i.test(filename)) throw new Error('请选择 Excel（.xlsx）文件');
  const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
  const path = type === 'express' ? '/api/orders/import-express-shipments' : '/api/orders/import-pickup-shipments';
  const response = await api(path, {
    method: 'POST',
    body: JSON.stringify({ filename, contentBase64 })
  });
  const result = response.result || {};
  if (Array.isArray(response.orders)) state.orders = response.orders;
  state.orderBusinessStats = (await api('/api/order-stats')).orderBusinessStats;
  const importResult = $('#importResult');
  if (importResult) {
    const shippingSyncFailed = (result.matched || []).filter((item) => item.wechatShipping && !item.wechatShipping.ok && !item.wechatShipping.skipped);
    const shippingSyncSkipped = (result.matched || []).filter((item) => item.wechatShipping && item.wechatShipping.skipped);
    importResult.hidden = false;
    importResult.innerHTML = `
      <strong>${type === 'express' ? '快递' : '自提'}导入结果：</strong>
      匹配 ${result.matched && result.matched.length || 0} 条，
      未匹配 ${result.unmatched && result.unmatched.length || 0} 条，
      跳过 ${result.skipped && result.skipped.length || 0} 条。
      ${shippingSyncFailed.length ? `<div>微信发货同步失败 ${shippingSyncFailed.length} 条，可在订单操作中重试。</div>` : ''}
      ${shippingSyncSkipped.length ? `<div>微信发货同步跳过 ${shippingSyncSkipped.length} 条。</div>` : ''}
      ${(result.unmatched || []).slice(0, 5).map((item) => `<div>${escapeHtml(item.orderId || '-')}：${escapeHtml(item.reason || '')}</div>`).join('')}
    `;
  }
  renderOrders();
  renderOrderBusinessStats();
  toast(`${type === 'express' ? '快递' : '自提'}发货信息已导入`);
}

function printOrdersDocument(title, orders) {
  const rows = (orders || []).map((order) => {
    const item = orderPrimaryItem(order);
    return `
      <tr>
        <td>${escapeHtml(orderBatchName(order))}</td>
        <td>${escapeHtml(order.id)}</td>
        <td>${escapeHtml(orderContactName(order))}</td>
        <td>${escapeHtml(maskPhone(orderContactPhone(order)))}</td>
        <td>${escapeHtml(deliveryTypeText(order.deliveryType))}</td>
        <td>${escapeHtml(orderDestinationText(order))}</td>
        <td>${escapeHtml(item.productName || '')}</td>
        <td>${escapeHtml(item.skuName || item.packageLabel || '')} × ${escapeHtml(item.quantity || 1)}</td>
        <td>${escapeHtml(orderFulfillmentStatusText(order))}</td>
      </tr>
    `;
  }).join('');
  const win = window.open('', '_blank');
  if (!win) {
    toast('浏览器拦截了打印窗口，请允许弹窗');
    return;
  }
  win.document.write(`
    <html><head><title>${escapeHtml(title)}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:24px;color:#111827}
      h1{font-size:20px;margin:0 0 14px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
      th{background:#f3f4f6}
    </style></head><body>
    <h1>${escapeHtml(title)}（${orders.length} 条）</h1>
    <table><thead><tr><th>批次</th><th>订单号</th><th>联系人</th><th>手机号</th><th>配送</th><th>地址/自提点</th><th>商品</th><th>规格</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>
  `);
  win.document.close();
  win.focus();
  win.print();
}

function isPickupAwaitingPrintOrder(order) {
  return order
    && order.deliveryType === 'pickup'
    && ['awaiting_pickup', 'awaiting_shipment'].includes(order.status);
}

function currentPrintOrders(type) {
  const limit = Math.max(1, Number($('#printOrderLimit') ? $('#printOrderLimit').value : 20) || 20);
  return filteredOrders()
    .filter((order) => {
      if (type === 'pickup-awaiting') return isPickupAwaitingPrintOrder(order);
      return type === 'all' || order.deliveryType === type;
    })
    .slice(0, limit);
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '进入中...', async () => {
      const data = formData(form);
      const session = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: data.username, password: data.password })
      });
      form.reset();
      showAdmin(session);
      await load();
      toast('已进入管理员后台');
    });
  });

  $('#logoutBtn').addEventListener('click', async (event) => {
    await withButtonLock(event.currentTarget, '退出中...', async () => {
      await api('/api/logout', { method: 'POST', body: JSON.stringify({}) });
      showLogin('已退出登录');
      toast('已退出登录');
    });
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.target === 'ordersPanel') handleOrderTabSecretClick();
      $$('.tab').forEach((item) => item.classList.remove('active'));
      $$('.panel').forEach((panel) => panel.classList.remove('active'));
      tab.classList.add('active');
      $(`#${tab.dataset.target}`).classList.add('active');
    });
  });

  $('#productForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '保存中...', async () => {
      const payload = productPayload(form);
      if (!payload.batchName) return toast('请输入批次名称');
      if (!payload.packageBox && !payload.packageBag) return toast('至少选择一种包装');
      const priceError = validateProductPrices(payload);
      if (priceError) return toast(priceError);
      const stockError = validateProductStock(payload);
      if (stockError) return toast(stockError);
      const scheduleError = validateProductSchedule(payload);
      if (scheduleError) return toast(scheduleError);
      if (!payload.deliveryPickup && !payload.deliveryExpress) return toast('至少选择一种配送');
      if (payload.deliveryPickup && !payload.pickupPointIds.length) return toast('请选择该商品适用的自提点');
      if (payload.deliveryPickup && Number(payload.pickupValidHours || 0) <= 0) return toast('请填写自提有效期时长');
      const incompatiblePoints = findIncompatiblePickupPoints(payload);
      if (payload.deliveryPickup && incompatiblePoints.length) {
        return toast(`以下自提点不支持当前商品包装：${incompatiblePoints.map((point) => point.name).join('、')}`);
      }
      if (payload.id) await api(`/api/products/${encodeURIComponent(payload.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      form.elements.packageBox.checked = true;
      form.elements.deliveryPickup.checked = true;
      syncProductSaleTypeFields(form);
      renderProductPickupPointChoices([]);
      updateCoverPreview('');
      resetUploadHint();
      await load();
      toast('商品已保存');
    });
  });

  $('#coverImageFile').addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      event.currentTarget.value = '';
      toast('仅支持 PNG/JPG/WEBP 图片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      event.currentTarget.value = '';
      toast('图片不能超过 5MB');
      return;
    }
    const uploadHint = $('#uploadHint');
    try {
      uploadHint.textContent = '图片上传中...';
      const uploaded = await uploadImage(file);
      $('#productForm').elements.coverImage.value = uploaded.url;
      updateCoverPreview(uploaded.url);
      uploadHint.textContent = `已上传：${uploaded.originalName || uploaded.filename}，保存商品后生效。`;
      toast('图片已上传');
    } catch (error) {
      uploadHint.textContent = '上传失败，请重试。';
      toast(error.message);
    } finally {
      event.currentTarget.value = '';
    }
  });

  $('#galleryImageFile').addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    const galleryUploadHint = $('#galleryUploadHint');
    try {
      galleryUploadHint.textContent = '详情图上传中...';
      const uploaded = await uploadImage(file);
      const field = $('#productForm').elements.imagesText;
      const current = String(field.value || '').split(/\n+/).map((item) => item.trim()).filter(Boolean);
      if (!current.includes(uploaded.url)) current.push(uploaded.url);
      field.value = current.join('\n');
      galleryUploadHint.textContent = `已追加：${uploaded.originalName || uploaded.filename}`;
      toast('详情图已上传');
    } catch (error) {
      galleryUploadHint.textContent = '详情图上传失败，请重试。';
      toast(error.message);
    } finally {
      event.currentTarget.value = '';
    }
  });

  $('#resetProductBtn').addEventListener('click', () => {
    $('#productForm').reset();
    $('#productForm').elements.packageBox.checked = true;
    $('#productForm').elements.deliveryPickup.checked = true;
    syncProductSaleTypeFields($('#productForm'));
    renderProductPickupPointChoices([]);
    updateCoverPreview('');
    resetUploadHint();
  });

  $('#selectAllProductPickupBtn')?.addEventListener('click', () => {
    setChoiceChecked('#productPickupPointChoices input[type="checkbox"]', true);
  });
  $('#productForm').elements.saleType?.addEventListener('change', (event) => {
    syncProductSaleTypeFields(event.currentTarget.form);
  });
  $('#productForm').elements.saleType?.addEventListener('input', (event) => {
    syncProductSaleTypeFields(event.currentTarget.form);
  });
  $('#productForm').addEventListener('change', (event) => {
    if (event.target && event.target.name === 'saleType') syncProductSaleTypeFields(event.currentTarget);
  });
  syncProductSaleTypeFields($('#productForm'));

  $('#clearProductPickupBtn')?.addEventListener('click', () => {
    setChoiceChecked('#productPickupPointChoices input[type="checkbox"]', false);
  });

  $('#selectAllWhitelistProductsBtn')?.addEventListener('click', () => {
    setChoiceChecked('#whitelistProductChoices input[type="checkbox"]', true);
  });

  $('#clearWhitelistProductsBtn')?.addEventListener('click', () => {
    setChoiceChecked('#whitelistProductChoices input[type="checkbox"]', false);
  });

  $('#downloadWhitelistTemplateBtn')?.addEventListener('click', () => {
    window.open('/api/whitelist/template.xlsx', '_blank');
  });

  $('#whitelistImportFile')?.addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    const hint = $('#whitelistImportHint');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5MB');
      if (hint) hint.textContent = '正在识别文件里的手机号...';
      const contentBase64 = await readFileAsBase64(file);
      const data = await api('/api/whitelist/import-file', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentBase64
        })
      });
      const total = mergeWhitelistPhones(data.phones || []);
      if (hint) hint.textContent = `已从 ${file.name} 识别 ${data.count || 0} 个手机号，当前列表共 ${total} 个。`;
      toast(`已导入 ${data.count || 0} 个手机号`);
    } catch (error) {
      if (hint) hint.textContent = '导入失败，请检查文件格式或手机号列。';
      toast(error.message);
    } finally {
      event.currentTarget.value = '';
    }
  });

  $('#selectAllCouponProductsBtn')?.addEventListener('click', () => {
    setChoiceChecked('#couponProductChoices input[type="checkbox"]', true);
  });

  $('#clearCouponProductsBtn')?.addEventListener('click', () => {
    setChoiceChecked('#couponProductChoices input[type="checkbox"]', false);
  });

  $('#pickupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '保存中...', async () => {
      const payload = pickupPayload(form);
      if (payload.id) await api(`/api/pickup-points/${encodeURIComponent(payload.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/pickup-points', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      form.elements.packageBox.checked = true;
      form.elements.packageBag.checked = true;
      form.elements.enabled.checked = true;
      await load();
      toast('自提点已保存');
    });
  });

  $('#resetPickupBtn').addEventListener('click', () => {
    $('#pickupForm').reset();
    $('#pickupForm').elements.packageBox.checked = true;
    $('#pickupForm').elements.packageBag.checked = true;
    $('#pickupForm').elements.enabled.checked = true;
  });

  $('#shippingForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '保存中...', async () => {
      const data = formData(form);
      await api('/api/shipping-rule', {
        method: 'PUT',
        body: JSON.stringify({
          localExpressFee: Math.round(Number(data.localExpressFeeYuan || 0) * 100),
          remoteExpressFee: Math.round(Number(data.remoteExpressFeeYuan || 0) * 100),
          expressBaseFee: Math.round(Number(data.remoteExpressFeeYuan || 0) * 100),
          freeShippingThreshold: Math.round(Number(data.freeShippingThresholdYuan || 0) * 100),
          pickupFee: Math.round(Number(data.pickupFeeYuan || 0) * 100),
          localRegionsText: data.localRegionsText,
          note: data.note
        })
      });
      await load();
      toast('运费规则已保存');
    });
  });

  $('#whitelistForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '导入中...', async () => {
      const data = formData(form);
      if (!String(data.phonesText || '').trim()) return toast('请输入手机号');
      const productIds = checkedValues('#whitelistProductChoices input[type="checkbox"]:checked');
      if (!productIds.length) return toast('请选择白名单适用商品');
      await api('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({
          phonesText: data.phonesText,
          discountPercent: Number(data.discountPercent || 80),
          label: data.label || '白名单折扣',
          productIds
        })
      });
      form.reset();
      form.elements.discountPercent.value = 80;
      form.elements.label.value = '白名单折扣';
      const hint = $('#whitelistImportHint');
      if (hint) hint.textContent = '支持导入 Excel(.xlsx)、CSV 或 TXT；系统会自动识别文件里的 11 位手机号并去重。';
      renderWhitelistProductChoices([]);
      await load();
      toast('白名单已导入');
    });
  });

  $('#couponForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withFormLock(form, '保存中...', async () => {
      const payload = couponPayload(form);
      if (!payload.code) return toast('请输入优惠码');
      if (payload.value <= 0) return toast('请输入有效优惠值');
      if (!payload.productIds.length) return toast('请选择优惠码适用商品');
      if (payload.originalCode && payload.code !== payload.originalCode) return toast('编辑已有优惠码不能修改优惠码，请删除后新建');
      if (!payload.originalCode && state.coupons.some((coupon) => coupon.code === payload.code)) return toast('优惠码已存在，请重新输入');
      await api('/api/coupons', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      resetCouponForm();
      await load();
      toast('优惠码已保存');
    });
  });

  $('#releaseExpiredBtn').addEventListener('click', async (event) => {
    await withButtonLock(event.currentTarget, '释放中...', async () => {
      const result = await api('/api/orders/release-expired', { method: 'POST', body: JSON.stringify({}) });
      await load();
      toast(`已释放 ${result.releasedCount || 0} 个超时待支付订单`);
    });
  });

  $('#reloadOrdersBtn').addEventListener('click', load);
  const resetOrderPage = () => {
    state.orderPage = 1;
    renderOrders();
  };
  $('#orderBatchFilter')?.addEventListener('input', resetOrderPage);
  $('#orderStatusFilter').addEventListener('change', resetOrderPage);
  $('#orderDeliveryFilter').addEventListener('change', resetOrderPage);
  $('#orderSaleTypeFilter')?.addEventListener('change', resetOrderPage);
  $('#orderDestinationFilter')?.addEventListener('input', resetOrderPage);
  $('#orderFulfillmentStartFilter')?.addEventListener('input', resetOrderPage);
  $('#orderFulfillmentEndFilter')?.addEventListener('input', resetOrderPage);
  $('#orderPageSize').addEventListener('change', (event) => {
    state.orderPageSize = Number(event.currentTarget.value || 20);
    resetOrderPage();
  });
  $('#orderKeyword').addEventListener('input', resetOrderPage);
  $('#importExpressBtn')?.addEventListener('click', () => $('#expressImportFile')?.click());
  $('#importPickupBtn')?.addEventListener('click', () => $('#pickupImportFile')?.click());
  $('#downloadExpressTemplateBtn')?.addEventListener('click', () => {
    window.open('/api/orders/import-express-template.xlsx', '_blank');
  });
  $('#downloadPickupTemplateBtn')?.addEventListener('click', () => {
    window.open('/api/orders/import-pickup-template.xlsx', '_blank');
  });
  $('#expressImportFile')?.addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    try {
      await importShipmentFile(file, 'express');
    } catch (error) {
      toast(error.message);
    } finally {
      event.currentTarget.value = '';
    }
  });
  $('#pickupImportFile')?.addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    if (!file) return;
    try {
      await importShipmentFile(file, 'pickup');
    } catch (error) {
      toast(error.message);
    } finally {
      event.currentTarget.value = '';
    }
  });

  $('#printPickupDocsBtn')?.addEventListener('click', () => {
    const orders = currentPrintOrders('pickup-awaiting');
    if (!orders.length) return toast('当前筛选下没有自提待发订单可打印');
    printOrdersDocument('自提单据', orders);
  });
  $('#printDeliveryDocsBtn')?.addEventListener('click', () => {
    const limit = Math.max(1, Number($('#printOrderLimit') ? $('#printOrderLimit').value : 20) || 20);
    if (!currentPrintOrders('all').length) return toast('当前筛选下没有订单可导出');
    const params = new URLSearchParams({
      status: $('#orderStatusFilter').value || 'all',
      deliveryType: $('#orderDeliveryFilter').value || 'all',
      saleType: $('#orderSaleTypeFilter')?.value || 'all',
      batchName: $('#orderBatchFilter')?.value || '',
      destination: $('#orderDestinationFilter')?.value || '',
      fulfillmentStart: $('#orderFulfillmentStartFilter')?.value || '',
      fulfillmentEnd: $('#orderFulfillmentEndFilter')?.value || '',
      keyword: $('#orderKeyword').value || '',
      excludeAwaitingPayment: state.showPendingPaymentOrders ? '' : '1',
      limit: String(limit)
    });
    window.open(`/api/orders/supply.xlsx?${params.toString()}`, '_blank');
  });
  $('#bindPrinterBtn')?.addEventListener('click', async () => {
    try {
      const status = await api('/api/printer/status');
      if (!status.printer || !status.printer.configured) return toast('云打印参数未配置');
      const ok = await showConfirm(`确认绑定芯烨云打印机 ${status.printer.sn} 吗？`, { title: '绑定云打印机', confirmText: '开始绑定' });
      if (!ok) return;
      await api('/api/printer/add', { method: 'POST', body: JSON.stringify({}) });
      await load();
      toast('云打印机绑定请求已提交');
    } catch (error) {
      toast(error.message);
    }
  });
  $('#exportOrdersBtn')?.addEventListener('click', () => {
    const params = new URLSearchParams({
      status: $('#orderStatusFilter').value || 'all',
      deliveryType: $('#orderDeliveryFilter').value || 'all',
      saleType: $('#orderSaleTypeFilter')?.value || 'all',
      batchName: $('#orderBatchFilter')?.value || '',
      destination: $('#orderDestinationFilter')?.value || '',
      fulfillmentStart: $('#orderFulfillmentStartFilter')?.value || '',
      fulfillmentEnd: $('#orderFulfillmentEndFilter')?.value || '',
      keyword: $('#orderKeyword').value || '',
      excludeAwaitingPayment: state.showPendingPaymentOrders ? '' : '1'
    });
    window.open(`/api/orders/export.xlsx?${params.toString()}`, '_blank');
  });

  document.body.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id, status } = button.dataset;
    if (action === 'order-page') {
      state.orderPage = Number(button.dataset.page || 1);
      renderOrders();
      return;
    }
    const lockedActions = new Set([
      'status-product',
      'toggle-pickup',
      'delete-pickup',
      'delete-whitelist-rule',
      'toggle-coupon',
	      'delete-coupon',
	      'order-pay',
	      'order-status',
	      'manual-ship',
	      'order-after-sale',
	      'order-refund',
	      'order-print-label'
	    ]);
	    const runAction = async () => {
    if (action === 'export-stats-bucket') {
      const bucket = button.dataset.bucket || 'all';
      const params = new URLSearchParams({
        bucket,
        excludeAwaitingPayment: state.showPendingPaymentOrders ? '' : '1'
      });
      window.open(`/api/order-stats/export.xlsx?${params.toString()}`, '_blank');
      toast('统计明细已导出 Excel');
    }
    if (action === 'view-order') {
      const order = state.orders.find((item) => item.id === id);
      if (!order) return toast('订单不存在');
      const item = orderPrimaryItem(order);
      const shipment = order.expressShipment || {};
      await showInfo('订单详情', {
        details: [
          { label: '订单编号', value: order.id },
          { label: '批次名称', value: orderBatchName(order) },
          { label: '销售类型', value: saleTypeText(order.saleType) },
          { label: '联系人', value: `${orderContactName(order)}｜${maskPhone(orderContactPhone(order))}` },
          { label: '配送方式', value: deliveryTypeText(order.deliveryType) },
          { label: '自提点/地址', value: orderDestinationText(order) },
          { label: '履约时间', value: orderFulfillmentText(order) },
          { label: '下单时间', value: displayDateTime(order.createdAt) },
          { label: '付款时间', value: displayDateTime(order.paidAt) },
          { label: '商品', value: `${item.productName || ''}｜${item.skuName || item.packageLabel || ''} × ${item.quantity || 1}` },
          { label: '实付', value: `¥${money(order.payAmount)}（商品 ¥${money(order.goodsAmount)}，运费 ¥${money(order.shippingFee)}）` },
          { label: '状态', value: orderFulfillmentStatusText(order) },
          { label: '物流', value: shipment.trackingNo ? `${shipment.company || '快递'}｜${shipment.trackingNo}` : '-' },
          { label: '微信发货同步', value: wechatShippingStatusText(order) },
          { label: '备注', value: order.note || '-' }
        ]
      });
    }
    if (action === 'manual-ship') {
      const order = state.orders.find((item) => item.id === id);
      const shipment = order && order.expressShipment || {};
      const values = await showForm({
        title: '手动发货',
        eyebrow: '快递信息',
        message: '录入快递公司和单号后，订单状态会更新为已发货。',
        fields: [
          { name: 'company', label: '快递公司', value: shipment.company || '', required: true },
          { name: 'trackingNo', label: '快递单号', value: shipment.trackingNo || '', required: true }
        ],
        confirmText: '确认发货'
      });
      if (!values) return;
      await api(`/api/orders/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'shipped',
          company: values.company,
          trackingNo: values.trackingNo,
          detail: `手动发货：${values.company} ${values.trackingNo}`
        })
      });
      await load();
      toast('快递信息已更新');
    }
    if (action === 'order-after-sale') {
      const order = state.orders.find((item) => item.id === id);
      if (!order) return toast('订单不存在');
      if (!canShowAfterSaleInfo(order)) return toast('暂无用户售后申请');
      const info = order.afterSaleInfo;
      const afterSaleDetails = [
        { label: '售后状态', value: afterSaleStatusText(info.status) },
        { label: '售后原因', value: info.reason || '-' },
        { label: '申请退款金额', value: `¥${money(info.refundAmount)}` },
        { label: '申请时间', value: info.requestedAt || '-' }
      ];
      if (isOrderRefundProcessed(order)) {
        afterSaleDetails.push(
          { label: '实际退款金额', value: `¥${money(info.refundAmount)}` },
          { label: '退款处理备注', value: info.refundNote || '-' },
          { label: '退款处理时间', value: info.handledAt || order.refundedAt || '-' }
        );
      } else if (isOrderRefundProcessing(order)) {
        afterSaleDetails.push(
          { label: '退款处理备注', value: info.refundNote || '-' },
          { label: '微信退款状态', value: order.wechatRefund && order.wechatRefund.status || 'PROCESSING' },
          { label: '微信退款单号', value: order.wechatRefund && order.wechatRefund.outRefundNo || '-' },
          { label: '提交时间', value: order.wechatRefund && order.wechatRefund.requestedAt || '-' }
        );
      }
      await showInfo('售后信息', {
        details: afterSaleDetails
      });
    }
    if (action === 'order-refund') {
      const order = state.orders.find((item) => item.id === id);
      if (!order) return toast('订单不存在');
      if (isOrderRefundProcessed(order)) return toast('该订单已退款，不能重复退款处理');
      if (!hasAfterSaleRequest(order)) return toast('该订单暂无售后申请，不能退款处理');
      const defaultAmount = order.afterSaleInfo && order.afterSaleInfo.refundAmount
        ? money(order.afterSaleInfo.refundAmount)
        : money(order.payAmount);
      const values = await showForm({
        title: '退款处理',
        eyebrow: '谨慎操作',
        message: '正式微信支付订单会提交微信原路退款；微信确认成功后才会标记为已退款。',
        fields: [
          { name: 'amountText', label: '退款金额（元）', type: 'number', step: '0.01', min: '0.01', value: defaultAmount, required: true },
          { name: 'reason', label: '退款处理备注', type: 'textarea', rows: 4, value: order.afterSaleInfo && order.afterSaleInfo.refundNote || '退款处理', required: true }
        ],
        confirmText: '确认退款',
        danger: true
      });
      if (!values) return;
      const amountText = values.amountText;
      const refundAmount = Math.round(Number(amountText || 0) * 100);
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) return toast('请输入有效退款金额');
      const reason = String(values.reason || '').trim();
      const result = await api(`/api/orders/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'refunded', refundNote: reason, reason, refundAmount, detail: reason })
      });
      await load();
      toast(result.wechatRefund && result.wechatRefund.mode === 'wechat' ? (result.wechatRefund.message || '微信退款已提交') : '退款状态已更新');
    }
	    if (action === 'edit-product') {
      const product = state.products.find((item) => item.id === id);
      renderProductPickupPointChoices(product && product.pickupPointIds || []);
      fillForm($('#productForm'), productToForm(product));
      syncProductSaleTypeFields($('#productForm'));
      updateCoverPreview(product.coverImage);
      resetUploadHint();
      window.scrollTo({ top: $('#productsPanel').offsetTop - 20, behavior: 'smooth' });
    }
    if (action === 'status-product') {
      const product = state.products.find((item) => item.id === id);
      if (status === 'on_sale' && product && !productCanBeListed(product)) {
        toast('上架前请先把所有规格库存补到大于 0');
        return;
      }
      await api(`/api/products/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await load();
      toast('商品状态已更新');
    }
    if (action === 'delete-product') {
      const product = state.products.find((item) => item.id === id);
      const name = product && product.name ? `「${product.name}」` : '该商品';
      const ok = await showConfirm(`确定删除${name}吗？删除后商品将从后台列表移除，已有订单仍保留订单快照。`, {
        title: '删除商品',
        danger: true,
        confirmText: '删除'
      });
      if (!ok) return;
      await api(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
      toast('商品已删除');
    }
    if (action === 'edit-pickup') {
      const point = state.pickupPoints.find((item) => item.id === id);
      fillForm($('#pickupForm'), pickupToForm(point));
      window.scrollTo({ top: $('#pickupPanel').offsetTop - 20, behavior: 'smooth' });
    }
    if (action === 'toggle-pickup') {
      await api(`/api/pickup-points/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }) });
      await load();
      toast('自提点状态已更新');
    }
    if (action === 'delete-pickup') {
      const ok = await showConfirm('确定停用该自提点吗？如仍有上架商品绑定该自提点，系统会阻止停用。', {
        title: '停用自提点',
        danger: true,
        confirmText: '停用'
      });
      if (!ok) return;
      await api(`/api/pickup-points/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
      toast('自提点已停用');
    }
    if (action === 'delete-whitelist-rule') {
      const ok = await showConfirm('确定只删除这条白名单规则吗？同手机号其他商品白名单会保留。', {
        title: '删除白名单规则',
        danger: true,
        confirmText: '删除'
      });
      if (!ok) return;
      await api(`/api/whitelist/${encodeURIComponent(button.dataset.phone)}/rules/${encodeURIComponent(button.dataset.ruleId)}`, { method: 'DELETE' });
      await load();
      toast('白名单规则已删除');
    }
    if (action === 'edit-coupon') {
      const coupon = state.coupons.find((item) => item.code === button.dataset.code);
      if (!coupon) return toast('优惠码不存在');
      renderCouponProductChoices(coupon && coupon.productIds || []);
      const form = $('#couponForm');
      fillForm(form, couponToForm(coupon));
      form.elements.code.readOnly = true;
      window.scrollTo({ top: $('#couponsPanel').offsetTop - 20, behavior: 'smooth' });
    }
    if (action === 'toggle-coupon') {
      await api(`/api/coupons/${encodeURIComponent(button.dataset.code)}/status`, {
        method: 'POST',
        body: JSON.stringify({ enabled: button.dataset.enabled === 'true' })
      });
      await load();
      toast('优惠码状态已更新');
    }
    if (action === 'delete-coupon') {
      const ok = await showConfirm('确定删除该优惠码吗？已有使用记录仍会保留在订单里。', {
        title: '删除优惠码',
        danger: true,
        confirmText: '删除'
      });
      if (!ok) return;
      await api(`/api/coupons/${encodeURIComponent(button.dataset.code)}`, { method: 'DELETE' });
      const form = $('#couponForm');
      const currentCode = String(form && form.elements.code.value || '').trim().toUpperCase();
      const originalCode = String(form && form.elements.originalCode.value || '').trim().toUpperCase();
      const deletedCode = String(button.dataset.code || '').trim().toUpperCase();
      if (form && (currentCode === deletedCode || originalCode === deletedCode)) resetCouponForm();
      await load();
      toast('优惠码已删除');
    }
    if (action === 'order-pay') {
      await api(`/api/orders/${encodeURIComponent(id)}/pay`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      toast('订单已确认支付，已尝试云打印');
    }
    if (action === 'order-print-label') {
      await api(`/api/orders/${encodeURIComponent(id)}/print-label`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      toast('订单标签已提交云打印');
    }
    if (action === 'order-status') {
      const scope = button.closest('.order-action-stack') || document;
      const company = scope.querySelector('.company')?.value || '';
      const trackingNo = scope.querySelector('.tracking')?.value || '';
      const reason = scope.querySelector('.reason')?.value || '';
      const refundAmount = Math.round(Number(scope.querySelector('.refund')?.value || 0) * 100);
      await api(`/api/orders/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, company, trackingNo, reason, refundAmount, detail: reason || undefined })
      });
      await load();
      toast('订单状态已更新');
    }
    };
    if (lockedActions.has(action)) {
      await withButtonLock(button, '处理中...', runAction);
    } else {
      await runAction();
    }
  });
}

async function boot() {
  const ok = await ensureSession();
  if (ok) await load();
}

bindEvents();
boot().catch((error) => toast(error.message));
