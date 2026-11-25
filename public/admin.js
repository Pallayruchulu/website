(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => '₹' + Math.round(Number(n)).toLocaleString('en-IN');
  const num = (n) => Number(n).toLocaleString('en-IN');
  const STATUS = { new: 'New', preparing: 'Packing', out: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
  const fmtTime = (ts) => new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const shortDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  let S = null; // summary
  let products = [];
  let tab = 'overview';
  let metric = 'packets';
  let orderStatus = 'active';
  let bill = {};
  let billPay = 'cash';
  let lastNewest = null;

  // ---------- api ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Please log in'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  let toastT;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- auth ----------
  function showLogin() { $('#login').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#login').hidden = true; $('#app').hidden = false; }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: e.target.password.value } });
      e.target.reset(); showApp(); refresh();
    } catch (ex) { $('#loginErr').textContent = ex.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ---------- tabs ----------
  const TITLES = { staff: 'Staff & stalls', money: 'Salary & expenses', overview: 'Overview', orders: 'Orders', stock: 'Stock', shop: 'Shop counter sale', products: 'Products & prices', settings: 'Settings' };
  function go(t) {
    tab = t;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $$('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== t));
    $('#pageTitle').textContent = TITLES[t];
    renderTab();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

  async function refresh() {
    try {
      [S, products] = await Promise.all([api('/api/admin/summary'), api('/api/admin/products')]);
    } catch { return; }
    showApp();
    $('#todayLabel').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const pending = S.kpis.pendingOrders;
    $('#pendingBadge').hidden = !pending; $('#pendingBadge').textContent = pending;
    $('#lowBadge').hidden = !S.lowStock.length; $('#lowBadge').textContent = S.lowStock.length;
    document.title = (pending ? `(${pending}) ` : '') + 'Owner Dashboard · Pallay Ruchulu';
    checkNewOrders();
    if (window.PRStaff) window.PRStaff.poll();
    renderTab(true);
  }

  function checkNewOrders() {
    const newest = S.recentOrders.find((o) => o.channel === 'online');
    const id = newest ? newest.id : null;
    if (lastNewest !== null && id && id !== lastNewest) {
      toast(`🛎️ New order ${id} from ${newest.customer.name}`);
      beep();
    }
    lastNewest = id || '';
  }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.15, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.16);
      });
    } catch { /* ignore */ }
  }

  function renderTab(fromPoll) {
    if (!S) return;
    if (tab === 'overview') renderOverview();
    if (tab === 'orders') loadOrders();
    if (tab === 'stock') renderStock();
    if (tab === 'shop') renderShop();
    if ((tab === 'staff' || tab === 'money') && window.PRStaff) window.PRStaff.render(tab, fromPoll);
    if (tab === 'products' && !fromPoll) renderProducts(); // don't clobber edits in progress
    if (tab === 'settings' && !fromPoll) loadSettings();
  }

  // ---------- overview ----------
  function renderOverview() {
    const k = S.kpis;
    const top = S.products.slice().sort((a, b) => b.soldMonth - a.soldMonth)[0];
    $('#kpis').innerHTML = [
      ['hero', 'Packets sold today', num(k.packetsToday), `${k.ordersToday} order${k.ordersToday === 1 ? '' : 's'}`],
      ['', 'Sales today', rupee(k.revenueToday), ''],
      ['', 'Packets this month', num(k.packetsMonth), `Online ${num(k.onlineMonth)} · Shop ${num(k.shopMonth)}`],
      ['', 'Sales this month', rupee(k.revenueMonth), top && top.soldMonth ? `Top: ${esc(top.name)}` : ''],
      ['', 'Packets in stock', num(k.totalStock), `${S.lowStock.length} item${S.lowStock.length === 1 ? '' : 's'} running low`],
      ['', 'Orders to deliver', num(k.pendingOrders), `All-time: ${num(k.packetsAll)} packets`]
    ].map(([c, l, v, s]) => `<div class="kpi ${c}"><div class="label">${l}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join('');

    const la = $('#lowAlert');
    la.hidden = !S.lowStock.length;
    la.innerHTML = '⚠️ <b>Low stock:</b> ' + S.lowStock.map((p) => `${esc(p.name)} (${p.stock} left)`).join(', ') + ' — <button class="link" data-goto="stock">add production →</button>';

    drawChart();

    $('#prodTable').innerHTML = `<thead><tr><th>Product</th><th>In stock</th><th class="num">Sold today</th><th class="num">Sold this month</th><th class="num">Sales this month</th><th class="num">Made (30d)</th><th class="num">Wasted (30d)</th></tr></thead><tbody>` +
      S.products.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="pill">hidden</span>'}</td><td>${meter(p)}</td><td class="num">${num(p.soldToday)}</td><td class="num">${num(p.soldMonth)}</td><td class="num">${rupee(p.revenueMonth)}</td><td class="num">${num(p.produced30)}</td><td class="num">${num(p.wasted30)}</td></tr>`).join('') + '</tbody>';

    $('#recent').innerHTML = S.recentOrders.length ? S.recentOrders.slice(0, 5).map(orderCard).join('') : '<div class="empty">No orders yet. Share your website link with customers! 🙌</div>';
  }

  function stockStatus(p) {
    if (p.stock <= 0) return ['out', '✕ Out of stock'];
    if (p.stock <= p.lowStockAt) return ['low', '! Low'];
    return ['ok', '✓ OK'];
  }
  function meter(p) {
    const [cls, label] = stockStatus(p);
    const pct = Math.min(100, (p.stock / Math.max(p.lowStockAt * 4, 1)) * 100);
    const col = cls === 'ok' ? 'var(--good)' : cls === 'low' ? 'var(--warn)' : 'var(--crit)';
    return `<div class="meter"><b style="min-width:32px;text-align:right">${num(p.stock)}</b><div class="track"><div class="fill" style="width:${pct}%;background:${col}"></div></div><span class="status ${cls}">${label}</span></div>`;
  }

  // ---------- chart (single-series bars, SVG) ----------
  $('#chartMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    metric = b.dataset.m;
    $$('#chartMetric button').forEach((x) => x.classList.toggle('on', x === b));
    $('.panel-head h2', $('#chart').closest('.panel')).textContent = (metric === 'packets' ? 'Packets sold' : 'Sales (₹)') + ' · last 14 days';
    drawChart();
  });

  function niceMax(v) {
    if (v <= 0) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function drawChart() {
    const el = $('#chart');
    const data = S.daily;
    const W = Math.max(el.clientWidth, 320), H = 260;
    const pad = { l: metric === 'revenue' ? 56 : 36, r: 8, t: 22, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const vals = data.map((d) => d[metric]);
    const max = niceMax(Math.max(...vals));
    const step = iw / data.length;
    const bw = Math.max(6, Math.min(36, step - 4)); // keeps >= 2px gap between bars
    const y = (v) => pad.t + ih - (v / max) * ih;
    const fmt = (v) => (metric === 'revenue' ? rupee(v) : num(v));
    let s = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      s += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/><text class="axis" x="${pad.l - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
    }
    const maxI = vals.indexOf(Math.max(...vals));
    const labelEvery = step < 34 ? 2 : 1;
    data.forEach((d, i) => {
      const v = d[metric];
      const x = pad.l + i * step + (step - bw) / 2;
      const top = y(v), h = pad.t + ih - top;
      const r = Math.min(4, h, bw / 2);
      const path = h > 0
        ? `M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`
        : '';
      s += `<rect class="hit" data-i="${i}" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${ih}"/>`;
      s += path ? `<path class="bar" d="${path}"/>` : '<path class="bar"/>';
      const isToday = i === data.length - 1;
      if (v > 0 && (i === maxI || isToday)) s += `<text class="vlabel" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${fmt(v)}</text>`;
      if (i % labelEvery === (data.length - 1) % labelEvery) s += `<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${isToday ? 'Today' : shortDate(d.date)}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric === 'packets' ? 'Packets sold' : 'Sales'} per day for the last 14 days">${s}</svg>`;

    const tip = $('#tip');
    $$('.hit', el).forEach((h) => {
      h.addEventListener('mousemove', (e) => {
        const d = data[h.dataset.i];
        tip.hidden = false;
        tip.innerHTML = `<b>${new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</b><div><span>Packets</span><span>${num(d.packets)}</span></div><div><span>Sales</span><span>${rupee(d.revenue)}</span></div><div><span>Online / Shop</span><span>${d.online} / ${d.shop}</span></div>`;
        const tx = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
        tip.style.left = tx + 'px'; tip.style.top = e.clientY + 14 + 'px';
      });
      h.addEventListener('mouseleave', () => (tip.hidden = true));
    });

    $('#chartTable').innerHTML = `<table class="tbl"><thead><tr><th>Date</th><th class="num">Packets</th><th class="num">Online</th><th class="num">Shop</th><th class="num">Sales</th></tr></thead><tbody>${data.slice().reverse().map((d) => `<tr><td>${shortDate(d.date)}</td><td class="num">${d.packets}</td><td class="num">${d.online}</td><td class="num">${d.shop}</td><td class="num">${rupee(d.revenue)}</td></tr>`).join('')}</tbody></table>`;
  }
  let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => tab === 'overview' && S && drawChart(), 150); });

  // ---------- orders ----------
  function orderCard(o) {
    const pk = o.items.reduce((s, l) => s + l.qty, 0);
    const phone = (o.customer.phone || '').replace(/\D/g, '');
    const wa = phone ? `https://wa.me/${phone.length === 10 ? '91' + phone : phone}?text=${encodeURIComponent(`Hi ${o.customer.name}, this is Pallay Ruchulu about your order ${o.id}.`)}` : '';
    const canChange = o.status !== 'cancelled' && o.channel === 'online';
    return `<div class="order ${o.status === 'new' ? 'isnew' : ''}">
      <div>
        <h3>${esc(o.id)} · ${esc(o.customer.name)} <span class="pill st-${o.status}">${STATUS[o.status]}</span>${o.channel === 'shop' ? '<span class="pill shop">Shop counter</span>' : o.channel === 'stall' ? `<span class="pill shop">Stall · ${esc(o.note.replace('Sold by ', ''))}</span>` : ''}</h3>
        <div class="meta">${fmtTime(o.createdAt)} · ${o.mode === 'pickup' ? '🏪 Pickup' : '🛵 Delivery'} · ${o.payment.toUpperCase()}</div>
        <div class="items">${o.items.map((l) => `${esc(l.name)} × <b>${l.qty}</b>`).join(' · ')} <span class="muted">(${pk} packet${pk === 1 ? '' : 's'})</span></div>
        ${o.customer.address ? `<div class="meta">📍 ${esc(o.customer.address)}</div>` : ''}
        ${o.note ? `<div class="meta">📝 ${esc(o.note)}</div>` : ''}
        ${phone ? `<div class="contact"><a href="tel:${esc(phone)}">📞 ${esc(o.customer.phone)}</a>${wa ? `<a href="${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}</div>` : ''}
      </div>
      <div class="right">
        <div class="amt">${rupee(o.total)}</div>
        ${canChange ? `<select data-order="${esc(o.id)}" aria-label="Order status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      </div></div>`;
  }

  async function loadOrders() {
    const q = $('#orderSearch').value.trim();
    let list;
    try { list = await api(`/api/admin/orders?status=${orderStatus === 'active' ? 'all' : orderStatus}&q=${encodeURIComponent(q)}`); } catch { return; }
    if (orderStatus === 'active') list = list.filter((o) => ['new', 'preparing', 'out'].includes(o.status));
    $('#orderList').innerHTML = list.length ? list.map(orderCard).join('') : `<div class="empty">${orderStatus === 'active' ? 'All caught up — no orders waiting. 🎉' : 'No orders found.'}</div>`;
  }
  $('#statusChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    orderStatus = b.dataset.s;
    $$('#statusChips button').forEach((x) => x.classList.toggle('on', x === b));
    loadOrders();
  });
  let sT; $('#orderSearch').addEventListener('input', () => { clearTimeout(sT); sT = setTimeout(loadOrders, 250); });

  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-order]'); if (!sel) return;
    const id = sel.dataset.order, status = sel.value;
    if (status === 'cancelled' && !confirm(`Cancel order ${id}? Its packets will be added back to stock.`)) { renderTab(); return; }
    try { await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status } }); toast(`${id} → ${STATUS[status]}`); refresh(); } catch (ex) { toast(ex.message, true); }
  });

  // ---------- stock ----------
  async function renderStock() {
    $('#stockGrid').innerHTML = S.products.map((p) => {
      const [cls, label] = stockStatus(p);
      return `<div class="stock-card">
        <div class="row"><b>${esc(p.name)}</b><span class="status ${cls}">${label}</span></div>
        <div class="row"><span class="big">${num(p.stock)}</span><span class="muted small">packets · alert at ${p.lowStockAt}</span></div>
        <div class="muted small">Sold today ${p.soldToday} · this month ${p.soldMonth}</div>
        <form data-stock="${esc(p.id)}">
          <select name="type">
            <option value="production">➕ Add today's production</option>
            <option value="waste">🗑 Remove wasted / expired</option>
            <option value="adjust-add">↑ Correct count (add)</option>
            <option value="adjust-remove">↓ Correct count (remove)</option>
          </select>
          <input name="qty" type="number" min="1" placeholder="Number of packets" required>
          <input name="note" placeholder="Note (optional)">
          <button class="btn primary" style="grid-column:1/-1">Update stock</button>
        </form></div>`;
    }).join('');
    try {
      const mv = await api('/api/admin/movements');
      const names = Object.fromEntries(products.map((p) => [p.id, p.name]));
      const T = { production: '➕ Production', waste: '🗑 Waste', adjust: '✎ Correction', sale: '🛒 Sale', return: '↩ Cancelled order' };
      $('#moveTable').innerHTML = mv.length ? `<thead><tr><th>When</th><th>Product</th><th>Type</th><th class="num">Packets</th><th>Note</th></tr></thead><tbody>${mv.slice(0, 80).map((m) => `<tr><td>${fmtTime(m.at)}</td><td>${esc(names[m.productId] || m.productId)}</td><td>${T[m.type] || m.type}</td><td class="num" style="color:${m.qty < 0 ? 'var(--crit)' : 'var(--good)'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td class="muted">${esc(m.note || m.ref || '')}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No stock changes yet. Add today\'s production above.</td></tr></tbody>';
    } catch { /* ignore */ }
  }
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-stock]'); if (!f) return;
    e.preventDefault();
    const body = { productId: f.dataset.stock, type: f.type.value, qty: Number(f.qty.value), note: f.note.value };
    try { const p = await api('/api/admin/stock', { method: 'POST', body }); toast(`${p.name}: now ${p.stock} packets`); refresh(); } catch (ex) { toast(ex.message, true); }
  });

  // ---------- shop counter ----------
  function renderShop() {
    $('#posGrid').innerHTML = products.filter((p) => p.active).map((p) => {
      const left = p.stock - (bill[p.id] || 0);
      return `<button data-pos="${esc(p.id)}" ${left <= 0 ? 'disabled' : ''}><div class="em">${esc(p.emoji)}</div><b>${esc(p.name)}</b><small>${rupee(p.price)} · ${left} left</small></button>`;
    }).join('');
    const ids = Object.keys(bill);
    $('#billLines').innerHTML = ids.length ? ids.map((id) => {
      const p = products.find((x) => x.id === id);
      return `<div class="bill-line"><span>${esc(p.name)}</span><span class="q"><button data-bdec="${esc(id)}">−</button><b>${bill[id]}</b><button data-pos="${esc(id)}">+</button></span><span>${rupee(p.price * bill[id])}</span></div>`;
    }).join('') : '<p class="muted small">Tap products on the left to start a bill.</p>';
    $('#billTotal').textContent = rupee(ids.reduce((s, id) => s + products.find((x) => x.id === id).price * bill[id], 0));
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-pos]'), d = e.target.closest('[data-bdec]');
    if (a) {
      const p = products.find((x) => x.id === a.dataset.pos);
      if ((bill[p.id] || 0) < p.stock) bill[p.id] = (bill[p.id] || 0) + 1; else toast(`Only ${p.stock} in stock`, true);
      renderShop();
    }
    if (d) { const id = d.dataset.bdec; bill[id]--; if (bill[id] <= 0) delete bill[id]; renderShop(); }
  });
  $('#billPay').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; billPay = b.dataset.p; $$('#billPay button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#clearBill').addEventListener('click', () => { bill = {}; renderShop(); });
  $('#saveBill').addEventListener('click', async () => {
    $('#billErr').textContent = '';
    const items = Object.entries(bill).map(([id, qty]) => ({ id, qty }));
    if (!items.length) { $('#billErr').textContent = 'Add at least one product'; return; }
    const btn = $('#saveBill'); btn.disabled = true;
    try {
      const o = await api('/api/admin/shop-sale', { method: 'POST', body: { items, payment: billPay, name: $('#billName').value, phone: $('#billPhone').value } });
      toast(`✓ Sale ${o.id} recorded · ${rupee(o.total)}`);
      bill = {}; $('#billName').value = ''; $('#billPhone').value = '';
      await refresh();
    } catch (ex) { $('#billErr').textContent = ex.message; } finally { btn.disabled = false; }
  });

  // ---------- products ----------
  function renderProducts() {
    $('#editTable').innerHTML = `<thead><tr><th>Show on site</th><th>Product</th><th>Pack size</th><th>Price (₹)</th><th>Low-stock alert at</th><th>Badge</th><th></th></tr></thead><tbody>` +
      products.map((p) => `<tr data-pid="${esc(p.id)}">
        <td><label class="switch"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}><span></span></label></td>
        <td><b>${esc(p.emoji)} ${esc(p.name)}</b><div class="muted small">${esc(p.telugu)}</div></td>
        <td><input name="unit" value="${esc(p.unit)}"></td>
        <td><input name="price" type="number" min="0" value="${p.price}" style="width:90px"></td>
        <td><input name="lowStockAt" type="number" min="0" value="${p.lowStockAt}" style="width:90px"></td>
        <td><input name="tag" value="${esc(p.tag || '')}" placeholder="e.g. Bestseller"></td>
        <td><button class="btn ghost small" data-save="${esc(p.id)}">Save</button></td></tr>`).join('') + '</tbody>';
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]'); if (!b) return;
    const row = b.closest('tr');
    const body = { active: $('[name=active]', row).checked, unit: $('[name=unit]', row).value, price: Number($('[name=price]', row).value), lowStockAt: Number($('[name=lowStockAt]', row).value), tag: $('[name=tag]', row).value };
    try { const p = await api(`/api/admin/products/${b.dataset.save}`, { method: 'PATCH', body }); toast(`${p.name} saved`); products = await api('/api/admin/products'); } catch (ex) { toast(ex.message, true); }
  });
  document.addEventListener('change', async (e) => {
    const c = e.target.closest('tr[data-pid] [name=active]'); if (!c) return;
    const id = c.closest('tr').dataset.pid;
    try { const p = await api(`/api/admin/products/${id}`, { method: 'PATCH', body: { active: c.checked } }); toast(`${p.name} ${p.active ? 'shown on' : 'hidden from'} website`); refresh(); } catch (ex) { toast(ex.message, true); }
  });
  $('#newProduct').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { const p = await api('/api/admin/products', { method: 'POST', body }); toast(`${p.name} added — now add its stock`); e.target.reset(); await refresh(); renderProducts(); } catch (ex) { toast(ex.message, true); }
  });

  // ---------- settings ----------
  async function loadSettings() {
    try {
      const s = await api('/api/admin/settings');
      const f = $('#settingsForm');
      for (const [k, v] of Object.entries(s)) if (f[k]) f[k].value = v;
    } catch { /* ignore */ }
  }
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { await api('/api/admin/settings', { method: 'PUT', body }); toast('Settings saved'); } catch (ex) { toast(ex.message, true); }
  });

  window.PR = { api, toast, esc, rupee, num, fmtTime, beep, go };

  // ---------- boot ----------
  refresh().then(() => { if ($('#app').hidden) showLogin(); });
  setInterval(() => { if (!$('#app').hidden && document.visibilityState === 'visible') refresh(); }, 20000);
})();
