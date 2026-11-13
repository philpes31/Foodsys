// Frontend do Balcão: loja pública, acompanhamento, painel da empresa e painel da plataforma. JavaScript puro, sem build.
const $ = s => document.querySelector(s);
const app = $('#app');
const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toCents = v => { const n = Number(String(v).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const fromCents = c => (c / 100).toFixed(2).replace('.', ',');
const mins = t => Math.max(0, Math.floor((Date.now() - t) / 60000));
const SLABEL = { novo: 'Recebido', preparo: 'Em preparo', pronto: 'Pronto', rota: 'Saiu para entrega', entregue: 'Entregue', cancelado: 'Cancelado' };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

/* ---------- utilidades de interface ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
function dialog(html, wide = false) { $('#dlg').classList.toggle('wide', wide); $('#dlgBody').innerHTML = html; $('#dlg').classList.add('open'); $('#dlgBody').querySelector('input,select,button')?.focus(); return $('#dlgBody'); }
function closeDlg() { $('#dlg').classList.remove('open'); $('#dlgBody').onclick = $('#dlgBody').onchange = $('#dlgBody').onsubmit = $('#dlgBody').oninput = null; }
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') closeDlg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDlg(); });
const setColor = c => document.documentElement.style.setProperty('--red', c || '#d62828');

async function api(path, opts = {}) {
  const token = store.get('token');
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/api/public')) { store.set('token', null); go('/entrar'); }
  if (!res.ok) throw new Error(data.error || 'Erro de conexão');
  return data;
}
const attempt = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function art(ic, c) {
  c = c || '#d62828'; const sh = '<ellipse cx="110" cy="116" rx="58" ry="7" fill="#0002"/>';
  const A = {
    pizza: `<circle cx="110" cy="62" r="54" fill="#d9a35b"/><circle cx="110" cy="62" r="45" fill="#e8463c"/>${[[80, 45, '#fff3d6'], [115, 35, '#7a1f1f'], [138, 58, '#fff3d6'], [95, 78, '#7a1f1f'], [128, 85, '#2f8f46'], [85, 62, '#2f8f46'], [110, 60, '#fff3d6']].map(([x, y, f]) => `<circle cx="${x}" cy="${y}" r="7" fill="${f}"/>`).join('')}`,
    burger: `<path d="M58 58 Q110 0 162 58 Z" fill="#e0a050"/><rect x="54" y="58" width="112" height="10" rx="5" fill="#5fae4b"/><rect x="58" y="68" width="104" height="10" fill="#f3c242"/><rect x="56" y="76" width="108" height="16" rx="8" fill="#6b3a1e"/><rect x="58" y="92" width="104" height="16" rx="7" fill="#e0a050"/>`,
    cup: `<path d="M72 34 H148 L138 110 H82 Z" fill="#fff"/><path d="M75 52 H145 L138 110 H82 Z" fill="${c}"/><ellipse cx="110" cy="34" rx="40" ry="8" fill="#6a2c91"/>${[[95, 28, '#f3c242'], [112, 26, '#e8463c'], [126, 30, '#fff3d6']].map(([x, y, f]) => `<circle cx="${x}" cy="${y}" r="6" fill="${f}"/>`).join('')}`,
    bottle: `<rect x="92" y="38" width="36" height="74" rx="10" fill="${c}"/><rect x="102" y="18" width="16" height="24" rx="4" fill="#333"/><rect x="92" y="62" width="36" height="20" fill="#fff" opacity=".85"/>`,
    box: `<path d="M66 50 L110 32 L154 50 L154 104 L110 118 L66 104 Z" fill="#c9925a"/><path d="M66 50 L110 66 L154 50" fill="none" stroke="#8a5a2b" stroke-width="2"/><path d="M110 66 V118" stroke="#8a5a2b" stroke-width="2"/><rect x="118" y="78" width="26" height="14" rx="2" fill="${c}"/>`,
    leaf: `<circle cx="92" cy="72" r="32" fill="#e8463c"/><circle cx="132" cy="80" r="26" fill="#f3c242"/><path d="M92 40 q8 -16 22 -14 q-6 14 -22 14Z" fill="#2f8f46"/>`,
    pill: `<g transform="rotate(-30 110 66)"><rect x="66" y="50" width="88" height="32" rx="16" fill="#fff"/><path d="M110 50 H138 a16 16 0 0 1 0 32 H110Z" fill="${c}"/></g>`
  };
  return `<svg viewBox="0 0 220 124" aria-hidden="true">${sh}${A[ic] || A.box}</svg>`;
}
const ICONS = ['pizza', 'burger', 'cup', 'bottle', 'box', 'leaf', 'pill'];

/* ---------- roteamento ---------- */
let cleanup = null;
function go(path) { history.pushState(null, '', path); render(); }
addEventListener('popstate', () => render());
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});

let ME = null;
async function loadMe() {
  if (!store.get('token')) return (ME = null);
  try { ME = await api('/api/me'); } catch { ME = null; }
  return ME;
}

function header(nav = '', who = true) {
  $('#nav').innerHTML = nav;
  $('#who').innerHTML = who && ME ? `<span>${esc(ME.user.name)}</span><button class="sm" id="logout">Sair</button>` : who ? `<a class="btn sm" style="background:#ffffff26;color:#fff" href="/entrar" data-link>Entrar</a>` : '';
  $('#logout')?.addEventListener('click', () => { store.set('token', null); ME = null; go('/entrar'); });
}

async function render() {
  cleanup?.(); cleanup = null; closeDlg();
  const p = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  try {
    if (p[0] === 'loja' && p[1]) return await vShop(p[1]);
    if (p[0] === 'pedido' && p[1]) return await vTrack(p[1]);
    if (p[0] === 'entrar') return vLogin();
    if (p[0] === 'painel') { await loadMe(); if (!ME?.store) return go('/entrar'); return await vPanel(p[1] || 'pedidos'); }
    if (p[0] === 'plataforma') { await loadMe(); if (ME?.user.role !== 'platform') return go('/entrar'); return await vPlatform(); }
    await loadMe(); return vHome();
  } catch (e) { app.innerHTML = `<div class="panel auth"><h2>Ops</h2><p>${esc(e.message)}</p><a class="btn" href="/" data-link>Voltar ao início</a></div>`; }
}

