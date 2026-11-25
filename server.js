// Pallay Ruchulu - store + owner dashboard. Zero dependencies (Node >= 18).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const staffModule = require('./staff');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pallay@123';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;

store.load();
const sessions = new Map(); // token -> expiry ms
const loginAttempts = new Map(); // ip -> {count, until}

// ---------- helpers ----------
const IST_OFFSET = 5.5 * 3600 * 1000;
const dayKey = (ts) => new Date(ts + IST_OFFSET).toISOString().slice(0, 10);
const now = () => Date.now();

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, max = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
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

function isAdmin(req) {
  const t = cookies(req).pr_admin;
  if (!t || !sessions.has(t)) return false;
  if (sessions.get(t) < now()) { sessions.delete(t); return false; }
  return true;
}

const clean = (s, max = 200) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

function publicProduct(p) {
  return {
    id: p.id, name: p.name, telugu: p.telugu, desc: p.desc, unit: p.unit, price: p.price,
    emoji: p.emoji, tag: p.tag, image: p.image || null,
    available: p.stock > 0, fewLeft: p.stock > 0 && p.stock <= p.lowStockAt ? p.stock : null
  };
}

function addMovement(db, productId, type, qty, note, ref) {
  db.movements.push({ id: crypto.randomUUID(), at: now(), productId, type, qty, note: note || '', ref: ref || null });
}

// Validates items against stock, deducts stock, returns order lines + subtotal.
function takeStock(db, items, ref) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Cart is empty');
  const merged = {};
  for (const it of items) {
    const qty = int(it.qty);
    if (!(qty > 0 && qty <= 100)) throw new Error('Invalid quantity');
    merged[it.id] = (merged[it.id] || 0) + qty;
  }
  const lines = [];
  for (const [id, qty] of Object.entries(merged)) {
    const p = db.products.find((x) => x.id === id);
    if (!p || !p.active) throw new Error('Product not available');
    if (p.stock < qty) throw new Error(`Only ${p.stock} pack(s) of ${p.name} left`);
    lines.push({ productId: p.id, name: p.name, qty, price: p.price });
  }
  for (const l of lines) {
    const p = db.products.find((x) => x.id === l.productId);
    p.stock -= l.qty;
    addMovement(db, p.id, 'sale', -l.qty, '', ref);
  }
  return { lines, subtotal: lines.reduce((s, l) => s + l.qty * l.price, 0) };
}

function restoreStock(db, order) {
  for (const l of order.items) {
    const p = db.products.find((x) => x.id === l.productId);
    if (p) { p.stock += l.qty; addMovement(db, p.id, 'return', l.qty, 'Order cancelled', order.id); }
  }
}

