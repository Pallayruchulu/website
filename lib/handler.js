// API router for store + owner dashboard. Used by Vercel (api/index.js) and local dev (server.js).
const crypto = require('crypto');
const U = require('./util');
const staffRoutes = require('./staff');

const { sb, q, all, UserError, send, readBody, clean, int, now, dayKey, istStart, mapProduct, mapOrder, mapMove, getSettings } = U;

const loginAttempts = new Map(); // best-effort per instance

function publicProduct(p) {
  return {
    id: p.id, name: p.name, telugu: p.telugu, desc: p.desc, unit: p.unit, price: p.price,
    emoji: p.emoji, tag: p.tag, image: p.image || null,
    available: p.stock > 0, fewLeft: p.stock > 0 && p.stock <= p.lowStockAt ? p.stock : null
  };
}

const products = async () => (await q(sb().from('products').select('*').order('sort').order('created_at'))).map(mapProduct);

async function createOrder(p) {
  return mapOrder(await q(sb().rpc('create_order', { p })));
}

// ---------- dashboard summary ----------
async function summary() {
  const today = dayKey(now());
  const month = today.slice(0, 7);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(now() - i * 86400000));
  const since = istStart(days[0] < `${month}-01` ? days[0] : `${month}-01`);
  const cutoff30 = new Date(now() - 30 * 86400000).toISOString();

  const [prods, recentRows, stats, pending, moves, latest] = await Promise.all([
    products(),
    all(() => sb().from('orders').select('created_at,channel,status,items,total,packets').gte('created_at', since).neq('status', 'cancelled').order('created_at')),
    q(sb().from('order_stats').select('*').single()),
    q(sb().from('orders').select('id', { count: 'exact', head: true }).in('status', ['new', 'preparing', 'out'])),
    all(() => sb().from('movements').select('product_id,type,qty').gte('at', cutoff30).in('type', ['production', 'waste'])),
    q(sb().from('orders').select('*').order('created_at', { ascending: false }).limit(8))
  ]);

  const daily = Object.fromEntries(days.map((d) => [d, { date: d, packets: 0, revenue: 0, online: 0, shop: 0 }]));
  const per = Object.fromEntries(prods.map((p) => [p.id, {
    id: p.id, name: p.name, stock: p.stock, lowStockAt: p.lowStockAt, active: p.active, price: p.price,
    soldToday: 0, soldMonth: 0, revenueMonth: 0, produced30: 0, wasted30: 0
  }]));
  const k = { packetsToday: 0, revenueToday: 0, ordersToday: 0, packetsMonth: 0, revenueMonth: 0, onlineMonth: 0, shopMonth: 0 };

  for (const r of recentRows) {
    const d = dayKey(Date.parse(r.created_at));
    const pk = r.packets;
    if (d === today) { k.packetsToday += pk; k.revenueToday += r.total; k.ordersToday++; }
    if (d.startsWith(month)) {
      k.packetsMonth += pk; k.revenueMonth += r.total;
      if (r.channel === 'online') k.onlineMonth += pk; else k.shopMonth += pk;
    }
    if (daily[d]) { daily[d].packets += pk; daily[d].revenue += r.total; daily[d][r.channel === 'online' ? 'online' : 'shop'] += pk; }
    for (const l of r.items) {
      const x = per[l.productId]; if (!x) continue;
      if (d === today) x.soldToday += l.qty;
      if (d.startsWith(month)) { x.soldMonth += l.qty; x.revenueMonth += l.qty * l.price; }
    }
  }
  for (const m of moves) {
    if (!per[m.product_id]) continue;
    if (m.type === 'production') per[m.product_id].produced30 += m.qty;
    if (m.type === 'waste') per[m.product_id].wasted30 += -m.qty;
  }
  const list = Object.values(per);
  return {
    today,
    kpis: { ...k, packetsAll: Number(stats.packets), revenueAll: Number(stats.revenue), totalStock: prods.reduce((s, p) => s + p.stock, 0), pendingOrders: pending },
    products: list,
    lowStock: list.filter((p) => p.active && p.stock <= p.lowStockAt),
    daily: Object.values(daily),
    recentOrders: latest.map(mapOrder)
  };
}