/* ---------- início ---------- */
function vHome() {
  setColor('#d62828'); $('#bName').textContent = 'Balcão'; header();
  const dest = ME?.user.role === 'platform' ? '/plataforma' : ME ? '/painel' : '/entrar';
  app.innerHTML = `<section class="hero"><div class="grid"><h1>Delivery próprio para qualquer negócio</h1>
    <p>Loja online com a sua marca, fila de preparo em tempo real, despacho de entregadores e relatórios — para pizzaria, hamburgueria, açaí, mercado, farmácia e o que mais vender por entrega.</p>
    <div class="row"><a class="btn pri" href="${dest}" data-link>${ME ? 'Ir para o painel' : 'Entrar no painel'}</a></div></div>
    <div class="menu" style="grid-template-columns:repeat(2,minmax(0,1fr))">${['pizza', 'burger', 'cup', 'box'].map((i, k) => `<div class="item">${art(i, ['#d62828', '#e85d04', '#6a2c91', '#2f8f46'][k])}</div>`).join('')}</div></section>
    <h3>Lojas de demonstração</h3><p class="mut">Disponíveis quando o servidor é iniciado com SEED_DEMO=1.</p>
    <div class="demo">${[['forno-da-vila', 'Forno da Vila', 'Pizzaria'], ['brasa-burger', 'Brasa Burger', 'Hamburgueria'], ['acai-da-praia', 'Açaí da Praia', 'Açaiteria'], ['mercadinho-bom-preco', 'Mercadinho Bom Preço', 'Mercado']]
      .map(([s, n, g]) => `<a href="/loja/${s}" data-link><b>${n}</b><span class="mut">${g} · /loja/${s}</span></a>`).join('')}</div>`;
}

/* ---------- login ---------- */
function vLogin() {
  setColor('#d62828'); $('#bName').textContent = 'Balcão'; header('', false);
  app.innerHTML = `<form class="panel auth" id="fLogin"><h2>Entrar</h2><p class="mut">Acesso para empresas e para a administração da plataforma.</p>
    <label>E-mail<input id="lE" type="email" required autocomplete="username"></label>
    <label>Senha<input id="lP" type="password" required autocomplete="current-password"></label>
    <button class="pri">Entrar</button></form>`;
  $('#fLogin').onsubmit = attempt(async e => {
    e.preventDefault();
    const r = await api('/api/auth/login', { method: 'POST', body: { email: $('#lE').value, password: $('#lP').value } });
    store.set('token', r.token); go(r.user.role === 'platform' ? '/plataforma' : '/painel');
  });
}

