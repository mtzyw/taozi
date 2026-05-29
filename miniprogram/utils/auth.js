const backend = require('./backend');
const store = require('./store');
const { normalizePhone } = require('./pricing');

const SESSION_KEY = 'peach.wechatSession';
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function safeGet(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (_) {}
}

function safeRemove(key) {
  try {
    wx.removeStorageSync(key);
  } catch (_) {}
}

function getCachedWechatSession() {
  const session = safeGet(SESSION_KEY, null);
  if (!session || !session.sessionId || Number(session.expiresAt || 0) <= Date.now() + 60 * 1000) return null;
  return session;
}

function saveWechatSession(session) {
  const normalized = {
    sessionId: session && session.sessionId || '',
    openid: session && session.openid || '',
    unionid: session && session.unionid || '',
    phone: normalizePhone(session && session.phone || ''),
    isMock: Boolean(session && session.mock),
    expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS
  };
  if (normalized.sessionId) safeSet(SESSION_KEY, normalized);
  return normalized;
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.login) {
      reject(new Error('当前环境不支持微信登录'));
      return;
    }
    wx.login({
      success(res) {
        if (res && res.code) resolve(res.code);
        else reject(new Error('微信登录未返回 code'));
      },
      fail(error) {
        reject(new Error(error && error.errMsg || '微信登录失败'));
      }
    });
  });
}

async function ensureWechatSession(options = {}) {
  const cached = options.force ? null : getCachedWechatSession();
  if (cached) return cached;
  const code = await wxLogin();
  const session = await backend.loginWithWechat(code);
  return saveWechatSession(session);
}

function phoneAuthErrorMessage(detail = {}) {
  const errMsg = String(detail.errMsg || '');
  if (/deny|cancel/i.test(errMsg)) return '已取消手机号授权';
  if (errMsg && !/ok/i.test(errMsg)) return errMsg;
  if (!detail.code) return '微信未返回手机号授权码，请升级微信后重试';
  return '';
}

async function bindPhoneFromEvent(event) {
  const detail = event && event.detail || {};
  const authError = phoneAuthErrorMessage(detail);
  if (authError) throw new Error(authError);

  const session = await ensureWechatSession().catch(() => null);
  const result = await backend.getWechatPhone({
    code: detail.code,
    sessionId: session && session.sessionId || ''
  });
  const phone = normalizePhone(result && (result.phoneNumber || result.purePhoneNumber || result.phone));
  if (!/^1\d{10}$/.test(phone)) throw new Error('微信手机号解析失败');

  store.setCurrentPhone(phone);
  if (session) saveWechatSession({ ...session, phone });
  return phone;
}

function logout() {
  store.setCurrentPhone('');
  safeRemove(SESSION_KEY);
}

module.exports = {
  ensureWechatSession,
  bindPhoneFromEvent,
  logout,
  getCachedWechatSession
};
