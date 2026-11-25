// Shared helpers: HTTP, auth cookies, time zones, Supabase client, row mappers.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---------- config ----------
const ENV = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  password: process.env.ADMIN_PASSWORD
});

let client = null;
function sb() {
  const e = ENV();
  if (!e.url || !e.key) throw new UserError('Server not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY', 500);
  // ws: Node < 22 has no built-in WebSocket, which supabase-js requires at startup
  if (!client) client = createClient(e.url, e.key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: require('ws') } });
  return client;
}

class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Runs a Supabase query; throws on error. Database "raise exception" messages become user-facing errors.
async function q(promise) {
  const { data, error, count } = await promise;
  if (error) {
    if (error.code === 'P0001') throw new UserError(error.message);
    const e = new Error(error.message); e.details = error; throw e;
  }
  return count !== undefined && count !== null && data === null ? count : data;
}

// Fetches every row (PostgREST caps responses at 1000 rows).
async function all(build) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const rows = await q(build().range(i, i + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ---------- time (business runs on India time) ----------
const IST_OFFSET = 5.5 * 3600 * 1000;
const now = () => Date.now();
const dayKey = (ts) => new Date(ts + IST_OFFSET).toISOString().slice(0, 10);
const monthKey = (ts) => dayKey(ts).slice(0, 7);
const istStart = (date) => `${date}T00:00:00+05:30`;
const ms = (iso) => (iso ? Date.parse(iso) : null);
function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return [istStart(`${m}-01`), istStart(`${next}-01`)];
}

// ---------- http ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, max = 100_000) {
  // Vercel may have parsed the body already
  if (req.body !== undefined && req.body !== null && !(typeof req.body === 'string' && req.body === '')) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    try { return Promise.resolve(JSON.parse(String(req.body))); } catch { return Promise.reject(new UserError('Invalid JSON')); }
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) { reject(new UserError('Body too large', 413)); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new UserError('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const clean = (s, max = 200) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

// ---------- stateless admin session (signed cookie; works across serverless instances) ----------
const SESSION_HOURS = 12;
function secret() {
  const e = ENV();
  // Changing ADMIN_PASSWORD automatically logs everyone out.
  return crypto.createHash('sha256').update(`pr-session|${e.password}|${e.key}`).digest();
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: now() + SESSION_HOURS * 3600000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function isAdmin(req) {
  const t = cookies(req).pr_admin;
  if (!t || !ENV().password) return false;
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return false;
  const good = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > now(); } catch { return false; }
}
function sessionCookie(req, value, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `pr_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

// ---------- row mappers (database snake_case -> API camelCase used by the pages) ----------
const mapProduct = (r) => ({ id: r.id, name: r.name, telugu: r.telugu, desc: r.description, unit: r.unit, price: r.price, stock: r.stock, lowStockAt: r.low_stock_at, active: r.active, emoji: r.emoji, tag: r.tag, image: r.image });
const mapOrder = (r) => ({ id: r.id, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), channel: r.channel, status: r.status, customer: r.customer || {}, mode: r.mode, payment: r.payment, note: r.note || '', items: r.items || [], subtotal: r.subtotal, delivery: r.delivery, total: r.total, packets: r.packets, staffId: r.staff_id });
const mapMove = (r) => ({ id: r.id, at: ms(r.at), productId: r.product_id, type: r.type, qty: r.qty, note: r.note, ref: r.ref });
const mapStaff = (r) => ({ id: r.id, name: r.name, phone: r.phone, role: r.role, stallName: r.stall_name, stallLat: r.stall_lat, stallLng: r.stall_lng, radiusM: r.radius_m, payType: r.pay_type, salary: r.salary, active: r.active, token: r.token, createdAt: ms(r.created_at) });
const mapCheckin = (r) => ({ id: r.id, staffId: r.staff_id, at: ms(r.at), type: r.type, lat: r.lat, lng: r.lng, accuracy: r.accuracy, distanceM: r.distance_m, atStall: r.at_stall, photo: r.photo });
const mapMsg = (r) => ({ id: r.id, staffId: r.staff_id, at: ms(r.at), from: r.from_role, kind: r.kind, text: r.text, done: r.done, doneAt: ms(r.done_at), seen: r.seen });
const mapPay = (r) => ({ id: r.id, staffId: r.staff_id, at: ms(r.at), month: r.month, amount: r.amount, kind: r.kind, mode: r.mode, note: r.note });
const mapExp = (r) => ({ id: r.id, at: ms(r.at), date: r.date, category: r.category, amount: r.amount, note: r.note });

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  shopName: 'Pallay Ruchulu',
  phone: '+91 79935 08884',
  whatsapp: '917993508884',
  upiId: 'pallayruchulu@upi',
  address: 'SYN No. 157168, Part Grampanchayat, Sri Sai Balaji Foods Pvt Ltd, Shop No G-3, Qutubullapur, Nizampet, Hyderabad, Telangana 500090',
  hours: 'Open daily · 6 AM – 8 PM',
  deliveryCharge: 20,
  freeDeliveryAbove: 300,
  rating: 5.0,
  reviews: 41
};
async function getSettings() {
  const row = await q(sb().from('settings').select('data').eq('id', 1).maybeSingle());
  return { ...DEFAULT_SETTINGS, ...((row && row.data) || {}) };
}

module.exports = {
  ENV, sb, q, all, UserError, IST_OFFSET, now, dayKey, monthKey, istStart, monthRange, ms,
  send, readBody, cookies, clean, int, makeSession, isAdmin, sessionCookie, SESSION_HOURS,
  mapProduct, mapOrder, mapMove, mapStaff, mapCheckin, mapMsg, mapPay, mapExp, getSettings
};