/* ================= LOJA PÚBLICA ================= */
async function vShop(slug) {
  const data = await api(`/api/public/stores/${encodeURIComponent(slug)}`);
  const S = data.store; setColor(S.color); $('#bName').textContent = S.name; header('', false);
  document.title = `${S.name} — pedido online`;
  const cartKey = `cart:${slug}`;
  let cart = store.get(cartKey, []).filter(c => data.products.some(p => p.id === c.productId));
  let cat = null, coupon = null;
  const cats = [...new Set(data.products.map(p => p.category))];
  const saveCart = () => store.set(cartKey, cart);
  const unitOf = (p, ids) => p.price + p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).reduce((t, o) => t + o.price, 0);
  const totals = () => {
    const sub = cart.reduce((t, c) => t + c.qty * c.unit, 0);
    const pickup = $('#cMode')?.value === 'pickup';
    const z = data.zones.find(z => String(z.id) === $('#cZone')?.value) || data.zones[0];
    let fee = pickup || !z ? 0 : z.fee, disc = 0;
    if (coupon) { if (coupon.percent) disc = Math.round(sub * coupon.percent / 100); if (coupon.freeShipping) fee = 0; }
    return { sub, fee, disc, total: sub + fee - disc, pickup, zone: z };
  };
  const paint = () => {
    cat = cats.includes(cat) ? cat : cats[0];
    const list = data.products.filter(p => p.category === cat);
    app.innerHTML = `<h2>${esc(S.name)}</h2><p class="lead">${esc(S.segmentName)} · ${S.isOpen ? '<span class="badge b-g">Aberto agora</span>' : '<span class="badge b-r">Fechado</span>'} · entrega em ${esc(S.eta)}${S.minOrder ? ` · pedido mínimo ${brl(S.minOrder)}` : ''}${S.phone ? ` · ${esc(S.phone)}` : ''}</p>
    <div class="shop"><section>
      <div class="cats">${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="menu">${list.map(p => `<article class="item">${art(p.icon, S.color)}<div class="b"><h3>${esc(p.name)}</h3><span class="mut">${esc(p.description)}</span>
        <div class="foot"><span class="price">${p.groups.some(g => g.min_sel && g.options.some(o => o.price)) ? '<span class="mut">a partir de </span>' : ''}<b>${brl(p.price)}</b></span>
        <button class="pri sm" data-add="${p.id}" ${S.isOpen ? '' : 'disabled'}>Adicionar</button></div></div></article>`).join('') || '<p class="empty">Cardápio vazio.</p>'}</div>
    </section>
    <aside class="cart" aria-label="Carrinho"><h3>Seu pedido</h3>
      ${cart.length ? cart.map((x, i) => `<div class="ci"><div><b>${x.qty}× ${esc(x.name)}</b>${x.optText ? `<br><span class="mut">${esc(x.optText)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}<br><button class="ghost sm" data-dec="${i}" aria-label="Diminuir">−</button> <button class="ghost sm" data-inc="${i}" aria-label="Aumentar">+</button></div><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('') : '<p class="empty">Carrinho vazio.</p>'}
      <label>Como receber<select id="cMode"><option value="delivery">Entrega</option>${S.allowPickup ? '<option value="pickup">Retirar na loja</option>' : ''}</select></label>
      <label id="zWrap">Bairro<select id="cZone">${data.zones.map(z => `<option value="${z.id}">${esc(z.name)} · ${z.fee ? brl(z.fee) : 'grátis'}</option>`).join('')}</select></label>
      <label>Cupom<span class="row" style="flex-wrap:nowrap"><input id="cCup" placeholder="Ex.: PRIMEIRA10" value="${esc(coupon?.code || '')}"><button class="ghost" id="cupBtn">Aplicar</button></span></label>
      <div id="tots"></div><button class="pri" id="checkout">Finalizar pedido</button></aside></div>
    ${cart.length ? `<button class="pri cartbar" id="toCart">Ver carrinho · ${cart.reduce((t, c) => t + c.qty, 0)} ${cart.length > 1 ? 'itens' : 'item'} · ${brl(cart.reduce((t, c) => t + c.qty * c.unit, 0))}</button>` : ''}`;
    paintTotals();
  };
  const paintTotals = () => {
    const t = totals(); $('#zWrap').hidden = t.pickup;
    const low = S.minOrder && t.sub < S.minOrder;
    $('#tots').innerHTML = `<div class="ci"><span>Subtotal</span><span class="price">${brl(t.sub)}</span></div><div class="ci"><span>Entrega</span><span class="price">${t.fee ? brl(t.fee) : 'Grátis'}</span></div>${t.disc ? `<div class="ci"><span>Desconto</span><span class="price">−${brl(t.disc)}</span></div>` : ''}<div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>${low && cart.length ? `<span class="badge b-a">Faltam ${brl(S.minOrder - t.sub)} para o pedido mínimo</span>` : ''}`;
    $('#checkout').disabled = !cart.length || low || !S.isOpen || (!t.pickup && !data.zones.length);
  };
  const addToCart = it => { const ex = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); ex ? ex.qty += it.qty : cart.push(it); saveCart(); toast('Adicionado ao carrinho'); paint(); };
  const builder = p => {
    if (!p.groups.length) return addToCart({ productId: p.id, name: p.name, optionIds: [], optText: '', unit: p.price, qty: 1, notes: '' });
    const sel = p.groups.map(g => g.min_sel ? g.options.slice(0, g.min_sel).map(o => o.id) : []);
    let qty = 1, notes = '';
    const draw = () => {
      const ids = sel.flat();
      dialog(`<h2>${esc(p.name)}</h2><span class="mut">${esc(p.description)}</span>
      ${p.groups.map((g, i) => `<div class="grp"><h3><span>${esc(g.name)}</span><span class="badge ${g.min_sel ? 'b-a' : ''}">${g.min_sel ? (g.min_sel === g.max_sel ? `Escolha ${g.min_sel}` : `Mín. ${g.min_sel}, máx. ${g.max_sel}`) : g.max_sel > 1 ? `Até ${g.max_sel}` : 'Opcional'}</span></h3>
        <div class="opts">${g.options.map(o => `<button data-g="${i}" data-o="${o.id}" class="${sel[i].includes(o.id) ? 'on' : ''}" aria-pressed="${sel[i].includes(o.id)}">${esc(o.name)}${o.price ? ' +' + brl(o.price) : ''}</button>`).join('')}</div></div>`).join('')}
      <label>Observação<input id="bObs" value="${esc(notes)}" maxlength="140" placeholder="Ex.: sem cebola"></label>
      <div class="row between"><span class="row"><button class="ghost sm" data-q="-1" aria-label="Menos">−</button><b>${qty}</b><button class="ghost sm" data-q="1" aria-label="Mais">+</button></span><span class="tot price">${brl(unitOf(p, ids) * qty)}</span></div>
      <div class="row" style="justify-content:flex-end"><button class="ghost" id="bX">Cancelar</button><button class="pri" id="bOk">Adicionar</button></div>`);
      $('#dlgBody').onclick = e => {
        const b = e.target.closest('button'); if (!b) return; notes = $('#bObs').value;
        if (b.dataset.g) {
          const i = +b.dataset.g, id = +b.dataset.o, g = p.groups[i], a = sel[i];
          if (a.includes(id)) { if (g.max_sel === 1 && g.min_sel === 1) return; a.splice(a.indexOf(id), 1); }
          else if (g.max_sel === 1) sel[i] = [id];
          else if (a.length < g.max_sel) a.push(id);
          else return toast(`Máximo de ${g.max_sel} em ${g.name}`);
          draw();
        } else if (b.dataset.q) { qty = Math.max(1, Math.min(99, qty + +b.dataset.q)); draw(); }
        else if (b.id === 'bX') closeDlg();
        else if (b.id === 'bOk') {
          const bad = p.groups.findIndex((g, i) => sel[i].length < g.min_sel);
          if (bad >= 0) return toast(`Escolha ${p.groups[bad].min_sel} em ${p.groups[bad].name}`);
          const ids = sel.flat(), names = p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).map(o => o.name);
          closeDlg(); addToCart({ productId: p.id, name: p.name, optionIds: ids.sort((a, b) => a - b), optText: names.join(', '), unit: unitOf(p, ids), qty, notes: notes.trim() });
        }
      };
    };
    draw();
  };
  const checkout = () => {
    const t = totals(), last = store.get('customer', {});
    dialog(`<h2>Finalizar pedido</h2><form id="fCk" class="grid">
      <label>Nome<input id="kN" required autocomplete="name" value="${esc(last.name || '')}"></label>
      <label>Telefone / WhatsApp<input id="kP" required inputmode="tel" autocomplete="tel" value="${esc(last.phone || '')}" placeholder="(11) 90000-0000"></label>
      ${t.pickup ? '<p class="mut">Retirada na loja — sem taxa de entrega.</p>' : `<label>Endereço em ${esc(t.zone.name)}<input id="kA" required minlength="5" autocomplete="street-address" value="${esc(last.address || '')}" placeholder="Rua, número, complemento"></label>`}
      <label>Pagamento<select id="kPay"><option>Pix</option><option>Cartão na entrega</option><option>Dinheiro</option></select></label>
      <label id="kTr" hidden>Troco para (R$)<input id="kT" inputmode="decimal" placeholder="Ex.: 100"></label>
      <div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="ghost" id="kX">Voltar</button><button class="pri" id="kGo">Enviar pedido</button></div></form>`);
    $('#kPay').onchange = e => $('#kTr').hidden = e.target.value !== 'Dinheiro';
    $('#kX').onclick = closeDlg;
    $('#fCk').onsubmit = attempt(async e => {
      e.preventDefault(); $('#kGo').disabled = true;
      try {
        const customer = { name: $('#kN').value, phone: $('#kP').value };
        const r = await api(`/api/public/stores/${slug}/orders`, { method: 'POST', body: {
          customer, fulfillment: t.pickup ? 'pickup' : 'delivery', zoneId: t.zone?.id, address: $('#kA')?.value, payment: $('#kPay').value,
          changeFor: $('#kT').value ? toCents($('#kT').value) : undefined, coupon: coupon?.code,
          items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: c.notes })) } });
        store.set('customer', { ...customer, address: $('#kA')?.value || last.address });
        cart = []; saveCart(); closeDlg(); go(`/pedido/${r.code}`);
      } finally { const b = $('#kGo'); if (b) b.disabled = false; }
    });
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.cat) { cat = d.cat; paint(); }
    else if (d.add) builder(data.products.find(p => p.id === +d.add));
    else if (d.inc) { cart[d.inc].qty++; saveCart(); paint(); }
    else if (d.dec) { if (!--cart[d.dec].qty) cart.splice(d.dec, 1); saveCart(); paint(); }
    else if (b.id === 'cupBtn') { coupon = null; const code = $('#cCup').value.trim(); if (code) { coupon = await api(`/api/public/stores/${slug}/coupon`, { method: 'POST', body: { code } }); toast('Cupom aplicado'); } paintTotals(); }
    else if (b.id === 'checkout') checkout();
    else if (b.id === 'toCart') $('.cart').scrollIntoView({ behavior: 'smooth' });
  });
  app.onchange = e => { if (['cMode', 'cZone'].includes(e.target.id)) paintTotals(); };
  cleanup = () => { app.onclick = app.onchange = null; document.title = 'Balcão'; };
  paint();
}