// ---------- dashboard summary ----------
function summary(db) {
  const today = dayKey(now());
  const month = today.slice(0, 7);
  const valid = db.orders.filter((o) => o.status !== 'cancelled');
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(now() - i * 86400000));
  const daily = Object.fromEntries(days.map((d) => [d, { date: d, packets: 0, revenue: 0, online: 0, shop: 0 }]));

  const per = Object.fromEntries(db.products.map((p) => [p.id, {
    id: p.id, name: p.name, stock: p.stock, lowStockAt: p.lowStockAt, active: p.active, price: p.price,
    soldToday: 0, soldMonth: 0, soldAll: 0, revenueMonth: 0, produced30: 0, wasted30: 0
  }]));

  const k = { packetsToday: 0, revenueToday: 0, ordersToday: 0, packetsMonth: 0, revenueMonth: 0, packetsAll: 0, revenueAll: 0, onlineMonth: 0, shopMonth: 0 };

  for (const o of valid) {
    const d = dayKey(o.createdAt);
    const pk = o.items.reduce((s, l) => s + l.qty, 0);
    k.packetsAll += pk; k.revenueAll += o.total;
    if (d === today) { k.packetsToday += pk; k.revenueToday += o.total; k.ordersToday++; }
    if (d.startsWith(month)) {
      k.packetsMonth += pk; k.revenueMonth += o.total;
      if (o.channel === 'online') k.onlineMonth += pk; else k.shopMonth += pk;
    }
    if (daily[d]) { daily[d].packets += pk; daily[d].revenue += o.total; daily[d][o.channel === 'online' ? 'online' : 'shop'] += pk; }
    for (const l of o.items) {
      const r = per[l.productId]; if (!r) continue;
      r.soldAll += l.qty;
      if (d === today) r.soldToday += l.qty;
      if (d.startsWith(month)) { r.soldMonth += l.qty; r.revenueMonth += l.qty * l.price; }
    }
  }
  const cutoff = now() - 30 * 86400000;
  for (const m of db.movements) {
    if (m.at < cutoff || !per[m.productId]) continue;
    if (m.type === 'production') per[m.productId].produced30 += m.qty;
    if (m.type === 'waste') per[m.productId].wasted30 += -m.qty;
  }

  const products = Object.values(per);
  return {
    today, kpis: { ...k, totalStock: db.products.reduce((s, p) => s + p.stock, 0), pendingOrders: db.orders.filter((o) => ['new', 'preparing', 'out'].includes(o.status)).length },
    products,
    lowStock: products.filter((p) => p.active && p.stock <= p.lowStockAt),
    daily: Object.values(daily),
    recentOrders: db.orders.slice(-8).reverse()
  };
}

