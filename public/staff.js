(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const time = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const when = (ts) => new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const token = (location.pathname.match(/\/staff\/([a-f0-9]+)/) || [])[1];
  const API = `/api/staff/${token}`;

  let D = null, bill = {}, pay = 'cash', pendingType = null, lastOwnerMsg = null;

  let tT;
  function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(tT); tT = setTimeout(() => t.classList.remove('show'), 3000); }
  function busy(msg) { const b = $('#busy'); b.hidden = !msg; b.textContent = msg || ''; }

  async function api(path, body) {
    const r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
    return j;
  }

  async function load() {
    try { D = await api('/'); } catch (e) {
      if (e.status === 404) $('#main').innerHTML = `<div class="card invalid"><h2>🔒 ${esc(e.message)}</h2></div>`;
      return;
    }
    render();
  }

  function render() {
    $('#hello').textContent = `Hello ${D.name} 👋`;
    $('#stall').textContent = (D.stallName || 'Your stall') + ' · ' + new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    const s = D.status;
    const icon = { present: '✅', away: '⚠️', absent: '🕘', out: '🏁' }[s.state];
    let sub = '';
    if (s.state === 'absent') sub = 'Tap "Check in" when you reach the stall';
    else if (s.state === 'out') sub = `Checked out at ${time(s.lastAt)}`;
    else sub = `Checked in at ${time(s.since)}` + (s.distanceM != null ? ` · ${s.distanceM} m from stall` : '');
    $('#statusBox').className = 'status s-' + s.state;
    $('#statusBox').innerHTML = `<div class="dot">${icon}</div><div><b>${s.state === 'present' ? 'You are at the stall' : s.state === 'away' ? 'You seem away from the stall' : s.state === 'out' ? 'Shift ended' : 'Not checked in yet'}</b><small>${esc(sub)}</small></div>`;
    $('#inBtn').disabled = s.state === 'present' || s.state === 'away';
    $('#outBtn').disabled = !(s.state === 'present' || s.state === 'away');
    $('#requestBox').hidden = !s.pendingRequest;
    $('#tPk').textContent = s.packetsToday; $('#tRs').textContent = rupee(s.salesToday);

    // messages
    const box = $('#msgs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = D.messages.length ? D.messages.map((m) => {
      if (m.kind === 'checkin-request') return `<div class="msg owner">🔔 ${esc(m.text)}<time>${when(m.at)} · ${m.done ? 'answered ✓' : 'waiting'}</time></div>`;
      if (m.kind === 'task') return `<div class="msg task ${m.done ? 'done' : ''}">📋 <b>Task:</b> ${esc(m.text)}<time>${when(m.at)}${m.done ? ' · done ✓' : ''}</time>${m.done ? '' : `<button class="done-btn" data-done="${m.id}">Mark done ✓</button>`}</div>`;
      return `<div class="msg ${m.from}">${esc(m.text)}<time>${when(m.at)}</time></div>`;
    }).join('') : '<p class="muted small">No messages yet.</p>';
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = 1; }

    const newestOwner = [...D.messages].reverse().find((m) => m.from === 'owner');
    if (lastOwnerMsg !== null && newestOwner && newestOwner.id !== lastOwnerMsg) { toast('📩 New message from owner'); alertSound(); }
    lastOwnerMsg = newestOwner ? newestOwner.id : '';

    renderPos();
  }

  function alertSound() {
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch { /* ignore */ }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3); o.start(); o.stop(ctx.currentTime + 0.3);
    } catch { /* ignore */ }
  }

  // ---------- location + selfie ----------
  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This phone does not support location'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => reject(new Error(e.code === 1 ? 'Location permission denied. Please allow location for this site in your browser settings and try again.' : 'Could not get your location. Turn on GPS and try again.')),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const max = 640, r = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, c.height - 28, c.width, 28);
        g.fillStyle = '#fff'; g.font = '16px sans-serif'; g.fillText(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 8, c.height - 9);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('Could not read the photo'));
      img.src = URL.createObjectURL(file);
    });
  }

  function startSelfie(type) { pendingType = type; $('#cam').value = ''; $('#cam').click(); }
  $('#cam').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f || !pendingType) return;
    try {
      busy('📸 Preparing photo…');
      const photo = await resizePhoto(f);
      let loc = {};
      if (pendingType === 'in') { busy('📍 Getting your location…'); loc = await getLocation(); } // GPS only at check-in / check-out
      busy('Sending…');
      const r = await api('/checkin', { type: pendingType, photo, ...loc });
      toast(pendingType === 'ping' ? '✅ Selfie sent to owner' : r.atStall === false ? `Checked in, but you are ${r.distanceM} m from the stall.` : '✅ Checked in. Have a good day!');
      await load();
    } catch (ex) { toast(ex.message, true); } finally { busy(); pendingType = null; }
  });

  $('#inBtn').addEventListener('click', () => startSelfie('in'));
  $('#answerBtn').addEventListener('click', () => startSelfie('ping'));
  $('#outBtn').addEventListener('click', async () => {
    if (!confirm('End your shift and check out?')) return;
    try { busy('📍 Getting your location…'); const loc = await getLocation(); await api('/checkin', { type: 'out', ...loc }); toast('🏁 Checked out. Thank you!'); await load(); } catch (ex) { toast(ex.message, true); } finally { busy(); }
  });


  // ---------- messages ----------
  $('#replyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#replyText').value.trim(); if (!text) return;
    try { await api('/message', { text }); $('#replyText').value = ''; await load(); $('#msgs').scrollTop = 1e6; } catch (ex) { toast(ex.message, true); }
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-done]'); if (!b) return;
    try { await api(`/messages/${b.dataset.done}/done`, {}); toast('Task marked done ✓'); load(); } catch (ex) { toast(ex.message, true); }
  });

  // ---------- stall sale ----------
  function renderPos() {
    $('#pos').innerHTML = D.products.map((p) => {
      const left = p.stock - (bill[p.id] || 0);
      return `<button type="button" data-add="${esc(p.id)}" ${left <= 0 ? 'disabled' : ''}><b>${esc(p.emoji)} ${esc(p.name)}</b><small>${rupee(p.price)} · ${left} left</small></button>`;
    }).join('');
    const ids = Object.keys(bill);
    $('#bill').innerHTML = ids.map((id) => {
      const p = D.products.find((x) => x.id === id);
      return `<div class="bill-line"><span>${esc(p.name)}</span><span><button type="button" data-sub="${esc(id)}">−</button> <b>${bill[id]}</b> <button type="button" data-add="${esc(id)}">+</button></span><span>${rupee(p.price * bill[id])}</span></div>`;
    }).join('');
    $('#billTotal').textContent = rupee(ids.reduce((a, id) => a + D.products.find((x) => x.id === id).price * bill[id], 0));
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-add]'), s = e.target.closest('[data-sub]');
    if (a) { const p = D.products.find((x) => x.id === a.dataset.add); if ((bill[p.id] || 0) < p.stock) bill[p.id] = (bill[p.id] || 0) + 1; renderPos(); }
    if (s) { bill[s.dataset.sub]--; if (bill[s.dataset.sub] <= 0) delete bill[s.dataset.sub]; renderPos(); }
  });
  $('#paySeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pay = b.dataset.p; [...$('#paySeg').children].forEach((x) => x.classList.toggle('on', x === b)); });
  $('#saleBtn').addEventListener('click', async () => {
    $('#saleErr').textContent = '';
    const items = Object.entries(bill).map(([id, qty]) => ({ id, qty }));
    if (!items.length) { $('#saleErr').textContent = 'Tap the products you sold first'; return; }
    $('#saleBtn').disabled = true;
    try { const r = await api('/sale', { items, payment: pay }); toast(`✓ Sale saved · ${rupee(r.total)}`); bill = {}; await load(); } catch (ex) { $('#saleErr').textContent = ex.message; } finally { $('#saleBtn').disabled = false; }
  });

  if (!token) { $('#main').innerHTML = '<div class="card invalid"><h2>🔒 Invalid link</h2></div>'; return; }
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
})();