/* ---------- acompanhamento do pedido ---------- */
async function vTrack(code) {
  const draw = async () => {
    const { store: S, order: o } = await api(`/api/public/orders/${encodeURIComponent(code)}`);
    setColor(S.color); $('#bName').textContent = S.name; header('', false);
    const flow = o.fulfillment === 'pickup' ? ['novo', 'preparo', 'pronto', 'entregue'] : ['novo', 'preparo', 'pronto', 'rota', 'entregue'];
    const idx = flow.indexOf(o.status), at = Object.fromEntries(o.events.map(e => [e.status, e.at]));
    app.innerHTML = `<h2>Pedido #${o.number}</h2><p class="lead">Olá, ${esc(o.customerName)}! Esta página atualiza sozinha.</p>
    <div class="panel" style="max-width:760px">
      ${o.status === 'cancelado' ? '<span class="badge b-r">Pedido cancelado pela loja. Em caso de dúvida, entre em contato.</span>' :
      `<div class="steps">${flow.map((s, i) => `<span class="${i <= idx ? 'on' : ''}">${s === 'pronto' && o.fulfillment === 'pickup' ? 'Pronto p/ retirar' : SLABEL[s]}${at[s] ? `<br><small>${new Date(at[s]).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>` : ''}</span>`).join('')}</div>`}
      ${o.courier ? `<p><b>${esc(o.courier)}</b> está a caminho de ${esc(o.address)}, ${esc(o.zone)}.</p>` : ''}
      <table><tbody>${o.items.map(x => `<tr><td>${x.qty}× ${esc(x.product_name)}${x.options_text ? `<br><span class="mut">${esc(x.options_text)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}</td><td class="n price">${brl(x.qty * x.unit_price)}</td></tr>`).join('')}
      <tr><td>${o.fulfillment === 'pickup' ? 'Retirada na loja' : `Entrega (${esc(o.zone)})`}</td><td class="n price">${brl(o.fee)}</td></tr>
      ${o.discount ? `<tr><td>Desconto ${esc(o.coupon || '')}</td><td class="n price">−${brl(o.discount)}</td></tr>` : ''}
      <tr><td><b>Total · ${esc(o.payment)}</b></td><td class="n price"><b>${brl(o.total)}</b></td></tr></tbody></table>
      <a class="btn ghost" href="/loja/${esc(S.slug)}" data-link>Voltar à loja</a></div>`;
    return o.status;
  };
  const st = await draw();
  if (!['entregue', 'cancelado'].includes(st)) {
    const h = setInterval(async () => { try { if (['entregue', 'cancelado'].includes(await draw())) clearInterval(h); } catch {} }, 8000);
    cleanup = () => clearInterval(h);
  }
}

/* ================= PAINEL DA EMPRESA ================= */
async function vPanel(tab) {
  const S = ME.store, owner = ME.user.role === 'owner';
  setColor(S.color); $('#bName').textContent = S.name;
  const tabs = [['pedidos', S.prepName], ['entregas', 'Entregas'], ['cardapio', 'Cardápio'], ...(owner ? [['relatorios', 'Relatórios'], ['config', 'Configurações']] : [])];
  if (!tabs.some(t => t[0] === tab)) tab = 'pedidos';
  header(tabs.map(([k, n]) => `<a href="/painel/${k}" data-link class="${k === tab ? 'on' : ''}">${esc(n)}</a>`).join('') + `<a href="/loja/${S.slug}" target="_blank" rel="noopener">Ver loja ↗</a>`);
  const views = { pedidos: pOrders, entregas: pDelivery, cardapio: pMenu, relatorios: pReports, config: pConfig };
  await views[tab](S, owner);
}

// Fila de preparo com atualização em tempo real (SSE) e aviso sonoro de pedido novo.
function live(onOrder) {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(store.get('token'))}`);
  es.addEventListener('order', e => onOrder(JSON.parse(e.data)));
  const tick = setInterval(() => onOrder(null), 30000);
  return () => { es.close(); clearInterval(tick); };
}
function beep() {
  try { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = 880; g.gain.value = .15; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + .35); } catch {}
}
const itemsList = o => `<ul>${o.items.map(x => `<li>${x.qty}× ${esc(x.product_name)}${x.options_text ? ` <span class="mut">(${esc(x.options_text)})</span>` : ''}${x.notes ? ` <b>— ${esc(x.notes)}</b>` : ''}</li>`).join('')}</ul>`;

