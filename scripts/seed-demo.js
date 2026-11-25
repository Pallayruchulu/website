// Fills the database with 30 days of SAMPLE orders so you can see the dashboard working.
// Usage: npm run demo            (refuses if real orders exist)
//        npm run demo -- --force (wipes everything and re-seeds)
const fs = require('fs');
const crypto = require('crypto');
const store = require('../db');

const force = process.argv.includes('--force');
if (fs.existsSync(store.DB_FILE) && !force) {
  const existing = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  if (existing.orders && existing.orders.length) {
    console.log('Database already has orders. Run "npm run demo -- --force" to WIPE it and load sample data.');
    process.exit(1);
  }
}

const db = store.emptyDb();
const names = ['Lakshmi', 'Ravi', 'Sravani', 'Kiran', 'Padma', 'Suresh', 'Anitha', 'Venkat', 'Divya', 'Mahesh', 'Swathi', 'Ramesh'];
const areas = ['Nizampet', 'Bachupally', 'Pragathi Nagar', 'KPHB', 'Miyapur', 'Kukatpally'];
const weights = { 'idly-batter': 5, 'dosa-batter': 5, 'millet-dosa': 2, chapati: 3, poori: 2 };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DAY = 86400000;
const now = Date.now();

for (const p of db.products) { p.stock = 0; }

