// Staff links, stall check-in/out (GPS only at check-in & check-out), owner<->staff messages, salaries & expenses.
const crypto = require('crypto');
const U = require('./util');

const { sb, q, all, UserError, send, readBody, clean, int, now, dayKey, monthKey, istStart, monthRange, mapStaff, mapCheckin, mapMsg, mapPay, mapExp } = U;

const BUCKET = 'selfies';
const EXPENSE_CATEGORIES = ['Raw material (rice/dal/millets)', 'Packaging', 'Rent', 'Electricity & water', 'Gas / fuel', 'Transport / delivery', 'Repairs & maintenance', 'Other'];
const newToken = () => crypto.randomBytes(24).toString('hex');
const todayStart = () => istStart(dayKey(now()));
const validMonth = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? m : monthKey(now()));

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new UserError('Invalid photo');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_500_000) throw new UserError('Photo too large');
  const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  const { error } = await sb().storage.from(BUCKET).upload(name, buf, { contentType: 'image/' + m[1], upsert: false });
  if (error) throw new Error('Photo upload failed: ' + error.message);
  return name;
}

// ctx: today's checkins (asc) for this staff, pending request row, unread count, today's stall orders
function status(ctx) {
  const todays = ctx.checkins;
  const last = todays[todays.length - 1] || null;
  const shift = [...todays].reverse().find((c) => c.type === 'in' || c.type === 'out') || null;
  const firstIn = todays.find((c) => c.type === 'in') || null;
  const out = {
    state: 'absent', label: 'Not checked in today', since: firstIn ? firstIn.at : null,
    lastAt: last ? last.at : null, distanceM: shift ? shift.distanceM : null,
    mapUrl: shift && shift.lat != null ? `https://www.google.com/maps?q=${shift.lat},${shift.lng}` : null,
    lastSelfieAt: [...todays].reverse().find((c) => c.photo)?.at || null,
    lastPhoto: [...todays].reverse().find((c) => c.photo)?.photo || null,
    pendingRequest: ctx.pending ? { id: ctx.pending.id, at: ctx.pending.at } : null,
    unread: ctx.unread || 0,
    packetsToday: ctx.sales.reduce((a, o) => a + o.packets, 0),
    salesToday: ctx.sales.reduce((a, o) => a + o.total, 0)
  };
  if (!shift) return out;
  out.shiftAt = shift.at;
  if (shift.type === 'out') { out.state = 'out'; out.label = 'Checked out'; return out; }
  if (shift.atStall === true) { out.state = 'present'; out.label = 'Checked in at the stall'; }
  else if (shift.atStall === false) { out.state = 'away'; out.label = 'Checked in away from stall'; }
  else { out.state = 'present'; out.label = 'Checked in (stall location not set)'; }
  return out;
}

// Loads everything needed to compute status for the given staff ids
async function statusContexts(ids) {
  if (!ids.length) return {};
  const t0 = todayStart();
  const [cks, pend, unseen, sales] = await Promise.all([
    q(sb().from('checkins').select('*').in('staff_id', ids).gte('at', t0).order('at')),
    q(sb().from('messages').select('id,staff_id,at').in('staff_id', ids).eq('kind', 'checkin-request').eq('done', false).order('at')),
    q(sb().from('messages').select('staff_id').in('staff_id', ids).eq('from_role', 'staff').eq('seen', false)),
    q(sb().from('orders').select('staff_id,packets,total').in('staff_id', ids).gte('created_at', t0).neq('status', 'cancelled'))
  ]);
  const ctx = Object.fromEntries(ids.map((id) => [id, { checkins: [], pending: null, unread: 0, sales: [] }]));
  for (const c of cks) ctx[c.staff_id].checkins.push(mapCheckin(c));
  for (const p of pend) if (!ctx[p.staff_id].pending) ctx[p.staff_id].pending = { id: p.id, at: Date.parse(p.at) };
  for (const u of unseen) ctx[u.staff_id].unread++;
  for (const o of sales) ctx[o.staff_id].sales.push(o);
  return ctx;
}

