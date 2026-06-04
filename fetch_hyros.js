// Trae Hyros attribution y mergea en data.json
// Corre en GitHub Actions antes de build.js
// Requiere env HYROS_API_KEY. Si no esta, salta silenciosamente.

const https = require('https');
const fs = require('fs');

const API_KEY = process.env.HYROS_API_KEY;
const HYROS_HOST = 'api.hyros.com';
const HYROS_BASE = '/v1/api/v1.0';
const DATA_PATH = 'data.json';
const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function exitOk(msg) { console.log(msg); process.exit(0); }
function exitErr(msg) { console.error(msg); process.exit(0); } // exit 0 para no romper el workflow

if (!API_KEY) exitOk('HYROS_API_KEY no configurado, skip Hyros merge');
if (!fs.existsSync(DATA_PATH)) exitOk('data.json no existe (workflow_dispatch manual), skip Hyros merge');

function hyrosCall(path, params) {
  const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const fullPath = HYROS_BASE + path + (qs ? '?' + qs : '');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HYROS_HOST, path: fullPath, method: 'GET',
      headers: { 'API-Key': API_KEY, 'Accept': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Hyros ${res.statusCode}: ${body.substring(0, 300)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Hyros response no es JSON: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Hyros timeout')); });
    req.end();
  });
}

async function fetchHyrosByDay(fromDate, toDate) {
  const buckets = {};
  let page = 1;
  let hasMore = true;
  let total = 0;
  while (hasMore && page <= 50) {
    let data;
    try {
      data = await hyrosCall('/sales', { fromDate, toDate, pageSize: 100, page });
    } catch(e) {
      console.error('Hyros call falló en pagina ' + page + ': ' + e.message);
      // Si la primera pagina falla, probable que el endpoint sea distinto
      if (page === 1) throw e;
      break;
    }
    const items = data.sales || data.data || data.results || (Array.isArray(data) ? data : []);
    if (!items.length) break;
    items.forEach(s => {
      const saleDate = (s.date || s.saleDate || s.createdAt || s.sale_date || '').substring(0, 10);
      if (!saleDate) return;
      const value = parseFloat(s.value || s.revenue || s.amount || 0);
      const touchArr = s.touches || s.touchpoints || s.attribution || [];
      const touches = Array.isArray(touchArr) ? touchArr.length : (s.touchCount || s.touch_count || 0);
      const firstTouchRaw = s.firstTouchDate || s.first_touch_date ||
        (Array.isArray(touchArr) && touchArr[0] && (touchArr[0].date || touchArr[0].timestamp));
      let daysToPurchase = 0;
      if (firstTouchRaw) {
        const fd = new Date(firstTouchRaw);
        const sd = new Date(saleDate);
        if (!isNaN(fd) && !isNaN(sd)) {
          daysToPurchase = Math.max(0, Math.round((sd - fd) / (1000 * 60 * 60 * 24)));
        }
      }
      if (!buckets[saleDate]) buckets[saleDate] = { sales:0, revenue:0, touchesSum:0, daysSum:0, n:0 };
      buckets[saleDate].sales += 1;
      buckets[saleDate].revenue += value;
      buckets[saleDate].touchesSum += touches;
      buckets[saleDate].daysSum += daysToPurchase;
      buckets[saleDate].n += 1;
      total += 1;
    });
    hasMore = items.length === 100;
    page++;
  }
  console.log(`Hyros: ${total} sales recolectadas en ${Object.keys(buckets).length} dias`);
  const result = {};
  Object.keys(buckets).forEach(d => {
    const b = buckets[d];
    result[d] = {
      hyros_sales: b.sales,
      hyros_revenue: Math.round(b.revenue * 100) / 100,
      hyros_avg_touches: b.n > 0 ? Math.round((b.touchesSum / b.n) * 10) / 10 : 0,
      hyros_avg_days: b.n > 0 ? Math.round((b.daysSum / b.n) * 10) / 10 : 0
    };
  });
  return result;
}

function ymdToDayKey(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return MONTH_NAMES[m-1] + ' ' + String(d).padStart(2, '0');
}

(async () => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!data.days || Object.keys(data.days).length === 0) exitOk('data.json sin dias, skip Hyros');

    // Rango: desde el primer dia con data hasta hoy
    const today = new Date();
    const past = new Date(); past.setDate(today.getDate() - 150);
    const from = past.toISOString().substring(0, 10);
    const to = today.toISOString().substring(0, 10);

    const hyrosByDate = await fetchHyrosByDay(from, to);
    let merged = 0;
    Object.keys(hyrosByDate).forEach(ymd => {
      const key = ymdToDayKey(ymd);
      if (!key || !data.days[key]) return;
      Object.assign(data.days[key], hyrosByDate[ymd]);
      merged++;
    });
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`Hyros merged: ${merged} dias actualizados en data.json`);
  } catch(e) {
    exitErr('Hyros sync FAIL: ' + e.message + ' (continuando sin Hyros)');
  }
})();
