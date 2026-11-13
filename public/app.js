// Frontend do Balcão sobre Supabase: loja pública, acompanhamento, cadastro, painel da empresa e painel da plataforma.
// JavaScript puro, sem build. A segurança está no banco (RLS + funções), não aqui.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = s => document.querySelector(s);
const app = $('#app');
const brl = c => ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toCents = v => { const n = Number(String(v).trim().replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const fromCents = c => ((c || 0) / 100).toFixed(2).replace('.', ',');
const mins = t => Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 60000));
const hhmm = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const SLABEL = { novo: 'Recebido', preparo: 'Em preparo', pronto: 'Pronto', rota: 'Saiu para entrega', entregue: 'Entregue', cancelado: 'Cancelado' };
const local = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

/* ---------- Supabase ---------- */
const configured = SUPABASE_URL && SUPABASE_ANON_KEY;
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const TR = [[/Invalid login credentials/i, 'E-mail ou senha incorretos'], [/Email not confirmed/i, 'Confirme seu e-mail pelo link que enviamos antes de entrar'],
  [/User already registered/i, 'Já existe uma conta com esse e-mail'], [/Password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres'],
  [/rate limit/i, 'Muitas tentativas. Aguarde um pouco.'], [/permission denied|row-level security/i, 'Sem permissão para essa ação'],
  [/duplicate key/i, 'Já existe um registro igual'], [/Failed to fetch|NetworkError/i, 'Sem conexão com o servidor']];
const tr = m => (TR.find(([re]) => re.test(m)) || [0, m])[1];
async function q(promise) { const { data, error } = await promise; if (error) throw new Error(tr(error.message || 'Erro')); return data; }
const rpc = (fn, args) => q(sb.rpc(fn, args));

/* ---------- interface ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); }
function dialog(html, wide = false) { $('#dlg').classList.toggle('wide', wide); $('#dlgBody').innerHTML = html; $('#dlg').classList.add('open'); $('#dlgBody').querySelector('input,select,button')?.focus(); }
function closeDlg() { $('#dlg').classList.remove('open'); $('#dlgBody').onclick = $('#dlgBody').onchange = $('#dlgBody').onsubmit = null; }
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') closeDlg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDlg(); });
const setColor = c => document.documentElement.style.setProperty('--red', c || '#d62828');
const attempt = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const sure = b => { if (b.dataset.sure) return true; b.dataset.sure = 1; b.textContent = 'Confirmar?'; return false; };

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

/* ---------- sessão ---------- */
let ME = null; // { user, isAdmin, memberships:[{role, tenant}], tenant, role }
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return (ME = null);
  const user = session.user;
  const [ms, adm] = await Promise.all([
    q(sb.from('memberships').select('role, tenant:tenants(*, seg:segment_templates(name, prep))').eq('user_id', user.id)),
    q(sb.from('platform_admins').select('user_id').eq('user_id', user.id))
  ]);
  const memberships = ms.filter(m => m.tenant);
  const pick = memberships.find(m => m.tenant.id === local.get('tenant')) || memberships[0];
  ME = { user, isAdmin: adm.length > 0, memberships, tenant: pick?.tenant || null, role: pick?.role || null };
  return ME;
}
function header(nav = '', who = true) {
  $('#nav').innerHTML = nav;
  const multi = ME?.memberships.length > 1 ? `<select id="pickT" aria-label="Empresa" style="width:auto;background:#ffffff26;color:#fff;border-color:#ffffff55">${ME.memberships.map(m => `<option value="${m.tenant.id}" ${m.tenant.id === ME.tenant?.id ? 'selected' : ''}>${esc(m.tenant.name)}</option>`).join('')}</select>` : '';
  $('#who').innerHTML = !who ? '' : ME ? `${multi}<span>${esc(ME.user.email)}</span><button class="sm" id="logout">Sair</button>` : `<a class="btn sm" style="background:#ffffff26;color:#fff" href="/entrar" data-link>Entrar</a>`;
  $('#logout')?.addEventListener('click', async () => { await sb.auth.signOut(); ME = null; go('/entrar'); });
  $('#pickT')?.addEventListener('change', e => { local.set('tenant', e.target.value); render(); });
}

async function render() {
  cleanup?.(); cleanup = null; closeDlg(); window.scrollTo(0, 0);
  if (!configured) return vSetup();
  const p = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (p[0] === 'loja' && p[1]) return await vShop(p[1]);
    if (p[0] === 'pedido' && p[1]) return await vTrack(p[1]);
    if (p[0] === 'entrar') return vAuth(p[1]);
    await loadMe();
    if (p[0] === 'comecar') { if (!ME) return go('/entrar/cadastro'); return await vStart(); }
    if (p[0] === 'painel') { if (!ME) return go('/entrar'); if (!ME.tenant) return go(ME.isAdmin ? '/plataforma' : '/comecar'); return await vPanel(p[1] || 'pedidos'); }
    if (p[0] === 'plataforma') { if (!ME?.isAdmin) return go('/entrar'); return await vPlatform(); }
    return vHome();
  } catch (e) { app.innerHTML = `<div class="panel auth"><h2>Ops</h2><p>${esc(e.message)}</p><a class="btn" href="/" data-link>Voltar ao início</a></div>`; }
}