function attendanceFrom(checkins) {
  const days = {};
  for (const c of checkins) {
    const d = dayKey(c.at);
    const r = (days[d] = days[d] || { date: d, in: null, out: null, checks: 0, awayChecks: 0 });
    if (c.type === 'in' && !r.in) r.in = c.at;
    if (c.type === 'out') r.out = c.at;
    r.checks++;
    if (c.atStall === false) r.awayChecks++;
  }
  return Object.values(days).filter((d) => d.in).sort((a, b) => (a.date < b.date ? 1 : -1));
}

function payroll(s, daysPresent, pays) {
  const sum = (k) => pays.filter((p) => p.kind === k).reduce((a, p) => a + p.amount, 0);
  const earned = s.payType === 'daily' ? daysPresent * s.salary : s.salary;
  const paid = sum('salary') + sum('advance');
  return { staffId: s.id, name: s.name, payType: s.payType, rate: s.salary, daysPresent, earned, paidSalary: sum('salary'), advance: sum('advance'), bonus: sum('bonus'), balance: earned - paid };
}

async function createOrder(p) { return U.mapOrder(await q(sb().rpc('create_order', { p }))); }

// ================= PUBLIC (staff link) =================
async function publicRoutes(req, res, url) {
  const mt = url.pathname.match(/^\/api\/staff\/([a-f0-9]{32,64})(\/.*)?$/);
  if (!mt) throw new UserError('Not found', 404);
  const row = await q(sb().from('staff').select('*').eq('token', mt[1]).eq('active', true).maybeSingle());
  if (!row) throw new UserError('This link is no longer valid. Please ask the owner for a new link.', 404);
  const s = mapStaff(row);
  const sub = mt[2] || '/';
  const m = req.method;

  if (sub === '/' && m === 'GET') {
    const [ctx, msgs, prods] = await Promise.all([
      statusContexts([s.id]),
      q(sb().from('messages').select('*').eq('staff_id', s.id).order('at', { ascending: false }).limit(60)),
      q(sb().from('products').select('id,name,price,emoji,stock').eq('active', true).order('sort'))
    ]);
    const st = status(ctx[s.id]);
    return send(res, 200, {
      name: s.name, stallName: s.stallName, hasStallLocation: s.stallLat != null, radiusM: s.radiusM,
      status: st, products: prods,
      messages: msgs.reverse().map(mapMsg),
      todayChecks: ctx[s.id].checkins.map((c) => ({ at: c.at, type: c.type, atStall: c.atStall, distanceM: c.distanceM }))
    });
  }

  if (sub === '/checkin' && m === 'POST') {
    const b = await readBody(req, 2_500_000);
    // GPS is taken ONLY at check-in and check-out. 'ping' = selfie-only reply to an owner request.
    const type = ['in', 'out', 'ping'].includes(b.type) ? b.type : null;
    if (!type) throw new UserError('Invalid type');
    const useGps = type !== 'ping';
    const lat = useGps ? Number(b.lat) : null, lng = useGps ? Number(b.lng) : null;
    if (useGps && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw new UserError('Location is required. Please allow location access.');
    if ((type === 'in' || type === 'ping') && !b.photo) throw new UserError('A selfie is required');
    const photo = await savePhoto(b.photo);
    const hasStall = s.stallLat != null && s.stallLng != null;
    const dist = hasStall && useGps ? distanceM(lat, lng, s.stallLat, s.stallLng) : null;
    const acc = useGps ? Math.max(0, Math.min(5000, Number(b.accuracy) || 0)) : null;
    const c = await q(sb().from('checkins').insert({
      staff_id: s.id, type, lat, lng, accuracy: acc == null ? null : Math.round(acc), distance_m: dist,
      at_stall: hasStall && useGps ? dist <= s.radiusM + Math.min(acc, 100) : null, photo
    }).select().single());
    if (type === 'ping') {
      await q(sb().from('messages').update({ done: true, done_at: new Date().toISOString(), checkin_id: c.id }).eq('staff_id', s.id).eq('kind', 'checkin-request').eq('done', false));
    }
    return send(res, 201, { at: Date.parse(c.at), atStall: c.at_stall, distanceM: c.distance_m, type });
  }

  if (sub === '/message' && m === 'POST') {
    const b = await readBody(req);
    const text = clean(b.text, 500);
    if (!text) throw new UserError('Message is empty');
    const msg = await q(sb().from('messages').insert({ staff_id: s.id, from_role: 'staff', kind: 'msg', text }).select().single());
    return send(res, 201, mapMsg(msg));
  }

  const done = sub.match(/^\/messages\/([a-f0-9-]{36})\/done$/);
  if (done && m === 'POST') {
    const rows = await q(sb().from('messages').update({ done: true, done_at: new Date().toISOString() }).eq('id', done[1]).eq('staff_id', s.id).eq('kind', 'task').select());
    if (!rows.length) throw new UserError('Task not found', 404);
    return send(res, 200, mapMsg(rows[0]));
  }

  if (sub === '/sale' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.items)) throw new UserError('Tap the products you sold first');
    const o = await createOrder({
      channel: 'stall', status: 'delivered', staff_id: s.id,
      customer: { name: `Stall · ${s.stallName || s.name}`, phone: '', address: '' },
      mode: 'pickup', payment: b.payment === 'upi' ? 'upi' : 'cash', note: `Sold by ${s.name}`,
      items: b.items.map((i) => ({ id: String(i.id), qty: int(i.qty) }))
    });
    return send(res, 201, { id: o.id, total: o.total });
  }

  throw new UserError('Not found', 404);
}

