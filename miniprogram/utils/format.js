function formatMoney(cents) {
  const safeCents = Number.isFinite(Number(cents)) ? Math.max(0, Math.round(Number(cents))) : 0;
  return (safeCents / 100).toFixed(2);
}

function packageTypeLabel(packageType) {
  return packageType === 'box' ? '盒装' : '袋装';
}

function deliveryTypeLabel(deliveryType) {
  return deliveryType === 'express' ? '快递' : '自提';
}

function statusLabel(status) {
  const labels = {
    on_sale: '上架中',
    off_sale_manual: '手动下架',
    sold_out_auto: '库存售罄',
    draft: '草稿',
    mock_paid: '已支付',
    awaiting_payment: '待支付',
    awaiting_shipment: '待发货',
    awaiting_pickup: '备货中',
    pickup_shipped: '自提点已到货，可领取',
    shipped: '已发货',
    picked_up: '已自提',
    completed: '已完成',
    cancelled: '已取消',
    after_sale: '售后中',
    refund_pending: '退款中',
    refunded: '已退款'
  };
  return labels[status] || status || '未知';
}

function maskPhone(phone) {
  const text = String(phone || '').trim();
  if (!/^1\d{10}$/.test(text)) return text;
  return `${text.slice(0, 3)}****${text.slice(7)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

module.exports = {
  formatMoney,
  packageTypeLabel,
  deliveryTypeLabel,
  statusLabel,
  maskPhone,
  formatDateTime
};