function vSetup() {
  header('', false);
  app.innerHTML = `<div class="panel auth" style="max-width:640px"><h2>Falta configurar o Supabase</h2>
    <p>Edite <code>public/config.js</code> com a <b>Project URL</b> e a chave <b>anon public</b> do seu projeto (Supabase → Project Settings → API) e recarregue a página.</p>
    <p class="mut">O passo a passo completo está no README do repositório.</p></div>`;
}

/* ---------- início ---------- */
function vHome() {
  setColor('#d62828'); $('#bName').textContent = 'Balcão'; header();
  const dest = ME?.tenant ? '/painel' : ME?.isAdmin ? '/plataforma' : ME ? '/comecar' : '/entrar/cadastro';
  app.innerHTML = `<section class="hero"><div class="grid"><h1>Delivery próprio para qualquer negócio</h1>
    <p>Loja online com a sua marca, fila de preparo em tempo real, despacho de entregadores e relatórios — para pizzaria, hamburgueria, açaí, mercado, farmácia e o que mais vender por entrega.</p>
    <div class="row"><a class="btn pri" href="${dest}" data-link>${ME ? 'Ir para o painel' : 'Criar minha loja'}</a>${ME ? '' : '<a class="btn ghost" href="/entrar" data-link>Já tenho conta</a>'}</div></div>
    <div class="menu" style="grid-template-columns:repeat(2,minmax(0,1fr))">${['pizza', 'burger', 'cup', 'box'].map((i, k) => `<div class="item">${art(i, ['#d62828', '#e85d04', '#6a2c91', '#2f8f46'][k])}</div>`).join('')}</div></section>`;
}