// ---------- router ----------
async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // ----- public store -----
  if (p === '/api/products' && m === 'GET') return send(res, 200, (await products()).filter((x) => x.active).map(publicProduct));

  if (p === '/api/settings' && m === 'GET') {
    const s = await getSettings();
    return send(res, 200, { shopName: s.shopName, phone: s.phone, whatsapp: s.whatsapp, upiId: s.upiId, address: s.address, hours: s.hours, deliveryCharge: s.deliveryCharge, freeDeliveryAbove: s.freeDeliveryAbove, rating: s.rating, reviews: s.reviews });
  }

  if (p === '/api/orders' && m === 'POST') {
    const b = await readBody(req);
    const name = clean(b.name, 80), phone = clean(b.phone, 15).replace(/[^\d+]/g, '');
    const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
    const address = clean(b.address, 300);
    if (name.length < 2) throw new UserError('Please enter your name');
    if (!/^\+?\d{10,13}$/.test(phone)) throw new UserError('Please enter a valid phone number');
    if (mode === 'delivery' && address.length < 8) throw new UserError('Please enter your full delivery address');
    if (!Array.isArray(b.items)) throw new UserError('Cart is empty');
    const s = await getSettings();
    const o = await createOrder({
      channel: 'online', status: 'new', customer: { name, phone, address: mode === 'delivery' ? address : '' },
      mode, payment: b.payment === 'upi' ? 'upi' : 'cod', note: clean(b.note, 300),
      items: b.items.map((i) => ({ id: String(i.id), qty: int(i.qty) })), delivery_charge: s.deliveryCharge, free_above: s.freeDeliveryAbove
    });
    return send(res, 201, { id: o.id, total: o.total, delivery: o.delivery, payment: o.payment, status: o.status });
  }

  const track = p.match(/^\/api\/orders\/(PR\d+)$/);
  if (track && m === 'GET') {
    const row = await q(sb().from('orders').select('*').eq('id', track[1]).maybeSingle());
    const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '').slice(-10);
    if (!row || !phone || String(row.customer.phone || '').replace(/\D/g, '').slice(-10) !== phone) throw new UserError('Order not found. Check order ID and phone number.', 404);
    const o = mapOrder(row);
    return send(res, 200, { id: o.id, status: o.status, createdAt: o.createdAt, items: o.items, total: o.total, mode: o.mode });
  }

  // ----- staff link pages -----
  if (p.startsWith('/api/staff/')) return staffRoutes.publicRoutes(req, res, url);

  // ----- admin auth -----
  if (p === '/api/admin/login' && m === 'POST') {
    const pw = U.ENV().password;
    if (!pw) throw new UserError('Server not configured: set ADMIN_PASSWORD', 500);
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const a = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (a.until > now()) throw new UserError('Too many attempts. Try again in a few minutes.', 429);
    const b = await readBody(req);
    const given = crypto.createHash('sha256').update(String(b.password || '')).digest();
    const real = crypto.createHash('sha256').update(pw).digest();
    if (!crypto.timingSafeEqual(given, real)) {
      a.count++; if (a.count >= 5) { a.until = now() + 5 * 60000; a.count = 0; }
      loginAttempts.set(ip, a);
      throw new UserError('Wrong password', 401);
    }
    loginAttempts.delete(ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': U.sessionCookie(req, U.makeSession(), U.SESSION_HOURS * 3600) });
  }
  if (p === '/api/admin/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': U.sessionCookie(req, '', 0) });

  if (!p.startsWith('/api/admin/')) throw new UserError('Not found', 404);
  if (!U.isAdmin(req)) throw new UserError('Please log in', 401);

  if ((await staffRoutes.adminRoutes(req, res, url)) !== false) return;

  // ----- admin -----
  if (p === '/api/admin/summary' && m === 'GET') return send(res, 200, await summary());

  if (p === '/api/admin/orders' && m === 'GET') {
    const status = url.searchParams.get('status');
    const term = (url.searchParams.get('q') || '').toLowerCase();
    let qb = sb().from('orders').select('*').order('created_at', { ascending: false }).limit(1000);
    if (status && status !== 'all') qb = qb.eq('status', status);
    let list = (await q(qb)).map(mapOrder);
    if (term) list = list.filter((o) => `${o.id} ${o.customer.name || ''} ${o.customer.phone || ''}`.toLowerCase().includes(term));
    return send(res, 200, list.slice(0, 300));
  }

  const om = p.match(/^\/api\/admin\/orders\/(PR\d+)$/);
  if (om && m === 'PATCH') {
    const b = await readBody(req);
    if (!['new', 'preparing', 'out', 'delivered', 'cancelled'].includes(b.status)) throw new UserError('Invalid status');
    if (b.status === 'cancelled') return send(res, 200, mapOrder(await q(sb().rpc('cancel_order', { p_id: om[1] }))));
    const rows = await q(sb().from('orders').update({ status: b.status, updated_at: new Date().toISOString() }).eq('id', om[1]).neq('status', 'cancelled').select());
    if (!rows.length) throw new UserError('Order not found or already cancelled', 404);
    return send(res, 200, mapOrder(rows[0]));
  }

  if (p === '/api/admin/shop-sale' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.items)) throw new UserError('Add at least one product');
    const o = await createOrder({
      channel: 'shop', status: 'delivered', customer: { name: clean(b.name, 80) || 'Walk-in customer', phone: clean(b.phone, 15), address: '' },
      mode: 'pickup', payment: ['cash', 'upi'].includes(b.payment) ? b.payment : 'cash', note: '',
      items: b.items.map((i) => ({ id: String(i.id), qty: int(i.qty) }))
    });
    return send(res, 201, o);
  }

  if (p === '/api/admin/products' && m === 'GET') return send(res, 200, await products());

  if (p === '/api/admin/products' && m === 'POST') {
    const b = await readBody(req);
    const name = clean(b.name, 60);
    if (name.length < 2) throw new UserError('Name required');
    const existing = new Set((await products()).map((x) => x.id));
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
    while (existing.has(id)) id += '-2';
    const row = await q(sb().from('products').insert({
      id, name, telugu: clean(b.telugu, 60), description: clean(b.desc, 300), unit: clean(b.unit, 40) || '1 pack',
      price: Math.max(0, int(b.price) || 0), stock: 0, low_stock_at: Math.max(0, int(b.lowStockAt) || 10), active: true,
      emoji: clean(b.emoji, 4) || '🍽️', tag: clean(b.tag, 20), sort: 100
    }).select().single());
    return send(res, 201, mapProduct(row));
  }

  const pm = p.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
  if (pm && m === 'PATCH') {
    const b = await readBody(req);
    const upd = {};
    for (const f of ['name', 'telugu', 'unit', 'tag', 'emoji']) if (b[f] !== undefined) upd[f] = clean(b[f], 60);
    if (b.desc !== undefined) upd.description = clean(b.desc, 300);
    if (b.price !== undefined) { const v = int(b.price); if (!(v >= 0)) throw new UserError('Invalid price'); upd.price = v; }
    if (b.lowStockAt !== undefined) { const v = int(b.lowStockAt); if (!(v >= 0)) throw new UserError('Invalid low-stock level'); upd.low_stock_at = v; }
    if (b.active !== undefined) upd.active = !!b.active;
    const rows = await q(sb().from('products').update(upd).eq('id', pm[1]).select());
    if (!rows.length) throw new UserError('Product not found', 404);
    return send(res, 200, mapProduct(rows[0]));
  }

  if (p === '/api/admin/stock' && m === 'POST') {
    const b = await readBody(req);
    const qty = int(b.qty);
    if (!(qty > 0 && qty <= 10000)) throw new UserError('Enter a quantity greater than 0');
    if (!['production', 'waste', 'adjust-add', 'adjust-remove'].includes(b.type)) throw new UserError('Invalid type');
    const delta = b.type === 'production' || b.type === 'adjust-add' ? qty : -qty;
    const row = await q(sb().rpc('adjust_stock', { p_product: String(b.productId), p_delta: delta, p_type: b.type.startsWith('adjust') ? 'adjust' : b.type, p_note: clean(b.note, 200) }));
    return send(res, 200, mapProduct(row));
  }

  if (p === '/api/admin/movements' && m === 'GET') {
    return send(res, 200, (await q(sb().from('movements').select('*').order('at', { ascending: false }).limit(200))).map(mapMove));
  }

  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, await getSettings());
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await readBody(req);
    const s = await getSettings();
    for (const f of ['shopName', 'phone', 'upiId', 'address', 'hours']) if (b[f] !== undefined) s[f] = clean(b[f], 300);
    if (b.whatsapp !== undefined) s.whatsapp = String(b.whatsapp).replace(/\D/g, '').slice(0, 15);
    for (const f of ['deliveryCharge', 'freeDeliveryAbove', 'reviews']) if (b[f] !== undefined && int(b[f]) >= 0) s[f] = int(b[f]);
    if (b.rating !== undefined && Number(b.rating) >= 0 && Number(b.rating) <= 5) s.rating = Number(b.rating);
    await q(sb().from('settings').upsert({ id: 1, data: s }));
    return send(res, 200, s);
  }

  if (p === '/api/admin/export.csv' && m === 'GET') {
    const rows = (await all(() => sb().from('orders').select('*').order('created_at'))).map(mapOrder);
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const out = [['Order ID', 'Date (IST)', 'Channel', 'Status', 'Customer', 'Phone', 'Mode', 'Payment', 'Items', 'Packets', 'Total (Rs)']];
    for (const o of rows) out.push([o.id, new Date(o.createdAt + U.IST_OFFSET).toISOString().replace('T', ' ').slice(0, 16), o.channel, o.status, o.customer.name, o.customer.phone, o.mode, o.payment, o.items.map((l) => `${l.name} x${l.qty}`).join('; '), o.packets, o.total]);
    return send(res, 200, '﻿' + out.map((r) => r.map(esc).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pallay-ruchulu-orders-${dayKey(now())}.csv"` });
  }

  throw new UserError('Not found', 404);
}

// Entry point. On Vercel, /api/* is rewritten to /api?__p=* so we rebuild the original path.
module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const forwarded = url.searchParams.get('__p');
  if (forwarded !== null) {
    url.pathname = '/api/' + forwarded.replace(/^\/+/, '');
    url.searchParams.delete('__p');
  }
  try {
    await route(req, res, url);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof UserError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
};