// ---------- routes ----------
async function api(req, res, url) {
  const db = store.get();
  const p = url.pathname;
  const m = req.method;

  // public
  if (p === '/api/products' && m === 'GET') return send(res, 200, db.products.filter((x) => x.active).map(publicProduct));

  if (p === '/api/settings' && m === 'GET') {
    const s = db.settings;
    return send(res, 200, { shopName: s.shopName, phone: s.phone, whatsapp: s.whatsapp, upiId: s.upiId, address: s.address, hours: s.hours, deliveryCharge: s.deliveryCharge, freeDeliveryAbove: s.freeDeliveryAbove, rating: s.rating, reviews: s.reviews });
  }

  if (p === '/api/orders' && m === 'POST') {
    const b = await readBody(req);
    const name = clean(b.name, 80), phone = clean(b.phone, 15).replace(/[^\d+]/g, '');
    const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
    const address = clean(b.address, 300);
    if (name.length < 2) return send(res, 400, { error: 'Please enter your name' });
    if (!/^\+?\d{10,13}$/.test(phone)) return send(res, 400, { error: 'Please enter a valid phone number' });
    if (mode === 'delivery' && address.length < 8) return send(res, 400, { error: 'Please enter your full delivery address' });
    const id = 'PR' + db.nextOrderNo;
    let t;
    try { t = takeStock(db, b.items, id); } catch (e) { return send(res, 400, { error: e.message }); }
    const s = db.settings;
    const delivery = mode === 'delivery' && t.subtotal < s.freeDeliveryAbove ? s.deliveryCharge : 0;
    const order = {
      id, createdAt: now(), channel: 'online', status: 'new',
      customer: { name, phone, address: mode === 'delivery' ? address : '' },
      mode, payment: b.payment === 'upi' ? 'upi' : 'cod', note: clean(b.note, 300),
      items: t.lines, subtotal: t.subtotal, delivery, total: t.subtotal + delivery
    };
    db.nextOrderNo++;
    db.orders.push(order);
    store.save();
    return send(res, 201, { id: order.id, total: order.total, delivery: order.delivery, payment: order.payment, status: order.status });
  }

  const track = p.match(/^\/api\/orders\/(PR\d+)$/);
  if (track && m === 'GET') {
    const o = db.orders.find((x) => x.id === track[1]);
    const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '').slice(-10);
    if (!o || o.customer.phone.replace(/\D/g, '').slice(-10) !== phone) return send(res, 404, { error: 'Order not found. Check order ID and phone number.' });
    return send(res, 200, { id: o.id, status: o.status, createdAt: o.createdAt, items: o.items, total: o.total, mode: o.mode });
  }

  // auth
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = req.socket.remoteAddress;
    const a = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (a.until > now()) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readBody(req);
    const given = Buffer.from(String(b.password || ''));
    const real = Buffer.from(ADMIN_PASSWORD);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      a.count++; if (a.count >= 5) { a.until = now() + 5 * 60000; a.count = 0; }
      loginAttempts.set(ip, a);
      return send(res, 401, { error: 'Wrong password' });
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now() + SESSION_HOURS * 3600000);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `pr_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    sessions.delete(cookies(req).pr_admin);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'pr_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (p.startsWith('/api/staff/')) return staff.publicRoutes(req, res, url, db);
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'Not found' });
  if (!isAdmin(req)) return send(res, 401, { error: 'Please log in' });
  if ((await staff.adminRoutes(req, res, url, db)) !== false) return;

  // admin
  if (p === '/api/admin/summary' && m === 'GET') return send(res, 200, summary(db));

  if (p === '/api/admin/orders' && m === 'GET') {
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let list = db.orders.slice().reverse();
    if (status && status !== 'all') list = list.filter((o) => o.status === status);
    if (q) list = list.filter((o) => (o.id + ' ' + o.customer.name + ' ' + o.customer.phone).toLowerCase().includes(q));
    return send(res, 200, list.slice(0, 300));
  }

  const om = p.match(/^\/api\/admin\/orders\/(PR\d+)$/);
  if (om && m === 'PATCH') {
    const b = await readBody(req);
    const o = db.orders.find((x) => x.id === om[1]);
    if (!o) return send(res, 404, { error: 'Order not found' });
    const allowed = ['new', 'preparing', 'out', 'delivered', 'cancelled'];
    if (!allowed.includes(b.status)) return send(res, 400, { error: 'Invalid status' });
    if (o.status === 'cancelled') return send(res, 400, { error: 'Cancelled orders cannot be changed' });
    if (b.status === 'cancelled') restoreStock(db, o);
    o.status = b.status;
    o.updatedAt = now();
    store.save();
    return send(res, 200, o);
  }

  if (p === '/api/admin/shop-sale' && m === 'POST') {
    const b = await readBody(req);
    const id = 'PR' + db.nextOrderNo;
    let t;
    try { t = takeStock(db, b.items, id); } catch (e) { return send(res, 400, { error: e.message }); }
    const order = {
      id, createdAt: now(), channel: 'shop', status: 'delivered',
      customer: { name: clean(b.name, 80) || 'Walk-in customer', phone: clean(b.phone, 15), address: '' },
      mode: 'pickup', payment: ['cash', 'upi'].includes(b.payment) ? b.payment : 'cash', note: '',
      items: t.lines, subtotal: t.subtotal, delivery: 0, total: t.subtotal
    };
    db.nextOrderNo++;
    db.orders.push(order);
    store.save();
    return send(res, 201, order);
  }

  if (p === '/api/admin/products' && m === 'GET') return send(res, 200, db.products);

  if (p === '/api/admin/products' && m === 'POST') {
    const b = await readBody(req);
    const name = clean(b.name, 60);
    if (name.length < 2) return send(res, 400, { error: 'Name required' });
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
    while (db.products.some((x) => x.id === id)) id += '-2';
    const prod = { id, name, telugu: clean(b.telugu, 60), desc: clean(b.desc, 300), unit: clean(b.unit, 40) || '1 pack', price: Math.max(0, int(b.price) || 0), stock: 0, lowStockAt: Math.max(0, int(b.lowStockAt) || 10), active: true, emoji: clean(b.emoji, 4) || '🍽️', tag: clean(b.tag, 20) };
    db.products.push(prod);
    store.save();
    return send(res, 201, prod);
  }

  const pm = p.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
  if (pm && m === 'PATCH') {
    const b = await readBody(req);
    const prod = db.products.find((x) => x.id === pm[1]);
    if (!prod) return send(res, 404, { error: 'Product not found' });
    for (const f of ['name', 'telugu', 'desc', 'unit', 'tag', 'emoji']) if (b[f] !== undefined) prod[f] = clean(b[f], f === 'desc' ? 300 : 60);
    if (b.price !== undefined) { const v = int(b.price); if (!(v >= 0)) return send(res, 400, { error: 'Invalid price' }); prod.price = v; }
    if (b.lowStockAt !== undefined) { const v = int(b.lowStockAt); if (!(v >= 0)) return send(res, 400, { error: 'Invalid low-stock level' }); prod.lowStockAt = v; }
    if (b.active !== undefined) prod.active = !!b.active;
    store.save();
    return send(res, 200, prod);
  }

  if (p === '/api/admin/stock' && m === 'POST') {
    const b = await readBody(req);
    const prod = db.products.find((x) => x.id === b.productId);
    if (!prod) return send(res, 404, { error: 'Product not found' });
    const qty = int(b.qty);
    if (!(qty > 0 && qty <= 10000)) return send(res, 400, { error: 'Enter a quantity greater than 0' });
    const type = ['production', 'waste', 'adjust-add', 'adjust-remove'].includes(b.type) ? b.type : null;
    if (!type) return send(res, 400, { error: 'Invalid type' });
    const delta = type === 'production' || type === 'adjust-add' ? qty : -qty;
    if (prod.stock + delta < 0) return send(res, 400, { error: `Only ${prod.stock} in stock` });
    prod.stock += delta;
    addMovement(db, prod.id, type.startsWith('adjust') ? 'adjust' : type, delta, clean(b.note, 200));
    store.save();
    return send(res, 200, prod);
  }

  if (p === '/api/admin/movements' && m === 'GET') return send(res, 200, db.movements.slice(-200).reverse());

  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, db.settings);
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await readBody(req);
    for (const f of ['shopName', 'phone', 'upiId', 'address', 'hours']) if (b[f] !== undefined) db.settings[f] = clean(b[f], 300);
    if (b.whatsapp !== undefined) db.settings.whatsapp = String(b.whatsapp).replace(/\D/g, '').slice(0, 15);
    for (const f of ['deliveryCharge', 'freeDeliveryAbove', 'reviews']) if (b[f] !== undefined && int(b[f]) >= 0) db.settings[f] = int(b[f]);
    if (b.rating !== undefined && Number(b.rating) >= 0 && Number(b.rating) <= 5) db.settings.rating = Number(b.rating);
    store.save();
    return send(res, 200, db.settings);
  }

  if (p === '/api/admin/export.csv' && m === 'GET') {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Order ID', 'Date (IST)', 'Channel', 'Status', 'Customer', 'Phone', 'Mode', 'Payment', 'Items', 'Packets', 'Total (Rs)']];
    for (const o of db.orders) rows.push([o.id, new Date(o.createdAt + IST_OFFSET).toISOString().replace('T', ' ').slice(0, 16), o.channel, o.status, o.customer.name, o.customer.phone, o.mode, o.payment, o.items.map((l) => `${l.name} x${l.qty}`).join('; '), o.items.reduce((s, l) => s + l.qty, 0), o.total]);
    return send(res, 200, '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pallay-ruchulu-orders-${dayKey(now())}.csv"` });
  }

  return send(res, 404, { error: 'Not found' });
}

const staff = staffModule({ send, readBody, clean, int, takeStock, dayKey, now, store, IST_OFFSET });

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json' };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' ) rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  if (/^\/staff\/[a-f0-9]{32,64}\/?$/.test(rel)) rel = '/staff.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: e.message || 'Something went wrong' });
  }
}).listen(PORT, () => {
  console.log(`\n  Pallay Ruchulu running`);
  console.log(`  Store:     http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/admin`);
  if (!process.env.ADMIN_PASSWORD) console.log(`  ⚠  Using default owner password "pallay@123" - set ADMIN_PASSWORD before going live.\n`);
});