async function pOrders(S) {
  let orders = [];
  const load = async () => { orders = await api('/api/orders?status=novo,preparo,pronto'); draw(); };
  const draw = () => {
    if (!document.body.contains(app)) return;
    const cols = [['novo', 'Novos', 'Aceitar', 'preparo'], ['preparo', 'Em preparo', 'Marcar pronto', 'pronto'], ['pronto', 'Prontos', '', '']];
    app.innerHTML = `<div class="row between"><div><h2>${esc(S.prepName)}</h2><p class="lead">Pedidos chegam aqui na hora, com aviso sonoro. Tickets com mais de 25 min ficam em alerta.</p></div></div>
    <div class="board">${cols.map(([k, t, a, next]) => { const os = orders.filter(o => o.status === k);
      return `<div class="col"><h3>${t}<span class="badge">${os.length}</span></h3>${os.map(o => `<div class="tk ${mins(o.created_at) > 25 ? 'late' : ''}">
        <div class="top"><span>#${o.number}</span><span class="price">${mins(o.created_at)} min</span></div>
        <span class="mut">${esc(o.customer_name)} · ${o.fulfillment === 'pickup' ? 'Retirada' : 'Entrega · ' + esc(o.zone_name)} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''}</span>
        ${itemsList(o)}<b class="price">${brl(o.total)}</b>
        <div class="row">${a ? `<button class="ok sm" data-st="${next}" data-id="${o.id}">${a}</button>` : `<span class="badge b-g">Aguardando ${o.fulfillment === 'pickup' ? 'cliente' : 'entregador'}</span>`}
        ${k !== 'pronto' ? `<button class="ghost sm" data-st="cancelado" data-id="${o.id}">${k === 'novo' ? 'Recusar' : 'Cancelar'}</button>` : ''}</div></div>`).join('') || '<p class="empty">Nada aqui</p>'}</div>`; }).join('')}</div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button[data-st]'); if (!b) return;
    if (b.dataset.st === 'cancelado' && !b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Confirmar?'; return; }
    await api(`/api/orders/${b.dataset.id}/status`, { method: 'POST', body: { status: b.dataset.st } }); await load();
  });
  const stop = live(o => { if (o?.status === 'novo' && !orders.some(x => x.id === o.id)) { beep(); toast(`Novo pedido #${o.number}`); } load().catch(() => {}); });
  cleanup = () => { stop(); app.onclick = null; };
  await load();
}

async function pDelivery() {
  let ready = [], route = [], couriers = [];
  const load = async () => {
    [ready, route, couriers] = await Promise.all([api('/api/orders?status=pronto'), api('/api/orders?status=rota'), api('/api/couriers')]);
    draw();
  };
  const draw = () => {
    const free = couriers.filter(c => c.active);
    app.innerHTML = `<h2>Entregas</h2><p class="lead">Despache os pedidos prontos e confirme quando forem entregues.</p>
    <div class="two"><div class="panel"><h3>Prontos (${ready.length})</h3>
      ${ready.map(o => `<div class="tk"><div class="top"><span>#${o.number} · ${esc(o.customer_name)}</span><span class="price">${brl(o.total)}</span></div>
        <span class="mut">${o.fulfillment === 'pickup' ? 'Retirada na loja' : `${esc(o.address)} — ${esc(o.zone_name)}`} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''} · ${esc(o.customer_phone)}</span>
        ${o.fulfillment === 'pickup' ? `<button class="ok sm" data-st="entregue" data-id="${o.id}">Cliente retirou</button>` : free.length ? `<span class="row" style="flex-wrap:nowrap"><select id="c${o.id}" aria-label="Entregador">${free.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="pri sm" data-st="rota" data-id="${o.id}">Despachar</button></span>` : '<span class="badge b-a">Cadastre ou ative um entregador</span>'}</div>`).join('') || '<p class="empty">Nenhum pedido pronto</p>'}
    </div><div class="panel"><h3>Em rota (${route.length})</h3>
      ${route.map(o => `<div class="tk go"><div class="top"><span>#${o.number} · ${esc(o.courier_name || '—')}</span><span class="price">${mins(o.updated_at)} min</span></div><span class="mut">${esc(o.address)} — ${esc(o.zone_name)} · ${esc(o.payment)}</span><button class="ok sm" data-st="entregue" data-id="${o.id}">Confirmar entrega</button></div>`).join('') || '<p class="empty">Ninguém na rua agora</p>'}
      <h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td>${route.some(o => o.courier_id === c.id) ? '<span class="badge b-a">Em rota</span>' : c.active ? '<span class="badge b-g">Disponível</span>' : '<span class="badge">Folga</span>'}</td><td class="n"><button class="ghost sm" data-cour="${c.id}">${c.active ? 'Dar folga' : 'Ativar'}</button></td></tr>`).join('')}</tbody></table>
    </div></div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.st) await api(`/api/orders/${b.dataset.id}/status`, { method: 'POST', body: { status: b.dataset.st, courierId: b.dataset.st === 'rota' ? +$('#c' + b.dataset.id).value : undefined } });
    if (b.dataset.cour) { const c = couriers.find(x => x.id === +b.dataset.cour); await api(`/api/couriers/${c.id}`, { method: 'PUT', body: { active: !c.active } }); }
    await load();
  });
  const stop = live(() => load().catch(() => {}));
  cleanup = () => { stop(); app.onclick = null; };
  await load();
}

/* ---------- cardápio + editor de grupos de opções ---------- */
async function pMenu(S, owner) {
  let prods = [];
  const load = async () => { prods = await api('/api/products'); draw(); };
  const draw = () => {
    const cats = [...new Set(prods.map(p => p.category))];
    app.innerHTML = `<div class="row between"><div><h2>Cardápio</h2><p class="lead">${owner ? 'Crie produtos com grupos de opções: tamanhos, sabores, adicionais, combos.' : 'Marque itens esgotados conforme o estoque.'}</p></div>${owner ? '<button class="pri" id="newP">Novo produto</button>' : ''}</div>
    ${cats.map(c => `<div class="panel" style="margin-bottom:16px"><h3>${esc(c)}</h3><div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th>Opções</th><th class="n">Preço</th><th>Disponível</th><th></th></tr></thead><tbody>
      ${prods.filter(p => p.category === c).map(p => `<tr><td data-l="Produto"><b>${esc(p.name)}</b><br><span class="mut">${esc(p.description)}</span></td>
        <td data-l="Opções"><span class="mut">${p.groups.map(g => `${esc(g.name)} (${g.options.length})`).join(', ') || '—'}</span></td><td data-l="Preço" class="n price">${brl(p.price)}</td>
        <td data-l="Disponível"><button class="sm ${p.available ? 'ok' : 'ghost'}" data-av="${p.id}">${p.available ? 'Sim' : 'Esgotado'}</button></td>
        <td data-l="">${owner ? `<button class="ghost sm" data-ed="${p.id}">Editar</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<p class="empty">Nenhum produto ainda.</p>'}`;
  };
  const editor = p => {
    const cats = [...new Set(prods.map(x => x.category))];
    const st = p ? JSON.parse(JSON.stringify(p)) : { category: cats[0] || '', name: '', description: '', price: 0, icon: 'box', available: true, groups: [] };
    const readForm = () => {
      st.name = $('#eN').value; st.category = $('#eC').value; st.description = $('#eD').value; st.price = toCents($('#eP').value); st.icon = $('#eI').value;
      st.groups.forEach((g, i) => { g.name = $(`#gN${i}`).value; g.min_sel = +$(`#gMin${i}`).value; g.max_sel = +$(`#gMax${i}`).value;
        g.options.forEach((o, k) => { o.name = $(`#o${i}_${k}`).value; o.price = toCents($(`#op${i}_${k}`).value || '0'); }); });
    };
    const drawEd = () => dialog(`<h2>${p ? 'Editar produto' : 'Novo produto'}</h2><form id="fEd" class="grid" novalidate>
      <div class="two" style="gap:10px"><label>Nome<input id="eN" required value="${esc(st.name)}"></label><label>Categoria<input id="eC" list="catl" required value="${esc(st.category)}"><datalist id="catl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
      <label>Descrição<input id="eD" value="${esc(st.description)}" maxlength="200"></label>
      <div class="two" style="gap:10px"><label>Preço base (R$)<input id="eP" inputmode="decimal" required value="${fromCents(st.price || 0)}"></label><label>Ilustração<select id="eI">${ICONS.map(i => `<option ${i === st.icon ? 'selected' : ''}>${i}</option>`).join('')}</select></label></div>
      <div class="row between"><h3>Grupos de opções</h3><button type="button" class="ghost sm" id="addG">+ Grupo</button></div>
      <p class="mut" style="margin:0">Mínimo 0 = opcional. Mínimo 1 e máximo 1 = escolha obrigatória de uma opção (ex.: tamanho). Máximo maior que 1 = várias escolhas (ex.: adicionais). O preço da opção soma ao preço base.</p>
      ${st.groups.map((g, i) => `<div class="ged"><div class="g3"><label>Nome do grupo<input id="gN${i}" value="${esc(g.name)}" placeholder="Ex.: Tamanho"></label><label>Mínimo<input id="gMin${i}" type="number" min="0" value="${g.min_sel}"></label><label>Máximo<input id="gMax${i}" type="number" min="1" value="${g.max_sel}"></label><button type="button" class="ghost sm" data-rg="${i}">Remover</button></div>
        ${g.options.map((o, k) => `<div class="o2"><input id="o${i}_${k}" value="${esc(o.name)}" placeholder="Opção" aria-label="Nome da opção"><input id="op${i}_${k}" inputmode="decimal" value="${fromCents(o.price || 0)}" aria-label="Preço adicional"><button type="button" class="ghost sm" data-ro="${i}_${k}" aria-label="Remover opção">×</button></div>`).join('')}
        <button type="button" class="ghost sm" data-ao="${i}">+ Opção</button></div>`).join('')}
      <div class="row between">${p ? '<button type="button" class="ghost" id="delP">Excluir produto</button>' : '<span></span>'}<span class="row"><button type="button" class="ghost" id="eX">Cancelar</button><button class="pri">Salvar</button></span></div></form>`, true);
    drawEd();
    $('#dlgBody').onclick = attempt(async e => {
      const b = e.target.closest('button'); if (!b || b.type === 'submit') return; readForm();
      if (b.id === 'addG') { st.groups.push({ name: '', min_sel: 0, max_sel: 1, options: [{ name: '', price: 0 }] }); drawEd(); }
      else if (b.dataset.rg) { st.groups.splice(+b.dataset.rg, 1); drawEd(); }
      else if (b.dataset.ao) { st.groups[+b.dataset.ao].options.push({ name: '', price: 0 }); drawEd(); }
      else if (b.dataset.ro) { const [i, k] = b.dataset.ro.split('_').map(Number); st.groups[i].options.splice(k, 1); drawEd(); }
      else if (b.id === 'eX') closeDlg();
      else if (b.id === 'delP') { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Clique de novo para excluir'; return; } await api(`/api/products/${p.id}`, { method: 'DELETE' }); closeDlg(); toast('Produto excluído'); await load(); }
    });
    $('#dlgBody').onsubmit = attempt(async e => {
      e.preventDefault(); readForm();
      const body = { ...st, groups: st.groups.map(g => ({ ...g, options: g.options.filter(o => o.name.trim()) })) };
      if (!Number.isInteger(body.price)) throw new Error('Preço base inválido');
      await api(p ? `/api/products/${p.id}` : '/api/products', { method: p ? 'PUT' : 'POST', body });
      closeDlg(); toast('Produto salvo'); await load();
    });
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'newP') editor(null);
    if (b.dataset.ed) editor(prods.find(p => p.id === +b.dataset.ed));
    if (b.dataset.av) { const p = prods.find(x => x.id === +b.dataset.av); await api(`/api/products/${p.id}/availability`, { method: 'PATCH', body: { available: !p.available } }); await load(); }
  });
  cleanup = () => { app.onclick = null; };
  await load();
}

/* ---------- relatórios ---------- */
async function pReports() {
  let days = 7;
  const draw = async () => {
    const r = await api(`/api/reports?days=${days}`);
    const bars = (rows, label, val, fmt, color) => { const m = Math.max(1, ...rows.map(val)); return rows.map(x => `<div class="bar"><span>${esc(label(x))}</span><i style="width:${val(x) / m * 100}%;${color ? `background:${color}` : ''}"></i><span class="price">${fmt(x)}</span></div>`).join('') || '<p class="empty">Sem dados no período</p>'; };
    app.innerHTML = `<div class="row between"><div><h2>Relatórios</h2><p class="lead">Pedidos não cancelados no período escolhido.</p></div>
      <span class="row">${[1, 7, 30, 90].map(d => `<button class="sm ${d === days ? 'pri' : 'ghost'}" data-days="${d}">${d === 1 ? 'Hoje' : d + ' dias'}</button>`).join('')}</span></div>
    <div class="kpis"><div class="kpi"><span class="mut">Faturamento</span><b class="price">${brl(r.revenue)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${r.orders}</b><span class="mut">${r.cancelled} cancelado(s)</span></div>
      <div class="kpi"><span class="mut">Ticket médio</span><b class="price">${brl(r.avgTicket)}</b></div><div class="kpi"><span class="mut">Tempo médio até entregar</span><b>${r.avgDeliveryMin ?? '—'}${r.avgDeliveryMin != null ? ' min' : ''}</b></div></div>
    <div class="two"><div class="panel"><h3>Faturamento por dia</h3><div class="bars">${bars(r.byDay, x => x.d.split('-').reverse().slice(0, 2).join('/'), x => x.revenue, x => brl(x.revenue))}</div></div>
      <div class="panel"><h3>Pedidos por horário</h3><div class="bars">${bars(r.byHour, x => String(x.h).padStart(2, '0') + 'h', x => x.orders, x => x.orders + ' ped.')}</div></div>
      <div class="panel"><h3>Mais vendidos</h3><div class="bars">${bars(r.top, x => x.name, x => x.qty, x => x.qty + ' un.', 'var(--basil)')}</div></div>
      <div class="panel"><h3>Formas de pagamento</h3><div class="bars">${bars(r.payments, x => x.payment, x => x.revenue, x => brl(x.revenue), 'var(--basil)')}</div>
        <h3>Entregadores</h3><table><thead><tr><th>Nome</th><th class="n">Entregas</th><th class="n">Taxas a repassar</th></tr></thead><tbody>${r.couriers.map(c => `<tr><td>${esc(c.name)}</td><td class="n">${c.deliveries}</td><td class="n price">${brl(c.fees)}</td></tr>`).join('')}</tbody></table></div></div>`;
  };
  app.onclick = attempt(async e => { const b = e.target.closest('button[data-days]'); if (b) { days = +b.dataset.days; await draw(); } });
  cleanup = () => { app.onclick = null; };
  await draw();
}

/* ---------- configurações ---------- */
async function pConfig(S) {
  const meta = await api('/api/meta');
  const draw = async () => {
    const [st, zones, coupons, couriers, team] = await Promise.all([api('/api/store'), api('/api/zones'), api('/api/coupons'), api('/api/couriers'), api('/api/team')]);
    const link = `${location.origin}/loja/${st.slug}`;
    app.innerHTML = `<h2>Configurações</h2><p class="lead">Endereço da sua loja: <a href="${link}" target="_blank" rel="noopener">${esc(link)}</a> <button class="ghost sm" id="copy">Copiar</button></p>
    <div class="two"><form class="panel" id="fStore"><h3>Loja</h3>
      <label>Nome<input id="sN" required value="${esc(st.name)}"></label>
      <div class="two" style="gap:10px"><label>Telefone<input id="sPh" value="${esc(st.phone)}"></label><label>Prazo de entrega<input id="sEta" value="${esc(st.eta)}"></label></div>
      <div class="two" style="gap:10px"><label>Pedido mínimo (R$)<input id="sMin" inputmode="decimal" value="${fromCents(st.minOrder)}"></label><label>Cor da marca<input type="color" id="sC" value="${st.color}"></label></div>
      <label class="chk"><input type="checkbox" id="sOpen" ${st.isOpen ? 'checked' : ''}> Loja aberta para pedidos</label>
      <label class="chk"><input type="checkbox" id="sPick" ${st.allowPickup ? 'checked' : ''}> Aceitar retirada na loja</label>
      <button class="pri">Salvar loja</button></form>
    <div class="panel"><h3>Bairros e taxas</h3><table><tbody>${zones.map(z => `<tr><td>${esc(z.name)}</td><td class="n" style="width:120px"><input inputmode="decimal" value="${fromCents(z.fee)}" data-zone="${z.id}" aria-label="Taxa ${esc(z.name)}"></td><td class="n"><button class="ghost sm" data-del="zones/${z.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fZone" class="row" style="flex-wrap:nowrap"><input id="zN" placeholder="Bairro" required><input id="zF" inputmode="decimal" placeholder="Taxa" style="width:100px" required><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Cupons</h3><table><tbody>${coupons.map(c => `<tr><td><b>${esc(c.code)}</b><br><span class="mut">${[c.percent ? c.percent + '% de desconto' : '', c.free_shipping ? 'frete grátis' : ''].filter(Boolean).join(' + ')}</span></td><td class="n"><button class="sm ${c.active ? 'ok' : 'ghost'}" data-cup="${c.id}">${c.active ? 'Ativo' : 'Pausado'}</button> <button class="ghost sm" data-del="coupons/${c.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fCup" class="row"><input id="cuC" placeholder="CÓDIGO" required style="flex:1"><input id="cuP" type="number" min="0" max="90" placeholder="%" style="width:80px"><label class="chk"><input type="checkbox" id="cuF"> Frete grátis</label><button class="ghost">Criar</button></form></div>
    <div class="panel"><h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td class="n"><button class="ghost sm" data-del="couriers/${c.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fCour" class="row" style="flex-wrap:nowrap"><input id="crN" placeholder="Nome" required><input id="crP" placeholder="Telefone"><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Equipe</h3><table><tbody>${team.map(u => `<tr><td>${esc(u.name)}<br><span class="mut">${esc(u.email)}</span></td><td>${u.role === 'owner' ? 'Dono' : 'Atendente'}</td><td class="n">${u.role === 'staff' ? `<button class="ghost sm" data-del="team/${u.id}" aria-label="Remover">×</button>` : ''}</td></tr>`).join('')}</tbody></table>
      <form id="fTeam" class="grid" style="gap:8px"><div class="two" style="gap:8px"><input id="tN" placeholder="Nome" required><input id="tE" type="email" placeholder="E-mail" required></div><div class="row" style="flex-wrap:nowrap"><input id="tP" type="password" minlength="8" placeholder="Senha (8+ caracteres)" required><button class="ghost">Adicionar atendente</button></div></form>
      <p class="mut" style="margin:0">Atendentes operam pedidos, entregas e disponibilidade do cardápio; não veem relatórios nem configurações.</p></div>
    <div class="panel"><h3>Assinatura</h3><div class="plans">${Object.entries(meta.plans).map(([n, p]) => `<div class="plan ${st.plan === n ? 'on' : ''}"><b>${n}</b><span class="price"><b>${brl(p.price)}</b>/mês</span><span class="mut">${esc(p.features)}</span>${st.plan === n ? '<span class="badge b-g">Plano atual</span>' : `<button class="ghost sm" data-plan="${n}">Mudar</button>`}</div>`).join('')}</div></div></div>`;
  };
  const reloadMe = async () => { await loadMe(); setColor(ME.store.color); $('#bName').textContent = ME.store.name; };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b || b.type === 'submit' || b.closest('form') && !b.dataset.del) return;
    if (b.id === 'copy') { try { await navigator.clipboard.writeText(`${location.origin}/loja/${ME.store.slug}`); toast('Link copiado'); } catch { toast('Copie o link manualmente'); } return; }
    if (b.dataset.del) { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Remover?'; return; } await api('/api/' + b.dataset.del, { method: 'DELETE' }); }
    if (b.dataset.cup) { const id = +b.dataset.cup, act = b.classList.contains('ok'); await api(`/api/coupons/${id}`, { method: 'PUT', body: { active: !act } }); }
    if (b.dataset.plan) { await api('/api/store/plan', { method: 'PUT', body: { plan: b.dataset.plan } }); toast('Plano alterado'); }
    await draw();
  });
  app.onchange = attempt(async e => {
    if (e.target.dataset.zone) { const fee = toCents(e.target.value); if (!Number.isInteger(fee) || fee < 0) throw new Error('Taxa inválida'); await api(`/api/zones/${e.target.dataset.zone}`, { method: 'PUT', body: { fee } }); toast('Taxa atualizada'); }
  });
  app.onsubmit = attempt(async e => {
    e.preventDefault(); const id = e.target.id;
    if (id === 'fStore') { const minOrder = toCents($('#sMin').value || '0'); if (!Number.isInteger(minOrder)) throw new Error('Pedido mínimo inválido');
      await api('/api/store', { method: 'PUT', body: { name: $('#sN').value, phone: $('#sPh').value, eta: $('#sEta').value, minOrder, color: $('#sC').value, isOpen: $('#sOpen').checked, allowPickup: $('#sPick').checked } }); await reloadMe(); }
    if (id === 'fZone') { const fee = toCents($('#zF').value); if (!Number.isInteger(fee)) throw new Error('Taxa inválida'); await api('/api/zones', { method: 'POST', body: { name: $('#zN').value, fee } }); }
    if (id === 'fCup') await api('/api/coupons', { method: 'POST', body: { code: $('#cuC').value, percent: +$('#cuP').value || 0, free_shipping: $('#cuF').checked } });
    if (id === 'fCour') await api('/api/couriers', { method: 'POST', body: { name: $('#crN').value, phone: $('#crP').value } });
    if (id === 'fTeam') await api('/api/team', { method: 'POST', body: { name: $('#tN').value, email: $('#tE').value, password: $('#tP').value } });
    toast('Salvo'); await draw();
  });
  cleanup = () => { app.onclick = app.onchange = app.onsubmit = null; };
  await draw();
}

/* ================= PLATAFORMA ================= */
async function vPlatform() {
  setColor('#1d1716'); $('#bName').textContent = 'Balcão'; header('<a class="on" href="/plataforma" data-link>Plataforma</a>');
  const meta = await api('/api/meta');
  let seg = 'pizzaria';
  const draw = async () => {
    const o = await api('/api/platform/overview');
    app.innerHTML = `<h2>Plataforma</h2><p class="lead">Todas as empresas assinantes, de qualquer segmento.</p>
    <div class="kpis"><div class="kpi"><span class="mut">Empresas</span><b>${o.tenants.length}</b><span class="mut">${o.tenants.filter(t => !t.active).length} suspensa(s)</span></div><div class="kpi"><span class="mut">Receita mensal (MRR)</span><b class="price">${brl(o.mrr)}</b></div>
      <div class="kpi"><span class="mut">Vendido pelas lojas</span><b class="price">${brl(o.gmv)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${o.orders}</b></div></div>
    <div class="panel" style="margin-bottom:20px"><h3>Empresas</h3><div class="scroll"><table class="stack"><thead><tr><th>Empresa</th><th>Segmento</th><th>Dono</th><th>Plano</th><th class="n">Pedidos</th><th class="n">Vendas</th><th></th></tr></thead><tbody>
      ${o.tenants.map(t => `<tr><td data-l="Empresa"><span class="dot" style="background:${t.color}"></span><a href="/loja/${t.slug}" target="_blank" rel="noopener">${esc(t.name)}</a> ${t.active ? '' : '<span class="badge b-r">Suspensa</span>'}</td><td data-l="Segmento">${esc(t.segmentName)}</td><td data-l="Dono"><span class="mut">${esc(t.ownerEmail || '—')}</span></td>
        <td data-l="Plano"><select data-plan="${t.id}" aria-label="Plano">${Object.keys(meta.plans).map(p => `<option ${p === t.plan ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td data-l="Pedidos" class="n">${t.orders}</td><td data-l="Vendas" class="n price">${brl(t.revenue)}</td><td data-l=""><button class="ghost sm" data-act="${t.id}" data-on="${t.active ? 1 : 0}">${t.active ? 'Suspender' : 'Reativar'}</button></td></tr>`).join('')}</tbody></table></div></div>
    <form class="panel" id="fNew"><h3>Cadastrar empresa</h3><span class="mut">O modelo do segmento já cria categorias, produtos com opções, bairros e cupons iniciais.</span>
      <div class="segs">${Object.entries(meta.segments).map(([k, v]) => `<button type="button" data-seg="${k}" class="${seg === k ? 'on' : ''}">${art(v.icon, v.color).replace('<svg', '<svg width="56" height="32"')}${esc(v.name)}</button>`).join('')}</div>
      <div class="two" style="gap:10px"><label>Nome da empresa<input id="nN" required placeholder="Ex.: Sushi do Bairro"></label><label>Endereço da loja (opcional)<input id="nS" pattern="[a-z0-9-]+" placeholder="sushi-do-bairro"></label></div>
      <div class="two" style="gap:10px"><label>Nome do dono<input id="nO" required></label><label>E-mail do dono<input id="nE" type="email" required></label></div>
      <div class="two" style="gap:10px"><label>Senha inicial<input id="nP" type="password" minlength="8" required></label><label>Plano<select id="nPl">${Object.keys(meta.plans).map(p => `<option ${p === 'Pro' ? 'selected' : ''}>${p}</option>`).join('')}</select></label></div>
      <label>Cor da marca<input type="color" id="nC" value="${meta.segments[seg].color}"></label>
      <button class="pri">Criar empresa</button></form>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.seg) { seg = b.dataset.seg; document.querySelectorAll('[data-seg]').forEach(x => x.classList.toggle('on', x === b)); $('#nC').value = meta.segments[seg].color; }
    if (b.dataset.act) { await api(`/api/platform/tenants/${b.dataset.act}`, { method: 'PATCH', body: { active: b.dataset.on !== '1' } }); await draw(); }
  });
  app.onchange = attempt(async e => { if (e.target.dataset.plan) { await api(`/api/platform/tenants/${e.target.dataset.plan}`, { method: 'PATCH', body: { plan: e.target.value } }); toast('Plano alterado'); await draw(); } });
  app.onsubmit = attempt(async e => {
    e.preventDefault();
    const t = await api('/api/platform/tenants', { method: 'POST', body: { name: $('#nN').value, slug: $('#nS').value || undefined, segment: seg, color: $('#nC').value, plan: $('#nPl').value, owner: { name: $('#nO').value, email: $('#nE').value, password: $('#nP').value } } });
    toast(`Empresa criada: /loja/${t.slug}`); await draw();
  });
  cleanup = () => { app.onclick = app.onchange = app.onsubmit = null; };
  await draw();
}

render();
