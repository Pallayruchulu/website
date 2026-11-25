(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
  };

  let products = [];
  const SHOP_WHATSAPP = '917993508884'; // fallback if settings can't load
  let settings = { deliveryCharge: 20, freeDeliveryAbove: 300, whatsapp: SHOP_WHATSAPP, phone: '+91 79935 08884', upiId: '' };
  let cart = store.get('pr_cart', {}); // id -> qty
  let filter = 'all';

  // ---------- Intro ----------
  const intro = $('#intro');
  let seen = false;
  try { seen = sessionStorage.getItem('pr_intro') === '1'; } catch { /* ignore */ }
  const endIntro = () => {
    if (intro.classList.contains('done')) return;
    intro.classList.add('done');
    try { sessionStorage.setItem('pr_intro', '1'); } catch { /* ignore */ }
    setTimeout(() => intro.classList.add('gone'), 900);
  };
  if (new URLSearchParams(location.search).get('intro') === '0') seen = true; // ?intro=0 skips the animation
  if (seen) intro.classList.add('gone');
  else {
    document.body.classList.add('lock');
    const t = setTimeout(() => { endIntro(); document.body.classList.remove('lock'); }, 3400);
    $('.intro-skip').addEventListener('click', () => { clearTimeout(t); endIntro(); document.body.classList.remove('lock'); });
  }

  // ---------- Toast ----------
  let toastT;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- Data ----------
  async function load() {
    try {
      const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error('bad response'); return r.json(); });
      const [p, s] = await Promise.all([get('/api/products'), get('/api/settings')]);
      if (!Array.isArray(p)) throw new Error('bad products');
      products = p; settings = { ...settings, ...s };
    } catch {
      $('#productGrid').innerHTML = '<div class="loading">Could not load products. Please refresh.</div>';
      return;
    }
    // drop cart items that no longer exist
    for (const id of Object.keys(cart)) if (!products.find((x) => x.id === id && x.available)) delete cart[id];
    applySettings();
    renderProducts();
    renderCart();
  }

  function waLink(text) {
    const n = settings.whatsapp || SHOP_WHATSAPP;
    return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  }

  function applySettings() {
    $('#ratingVal').textContent = Number(settings.rating || 5).toFixed(1);
    $('#reviewCount').textContent = settings.reviews || 0;
    $('#addr').textContent = settings.address || '';
    $('#hours').textContent = settings.hours || '';
    $('#callBtn').href = 'tel:' + (settings.phone || '').replace(/\s/g, '');
    $('#ribbonDelivery').textContent = `Free delivery above ${rupee(settings.freeDeliveryAbove)}`;
    $('.js-wa').forEach((a) => (a.href = waLink('Hi Pallay Ruchulu! I have a question.')));
    // open-now indicator (IST, 6am-8pm default)
    const h = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000).getHours();
    const el = $('#openNow');
    const open = h >= 6 && h < 20;
    el.className = 'open-now ' + (open ? 'open' : 'closed');
    el.textContent = open ? 'Open now · closes 8 PM' : 'Closed now · opens 6 AM';
  }

  // Small hand-drawn illustrations for the core products
  const ART = {
    'idly-batter': '<svg viewBox="0 0 80 60" width="78"><ellipse cx="22" cy="40" rx="17" ry="9" fill="#fff" stroke="#e6dcc4" stroke-width="2"/><path d="M5 40 q17 -22 34 0" fill="#fffdf6" stroke="#e6dcc4" stroke-width="2"/><ellipse cx="54" cy="38" rx="19" ry="10" fill="#fff" stroke="#e6dcc4" stroke-width="2"/><path d="M35 38 q19 -24 38 0" fill="#fffdf6" stroke="#e6dcc4" stroke-width="2"/><circle cx="50" cy="29" r="1.4" fill="#e6dcc4"/><circle cx="58" cy="31" r="1.2" fill="#e6dcc4"/><circle cx="20" cy="33" r="1.2" fill="#e6dcc4"/><path d="M48 14 q-4 -5 0 -10 M56 16 q-4 -5 0 -10" stroke="#cdbf9e" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    'dosa-batter': '<svg viewBox="0 0 80 60" width="80"><path d="M6 44 L70 16 q6 6 2 14 L10 52 q-6 -2 -4 -8z" fill="#e3a447" stroke="#b5732a" stroke-width="2"/><path d="M14 46 L64 24" stroke="#f3d28a" stroke-width="3" stroke-linecap="round"/><circle cx="66" cy="46" r="9" fill="#fff" stroke="#e6dcc4" stroke-width="2"/><circle cx="66" cy="46" r="5" fill="#e9f0dc"/></svg>',
    'millet-dosa': '<svg viewBox="0 0 80 60" width="76"><circle cx="34" cy="34" r="22" fill="#b98a4a" stroke="#8a5f2a" stroke-width="2"/><g fill="#8a5f2a"><circle cx="26" cy="28" r="1.6"/><circle cx="38" cy="24" r="1.4"/><circle cx="42" cy="38" r="1.6"/><circle cx="28" cy="40" r="1.3"/><circle cx="34" cy="32" r="1.2"/></g><path d="M64 52 V18" stroke="#9c7a2a" stroke-width="2"/><g fill="#d9b44a"><ellipse cx="60" cy="22" rx="3" ry="5"/><ellipse cx="68" cy="26" rx="3" ry="5"/><ellipse cx="60" cy="32" rx="3" ry="5"/><ellipse cx="68" cy="36" rx="3" ry="5"/></g></svg>',
    chapati: '<svg viewBox="0 0 80 60" width="78"><ellipse cx="40" cy="40" rx="30" ry="12" fill="#e8c88f" stroke="#b98a4a" stroke-width="2"/><ellipse cx="40" cy="33" rx="30" ry="12" fill="#f1d7a4" stroke="#b98a4a" stroke-width="2"/><g fill="#c48f45"><circle cx="30" cy="31" r="2.2"/><circle cx="46" cy="29" r="1.8"/><circle cx="52" cy="36" r="2"/><circle cx="36" cy="37" r="1.5"/></g></svg>',
    poori: '<svg viewBox="0 0 80 60" width="78"><ellipse cx="28" cy="38" rx="20" ry="13" fill="#e9a94a" stroke="#b5732a" stroke-width="2"/><path d="M12 34 q16 -14 32 0" fill="#f4c46e"/><ellipse cx="54" cy="32" rx="19" ry="13" fill="#eeb455" stroke="#b5732a" stroke-width="2"/><path d="M39 28 q15 -13 30 0" fill="#f7cf80"/></svg>'
  };

  const category = (p) => (/batter|dosa|idly|idli/i.test(p.id + p.name) ? 'batter' : 'ready');

  // ---------- Products ----------
  function renderProducts() {
    const list = products.filter((p) => filter === 'all' || category(p) === filter);
    const grid = $('#productGrid');
    if (!list.length) { grid.innerHTML = '<div class="loading">Nothing here right now.</div>'; return; }
    grid.innerHTML = list.map((p) => {
      const q = cart[p.id] || 0;
      const art = p.image ? `<img src="${esc(p.image)}" alt="">` : `<div class="plate">${ART[p.id] || esc(p.emoji)}</div>`;
      const action = !p.available
        ? '<button class="add" disabled>Sold out</button>'
        : q
          ? `<div class="stepper"><button data-dec="${esc(p.id)}" aria-label="Remove one">−</button><span>${q}</span><button data-inc="${esc(p.id)}" aria-label="Add one">+</button></div>`
          : `<button class="add" data-inc="${esc(p.id)}">Add +</button>`;
      return `<article class="card">
        <div class="card-art">${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}${p.fewLeft ? `<span class="few">Only ${p.fewLeft} left!</span>` : ''}${art}</div>
        <div class="card-body">
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.desc)}</p>
          <div class="card-foot"><div class="price">${rupee(p.price)}<small>${esc(p.unit)}</small></div>${action}</div>
        </div></article>`;
    }).join('');
    // staggered reveal
    $$('.card', grid).forEach((c, i) => setTimeout(() => c.classList.add('in'), 60 * i));
  }

  $('#mood').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.filter;
    $$('#mood button').forEach((x) => x.classList.toggle('on', x === b));
    renderProducts();
  });

  document.addEventListener('click', (e) => {
    const inc = e.target.closest('[data-inc]');
    const dec = e.target.closest('[data-dec]');
    if (inc) changeQty(inc.dataset.inc, 1);
    if (dec) changeQty(dec.dataset.dec, -1);
  });

  function changeQty(id, d) {
    const p = products.find((x) => x.id === id); if (!p) return;
    const q = Math.max(0, Math.min(50, (cart[id] || 0) + d));
    if (q) cart[id] = q; else delete cart[id];
    store.set('pr_cart', cart);
    if (d > 0) {
      toast(`${p.emoji} ${p.name} added to basket`);
      const btn = $('#openCart'); btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    }
    renderProducts();
    renderCart();
  }

  // ---------- Cart ----------
  function totals() {
    const sub = Object.entries(cart).reduce((s, [id, q]) => { const p = products.find((x) => x.id === id); return s + (p ? p.price * q : 0); }, 0);
    const mode = ($('input[name=mode]:checked') || {}).value || 'delivery';
    const delivery = mode === 'delivery' && sub > 0 && sub < settings.freeDeliveryAbove ? settings.deliveryCharge : 0;
    return { sub, delivery, total: sub + delivery, mode };
  }

  function renderCart() {
    const ids = Object.keys(cart);
    $('#cartCount').textContent = Object.values(cart).reduce((a, b) => a + b, 0);
    $('#cartEmpty').hidden = ids.length > 0;
    $('#checkout').hidden = ids.length === 0;
    $('#cartItems').innerHTML = ids.map((id) => {
      const p = products.find((x) => x.id === id); if (!p) return '';
      return `<div class="line"><div class="em">${esc(p.emoji)}</div>
        <div><b>${esc(p.name)}</b><small>${rupee(p.price)} · ${esc(p.unit)}</small></div>
        <div class="stepper"><button data-dec="${esc(id)}" aria-label="Remove one">−</button><span>${cart[id]}</span><button data-inc="${esc(id)}" aria-label="Add one">+</button></div></div>`;
    }).join('');
    const t = totals();
    $('#subtotal').textContent = rupee(t.sub);
    $('#deliveryFee').textContent = t.delivery ? rupee(t.delivery) : (t.mode === 'pickup' ? '—' : 'FREE');
    $('#grandTotal').textContent = rupee(t.total);
    const gap = settings.freeDeliveryAbove - t.sub;
    $('#freeHint').textContent = t.mode === 'delivery' && gap > 0 ? `Add ${rupee(gap)} more for free delivery 🛵` : '';
    $('#addressField').hidden = t.mode === 'pickup';
  }

  const drawer = $('#drawer'), scrim = $('#scrim');
  function openCart() { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); scrim.hidden = false; document.body.classList.add('lock'); }
  function closeCart() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); scrim.hidden = true; document.body.classList.remove('lock'); }
  $('#openCart').addEventListener('click', openCart);
  $('#closeCart').addEventListener('click', closeCart);
  scrim.addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });
  $('#checkout').addEventListener('change', renderCart);

  // restore saved details
  const saved = store.get('pr_customer', {});
  for (const k of ['name', 'phone', 'address']) if (saved[k]) $(`#checkout [name=${k}]`).value = saved[k];

  $('#checkout').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.items = Object.entries(cart).map(([id, qty]) => ({ id, qty }));
    const err = $('#formError');
    err.textContent = '';
    if ((body.name || '').trim().length < 2) return (err.textContent = 'Please enter your name');
    if (!/^\+?\d{10,13}$/.test((body.phone || '').replace(/[\s-]/g, ''))) return (err.textContent = 'Please enter a valid 10-digit phone number');
    if (body.mode === 'delivery' && (body.address || '').trim().length < 8) return (err.textContent = 'Please enter your full delivery address');
    body.phone = body.phone.replace(/[\s-]/g, '');
    const btn = $('#placeOrder');
    btn.disabled = true; btn.textContent = 'Placing order…';
    try {
      const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not place order');
      store.set('pr_customer', { name: body.name, phone: body.phone, address: body.address });
      const lines = body.items.map((i) => { const p = products.find((x) => x.id === i.id); return `• ${p.name} (${p.unit}) × ${i.qty} = ${rupee(p.price * i.qty)}`; }).join('\n');
      cart = {}; store.set('pr_cart', cart);
      closeCart();
      showSuccess(data, lines, body);
      load();
    } catch (ex) {
      err.textContent = ex.message;
      load();
    } finally {
      btn.disabled = false; btn.textContent = 'Place order';
    }
  });

  function showSuccess(order, lines, body) {
    $('#sId').textContent = order.id;
    $('#sTotal').textContent = rupee(order.total);
    const upi = $('#sUpi'), note = $('#sUpiNote');
    if (order.payment === 'upi' && settings.upiId) {
      upi.hidden = false; note.hidden = false;
      upi.href = `upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent('Pallay Ruchulu')}&am=${order.total}&cu=INR&tn=${encodeURIComponent('Order ' + order.id)}`;
      note.textContent = `Or pay to UPI ID: ${settings.upiId}`;
    } else { upi.hidden = true; note.hidden = true; }
    const msg = [
      `🛒 *New order ${order.id}* — Pallay Ruchulu`,
      '',
      lines,
      order.delivery ? `Delivery: ${rupee(order.delivery)}` : null,
      `*Total: ${rupee(order.total)}* (${order.payment === 'upi' ? 'UPI' : 'Cash on delivery'})`,
      '',
      `👤 ${body.name} · 📞 ${body.phone}`,
      body.mode === 'pickup' ? '🏪 Pickup at shop' : `🛵 Deliver to: ${body.address}`,
      body.note ? `📝 ${body.note}` : null
    ].filter((l) => l !== null).join('\n');
    const wa = waLink(msg);
    $('#sWa').href = wa;
    $('#success').hidden = false;
    confetti();
    // Order is saved — now take the customer straight to WhatsApp to send it.
    // Same-tab navigation is not blocked by popup blockers; the button above stays as a fallback.
    setTimeout(() => {
      $('#sWaMsg').innerHTML = 'If WhatsApp didn\'t open, tap the button below to send your order.';
      window.location.href = wa;
    }, 1500);
  }
  $('#sClose').addEventListener('click', () => ($('#success').hidden = true));

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bits = ['⚪', '🌕', '🌾', '🍃', '✨', '🥥'];
    for (let i = 0; i < 28; i++) {
      const s = document.createElement('div');
      s.className = 'confetti';
      s.textContent = bits[i % bits.length];
      s.style.left = Math.random() * 100 + 'vw';
      s.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
      s.style.animationDelay = Math.random() * 0.5 + 's';
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 4500);
    }
  }

  // ---------- Tips ----------
  const tips = [
    "💡 Tip: Don't over-stir the batter — idlis stay soft and fluffy.",
    '💡 Tip: Add salt just before making dosas, not before storing.',
    '💡 Tip: Keep the batter refrigerated and use within 4–5 days.',
    '💡 Tip: For crispy dosas, the tawa must be really hot.',
    '💡 Tip: Millet dosa tastes best with peanut chutney!'
  ];
  let ti = 0;
  const tipEl = $('#tip');
  const showTip = () => { tipEl.textContent = tips[ti]; };
  showTip();
  setInterval(() => { tipEl.style.opacity = 0; setTimeout(() => { ti = (ti + 1) % tips.length; showTip(); tipEl.style.opacity = 1; }, 400); }, 6000);

  // ---------- Track ----------
  const STATUSES = [['new', '📝', 'Received'], ['preparing', '🥣', 'Packing'], ['out', '🛵', 'On the way'], ['delivered', '✅', 'Delivered']];
  $('#trackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const id = String(f.get('id')).trim().toUpperCase();
    const out = $('#trackResult');
    out.hidden = false;
    out.innerHTML = '<p class="muted">Checking…</p>';
    try {
      const r = await fetch(`/api/orders/${encodeURIComponent(id)}?phone=${encodeURIComponent(f.get('phone'))}`);
      const o = await r.json();
      if (!r.ok) throw new Error(o.error || 'Order not found');
      if (o.status === 'cancelled') { out.innerHTML = `<p><b>${esc(o.id)}</b> was cancelled. Please call us if this is unexpected.</p>`; return; }
      const steps = o.mode === 'pickup' ? STATUSES.map((s) => (s[0] === 'out' ? ['out', '🏪', 'Ready for pickup'] : s[0] === 'delivered' ? ['delivered', '✅', 'Picked up'] : s)) : STATUSES;
      const idx = steps.findIndex((s) => s[0] === o.status);
      out.innerHTML = `<p><b>${esc(o.id)}</b> · ${o.items.map((l) => `${esc(l.name)} × ${l.qty}`).join(', ')} · <b>${rupee(o.total)}</b></p>
        <div class="progress"><div class="bar" style="width:0"></div>${steps.map((s, i) => `<div class="st ${i <= idx ? 'on' : ''}"><i>${s[1]}</i>${s[2]}</div>`).join('')}</div>`;
      requestAnimationFrame(() => ($('.progress .bar', out).style.width = (88 * idx) / (steps.length - 1) + '%'));
    } catch (ex) {
      out.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`;
    }
  });

  $('#yr').textContent = new Date().getFullYear();
  load();
})();
