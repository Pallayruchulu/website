(() => {
  const { api, toast, esc, rupee, num, fmtTime, beep } = window.PR;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const time = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const IST = 5.5 * 3600000;
  const thisMonth = () => new Date(Date.now() + IST).toISOString().slice(0, 7);
  const today = () => new Date(Date.now() + IST).toISOString().slice(0, 10);

  let staff = [];
  let openId = null;
  let lastUnread = null;
  let money = null;

  // ---------- status display ----------
  function statusChip(st) {
    if (!st) return '<span class="status out">Inactive</span>';
    const map = { present: ['ok', '✅'], away: ['low', '⚠️'], absent: ['out', '🕘'], out: ['neutral', '🏁'] };
    const [cls, ic] = map[st.state];
    return `<span class="status ${cls}">${ic} ${esc(st.label)}</span>`;
  }
  function statusLine(st) {
    if (!st) return '';
    if (st.state === 'absent') return 'Has not checked in today';
    if (st.state === 'out') return `Checked in ${time(st.since)} · checked out ${time(st.shiftAt)}`;
    let s = `Checked in at ${time(st.since)}`;
    if (st.distanceM != null) s += st.state === 'away' ? ` · <b style="color:var(--crit)">${fmtDist(st.distanceM)} from stall</b>` : ` · ${fmtDist(st.distanceM)} from stall`;
    if (st.lastSelfieAt && st.lastSelfieAt !== st.since) s += ` · last selfie ${time(st.lastSelfieAt)}`;
    return s;
  }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m');
  const staffLink = (s) => `${location.origin}/staff/${s.token}`;

  // ---------- polling (badge + new staff messages) ----------
  async function poll() {
    try { staff = await api('/api/admin/staff'); } catch { return; }
    const unread = staff.reduce((a, s) => a + (s.status ? s.status.unread : 0), 0);
    const b = $('#staffBadge'); b.hidden = !unread; b.textContent = unread;
    if (lastUnread !== null && unread > lastUnread) { toast('💬 New message from staff'); beep(); }
    lastUnread = unread;
  }

  // ---------- staff list ----------
  function renderList() {
    $('#staffList').hidden = false; $('#staffDetail').hidden = true;
    const g = $('#staffGrid');
    if (!staff.length) { g.innerHTML = '<div class="panel empty">No staff yet. Add your first stall person below 👇</div>'; $('#addStaffBox').open = true; return; }
    g.innerHTML = staff.map((s) => {
      const st = s.status;
      return `<div class="staff-card ${s.active ? '' : 'inactive'}" data-open="${s.id}" tabindex="0" role="button">
        <div class="sc-top">
          ${st && st.lastPhoto ? `<img class="selfie" src="/api/admin/photo/${esc(st.lastPhoto)}" alt="Latest selfie of ${esc(s.name)}">` : `<div class="selfie ph">${esc(s.name[0] || '?')}</div>`}
          <div><b>${esc(s.name)}</b><div class="muted small">📍 ${esc(s.stallName || 'No stall set')}</div></div>
          ${st && st.unread ? `<span class="badge">${st.unread} new</span>` : ''}
        </div>
        ${statusChip(st)}
        <div class="muted small">${statusLine(st)}</div>
        ${st && st.pendingRequest ? `<div class="small" style="color:var(--warn)">🔔 Selfie requested ${time(st.pendingRequest.at)} — waiting</div>` : ''}
        ${s.stallLat == null && s.active ? '<div class="small" style="color:var(--warn)">⚠ Stall location not set — distance can\'t be checked</div>' : ''}
        <div class="sc-foot"><span>Today: <b>${st ? st.packetsToday : 0}</b> packets · <b>${rupee(st ? st.salesToday : 0)}</b></span><span class="link">Open →</span></div>
      </div>`;
    }).join('');
  }

  document.addEventListener('click', (e) => { const c = e.target.closest('[data-open]'); if (c) openStaff(c.dataset.open); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('[data-open]'); if (c) openStaff(c.dataset.open); } });

  $('#addStaff').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { const s = await api('/api/admin/staff', { method: 'POST', body }); toast(`${s.name} added — share their link`); e.target.reset(); await poll(); openStaff(s.id); } catch (ex) { toast(ex.message, true); }
  });

  // ---------- staff detail ----------
  async function openStaff(id, keepScroll) {
    openId = id;
    let d;
    try { d = await api(`/api/admin/staff/${id}/detail`); } catch (ex) { toast(ex.message, true); return; }
    const s = d.staff, st = d.status, link = staffLink(s), pr = d.payroll;
    const box = $('#staffDetail');
    const typing = box.querySelector('#msgText')?.value || '';
    $('#staffList').hidden = true; box.hidden = false;
    const waText = `Hi ${s.name}, this is your Pallay Ruchulu staff link. Open it every day at the stall to check in (selfie + location), see messages & tasks, and record sales:\n${link}`;
    const phone = (s.phone || '').replace(/\D/g, '');
    const waTo = phone ? (phone.length === 10 ? '91' + phone : phone) : '';
    const T = { in: '✅ Check-in', out: '🏁 Check-out', ping: '📸 Selfie (requested)' };

    box.innerHTML = `
      <button class="link" id="backToStaff">← All staff</button>
      <div class="detail-head">
        ${st.lastPhoto ? `<a href="/api/admin/photo/${esc(st.lastPhoto)}" target="_blank"><img class="selfie lg" src="/api/admin/photo/${esc(st.lastPhoto)}" alt="Latest selfie"></a>` : `<div class="selfie lg ph">${esc(s.name[0])}</div>`}
        <div>
          <h2 style="font-size:1.3rem">${esc(s.name)} ${s.active ? '' : '<span class="pill">inactive</span>'}</h2>
          <div class="muted">📍 ${esc(s.stallName || 'No stall name')} · ${esc(s.role)}</div>
          <div style="margin-top:6px">${statusChip(st)} <span class="muted small">${statusLine(st)}</span></div>
          ${st.mapUrl ? `<a class="small" href="${st.mapUrl}" target="_blank" rel="noopener">See last check-in on map ↗</a>` : ''}
        </div>
      </div>

      <div class="detail-grid">
        <div class="panel">
          <div class="panel-head"><h2>💬 Follow up (no calls needed)</h2></div>
          <div class="quick">
            <button class="btn ghost small" data-quick="checkin-request">🔔 Ask for a selfie now</button>
            <button class="btn ghost small" data-quick-text="How many packets are left at the stall? Please reply.">📦 Ask stock left</button>
            <button class="btn ghost small" data-quick-text="Please send today's cash/UPI total.">💵 Ask today's cash</button>
          </div>
          <div class="thread" id="thread">${d.messages.length ? d.messages.map((m) => {
            const who = m.from === 'owner' ? 'owner' : 'staff';
            let body = esc(m.text);
            if (m.kind === 'task') body = `📋 <b>Task:</b> ${body} ${m.done ? `<span class="status ok">done ${time(m.doneAt)}</span>` : '<span class="status low">pending</span>'}`;
            if (m.kind === 'checkin-request') body = `🔔 ${body} ${m.done ? `<span class="status ok">answered ${time(m.doneAt)}</span>` : '<span class="status low">waiting</span>'}`;
            return `<div class="bubble ${who}">${body}<time>${fmtTime(m.at)}</time></div>`;
          }).join('') : '<p class="muted small">No messages yet.</p>'}</div>
          <form class="send" id="sendMsg">
            <select id="msgKind" aria-label="Message type"><option value="msg">Message</option><option value="task">Task (needs "done")</option></select>
            <input id="msgText" placeholder="Type a message or task…" maxlength="500" autocomplete="off">
            <button class="btn primary">Send</button>
          </form>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>🔗 Staff link</h2></div>
          <p class="muted small" style="margin-top:0">Send this link to ${esc(s.name)} once. They open it on their phone to check in and out, get your messages and record stall sales. No password is needed, so keep it private.</p>
          <input readonly value="${esc(link)}" id="linkBox" onclick="this.select()">
          <div class="quick" style="margin-top:8px">
            <button class="btn ghost small" id="copyLink">📋 Copy</button>
            <a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/${waTo}?text=${encodeURIComponent(waText)}">💬 Send on WhatsApp</a>
            <button class="btn danger small" id="resetLink" title="Old link stops working">↻ New link</button>
          </div>
          <h2 style="margin:18px 0 8px">💰 Salary · ${d.month}</h2>
          <div class="pay-sum">
            <div><small>${s.payType === 'daily' ? `${pr.daysPresent} days × ${rupee(s.salary)}` : 'Monthly salary'}</small><b>${rupee(pr.earned)}</b></div>
            <div><small>Paid + advance</small><b>${rupee(pr.paidSalary + pr.advance)}</b></div>
            <div><small>Balance due</small><b style="color:${pr.balance > 0 ? 'var(--crit)' : 'var(--good)'}">${rupee(pr.balance)}</b></div>
          </div>
          <p class="muted small">Days present this month: <b>${pr.daysPresent}</b>. <button class="link" data-goto="money">Pay salary →</button></p>
        </div>
      </div>

      <div class="detail-grid">
        <div class="panel">
          <div class="panel-head"><h2>📸 Check-ins (selfie + location)</h2></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>When</th><th>Type</th><th>Where</th><th>Selfie</th></tr></thead>
            <tbody>${d.checkins.length ? d.checkins.map((c) => `<tr>
              <td>${fmtTime(c.at)}</td><td>${T[c.type] || c.type}</td>
              <td>${c.lat == null ? '<span class="muted small">no GPS (selfie only)</span>' : `${c.atStall === true ? '<span class="status ok">At stall</span>' : c.atStall === false ? '<span class="status out">Away</span>' : ''} ${c.distanceM != null ? fmtDist(c.distanceM) : ''} <a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.lat},${c.lng}">map ↗</a>`}</td>
              <td>${c.photo ? `<a href="/api/admin/photo/${esc(c.photo)}" target="_blank"><img class="thumb" src="/api/admin/photo/${esc(c.photo)}" alt="selfie" loading="lazy"></a>` : '—'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No check-ins yet</td></tr>'}</tbody>
          </table></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>🗓 Attendance · ${d.month}</h2></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Date</th><th>In</th><th>Out</th><th class="num">Hours</th></tr></thead>
            <tbody>${d.attendance.length ? d.attendance.map((a) => `<tr><td>${new Date(a.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${time(a.in)}${a.awayChecks ? ' <span class="status low">away</span>' : ''}</td><td>${a.out ? time(a.out) : '<span class="muted">—</span>'}</td><td class="num">${a.out ? ((a.out - a.in) / 3600000).toFixed(1) : '—'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No attendance this month</td></tr>'}</tbody>
          </table></div>
        </div>
      </div>

      <form class="panel form-grid" id="editStaff">
        <div class="panel-head span"><h2>⚙️ Details & stall location</h2></div>
        <label>Name<input name="name" value="${esc(s.name)}"></label>
        <label>Phone<input name="phone" value="${esc(s.phone)}"></label>
        <label>Stall name<input name="stallName" value="${esc(s.stallName)}"></label>
        <label>Role<input name="role" value="${esc(s.role)}"></label>
        <label>Pay type<select name="payType"><option value="monthly" ${s.payType === 'monthly' ? 'selected' : ''}>Monthly salary</option><option value="daily" ${s.payType === 'daily' ? 'selected' : ''}>Daily wage</option></select></label>
        <label>Salary / wage (₹)<input name="salary" type="number" min="0" value="${s.salary}"></label>
        <label>Allowed distance from stall (m)<input name="radiusM" type="number" min="30" value="${s.radiusM}"></label>
        <label>Active<select name="active"><option value="1" ${s.active ? 'selected' : ''}>Yes</option><option value="0" ${s.active ? '' : 'selected'}>No (link stops working)</option></select></label>
        <div class="span stall-loc">
          <div><b>Stall location:</b> ${s.stallLat != null ? `${s.stallLat.toFixed(5)}, ${s.stallLng.toFixed(5)} <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${s.stallLat},${s.stallLng}">map ↗</a>` : '<span style="color:var(--warn)">not set</span>'}</div>
          <div class="quick">
            <button type="button" class="btn ghost small" id="locMine" title="Stand at the stall with this phone and tap">📍 Use my current location</button>
            <button type="button" class="btn ghost small" id="locLast">📸 Use their last check-in location</button>
          </div>
        </div>
        <div class="span"><button class="btn primary">Save details</button></div>
      </form>`;

    const th = $('#thread'); th.scrollTop = th.scrollHeight;
    if (typing) $('#msgText').value = typing;
    if (!keepScroll) window.scrollTo({ top: 0 });
    poll();

    $('#backToStaff').onclick = () => { openId = null; poll().then(renderList); };
    $('#copyLink').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { $('#linkBox').select(); document.execCommand('copy'); toast('Link copied'); } };
    $('#resetLink').onclick = async () => { if (!confirm(`Create a new link for ${s.name}? The old link will stop working immediately.`)) return; try { await api(`/api/admin/staff/${s.id}/reset-link`, { method: 'POST' }); toast('New link created — send it to them'); openStaff(s.id); } catch (ex) { toast(ex.message, true); } };
    $('#sendMsg').onsubmit = async (e) => { e.preventDefault(); const text = $('#msgText').value.trim(); if (!text) return; await send(s.id, $('#msgKind').value, text); $('#msgText').value = ''; };
    $$('[data-quick]', box).forEach((b) => (b.onclick = () => send(s.id, b.dataset.quick, '')));
    $$('[data-quick-text]', box).forEach((b) => (b.onclick = () => send(s.id, 'msg', b.dataset.quickText)));
    $('#locMine').onclick = () => {
      if (!navigator.geolocation) return toast('Location not supported on this device', true);
      toast('Getting your location…');
      navigator.geolocation.getCurrentPosition(
        (p) => saveStaff(s.id, { stallLat: p.coords.latitude, stallLng: p.coords.longitude }, 'Stall location saved'),
        () => toast('Could not get location. Allow location access and try again.', true),
        { enableHighAccuracy: true, timeout: 20000 }
      );
    };
    $('#locLast').onclick = async () => { try { await api(`/api/admin/staff/${s.id}/stall-from-last`, { method: 'POST' }); toast('Stall location set from last check-in'); openStaff(s.id, true); } catch (ex) { toast(ex.message, true); } };
    $('#editStaff').onsubmit = (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target).entries());
      b.active = b.active === '1';
      saveStaff(s.id, b, 'Saved');
    };
  }

  async function send(id, kind, text) {
    try { await api(`/api/admin/staff/${id}/message`, { method: 'POST', body: { kind, text } }); toast(kind === 'checkin-request' ? '🔔 Selfie request sent' : 'Sent ✓'); openStaff(id, true); } catch (ex) { toast(ex.message, true); }
  }
  async function saveStaff(id, body, msg) {
    try { await api(`/api/admin/staff/${id}`, { method: 'PATCH', body }); toast(msg); openStaff(id, true); } catch (ex) { toast(ex.message, true); }
  }

  // ---------- money ----------
  async function renderMoney() {
    const mEl = $('#moneyMonth');
    if (!mEl.value) mEl.value = thisMonth();
    if (!$('#expForm').date.value) $('#expForm').date.value = today();
    try { money = await api(`/api/admin/money?month=${mEl.value}`); } catch { return; }
    const t = money.totals;
    $('#moneyKpis').innerHTML = [
      ['', 'Sales', rupee(t.sales), `${num(t.orders)} orders`],
      ['', 'Expenses', rupee(t.expenses), `${money.expenses.length} entries`],
      ['', 'Staff paid', rupee(t.staffPaid), `${money.payments.length} payments`],
      ['hero', 'Profit (estimate)', rupee(t.profit), 'Sales − expenses − staff paid']
    ].map(([c, l, v, s]) => `<div class="kpi ${c}"><div class="label">${l}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join('');

    $('#payrollTable').innerHTML = money.payroll.length ? `<thead><tr><th>Staff</th><th>Pay</th><th class="num">Days</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Balance</th><th></th></tr></thead><tbody>` +
      money.payroll.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="small">${p.payType === 'daily' ? rupee(p.rate) + '/day' : rupee(p.rate) + '/month'}</td><td class="num">${p.daysPresent}</td><td class="num">${rupee(p.earned)}</td><td class="num">${rupee(p.paidSalary + p.advance)}${p.bonus ? `<div class="small muted">+${rupee(p.bonus)} bonus</div>` : ''}</td><td class="num" style="color:${p.balance > 0 ? 'var(--crit)' : 'var(--good)'};font-weight:600">${rupee(p.balance)}</td><td>${p.balance > 0 ? `<button class="btn ghost small" data-pay="${p.staffId}" data-amt="${p.balance}">Pay</button>` : '✓'}</td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td class="empty">Add staff in the "Staff & stalls" tab first.</td></tr></tbody>';

    const sel = $('#payForm').staffId, cur = sel.value;
    sel.innerHTML = money.payroll.map((p) => `<option value="${p.staffId}">${esc(p.name)}</option>`).join('');
    if (cur) sel.value = cur;
    const cat = $('#expForm').category;
    if (!cat.options.length) cat.innerHTML = money.categories.map((c) => `<option>${esc(c)}</option>`).join('');

    const K = { salary: 'Salary', advance: 'Advance', bonus: 'Bonus' };
    $('#payList').innerHTML = money.payments.length ? `<tbody>${money.payments.map((p) => `<tr><td>${fmtTime(p.at)}</td><td><b>${esc(p.name)}</b></td><td>${K[p.kind]}</td><td class="small">${p.mode.toUpperCase()}${p.note ? ' · ' + esc(p.note) : ''}</td><td class="num">${rupee(p.amount)}</td><td><button class="link small" data-del="payments/${p.id}">delete</button></td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted small">No payments this month.</td></tr></tbody>';

    // expenses by category: single-series horizontal bars
    const max = Math.max(1, ...money.byCategory.map((c) => c.amount));
    $('#catBars').innerHTML = money.byCategory.map((c) => `<div class="hbar" title="${esc(c.category)}: ${rupee(c.amount)}"><span class="hl">${esc(c.category)}</span><span class="ht"><span class="hf" style="width:${(c.amount / max) * 100}%"></span></span><b>${rupee(c.amount)}</b></div>`).join('');
    $('#expList').innerHTML = money.expenses.length ? `<thead><tr><th>Date</th><th>Category</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>${money.expenses.map((e) => `<tr><td>${new Date(e.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td><td>${esc(e.category)}</td><td class="muted">${esc(e.note)}</td><td class="num">${rupee(e.amount)}</td><td><button class="link small" data-del="expenses/${e.id}">delete</button></td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted small">No expenses recorded this month.</td></tr></tbody>';
  }

  $('#moneyMonth').addEventListener('change', renderMoney);
  $('#payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.month = $('#moneyMonth').value;
    try { await api('/api/admin/payments', { method: 'POST', body }); toast('💰 Payment recorded — staff can see it on their page'); e.target.amount.value = ''; e.target.note.value = ''; renderMoney(); } catch (ex) { toast(ex.message, true); }
  });
  $('#expForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { await api('/api/admin/expenses', { method: 'POST', body }); toast('Expense added'); e.target.amount.value = ''; e.target.note.value = ''; renderMoney(); } catch (ex) { toast(ex.message, true); }
  });
  document.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-pay]');
    if (p) { const f = $('#payForm'); f.staffId.value = p.dataset.pay; f.kind.value = 'salary'; f.amount.value = p.dataset.amt; f.amount.focus(); f.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    const d = e.target.closest('[data-del]');
    if (d) { if (!confirm('Delete this entry?')) return; try { await api('/api/admin/' + d.dataset.del, { method: 'DELETE' }); toast('Deleted'); renderMoney(); } catch (ex) { toast(ex.message, true); } }
  });

  // ---------- entry ----------
  async function render(tab, fromPoll) {
    if (tab === 'staff') {
      if (openId) { if (!fromPoll) openStaff(openId); else if (!document.activeElement || !$('#staffDetail').contains(document.activeElement)) openStaff(openId, true); return; }
      if (!fromPoll) await poll();
      renderList();
    }
    if (tab === 'money' && !fromPoll) renderMoney();
  }

  window.PRStaff = { render, poll };
})();