/* ---------- entrar / criar conta / recuperar senha ---------- */
function vAuth(mode = 'login') {
  setColor('#d62828'); $('#bName').textContent = 'Balcão'; header('', false);
  const T = { login: ['Entrar', 'Acesso para empresas e para a administração da plataforma.', 'Entrar'], cadastro: ['Criar conta', 'Depois de criar a conta você monta sua loja em um minuto.', 'Criar conta'], senha: ['Recuperar senha', 'Enviaremos um link para você criar uma nova senha.', 'Enviar link'], nova: ['Nova senha', 'Digite a nova senha da sua conta.', 'Salvar senha'] }[mode];
  if (!T) return go('/entrar');
  app.innerHTML = `<form class="panel auth" id="fAuth"><h2>${T[0]}</h2><p class="mut">${T[1]}</p>
    ${mode !== 'nova' ? '<label>E-mail<input id="aE" type="email" required autocomplete="username"></label>' : ''}
    ${mode !== 'senha' ? `<label>Senha<input id="aP" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
    <button class="pri">${T[2]}</button>
    <p class="mut" style="margin:0">${mode === 'login' ? '<a href="/entrar/cadastro" data-link>Criar conta</a> · <a href="/entrar/senha" data-link>Esqueci a senha</a>' : '<a href="/entrar" data-link>Voltar para entrar</a>'}</p></form>`;
  $('#fAuth').onsubmit = attempt(async e => {
    e.preventDefault(); const email = $('#aE')?.value.trim(), password = $('#aP')?.value;
    if (mode === 'login') { await q(sb.auth.signInWithPassword({ email, password })); await loadMe(); go(ME?.tenant ? '/painel' : ME?.isAdmin ? '/plataforma' : '/comecar'); }
    if (mode === 'cadastro') {
      const r = await q(sb.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/comecar` } }));
      if (r.session) go('/comecar');
      else app.innerHTML = `<div class="panel auth"><h2>Confira seu e-mail</h2><p>Enviamos um link de confirmação para <b>${esc(email)}</b>. Depois de confirmar, você volta para cá e cria sua loja.</p></div>`;
    }
    if (mode === 'senha') { await q(sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/entrar/nova` })); toast('Se o e-mail existir, o link foi enviado'); }
    if (mode === 'nova') { await q(sb.auth.updateUser({ password })); toast('Senha alterada'); go('/painel'); }
  });
}

/* ---------- criar a loja (depois do cadastro) ---------- */
async function vStart() {
  setColor('#d62828'); $('#bName').textContent = 'Balcão'; header();
  const segs = await q(sb.from('segment_templates').select('segment, name, color, icon').order('sort'));
  let seg = segs[0].segment;
  app.innerHTML = `<form class="panel" id="fNew" style="max-width:760px;margin:0 auto"><h2>Crie sua loja</h2>
    <p class="mut">Escolha o tipo de negócio: já criamos categorias, produtos de exemplo com opções, bairros e cupons. Tudo pode ser editado depois.</p>
    <div class="segs">${segs.map(s => `<button type="button" data-seg="${s.segment}" class="${seg === s.segment ? 'on' : ''}">${art(s.icon, s.color).replace('<svg', '<svg width="56" height="32"')}${esc(s.name)}</button>`).join('')}</div>
    <div class="two" style="gap:10px"><label>Nome da empresa<input id="nN" required maxlength="80" placeholder="Ex.: Sushi do Bairro"></label>
    <label>Endereço da loja (opcional)<input id="nS" pattern="[a-z0-9][a-z0-9\\-]{1,39}" placeholder="sushi-do-bairro"></label></div>
    <label>Cor da marca<input type="color" id="nC" value="${segs[0].color}"></label>
    <button class="pri">Criar loja</button></form>`;
  app.onclick = e => { const b = e.target.closest('[data-seg]'); if (!b) return; seg = b.dataset.seg; document.querySelectorAll('[data-seg]').forEach(x => x.classList.toggle('on', x === b)); $('#nC').value = segs.find(s => s.segment === seg).color; };
  app.onsubmit = attempt(async e => {
    e.preventDefault();
    const t = await rpc('create_my_tenant', { p_name: $('#nN').value, p_segment: seg, p_slug: $('#nS').value || null, p_color: $('#nC').value });
    local.set('tenant', t.id); toast('Loja criada!'); go('/painel/config');
  });
  cleanup = () => { app.onclick = app.onsubmit = null; };
}

/* ================= LOJA PÚBLICA ================= */
const bySort = (a, b) => a.sort - b.sort || a.id - b.id;
const sortMenu = prods => prods.sort(bySort).map(p => ({ ...p,
  groups: (p.option_groups || []).sort(bySort).map(g => ({ ...g, options: (g.options || []).sort(bySort) })) }));
const MENU_COLS = 'id, category, name, description, price, icon, available, sort, option_groups(id, name, min_sel, max_sel, sort, options(id, name, price, sort))';

async function vShop(slug) {
  const S = (await q(sb.from('tenants').select('*, seg:segment_templates(name)').eq('slug', slug).limit(1)))[0];
  if (!S) throw new Error('Loja não encontrada');
  const [rawP, zones] = await Promise.all([
    q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)),
    q(sb.from('zones').select('id, name, fee').eq('tenant_id', S.id).order('name'))]);
  const products = sortMenu(rawP);
  setColor(S.color); $('#bName').textContent = S.name; header('', false); document.title = `${S.name} — pedido online`;
  const cartKey = `cart:${slug}`;
  let cart = local.get(cartKey, []).filter(c => products.some(p => p.id === c.productId)), cat = null, coupon = null;
  const cats = [...new Set(products.map(p => p.category))];
  const saveCart = () => local.set(cartKey, cart);
  const unitOf = (p, ids) => p.price + p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).reduce((t, o) => t + o.price, 0);
  const totals = () => {
    const sub = cart.reduce((t, c) => t + c.qty * c.unit, 0), pickup = $('#cMode')?.value === 'pickup';
    const z = zones.find(z => String(z.id) === $('#cZone')?.value) || zones[0];
    let fee = pickup || !z ? 0 : z.fee, disc = 0;
    if (coupon) { if (coupon.percent) disc = Math.round(sub * coupon.percent / 100); if (coupon.freeShipping) fee = 0; }
    return { sub, fee, disc, total: sub + fee - disc, pickup, zone: z };
  };
  const paint = () => {
    cat = cats.includes(cat) ? cat : cats[0];
    const list = products.filter(p => p.category === cat), count = cart.reduce((t, c) => t + c.qty, 0);
    app.innerHTML = `<h2>${esc(S.name)}</h2><p class="lead">${esc(S.seg?.name)} · ${S.is_open ? '<span class="badge b-g">Aberto agora</span>' : '<span class="badge b-r">Fechado</span>'} · entrega em ${esc(S.eta_text)}${S.min_order ? ` · pedido mínimo ${brl(S.min_order)}` : ''}${S.phone ? ` · ${esc(S.phone)}` : ''}</p>
    <div class="shop"><section>
      <div class="cats">${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="menu">${list.map(p => `<article class="item">${art(p.icon, S.color)}<div class="b"><h3>${esc(p.name)}</h3><span class="mut">${esc(p.description)}</span>
        <div class="foot"><span class="price">${p.groups.some(g => g.min_sel && g.options.some(o => o.price)) ? '<span class="mut">a partir de </span>' : ''}<b>${brl(p.price)}</b></span>
        <button class="pri sm" data-add="${p.id}" ${S.is_open ? '' : 'disabled'}>Adicionar</button></div></div></article>`).join('') || '<p class="empty">Cardápio vazio.</p>'}</div>
    </section>
    <aside class="cart" aria-label="Carrinho"><h3>Seu pedido</h3>
      ${cart.length ? cart.map((x, i) => `<div class="ci"><div><b>${x.qty}× ${esc(x.name)}</b>${x.optText ? `<br><span class="mut">${esc(x.optText)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}<br><button class="ghost sm" data-dec="${i}" aria-label="Diminuir">−</button> <button class="ghost sm" data-inc="${i}" aria-label="Aumentar">+</button></div><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('') : '<p class="empty">Carrinho vazio.</p>'}
      <label>Como receber<select id="cMode"><option value="delivery">Entrega</option>${S.allow_pickup ? '<option value="pickup">Retirar na loja</option>' : ''}</select></label>
      <label id="zWrap">Bairro<select id="cZone">${zones.map(z => `<option value="${z.id}">${esc(z.name)} · ${z.fee ? brl(z.fee) : 'grátis'}</option>`).join('')}</select></label>
      <label>Cupom<span class="row" style="flex-wrap:nowrap"><input id="cCup" placeholder="Ex.: PRIMEIRA10" value="${esc(coupon?.code || '')}"><button class="ghost" id="cupBtn">Aplicar</button></span></label>
      <div id="tots"></div><button class="pri" id="checkout">Finalizar pedido</button></aside></div>
    ${count ? `<button class="pri cartbar" id="toCart">Ver carrinho · ${count} ${count > 1 ? 'itens' : 'item'} · ${brl(cart.reduce((t, c) => t + c.qty * c.unit, 0))}</button>` : ''}`;
    paintTotals();
  };
  const paintTotals = () => {
    const t = totals(), low = S.min_order && t.sub < S.min_order; $('#zWrap').hidden = t.pickup;
    $('#tots').innerHTML = `<div class="ci"><span>Subtotal</span><span class="price">${brl(t.sub)}</span></div><div class="ci"><span>Entrega</span><span class="price">${t.fee ? brl(t.fee) : 'Grátis'}</span></div>${t.disc ? `<div class="ci"><span>Desconto</span><span class="price">−${brl(t.disc)}</span></div>` : ''}<div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>${low && cart.length ? `<span class="badge b-a">Faltam ${brl(S.min_order - t.sub)} para o pedido mínimo</span>` : ''}`;
    $('#checkout').disabled = !cart.length || low || !S.is_open || (!t.pickup && !zones.length);
  };
  const addToCart = it => { const ex = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); ex ? ex.qty += it.qty : cart.push(it); saveCart(); toast('Adicionado ao carrinho'); paint(); };
  const builder = p => {
    if (!p.groups.length) return addToCart({ productId: p.id, name: p.name, optionIds: [], optText: '', unit: p.price, qty: 1, notes: '' });
    const sel = p.groups.map(g => g.options.slice(0, g.min_sel).map(o => o.id));
    let qty = 1, notes = '';
    const draw = () => {
      dialog(`<h2>${esc(p.name)}</h2><span class="mut">${esc(p.description)}</span>
      ${p.groups.map((g, i) => `<div class="grp"><h3><span>${esc(g.name)}</span><span class="badge ${g.min_sel ? 'b-a' : ''}">${g.min_sel ? (g.min_sel === g.max_sel ? `Escolha ${g.min_sel}` : `Mín. ${g.min_sel}, máx. ${g.max_sel}`) : g.max_sel > 1 ? `Até ${g.max_sel}` : 'Opcional'}</span></h3>
        <div class="opts">${g.options.map(o => `<button data-g="${i}" data-o="${o.id}" class="${sel[i].includes(o.id) ? 'on' : ''}" aria-pressed="${sel[i].includes(o.id)}">${esc(o.name)}${o.price ? ' +' + brl(o.price) : ''}</button>`).join('')}</div></div>`).join('')}
      <label>Observação<input id="bObs" value="${esc(notes)}" maxlength="140" placeholder="Ex.: sem cebola"></label>
      <div class="row between"><span class="row"><button class="ghost sm" data-q="-1" aria-label="Menos">−</button><b>${qty}</b><button class="ghost sm" data-q="1" aria-label="Mais">+</button></span><span class="tot price">${brl(unitOf(p, sel.flat()) * qty)}</span></div>
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
          const ids = sel.flat().sort((a, b) => a - b), names = p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).map(o => o.name);
          closeDlg(); addToCart({ productId: p.id, name: p.name, optionIds: ids, optText: names.join(', '), unit: unitOf(p, ids), qty, notes: notes.trim() });
        }
      };
    };
    draw();
  };
  const checkout = () => {
    const t = totals(), last = local.get('customer', {});
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
        const r = await rpc('place_order', { p_slug: slug, p: {
          customer, fulfillment: t.pickup ? 'pickup' : 'delivery', zoneId: t.zone?.id, address: $('#kA')?.value, payment: $('#kPay').value,
          changeFor: $('#kT').value ? toCents($('#kT').value) : undefined, coupon: coupon?.code,
          items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: c.notes })) } });
        local.set('customer', { ...customer, address: $('#kA')?.value || last.address });
        cart = []; saveCart(); closeDlg(); go(`/pedido/${r.code}`);
      } finally { const b = $('#kGo'); if (b) b.disabled = false; }
    });
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.cat) { cat = d.cat; paint(); }
    else if (d.add) builder(products.find(p => p.id === +d.add));
    else if (d.inc) { cart[d.inc].qty++; saveCart(); paint(); }
    else if (d.dec) { if (!--cart[d.dec].qty) cart.splice(d.dec, 1); saveCart(); paint(); }
    else if (b.id === 'cupBtn') {
      const code = $('#cCup').value.trim(); coupon = null;
      if (code) { coupon = await rpc('check_coupon', { p_slug: slug, p_code: code }); toast(coupon ? 'Cupom aplicado' : 'Cupom inválido'); }
      paintTotals();
    }
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
    const r = await rpc('track_order', { p_code: code });
    if (!r) throw new Error('Pedido não encontrado');
    const { store: S, order: o } = r;
    setColor(S.color); $('#bName').textContent = S.name; header('', false);
    const flow = o.fulfillment === 'pickup' ? ['novo', 'preparo', 'pronto', 'entregue'] : ['novo', 'preparo', 'pronto', 'rota', 'entregue'];
    const idx = flow.indexOf(o.status), at = Object.fromEntries(o.events.map(e => [e.status, e.at]));
    app.innerHTML = `<h2>Pedido #${o.number}</h2><p class="lead">Olá, ${esc(o.customerName)}! Esta página atualiza sozinha.</p>
    <div class="panel" style="max-width:760px">
      ${o.status === 'cancelado' ? `<span class="badge b-r">Pedido cancelado pela loja.${S.phone ? ' Contato: ' + esc(S.phone) : ''}</span>` :
      `<div class="steps">${flow.map((s, i) => `<span class="${i <= idx ? 'on' : ''}">${s === 'pronto' && o.fulfillment === 'pickup' ? 'Pronto p/ retirar' : SLABEL[s]}${at[s] ? `<br><small>${hhmm(at[s])}</small>` : ''}</span>`).join('')}</div>`}
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
  const S = ME.tenant, owner = ME.role === 'owner';
  setColor(S.color); $('#bName').textContent = S.name;
  const tabs = [['pedidos', S.seg?.prep || 'Preparo'], ['entregas', 'Entregas'], ['cardapio', 'Cardápio'], ...(owner ? [['relatorios', 'Relatórios'], ['config', 'Configurações']] : [])];
  if (!tabs.some(t => t[0] === tab)) tab = 'pedidos';
  header(tabs.map(([k, n]) => `<a href="/painel/${k}" data-link class="${k === tab ? 'on' : ''}">${esc(n)}</a>`).join('') + `<a href="/loja/${S.slug}" target="_blank" rel="noopener">Ver loja ↗</a>` + (ME.isAdmin ? '<a href="/plataforma" data-link>Plataforma</a>' : ''));
  await ({ pedidos: pOrders, entregas: pDelivery, cardapio: pMenu, relatorios: pReports, config: pConfig })[tab](S, owner);
}

const ORDER_COLS = '*, items:order_items(product_name, options_text, qty, unit_price, notes), courier:couriers(name)';
const fetchOrders = (tid, statuses) => q(sb.from('orders').select(ORDER_COLS).eq('tenant_id', tid).in('status', statuses).order('created_at'));

// Tempo real: o Supabase avisa quando um pedido da empresa é criado ou muda de status.
function live(tid, onChange) {
  const ch = sb.channel(`orders-${tid}`).on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `tenant_id=eq.${tid}` }, p => onChange(p)).subscribe();
  const tick = setInterval(() => onChange(null), 30000);
  return () => { sb.removeChannel(ch); clearInterval(tick); };
}
function beep() { try { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = 880; g.gain.value = .15; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + .35); } catch {} }
const itemsList = o => `<ul>${o.items.map(x => `<li>${x.qty}× ${esc(x.product_name)}${x.options_text ? ` <span class="mut">(${esc(x.options_text)})</span>` : ''}${x.notes ? ` <b>— ${esc(x.notes)}</b>` : ''}</li>`).join('')}</ul>`;
const setStatus = (id, status, courier) => rpc('change_order_status', { p_order: id, p_status: status, p_courier: courier ?? null });

async function pOrders(S) {
  let orders = [];
  const load = async () => { orders = await fetchOrders(S.id, ['novo', 'preparo', 'pronto']); draw(); };
  const draw = () => {
    const cols = [['novo', 'Novos', 'Aceitar', 'preparo'], ['preparo', 'Em preparo', 'Marcar pronto', 'pronto'], ['pronto', 'Prontos', '', '']];
    app.innerHTML = `<h2>${esc(S.seg?.prep || 'Preparo')}</h2><p class="lead">Pedidos chegam aqui na hora, com aviso sonoro. Tickets com mais de 25 min ficam em alerta.</p>
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
    if (b.dataset.st === 'cancelado' && !sure(b)) return;
    await setStatus(+b.dataset.id, b.dataset.st); await load();
  });
  const stop = live(S.id, p => { if (p?.eventType === 'INSERT') { beep(); toast(`Novo pedido #${p.new.number}`); } load().catch(() => {}); });
  cleanup = () => { stop(); app.onclick = null; };
  await load();
}

