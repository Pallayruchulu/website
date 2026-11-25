// Staff, stall attendance (GPS + selfie), owner<->staff messages, salaries & expenses.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHOTO_DIR = path.join(__dirname, 'data', 'photos');
const EXPENSE_CATEGORIES = ['Raw material (rice/dal/millets)', 'Packaging', 'Rent', 'Electricity & water', 'Gas / fuel', 'Transport / delivery', 'Repairs & maintenance', 'Other'];

module.exports = function staffModule(ctx) {
  const { send, readBody, clean, int, takeStock, dayKey, now, store } = ctx;

  function ensure(db) {
    db.staff = db.staff || [];
    db.checkins = db.checkins || [];
    db.messages = db.messages || [];
    db.payments = db.payments || [];
    db.expenses = db.expenses || [];
  }

  const newToken = () => crypto.randomBytes(24).toString('hex');
  const monthKey = (ts) => dayKey(ts).slice(0, 7);

  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }

  function savePhoto(dataUrl) {
    if (!dataUrl) return null;
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw new Error('Invalid photo');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1_500_000) throw new Error('Photo too large');
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    return name;
  }

  // Today's presence status for one staff member
  function status(db, s) {
    const today = dayKey(now());
    const todays = db.checkins.filter((c) => c.staffId === s.id && dayKey(c.at) === today);
    const last = todays[todays.length - 1] || null;            // any event (incl. selfie-only)
    const shift = [...todays].reverse().find((c) => c.type === 'in' || c.type === 'out') || null; // GPS events only
    const firstIn = todays.find((c) => c.type === 'in') || null;
    const pendingRequest = db.messages.find((m) => m.staffId === s.id && m.kind === 'checkin-request' && !m.done) || null;
    const unread = db.messages.filter((m) => m.staffId === s.id && m.from === 'staff' && !m.seen).length;
    const salesToday = db.orders.filter((o) => o.staffId === s.id && o.status !== 'cancelled' && dayKey(o.createdAt) === today);
    const out = {
      state: 'absent', label: 'Not checked in today', since: firstIn ? firstIn.at : null,
      lastAt: last ? last.at : null, distanceM: shift ? shift.distanceM : null,
      mapUrl: shift && shift.lat != null ? `https://www.google.com/maps?q=${shift.lat},${shift.lng}` : null,
      lastSelfieAt: [...todays].reverse().find((c) => c.photo)?.at || null,
      lastPhoto: [...todays].reverse().find((c) => c.photo)?.photo || null,
      pendingRequest: pendingRequest ? { id: pendingRequest.id, at: pendingRequest.at } : null,
      unread,
      packetsToday: salesToday.reduce((a, o) => a + o.items.reduce((x, l) => x + l.qty, 0), 0),
      salesToday: salesToday.reduce((a, o) => a + o.total, 0)
    };
    if (!shift) return out;
    out.shiftAt = shift.at;
    if (shift.type === 'out') { out.state = 'out'; out.label = 'Checked out'; return out; }
    if (shift.atStall === true) { out.state = 'present'; out.label = 'Checked in at the stall'; }
    else if (shift.atStall === false) { out.state = 'away'; out.label = 'Checked in away from stall'; }
    else { out.state = 'present'; out.label = 'Checked in (stall location not set)'; }
    return out;
  }

  function attendance(db, staffId, month) {
    const days = {};
    for (const c of db.checkins) {
      if (c.staffId !== staffId || monthKey(c.at) !== month) continue;
      const d = dayKey(c.at);
      const r = (days[d] = days[d] || { date: d, in: null, out: null, checks: 0, awayChecks: 0 });
      if (c.type === 'in' && !r.in) r.in = c.at;
      if (c.type === 'out') r.out = c.at;
      r.checks++;
      if (c.atStall === false) r.awayChecks++;
    }
    return Object.values(days).filter((d) => d.in).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function payroll(db, s, month) {
    const days = attendance(db, s.id, month).length;
    const pays = db.payments.filter((p) => p.staffId === s.id && p.month === month);
    const sum = (k) => pays.filter((p) => p.kind === k).reduce((a, p) => a + p.amount, 0);
    const earned = s.payType === 'daily' ? days * s.salary : s.salary;
    const paid = sum('salary') + sum('advance');
    return { staffId: s.id, name: s.name, payType: s.payType, rate: s.salary, daysPresent: days, earned, paidSalary: sum('salary'), advance: sum('advance'), bonus: sum('bonus'), balance: earned - paid };
  }

  const publicStaff = (s) => ({ id: s.id, name: s.name, phone: s.phone, role: s.role, stallName: s.stallName, stallLat: s.stallLat, stallLng: s.stallLng, radiusM: s.radiusM, payType: s.payType, salary: s.salary, active: s.active, token: s.token, createdAt: s.createdAt });

  // ================= PUBLIC (staff link) =================
  async function publicRoutes(req, res, url, db) {
    ensure(db);
    const mt = url.pathname.match(/^\/api\/staff\/([a-f0-9]{32,64})(\/.*)?$/);
    if (!mt) return send(res, 404, { error: 'Not found' });
    const s = db.staff.find((x) => x.token === mt[1] && x.active);
    if (!s) return send(res, 404, { error: 'This link is no longer valid. Please ask the owner for a new link.' });
    const sub = mt[2] || '/';
    const m = req.method;

    if (sub === '/' && m === 'GET') {
      const today = dayKey(now());
      const st = status(db, s);
      return send(res, 200, {
        name: s.name, stallName: s.stallName, hasStallLocation: s.stallLat != null, radiusM: s.radiusM,
        status: st,
        products: db.products.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, price: p.price, emoji: p.emoji, stock: p.stock })),
        messages: db.messages.filter((x) => x.staffId === s.id).slice(-60),
        todayChecks: db.checkins.filter((c) => c.staffId === s.id && dayKey(c.at) === today).map((c) => ({ at: c.at, type: c.type, atStall: c.atStall, distanceM: c.distanceM }))
      });
    }

    if (sub === '/checkin' && m === 'POST') {
      const b = await readBody(req, 2_500_000);
      // GPS is taken ONLY at check-in and check-out. 'ping' = selfie-only reply to an owner request (no location).
      const type = ['in', 'out', 'ping'].includes(b.type) ? b.type : null;
      if (!type) return send(res, 400, { error: 'Invalid type' });
      const useGps = type !== 'ping';
      const lat = useGps ? Number(b.lat) : null, lng = useGps ? Number(b.lng) : null;
      if (useGps && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) return send(res, 400, { error: 'Location is required. Please allow location access.' });
      if ((type === 'in' || type === 'ping') && !b.photo) return send(res, 400, { error: 'A selfie is required' });
      let photo = null;
      try { photo = savePhoto(b.photo); } catch (e) { return send(res, 400, { error: e.message }); }
      const hasStall = s.stallLat != null && s.stallLng != null;
      const dist = hasStall && useGps ? distanceM(lat, lng, s.stallLat, s.stallLng) : null;
      const acc = useGps ? Math.max(0, Math.min(5000, Number(b.accuracy) || 0)) : 0;
      const c = {
        id: crypto.randomUUID(), staffId: s.id, at: now(), type, lat, lng, accuracy: Math.round(acc),
        distanceM: dist, atStall: hasStall && useGps ? dist <= s.radiusM + Math.min(acc, 100) : null, photo
      };
      db.checkins.push(c);
      // answering a check-in request
      if (type === 'ping') for (const r of db.messages) if (r.staffId === s.id && r.kind === 'checkin-request' && !r.done) { r.done = true; r.doneAt = now(); r.checkinId = c.id; }
      store.save();
      return send(res, 201, { at: c.at, atStall: c.atStall, distanceM: c.distanceM, type });
    }

    if (sub === '/message' && m === 'POST') {
      const b = await readBody(req);
      const text = clean(b.text, 500);
      if (!text) return send(res, 400, { error: 'Message is empty' });
      const msg = { id: crypto.randomUUID(), staffId: s.id, at: now(), from: 'staff', kind: 'msg', text, seen: false };
      db.messages.push(msg);
      store.save();
      return send(res, 201, msg);
    }

    const done = sub.match(/^\/messages\/([a-f0-9-]{36})\/done$/);
    if (done && m === 'POST') {
      const msg = db.messages.find((x) => x.id === done[1] && x.staffId === s.id && x.kind === 'task');
      if (!msg) return send(res, 404, { error: 'Task not found' });
      msg.done = true; msg.doneAt = now();
      store.save();
      return send(res, 200, msg);
    }

    if (sub === '/sale' && m === 'POST') {
      const b = await readBody(req);
      const id = 'PR' + db.nextOrderNo;
      let t;
      try { t = takeStock(db, b.items, id); } catch (e) { return send(res, 400, { error: e.message }); }
      const order = {
        id, createdAt: now(), channel: 'stall', staffId: s.id, status: 'delivered',
        customer: { name: `Stall · ${s.stallName || s.name}`, phone: '', address: '' },
        mode: 'pickup', payment: b.payment === 'upi' ? 'upi' : 'cash', note: `Sold by ${s.name}`,
        items: t.lines, subtotal: t.subtotal, delivery: 0, total: t.subtotal
      };
      db.nextOrderNo++;
      db.orders.push(order);
      store.save();
      return send(res, 201, { id: order.id, total: order.total });
    }

    return send(res, 404, { error: 'Not found' });
  }

  // ================= ADMIN =================
  async function adminRoutes(req, res, url, db) {
    ensure(db);
    const p = url.pathname, m = req.method;

    if (p === '/api/admin/staff' && m === 'GET') {
      return send(res, 200, db.staff.map((s) => ({ ...publicStaff(s), status: s.active ? status(db, s) : null })));
    }

    if (p === '/api/admin/staff' && m === 'POST') {
      const b = await readBody(req);
      const name = clean(b.name, 60);
      if (name.length < 2) return send(res, 400, { error: 'Name required' });
      const s = {
        id: crypto.randomUUID(), name, phone: clean(b.phone, 15), role: clean(b.role, 40) || 'Stall staff',
        stallName: clean(b.stallName, 60), stallLat: null, stallLng: null, radiusM: Math.max(30, int(b.radiusM) || 150),
        payType: b.payType === 'daily' ? 'daily' : 'monthly', salary: Math.max(0, int(b.salary) || 0),
        token: newToken(), active: true, createdAt: now()
      };
      db.staff.push(s);
      store.save();
      return send(res, 201, publicStaff(s));
    }

    const sm = p.match(/^\/api\/admin\/staff\/([a-f0-9-]{36})(\/[a-z-]+)?$/);
    if (sm) {
      const s = db.staff.find((x) => x.id === sm[1]);
      if (!s) return send(res, 404, { error: 'Staff not found' });
      const sub = sm[2] || '';

      if (!sub && m === 'PATCH') {
        const b = await readBody(req);
        for (const f of ['name', 'phone', 'role', 'stallName']) if (b[f] !== undefined) s[f] = clean(b[f], 60);
        if (b.payType !== undefined) s.payType = b.payType === 'daily' ? 'daily' : 'monthly';
        if (b.salary !== undefined && int(b.salary) >= 0) s.salary = int(b.salary);
        if (b.radiusM !== undefined && int(b.radiusM) >= 30) s.radiusM = int(b.radiusM);
        if (b.active !== undefined) s.active = !!b.active;
        if (b.stallLat !== undefined) {
          const la = Number(b.stallLat), ln = Number(b.stallLng);
          if (b.stallLat === null) { s.stallLat = null; s.stallLng = null; }
          else if (Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) { s.stallLat = la; s.stallLng = ln; }
          else return send(res, 400, { error: 'Invalid stall location' });
        }
        store.save();
        return send(res, 200, publicStaff(s));
      }

      if (sub === '/reset-link' && m === 'POST') { s.token = newToken(); store.save(); return send(res, 200, publicStaff(s)); }

      if (sub === '/stall-from-last' && m === 'POST') {
        const last = [...db.checkins].reverse().find((c) => c.staffId === s.id && c.lat != null);
        if (!last) return send(res, 400, { error: 'No check-in yet to take the location from' });
        s.stallLat = last.lat; s.stallLng = last.lng;
        store.save();
        return send(res, 200, publicStaff(s));
      }

      if (sub === '/detail' && m === 'GET') {
        const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : monthKey(now());
        // opening the detail marks staff messages as seen
        let changed = false;
        for (const x of db.messages) if (x.staffId === s.id && x.from === 'staff' && !x.seen) { x.seen = true; changed = true; }
        if (changed) store.save();
        return send(res, 200, {
          staff: publicStaff(s), status: status(db, s), month,
          checkins: db.checkins.filter((c) => c.staffId === s.id).slice(-60).reverse(),
          messages: db.messages.filter((x) => x.staffId === s.id).slice(-100),
          attendance: attendance(db, s.id, month),
          payroll: payroll(db, s, month),
          payments: db.payments.filter((x) => x.staffId === s.id).slice(-30).reverse()
        });
      }

      if (sub === '/message' && m === 'POST') {
        const b = await readBody(req);
        const kind = ['msg', 'task', 'checkin-request'].includes(b.kind) ? b.kind : 'msg';
        const text = kind === 'checkin-request' ? (clean(b.text, 500) || 'Please send a selfie from the stall now.') : clean(b.text, 500);
        if (!text) return send(res, 400, { error: 'Message is empty' });
        const msg = { id: crypto.randomUUID(), staffId: s.id, at: now(), from: 'owner', kind, text, done: false };
        db.messages.push(msg);
        store.save();
        return send(res, 201, msg);
      }
    }

    const photo = p.match(/^\/api\/admin\/photo\/([a-f0-9-]{36}\.(jpg|png|webp))$/);
    if (photo && m === 'GET') {
      fs.readFile(path.join(PHOTO_DIR, photo[1]), (err, buf) => {
        if (err) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': photo[2] === 'jpg' ? 'image/jpeg' : 'image/' + photo[2], 'Cache-Control': 'private, max-age=86400' });
        res.end(buf);
      });
      return;
    }

    // ---------- money ----------
    if (p === '/api/admin/money' && m === 'GET') {
      const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : monthKey(now());
      const orders = db.orders.filter((o) => o.status !== 'cancelled' && monthKey(o.createdAt) === month);
      const sales = orders.reduce((a, o) => a + o.total, 0);
      const expenses = db.expenses.filter((e) => e.date.startsWith(month)).sort((a, b) => (a.date < b.date ? 1 : -1));
      const payments = db.payments.filter((x) => x.month === month).sort((a, b) => b.at - a.at);
      const byCat = {};
      for (const e of expenses) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
      const expenseTotal = expenses.reduce((a, e) => a + e.amount, 0);
      const staffPaid = payments.reduce((a, x) => a + x.amount, 0);
      const names = Object.fromEntries(db.staff.map((s) => [s.id, s.name]));
      return send(res, 200, {
        month, categories: EXPENSE_CATEGORIES,
        totals: { sales, expenses: expenseTotal, staffPaid, profit: sales - expenseTotal - staffPaid, orders: orders.length },
        byCategory: Object.entries(byCat).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
        expenses,
        payments: payments.map((x) => ({ ...x, name: names[x.staffId] || 'Removed staff' })),
        payroll: db.staff.filter((s) => s.active || payments.some((x) => x.staffId === s.id)).map((s) => payroll(db, s, month))
      });
    }

    if (p === '/api/admin/payments' && m === 'POST') {
      const b = await readBody(req);
      const s = db.staff.find((x) => x.id === b.staffId);
      if (!s) return send(res, 400, { error: 'Choose a staff member' });
      const amount = int(b.amount);
      if (!(amount > 0)) return send(res, 400, { error: 'Enter an amount' });
      const month = /^\d{4}-\d{2}$/.test(b.month || '') ? b.month : monthKey(now());
      const pay = { id: crypto.randomUUID(), staffId: s.id, at: now(), month, amount, kind: ['salary', 'advance', 'bonus'].includes(b.kind) ? b.kind : 'salary', mode: ['cash', 'upi', 'bank'].includes(b.mode) ? b.mode : 'cash', note: clean(b.note, 200) };
      db.payments.push(pay);
      // let the staff member see it on their page
      db.messages.push({ id: crypto.randomUUID(), staffId: s.id, at: now(), from: 'owner', kind: 'msg', text: `💰 ${pay.kind === 'advance' ? 'Advance' : pay.kind === 'bonus' ? 'Bonus' : 'Salary'} of ₹${amount.toLocaleString('en-IN')} paid (${pay.mode.toUpperCase()}) for ${month}.`, done: false });
      store.save();
      return send(res, 201, pay);
    }

    if (p === '/api/admin/expenses' && m === 'POST') {
      const b = await readBody(req);
      const amount = int(b.amount);
      if (!(amount > 0)) return send(res, 400, { error: 'Enter an amount' });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : dayKey(now());
      const e = { id: crypto.randomUUID(), at: now(), date, category: EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'Other', amount, note: clean(b.note, 200) };
      db.expenses.push(e);
      store.save();
      return send(res, 201, e);
    }

    const del = p.match(/^\/api\/admin\/(expenses|payments)\/([a-f0-9-]{36})$/);
    if (del && m === 'DELETE') {
      const list = db[del[1]];
      const i = list.findIndex((x) => x.id === del[2]);
      if (i < 0) return send(res, 404, { error: 'Not found' });
      list.splice(i, 1);
      store.save();
      return send(res, 200, { ok: true });
    }

    return false; // not handled here
  }

  return { publicRoutes, adminRoutes };
};