// ================= ADMIN =================
async function adminRoutes(req, res, url) {
  const p = url.pathname, m = req.method;

  if (p === '/api/admin/staff' && m === 'GET') {
    const list = (await q(sb().from('staff').select('*').order('created_at'))).map(mapStaff);
    const ctx = await statusContexts(list.filter((s) => s.active).map((s) => s.id));
    return send(res, 200, list.map((s) => ({ ...s, status: s.active ? status(ctx[s.id]) : null })));
  }

  if (p === '/api/admin/staff' && m === 'POST') {
    const b = await readBody(req);
    const name = clean(b.name, 60);
    if (name.length < 2) throw new UserError('Name required');
    const row = await q(sb().from('staff').insert({
      name, phone: clean(b.phone, 15), role: clean(b.role, 40) || 'Stall staff', stall_name: clean(b.stallName, 60),
      radius_m: Math.max(30, int(b.radiusM) || 150), pay_type: b.payType === 'daily' ? 'daily' : 'monthly',
      salary: Math.max(0, int(b.salary) || 0), token: newToken(), active: true
    }).select().single());
    return send(res, 201, mapStaff(row));
  }

  const sm = p.match(/^\/api\/admin\/staff\/([a-f0-9-]{36})(\/[a-z-]+)?$/);
  if (sm) {
    const row = await q(sb().from('staff').select('*').eq('id', sm[1]).maybeSingle());
    if (!row) throw new UserError('Staff not found', 404);
    const s = mapStaff(row);
    const sub = sm[2] || '';
    const update = async (upd) => send(res, 200, mapStaff(await q(sb().from('staff').update(upd).eq('id', s.id).select().single())));

    if (!sub && m === 'PATCH') {
      const b = await readBody(req);
      const upd = {};
      for (const [f, col] of [['name', 'name'], ['phone', 'phone'], ['role', 'role'], ['stallName', 'stall_name']]) if (b[f] !== undefined) upd[col] = clean(b[f], 60);
      if (b.payType !== undefined) upd.pay_type = b.payType === 'daily' ? 'daily' : 'monthly';
      if (b.salary !== undefined && int(b.salary) >= 0) upd.salary = int(b.salary);
      if (b.radiusM !== undefined && int(b.radiusM) >= 30) upd.radius_m = int(b.radiusM);
      if (b.active !== undefined) upd.active = !!b.active;
      if (b.stallLat !== undefined) {
        if (b.stallLat === null) { upd.stall_lat = null; upd.stall_lng = null; }
        else {
          const la = Number(b.stallLat), ln = Number(b.stallLng);
          if (!(Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180)) throw new UserError('Invalid stall location');
          upd.stall_lat = la; upd.stall_lng = ln;
        }
      }
      return update(upd);
    }

    if (sub === '/reset-link' && m === 'POST') return update({ token: newToken() });

    if (sub === '/stall-from-last' && m === 'POST') {
      const last = await q(sb().from('checkins').select('lat,lng').eq('staff_id', s.id).not('lat', 'is', null).order('at', { ascending: false }).limit(1).maybeSingle());
      if (!last) throw new UserError('No check-in yet to take the location from');
      return update({ stall_lat: last.lat, stall_lng: last.lng });
    }

    if (sub === '/detail' && m === 'GET') {
      const month = validMonth(url.searchParams.get('month'));
      const [from, to] = monthRange(month);
      // opening the detail marks staff messages as seen
      await q(sb().from('messages').update({ seen: true }).eq('staff_id', s.id).eq('from_role', 'staff').eq('seen', false));
      const [ctx, cks, msgs, monthCks, monthPays, pays] = await Promise.all([
        statusContexts([s.id]),
        q(sb().from('checkins').select('*').eq('staff_id', s.id).order('at', { ascending: false }).limit(60)),
        q(sb().from('messages').select('*').eq('staff_id', s.id).order('at', { ascending: false }).limit(100)),
        q(sb().from('checkins').select('*').eq('staff_id', s.id).gte('at', from).lt('at', to).order('at')),
        q(sb().from('payments').select('*').eq('staff_id', s.id).eq('month', month)),
        q(sb().from('payments').select('*').eq('staff_id', s.id).order('at', { ascending: false }).limit(30))
      ]);
      const att = attendanceFrom(monthCks.map(mapCheckin));
      return send(res, 200, {
        staff: s, status: status(ctx[s.id]), month,
        checkins: cks.map(mapCheckin),
        messages: msgs.reverse().map(mapMsg),
        attendance: att,
        payroll: payroll(s, att.length, monthPays.map(mapPay)),
        payments: pays.map(mapPay)
      });
    }

    if (sub === '/message' && m === 'POST') {
      const b = await readBody(req);
      const kind = ['msg', 'task', 'checkin-request'].includes(b.kind) ? b.kind : 'msg';
      const text = kind === 'checkin-request' ? (clean(b.text, 500) || 'Please send a selfie from the stall now.') : clean(b.text, 500);
      if (!text) throw new UserError('Message is empty');
      const msg = await q(sb().from('messages').insert({ staff_id: s.id, from_role: 'owner', kind, text }).select().single());
      return send(res, 201, mapMsg(msg));
    }
  }

  const photo = p.match(/^\/api\/admin\/photo\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/);
  if (photo && m === 'GET') {
    const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(photo[1], 600);
    if (error || !data) throw new UserError('Not found', 404);
    res.writeHead(302, { Location: data.signedUrl, 'Cache-Control': 'private, max-age=300' });
    res.end();
    return;
  }

  // ---------- money ----------
  if (p === '/api/admin/money' && m === 'GET') {
    const month = validMonth(url.searchParams.get('month'));
    const [from, to] = monthRange(month);
    const [y, mo] = month.split('-').map(Number);
    const nextMonth = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    const [orders, expenses, payments, staff, ins] = await Promise.all([
      all(() => sb().from('orders').select('total').neq('status', 'cancelled').gte('created_at', from).lt('created_at', to)),
      q(sb().from('expenses').select('*').gte('date', `${month}-01`).lt('date', `${nextMonth}-01`).order('date', { ascending: false })),
      q(sb().from('payments').select('*').eq('month', month).order('at', { ascending: false })),
      q(sb().from('staff').select('*').order('created_at')),
      all(() => sb().from('checkins').select('staff_id,at').eq('type', 'in').gte('at', from).lt('at', to))
    ]);
    const sales = orders.reduce((a, o) => a + o.total, 0);
    const exps = expenses.map(mapExp), pays = payments.map(mapPay), staffList = staff.map(mapStaff);
    const byCat = {};
    for (const e of exps) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const expenseTotal = exps.reduce((a, e) => a + e.amount, 0);
    const staffPaid = pays.reduce((a, x) => a + x.amount, 0);
    const days = {};
    for (const c of ins) (days[c.staff_id] = days[c.staff_id] || new Set()).add(dayKey(Date.parse(c.at)));
    const names = Object.fromEntries(staffList.map((s) => [s.id, s.name]));
    return send(res, 200, {
      month, categories: EXPENSE_CATEGORIES,
      totals: { sales, expenses: expenseTotal, staffPaid, profit: sales - expenseTotal - staffPaid, orders: orders.length },
      byCategory: Object.entries(byCat).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
      expenses: exps,
      payments: pays.map((x) => ({ ...x, name: names[x.staffId] || 'Removed staff' })),
      payroll: staffList.filter((s) => s.active || pays.some((x) => x.staffId === s.id))
        .map((s) => payroll(s, days[s.id] ? days[s.id].size : 0, pays.filter((x) => x.staffId === s.id)))
    });
  }

  if (p === '/api/admin/payments' && m === 'POST') {
    const b = await readBody(req);
    const s = await q(sb().from('staff').select('id').eq('id', String(b.staffId || '')).maybeSingle());
    if (!s) throw new UserError('Choose a staff member');
    const amount = int(b.amount);
    if (!(amount > 0)) throw new UserError('Enter an amount');
    const month = validMonth(b.month);
    const kind = ['salary', 'advance', 'bonus'].includes(b.kind) ? b.kind : 'salary';
    const mode = ['cash', 'upi', 'bank'].includes(b.mode) ? b.mode : 'cash';
    const pay = await q(sb().from('payments').insert({ staff_id: s.id, month, amount, kind, mode, note: clean(b.note, 200) }).select().single());
    // staff sees it on their page
    await q(sb().from('messages').insert({ staff_id: s.id, from_role: 'owner', kind: 'msg', text: `💰 ${kind === 'advance' ? 'Advance' : kind === 'bonus' ? 'Bonus' : 'Salary'} of ₹${amount.toLocaleString('en-IN')} paid (${mode.toUpperCase()}) for ${month}.` }));
    return send(res, 201, mapPay(pay));
  }

  if (p === '/api/admin/expenses' && m === 'POST') {
    const b = await readBody(req);
    const amount = int(b.amount);
    if (!(amount > 0)) throw new UserError('Enter an amount');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : dayKey(now());
    const e = await q(sb().from('expenses').insert({ date, category: EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'Other', amount, note: clean(b.note, 200) }).select().single());
    return send(res, 201, mapExp(e));
  }

  const del = p.match(/^\/api\/admin\/(expenses|payments)\/([a-f0-9-]{36})$/);
  if (del && m === 'DELETE') {
    const rows = await q(sb().from(del[1]).delete().eq('id', del[2]).select('id'));
    if (!rows.length) throw new UserError('Not found', 404);
    return send(res, 200, { ok: true });
  }

  return false; // not handled here
}

module.exports = { publicRoutes, adminRoutes };