async function pDelivery(S) {
  let ready = [], route = [], couriers = [];
  const load = async () => {
    [ready, route, couriers] = await Promise.all([fetchOrders(S.id, ['pronto']), fetchOrders(S.id, ['rota']), q(sb.from('couriers').select('*').eq('tenant_id', S.id).order('id'))]);
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
      ${route.map(o => `<div class="tk go"><div class="top"><span>#${o.number} · ${esc(o.courier?.name || '—')}</span><span class="price">${mins(o.updated_at)} min</span></div><span class="mut">${esc(o.address)} — ${esc(o.zone_name)} · ${esc(o.payment)}</span><button class="ok sm" data-st="entregue" data-id="${o.id}">Confirmar entrega</button></div>`).join('') || '<p class="empty">Ninguém na rua agora</p>'}
      <h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td>${route.some(o => o.courier_id === c.id) ? '<span class="badge b-a">Em rota</span>' : c.active ? '<span class="badge b-g">Disponível</span>' : '<span class="badge">Folga</span>'}</td><td class="n"><button class="ghost sm" data-cour="${c.id}">${c.active ? 'Dar folga' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Cadastre entregadores em Configurações.</td></tr>'}</tbody></table>
    </div></div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.st) await setStatus(+b.dataset.id, b.dataset.st, b.dataset.st === 'rota' ? +$('#c' + b.dataset.id).value : null);
    if (b.dataset.cour) { const c = couriers.find(x => x.id === +b.dataset.cour); await q(sb.from('couriers').update({ active: !c.active }).eq('id', c.id)); }
    await load();
  });
  const stop = live(S.id, () => load().catch(() => {}));
  cleanup = () => { stop(); app.onclick = null; };
  await load();
}