for (let d = 29; d >= 0; d--) {
  const dayStart = now - d * DAY - (now % DAY);
  // morning production
  for (const p of db.products) {
    const made = weights[p.id] * 2 + Math.floor(Math.random() * 4) + (d === 0 ? 4 : 0);
    p.stock += made;
    db.movements.push({ id: crypto.randomUUID(), at: dayStart + 1 * 3600000, productId: p.id, type: 'production', qty: made, note: 'Morning batch', ref: null });
  }
  const nOrders = 8 + Math.floor(Math.random() * 10) + (d % 7 === 0 ? 6 : 0);
  for (let i = 0; i < nOrders; i++) {
    const at = Math.min(now - 60000, dayStart + (1.5 + Math.random() * 13) * 3600000);
    const items = [];
    const n = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < n; k++) {
      const p = pick(db.products.flatMap((x) => Array(weights[x.id]).fill(x)));
      const qty = 1 + Math.floor(Math.random() * 3);
      if (p.stock < qty || items.find((l) => l.productId === p.id)) continue;
      p.stock -= qty;
      items.push({ productId: p.id, name: p.name, qty, price: p.price });
    }
    if (!items.length) continue;
    const id = 'PR' + db.nextOrderNo++;
    for (const l of items) db.movements.push({ id: crypto.randomUUID(), at, productId: l.productId, type: 'sale', qty: -l.qty, note: '', ref: id });
    const shop = Math.random() < 0.45;
    const sub = items.reduce((s, l) => s + l.qty * l.price, 0);
    const delivery = !shop && sub < 300 ? 20 : 0;
    const status = shop ? 'delivered' : d > 0 ? (Math.random() < 0.04 ? 'cancelled' : 'delivered') : pick(['new', 'preparing', 'out', 'delivered']);
    if (status === 'cancelled') for (const l of items) { db.products.find((x) => x.id === l.productId).stock += l.qty; }
    const name = pick(names);
    db.orders.push({
      id, createdAt: at, channel: shop ? 'shop' : 'online', status,
      customer: { name: shop ? 'Walk-in customer' : name, phone: shop ? '' : '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), address: shop ? '' : `Flat ${100 + Math.floor(Math.random() * 400)}, ${pick(areas)}` },
      mode: shop ? 'pickup' : 'delivery', payment: shop ? pick(['cash', 'upi']) : pick(['cod', 'upi']), note: '',
      items, subtotal: sub, delivery, total: sub + delivery
    });
  }
  // evening waste of leftovers older batter
  if (d > 0 && Math.random() < 0.3) {
    const p = pick(db.products);
    const w = Math.min(p.stock, 1 + Math.floor(Math.random() * 3));
    if (w > 0) { p.stock -= w; db.movements.push({ id: crypto.randomUUID(), at: dayStart + 20 * 3600000, productId: p.id, type: 'waste', qty: -w, note: 'Expired', ref: null }); }
  }
}
// ---- sample staff, attendance, messages, salary, expenses ----
const STALL = { lat: 17.5146, lng: 78.3862 };
const mk = (name, stallName, payType, salary, phone) => ({ id: crypto.randomUUID(), name, phone, role: 'Stall staff', stallName, stallLat: STALL.lat + (Math.random() - 0.5) * 0.01, stallLng: STALL.lng + (Math.random() - 0.5) * 0.01, radiusM: 150, payType, salary, token: crypto.randomBytes(24).toString('hex'), active: true, createdAt: now - 40 * DAY });
db.staff = [mk('Ravi', 'Nizampet X-Roads stall', 'monthly', 12000, '9000000001'), mk('Sravani', 'Bachupally stall', 'daily', 500, '9000000002')];
db.checkins = []; db.messages = []; db.payments = []; db.expenses = [];
const IST = 5.5 * 3600000;
const istMidnight = (d) => { const t = now - d * DAY; return t - ((t + IST) % DAY); };
for (const s of db.staff) {
  for (let d = 29; d >= 0; d--) {
    if (Math.random() < 0.12) continue; // day off
    const base = istMidnight(d);
    const late = Math.random() < 0.1;
    const inAt = base + (7 + Math.random()) * 3600000;
    if (inAt > now) continue;
    const off = late ? 900 : Math.random() * 60;
    const jitter = (m) => ({ lat: s.stallLat + (m / 111000) * (Math.random() < 0.5 ? -1 : 1), lng: s.stallLng });
    const p1 = jitter(off);
    db.checkins.push({ id: crypto.randomUUID(), staffId: s.id, at: inAt, type: 'in', ...p1, accuracy: 12, distanceM: Math.round(off), atStall: off <= 150, photo: null });
    const outAt = base + (19 + Math.random()) * 3600000;
    if (outAt < now) db.checkins.push({ id: crypto.randomUUID(), staffId: s.id, at: outAt, type: 'out', ...jitter(20), accuracy: 15, distanceM: 20, atStall: true, photo: null });
  }
  const t0 = istMidnight(0) + 10 * 3600000;
  if (t0 < now) {
    db.messages.push({ id: crypto.randomUUID(), staffId: s.id, at: t0, from: 'owner', kind: 'task', text: 'Collect 20 empty crates from the shop by 4 PM', done: false });
    db.messages.push({ id: crypto.randomUUID(), staffId: s.id, at: t0 + 600000, from: 'owner', kind: 'msg', text: 'How many idly packets left?', done: false });
    db.messages.push({ id: crypto.randomUUID(), staffId: s.id, at: t0 + 1200000, from: 'staff', kind: 'msg', text: '6 idly, 4 dosa left. Send 10 more idly please.', seen: false });
  }
}
const mon = (o) => new Date(now - o * 30 * DAY + IST).toISOString().slice(0, 7);
db.payments.push({ id: crypto.randomUUID(), staffId: db.staff[0].id, at: now - 20 * DAY, month: mon(0), amount: 3000, kind: 'advance', mode: 'cash', note: 'Festival advance' });
const cats = [['Raw material (rice/dal/millets)', 18000, '300 kg rice + urad dal'], ['Packaging', 3500, 'Pouches & labels'], ['Rent', 15000, 'Shop rent'], ['Electricity & water', 4200, ''], ['Gas / fuel', 2600, 'Delivery bike petrol'], ['Transport / delivery', 1800, '']];
for (const [category, amount, note] of cats) db.expenses.push({ id: crypto.randomUUID(), at: now, date: new Date(now - Math.floor(Math.random() * 20) * DAY + IST).toISOString().slice(0, 10), category, amount, note });

db.orders.sort((a, b) => a.createdAt - b.createdAt);
db.movements.sort((a, b) => a.at - b.at);

fs.mkdirSync(require('path').dirname(store.DB_FILE), { recursive: true });
fs.writeFileSync(store.DB_FILE, JSON.stringify(db, null, 2));
console.log(`Loaded SAMPLE data: ${db.orders.length} orders over 30 days. Restart the server if it is running.`);
console.log('To start fresh for real business, delete data/db.json.');