/* ---------- cardápio + editor de grupos de opções ---------- */
async function pMenu(S, owner) {
  let prods = [];
  const load = async () => { prods = sortMenu(await q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id))); draw(); };
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
      <div class="two" style="gap:10px"><label>Preço base (R$)<input id="eP" inputmode="decimal" required value="${fromCents(st.price)}"></label><label>Ilustração<select id="eI">${ICONS.map(i => `<option ${i === st.icon ? 'selected' : ''}>${i}</option>`).join('')}</select></label></div>
      <div class="row between"><h3>Grupos de opções</h3><button type="button" class="ghost sm" id="addG">+ Grupo</button></div>
      <p class="mut" style="margin:0">Mínimo 0 = opcional. Mínimo 1 e máximo 1 = escolha obrigatória de uma opção (ex.: tamanho). Máximo maior que 1 = várias escolhas (ex.: adicionais). O preço da opção soma ao preço base.</p>
      ${st.groups.map((g, i) => `<div class="ged"><div class="g3"><label>Nome do grupo<input id="gN${i}" value="${esc(g.name)}" placeholder="Ex.: Tamanho"></label><label>Mínimo<input id="gMin${i}" type="number" min="0" value="${g.min_sel}"></label><label>Máximo<input id="gMax${i}" type="number" min="1" value="${g.max_sel}"></label><button type="button" class="ghost sm" data-rg="${i}">Remover</button></div>
        ${g.options.map((o, k) => `<div class="o2"><input id="o${i}_${k}" value="${esc(o.name)}" placeholder="Opção" aria-label="Nome da opção"><input id="op${i}_${k}" inputmode="decimal" value="${fromCents(o.price)}" aria-label="Preço adicional"><button type="button" class="ghost sm" data-ro="${i}_${k}" aria-label="Remover opção">×</button></div>`).join('')}
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
      else if (b.id === 'delP') { if (!sure(b)) return; await q(sb.from('products').delete().eq('id', p.id)); closeDlg(); toast('Produto excluído'); await load(); }
    });
    $('#dlgBody').onsubmit = attempt(async e => {
      e.preventDefault(); readForm();
      if (!Number.isInteger(st.price) || st.price < 0) throw new Error('Preço base inválido');
      if (st.groups.some(g => g.options.some(o => !Number.isInteger(o.price) || o.price < 0))) throw new Error('Preço de opção inválido');
      const body = { category: st.category, name: st.name, description: st.description, price: st.price, icon: st.icon, available: st.available,
        groups: st.groups.map(g => ({ name: g.name, min_sel: g.min_sel, max_sel: g.max_sel, options: g.options.filter(o => o.name.trim()).map(o => ({ name: o.name, price: o.price })) })) };
      await rpc('save_product', { p_tenant: S.id, p_id: p?.id ?? null, p: body });
      closeDlg(); toast('Produto salvo'); await load();
    });
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'newP') editor(null);
    if (b.dataset.ed) editor(prods.find(p => p.id === +b.dataset.ed));
    if (b.dataset.av) { const p = prods.find(x => x.id === +b.dataset.av); await rpc('set_product_availability', { p_product: p.id, p_available: !p.available }); await load(); }
  });
  cleanup = () => { app.onclick = null; };
  await load();
}

/* ---------- relatórios ---------- */
async function pReports(S) {
  let days = 7;
  const draw = async () => {
    const r = await rpc('store_report', { p_tenant: S.id, p_days: days });
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
  const plans = await q(sb.from('plans').select('*').order('sort'));
  const draw = async () => {
    const [st, zones, coupons, couriers, team, nOrders] = await Promise.all([
      q(sb.from('tenants').select('*').eq('id', S.id).single()), q(sb.from('zones').select('*').eq('tenant_id', S.id).order('id')),
      q(sb.from('coupons').select('*').eq('tenant_id', S.id).order('id')), q(sb.from('couriers').select('*').eq('tenant_id', S.id).order('id')),
      rpc('list_team', { p_tenant: S.id }), sb.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', S.id).then(r => r.count || 0)]);
    const link = `${location.origin}/loja/${st.slug}`;
    app.innerHTML = `<h2>Configurações</h2><p class="lead">Endereço da sua loja: <a href="${link}" target="_blank" rel="noopener">${esc(link)}</a> <button class="ghost sm" id="copy">Copiar</button></p>
    ${nOrders ? '' : '<div class="panel" style="margin-bottom:20px"><h3>Quer ver o sistema funcionando?</h3><p class="mut" style="margin:0">Gere pedidos de exemplo para testar a fila, as entregas e os relatórios.</p><button class="ok" id="demo">Gerar 12 pedidos de exemplo</button></div>'}
    <div class="two"><form class="panel" id="fStore"><h3>Loja</h3>
      <label>Nome<input id="sN" required maxlength="80" value="${esc(st.name)}"></label>
      <div class="two" style="gap:10px"><label>Telefone<input id="sPh" maxlength="30" value="${esc(st.phone)}"></label><label>Prazo de entrega<input id="sEta" maxlength="40" value="${esc(st.eta_text)}"></label></div>
      <div class="two" style="gap:10px"><label>Pedido mínimo (R$)<input id="sMin" inputmode="decimal" value="${fromCents(st.min_order)}"></label><label>Cor da marca<input type="color" id="sC" value="${st.color}"></label></div>
      <label class="chk"><input type="checkbox" id="sOpen" ${st.is_open ? 'checked' : ''}> Loja aberta para pedidos</label>
      <label class="chk"><input type="checkbox" id="sPick" ${st.allow_pickup ? 'checked' : ''}> Aceitar retirada na loja</label>
      <button class="pri">Salvar loja</button></form>
    <div class="panel"><h3>Bairros e taxas</h3><table><tbody>${zones.map(z => `<tr><td>${esc(z.name)}</td><td class="n" style="width:120px"><input inputmode="decimal" value="${fromCents(z.fee)}" data-zone="${z.id}" aria-label="Taxa ${esc(z.name)}"></td><td class="n"><button class="ghost sm" data-del="zones:${z.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fZone" class="row" style="flex-wrap:nowrap"><input id="zN" placeholder="Bairro" required maxlength="60"><input id="zF" inputmode="decimal" placeholder="Taxa" style="width:100px" required><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Cupons</h3><table><tbody>${coupons.map(c => `<tr><td><b>${esc(c.code)}</b><br><span class="mut">${[c.percent ? c.percent + '% de desconto' : '', c.free_shipping ? 'frete grátis' : ''].filter(Boolean).join(' + ')}</span></td><td class="n"><button class="sm ${c.active ? 'ok' : 'ghost'}" data-cup="${c.id}" data-on="${c.active ? 1 : 0}">${c.active ? 'Ativo' : 'Pausado'}</button> <button class="ghost sm" data-del="coupons:${c.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fCup" class="row"><input id="cuC" placeholder="CÓDIGO" required pattern="[A-Za-z0-9]{2,20}" style="flex:1"><input id="cuP" type="number" min="0" max="90" placeholder="%" style="width:80px"><label class="chk"><input type="checkbox" id="cuF"> Frete grátis</label><button class="ghost">Criar</button></form></div>
    <div class="panel"><h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td class="n"><button class="ghost sm" data-del="couriers:${c.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fCour" class="row" style="flex-wrap:nowrap"><input id="crN" placeholder="Nome" required maxlength="60"><input id="crP" placeholder="Telefone"><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Equipe</h3><table><tbody>${team.map(u => `<tr><td>${esc(u.email)}</td><td>${u.role === 'owner' ? 'Dono' : 'Atendente'}</td><td class="n">${u.role === 'staff' ? `<button class="ghost sm" data-staff="${u.user_id}" aria-label="Remover">×</button>` : ''}</td></tr>`).join('')}</tbody></table>
      <form id="fTeam" class="row" style="flex-wrap:nowrap"><input id="tE" type="email" placeholder="E-mail do atendente" required><button class="ghost">Adicionar</button></form>
      <p class="mut" style="margin:0">O atendente precisa criar uma conta em /entrar/cadastro antes. Ele opera pedidos, entregas e disponibilidade do cardápio, sem acesso a relatórios e configurações.</p></div>
    <div class="panel"><h3>Assinatura</h3><div class="plans">${plans.map(p => `<div class="plan ${st.plan === p.name ? 'on' : ''}"><b>${esc(p.name)}</b><span class="price"><b>${brl(p.price)}</b>/mês</span><span class="mut">${esc(p.features)}</span>${st.plan === p.name ? '<span class="badge b-g">Plano atual</span>' : `<button class="ghost sm" data-plan="${esc(p.name)}">Mudar</button>`}</div>`).join('')}</div></div></div>`;
  };
  const refreshBrand = async () => { await loadMe(); setColor(ME.tenant.color); $('#bName').textContent = ME.tenant.name; };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b || b.type === 'submit') return;
    if (b.id === 'copy') { try { await navigator.clipboard.writeText(`${location.origin}/loja/${S.slug}`); toast('Link copiado'); } catch { toast('Copie o link manualmente'); } return; }
    if (b.id === 'demo') { b.disabled = true; await rpc('generate_demo_orders', { p_tenant: S.id, p_count: 12 }); toast('Pedidos de exemplo criados'); }
    if (b.dataset.del) { if (!sure(b)) return; const [t, id] = b.dataset.del.split(':'); await q(sb.from(t).delete().eq('id', +id)); }
    if (b.dataset.staff) { if (!sure(b)) return; await rpc('remove_staff', { p_tenant: S.id, p_user: b.dataset.staff }); }
    if (b.dataset.cup) await q(sb.from('coupons').update({ active: b.dataset.on !== '1' }).eq('id', +b.dataset.cup));
    if (b.dataset.plan) { await rpc('change_plan', { p_tenant: S.id, p_plan: b.dataset.plan }); toast('Plano alterado'); }
    await draw();
  });
  app.onchange = attempt(async e => {
    if (!e.target.dataset.zone) return;
    const fee = toCents(e.target.value); if (!Number.isInteger(fee) || fee < 0) throw new Error('Taxa inválida');
    await q(sb.from('zones').update({ fee }).eq('id', +e.target.dataset.zone)); toast('Taxa atualizada');
  });
  app.onsubmit = attempt(async e => {
    e.preventDefault(); const id = e.target.id;
    if (id === 'fStore') {
      const min_order = toCents($('#sMin').value || '0'); if (!Number.isInteger(min_order) || min_order < 0) throw new Error('Pedido mínimo inválido');
      await q(sb.from('tenants').update({ name: $('#sN').value.trim(), phone: $('#sPh').value.trim(), eta_text: $('#sEta').value.trim(), min_order, color: $('#sC').value, is_open: $('#sOpen').checked, allow_pickup: $('#sPick').checked }).eq('id', S.id));
      await refreshBrand();
    }
    if (id === 'fZone') { const fee = toCents($('#zF').value); if (!Number.isInteger(fee) || fee < 0) throw new Error('Taxa inválida'); await q(sb.from('zones').insert({ tenant_id: S.id, name: $('#zN').value.trim(), fee })); }
    if (id === 'fCup') await q(sb.from('coupons').insert({ tenant_id: S.id, code: $('#cuC').value.trim().toUpperCase(), percent: +$('#cuP').value || 0, free_shipping: $('#cuF').checked }));
    if (id === 'fCour') await q(sb.from('couriers').insert({ tenant_id: S.id, name: $('#crN').value.trim(), phone: $('#crP').value.trim() }));
    if (id === 'fTeam') await rpc('add_staff', { p_tenant: S.id, p_email: $('#tE').value });
    toast('Salvo'); await draw();
  });
  cleanup = () => { app.onclick = app.onchange = app.onsubmit = null; };
  await draw();
}

/* ================= PLATAFORMA ================= */
async function vPlatform() {
  setColor('#1d1716'); $('#bName').textContent = 'Balcão';
  header('<a class="on" href="/plataforma" data-link>Plataforma</a>' + (ME.tenant ? '<a href="/painel" data-link>Minha loja</a>' : ''));
  const plans = await q(sb.from('plans').select('name').order('sort'));
  const draw = async () => {
    const o = await rpc('platform_overview');
    app.innerHTML = `<h2>Plataforma</h2><p class="lead">Todas as empresas assinantes. Novas empresas se cadastram sozinhas em <a href="/entrar/cadastro" data-link>/entrar/cadastro</a>.</p>
    <div class="kpis"><div class="kpi"><span class="mut">Empresas</span><b>${o.tenants.length}</b><span class="mut">${o.tenants.filter(t => !t.active).length} suspensa(s)</span></div><div class="kpi"><span class="mut">Receita mensal (MRR)</span><b class="price">${brl(o.mrr)}</b></div>
      <div class="kpi"><span class="mut">Vendido pelas lojas</span><b class="price">${brl(o.gmv)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${o.orders}</b></div></div>
    <div class="panel"><h3>Empresas</h3><div class="scroll"><table class="stack"><thead><tr><th>Empresa</th><th>Segmento</th><th>Dono</th><th>Plano</th><th class="n">Pedidos</th><th class="n">Vendas</th><th></th></tr></thead><tbody>
      ${o.tenants.map(t => `<tr><td data-l="Empresa"><span class="dot" style="background:${esc(t.color)}"></span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a> ${t.active ? '' : '<span class="badge b-r">Suspensa</span>'}</td><td data-l="Segmento">${esc(t.segmentName)}</td><td data-l="Dono"><span class="mut">${esc(t.ownerEmail || '—')}</span></td>
        <td data-l="Plano"><select data-plan="${t.id}" aria-label="Plano">${plans.map(p => `<option ${p.name === t.plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>
        <td data-l="Pedidos" class="n">${t.orders}</td><td data-l="Vendas" class="n price">${brl(t.revenue)}</td><td data-l=""><button class="ghost sm" data-act="${t.id}" data-on="${t.active ? 1 : 0}">${t.active ? 'Suspender' : 'Reativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Nenhuma empresa ainda.</td></tr>'}</tbody></table></div></div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    if (b.dataset.on === '1' && !sure(b)) return;
    await rpc('platform_update_tenant', { p_tenant: b.dataset.act, p_plan: null, p_active: b.dataset.on !== '1' }); await draw();
  });
  app.onchange = attempt(async e => { if (e.target.dataset.plan) { await rpc('platform_update_tenant', { p_tenant: e.target.dataset.plan, p_plan: e.target.value, p_active: null }); toast('Plano alterado'); await draw(); } });
  cleanup = () => { app.onclick = app.onchange = null; };
  await draw();
}

if (sb) sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') go('/entrar/nova'); });
render();
