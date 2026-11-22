// Frontend do Balcão sobre Supabase: loja pública, acompanhamento, cadastro, painel da empresa e painel da plataforma.
// JavaScript puro, sem build. A segurança está no banco (RLS + funções), não aqui.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, PLATFORM as P0 } from './config.js';
import { termsHtml, privacyHtml, LEGAL_VERSION } from './legal.js';
const PLATFORM = { name: 'Balcão', company: '', cnpj: '', email: '', city: '', ...(P0 || {}) };

const $ = s => document.querySelector(s);
const app = $('#app');
const brl = c => ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toCents = v => { const n = Number(String(v).trim().replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
// Célula de planilha: texto que começa com = + - @ vira texto puro (evita fórmula maliciosa vinda de um nome de cliente).
const csvCell = x => { let v = String(x ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
const fromCents = c => ((c || 0) / 100).toFixed(2).replace('.', ',');
const mins = t => Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 60000));
const hhmm = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const CHANNEL = { online: 'Site', balcao: 'Balcão', telefone: 'Telefone', mesa: 'Mesa', totem: 'Totem' };
const FUL = { delivery: 'Entrega', pickup: 'Retirada', table: 'Mesa' };
const where = o => o.fulfillment === 'table' ? `Mesa ${o.table_label || ''}` : o.fulfillment === 'pickup' ? 'Retirada' : `Entrega · ${o.zone_name}`;
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
  [/duplicate key/i, 'Já existe um registro igual'],
  [/Could not find the (function|table)|schema cache|column .* does not exist|relation .* does not exist/i, 'O banco de dados está desatualizado: falta rodar migrações no Supabase. O administrador vê quais na tela Plataforma.'], [/Failed to fetch|NetworkError/i, 'Sem conexão com o servidor']];
const tr = m => (TR.find(([re]) => re.test(m)) || [0, m])[1];
async function q(promise) { const { data, error } = await promise; if (error) throw new Error(tr(error.message || 'Erro')); return data; }
const rpc = (fn, args) => q(sb.rpc(fn, args));
// Edge Function de assinatura da plataforma (Mercado Pago)
async function billingCall(body) {
  const { data, error } = await sb.functions.invoke('billing', { body });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch {} throw new Error(/Failed to send|fetch/i.test(m) ? 'Não foi possível falar com o serviço de assinatura. Tente de novo.' : m); }
  return data;
}
// Mesmo cálculo do banco (billing_ok): teste grátis válido, assinatura em dia (+3 dias de carência) ou liberada.
function billingOk(t) {
  if (!t.billing_status) return true; // migração de assinatura ainda não aplicada
  if (t.billing_status === 'free') return true;
  if (t.billing_status === 'trial') return new Date(t.trial_ends_at) > Date.now();
  return new Date(t.paid_until || t.trial_ends_at).getTime() + 3 * 864e5 > Date.now();
}
const daysUntil = d => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 864e5));
// Edge Function do Pix (Mercado Pago)
async function pixCall(body) {
  const { data, error } = await sb.functions.invoke('pix', { body });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch {} throw new Error(/Failed to send|fetch/i.test(m) ? 'Não foi possível falar com o serviço de Pix. Tente de novo.' : m); }
  return data;
}

/* ---------- interface ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); }
function dialog(html, wide = false) { $('#dlg').classList.toggle('wide', wide); $('#dlgBody').innerHTML = html; $('#dlg').classList.add('open'); $('#dlgBody').querySelector('input,select,button')?.focus(); }
function closeDlg() { $('#dlg').classList.remove('open'); $('#dlgBody').onclick = $('#dlgBody').onchange = $('#dlgBody').onsubmit = null; }
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg' || e.target.closest('[data-close]')) closeDlg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDlg(); });
const setColor = c => { document.documentElement.style.setProperty('--red', c || '#d62828'); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c || '#d62828'); };

/* ---------- app instalável (PWA) ---------- */
// Na página de uma loja, o app instalado abre direto nela, com o nome e a cor da loja.
// Cabeçalho: nome e, se a loja tiver, o logotipo no lugar do ícone padrão
function brand(name, logo) {
  $('#bName').textContent = name;
  const img = $('#bLogo'), ic = $('#bIcon'); if (!img) return;
  if (logo) { if (img.getAttribute('src') !== imgUrl(logo)) img.src = imgUrl(logo); img.alt = `Logotipo de ${name}`; img.hidden = false; ic.style.display = 'none'; }
  else { img.hidden = true; img.removeAttribute('src'); ic.style.display = ''; }
}
function setManifest(store) {
  const link = $('#manifest'); if (!link) return;
  if (!store) { link.href = '/manifest.webmanifest'; return; }
  const abs = p => new URL(p, location.origin).href;
  const m = { name: store.name, short_name: store.name.slice(0, 12), lang: 'pt-BR', start_url: abs(`/loja/${store.slug}`), scope: abs('/'), display: 'standalone',
    background_color: '#ffffff', theme_color: store.color || '#d62828',
    icons: [{ src: abs('/icons/icon-192.png'), sizes: '192x192', type: 'image/png' }, { src: abs('/icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: abs('/icons/maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
  link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(m));
}
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
addEventListener('appinstalled', () => { installEvt = null; $('#installBtn').hidden = true; toast('App instalado!'); });
$('#installBtn')?.addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true; });
{ const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone; if ($('#iosHint')) $('#iosHint').hidden = !ios; }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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

/* ---------- fotos ---------- */
const BUCKET = 'product-images';
const imgUrl = path => path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` : '';
const picture = (p, color) => p.image_path ? `<img src="${esc(imgUrl(p.image_path))}" alt="${esc(p.name)}" loading="lazy">` : art(p.icon, color);
// Reduz a foto no navegador (máx. 900 px, JPEG) antes de enviar: carrega rápido no celular do cliente.
async function shrinkImage(file, max = 900, type = 'image/jpeg') {
  if (!/^image\//.test(file.type)) throw new Error('Escolha um arquivo de imagem');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('Não foi possível ler a imagem')), type, .82));
}

/* ---------- horário de funcionamento ---------- */
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), min: (+parts.hour % 24) * 60 + +parts.minute };
}
// Mesmo cálculo do banco (store_open_at), só para mostrar "Aberto" / "Abre às…". Quem decide de verdade é o banco.
function openState(t) {
  if (!billingOk(t)) return { open: false, label: 'Temporariamente indisponível' };
  if (!t.is_open) return { open: false, label: 'Pausada no momento' };
  if (t.paused_until && new Date(t.paused_until) > Date.now()) return { open: false, label: `Pausada até as ${hhmm(t.paused_until)}` };
  if (closedOn(t, new Date())) return { open: false, label: `Fechada hoje${closedNote(t, new Date()) ? ' · ' + closedNote(t, new Date()) : ''}` };
  if (!t.auto_hours) return { open: true, label: '' };
  const { dow, min } = localNow(t.timezone), H = t.hours || {};
  const ranges = d => (H[String((d + 7) % 7)] || []).map(([o, c]) => [toMin(o), toMin(c)]);
  for (const [o, c] of ranges(dow)) if ((c > o && min >= o && min < c) || (c < o && min >= o)) return { open: true, label: `até ${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}` };
  for (const [o, c] of ranges(dow - 1)) if (c < o && min < c) return { open: true, label: `até ${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}` };
  for (let i = 0; i < 7; i++) {
    const next = ranges(dow + i).map(r => r[0]).filter(o => i > 0 || o > min).sort((a, b) => a - b)[0];
    if (next != null) return { open: false, label: `Abre ${i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DAYS[(dow + i) % 7].toLowerCase()} às ${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}` };
  }
  return { open: false, label: 'Fechada' };
}

// Fechamentos especiais (feriados): datas YYYY-MM-DD no fuso da loja
const ymdIn = (tz, at) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const closedOn = (t, at) => (t.closed_dates || []).some(d => d.date === ymdIn(t.timezone, at));
const closedNote = (t, at) => (t.closed_dates || []).find(d => d.date === ymdIn(t.timezone, at))?.note || '';
const deliveryPaused = t => t.delivery_paused_until && new Date(t.delivery_paused_until) > Date.now();

/* ---------- agendamento ---------- */
// diferença (min) entre o horário local da loja e UTC num instante
function tzOffsetMin(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - date.getTime()) / 60000;
}
const localToUtc = (tz, y, m, d, minOfDay) => { const guess = Date.UTC(y, m - 1, d, 0, minOfDay); return new Date(guess - tzOffsetMin(tz, new Date(guess)) * 60000); };
const fmtWhen = (iso, tz) => new Date(iso).toLocaleString('pt-BR', { timeZone: tz || 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hhmmTz = (iso, tz) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: tz || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
// Horários possíveis para agendar (mesma regra do banco: antecedência, limite de dias e faixas de funcionamento)
function scheduleSlots(S) {
  const tz = S.timezone || 'America/Sao_Paulo', step = S.schedule_slot_minutes || 30, minAt = Date.now() + (S.schedule_lead_minutes || 60) * 60000;
  const maxAt = Date.now() + (S.schedule_days || 3) * 864e5, out = [];
  for (let i = 0; i <= (S.schedule_days || 3); i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(Date.now() + i * 864e5)).map(x => [x.type, x.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    const ranges = S.auto_hours ? ((S.hours || {})[dow] || []).map(([o, c]) => [toMin(o), toMin(c) <= toMin(o) ? 1440 : toMin(c)]) : [[8 * 60, 23 * 60]];
    const slots = [];
    for (const [o, c] of ranges) for (let m = Math.ceil(o / step) * step; m < c; m += step) {
      const at = localToUtc(tz, +p.year, +p.month, +p.day, m);
      if (at.getTime() >= minAt && at.getTime() <= maxAt && !closedOn(S, at) && !(S.paused_until && at < new Date(S.paused_until))) slots.push({ iso: at.toISOString(), label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
    }
    if (slots.length) out.push({ day: i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : `${DAYS[dow]} ${p.day}/${p.month}`, slots });
  }
  return out;
}

/* ---------- promoções (mesma regra do banco; o valor final é sempre o calculado no banco) ---------- */
function localParts(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: (+p.hour % 24) * 60 + +p.minute };
}
function promoActive(pm, tz, at) {
  if (!pm.active) return false;
  const { dow, min } = localParts(tz, at);
  if (pm.days?.length && !pm.days.includes(dow)) return false;
  if (!pm.start_time) return true;
  const a = toMin(pm.start_time.slice(0, 5)), b = toMin(pm.end_time.slice(0, 5));
  return a < b ? min >= a && min < b : min >= a || min < b;
}
// Categoria com horário (ex.: café da manhã das 06:00 às 11:00): mesma regra do banco.
function catOpen(S, cat, at) {
  const h = (S.category_hours || {})[cat]; if (!h) return true;
  const { dow, min } = localParts(S.timezone, at);
  if (h.days?.length && !h.days.includes(dow)) return false;
  if (!h.from || !h.to || h.from === h.to) return true;
  const a = toMin(h.from), b = toMin(h.to);
  return a < b ? min >= a && min < b : min >= a || min < b;
}
const catHoursText = (S, cat) => { const h = (S.category_hours || {})[cat]; if (!h) return '';
  return `das ${h.from} às ${h.to}${h.days?.length && h.days.length < 7 ? ` (${[...h.days].sort().map(d => DAYS.at(d).slice(0, 3).toLowerCase()).join(', ')})` : ''}`; };
const etaTxt = m => m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`;
const promoMatches = (pm, prod) => (!pm.product_id || pm.product_id === prod.id) && (!pm.category || pm.category === prod.category);
function promoDiscount(promos, lines, byId, tz, at) {
  let total = 0; const names = [];
  for (const pm of promos.filter(x => promoActive(x, tz, at))) {
    const units = lines.filter(l => byId[l.productId] && promoMatches(pm, byId[l.productId])).flatMap(l => Array(l.qty).fill(l.unit));
    let d = 0;
    if (pm.kind === 'percent') d = Math.round(units.reduce((a, u) => a + u, 0) * pm.percent / 100);
    else { const free = Math.floor(units.length / pm.buy_qty) * (pm.buy_qty - pm.pay_qty); d = units.sort((a, b) => a - b).slice(0, free).reduce((a, u) => a + u, 0); }
    if (d > 0) { total += d; names.push(pm.name); }
  }
  return { total, names };
}
function promoLabel(pm, byId) {
  const what = pm.product_id ? byId[pm.product_id]?.name || 'produto' : pm.category || 'toda a loja';
  const deal = pm.kind === 'percent' ? `${pm.percent}% off em ${what}` : `Leve ${pm.buy_qty}, pague ${pm.pay_qty} em ${what}`;
  const days = pm.days?.length && pm.days.length < 7 ? ' · ' + pm.days.slice().sort().map(d => DAYS[d].slice(0, 3).toLowerCase()).join(', ') : '';
  const hrs = pm.start_time ? ` · ${pm.start_time.slice(0, 5)}–${pm.end_time.slice(0, 5)}` : '';
  return `${deal}${days}${hrs}`;
}

/* ---------- WhatsApp ---------- */
const waNumber = phone => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 12 && d.startsWith('55') ? d : d.length >= 10 ? '55' + d : ''; };
const waLink = (phone, text) => { const n = waNumber(phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : ''; };
const trackUrl = o => `${location.origin}/pedido/${o.public_code}`;
const mapsUrl = o => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.dest_lat ? `${o.dest_lat},${o.dest_lng}` : / km$/.test(o.zone_name) ? o.address : `${o.address}, ${o.zone_name}`)}`;
function customerMsg(o, storeName) {
  const n = o.customer_name.split(' ')[0];
  const m = {
    novo: `Olá, ${n}! Recebemos seu pedido #${o.number} na ${storeName}.`,
    preparo: `Olá, ${n}! Seu pedido #${o.number} na ${storeName} foi aceito e já está sendo preparado.`,
    pronto: o.fulfillment === 'table' ? `Olá, ${n}! Seu pedido #${o.number} está pronto e já vai para a sua mesa.` : o.fulfillment === 'pickup' ? `Olá, ${n}! Seu pedido #${o.number} está pronto para retirada na ${storeName}.` : `Olá, ${n}! Seu pedido #${o.number} está pronto e logo sai para entrega.`,
    rota: `Olá, ${n}! Seu pedido #${o.number} saiu para entrega${o.courier?.name ? ` com ${o.courier.name}` : ''}.`,
    entregue: `Obrigado pelo pedido, ${n}! Esperamos que tenha gostado. 😊`,
    cancelado: `Olá, ${n}. Infelizmente seu pedido #${o.number} na ${storeName} foi cancelado. Fale com a gente se tiver dúvidas.`
  }[o.status];
  return `${m}\nAcompanhe: ${trackUrl(o)}`;
}
const courierMsg = o => `Entrega #${o.number}${o.scheduled_for ? ` (agendada: ${fmtWhen(o.scheduled_for)})` : ''}\n${o.customer_name} · ${o.customer_phone}\n${o.address} — ${o.zone_name}\n${o.payment_status === 'paid' ? `JÁ PAGO (${o.payment}) · não cobrar` : `Cobrar: ${o.payment} · ${brl(o.total)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''}`}\nMapa: ${mapsUrl(o)}`;
const waBtn = (href, label = 'WhatsApp') => href ? `<a class="btn ghost sm" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : '';

/* ---------- endereço: CEP e localização ---------- */
// CEP → rua, bairro, cidade e (quando houver) coordenadas. BrasilAPI primeiro, ViaCEP de reserva.
async function lookupCep(cep) {
  cep = String(cep).replace(/\D/g, '');
  if (cep.length !== 8) return null;
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
    if (r.ok) { const j = await r.json(); const c = j.location?.coordinates || {};
      return { street: j.street || '', district: j.neighborhood || '', city: j.city || '', state: j.state || '', lat: +c.latitude || null, lng: +c.longitude || null }; }
  } catch {}
  try {
    const j = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
    if (!j.erro) return { street: j.logradouro || '', district: j.bairro || '', city: j.localidade || '', state: j.uf || '', lat: null, lng: null };
  } catch {}
  return null;
}
// Endereço completo → coordenadas (OpenStreetMap). Se não achar, usa as coordenadas do CEP.
async function locateAddress({ street, number, city, state, cep }, cepInfo) {
  if (street && city) {
    try {
      const u = new URL('https://nominatim.openstreetmap.org/search');
      Object.entries({ format: 'json', limit: '1', countrycodes: 'br', street: `${number || ''} ${street}`.trim(), city, state: state || '', postalcode: String(cep || '').replace(/\D/g, '') })
        .forEach(([k, v]) => v && u.searchParams.set(k, v));
      const j = await (await fetch(u, { headers: { 'Accept-Language': 'pt-BR' } })).json();
      if (j[0]) return { lat: +j[0].lat, lng: +j[0].lon };
    } catch {}
  }
  return cepInfo?.lat ? { lat: cepInfo.lat, lng: cepInfo.lng } : null;
}
const kmTxt = km => `${String(km).replace('.', ',')} km`;

// Endereço público da loja: o domínio próprio, quando a loja tem um; senão o caminho /loja/<slug> da plataforma.
const storeLink = t => t?.custom_domain ? `https://${t.custom_domain}` : `${location.origin}/loja/${t.slug}`;
// Domínio próprio: quem abre pedidos.minhaloja.com.br cai direto na loja.
const isPlatformHost = h => /^(localhost|127\.0\.0\.1)$|\.vercel\.app$/.test(h) || (PLATFORM.domains || []).includes(h);
let hostSlug; // undefined = ainda não consultado
async function slugForHost() {
  if (hostSlug !== undefined) return hostSlug;
  if (isPlatformHost(location.hostname)) return (hostSlug = null);
  try { hostSlug = await rpc('store_by_domain', { p_host: location.hostname }); } catch { hostSlug = null; }
  return hostSlug;
}

// "Meus pedidos": os pedidos feitos neste aparelho (sem login), para acompanhar e pedir de novo.
const myOrders = () => local.get('myorders', []);
const rememberOrder = o => local.set('myorders', [o, ...myOrders().filter(x => x.code !== o.code)].slice(0, 20));
const FINAL = ['entregue', 'cancelado'];

/* ---------- comanda (impressora térmica 80 mm) ---------- */
// Folha A4 com os QR Codes das mesas (imagem gerada pelo serviço público goqr.me/api.qrserver.com)
async function printTableQrs(base, count, storeName) {
  const url = n => `${base}?mesa=${n}`;
  $('#print').innerHTML = `<div class="qrsheet">${Array.from({ length: count }, (_, i) => `<div class="qrcard"><b>${esc(storeName)}</b>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=${encodeURIComponent(url(i + 1))}" alt="QR Code da mesa ${i + 1}">
    <span class="big">Mesa ${i + 1}</span><span>Aponte a câmera para pedir</span></div>`).join('')}</div>`;
  toast('Preparando os QR Codes…');
  await Promise.all([...$('#print').querySelectorAll('img')].map(img => img.complete ? 0 : new Promise(ok => { img.onload = img.onerror = ok; })));
  window.print();
}

// Cardápio impresso (A4) com QR Code para a loja online
async function printMenu(S, prods) {
  const link = storeLink(S), cats = [...new Set(prods.filter(p => p.available).map(p => p.category))];
  const from = p => { const min = (p.groups || []).filter(g => g.min_sel > 0).reduce((a, g) => a + Math.min(...g.options.map(o => o.price)), 0); return p.price + min; };
  const hasVar = p => (p.groups || []).some(g => g.min_sel > 0 && new Set(g.options.map(o => o.price)).size > 1);
  $('#print').innerHTML = `<div class="menusheet"><header><div>${S.logo_path ? `<img class="mlogo" src="${esc(imgUrl(S.logo_path))}" alt="">` : ''}<h1>${esc(S.name)}</h1><div>${[S.phone, S.address].filter(Boolean).map(esc).join(' · ')}</div>
      ${S.description ? `<div style="margin-top:2mm">${esc(S.description)}</div>` : ''}</div>
      <div style="text-align:center"><img src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=4&data=${encodeURIComponent(link)}" alt="QR Code da loja"><div><b>Peça pelo celular</b></div></div></header>
    <div class="cols">${cats.map(c => `<section><h2>${esc(c)}</h2>${prods.filter(p => p.category === c && p.available).map(p => `<div class="it"><span><b>${esc(p.name)}</b>${p.description ? `<small>${esc(p.description)}</small>` : ''}</span><b>${hasVar(p) ? 'a partir de ' : ''}${brl(from(p))}</b></div>`).join('')}</section>`).join('')}</div>
    <footer>${esc(link.replace(/^https?:\/\//, ''))} · preços sujeitos a alteração</footer></div>`;
  await Promise.all([...$('#print').querySelectorAll('img')].map(img => img.complete ? 0 : new Promise(ok => { img.onload = img.onerror = ok; })));
  window.print();
}

// Estações (cozinha, bar…): cada categoria vai para uma estação; sem estação definida = Cozinha.
const stationList = S => [...new Set(['Cozinha', ...Object.values(S.stations || {})])];
const catMapCache = {};
async function productCats(tid) {
  if (!catMapCache[tid]) catMapCache[tid] = Object.fromEntries((await q(sb.from('products').select('id, category').eq('tenant_id', tid)).catch(() => [])).map(p => [p.id, p.category]));
  return catMapCache[tid];
}
const itemStation = (S, cats, x) => (S.stations || {})[cats[x.product_id]] || 'Cozinha';
// Imprime conforme a escolha do aparelho: pedido completo, uma comanda por estação, ou só uma estação.
async function printOrder(S, o) {
  const mode = local.get('printStation', 'all'); if (mode === 'all' || stationList(S).length < 2) return printTicket(o, S.name);
  const cats = await productCats(S.id), st = mode === 'split' ? stationList(S) : [mode];
  const parts = st.map(n => [n, o.items.filter(x => itemStation(S, cats, x) === n)]).filter(([, its]) => its.length);
  parts.forEach(([n, its], i) => setTimeout(() => printTicket({ ...o, items: its }, S.name, n), i * 1500));
}
function printTicket(o, storeName, station) {
  const box = $('#print');
  if (station) { // comanda de estação: só os itens, sem valores
    box.innerHTML = `<div class="tkt"><b class="big">${esc(station.toUpperCase())}</b><div>Pedido <b class="big">#${o.number}</b>${o.fulfillment === 'table' ? ` · <b class="big">MESA ${esc(o.table_label)}</b>` : ''}</div>
      <div>${new Date(o.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${esc(o.customer_name)}${o.scheduled_for ? ` · <b>AGENDADO ${esc(fmtWhen(o.scheduled_for))}</b>` : ''}</div><hr>
      ${o.items.map(x => `<div class="li big"><b>${x.qty}x ${esc(x.product_name)}</b></div>${x.options_text ? `<div class="sub">${esc(x.options_text)}</div>` : ''}${x.notes ? `<div class="sub">Obs: ${esc(x.notes)}</div>` : ''}`).join('')}</div>`;
    return window.print();
  }
  box.innerHTML = `<div class="tkt"><b class="big">${esc(storeName)}</b><div>Pedido <b class="big">#${o.number}</b></div>${o.scheduled_for ? `<div><b class="big">AGENDADO: ${esc(fmtWhen(o.scheduled_for))}</b></div>` : ''}
    <div>${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div><hr>
    <div><b>${esc(o.customer_name)}</b> · ${esc(o.customer_phone)}</div>
    <div>${o.fulfillment === 'table' ? `<b class="big">MESA ${esc(o.table_label)}</b>` : o.fulfillment === 'pickup' ? `<b>RETIRADA${o.channel === 'balcao' ? ' · BALCÃO' : ' NA LOJA'}</b>` : `<b>ENTREGA</b> · ${esc(o.address)} — ${esc(o.zone_name)}`}</div><hr>
    ${o.items.map(x => `<div class="li"><b>${x.qty}x ${esc(x.product_name)}</b><span>${brl(x.qty * x.unit_price)}</span></div>${x.options_text ? `<div class="sub">${esc(x.options_text)}</div>` : ''}${x.notes ? `<div class="sub">OBS: ${esc(x.notes)}</div>` : ''}`).join('')}<hr>
    <div class="li"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
    ${o.fee ? `<div class="li"><span>Entrega</span><span>${brl(o.fee)}</span></div>` : ''}${o.service_fee ? `<div class="li"><span>Serviço</span><span>${brl(o.service_fee)}</span></div>` : ''}${o.promo_discount ? `<div class="li"><span>Promoção</span><span>-${brl(o.promo_discount)}</span></div>` : ''}${o.discount ? `<div class="li"><span>Desconto</span><span>-${brl(o.discount)}</span></div>` : ''}
    <div class="li big"><b>TOTAL</b><b>${brl(o.total)}</b></div>
    <div>Pagamento: ${esc(o.payment)}${o.change_for ? ` · troco p/ ${brl(o.change_for)}` : ''}${o.payment_status === 'paid' ? ' · <b>PAGO</b>' : ''}</div></div>`;
  window.print();
}

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
    tenantsQuery(c => sb.from('memberships').select(`role, tenant:tenants(${c}, seg:segment_templates(name, prep))`).eq('user_id', user.id)),
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
  $('#nav a.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#logout')?.addEventListener('click', async () => { await sb.auth.signOut(); ME = null; go('/entrar'); });
  $('#pickT')?.addEventListener('change', e => { local.set('tenant', e.target.value); render(); });
}

async function render() {
  // Totem travado: qualquer navegação (voltar, links) volta para o totem; só a tela de login passa
  if (local.get('kioskLock', false) && location.pathname !== '/painel/totem' && !location.pathname.startsWith('/entrar')) history.replaceState(null, '', '/painel/totem');
  cleanup?.(); cleanup = null; closeDlg(); window.scrollTo(0, 0); $('#banner').innerHTML = ''; setManifest(null);
  document.body.classList.remove('kiosk');
  if (!configured) return vSetup();
  const p = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (p[0] === 'loja' && p[1]) return await vShop(p[1]);
    if (p[0] === 'pedido' && p[1]) return await vTrack(p[1]);
    if (p[0] === 'entrar') return vAuth(p[1]);
    if (p[0] === 'termos' || p[0] === 'privacidade') return vLegal(p[0]);
    if (p[0] === 'meus-pedidos') return await vMyOrders();
    if (p[0] === 'chamada' && p[1]) return await vCallBoard(p[1]);
    if (p[0] === 'entregador' && p[1]) return await vCourier(p[1]);
    if (!p.length) { const hs = await slugForHost(); if (hs) return await vShop(hs); }
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

/* ---------- termos e privacidade ---------- */
function vLegal(which) {
  setColor('#d62828'); brand(PLATFORM.name); header('', false);
  const missing = !PLATFORM.company || !PLATFORM.cnpj || !PLATFORM.email || !PLATFORM.city;
  app.innerHTML = `<article class="panel legal">${missing ? '<p class="banner warn" style="margin:0">Modelo: preencha os dados da empresa em <code>public/config.js</code> (PLATFORM) e revise o texto com um advogado.</p>' : ''}
    ${which === 'termos' ? termsHtml(PLATFORM) : privacyHtml(PLATFORM)}</article>`;
}

/* ---------- página do entregador (link secreto, sem login) ---------- */
async function vCourier(token) {
  let lastSig = '', R = null, plan = null, planSig = '', me = null, watch = null, lastSent = 0, sentAt = null, wake = null;
  const sharing = () => local.get(`share:${token.slice(0, 12)}`, false);
  // Rota sugerida: posição atual (ou a loja) → entregas na ordem mais curta. Endereço sem localização: procura no mapa.
  const buildPlan = async () => {
    const ds = R?.deliveries || [], sig = ds.map(d => d.id).join();
    if (sig === planSig && plan) return;
    planSig = sig; plan = null;
    if (!ds.length) return;
    const pts = await Promise.all(ds.map(async d => d.lat != null ? { lat: d.lat, lng: d.lng } : await geocodeText(/ km$/.test(d.zone) ? d.address : `${d.address}, ${d.zone}`)));
    if (sig !== planSig) return;
    const withPt = ds.map((d, i) => ({ ...d, pt: pts[i] })), geo = withPt.filter(d => d.pt), rest = withPt.filter(d => !d.pt);
    const start = me ? [me.lat, me.lng] : R.store.lat != null ? [R.store.lat, R.store.lng] : null;
    plan = [...orderStops(start, geo, d => [d.pt.lat, d.pt.lng]), ...rest];
    paint();
  };
  const gmaps = () => {
    const stop = d => d.pt ? `${d.pt.lat},${d.pt.lng}` : (/ km$/.test(d.zone) ? d.address : `${d.address}, ${d.zone}`);
    const ps = plan.map(stop), origin = me ? `${me.lat},${me.lng}` : R.store.lat != null ? `${R.store.lat},${R.store.lng}` : '';
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving${origin ? `&origin=${encodeURIComponent(origin)}` : ''}&destination=${encodeURIComponent(ps.at(-1))}${ps.length > 1 ? `&waypoints=${encodeURIComponent(ps.slice(0, -1).join('|'))}` : ''}`;
  };
  const card = (d, i) => `<div class="panel dl">
        <div class="row between"><b class="big">${plan ? `<span class="stopn">${i + 1}</span> ` : ''}#${d.number}</b><span class="mut">saiu há ${mins(d.since)} min</span></div>
        <div><b>${esc(d.customerName)}</b></div>
        <div class="addr">${esc(d.address)}<br><span class="mut">${esc(d.zone)}</span></div>
        <div class="${d.paid ? 'badge b-g' : 'badge b-a'}" style="font-size:14px;padding:6px 10px">${d.paid ? 'JÁ PAGO · não cobrar' : `Cobrar ${brl(d.total)} · ${esc(d.payment)}${d.changeFor ? ` · levar troco p/ ${brl(d.changeFor)}` : ''}`}</div>
        <div class="mut">${d.items.map(esc).join(' · ')}</div>
        <div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
          <a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.lat != null ? `${d.lat},${d.lng}` : / km$/.test(d.zone) ? d.address : d.address + ', ' + d.zone)}" target="_blank" rel="noopener">Mapa</a>
          ${waBtn(waLink(d.customerPhone, `Olá, ${d.customerName.split(' ')[0]}! Sou o entregador da ${R.store.name} e estou chegando com seu pedido #${d.number}.`), 'WhatsApp').replace('btn ghost sm', 'btn ghost') || '<span></span>'}
          <a class="btn ghost" href="tel:${esc(String(d.customerPhone).replace(/[^\d+]/g, ''))}">Ligar</a></div>
        <button class="ok" data-done="${d.id}">Entreguei</button></div>`;
  const paint = () => {
    if (!R) return;
    const ds = plan || R.deliveries;
    app.innerHTML = `<div class="courier"><h2>Olá, ${esc(R.courier.name.split(' ')[0])}!</h2>
      <p class="lead">Hoje: <b>${R.today.deliveries}</b> entrega(s) · ${brl(R.today.fees)} em taxas. Esta página atualiza sozinha.</p>
      ${R.deliveries.length ? `<div class="panel live">
        <label class="chk"><input type="checkbox" id="shareLoc" ${sharing() ? 'checked' : ''}> <b>Compartilhar minha localização</b></label>
        <span class="mut">${sharing() ? (me ? `Ligado · o cliente vê você no mapa${sentAt ? ` · enviado às ${hhmm(sentAt)}` : ''}. Mantenha esta página aberta.` : 'Procurando o GPS… permita a localização se o celular pedir.') : 'O cliente acompanha você chegando, só enquanto a entrega dele está em rota. Desliga sozinho quando você termina.'}</span>
        ${R.deliveries.length > 1 ? `<div class="row between" style="margin-top:6px"><b>Rota sugerida${plan ? `: ${plan.map(d => '#' + d.number).join(' → ')}` : '…'}</b>${plan ? `<a class="btn pri sm" href="${esc(gmaps())}" target="_blank" rel="noopener">Abrir rota no Google Maps</a>` : ''}</div>` : ''}
        <div class="omap" id="cMap" hidden></div></div>` : ''}
      ${ds.map(card).join('') || '<div class="panel"><p class="empty">Nenhuma entrega com você agora.</p></div>'}
      ${R.store.phone ? `<p class="mut">Dúvidas: ${esc(R.store.phone)}</p>` : ''}</div>`;
    drawMap($('#cMap'), [
      ...(me ? [{ ...me, kind: 'moto', label: 'Você' }] : R.store.lat != null ? [{ lat: R.store.lat, lng: R.store.lng, kind: 'store', label: R.store.name }] : []),
      ...(plan || []).filter(d => d.pt).map((d, i) => ({ ...d.pt, kind: 'n', label: String(i + 1) }))]);
  };
  const draw = async force => {
    const r = await rpc('courier_portal', { p_token: token });
    if (!r) { app.innerHTML = '<div class="panel auth"><h2>Link inválido</h2><p>Peça um link novo para a loja.</p></div>'; header('', false); return false; }
    const sig = JSON.stringify(r); if (!force && sig === lastSig) return true; lastSig = sig; R = r;
    setColor(r.store.color); brand(r.store.name, r.store.logo); header('', false);
    if (!r.deliveries.length) stopGps();
    else if (sharing() && watch == null) startGps();
    paint(); buildPlan();
    return true;
  };
  const send = async () => {
    if (!me || !R?.deliveries.length || Date.now() - lastSent < 15000) return;
    lastSent = Date.now();
    try { if (await rpc('courier_ping', { p_token: token, p_lat: me.lat, p_lng: me.lng, p_acc: me.acc })) { sentAt = new Date(); paint(); } } catch {}
  };
  function startGps() {
    if (!navigator.geolocation) return toast('Este celular não tem GPS no navegador');
    watch = navigator.geolocation.watchPosition(p => { me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; send(); if (!sentAt) paint(); },
      err => { toast(err.code === 1 ? 'Permita a localização para o cliente ver você no mapa' : 'GPS indisponível agora'); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {});   // tela acesa enquanto compartilha
  }
  function stopGps() { if (watch != null) navigator.geolocation.clearWatch(watch); watch = null; wake?.release?.().catch(() => {}); wake = null; }
  app.onchange = e => {
    if (e.target.id !== 'shareLoc') return;
    local.set(`share:${token.slice(0, 12)}`, e.target.checked);
    if (e.target.checked) startGps(); else { stopGps(); me = null; sentAt = null; }
    paint();
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button[data-done]'); if (!b) return;
    if (!sure(b)) return;
    await rpc('courier_deliver', { p_token: token, p_order: +b.dataset.done }); toast('Entrega confirmada'); await draw(true);
  });
  const vis = () => { if (document.visibilityState === 'visible' && sharing() && R?.deliveries.length) { navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {}); draw().catch(() => {}); } };
  document.addEventListener('visibilitychange', vis);
  if (await draw(true)) { const h = setInterval(() => { draw().catch(() => {}); send(); }, 15000); cleanup = () => { clearInterval(h); stopGps(); document.removeEventListener('visibilitychange', vis); app.onclick = app.onchange = null; }; }
  else cleanup = () => { app.onclick = null; };
}

/* ---------- início ---------- */
function vHome() {
  setColor('#d62828'); brand('Balcão'); header();
  const dest = ME?.tenant ? '/painel' : ME?.isAdmin ? '/plataforma' : ME ? '/comecar' : '/entrar/cadastro';
  app.innerHTML = `<section class="hero"><div class="grid"><h1>Delivery próprio para qualquer negócio</h1>
    <p>Loja online com a sua marca, fila de preparo em tempo real, despacho de entregadores e relatórios — para pizzaria, hamburgueria, açaí, mercado, farmácia e o que mais vender por entrega.</p>
    <div class="row"><a class="btn pri" href="${dest}" data-link>${ME ? 'Ir para o painel' : 'Criar minha loja'}</a>${ME ? '' : '<a class="btn ghost" href="/entrar" data-link>Já tenho conta</a>'}${myOrders().length ? '<a class="btn ghost" href="/meus-pedidos" data-link>Meus pedidos</a>' : ''}</div></div>
    <div class="menu" style="grid-template-columns:repeat(2,minmax(0,1fr))">${['pizza', 'burger', 'cup', 'box'].map((i, k) => `<div class="item">${art(i, ['#d62828', '#e85d04', '#6a2c91', '#2f8f46'][k])}</div>`).join('')}</div></section>`;
}

/* ---------- painel de chamada (TV do balcão, público) ---------- */
async function vCallBoard(slug) {
  document.body.classList.add('kds-on', 'callb');
  let known = null, last = null;
  const draw = async () => {
    let b; try { b = await rpc('call_board', { p_slug: slug }); } catch { return; }
    if (!b) { app.innerHTML = '<h2 style="padding:24px">Loja não encontrada.</h2>'; return; }
    setColor(b.store.color);
    const ready = b.ready.filter(x => !x.table), prep = b.preparing.filter(x => !x.table);
    const ids = new Set(ready.map(x => x.n)), fresh = known ? ready.filter(x => !known.has(x.n)) : [];
    if (fresh.length) { last = fresh[0].n; try { beep(); setTimeout(beep, 400); } catch {} }
    known = ids;
    app.innerHTML = `<div class="cb"><div class="cbh"><b class="cbname">${b.store.logo ? `<img src="${esc(imgUrl(b.store.logo))}" alt="">` : ''}${esc(b.store.name)}</b><span>${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="cbcols"><section><h2>Preparando</h2><div class="nums prep">${prep.map(x => `<span>${x.n}${x.name ? `<small>${esc(x.name)}</small>` : ''}</span>`).join('') || '<em>—</em>'}</div></section>
      <section class="ok"><h2>Pronto! Pode retirar</h2><div class="nums">${ready.map(x => `<span class="${x.n === last ? 'new' : ''}">${x.n}${x.name ? `<small>${esc(x.name)}</small>` : ''}</span>`).join('') || '<em>—</em>'}</div></section></div></div>`;
  };
  await draw();
  const tick = setInterval(draw, 8000);
  try { navigator.wakeLock?.request('screen').catch(() => {}); } catch {}
  app.onclick = () => document.fullscreenElement ? null : document.documentElement.requestFullscreen?.().catch(() => {});
  cleanup = () => { clearInterval(tick); app.onclick = null; document.body.classList.remove('kds-on', 'callb'); };
}

/* ---------- meus pedidos (cliente, sem login) ---------- */
async function vMyOrders() {
  setColor('#d62828'); brand('Meus pedidos'); header('', false);
  const list = myOrders();
  const st = await Promise.all(list.slice(0, 10).map(o => rpc('track_order', { p_code: o.code }).then(r => r?.order?.status || null).catch(() => null)));
  app.innerHTML = `<h2>Meus pedidos</h2><p class="lead">Pedidos feitos neste aparelho. Ficam só aqui no seu celular.</p>
    <div class="panel" style="max-width:760px">${list.map((o, i) => `<div class="ci"><span><b>${esc(o.store)}</b> · pedido #${o.number}<br><span class="mut">${new Date(o.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${brl(o.total)}</span></span>
      <span class="row">${st.at(i) ? `<span class="badge ${st.at(i) === 'entregue' ? 'b-g' : st.at(i) === 'cancelado' ? 'b-r' : 'b-a'}">${esc(st.at(i) === 'pagamento' ? 'Aguardando pagamento' : SLABEL[st.at(i)] || st.at(i))}</span>` : ''}
        <a class="btn ghost sm" href="/pedido/${esc(o.code)}" data-link>Ver</a><a class="btn ghost sm" href="/loja/${esc(o.slug)}?repetir=1" data-link>Pedir de novo</a></span></div>`).join('') || '<p class="empty">Nenhum pedido feito neste aparelho ainda.</p>'}
    ${list.length ? '<button class="ghost sm" id="myClear" style="margin-top:12px">Apagar histórico deste aparelho</button>' : ''}</div>`;
  app.onclick = e => { const b = e.target.closest('#myClear'); if (!b || !sure(b)) return; local.set('myorders', []); ['last:', 'cart:'].forEach(k => Object.keys(localStorage).filter(x => x.startsWith(k)).forEach(x => localStorage.removeItem(x))); vMyOrders(); };
  cleanup = () => { app.onclick = null; };
}

/* ---------- entrar / criar conta / recuperar senha ---------- */
function vAuth(mode = 'login') {
  setColor('#d62828'); brand('Balcão'); header('', false);
  const T = { login: ['Entrar', 'Acesso para empresas e para a administração da plataforma.', 'Entrar'], cadastro: ['Criar conta', 'Depois de criar a conta você monta sua loja em um minuto.', 'Criar conta'], senha: ['Recuperar senha', 'Enviaremos um link para você criar uma nova senha.', 'Enviar link'], nova: ['Nova senha', 'Digite a nova senha da sua conta.', 'Salvar senha'] }[mode];
  if (!T) return go('/entrar');
  app.innerHTML = `<form class="panel auth" id="fAuth"><h2>${T[0]}</h2><p class="mut">${T[1]}</p>
    ${mode !== 'nova' ? '<label>E-mail<input id="aE" type="email" required autocomplete="username"></label>' : ''}
    ${mode !== 'senha' ? `<label>Senha<input id="aP" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
    ${mode === 'cadastro' ? '<label class="chk" style="align-items:flex-start"><input type="checkbox" id="aTerms" required> <span>Li e aceito os <a href="/termos" target="_blank">Termos de Uso</a> e a <a href="/privacidade" target="_blank">Política de Privacidade</a>.</span></label>' : ''}
    <button class="pri">${T[2]}</button>
    <p class="mut" style="margin:0">${mode === 'login' ? '<a href="/entrar/cadastro" data-link>Criar conta</a> · <a href="/entrar/senha" data-link>Esqueci a senha</a>' : '<a href="/entrar" data-link>Voltar para entrar</a>'}</p></form>`;
  $('#fAuth').onsubmit = attempt(async e => {
    e.preventDefault(); const email = $('#aE')?.value.trim(), password = $('#aP')?.value;
    if (mode === 'login') { await q(sb.auth.signInWithPassword({ email, password })); await loadMe(); go(ME?.tenant ? '/painel' : ME?.isAdmin ? '/plataforma' : '/comecar'); }
    if (mode === 'cadastro') {
      if (!$('#aTerms').checked) throw new Error('Aceite os Termos de Uso e a Política de Privacidade');
      const r = await q(sb.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/comecar`, data: { terms_version: LEGAL_VERSION, terms_accepted_at: new Date().toISOString() } } }));
      if (r.session) go('/comecar');
      else app.innerHTML = `<div class="panel auth"><h2>Confira seu e-mail</h2><p>Enviamos um link de confirmação para <b>${esc(email)}</b>. Depois de confirmar, você volta para cá e cria sua loja.</p></div>`;
    }
    if (mode === 'senha') { await q(sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/entrar/nova` })); toast('Se o e-mail existir, o link foi enviado'); }
    if (mode === 'nova') { await q(sb.auth.updateUser({ password })); toast('Senha alterada'); go('/painel'); }
  });
}

/* ---------- criar a loja (depois do cadastro) ---------- */
async function vStart() {
  setColor('#d62828'); brand('Balcão'); header();
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
// Colunas públicas da loja (os dados internos de cobrança não são lidos pelo site).
const TENANT_BASE = 'id, slug, name, segment, color, plan, min_order, is_open, allow_pickup, eta_text, phone, timezone, active, created_at, hours, auto_hours, pix_online, billing_status, trial_ends_at, paid_until, delivery_mode, lat, lng, distance_tiers, loyalty_enabled, loyalty_every, loyalty_percent, allow_tables, tables_count, allow_scheduling, schedule_days, schedule_lead_minutes, schedule_slot_minutes, description, address, instagram, banner_path, free_delivery_above, card_online, custom_domain, service_percent, category_hours, paused_until, delivery_paused_until, closed_dates, stations, cashback_percent, cashback_days, logo_path, referral_reward';
let TENANT_COLS = TENANT_BASE;
// Banco sem alguma migração nova: tira da lista a coluna que ainda não existe e tenta de novo.
async function tenantsQuery(build) {
  for (let i = 0; i < 8; i++) {
    const { data, error } = await build(TENANT_COLS);
    if (!error) return data;
    const m = /column [\w.]*?\.?(\w+) does not exist/.exec(error.message || '');
    if (!m || !TENANT_COLS.includes(m[1])) throw new Error(tr(error.message || 'Erro'));
    TENANT_COLS = TENANT_COLS.split(', ').filter(c => c !== m[1]).join(', ');
  }
  throw new Error('Não foi possível ler a loja');
}
const MENU_COLS = 'id, category, name, description, price, icon, image_path, available, stock, sort, option_groups(id, name, min_sel, max_sel, sort, options(id, name, price, sort))';

// Montador de produto com grupos de opções (usado na loja e no lançamento de pedidos do painel)
const unitOfP = (p, ids) => p.price + p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).reduce((t, o) => t + o.price, 0);
function openBuilder(p, onAdd) {
  if (!p.groups.length) return onAdd({ productId: p.id, name: p.name, optionIds: [], optText: '', unit: p.price, qty: 1, notes: '' });
  const sel = p.groups.map(g => g.options.slice(0, g.min_sel).map(o => o.id));
  let qty = 1, notes = '';
  const draw = () => {
    dialog(`<h2>${esc(p.name)}</h2><span class="mut">${esc(p.description)}</span>
    ${p.groups.map((g, i) => `<div class="grp"><h3><span>${esc(g.name)}</span><span class="badge ${g.min_sel ? 'b-a' : ''}">${g.min_sel ? (g.min_sel === g.max_sel ? `Escolha ${g.min_sel}` : `Mín. ${g.min_sel}, máx. ${g.max_sel}`) : g.max_sel > 1 ? `Até ${g.max_sel}` : 'Opcional'}</span></h3>
      <div class="opts">${g.options.map(o => `<button data-g="${i}" data-o="${o.id}" class="${sel[i].includes(o.id) ? 'on' : ''}" aria-pressed="${sel[i].includes(o.id)}">${esc(o.name)}${o.price ? ' +' + brl(o.price) : ''}</button>`).join('')}</div></div>`).join('')}
    <label>Observação<input id="bObs" value="${esc(notes)}" maxlength="140" placeholder="Ex.: sem cebola"></label>
    <div class="row between"><span class="row"><button class="ghost sm" data-q="-1" aria-label="Menos">−</button><b>${qty}</b><button class="ghost sm" data-q="1" aria-label="Mais">+</button></span><span class="tot price">${brl(unitOfP(p, sel.flat()) * qty)}</span></div>
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
        closeDlg(); onAdd({ productId: p.id, name: p.name, optionIds: ids, optText: names.join(', '), unit: unitOfP(p, ids), qty, notes: notes.trim() });
      }
    };
  };
  draw();
}

async function vShop(slug) {
  const S = (await tenantsQuery(c => sb.from('tenants').select(`${c}, seg:segment_templates(name)`).eq('slug', slug).limit(1)))[0];
  if (!S) throw new Error('Loja não encontrada');
  const [rawP, zones] = await Promise.all([
    q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)),
    q(sb.from('zones').select('id, name, fee').eq('tenant_id', S.id).order('name'))]);
  const products = sortMenu(rawP), OS = openState(S), DIST = S.delivery_mode === 'distance';
  const RV = await rpc('store_reviews', { p_slug: slug, p_limit: 10 }).catch(() => null);
  const PR = await rpc('store_product_ratings', { p_slug: slug }).catch(() => ({}));   // { productId: { avg, count } } com 3+ avaliações
  const [PROMOS, POP, ETA] = await Promise.all([q(sb.from('promotions').select('*').eq('tenant_id', S.id).eq('active', true)).catch(() => []),
    rpc('popular_products', { p_slug: slug }).catch(() => []), rpc('store_eta', { p_slug: slug }).catch(() => null)]);
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  // Pedido na mesa: o QR Code da mesa abre /loja/<loja>?mesa=7
  const mesaParam = (new URLSearchParams(location.search).get('mesa') || '').toUpperCase().trim();
  const TABLE = S.allow_tables && /^[A-Z0-9][A-Z0-9 -]{0,9}$/.test(mesaParam) ? mesaParam : null;
  // Indique e ganhe: o link do amigo abre /loja/<loja>?indica=ABC123; o código vale no 1º pedido feito neste aparelho
  const indica = (new URLSearchParams(location.search).get('indica') || '').toUpperCase().trim();
  if (S.referral_reward && /^[A-Z2-9]{6}$/.test(indica)) local.set(`ref:${slug}`, indica);
  const SLOTS = !TABLE && S.allow_scheduling && S.is_open && billingOk(S) ? scheduleSlots(S) : [];
  const CAN_ORDER = OS.open || SLOTS.length > 0, SCHED_ONLY = !OS.open && SLOTS.length > 0;
  let geo = null; // { lat, lng, quote: { km, fee, inArea, maxKm } } no modo por distância
  const zoneTxt = () => !geo?.quote ? '' : geo.quote.inArea
    ? `Distância aproximada: <b>${kmTxt(geo.quote.km)}</b> · taxa ${geo.quote.fee ? brl(geo.quote.fee) : 'grátis'}`
    : `<span class="badge b-r">Fora da área de entrega: ${kmTxt(geo.quote.km)} (a loja entrega até ${kmTxt(geo.quote.maxKm)})</span>`;
  setColor(S.color); brand(S.name, S.logo_path); header('', false); document.title = `${S.name} — pedido online`; setManifest(S);
  const cartKey = `cart:${slug}`;
  let cart = local.get(cartKey, []).filter(c => products.some(p => p.id === c.productId)), cat = null, coupon = null;
  // "Mais pedidos": vitrine dos campeões de venda (aparece quando há 3 ou mais)
  const TOP = '★ Mais pedidos', popular = (POP || []).map(id => products.find(p => p.id === id)).filter(Boolean);
  const cats = [...(popular.length >= 3 ? [TOP] : []), ...new Set(products.map(p => p.category))];
  const saveCart = () => local.set(cartKey, cart);
  // "Pedir de novo": guarda o último pedido neste aparelho e remonta com os preços de hoje.
  const lastKey = `last:${slug}`;
  const againItems = () => local.get(lastKey, []).flatMap(c => {
    const p = products.find(x => x.id === c.productId); if (!p) return [];
    const opts = p.groups.flatMap(g => g.options);
    if (!c.optionIds.every(id => opts.some(o => o.id === id))) return [];
    return [{ ...c, name: p.name, unit: unitOfP(p, c.optionIds) }];
  });
  const orderAgain = () => {
    const its = againItems(); if (!its.length) return toast('Os itens do último pedido não estão mais disponíveis');
    for (const it of its) { const ex = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); ex ? ex.qty += it.qty : cart.push({ ...it }); }
    saveCart(); toast(its.length < local.get(lastKey, []).length ? 'Último pedido no carrinho (alguns itens não estão mais disponíveis)' : 'Último pedido no carrinho'); paint();
  };
  if (new URLSearchParams(location.search).get('repetir') === '1') { history.replaceState(null, '', location.pathname + (TABLE ? `?mesa=${encodeURIComponent(TABLE)}` : '')); if (!cart.length) setTimeout(orderAgain); }
  const unitOf = (p, ids) => p.price + p.groups.flatMap(g => g.options).filter(o => ids.includes(o.id)).reduce((t, o) => t + o.price, 0);
  let service = true; // taxa de serviço da mesa: opcional para o cliente
  // Pedido em andamento feito neste aparelho nas últimas 4 horas: aparece no topo da loja.
  let ACTIVE = null;
  const recent = myOrders().find(x => x.slug === slug && Date.now() - new Date(x.at) < 4 * 3600e3);
  if (recent) rpc('track_order', { p_code: recent.code }).then(r => { if (r && !FINAL.includes(r.order.status) && r.order.status !== 'pagamento') { ACTIVE = { ...recent, status: r.order.status }; paint(); } }).catch(() => {});
  const totals = () => {
    const sub = cart.reduce((t, c) => t + c.qty * c.unit, 0), pickup = !!TABLE || $('#cMode')?.value === 'pickup';
    const z = DIST ? null : zones.find(z => String(z.id) === $('#cZone')?.value) || zones[0];
    let fee = pickup ? 0 : DIST ? (geo?.quote?.fee || 0) : z ? z.fee : 0, disc = 0;
    const freeShip = !pickup && S.free_delivery_above && sub >= S.free_delivery_above;
    if (freeShip) fee = 0;
    if (coupon) { if (coupon.percent) disc = Math.round(sub * coupon.percent / 100); if (coupon.freeShipping) fee = 0; }
    const when = $('#kWhen')?.value ? new Date($('#kWhen').value) : new Date();
    const pr = promoDiscount(PROMOS, cart, byId, S.timezone, when), promo = Math.min(pr.total, sub);
    const svc = TABLE && S.service_percent && service ? Math.round(Math.max(0, sub - disc - promo) * S.service_percent / 100) : 0;
    return { sub, fee, disc, promo, svc, promoNames: pr.names, total: Math.max(0, sub + fee - disc - promo) + svc, pickup, zone: z, freeShip, feeKnown: pickup || freeShip || !DIST || !!geo?.quote?.inArea };
  };
  // Sugestões no carrinho: o item mais barato de cada categoria que ainda não está no pedido (bebida, sobremesa, porção…).
  // O dono pode escolher os produtos sugeridos (Cardápio → Sugerir no carrinho); sem escolha, vale a regra automática.
  let SUGG = new Set();
  q(sb.from('products').select('id').eq('tenant_id', S.id).eq('suggest', true)).then(r => { SUGG = new Set(r.map(x => x.id)); if (SUGG.size && cart.length) paint(); }).catch(() => {});
  const suggest = () => {
    if (!cart.length || !CAN_ORDER) return [];
    const ids = new Set(cart.map(c => c.productId));
    if (SUGG.size) return products.filter(p => SUGG.has(p.id) && !ids.has(p.id) && p.stock !== 0 && (catOpen(S, p.category, new Date()) || SLOTS.length)).slice(0, 4);
    const inCart = new Set(cart.map(c => products.find(p => p.id === c.productId)?.category));
    return cats.filter(c => !inCart.has(c)).map(c => products.filter(p => p.category === c && p.stock !== 0).sort((x, y) => x.price - y.price)[0])
      .filter(Boolean).sort((x, y) => x.price - y.price).slice(0, 3);
  };
  const paint = () => {
    cat = cats.includes(cat) ? cat : cats[0];
    const list = cat === TOP ? popular : products.filter(p => p.category === cat), count = cart.reduce((t, c) => t + c.qty, 0);
    const catNow = c => catOpen(S, c, new Date());
    app.innerHTML = `${TABLE ? `<div class="banner" style="margin:-24px calc(-1 * max(4vw,16px)) 16px">Você está pedindo para a <b>Mesa ${esc(TABLE)}</b>. O pedido vai direto para a cozinha.</div>` : ''}${!TABLE && S.referral_reward && local.get(`ref:${slug}`, null) ? `<div class="banner" style="margin:-24px calc(-1 * max(4vw,16px)) 16px">🎁 Você foi indicado por um amigo! No seu 1º pedido entregue, vocês dois ganham <b>${brl(S.referral_reward)}</b> de crédito para usar aqui.</div>` : ''}${S.banner_path ? `<div class="hero-banner" style="background-image:linear-gradient(0deg,#000a,#0000 60%),url('${esc(imgUrl(S.banner_path))}')"><h1>${esc(S.name)}</h1></div>` : `<h2>${esc(S.name)}</h2>`}
    ${S.description ? `<p class="desc">${esc(S.description)}</p>` : ''}
    ${deliveryPaused(S) && !TABLE ? `<p class="banner" style="text-align:left;border-radius:12px;margin:0 0 12px">Entregas pausadas até as <b>${hhmm(S.delivery_paused_until)}</b>${S.allow_pickup ? ' · retirada na loja continua funcionando' : ''}.</p>` : ''}
    ${ACTIVE ? `<a class="activeorder" href="/pedido/${esc(ACTIVE.code)}" data-link>Seu pedido <b>#${ACTIVE.number}</b> está <b>${esc((SLABEL[ACTIVE.status] || ACTIVE.status).toLowerCase())}</b> · Acompanhar →</a>` : ''}
    <p class="lead">${myOrders().length ? '<a href="/meus-pedidos" data-link>Meus pedidos</a> · ' : ''}${SCHED_ONLY ? '<span class="badge b-a">Fechado agora · agende seu pedido</span> · ' : ''}${RV?.count ? `<button class="rating" id="seeReviews">★ ${String(RV.avg).replace('.', ',')} <span class="mut">(${RV.count} avaliaç${RV.count > 1 ? 'ões' : 'ão'})</span></button> · ` : ''}${esc(S.seg?.name)} · ${OS.open ? `<span class="badge b-g">Aberto${OS.label ? ' ' + OS.label : ' agora'}</span>` : `<span class="badge b-r">${esc(OS.label || 'Fechado')}</span>`} · ${TABLE ? '' : ETA?.delivery ? `entrega em ~${etaTxt(ETA.delivery)} <span class="mut">(média da loja)</span>` : `entrega em ${esc(S.eta_text)}`}${S.min_order ? ` · pedido mínimo ${brl(S.min_order)}` : ''}${S.phone ? ` · ${esc(S.phone)}` : ''}
      ${waLink(S.phone, `Olá, ${S.name}!`) ? ` · <a href="${esc(waLink(S.phone, `Olá, ${S.name}!`))}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ''}
      ${S.instagram ? ` · <a href="https://instagram.com/${esc(S.instagram)}" target="_blank" rel="noopener">@${esc(S.instagram)}</a>` : ''}
      ${S.address ? `<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(S.address)}" target="_blank" rel="noopener">${esc(S.address)}</a>` : ''}</p>
    ${S.auto_hours && Object.keys(S.hours || {}).length ? `<details class="hours-pub"><summary class="mut">Horário de funcionamento</summary><table>${DAYS.map((d, i) => `<tr><td>${d}</td><td>${((S.hours || {})[i] || []).map(r => r.join(' às ')).join(' · ') || 'Fechado'}</td></tr>`).join('')}</table></details>` : ''}
    ${PROMOS.length || S.free_delivery_above ? `<div class="promos">${S.free_delivery_above ? `<span class="promo">Frete grátis acima de ${brl(S.free_delivery_above)}</span>` : ''}${PROMOS.map(pm => `<span class="promo ${promoActive(pm, S.timezone) ? '' : 'off'}">${esc(promoLabel(pm, byId))}${promoActive(pm, S.timezone) ? '' : ' (fora do horário)'}</span>`).join('')}</div>` : ''}
    <div class="shop"><section>
      <div class="cats">${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}${c !== TOP && !catNow(c) ? ` <span class="mut" style="font-weight:400">· ${esc(catHoursText(S, c))}</span>` : ''}</button>`).join('')}</div>
      ${cat !== TOP && !catNow(cat) ? `<p class="banner" style="text-align:left;border-radius:12px;margin:0 0 12px">${esc(cat)}: disponível ${esc(catHoursText(S, cat))}.${SLOTS.length ? ' Dá para agendar um pedido para esse horário.' : ''}</p>` : ''}
      <div class="menu">${list.map(p => `<article class="item">${picture(p, S.color)}<div class="b">${PROMOS.some(pm => promoActive(pm, S.timezone) && promoMatches(pm, p)) ? '<span class="badge b-g">Em promoção</span>' : ''}<h3>${esc(p.name)}</h3>${PR?.[p.id] ? `<span class="prate" title="Nota dos pedidos que tinham este produto">★ ${String(PR[p.id].avg).replace('.', ',')} <span class="mut">(${PR[p.id].count})</span></span>` : ''}<span class="mut">${esc(p.description)}</span>
        <div class="foot"><span class="price">${p.groups.some(g => g.min_sel && g.options.some(o => o.price)) ? '<span class="mut">a partir de </span>' : ''}<b>${brl(p.price)}</b></span>
        ${p.stock === 0 ? '<span class="badge b-r">Esgotado</span>' : `<button class="pri sm" data-add="${p.id}" ${CAN_ORDER && (catNow(p.category) || SLOTS.length) ? '' : 'disabled'}>Adicionar</button>`}</div>${p.stock > 0 && p.stock <= 5 ? `<span class="badge b-a">Últimas ${p.stock} unidade${p.stock > 1 ? 's' : ''}</span>` : ''}</div></article>`).join('') || '<p class="empty">Cardápio vazio.</p>'}</div>
    </section>
    <aside class="cart" aria-label="Carrinho"><h3>Seu pedido</h3>
      ${cart.length ? cart.map((x, i) => `<div class="ci"><div><b>${x.qty}× ${esc(x.name)}</b>${x.optText ? `<br><span class="mut">${esc(x.optText)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}<br><button class="ghost sm" data-dec="${i}" aria-label="Diminuir">−</button> <button class="ghost sm" data-inc="${i}" aria-label="Aumentar">+</button></div><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('') : `<p class="empty">Carrinho vazio.</p>${againItems().length ? `<button class="ghost" id="again" style="width:100%">↻ Pedir de novo<br><span class="mut" style="font-weight:400">${esc(againItems().map(x => `${x.qty}× ${x.name}`).join(', ').slice(0, 90))}</span></button>` : ''}`}
      ${suggest().length ? `<div class="sugg"><span class="mut">Que tal adicionar?</span>${suggest().map(p => `<button class="ghost sm suggb" data-add="${p.id}"><span class="thumb">${picture(p, S.color)}</span><span>+ ${esc(p.name)} <span class="mut">${brl(p.price)}</span></span></button>`).join('')}</div>` : ''}
      ${TABLE ? `<p style="margin:0">Pedido para a <b>Mesa ${esc(TABLE)}</b></p>` : `<label>Como receber<select id="cMode"><option value="delivery" ${deliveryPaused(S) && !SLOTS.length ? 'disabled' : ''}>Entrega${deliveryPaused(S) ? ` (pausada até ${hhmm(S.delivery_paused_until)}${SLOTS.length ? ', só agendada' : ''})` : ''}</option>${S.allow_pickup ? `<option value="pickup" ${deliveryPaused(S) ? 'selected' : ''}>Retirar na loja</option>` : ''}</select></label>`}
      <label id="zWrap" ${DIST || TABLE ? 'hidden' : ''}>Bairro<select id="cZone">${zones.map(z => `<option value="${z.id}">${esc(z.name)} · ${z.fee ? brl(z.fee) : 'grátis'}</option>`).join('')}</select></label>
      <label>Cupom<span class="row" style="flex-wrap:nowrap"><input id="cCup" placeholder="Ex.: PRIMEIRA10" value="${esc(coupon?.code || '')}"><button class="ghost" id="cupBtn">Aplicar</button></span></label>
      <div id="tots"></div><button class="pri" id="checkout">Finalizar pedido</button></aside></div>
    ${count ? `<button class="pri cartbar" id="toCart">Ver carrinho · ${count} ${count > 1 ? 'itens' : 'item'} · ${brl(cart.reduce((t, c) => t + c.qty * c.unit, 0))}</button>` : ''}`;
    paintTotals();
  };
  const paintTotals = () => {
    const t = totals(), low = !t.pickup && S.min_order && t.sub < S.min_order; $('#zWrap').hidden = t.pickup || DIST;
    $('#tots').innerHTML = `<div class="ci"><span>Subtotal</span><span class="price">${brl(t.sub)}</span></div>${TABLE ? '' : `<div class="ci"><span>Entrega${DIST && geo?.quote && !t.pickup ? ` (${kmTxt(geo.quote.km)})` : ''}</span><span class="price">${!t.feeKnown ? 'pelo endereço' : t.fee ? brl(t.fee) : 'Grátis'}</span></div>`}${t.disc ? `<div class="ci"><span>Desconto</span><span class="price">−${brl(t.disc)}</span></div>` : ''}${t.promo ? `<div class="ci"><span>Promoção <span class="mut">(${esc(t.promoNames.join(', '))})</span></span><span class="price">−${brl(t.promo)}</span></div>` : ''}${TABLE && S.service_percent ? `<div class="ci"><label class="chk" style="margin:0"><input type="checkbox" id="svc" ${service ? 'checked' : ''}> Taxa de serviço (${S.service_percent}%, opcional)</label><span class="price">${brl(t.svc)}</span></div>` : ''}<div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>${low && cart.length ? `<span class="badge b-a">Faltam ${brl(S.min_order - t.sub)} para o pedido mínimo</span>` : ''}${!TABLE && !t.pickup && S.free_delivery_above && cart.length && !t.freeShip ? `<span class="badge b-g">Faltam ${brl(S.free_delivery_above - t.sub)} para o frete grátis</span>` : ''}`;
    $('#checkout').disabled = !cart.length || low || !CAN_ORDER || (!t.pickup && !DIST && !zones.length);
  };
  const addToCart = it => { const ex = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); ex ? ex.qty += it.qty : cart.push(it); saveCart(); toast('Adicionado ao carrinho'); paint(); };
  const builder = p => openBuilder(p, addToCart);
  const checkout = () => {
    const t = totals(), last = local.get('customer', {});
    dialog(`<h2>Finalizar pedido</h2><form id="fCk" class="grid">
      <label>Nome<input id="kN" required autocomplete="name" value="${esc(last.name || '')}"></label>
      <label>Telefone / WhatsApp${TABLE ? ' (opcional, para acompanhar e somar selos)' : ''}<input id="kP" ${TABLE ? '' : 'required'} inputmode="tel" autocomplete="tel" value="${esc(last.phone || '')}" placeholder="(11) 90000-0000"></label>
      ${TABLE ? `<p class="mut" style="margin:0">Pedido para a <b>Mesa ${esc(TABLE)}</b>. A gente leva até você.</p>` : t.pickup ? '<p class="mut">Retirada na loja — sem taxa de entrega.</p>' : `
      <div class="two" style="gap:10px"><label>CEP<input id="kCep" inputmode="numeric" autocomplete="postal-code" maxlength="9" placeholder="00000-000" value="${esc(last.cep || '')}"></label><label>Número<input id="kNum" required value="${esc(last.num || '')}" placeholder="123"></label></div>
      <label>Rua<input id="kRua" required minlength="3" autocomplete="address-line1" value="${esc(last.rua || '')}" placeholder="Rua, avenida…"></label>
      <label>Complemento / referência<input id="kComp" value="${esc(last.comp || '')}" placeholder="Apto, bloco, ponto de referência"></label>
      <p class="mut" id="kZone" style="margin:0">${DIST ? (geo?.quote ? zoneTxt() : 'Taxa de entrega: preencha o CEP e o número para calcular.') : `Bairro de entrega: <b>${esc(t.zone.name)}</b> · taxa ${t.fee ? brl(t.fee) : 'grátis'}`}</p>`}
      ${S.cashback_percent ? `<p class="mut" style="margin:0">Cashback: <b>${S.cashback_percent}% de volta</b> em cada pedido entregue, para usar no próximo (vale ${S.cashback_days} dias).</p>` : ''}
      ${S.loyalty_enabled ? `<p class="mut" style="margin:0">Fidelidade: a cada ${S.loyalty_every} pedidos entregues, ${S.loyalty_percent}% de desconto no próximo, aplicado automaticamente.</p>` : ''}
      ${SLOTS.length ? `<label>Quando?<select id="kWhen">${SCHED_ONLY ? '' : `<option value="">O quanto antes (${esc(S.eta_text)})</option>`}${SLOTS.map(d => `<optgroup label="${esc(d.day)}">${d.slots.map(x => `<option value="${x.iso}">${esc(d.day)} às ${x.label}</option>`).join('')}</optgroup>`).join('')}</select></label>` : ''}
      <label>Pagamento<select id="kPay">${TABLE ? '<option value="Pagar no caixa" selected>Pagar no caixa / na mesa</option>' : ''}${S.pix_online ? `<option value="Pix online" ${TABLE ? '' : 'selected'}>Pix agora (QR Code, confirmação automática)</option>` : ''}${S.card_online && !TABLE ? `<option value="Cartão online" ${S.pix_online ? '' : 'selected'}>Cartão de crédito agora (pagamento online)</option>` : ''}${TABLE ? '' : '<option value="Pix">Pix na entrega</option><option>Cartão na entrega</option><option>Dinheiro</option>'}</select></label>
      <label id="kEm" ${S.pix_online ? '' : 'hidden'}>E-mail (para o comprovante do Pix)<input id="kEmail" type="email" autocomplete="email" value="${esc(last.email || '')}" placeholder="voce@email.com"></label>
      <label id="kTr" hidden>Troco para (R$)<input id="kT" inputmode="decimal" placeholder="Ex.: 100"></label>
      ${(S.cashback_percent || S.referral_reward) && !TABLE ? `<label class="chk"><input type="checkbox" id="kCb" checked> Usar meu saldo de cashback, se eu tiver <span class="mut">(o desconto aparece no pedido)</span></label>` : ''}
      <div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>
      <p class="mut" style="margin:0;font-size:13px">Seus dados são usados só para preparar e entregar este pedido. <a href="/privacidade" target="_blank">Política de Privacidade</a>.</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="ghost" id="kX">Voltar</button><button class="pri" id="kGo">Enviar pedido</button></div></form>`);
    $('#kPay').onchange = e => { $('#kTr').hidden = e.target.value !== 'Dinheiro'; $('#kEm').hidden = e.target.value !== 'Pix online'; };
    $('#kEm').hidden = $('#kPay').value !== 'Pix online';
    $('#kX').onclick = closeDlg;
    // CEP → rua e bairro. Modo bairros: seleciona o bairro se existir na lista. Modo distância: localiza e calcula a taxa.
    const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    let cepInfo = null;
    const locate = async () => {
      if (!DIST || t.pickup) return;
      const pos = await locateAddress({ street: $('#kRua').value.trim() || cepInfo?.street, number: $('#kNum').value.trim(), city: cepInfo?.city, state: cepInfo?.state, cep: $('#kCep').value }, cepInfo);
      if (!pos) { geo = null; $('#kZone').innerHTML = '<span class="badge b-a">Não encontramos esse endereço no mapa. Confira o CEP.</span>'; return; }
      const quote = await rpc('delivery_quote', { p_slug: slug, p_lat: pos.lat, p_lng: pos.lng });
      geo = { ...pos, quote };
      $('#kZone').innerHTML = zoneTxt(); paintTotals(); dialogTotal();
    };
    $('#kCep')?.addEventListener('input', async e => {
      const cep = e.target.value.replace(/\D/g, '');
      if (cep.length !== 8) return;
      cepInfo = await lookupCep(cep);
      if (!cepInfo) return toast('CEP não encontrado');
      if (cepInfo.street) $('#kRua').value = cepInfo.street;
      if (!DIST) {
        const z = zones.find(z => norm(z.name) === norm(cepInfo.district));
        if (z) { $('#cZone').value = z.id; paintTotals(); const t2 = totals(); $('#kZone').innerHTML = `Bairro de entrega: <b>${esc(z.name)}</b> · taxa ${t2.fee ? brl(t2.fee) : 'grátis'}`; dialogTotal(); }
        else if (cepInfo.district) toast(`Confira se o bairro ${cepInfo.district} está na lista de entrega`);
      } else if ($('#kNum').value.trim()) await locate().catch(() => {});
      $('#kNum').focus();
    });
    $('#kNum')?.addEventListener('change', () => locate().catch(() => {}));
    $('#kRua')?.addEventListener('change', () => locate().catch(() => {}));
    const dialogTotal = () => { const el = $('#fCk .tot .price'); if (el) el.textContent = brl(totals().total); };
    if (DIST && !t.pickup && $('#kCep').value.replace(/\D/g, '').length === 8) lookupCep($('#kCep').value).then(c => { cepInfo = c; if (!geo) return locate(); }).catch(() => {});
    $('#fCk').onsubmit = attempt(async e => {
      e.preventDefault(); $('#kGo').disabled = true;
      try {
        const customer = { name: $('#kN').value, phone: $('#kP').value };
        const pixOnline = $('#kPay').value === 'Pix online', email = $('#kEmail').value.trim();
        if (pixOnline && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Informe seu e-mail para gerar o Pix');
        const addr = t.pickup || TABLE ? '' : `${$('#kRua').value.trim()}, ${$('#kNum').value.trim()}${$('#kComp').value.trim() ? ' - ' + $('#kComp').value.trim() : ''}${$('#kCep').value.trim() ? ' - CEP ' + $('#kCep').value.trim() : ''}`;
        const zoneNow = totals().zone;
        if (DIST && !t.pickup) {
          if (!geo) await locate();
          if (!geo) throw new Error('Não encontramos o endereço no mapa. Confira o CEP e o número.');
          if (!geo.quote?.inArea) throw new Error(`Endereço fora da área de entrega (${kmTxt(geo.quote?.km ?? '?')}).`);
        }
        const r = await rpc('place_order', { p_slug: slug, p: {
          customer, fulfillment: TABLE ? 'table' : t.pickup ? 'pickup' : 'delivery', ...(TABLE ? { table: TABLE } : {}), zoneId: zoneNow?.id, address: addr, payment: $('#kPay').value,
          ...(DIST && !t.pickup ? { lat: geo.lat, lng: geo.lng } : {}),
          ...($('#kWhen')?.value ? { scheduledFor: $('#kWhen').value } : {}),
          ...(TABLE && S.service_percent ? { service } : {}),
          ...($('#kCb')?.checked ? { useCashback: true } : {}),
          changeFor: $('#kT').value ? toCents($('#kT').value) : undefined, coupon: coupon?.code,
          items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: c.notes })) } });
        local.set('customer', { ...last, ...customer, ...(email ? { email } : {}), ...(t.pickup || TABLE ? {} : { cep: $('#kCep').value, rua: $('#kRua').value, num: $('#kNum').value, comp: $('#kComp').value }) });
        local.set(lastKey, cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, optText: c.optText, notes: c.notes })));
        rememberOrder({ code: r.code, slug, store: S.name, number: r.number, total: r.total, at: new Date().toISOString() });
        const refC = local.get(`ref:${slug}`, null);
        if (refC && S.referral_reward) { await rpc('apply_referral', { p_order_code: r.code, p_ref: refC }).catch(() => null); local.set(`ref:${slug}`, null); }
        cart = []; saveCart();
        if (r.pix) { $('#kGo').textContent = 'Gerando Pix…'; try { await pixCall({ action: 'create', code: r.code, email }); } catch (err) { toast(err.message); } }
        if (r.card) {
          $('#kGo').textContent = 'Abrindo pagamento…';
          try { const c = await pixCall({ action: 'card', code: r.code, origin: location.origin }); if (c.url) { location.href = c.url; return; } } catch (err) { toast(err.message); }
        }
        closeDlg(); go(`/pedido/${r.code}`);
      } finally { const b = $('#kGo'); if (b) b.disabled = false; }
    });
  };
  app.onclick = attempt(async e => {
    if (e.target.id === 'svc') { service = e.target.checked; paintTotals(); return; }
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.cat) { cat = d.cat; paint(); }
    else if (d.add) builder(products.find(p => p.id === +d.add));
    else if (d.inc) { cart[d.inc].qty++; saveCart(); paint(); }
    else if (d.dec) { if (!--cart[d.dec].qty) cart.splice(d.dec, 1); saveCart(); paint(); }
    else if (b.id === 'cupBtn') {
      const code = $('#cCup').value.trim(); coupon = null;
      if (code) {
        coupon = await rpc('check_coupon', { p_slug: slug, p_code: code });
        if (coupon?.soldOut) { coupon = null; toast('Este cupom já atingiu o limite de usos'); }
        else if (coupon && coupon.minSubtotal && cart.reduce((t, c) => t + c.qty * c.unit, 0) < coupon.minSubtotal) { toast(`Cupom válido a partir de ${brl(coupon.minSubtotal)} em produtos`); coupon = null; }
        else toast(coupon ? `Cupom aplicado${coupon.firstOrderOnly ? ' (válido só na primeira compra)' : ''}` : 'Cupom inválido ou expirado');
      }
      paintTotals();
    }
    else if (b.id === 'checkout') checkout();
    else if (b.id === 'again') orderAgain();
    else if (b.id === 'toCart') $('.cart').scrollIntoView({ behavior: 'smooth' });
    else if (b.id === 'seeReviews') dialog(`<h2>Avaliações</h2><p class="lead" style="margin:0">★ ${String(RV.avg).replace('.', ',')} de 5 · ${RV.count} avaliações</p>
      ${RV.recent.map(r => `<div class="rv"><div class="row between"><b>${esc(r.name)}</b><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span></div>
        <p style="margin:0">${esc(r.comment)}</p>${r.reply ? `<p class="mut" style="margin:0">Resposta da loja: ${esc(r.reply)}</p>` : ''}<span class="mut" style="font-size:13px">${new Date(r.at).toLocaleDateString('pt-BR')}</span></div>`).join('') || '<p class="mut">Ainda sem comentários.</p>'}
      <button class="ghost" data-close>Fechar</button>`);
  });
  app.onchange = e => { if (['cMode', 'cZone'].includes(e.target.id)) paintTotals(); };
  cleanup = () => { app.onclick = app.onchange = null; document.title = 'Balcão'; };
  paint();
}

/* ---------- acompanhamento do pedido ---------- */
// Avisos no celular (Web Push): suporte do navegador e chave pública da plataforma
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function pushSubscribe(code, key) {
  if (Notification.permission === 'denied') throw new Error('Os avisos estão bloqueados no navegador. Libere nas configurações do site.');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Sem permissão para avisos');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0)) });
  const ok = await rpc('push_subscribe', { p_code: code, p_sub: sub.toJSON() });
  if (!ok) throw new Error('Este pedido já foi encerrado');
}
async function vTrack(code) {
  let lastSig = '', rating = 0, pushKey = null, REF, LIVE = null, liveAt = 0;
  // Entregador ao vivo: posição a cada 15 s enquanto o pedido está em rota
  const paintLive = () => {
    const el = $('#tMap'); if (!el) return;
    if (!LIVE) { el.hidden = true; $('#tMapInfo').textContent = 'O entregador ainda não ligou a localização. Assim que ligar, ele aparece aqui no mapa.'; return; }
    const pts = [{ lat: LIVE.lat, lng: LIVE.lng, kind: 'moto', label: 'Entregador' }, ...(LIVE.dest ? [{ ...LIVE.dest, kind: 'home', label: 'Você' }] : [])];
    drawMap(el, pts);
    const km = LIVE.dest ? kmBetween([LIVE.lat, LIVE.lng], [LIVE.dest.lat, LIVE.dest.lng]) : null, ago = Math.max(0, Math.round((Date.now() - new Date(LIVE.at)) / 1000));
    $('#tMapInfo').innerHTML = `🛵 ${km != null ? `A cerca de <b>${km < 1 ? Math.round(km * 1000) + ' m' : kmTxt(Math.round(km * 10) / 10)}</b> de você · ` : ''}${LIVE.stopsBefore ? `${LIVE.stopsBefore} entrega(s) antes da sua · ` : ''}atualizado há ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`}`;
  };
  const pollLive = async () => {
    if (!$('#tMap') || Date.now() - liveAt < 14000) return;
    liveAt = Date.now();
    try { LIVE = await rpc('track_courier', { p_code: code }); } catch { LIVE = null; }
    paintLive();
  };
  rpc('my_referral', { p_code: code }).then(r => { REF = r; if (r) draw(true).catch(() => {}); }).catch(() => { REF = null; });
  const refLink = () => `${location.origin}/loja/${REF.slug}?indica=${REF.code}`;
  const refBox = o => !REF || o.status === 'cancelado' ? '' : `<div class="loyal refbox"><b>🎁 Indique e ganhe ${brl(REF.reward)}</b>
    <span>Mande seu link para um amigo que ainda não comprou aqui. Quando o 1º pedido dele for entregue, <b>vocês dois</b> ganham ${brl(REF.reward)} de crédito para usar na loja (vale ${REF.days} dias).</span>
    <span class="row"><button class="pri sm" id="refWa">Enviar no WhatsApp</button><button class="ghost sm" id="refCopy">Copiar link</button></span>
    ${REF.friends ? `<span class="mut">Amigos que já pediram: <b>${REF.friends}</b> · você ganhou <b>${brl(REF.earned)}</b></span>` : ''}</div>`;
  if (pushSupported()) rpc('push_public_key').then(k => { pushKey = k || null; if (pushKey) draw(true).catch(() => {}); }).catch(() => {});
  const pushBox = o => {
    if (!pushKey || ['entregue', 'cancelado', 'pagamento'].includes(o.status)) return '';
    if (local.get(`push:${code}`, false)) return '<p class="mut pushbox">🔔 Avisos ligados neste aparelho: você recebe uma notificação quando o pedido mudar.</p>';
    if (isIOS() && !isStandalone()) return '<p class="mut pushbox">🔔 No iPhone, para receber avisos: toque em Compartilhar → <b>Adicionar à Tela de Início</b> e abra o pedido por lá.</p>';
    return '<div class="pushbox"><button class="ghost" id="pushOn">🔔 Me avise no celular quando o pedido mudar</button></div>';
  };
  const draw = async (force) => {
    const r = await rpc('track_order', { p_code: code });
    if (!r) throw new Error('Pedido não encontrado');
    const { store: S, order: o } = r;
    const sig = JSON.stringify(r);
    if (!force && sig === lastSig) return o.status;
    lastSig = sig;
    if (o.status === 'pagamento') { o.payment === 'Cartão online' ? drawCard(S, o) : drawPix(S, o); return o.status; }
    setColor(S.color); brand(S.name, S.logo_path); header('', false);
    const flow = o.fulfillment !== 'delivery' ? ['novo', 'preparo', 'pronto', 'entregue'] : ['novo', 'preparo', 'pronto', 'rota', 'entregue'];
    const idx = flow.indexOf(o.status), at = Object.fromEntries(o.events.map(e => [e.status, e.at]));
    app.innerHTML = `<h2>Pedido #${o.number}</h2><p class="lead">Olá, ${esc(o.customerName)}! Esta página atualiza sozinha.</p>
    ${o.scheduledFor && !['entregue', 'cancelado'].includes(o.status) ? `<p class="banner" style="margin:0 0 16px;max-width:760px">Pedido <b>agendado para ${esc(fmtWhen(o.scheduledFor))}</b>.</p>` : ''}
    <div class="panel" style="max-width:760px">
      ${o.paymentStatus === 'paid' ? '<span class="badge b-g">Pagamento confirmado</span>' : ''}
      ${o.status === 'cancelado' ? `<span class="badge b-r">${o.paymentStatus === 'expired' ? 'Pedido cancelado: o Pix não foi pago dentro do prazo.' : 'Pedido cancelado pela loja.'}${S.phone ? ' Contato: ' + esc(S.phone) : ''}</span>` :
      `<div class="steps">${flow.map((s, i) => `<span class="${i <= idx ? 'on' : ''}">${s === 'pronto' && o.fulfillment === 'pickup' ? 'Pronto p/ retirar' : s === 'entregue' && o.fulfillment === 'table' ? 'Servido' : SLABEL[s]}${at[s] ? `<br><small>${hhmm(at[s])}</small>` : ''}</span>`).join('')}</div>`}
      ${o.etaAt && !['entregue', 'cancelado', 'pagamento'].includes(o.status) && !(o.fulfillment !== 'delivery' && o.status === 'pronto') ? `<p class="eta">${o.fulfillment === 'delivery' ? 'Previsão de entrega' : o.fulfillment === 'table' ? 'Previsão para servir' : 'Previsão para ficar pronto'}: <b>por volta das ${hhmm(new Date(Math.max(new Date(o.etaAt), Date.now() + 5 * 60000)).toISOString())}</b> <span class="mut">· tempo médio da loja</span></p>` : ''}
      ${o.courier ? `<p><b>${esc(o.courier)}</b> está a caminho de ${esc(o.address)}, ${esc(o.zone)}.</p>` : ''}
      ${o.status === 'rota' && o.fulfillment === 'delivery' ? '<div class="omap" id="tMap" hidden></div><p class="mut" id="tMapInfo" style="margin:6px 0 12px"></p>' : ''}
      ${pushBox(o)}
      <table><tbody>${o.items.map(x => `<tr><td>${x.qty}× ${esc(x.product_name)}${x.options_text ? `<br><span class="mut">${esc(x.options_text)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}</td><td class="n price">${brl(x.qty * x.unit_price)}</td></tr>`).join('')}
      <tr><td>${o.fulfillment === 'pickup' ? 'Retirada na loja' : o.fulfillment === 'table' ? esc(o.zone) : `Entrega (${esc(o.zone)})`}</td><td class="n price">${brl(o.fee)}</td></tr>
      ${o.serviceFee ? `<tr><td>Taxa de serviço</td><td class="n price">${brl(o.serviceFee)}</td></tr>` : ''}
      ${o.discount ? `<tr><td>Desconto ${o.loyaltyDiscount ? 'de fidelidade' : esc(o.coupon || '')}</td><td class="n price">−${brl(o.discount)}</td></tr>` : ''}
      ${o.cashbackUsed ? `<tr><td>Cashback usado</td><td class="n price">−${brl(o.cashbackUsed)}</td></tr>` : ''}
      ${o.promoDiscount ? `<tr><td>Promoção (${esc(o.promoNames || '')})</td><td class="n price">−${brl(o.promoDiscount)}</td></tr>` : ''}
      <tr><td><b>Total · ${esc(o.payment)}</b></td><td class="n price"><b>${brl(o.total)}</b></td></tr></tbody></table>
      ${o.cashback && (o.cashback.willEarn || o.cashback.earned || o.cashback.balance) ? `<div class="loyal"><b>Cashback</b>
        ${o.cashback.willEarn ? `<span>Você vai ganhar <b>${brl(o.cashback.willEarn)}</b> quando o pedido for entregue.</span>` : ''}
        ${o.cashback.earned > 0 ? `<span class="badge b-g">Você ganhou ${brl(o.cashback.earned)} neste pedido!</span>` : ''}
        <span class="mut">Seu saldo nesta loja: <b>${brl(o.cashback.balance)}</b>${o.cashback.balance ? `, para usar em até ${o.cashback.days} dias` : ''}.</span></div>` : ''}
      ${refBox(o)}
      ${o.loyalty ? `<div class="loyal"><b>Cartão fidelidade</b>${o.loyaltyDiscount ? `<span class="badge b-g">Você ganhou ${o.loyalty.percent}% neste pedido!</span>` : ''}
        <div class="stamps">${Array.from({ length: o.loyalty.every }, (_, i) => `<i class="${i < Math.min(o.loyalty.stamps, o.loyalty.every) ? 'on' : ''}"></i>`).join('')}</div>
        <span class="mut">${o.loyalty.stamps >= o.loyalty.every ? `Seu próximo pedido tem ${o.loyalty.percent}% de desconto.` : `${o.loyalty.stamps} de ${o.loyalty.every} pedidos entregues. Faltam ${o.loyalty.every - o.loyalty.stamps} para ganhar ${o.loyalty.percent}% de desconto.`}</span></div>` : ''}
      ${o.canReview ? `<div class="loyal" id="rvBox"><b>Como foi o seu pedido?</b><div class="starpick">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" aria-label="${n} estrela${n > 1 ? 's' : ''}">☆</button>`).join('')}</div>
        <textarea id="rvText" rows="2" maxlength="500" placeholder="Conte o que achou (opcional)"></textarea><button class="pri" id="rvSend" disabled>Enviar avaliação</button></div>` : ''}
      ${o.review ? `<div class="loyal"><b>Sua avaliação</b><span class="stars">${'★'.repeat(o.review.rating)}${'☆'.repeat(5 - o.review.rating)}</span>${o.review.comment ? `<span>${esc(o.review.comment)}</span>` : ''}${o.review.reply ? `<span class="mut">Resposta da loja: ${esc(o.review.reply)}</span>` : ''}</div>` : ''}
      <div class="row"><a class="btn ghost" href="/loja/${esc(S.slug)}" data-link>Voltar à loja</a>${['entregue', 'cancelado'].includes(o.status) && o.fulfillment !== 'table' ? `<a class="btn pri" href="/loja/${esc(S.slug)}?repetir=1" data-link>↻ Pedir de novo</a>` : ''}</div></div>`;
    paintLive();
    return o.status;
  };
  // Pagamento com cartão: o Mercado Pago cuida dos dados do cartão; aqui só o botão para pagar e a conferência.
  const drawCard = (S, o) => {
    setColor(S.color); brand(S.name, S.logo_path); header('', false);
    app.innerHTML = `<h2>Pague com cartão</h2><p class="lead">Pedido #${o.number} · ${esc(S.name)} — assim que o pagamento for aprovado, ele vai direto para o preparo. Esta página atualiza sozinha.</p>
    <div class="panel pix" style="max-width:560px">
      <div class="tot"><span>Total</span><span class="price">${brl(o.total)}</span></div>
      <p class="mut" style="margin:0">Você será levado ao ambiente seguro do Mercado Pago para digitar o cartão. A loja não vê os dados do seu cartão.</p>
      <button class="pri" id="cardPay">Pagar ${brl(o.total)} com cartão</button>
      <button class="ghost" id="pixCheck">Já paguei</button>
      <p class="mut" style="margin:0">Cartão recusado? Tente outro cartão pelo mesmo botão. Sem pagamento, o pedido é cancelado em 45 minutos.</p>
    </div>`;
  };
  // Tela de pagamento: QR Code, copia-e-cola, prazo e botão "Já paguei"
  const drawPix = (S, o) => {
    setColor(S.color); brand(S.name, S.logo_path); header('', false);
    const left = o.pix?.expiresAt ? Math.max(0, Math.round((new Date(o.pix.expiresAt) - Date.now()) / 60000)) : null;
    app.innerHTML = `<h2>Pague com Pix</h2><p class="lead">Pedido #${o.number} · ${esc(S.name)} — assim que o pagamento cair, ele vai direto para o preparo. Esta página atualiza sozinha.</p>
    <div class="panel pix" style="max-width:560px">
      <div class="tot"><span>Total</span><span class="price">${brl(o.total)}</span></div>
      ${o.pix ? `${o.pix.qrBase64 ? `<img class="qr" src="data:image/png;base64,${esc(o.pix.qrBase64)}" alt="QR Code do Pix">` : ''}
        <label>Pix copia e cola<textarea id="pixCode" readonly rows="3">${esc(o.pix.qr)}</textarea></label>
        <button class="pri" id="pixCopy">Copiar código Pix</button>
        <p class="mut" style="margin:0">Abra o app do seu banco, escolha Pix → QR Code ou "copia e cola". ${left != null ? `O código vale por mais ${left} min.` : ''}</p>
        <button class="ghost" id="pixCheck">Já paguei</button>`
      : `<p>Gere o código Pix para pagar.</p><label>E-mail (para o comprovante)<input id="pixEmail" type="email" value="${esc(local.get('customer', {}).email || '')}"></label><button class="pri" id="pixNew">Gerar Pix</button>`}
    </div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.star) { rating = +b.dataset.star; document.querySelectorAll('[data-star]').forEach(x => { x.textContent = +x.dataset.star <= rating ? '★' : '☆'; x.classList.toggle('on', +x.dataset.star <= rating); }); $('#rvSend').disabled = false; return; }
    if (b.id === 'refCopy') { await navigator.clipboard.writeText(refLink()).then(() => toast('Link copiado'), () => prompt('Copie o link:', refLink())); return; }
    if (b.id === 'refWa') return window.open(`https://wa.me/?text=${encodeURIComponent(`Experimenta pedir aqui e ganhe ${brl(REF.reward)} de crédito no seu primeiro pedido: ${refLink()}`)}`, '_blank', 'noopener');
    if (b.id === 'pushOn') { b.disabled = true; try { await pushSubscribe(code, pushKey); local.set(`push:${code}`, true); toast('Pronto! Você vai receber os avisos deste pedido'); await draw(true); } finally { b.disabled = false; } return; }
    if (b.id === 'rvSend') { b.disabled = true; try { await rpc('review_order', { p_code: code, p_rating: rating, p_comment: $('#rvText').value }); toast('Obrigado pela avaliação!'); await draw(true); } finally { b.disabled = false; } return; }
    if (b.id === 'pixCopy') { const ta = $('#pixCode'); try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); } toast('Código copiado. Cole no app do banco.'); }
    if (b.id === 'cardPay') { b.disabled = true; try { const c = await pixCall({ action: 'card', code, origin: location.origin }); if (c.url) location.href = c.url; else await draw(true); } finally { b.disabled = false; } return; }
    if (b.id === 'pixNew') { b.disabled = true; try { await pixCall({ action: 'create', code, email: $('#pixEmail').value }); await draw(true); } finally { b.disabled = false; } }
    if (b.id === 'pixCheck') { b.disabled = true; try { const r = await pixCall({ action: 'check', code }); toast(r.paid ? 'Pagamento confirmado!' : 'Ainda não caiu. Pode levar alguns segundos.'); await draw(true); } finally { b.disabled = false; } }
  });
  // Voltou do Mercado Pago: confere o pagamento na hora, sem esperar o aviso.
  if (/[?&](payment_id|collection_id|status)=/.test(location.search)) {
    history.replaceState(null, '', location.pathname);
    try { const r = await pixCall({ action: 'check', code }); if (r.paid) toast('Pagamento aprovado!'); } catch {}
  }
  const st = await draw(true);
  if (!['entregue', 'cancelado'].includes(st)) {
    const h = setInterval(async () => { try { if (['entregue', 'cancelado'].includes(await draw())) clearInterval(h); pollLive(); } catch {} }, 5000);
    pollLive();
    cleanup = () => { clearInterval(h); app.onclick = null; };
  } else cleanup = () => { app.onclick = null; };
}

/* ================= PAINEL DA EMPRESA ================= */
async function vPanel(tab) {
  const S = ME.tenant, owner = ME.role === 'owner';
  setColor(S.color); brand(S.name, S.logo_path);
  const tabs = [['pedidos', S.seg?.prep || 'Preparo'], ['entregas', 'Entregas'], ...(S.allow_tables ? [['garcom', 'Garçom'], ['mesas', 'Mesas']] : []), ['cardapio', 'Cardápio'], ['estoque', 'Estoque'], ['caixa', 'Caixa'], ...(owner ? [['clientes', 'Clientes'], ['relatorios', 'Relatórios'], ['unidades', 'Unidades'], ['config', 'Configurações']] : [])];
  if (tab === 'kds') return pKitchenScreen(S);
  if (tab === 'totem') return pKiosk(S);
  if (!tabs.some(t => t[0] === tab) && tab !== 'novo') tab = 'pedidos';
  $('#banner').innerHTML = billingBanner(S, owner);
  header(tabs.map(([k, n]) => `<a href="/painel/${k}" data-link class="${k === tab ? 'on' : ''}">${esc(n)}</a>`).join('') + `<a href="/loja/${S.slug}" target="_blank" rel="noopener">Ver loja ↗</a>` + (ME.isAdmin ? '<a href="/plataforma" data-link>Plataforma</a>' : ''));
  await ({ pedidos: pOrders, entregas: pDelivery, cardapio: pMenu, caixa: pCash, novo: pNewOrder, clientes: pCustomers, relatorios: pReports, unidades: pUnits, config: pConfig, mesas: pTables, garcom: pWaiter, estoque: pStock })[tab](S, owner);
}

function billingBanner(t, owner) {
  if (!t.billing_status || t.billing_status === 'free') return '';
  const link = owner ? ' <a href="/painel/config#assinatura" data-link>Ver assinatura</a>' : ' Avise o dono da loja.';
  if (!billingOk(t)) return `<div class="banner bad">Sua loja <b>não está recebendo pedidos</b>: a assinatura está pendente.${link}</div>`;
  if (t.billing_status === 'trial') { const d = daysUntil(t.trial_ends_at); return `<div class="banner ${d <= 3 ? 'warn' : ''}">Teste grátis: ${d === 0 ? 'termina hoje' : `faltam <b>${d} dia${d > 1 ? 's' : ''}</b>`}.${owner ? ' <a href="/painel/config#assinatura" data-link>Assinar agora</a>' : ''}</div>`; }
  if (t.billing_status === 'past_due' || t.billing_status === 'canceled') return `<div class="banner warn">${t.billing_status === 'canceled' ? 'Assinatura cancelada' : 'Pagamento da assinatura com problema'}: a loja para de receber pedidos em ${daysUntil(new Date(t.paid_until || t.trial_ends_at).getTime() + 3 * 864e5)} dia(s).${link}</div>`;
  return '';
}

const ORDER_COLS = '*, items:order_items(product_id, product_name, options_text, qty, unit_price, notes), courier:couriers(name)';
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

// Primeiros passos da loja nova (só o dono vê; some quando tudo estiver feito ou ao dispensar)
async function setupSteps(S) {
  const [z, o] = await Promise.all([q(sb.from('zones').select('id').eq('tenant_id', S.id).limit(1)).catch(() => []), q(sb.from('orders').select('id').eq('tenant_id', S.id).limit(1)).catch(() => [])]);
  return [
    { ok: !!(S.phone && S.address), t: 'Telefone e endereço da loja', go: '/painel/config' },
    { ok: local.get(`seen-menu:${S.id}`, false), t: 'Revisar o cardápio (preços, fotos, esgotados)', go: '/painel/cardapio' },
    { ok: !!S.auto_hours, t: 'Horário de funcionamento automático', go: '/painel/config' },
    { ok: z.length > 0 || (S.delivery_mode === 'distance' && (S.distance_tiers || []).length > 0), t: 'Bairros ou distâncias de entrega e taxas', go: '/painel/config' },
    { ok: !!(S.description || S.banner_path), t: 'Vitrine: descrição e foto de capa', go: '/painel/config' },
    { ok: !!(S.pix_online || S.card_online), t: 'Pix ou cartão online (opcional, recomendado)', go: '/painel/config' },
    { ok: o.length > 0, t: 'Fazer um pedido de teste na loja', go: `/loja/${S.slug}`, ext: true },
    { ok: local.get(`shared:${S.id}`, false), t: 'Divulgar o link da loja (WhatsApp, Instagram)', share: true }];
}
async function pOrders(S, owner) {
  let orders = [];
  // Impressão automática: 'off', 'accept' (ao aceitar) ou 'arrive' (assim que o pedido chega). Vale só para este aparelho.
  let pmode = local.get('printMode', local.get('autoPrint', false) ? 'accept' : 'off');
  const printedKey = `printed:${S.id}`;
  const printed = new Set(local.get(printedKey, []));
  const markPrinted = ids => { ids.forEach(id => printed.add(id)); local.set(printedKey, [...printed].slice(-300)); };
  // Aceite automático: o pedido já chega "em preparo"; com impressão ligada (ao aceitar ou ao chegar), imprime na chegada
  let autoAcc = false;
  const loadAuto = () => q(sb.from('tenants').select('auto_accept').eq('id', S.id).single()).then(r => { autoAcc = !!r.auto_accept; }).catch(() => { autoAcc = false; });
  const printArrivals = () => {
    if (pmode === 'off' || (pmode === 'accept' && !autoAcc)) return;
    const fresh = orders.filter(o => !printed.has(o.id) && ((pmode === 'arrive' && o.status === 'novo') || (autoAcc && o.status === 'preparo'))).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    markPrinted(fresh.map(o => o.id));
    fresh.forEach((o, i) => setTimeout(() => printOrder(S, o), i * 3000));
  };
  let lowIng = [];
  const loadLow = () => q(sb.from('ingredients').select('name, stock, min_stock').eq('tenant_id', S.id).gt('min_stock', 0)).then(r => { lowIng = r.filter(i => +i.stock <= +i.min_stock); }).catch(() => {});
  let steps = null;
  const loadSteps = () => owner && !local.get(`setup-done:${S.id}`, false) ? setupSteps(S).then(r => { steps = r.every(x => x.ok) ? null : r; }).catch(() => {}) : null;
  let goal = null; // meta do dia: { goal, total }
  const loadGoal = () => q(sb.from('tenants').select('daily_goal').eq('id', S.id).single())
    .then(async g => { goal = g.daily_goal ? { goal: g.daily_goal, total: (await rpc('cash_report', { p_tenant: S.id })).total } : null; }).catch(() => { goal = null; });
  const load = async () => {
    [orders] = await Promise.all([fetchOrders(S.id, ['novo', 'preparo', 'pronto']), loadLow(), loadGoal(), steps === null && !load.once ? loadSteps() : null, load.once ? null : loadAuto()]);
    if (!load.once && autoAcc) markPrinted(orders.filter(o => o.status === 'preparo').map(o => o.id));   // os que já estavam em preparo ao abrir a tela não são reimpressos
    load.once = true; draw(); printArrivals();
  };
  // Aviso de pedido parado: novo sem aceitar há 5+ min, ou pronto esperando há 15+ min.
  let lastNag = 0;
  const stuck = () => {
    const waiting = orders.filter(o => o.status === 'novo' && !(o.scheduled_for && new Date(o.scheduled_for) - Date.now() > 60 * 60000) && mins(o.created_at) >= 5);
    const ready = orders.filter(o => o.status === 'pronto' && mins(o.updated_at) >= 15);
    const box = $('#stuck'); if (!box) return;
    box.innerHTML = [waiting.length ? `⚠ ${waiting.length === 1 ? `O pedido #${waiting[0].number} está` : `${waiting.length} pedidos estão`} esperando para ser aceito há mais de 5 minutos.` : '',
      ready.length ? `⏱ ${ready.length === 1 ? `O pedido #${ready[0].number} está pronto` : `${ready.length} pedidos estão prontos`} há mais de 15 minutos${ready.some(o => o.fulfillment === 'delivery') ? ' esperando entregador' : ''}.` : ''].filter(Boolean).map(t => `<div>${t}</div>`).join('');
    box.hidden = !box.innerHTML;
    if (waiting.length && Date.now() - lastNag > 60000) { lastNag = Date.now(); beep(); }
  };
  const tick = setInterval(() => { if (!app.contains(document.activeElement) || document.activeElement.tagName !== 'SELECT') draw(); }, 30000);
  const draw = () => {
    const cols = [['novo', 'Novos', 'Aceitar', 'preparo'], ['preparo', 'Em preparo', 'Marcar pronto', 'pronto'], ['pronto', 'Prontos', '', '']];
    const isLater = o => o.scheduled_for && o.status === 'novo' && new Date(o.scheduled_for) - Date.now() > 60 * 60000;
    const later = orders.filter(isLater).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for)), soon = orders.filter(o => !isLater(o));
    app.innerHTML = `<div class="row between"><div><h2>${esc(S.seg?.prep || 'Preparo')}</h2><p class="lead">Pedidos chegam aqui na hora, com aviso sonoro. Tickets com mais de 25 min ficam em alerta.</p></div>
      <span class="row"><label class="chk" style="gap:6px">Imprimir comanda <select id="printMode" style="width:auto;min-height:36px;padding:4px 8px">${[['off', 'só no botão'], ['accept', 'ao aceitar'], ['arrive', 'assim que chegar']].map(([v, t]) => `<option value="${v}" ${v === pmode ? 'selected' : ''}>${t}</option>`).join('')}</select></label>${stationList(S).length > 1 ? `<select id="printStation" aria-label="O que imprimir" style="width:auto;min-height:36px;padding:4px 8px">${[['all', 'pedido completo'], ['split', 'uma comanda por estação'], ...stationList(S).map(n => [n, 'só ' + n])].map(([v, t]) => `<option value="${esc(v)}" ${v === local.get('printStation', 'all') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}<button class="ghost sm" id="printHelp" title="Imprimir sem abrir a janela">?</button><a class="btn ghost" href="/painel/kds" data-link>Tela da cozinha</a><a class="btn ghost" href="/chamada/${esc(S.slug)}" target="_blank" rel="noopener" title="Abra numa TV voltada para os clientes">Painel de chamada</a><a class="btn pri" href="/painel/novo" data-link>+ Novo pedido</a></span></div>
    ${later.length ? `<div class="panel sched"><h3>Agendados para mais tarde (${later.length})</h3><div class="row">${later.map(o => `<span class="badge b-a" title="${esc(o.customer_name)}">${esc(fmtWhen(o.scheduled_for, S.timezone))} · #${o.number} · ${esc(where(o))}</span>`).join('')}</div>
      <p class="mut" style="margin:0">Eles entram nas colunas 1 hora antes do horário marcado.</p></div>` : ''}
    <div class="stuck" id="stuck" role="alert" hidden></div>
    ${goal ? `<div class="goal"><span>Meta do dia: <b class="price">${brl(goal.total)}</b> de ${brl(goal.goal)}${goal.total >= goal.goal ? ' 🎉 batida!' : ` · faltam ${brl(goal.goal - goal.total)}`}</span><div class="progress"><i style="width:${Math.min(100, goal.total / goal.goal * 100)}%"></i></div></div>` : ''}
    ${steps ? `<div class="panel setup"><div class="row between"><h3 style="margin:0">Primeiros passos · ${steps.filter(x => x.ok).length} de ${steps.length}</h3><button class="ghost sm" id="setupHide">Dispensar</button></div>
      <div class="progress"><i style="width:${steps.filter(x => x.ok).length / steps.length * 100}%"></i></div>
      <ol class="steps2">${steps.map(x => `<li class="${x.ok ? 'done' : ''}">${x.ok ? '✓' : '○'} ${x.share ? `<a href="#" data-share="1">${esc(x.t)}</a>` : `<a href="${esc(x.go)}" ${x.ext ? 'target="_blank" rel="noopener"' : 'data-link'}>${esc(x.t)}</a>`}</li>`).join('')}</ol></div>` : ''}
    ${lowIng.length ? `<a class="activeorder" href="/painel/estoque" data-link style="margin-bottom:12px">⚠ ${lowIng.length} insumo(s) acabando: <b>${lowIng.slice(0, 4).map(i => esc(i.name)).join(', ')}</b>${lowIng.length > 4 ? '…' : ''} · ver estoque →</a>` : ''}
    ${'paused_until' in S ? `<div class="pausebar">${S.paused_until && new Date(S.paused_until) > Date.now()
        ? `<span class="badge b-r">⏸ Loja pausada até ${hhmm(S.paused_until)}</span><button class="ok sm" data-pause="store" data-min="0">Retomar agora</button>`
        : `<span class="mut">Pausar loja:</span>${[15, 30, 60].map(m => `<button class="ghost sm" data-pause="store" data-min="${m}">${m} min</button>`).join('')}`}
      <span class="sep"></span>${deliveryPaused(S)
        ? `<span class="badge b-a">Entregas pausadas até ${hhmm(S.delivery_paused_until)}</span><button class="ok sm" data-pause="delivery" data-min="0">Retomar entregas</button>`
        : `<span class="mut">Pausar só entregas:</span>${[30, 60].map(m => `<button class="ghost sm" data-pause="delivery" data-min="${m}">${m} min</button>`).join('')}`}</div>` : ''}
    ${(() => { const old = orders.filter(o => Date.now() - new Date(o.scheduled_for || o.created_at) > 12 * 3600e3); return old.length ? `<div class="panel" style="margin-bottom:14px"><b>${old.length} pedido(s) de dias anteriores ainda abertos</b> <span class="mut">(mais de 12 horas, de #${Math.min(...old.map(o => o.number))} a #${Math.max(...old.map(o => o.number))}). Provavelmente foram entregues e ninguém marcou.</span>
      <div class="row" style="margin-top:8px"><button class="ok sm" data-stale="entregue">Marcar todos como entregues</button><button class="ghost sm" data-stale="cancelado">Cancelar todos</button></div></div>` : ''; })()}
    <div class="board">${cols.map(([k, t, a, next]) => { const os = soon.filter(o => o.status === k).sort((x, y) => new Date(x.scheduled_for || x.created_at) - new Date(y.scheduled_for || y.created_at));
      return `<div class="col"><h3>${t}<span class="badge">${os.length}</span></h3>${os.map(o => `<div class="tk ${!o.scheduled_for && mins(o.created_at) > 25 ? 'late' : ''}">
        <div class="top"><span>#${o.number}</span><span class="price">${o.scheduled_for ? `<span class="badge b-a">⏰ ${hhmmTz(o.scheduled_for, S.timezone)}</span>` : `${mins(o.created_at)} min`}</span></div>
        <span class="mut">${o.fulfillment === 'table' ? `<span class="badge b-a">MESA ${esc(o.table_label)}</span> ` : ''}${o.channel && o.channel !== 'online' && o.channel !== 'mesa' ? `<span class="badge">${CHANNEL[o.channel]}</span> ` : ''}${esc(o.customer_name)} · ${esc(where(o))} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''}</span>
        ${o.payment_status === 'paid' ? '<span><span class="badge b-g">PAGO ONLINE</span></span>' : ''}
        ${itemsList(o)}<b class="price">${brl(o.total)}</b>
        <div class="row">${a ? `<button class="ok sm" data-st="${next}" data-id="${o.id}">${a}</button>` : o.fulfillment === 'delivery' ? '<span class="badge b-g">Aguardando entregador</span>' : `<button class="ok sm" data-st="entregue" data-id="${o.id}">${o.fulfillment === 'table' ? 'Servido' : 'Cliente retirou'}</button>`}
        ${k !== 'pronto' ? `<button class="ghost sm" data-st="cancelado" data-id="${o.id}">${k === 'novo' ? 'Recusar' : 'Cancelar'}</button>` : ''}
        <button class="ghost sm" data-print="${o.id}">Imprimir</button>${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)))}</div></div>`).join('') || '<p class="empty">Nada aqui</p>'}</div>`; }).join('')}</div>`;
    stuck();
  };
  app.onclick = attempt(async e => {
    const pr = e.target.closest('button[data-print]');
    if (pr) return printOrder(S, orders.find(o => o.id === +pr.dataset.print));
    if (e.target.closest('#setupHide')) { local.set(`setup-done:${S.id}`, true); steps = null; return draw(); }
    if (e.target.closest('[data-share]')) {
      e.preventDefault(); const link = storeLink(S), msg = `Peça pela nossa loja online: ${link}`;
      local.set(`shared:${S.id}`, true); steps = await setupSteps(S); if (steps.every(x => x.ok)) steps = null; draw();
      try { if (navigator.share) return await navigator.share({ title: S.name, text: msg, url: link }); } catch {}
      try { await navigator.clipboard.writeText(link); toast('Link copiado. Cole no WhatsApp e no Instagram.'); } catch { toast(link); }
      return;
    }
    const pz = e.target.closest('button[data-pause]');
    if (pz) { const r = await rpc('set_pause', { p_tenant: S.id, p_kind: pz.dataset.pause, p_minutes: +pz.dataset.min });
      S.paused_until = r.pausedUntil; S.delivery_paused_until = r.deliveryPausedUntil;
      toast(+pz.dataset.min ? `${pz.dataset.pause === 'store' ? 'Loja pausada' : 'Entregas pausadas'} por ${pz.dataset.min} min. Volta sozinha.` : 'Retomado'); return draw(); }
    const sb2 = e.target.closest('button[data-stale]');
    if (sb2) { if (sb2.dataset.stale === 'cancelado' && !sure(sb2)) return; const n = await rpc('close_stale_orders', { p_tenant: S.id, p_hours: 12, p_status: sb2.dataset.stale }); toast(`${n} pedido(s) encerrado(s)`); return load(); }
    if (e.target.closest('#printHelp')) return dialog(`<h2>Imprimir sem a janela de impressão</h2>
      <p>Por segurança, o navegador sempre mostra a janela de impressão. No computador da loja dá para pular essa janela e imprimir direto na impressora padrão:</p>
      <ol><li>Defina a impressora térmica como <b>impressora padrão</b> do Windows.</li>
      <li>Crie um atalho do Google Chrome na área de trabalho, clique com o botão direito em <b>Propriedades</b> e, no campo <b>Destino</b>, acrescente no final: <code>--kiosk-printing</code></li>
      <li>Feche todas as janelas do Chrome e abra o painel por esse atalho.</li>
      <li>Aqui no Preparo, escolha <b>Imprimir comanda: assim que chegar</b>. Deixe esta tela aberta.</li></ol>
      <p class="mut">A escolha vale só para este aparelho. Pedidos com Pix online são impressos quando o pagamento é confirmado.</p>
      <button class="pri" data-close>Entendi</button>`);
    const b = e.target.closest('button[data-st]'); if (!b) return;
    if (b.dataset.st === 'cancelado' && !sure(b)) return;
    await setStatus(+b.dataset.id, b.dataset.st);
    if (b.dataset.st === 'preparo' && pmode === 'accept' && !printed.has(+b.dataset.id)) { markPrinted([+b.dataset.id]); printOrder(S, orders.find(o => o.id === +b.dataset.id)); }
    await load();
  });
  app.onchange = e => {
    if (e.target.id === 'printStation') { local.set('printStation', e.target.value); return toast('Impressão ajustada neste aparelho'); }
    if (e.target.id !== 'printMode') return;
    pmode = e.target.value; local.set('printMode', pmode);
    if (pmode === 'arrive') { markPrinted(orders.filter(o => o.status === 'novo').map(o => o.id)); toast('Os próximos pedidos serão impressos assim que chegarem'); }
  };
  const stop = live(S.id, p => {
    if (['novo', 'preparo'].includes(p?.new?.status) && !orders.some(o => o.id === p.new.id)) { beep(); toast(`Novo pedido #${p.new.number}${p.new.payment_status === 'paid' ? ' (pago online)' : ''}${p.new.status === 'preparo' ? ' · aceito automaticamente' : ''}`); }
    load().catch(() => {});
  });
  cleanup = () => { stop(); clearInterval(tick); app.onclick = app.onchange = null; };
  await load();
}

// Rota de entregas: ordena as paradas pela mais próxima (a partir da loja) e monta o link do Google Maps.
const kmBetween = (a, b) => { const r = x => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2)); };
// Ordem das paradas a partir de "start" ([lat, lng]): vizinho mais próximo e depois 2-opt (desfaz cruzamentos). pt(x) => [lat, lng]
function orderStops(start, xs, pt) {
  const left = [...xs], out = []; let at = start || (xs[0] && pt(xs[0]));
  while (left.length) { let bi = 0; left.forEach((o, i) => { if (kmBetween(at, pt(o)) < kmBetween(at, pt(left[bi]))) bi = i; }); const [o] = left.splice(bi, 1); out.push(o); at = pt(o); }
  if (!start || out.length < 3) return out;
  const len = r => r.reduce((t, o, i) => t + kmBetween(i ? pt(r[i - 1]) : start, pt(o)), 0);
  let best = out, bestLen = len(out), improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
      const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)], l = len(cand);
      if (l < bestLen - 1e-9) { best = cand; bestLen = l; improved = true; }
    }
  }
  return best;
}
function planRoute(S, os) {
  const geo = os.filter(o => o.dest_lat != null && o.dest_lng != null), rest = os.filter(o => o.dest_lat == null || o.dest_lng == null);
  const start = S.lat != null ? [S.lat, S.lng] : null;
  // Sem coordenadas: agrupa pelo bairro/zona, no fim.
  return [...orderStops(start, geo, o => [o.dest_lat, o.dest_lng]), ...rest.sort((a, b) => String(a.zone_name).localeCompare(String(b.zone_name)))];
}

// Mapa leve (blocos do OpenStreetMap, sem biblioteca). pts: [{ lat, lng, kind: 'moto'|'home'|'store'|'n', label }]
function drawMap(el, pts, { height = 260 } = {}) {
  if (!el) return;
  pts = pts.filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!pts.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const W = el.clientWidth || 600, H = height, T = 256;
  const X = (lng, z) => (lng + 180) / 360 * T * 2 ** z;
  const Y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * T * 2 ** z; };
  let z = 17;
  for (; z > 3; z--) {
    const xs = pts.map(p => X(p.lng, z)), ys = pts.map(p => Y(p.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= W - 70 && Math.max(...ys) - Math.min(...ys) <= H - 70) break;
  }
  const xs = pts.map(p => X(p.lng, z)), ys = pts.map(p => Y(p.lat, z));
  const left = (Math.max(...xs) + Math.min(...xs)) / 2 - W / 2, top = (Math.max(...ys) + Math.min(...ys)) / 2 - H / 2, n = 2 ** z;
  let tiles = '';
  for (let tx = Math.floor(left / T); tx <= Math.floor((left + W) / T); tx++) for (let ty = Math.floor(top / T); ty <= Math.floor((top + H) / T); ty++) {
    if (ty < 0 || ty >= n) continue;
    tiles += `<img src="https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png" alt="" style="left:${Math.round(tx * T - left)}px;top:${Math.round(ty * T - top)}px" loading="lazy" referrerpolicy="strict-origin-when-cross-origin">`;
  }
  const icon = { moto: '🛵', home: '🏠', store: '🏪' };
  const marks = pts.map(p => `<span class="mk mk-${p.kind || 'n'}" style="left:${Math.round(X(p.lng, z) - left)}px;top:${Math.round(Y(p.lat, z) - top)}px" title="${esc(p.label || '')}">${icon[p.kind] || esc(p.label || '•')}</span>`).join('');
  el.style.height = `${H}px`;
  el.innerHTML = `${tiles}${marks}<a class="osm" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>`;
}
// Endereço em texto → coordenadas (com cache no aparelho), para pedidos sem localização exata
async function geocodeText(addr) {
  const k = `geo:${addr}`, c = local.get(k, null); if (c) return c.lat ? c : null;
  try {
    const u = new URL('https://nominatim.openstreetmap.org/search'); u.searchParams.set('format', 'json'); u.searchParams.set('limit', '1'); u.searchParams.set('countrycodes', 'br'); u.searchParams.set('q', addr);
    const j = await (await fetch(u, { headers: { 'Accept-Language': 'pt-BR' } })).json();
    const r = j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : {}; local.set(k, r); return r.lat ? r : null;
  } catch { return null; }
}
const stopOf = o => o.dest_lat != null ? `${o.dest_lat},${o.dest_lng}` : / km$/.test(o.zone_name) ? o.address : `${o.address}, ${o.zone_name}`;
const routeUrl = (S, os) => { const pts = os.map(stopOf), origin = S.lat != null ? `${S.lat},${S.lng}` : (S.address || '');
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving${origin ? `&origin=${encodeURIComponent(origin)}` : ''}&destination=${encodeURIComponent(pts.at(-1))}${pts.length > 1 ? `&waypoints=${encodeURIComponent(pts.slice(0, -1).join('|'))}` : ''}`; };
const routeMsg = (S, os) => `Rota com ${os.length} entregas — ${S.name}\n\n${os.map((o, i) => `${i + 1}) #${o.number} · ${o.customer_name} · ${o.customer_phone}\n${o.address} — ${o.zone_name}\n${o.payment_status === 'paid' ? `JÁ PAGO (${o.payment}) · não cobrar` : `Cobrar: ${o.payment} · ${brl(o.total)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''}`}`).join('\n\n')}\n\nRota no mapa: ${routeUrl(S, os)}`;

// Mensagem de acerto para o entregador (WhatsApp): entregas, taxas e dinheiro a devolver.
const settleMsg = (S, c, day) => `Acerto ${S.name} — ${day.split('-').reverse().join('/')}\n${c.name}\n\nEntregas: ${c.deliveries}${c.onRoute ? ` (+${c.onRoute} em rota)` : ''}\nTaxas de entrega: ${brl(c.fees)}\nDinheiro recebido dos clientes: ${brl(c.cash)}\n${c.cash >= c.fees ? `Devolver à loja: ${brl(c.cash - c.fees)}` : `A loja paga: ${brl(c.fees - c.cash)}`}\n\nPedidos: ${c.orders.map(o => `#${o.number} ${o.status === 'rota' ? '(em rota)' : ''}${o.payment === 'Dinheiro' && o.status === 'entregue' ? ` dinheiro ${brl(o.total)}` : ''}`).join(', ')}`;
async function pDelivery(S) {
  let ready = [], route = [], couriers = [], settle = null, onMap = null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: S.timezone || 'America/Sao_Paulo' });
  let sday = today;
  const picked = new Set();
  const load = async () => {
    [ready, route, couriers, settle] = await Promise.all([fetchOrders(S.id, ['pronto']), fetchOrders(S.id, ['rota']), q(sb.from('couriers').select('id, tenant_id, name, phone, active').eq('tenant_id', S.id).order('id')),
      rpc('courier_settlement', { p_tenant: S.id, p_day: sday }).catch(() => null)]);
    onMap = await rpc('courier_positions', { p_tenant: S.id }).catch(() => null);
    draw();
    if (onMap?.length) drawMap($('#dMap'), [...(S.lat != null ? [{ lat: S.lat, lng: S.lng, kind: 'store', label: S.name }] : []),
      ...onMap.map(c => ({ lat: c.lat, lng: c.lng, kind: 'moto', label: c.name })),
      ...onMap.flatMap(c => c.orders.filter(o => o.lat != null).map(o => ({ lat: o.lat, lng: o.lng, kind: 'n', label: `#${o.number}` })))]);
  };
  const draw = () => {
    const free = couriers.filter(c => c.active);
    const dels = ready.filter(o => o.fulfillment === 'delivery'); [...picked].forEach(id => dels.some(o => o.id === id) || picked.delete(id));
    app.innerHTML = `<h2>Entregas</h2><p class="lead">Despache os pedidos prontos e confirme quando forem entregues. Para levar vários de uma vez, marque os pedidos e monte uma rota.</p>
    <div class="two"><div class="panel"><div class="row between"><h3>Prontos (${ready.length})</h3>${dels.length >= 2 ? `<span class="row"><button class="ghost sm" id="pickAll">${picked.size === dels.length ? 'Desmarcar todos' : 'Marcar todas as entregas'}</button><button class="pri sm" id="mkRoute" ${picked.size >= 2 ? '' : 'disabled'}>Montar rota${picked.size ? ` (${picked.size})` : ''}</button></span>` : ''}</div>
      ${ready.map(o => `<div class="tk"><div class="top"><span>${o.fulfillment === 'delivery' && dels.length >= 2 ? `<input type="checkbox" data-pick="${o.id}" ${picked.has(o.id) ? 'checked' : ''} aria-label="Incluir na rota" style="vertical-align:middle;margin-right:6px">` : ''}#${o.number} · ${esc(o.customer_name)}</span><span class="price">${brl(o.total)}</span></div>
        <span class="mut">${o.fulfillment === 'pickup' ? 'Retirada na loja' : o.fulfillment === 'table' ? `Mesa ${esc(o.table_label)}` : `${esc(o.address)} — ${esc(o.zone_name)}`} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''} · ${esc(o.customer_phone)}</span>
        ${o.fulfillment !== 'delivery' ? `<button class="ok sm" data-st="entregue" data-id="${o.id}">${o.fulfillment === 'table' ? 'Servido na mesa' : 'Cliente retirou'}</button>` : free.length ? `<span class="row" style="flex-wrap:nowrap"><select id="c${o.id}" aria-label="Entregador">${free.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="pri sm" data-st="rota" data-id="${o.id}">Despachar</button></span>` : '<span class="badge b-a">Cadastre ou ative um entregador</span>'}
        <span class="row">${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)), 'Avisar cliente')}${o.fulfillment === 'delivery' ? `<a class="btn ghost sm" href="${esc(mapsUrl(o))}" target="_blank" rel="noopener">Mapa</a>` : ''}</span></div>`).join('') || '<p class="empty">Nenhum pedido pronto</p>'}
    </div><div class="panel"><h3>Em rota (${route.length})</h3>
      ${onMap?.length ? `<div class="omap" id="dMap" hidden></div><p class="mut" style="margin:4px 0 10px">${onMap.map(c => `🛵 <b>${esc(c.name)}</b> · ${c.orders.length} entrega(s) · posição de ${hhmm(c.at)}`).join('<br>')}</p>` : ''}
      ${route.map(o => `<div class="tk go"><div class="top"><span>#${o.number} · ${esc(o.courier?.name || '—')}</span><span class="price">${mins(o.updated_at)} min</span></div><span class="mut">${esc(o.address)} — ${esc(o.zone_name)} · ${esc(o.payment)}</span>
        <span class="row"><button class="ok sm" data-st="entregue" data-id="${o.id}">Confirmar entrega</button>${waBtn(waLink(couriers.find(c => c.id === o.courier_id)?.phone, courierMsg(o)), 'Enviar ao entregador')}${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)), 'Avisar cliente')}</span></div>`).join('') || '<p class="empty">Ninguém na rua agora</p>'}
      ${settle ? `<div class="row between" style="margin-top:8px"><h3 style="margin:0">Acerto do dia</h3><input type="date" id="sDay" value="${sday}" max="${today}" style="width:auto"></div>
        <p class="mut" style="margin:4px 0 8px">Taxas = o que a loja repassa ao entregador. Dinheiro = o que ele recebeu dos clientes e devolve. Considera o modelo comum, em que o entregador fica com a taxa.</p>
        ${settle.length ? `<div class="scroll"><table class="stack"><thead><tr><th>Entregador</th><th class="n">Entregas</th><th class="n">Taxas</th><th class="n">Dinheiro</th><th class="n">Acerto</th><th></th></tr></thead><tbody>
        ${settle.map(c => `<tr><td data-l="Entregador"><b>${esc(c.name)}</b>${c.onRoute ? ` <span class="badge b-a">${c.onRoute} em rota</span>` : ''}</td><td data-l="Entregas" class="n">${c.deliveries}</td><td data-l="Taxas" class="n price">${brl(c.fees)}</td><td data-l="Dinheiro" class="n price">${brl(c.cash)}</td>
          <td data-l="Acerto" class="n"><b class="price">${c.cash >= c.fees ? `devolve ${brl(c.cash - c.fees)}` : `receber ${brl(c.fees - c.cash)}`}</b></td><td data-l="">${waBtn(waLink(c.phone, settleMsg(S, c, sday)), 'Enviar acerto')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty" style="margin:0">Nenhuma entrega com entregador nesse dia.</p>'}` : ''}
      <h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td>${route.some(o => o.courier_id === c.id) ? '<span class="badge b-a">Em rota</span>' : c.active ? '<span class="badge b-g">Disponível</span>' : '<span class="badge">Folga</span>'}</td><td class="n"><button class="ghost sm" data-cour="${c.id}">${c.active ? 'Dar folga' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Cadastre entregadores em Configurações.</td></tr>'}</tbody></table>
    </div></div>`;
  };
  const openRoute = () => {
    const os = planRoute(S, ready.filter(o => picked.has(o.id))), free = couriers.filter(c => c.active);
    if (!free.length) return toast('Cadastre ou ative um entregador primeiro');
    const noGeo = os.filter(o => o.dest_lat == null).length;
    dialog(`<h2>Rota com ${os.length} entregas</h2>
      <p class="mut" style="margin:0">${noGeo === os.length ? 'Ordem pelo bairro (os endereços não têm localização exata).' : `Ordem pela entrega mais próxima, saindo da loja${noGeo ? `. ${noGeo === 1 ? '1 endereço sem localização exata ficou' : `${noGeo} endereços sem localização exata ficaram`} no fim, agrupados por bairro` : ''}.`}</p>
      <ol class="stops">${os.map(o => `<li><b>#${o.number} · ${esc(o.customer_name)}</b><br><span class="mut">${esc(o.address)} — ${esc(o.zone_name)} · ${o.payment_status === 'paid' ? 'já pago' : `cobrar ${brl(o.total)} (${esc(o.payment)})`}</span></li>`).join('')}</ol>
      <a class="btn ghost" href="${esc(routeUrl(S, os))}" target="_blank" rel="noopener">Ver rota no Google Maps</a>
      <label>Entregador<select id="rCour">${free.map(c => `<option value="${c.id}">${esc(c.name)}${route.some(o => o.courier_id === c.id) ? ' (em rota)' : ''}</option>`).join('')}</select></label>
      <div id="rDone"></div>
      <div class="row"><button class="pri" id="rGo">Despachar ${os.length} pedidos</button><button class="ghost" data-close>Cancelar</button></div>`);
    $('#dlgBody').onclick = attempt(async ev => {
      const go = ev.target.closest('#rGo'); if (!go) return;
      go.disabled = true; const cid = +$('#rCour').value, c = couriers.find(x => x.id === cid);
      try { for (const o of os) await setStatus(o.id, 'rota', cid); }
      finally { picked.clear(); load().catch(() => {}); }
      const wa = waLink(c.phone, routeMsg(S, os));
      $('#rDone').innerHTML = `<p class="banner" style="text-align:left;border-radius:12px">✓ ${os.length} pedidos despachados com <b>${esc(c.name)}</b>.</p>`;
      go.outerHTML = wa ? `<a class="btn pri" href="${esc(wa)}" target="_blank" rel="noopener">Enviar rota ao entregador no WhatsApp</a>` : '<span class="mut">O entregador não tem WhatsApp válido cadastrado.</span>';
    });
  };
  app.onchange = e => {
    if (e.target.id === 'sDay' && e.target.value) { sday = e.target.value; return load().catch(err => toast(err.message)); }
    const id = e.target.dataset.pick; if (!id) return; e.target.checked ? picked.add(+id) : picked.delete(+id); draw(); };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'pickAll') { const dels = ready.filter(o => o.fulfillment === 'delivery'); picked.size === dels.length ? picked.clear() : dels.forEach(o => picked.add(o.id)); return draw(); }
    if (b.id === 'mkRoute') return openRoute();
    if (b.dataset.st) {
      await setStatus(+b.dataset.id, b.dataset.st, b.dataset.st === 'rota' ? +$('#c' + b.dataset.id).value : null);
      if (b.dataset.st === 'rota') toast('Despachado. Use “Enviar ao entregador” para mandar o endereço pelo WhatsApp.');
    }
    if (b.dataset.cour) { const c = couriers.find(x => x.id === +b.dataset.cour); await q(sb.from('couriers').update({ active: !c.active }).eq('id', c.id)); }
    await load();
  });
  const stop = live(S.id, () => load().catch(() => {}));
  cleanup = () => { stop(); app.onclick = app.onchange = null; };
  await load();
}

/* ---------- cardápio + editor de grupos de opções ---------- */
// Planilha CSV (Excel/Google Planilhas): separa por ; ou , e entende aspas.
function parseCsv(text) {
  text = text.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/)[0] || '', sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const MENU_HEAD = ['Categoria', 'Produto', 'Descrição', 'Preço', 'Disponível'];
const normHead = h => h.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function menuRowsFromCsv(text) {
  const rows = parseCsv(text); if (rows.length < 2) throw new Error('A planilha precisa do cabeçalho e de pelo menos 1 produto');
  const head = rows[0].map(normHead), col = names => head.findIndex(h => names.includes(h));
  const ci = { cat: col(['categoria', 'category']), name: col(['produto', 'nome', 'name']), desc: col(['descricao', 'description']), price: col(['preco', 'valor', 'price']), av: col(['disponivel', 'ativo', 'available']) };
  if (ci.cat < 0 || ci.name < 0 || ci.price < 0) throw new Error('Cabeçalho precisa ter as colunas Categoria, Produto e Preço');
  return rows.slice(1).map((r, k) => {
    const cell = i => i < 0 ? '' : String(r.at(i) ?? '').trim(), raw = cell(ci.price).replace(/R\$\s*/i, ''), price = toCents(raw);
    const av = cell(ci.av).toLowerCase();
    return { line: k + 2, category: cell(ci.cat), name: cell(ci.name), description: cell(ci.desc), price,
      available: !['nao', 'não', 'n', '0', 'false', 'esgotado', 'inativo'].includes(av),
      error: !cell(ci.cat) || !cell(ci.name) ? 'falta categoria ou nome' : !(Number.isInteger(price) && price >= 0) ? `preço "${cell(ci.price)}" inválido` : '' };
  });
}
async function pMenu(S, owner) {
  let prods = []; local.set(`seen-menu:${S.id}`, true);
  let sugg = null;   // ids marcados como sugestão no carrinho (null = migração ainda não rodou)
  const load = async () => {
    [prods] = await Promise.all([q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id)).then(sortMenu),
      owner ? q(sb.from('products').select('id').eq('tenant_id', S.id).eq('suggest', true)).then(r => { sugg = new Set(r.map(x => x.id)); }).catch(() => { sugg = null; }) : null]);
    draw();
  };
  const draw = () => {
    const cats = [...new Set(prods.map(p => p.category))];
    app.innerHTML = `<div class="row between"><div><h2>Cardápio</h2><p class="lead">${owner ? 'Crie produtos com grupos de opções: tamanhos, sabores, adicionais, combos.' : 'Marque itens esgotados ou ajuste o estoque.'} Estoque em branco = sem controle; com número, baixa a cada pedido e volta se o pedido for cancelado.</p></div>${owner ? '<span class="row"><button class="ghost" id="menuPrint">Imprimir cardápio</button><button class="ghost" id="menuCsv">Baixar planilha</button><button class="ghost" id="menuRep">Reajustar preços</button><label class="btn ghost" style="cursor:pointer">Importar planilha<input type="file" id="menuImp" accept=".csv,text/csv" hidden></label><button class="pri" id="newP">Novo produto</button></span>' : ''}</div>
    ${cats.map(c => `<div class="panel" style="margin-bottom:16px"><div class="row between"><h3>${esc(c)}${(S.category_hours || {})[c] ? ` <span class="badge b-a">${esc(catHoursText(S, c))}</span>` : ''}</h3><span class="row">${owner && 'stations' in S ? `<label class="chk" style="gap:6px;margin:0">Estação <select data-station="${esc(c)}" style="width:auto;min-height:34px;padding:2px 8px">${[...new Set([...stationList(S), 'Bar'])].map(n => `<option ${((S.stations || {})[c] || 'Cozinha') === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new">Outra…</option></select></label>` : ''}${owner && 'category_hours' in S ? `<button class="ghost sm" data-chours="${esc(c)}">Horário da categoria</button>` : ''}${(() => { const ps = prods.filter(p => p.category === c), on = ps.some(p => p.available); return `<button class="ghost sm" data-catav="${esc(c)}" data-to="${on ? 0 : 1}" title="${on ? 'Marca todos os produtos da categoria como esgotados' : 'Volta todos os produtos da categoria'}">${on ? 'Esgotar categoria' : 'Voltar categoria'}</button>`; })()}</span></div><div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th>Opções</th><th class="n">Preço</th><th>Estoque</th><th>Disponível</th><th></th></tr></thead><tbody>
      ${prods.filter(p => p.category === c).map(p => `<tr><td data-l="Produto"><span class="row" style="flex-wrap:nowrap"><span class="thumb">${picture(p, S.color)}</span><span><b>${esc(p.name)}</b><br><span class="mut">${esc(p.description)}</span></span></span></td>
        <td data-l="Opções"><span class="mut">${p.groups.map(g => `${esc(g.name)} (${g.options.length})`).join(', ') || '—'}</span></td><td data-l="Preço" class="n price">${brl(p.price)}</td>
        <td data-l="Estoque"><input class="stockin" type="number" min="0" inputmode="numeric" data-stock="${p.id}" value="${p.stock ?? ''}" placeholder="sem controle" aria-label="Estoque de ${esc(p.name)}">${p.stock === 0 ? ' <span class="badge b-r">zerado</span>' : ''}</td>
        <td data-l="Disponível"><button class="sm ${p.available ? 'ok' : 'ghost'}" data-av="${p.id}">${p.available ? 'Sim' : 'Esgotado'}</button></td>
        <td data-l="">${owner ? `<span class="row" style="flex-wrap:nowrap;gap:6px">${sugg ? `<button class="sm ${sugg.has(p.id) ? 'ok' : 'ghost'}" data-sug="${p.id}" title="Aparece em &quot;Que tal adicionar?&quot; no carrinho da loja">${sugg.has(p.id) ? '★ Sugerido' : '☆ Sugerir'}</button>` : ''}<button class="ghost sm" data-ed="${p.id}">Editar</button></span>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<p class="empty">Nenhum produto ainda.</p>'}`;
  };
  const exportMenu = () => {
    const rows = [MENU_HEAD, ...prods.map(p => [p.category, p.name, p.description || '', fromCents(p.price), p.available ? 'sim' : 'não'])];
    const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `cardapio-${S.slug}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  // Reajuste em lote: mostra a prévia antes de aplicar
  const reprice = () => {
    const cats = [...new Set(prods.map(p => p.category))];
    dialog(`<h2>Reajustar preços</h2><p class="mut" style="margin:0">Aumente ou diminua vários preços de uma vez. Você vê a prévia antes de aplicar. Produtos e opções que custam R$ 0,00 não mudam.</p>
      <form id="rpF" class="grid" style="gap:10px">
        <label>Categoria<select id="rpC"><option value="">Todo o cardápio</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <div class="two" style="gap:10px"><label>Percentual (%)<input id="rpP" inputmode="decimal" placeholder="ex.: 8 ou -5"></label><label>Valor fixo (R$)<input id="rpV" inputmode="decimal" placeholder="ex.: 2,00 ou -1,00"></label></div>
        <label>Arredondar<select id="rpR"><option value="none">Não arredondar</option><option value="90">Terminar em ,90</option><option value="00">Reais inteiros (,00)</option></select></label>
        <label class="chk"><input type="checkbox" id="rpO" checked> Reajustar também as opções pagas (tamanhos, adicionais)</label>
        <div class="row"><button class="ghost">Ver prévia</button></div></form>
      <div id="rpOut"></div>`, true);
    const args = apply => {
      const pct = $('#rpP').value.trim() ? +$('#rpP').value.trim().replace(',', '.') : 0;
      const v = $('#rpV').value.trim(), neg = v.startsWith('-'), fixed = v ? (neg ? -1 : 1) * toCents(v.replace(/^[-+]/, '')) : 0;
      if (!Number.isFinite(pct)) throw new Error('Percentual inválido');
      if (!Number.isInteger(fixed)) throw new Error('Valor fixo inválido');
      return { p_tenant: S.id, p_category: $('#rpC').value || null, p_percent: pct, p_fixed: fixed, p_round: $('#rpR').value, p_options: $('#rpO').checked, p_apply: apply };
    };
    $('#dlgBody').onsubmit = attempt(async e => {
      e.preventDefault();
      const r = await rpc('bulk_reprice', args(false));
      $('#rpOut').innerHTML = r.count ? `<p style="margin:12px 0 6px"><b>${r.count}</b> preço(s) vão mudar${r.count > r.items.length ? ` (mostrando ${r.items.length})` : ''}:</p>
        <div class="scroll" style="max-height:260px"><table><thead><tr><th>Item</th><th class="n">Antes</th><th class="n">Depois</th></tr></thead><tbody>${r.items.map(i => `<tr><td>${i.kind === 'opção' ? '<span class="mut">opção · </span>' : ''}${esc(i.name)}</td><td class="n mut">${brl(i.old)}</td><td class="n price"><b>${brl(i.new)}</b></td></tr>`).join('')}</tbody></table></div>
        <div class="row" style="margin-top:10px"><button class="pri" id="rpGo">Aplicar reajuste</button><button class="ghost" data-close>Cancelar</button></div>` : '<p class="mut">Nenhum preço muda com esses valores.</p>';
    });
    $('#dlgBody').onclick = attempt(async e => {
      const go = e.target.closest('#rpGo'); if (!go) return; go.disabled = true;
      try { const r = await rpc('bulk_reprice', args(true)); closeDlg(); toast(`${r.count} preço(s) reajustado(s)`); await load(); } finally { go.disabled = false; }
    });
    $('#dlgBody').onchange = () => { if ($('#rpOut')) $('#rpOut').innerHTML = ''; };   // mudou algo: precisa ver a prévia de novo
  };
  const importMenu = async file => {
    if (file.size > 1024 * 1024) throw new Error('Planilha grande demais (máx. 1 MB)');
    const rows = menuRowsFromCsv(await file.text()), bad = rows.filter(r => r.error);
    const key = r => `${r.category.toLowerCase()}|${r.name.toLowerCase()}`, have = new Set(prods.map(key));
    const nNew = rows.filter(r => !r.error && !have.has(key(r))).length, nUpd = rows.filter(r => !r.error && have.has(key(r))).length;
    dialog(`<h2>Importar cardápio</h2><p style="margin:0"><b>${nNew}</b> produto(s) novo(s) e <b>${nUpd}</b> atualizado(s) (preço, descrição e disponibilidade).</p>
      <p class="mut" style="margin:0">Produtos são reconhecidos pelo nome dentro da categoria. Opções, fotos e estoque não mudam. Produtos que não estão na planilha continuam como estão.</p>
      ${bad.length ? `<p class="stuck" style="display:block">Corrija antes de importar:<br>${bad.slice(0, 8).map(r => `linha ${r.line}: ${esc(r.error)}`).join('<br>')}${bad.length > 8 ? `<br>e mais ${bad.length - 8}…` : ''}</p>` : ''}
      <div class="scroll" style="max-height:240px"><table><tbody>${rows.slice(0, 12).map(r => `<tr><td>${esc(r.category)}</td><td><b>${esc(r.name)}</b></td><td class="n price">${Number.isInteger(r.price) ? brl(r.price) : '?'}</td><td>${have.has(key(r)) ? '<span class="badge">atualiza</span>' : '<span class="badge b-g">novo</span>'}</td></tr>`).join('')}</tbody></table></div>
      ${rows.length > 12 ? `<p class="mut" style="margin:0">e mais ${rows.length - 12} linha(s)…</p>` : ''}
      <div class="row"><button class="pri" id="impGo" ${bad.length ? 'disabled' : ''}>Importar ${rows.length} linha(s)</button><button class="ghost" data-close>Cancelar</button></div>`);
    $('#dlgBody').onclick = attempt(async ev => {
      const go = ev.target.closest('#impGo'); if (!go) return; go.disabled = true;
      try { const r = await rpc('import_menu', { p_tenant: S.id, p_rows: rows.map(({ category, name, description, price, available }) => ({ category, name, description, price, available })) });
        closeDlg(); toast(`${r.created} criado(s), ${r.updated} atualizado(s)`); await load(); } finally { go.disabled = false; }
    });
  };
  const editor = p => {
    const cats = [...new Set(prods.map(x => x.category))];
    const st = p ? JSON.parse(JSON.stringify(p)) : { category: cats[0] || '', name: '', description: '', price: 0, icon: 'box', available: true, image_path: null, groups: [] };
    const uploaded = [];
    const readForm = () => {
      st.name = $('#eN').value; st.category = $('#eC').value; st.description = $('#eD').value; st.price = toCents($('#eP').value); st.icon = $('#eI').value;
      st.groups.forEach((g, i) => { g.name = $(`#gN${i}`).value; g.min_sel = +$(`#gMin${i}`).value; g.max_sel = +$(`#gMax${i}`).value;
        g.options.forEach((o, k) => { o.name = $(`#o${i}_${k}`).value; o.price = toCents($(`#op${i}_${k}`).value || '0'); }); });
    };
    const drawEd = () => dialog(`<h2>${p ? 'Editar produto' : 'Novo produto'}</h2><form id="fEd" class="grid" novalidate>
      <div class="two" style="gap:10px"><label>Nome<input id="eN" required value="${esc(st.name)}"></label><label>Categoria<input id="eC" list="catl" required value="${esc(st.category)}"><datalist id="catl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
      <label>Descrição<input id="eD" value="${esc(st.description)}" maxlength="200"></label>
      <div class="two" style="gap:10px"><label>Preço base (R$)<input id="eP" inputmode="decimal" required value="${fromCents(st.price)}"></label><label>Ilustração (sem foto)<select id="eI">${ICONS.map(i => `<option ${i === st.icon ? 'selected' : ''}>${i}</option>`).join('')}</select></label></div>
      <div class="photo"><div class="ph">${st.image_path ? `<img src="${esc(imgUrl(st.image_path))}" alt="">` : art(st.icon, S.color)}</div>
        <div class="grid" style="gap:6px"><label>Foto do produto<input type="file" id="eImg" accept="image/jpeg,image/png,image/webp"></label>
        <span class="mut">JPG, PNG ou WebP. A foto é reduzida automaticamente antes de enviar.</span>
        ${st.image_path ? '<button type="button" class="ghost sm" id="rmImg">Remover foto</button>' : ''}</div></div>
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
      else if (b.id === 'rmImg') { st.image_path = null; drawEd(); }
      else if (b.id === 'eX') { closeDlg(); if (uploaded.length) sb.storage.from(BUCKET).remove(uploaded).catch(() => {}); }
      else if (b.id === 'delP') { if (!sure(b)) return; await q(sb.from('products').delete().eq('id', p.id)); const old = [...uploaded, p.image_path].filter(Boolean); if (old.length) sb.storage.from(BUCKET).remove(old).catch(() => {}); closeDlg(); toast('Produto excluído'); await load(); }
    });
    $('#dlgBody').onchange = attempt(async e => {
      if (e.target.id !== 'eImg' || !e.target.files[0]) return;
      readForm(); toast('Enviando foto…');
      const blob = await shrinkImage(e.target.files[0]);
      const path = `${S.id}/${crypto.randomUUID()}.jpg`;
      await q(sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }));
      uploaded.push(path); st.image_path = path; drawEd(); toast('Foto pronta. Clique em Salvar.');
    });
    $('#dlgBody').onsubmit = attempt(async e => {
      e.preventDefault(); readForm();
      if (!Number.isInteger(st.price) || st.price < 0) throw new Error('Preço base inválido');
      if (st.groups.some(g => g.options.some(o => !Number.isInteger(o.price) || o.price < 0))) throw new Error('Preço de opção inválido');
      const body = { category: st.category, name: st.name, description: st.description, price: st.price, icon: st.icon, available: st.available, image_path: st.image_path,
        groups: st.groups.map(g => ({ name: g.name, min_sel: g.min_sel, max_sel: g.max_sel, options: g.options.filter(o => o.name.trim()).map(o => ({ name: o.name, price: o.price })) })) };
      await rpc('save_product', { p_tenant: S.id, p_id: p?.id ?? null, p: body });
      // apaga do Storage as fotos que deixaram de ser usadas
      const unused = [...uploaded, p?.image_path].filter(x => x && x !== st.image_path);
      if (unused.length) sb.storage.from(BUCKET).remove(unused).catch(() => {});
      closeDlg(); toast('Produto salvo'); await load();
    });
  };
  // Horário da categoria (ex.: café da manhã só de manhã). Vazio = vende o dia todo.
  const hoursEditor = c => {
    const h = (S.category_hours || {})[c] || {};
    dialog(`<h2>Horário: ${esc(c)}</h2><p class="mut" style="margin:0">Fora desse horário os produtos aparecem na loja, mas não podem ser pedidos (a não ser agendando para dentro do horário).</p>
      <form id="fCh"><div class="two" style="gap:10px"><label>Das<input id="chF" type="time" value="${esc(h.from || '')}"></label><label>Até<input id="chT" type="time" value="${esc(h.to || '')}"></label></div>
      <p class="mut" style="margin:0">Dias (nenhum marcado = todos os dias)</p><div class="row">${DAYS.map((d, i) => `<label class="chk"><input type="checkbox" data-chd="${i}" ${h.days?.includes(i) ? 'checked' : ''}> ${d.slice(0, 3)}</label>`).join('')}</div>
      <div class="row"><button class="pri">Salvar</button>${h.from ? '<button type="button" class="ghost" id="chClear">Vender o dia todo</button>' : ''}<button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
    const save = async v => {
      const all = { ...(S.category_hours || {}) }; if (v) all[c] = v; else delete all[c];
      await q(sb.from('tenants').update({ category_hours: all }).eq('id', S.id)); S.category_hours = all; closeDlg(); toast('Horário salvo'); draw();
    };
    $('#dlgBody').onclick = attempt(async ev => { if (ev.target.closest('#chClear')) await save(null); });
    $('#dlgBody').onsubmit = attempt(async ev => {
      ev.preventDefault(); const from = $('#chF').value, to = $('#chT').value;
      if (!from || !to || from === to) return toast('Informe o horário de início e de fim');
      const days = [...document.querySelectorAll('[data-chd]')].filter(x => x.checked).map(x => +x.dataset.chd);
      await save({ from, to, ...(days.length && days.length < 7 ? { days } : {}) });
    });
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.chours) return hoursEditor(b.dataset.chours);
    if (b.id === 'menuCsv') return exportMenu();
    if (b.id === 'menuPrint') { toast('Preparando o cardápio…'); return printMenu(S, prods); }
    if (b.id === 'menuRep') return reprice();
    if (b.dataset.sug) {
      const id = +b.dataset.sug, on = !sugg.has(id);
      await rpc('set_product_suggest', { p_product: id, p_on: on }); on ? sugg.add(id) : sugg.delete(id);
      toast(on ? 'Vai aparecer em "Que tal adicionar?" no carrinho' : 'Removido das sugestões'); return draw();
    }
    if (b.dataset.catav) {
      const c = b.dataset.catav, to = b.dataset.to === '1';
      if (!to && !sure(b)) return;
      const n = await rpc('set_category_availability', { p_tenant: S.id, p_category: c, p_available: to });
      toast(`${c}: ${n} produto(s) ${to ? 'disponíveis de novo' : 'esgotados'}`); return load();
    }
    if (b.id === 'newP') editor(null);
    if (b.dataset.ed) editor(prods.find(p => p.id === +b.dataset.ed));
    if (b.dataset.av) { const p = prods.find(x => x.id === +b.dataset.av); await rpc('set_product_availability', { p_product: p.id, p_available: !p.available }); await load(); }
  });
  app.onchange = attempt(async e => {
    if (e.target.id === 'menuImp') { const f = e.target.files?.[0]; e.target.value = ''; if (f) await importMenu(f); return; }
    const sc = e.target.dataset.station;
    if (sc != null) {
      let v = e.target.value;
      if (v === '__new') { v = (prompt('Nome da estação (ex.: Bar, Confeitaria, Grelha)') || '').trim().slice(0, 30); if (!v) return draw(); }
      const all = { ...(S.stations || {}) }; if (v === 'Cozinha') delete all[sc]; else all[sc] = v;
      await q(sb.from('tenants').update({ stations: all }).eq('id', S.id)); S.stations = all; toast(`${sc} → ${v}`); return draw();
    }
    if (!e.target.dataset.stock) return;
    const v = e.target.value.trim();
    if (v !== '' && !/^\d{1,7}$/.test(v)) throw new Error('Estoque inválido');
    await rpc('set_stock', { p_product: +e.target.dataset.stock, p_stock: v === '' ? null : +v });
    toast(v === '' ? 'Estoque sem controle' : `Estoque: ${v}`); await load();
  });
  cleanup = () => { app.onclick = app.onchange = null; };
  await load();
}

/* ---------- tela da cozinha (KDS): TV ou tablet, tela cheia ---------- */
async function pKitchenScreen(S) {
  document.body.classList.add('kds-on'); setColor(S.color);
  let orders = [], sound = local.get('kdsSound', true), station = local.get('kdsStation', '');
  const cats = await productCats(S.id), stations = stationList(S);
  if (!stations.includes(station)) station = '';
  const mine = o => station ? { ...o, items: o.items.filter(x => itemStation(S, cats, x) === station) } : o;
  const age = o => mins(o.scheduled_for && new Date(o.scheduled_for) < new Date() ? o.scheduled_for : o.created_at);
  const tone = (o, k) => k === 'pronto' ? 'ok' : age(o) >= 20 ? 'bad' : age(o) >= 10 ? 'warn' : 'ok';
  const load = async () => { orders = await fetchOrders(S.id, ['novo', 'preparo', 'pronto']); draw(); };
  const draw = () => {
    const later = o => o.scheduled_for && o.status === 'novo' && new Date(o.scheduled_for) - Date.now() > 60 * 60000;
    const cols = [['novo', 'Novos'], ['preparo', 'Em preparo'], ['pronto', 'Prontos']];
    const act = (o, k) => k === 'novo' ? ['preparo', 'Começar'] : k === 'preparo' ? ['pronto', 'Pronto'] : o.fulfillment === 'delivery' ? null : ['entregue', o.fulfillment === 'table' ? 'Servido' : 'Retirado'];
    app.innerHTML = `<div class="kds"><div class="kbar"><b>${esc(S.name)}</b><span class="kclock">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="row">${stations.length > 1 ? `<select id="kStation" aria-label="Estação">${['', ...stations].map(n => `<option value="${esc(n)}" ${n === station ? 'selected' : ''}>${n ? esc(n) : 'Todas as estações'}</option>`).join('')}</select>` : ''}<button id="kSound">${sound ? 'Som ligado' : 'Som desligado'}</button><button id="kFull">Tela cheia</button><a class="btn" href="/painel" data-link>Sair</a></span></div>
      <div class="kcols">${cols.map(([k, t]) => { const os = orders.map(mine).filter(o => o.status === k && !later(o) && o.items.length).sort((a, b) => new Date(a.scheduled_for || a.created_at) - new Date(b.scheduled_for || b.created_at));
        return `<section><h2>${t} <span>${os.length}</span></h2>${os.map(o => { const a = act(o, k); return `<article class="kt ${tone(o, k)}">
          <header><b>#${o.number}</b><span>${o.scheduled_for ? '⏰ ' + hhmmTz(o.scheduled_for, S.timezone) : age(o) + ' min'}</span></header>
          <div class="kwhere">${o.fulfillment === 'table' ? `MESA ${esc(o.table_label)}` : o.fulfillment === 'pickup' ? 'RETIRADA' : 'ENTREGA'} · ${esc(o.customer_name)}</div>
          <ul>${o.items.map(x => `<li><b>${x.qty}×</b> ${esc(x.product_name)}${x.options_text ? `<small>${esc(x.options_text)}</small>` : ''}${x.notes ? `<em>${esc(x.notes)}</em>` : ''}</li>`).join('')}</ul>
          ${a ? `<button data-st="${a[0]}" data-id="${o.id}">${a[1]}</button>` : '<div class="kwait">Aguardando entregador</div>'}</article>`; }).join('') || '<p class="kempty">—</p>'}</section>`; }).join('')}</div></div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'kFull') { try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch { toast('Tela cheia indisponível neste aparelho'); } return; }
    if (b.id === 'kSound') { sound = !sound; local.set('kdsSound', sound); if (sound) beep(); return draw(); }
    if (b.dataset.st) { b.disabled = true; await setStatus(+b.dataset.id, b.dataset.st); if (b.dataset.st === 'preparo' && local.get('printMode', 'off') === 'accept') printOrder(S, orders.find(o => o.id === +b.dataset.id)); await load(); }
  });
  const stop = live(S.id, p => { if (['novo', 'preparo'].includes(p?.new?.status) && !orders.some(o => o.id === p.new.id) && sound) beep(); load().catch(() => {}); });
  app.onchange = e => { if (e.target.id === 'kStation') { station = e.target.value; local.set('kdsStation', station); draw(); } };
  const tick = setInterval(draw, 20000);
  // mantém a tela acesa em tablets/TVs que suportam
  let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  cleanup = () => { stop(); clearInterval(tick); app.onclick = app.onchange = null; document.body.classList.remove('kds-on'); lock?.release?.().catch(() => {}); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  await load();
}

/* ---------- lançar pedido (balcão, telefone, mesa) ---------- */
async function pNewOrder(S) {
  const [rawP, zones] = await Promise.all([
    q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)),
    q(sb.from('zones').select('id, name, fee').eq('tenant_id', S.id).order('name'))]);
  const products = sortMenu(rawP), DIST = S.delivery_mode === 'distance';
  const qs = new URLSearchParams(location.search), fromWaiter = qs.get('volta') === 'garcom', preTable = S.allow_tables ? qs.get('mesa') : null;
  let cart = [], st = { channel: preTable ? 'mesa' : 'balcao', ful: preTable ? 'table' : 'pickup', table: preTable || '1', name: '', phone: '', zone: zones[0]?.id || null, cep: '', rua: '', num: '', comp: '', pay: 'Pagar no caixa', change: '', term: '' }, geo = null, cepInfo = null;
  const sub = () => cart.reduce((t, c) => t + c.qty * c.unit, 0);
  const fee = () => st.ful !== 'delivery' ? 0 : DIST ? (geo?.quote?.fee || 0) : (zones.find(z => z.id === +st.zone)?.fee || 0);
  const read = () => { for (const k of ['name', 'phone', 'table', 'zone', 'cep', 'rua', 'num', 'comp', 'pay', 'change', 'term']) { const el = $('#n_' + k); if (el) st[k] = el.value; } };
  const draw = () => {
    const list = products.filter(p => !st.term || (p.name + ' ' + p.category).toLowerCase().includes(st.term.toLowerCase()));
    const cats = [...new Set(list.map(p => p.category))];
    app.innerHTML = `<div class="row between"><div><h2>Novo pedido</h2><p class="lead">Lance pedidos do balcão, do telefone ou da mesa. Eles entram direto em preparo.</p></div><a class="btn ghost" href="${fromWaiter ? '/painel/garcom' : '/painel'}" data-link>Voltar</a></div>
    <div class="shop"><section class="panel">
      <input id="n_term" type="search" placeholder="Buscar produto" value="${esc(st.term)}">
      ${cats.map(c => `<h3>${esc(c)}</h3><div class="plist">${list.filter(p => p.category === c).map(p => `<button class="pbtn" data-p="${p.id}" ${p.stock === 0 ? 'disabled' : ''}><span>${esc(p.name)}${p.stock != null ? `<br><small class="mut">${p.stock === 0 ? 'esgotado' : `estoque: ${p.stock}`}</small>` : ''}</span><span class="price">${brl(p.price)}${p.groups.length ? ' +' : ''}</span></button>`).join('')}</div>`).join('') || '<p class="empty">Nenhum produto.</p>'}
    </section>
    <aside class="cart"><h3>Pedido</h3>
      <div class="segs" style="grid-template-columns:repeat(3,minmax(0,1fr))">${['balcao', 'telefone', ...(S.allow_tables ? ['mesa'] : [])].map(c => `<button type="button" data-ch="${c}" class="${st.channel === c ? 'on' : ''}" style="min-height:44px">${CHANNEL[c]}</button>`).join('')}</div>
      ${st.channel === 'mesa' ? `<label>Mesa<select id="n_table">${[...new Set([...Array.from({ length: S.tables_count || 10 }, (_, i) => String(i + 1)), st.table])].map(t => `<option ${t === st.table ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
      ${st.channel === 'telefone' ? `<label>Como receber<select id="n_ful"><option value="delivery" ${st.ful === 'delivery' ? 'selected' : ''}>Entrega</option><option value="pickup" ${st.ful === 'pickup' ? 'selected' : ''}>Retirada</option></select></label>` : ''}
      <label>Nome do cliente${st.channel === 'balcao' ? ' (opcional)' : ''}<input id="n_name" value="${esc(st.name)}"></label>
      <label>Telefone${st.channel === 'telefone' ? '' : ' (opcional)'}<input id="n_phone" inputmode="tel" value="${esc(st.phone)}"></label>
      ${st.ful === 'delivery' ? (DIST ? `<div class="two" style="gap:8px"><label>CEP<input id="n_cep" inputmode="numeric" maxlength="9" value="${esc(st.cep)}"></label><label>Número<input id="n_num" value="${esc(st.num)}"></label></div>
          <label>Rua<input id="n_rua" value="${esc(st.rua)}"></label><label>Complemento<input id="n_comp" value="${esc(st.comp)}"></label>
          <p class="mut" style="margin:0" id="n_q">${geo?.quote ? (geo.quote.inArea ? `${kmTxt(geo.quote.km)} · taxa ${brl(geo.quote.fee)}` : `<span class="badge b-r">Fora da área (${kmTxt(geo.quote.km)})</span>`) : 'Preencha CEP e número para calcular a taxa.'}</p>`
        : `<label>Bairro<select id="n_zone">${zones.map(z => `<option value="${z.id}" ${+st.zone === z.id ? 'selected' : ''}>${esc(z.name)} · ${brl(z.fee)}</option>`).join('')}</select></label>
          <label>Endereço<input id="n_rua" value="${esc(st.rua)}" placeholder="Rua, número, complemento"></label>`) : ''}
      ${cart.map((x, i) => `<div class="ci"><div><b>${x.qty}× ${esc(x.name)}</b>${x.optText ? `<br><span class="mut">${esc(x.optText)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}<br><button class="ghost sm" data-dec="${i}">−</button> <button class="ghost sm" data-inc="${i}">+</button></div><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('') || '<p class="empty">Toque nos produtos para adicionar.</p>'}
      <label>Pagamento<select id="n_pay">${['Pagar no caixa', 'Dinheiro', 'Cartão na entrega', 'Pix'].map(v => `<option value="${v}" ${st.pay === v ? 'selected' : ''}>${v === 'Cartão na entrega' ? 'Cartão' : v}</option>`).join('')}</select></label>
      ${st.pay === 'Dinheiro' ? `<label>Troco para (R$)<input id="n_change" inputmode="decimal" value="${esc(st.change)}"></label>` : ''}
      <div class="ci"><span>Subtotal</span><span class="price">${brl(sub())}</span></div>${fee() ? `<div class="ci"><span>Entrega</span><span class="price">${brl(fee())}</span></div>` : ''}
      <div class="tot"><span>Total</span><span class="price">${brl(sub() + fee())}</span></div>
      <p class="mut" style="margin:0;font-size:13px">Cupons, fidelidade, promoções e frete grátis são aplicados pelo sistema ao lançar.</p>
      <button class="pri" id="n_go" ${cart.length ? '' : 'disabled'}>Lançar pedido</button></aside></div>`;
  };
  const locate = async () => {
    read(); if (!DIST || st.ful !== 'delivery') return;
    if (String(st.cep).replace(/\D/g, '').length === 8 && (!cepInfo || cepInfo._cep !== st.cep)) { cepInfo = await lookupCep(st.cep); if (cepInfo) { cepInfo._cep = st.cep; if (!st.rua) st.rua = cepInfo.street; } }
    const pos = await locateAddress({ street: st.rua || cepInfo?.street, number: st.num, city: cepInfo?.city, state: cepInfo?.state, cep: st.cep }, cepInfo);
    geo = pos ? { ...pos, quote: await rpc('delivery_quote', { p_slug: S.slug, p_lat: pos.lat, p_lng: pos.lng }) } : null;
    draw();
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return; read();
    if (b.dataset.p) { openBuilder(products.find(p => p.id === +b.dataset.p), it => { const ex = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); ex ? ex.qty += it.qty : cart.push(it); draw(); }); }
    else if (b.dataset.ch) { st.channel = b.dataset.ch; st.ful = st.channel === 'telefone' ? 'delivery' : st.channel === 'mesa' ? 'table' : 'pickup'; draw(); }
    else if (b.dataset.inc) { cart[b.dataset.inc].qty++; draw(); }
    else if (b.dataset.dec) { if (!--cart[b.dataset.dec].qty) cart.splice(b.dataset.dec, 1); draw(); }
    else if (b.id === 'n_go') {
      if (st.ful === 'delivery' && DIST) { if (!geo) await locate(); if (!geo?.quote?.inArea) throw new Error('Endereço não localizado ou fora da área de entrega'); }
      const addr = st.ful !== 'delivery' ? '' : DIST ? `${st.rua}, ${st.num}${st.comp ? ' - ' + st.comp : ''}${st.cep ? ' - CEP ' + st.cep : ''}` : st.rua;
      b.disabled = true;
      try {
        const r = await rpc('staff_place_order', { p_tenant: S.id, p: {
          channel: st.channel, fulfillment: st.ful, table: st.channel === 'mesa' ? st.table : undefined,
          customer: { name: st.name.trim(), phone: st.phone.trim() }, zoneId: st.ful === 'delivery' && !DIST ? +st.zone : undefined, address: addr,
          ...(st.ful === 'delivery' && DIST ? { lat: geo.lat, lng: geo.lng } : {}),
          payment: st.pay, changeFor: st.pay === 'Dinheiro' && st.change ? toCents(st.change) : undefined,
          items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: c.notes })) } });
        toast(`Pedido #${r.number} lançado · ${brl(r.total)}`);
        if (local.get('printMode', local.get('autoPrint', false) ? 'accept' : 'off') !== 'off') { const o = (await q(sb.from('orders').select(ORDER_COLS).eq('id', r.id)))[0]; if (o) printOrder(S, o); }
        if (fromWaiter) return go('/painel/garcom');
        cart = []; st = { ...st, name: '', phone: '', rua: '', num: '', comp: '', cep: '', change: '' }; geo = null; draw();
      } finally { const x = $('#n_go'); if (x) x.disabled = !cart.length; }
    }
  });
  app.onchange = e => {
    read();
    if (e.target.id === 'n_ful') { st.ful = e.target.value; draw(); }
    if (['n_pay', 'n_zone'].includes(e.target.id)) draw();
    if (['n_cep', 'n_num', 'n_rua'].includes(e.target.id) && DIST) locate().catch(err => toast(err.message));
  };
  let tmr; app.oninput = e => { if (e.target.id !== 'n_term') return; clearTimeout(tmr); tmr = setTimeout(() => { read(); draw(); const el = $('#n_term'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); };
  cleanup = () => { app.onclick = app.onchange = app.oninput = null; clearTimeout(tmr); };
  draw();
}

/* ---------- fechamento de caixa ---------- */
async function pCash(S) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: S.timezone || 'America/Sao_Paulo' });
  let day = today, r = null;
  const rows = (arr, label) => arr.map(x => `<tr><td>${esc(label(x))}</td><td class="n">${x.count}</td><td class="n price">${brl(x.total)}</td></tr>`).join('') || '<tr><td class="mut" colspan="3">Sem vendas</td></tr>';
  let cs = null; // turno do caixa (abre com troco, sangrias/reforços, fecha contando a gaveta)
  const shiftBox = () => {
    if (!cs) return '';
    if (!cs.open) return `<div class="panel shift"><div class="row between"><div><h3 style="margin:0">Caixa fechado</h3>${cs.last ? `<p class="mut" style="margin:4px 0 0">Último turno: ${new Date(cs.last.opened_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} a ${hhmm(cs.last.closed_at)} · esperado ${brl(cs.last.expected_amount)} · contado ${brl(cs.last.counted_amount)} · <b class="${cs.last.diff < 0 ? 'neg' : ''}">${cs.last.diff === 0 ? 'bateu certinho' : (cs.last.diff > 0 ? 'sobrou ' : 'faltou ') + brl(Math.abs(cs.last.diff))}</b>${cs.last.note ? ` · ${esc(cs.last.note)}` : ''}</p>` : '<p class="mut" style="margin:4px 0 0">Abra o caixa no começo do turno com o troco que está na gaveta.</p>'}</div>
      <form class="row" id="fOpen"><label>Troco inicial (R$)<input id="csOpen" inputmode="decimal" placeholder="100,00" style="width:120px" required></label><button class="pri" style="align-self:end">Abrir caixa</button></form></div></div>`;
    return `<div class="panel shift"><div class="row between"><h3 style="margin:0">Caixa aberto <span class="badge b-g">desde ${hhmm(cs.openedAt)}</span></h3><span class="row"><button class="ghost sm" data-move="suprimento">+ Reforço</button><button class="ghost sm" data-move="sangria">− Sangria</button><button class="pri sm" id="csClose">Fechar caixa</button></span></div>
      <div class="kpis" style="margin:10px 0 0"><div class="kpi"><span class="mut">Troco inicial</span><b class="price">${brl(cs.opening)}</b></div><div class="kpi"><span class="mut">Vendas em dinheiro</span><b class="price">${brl(cs.cashSales)}</b></div>
        <div class="kpi"><span class="mut">Reforços − sangrias</span><b class="price">${brl(cs.supplies - cs.withdrawals)}</b></div><div class="kpi"><span class="mut">Deve ter na gaveta</span><b class="price">${brl(cs.expected)}</b></div></div>
      ${cs.moves.length ? `<p class="mut" style="margin:8px 0 0">${cs.moves.map(m => `${hhmm(m.at)} ${m.kind === 'sangria' ? 'sangria' : 'reforço'} ${brl(m.amount)}${m.note ? ` (${esc(m.note)})` : ''}`).join(' · ')}</p>` : ''}</div>`;
  };
  const draw = async () => {
    [r, cs] = await Promise.all([rpc('cash_report', { p_tenant: S.id, p_day: day }), rpc('cash_status', { p_tenant: S.id }).catch(() => null)]);
    app.innerHTML = `<div class="row between"><div><h2>Caixa</h2><p class="lead">Fechamento do dia: confira os valores por forma de pagamento com a maquininha e a gaveta.</p></div>
      <span class="row"><input type="date" id="cDay" value="${day}" max="${today}" style="width:auto"><button class="pri" id="cPrint">Imprimir fechamento</button></span></div>
    ${shiftBox()}
    <div class="kpis"><div class="kpi"><span class="mut">Total do dia</span><b class="price">${brl(r.total)}</b><span class="mut">${r.orders} pedido(s)</span></div>
      <div class="kpi"><span class="mut">Taxas de entrega</span><b class="price">${brl(r.fees)}</b>${r.serviceFees ? `<span class="mut">+ ${brl(r.serviceFees)} de taxa de serviço</span>` : ''}</div>
      <div class="kpi"><span class="mut">Descontos</span><b class="price">${brl(r.discounts)}</b></div>
      <div class="kpi"><span class="mut">Cancelados</span><b>${r.cancelled.count}</b><span class="mut">${brl(r.cancelled.total)}</span></div></div>
    ${r.open ? `<p class="banner warn" style="margin:0 0 16px">${r.open} pedido(s) do dia ainda não foram finalizados (entregues, retirados ou servidos).</p>` : ''}
    <div class="two"><div class="panel"><h3>Por forma de pagamento</h3><table><thead><tr><th>Forma</th><th class="n">Pedidos</th><th class="n">Valor</th></tr></thead><tbody>${rows(r.byPayment, x => x.payment)}</tbody></table>
      ${r.paidOnline ? `<p class="mut" style="margin:0">Já recebido online (Pix): <b>${brl(r.paidOnline)}</b>, cai direto na conta do Mercado Pago.</p>` : ''}
      ${r.cashChange ? `<p class="mut" style="margin:0">Troco devolvido em dinheiro: <b>${brl(r.cashChange)}</b>.</p>` : ''}</div>
    <div class="panel"><h3>Por canal</h3><table><thead><tr><th>Canal</th><th class="n">Pedidos</th><th class="n">Valor</th></tr></thead><tbody>${rows(r.byChannel, x => CHANNEL[x.channel] || x.channel)}</tbody></table>
      <h3>Por tipo</h3><table><tbody>${rows(r.byFulfillment, x => FUL[x.fulfillment] || x.fulfillment)}</tbody></table></div></div>`;
  };
  const printCash = () => {
    $('#print').innerHTML = `<div class="tkt"><b class="big">${esc(S.name)}</b><div>FECHAMENTO DE CAIXA</div><div>${day.split('-').reverse().join('/')} · impresso ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div><hr>
      ${r.byPayment.map(x => `<div class="li"><span>${esc(x.payment)} (${x.count})</span><span>${brl(x.total)}</span></div>`).join('')}<hr>
      <div class="li"><span>Subtotal</span><span>${brl(r.subtotal)}</span></div><div class="li"><span>Taxas de entrega</span><span>${brl(r.fees)}</span></div>${r.serviceFees ? `<div class="li"><span>Taxa de serviço</span><span>${brl(r.serviceFees)}</span></div>` : ''}
      <div class="li"><span>Descontos</span><span>-${brl(r.discounts)}</span></div><div class="li big"><b>TOTAL (${r.orders})</b><b>${brl(r.total)}</b></div><hr>
      ${r.byChannel.map(x => `<div class="li"><span>${CHANNEL[x.channel] || x.channel} (${x.count})</span><span>${brl(x.total)}</span></div>`).join('')}
      <div class="li"><span>Cancelados (${r.cancelled.count})</span><span>${brl(r.cancelled.total)}</span></div>
      ${r.paidOnline ? `<div class="li"><span>Recebido online</span><span>${brl(r.paidOnline)}</span></div>` : ''}<hr><div>Conferido por: ____________________</div></div>`;
    window.print();
  };
  const money = (id, label) => { const v = toCents($(id).value || '0'); if (!Number.isFinite(v) || v < 0) throw new Error(`${label}: valor inválido`); return v; };
  app.onsubmit = attempt(async e => { if (e.target.id !== 'fOpen') return; e.preventDefault(); await rpc('cash_open', { p_tenant: S.id, p_amount: money('#csOpen', 'Troco') }); toast('Caixa aberto'); await draw(); });
  app.onclick = attempt(async e => {
    if (e.target.closest('#cPrint')) return printCash();
    const mv = e.target.closest('button[data-move]');
    if (mv) {
      const kind = mv.dataset.move;
      dialog(`<h2>${kind === 'sangria' ? 'Sangria (tirar dinheiro da gaveta)' : 'Reforço (colocar dinheiro na gaveta)'}</h2><form id="fMove"><label>Valor (R$)<input id="mvV" inputmode="decimal" required autofocus></label>
        <label>Motivo (opcional)<input id="mvN" maxlength="120" placeholder="${kind === 'sangria' ? 'depósito, pagamento de fornecedor…' : 'mais moedas…'}"></label><div class="row"><button class="pri">Registrar</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').onsubmit = attempt(async ev => { ev.preventDefault(); const v = money('#mvV', 'Valor'); if (!v) throw new Error('Informe o valor');
        await rpc('cash_move', { p_tenant: S.id, p_kind: kind, p_amount: v, p_note: $('#mvN').value }); closeDlg(); toast(kind === 'sangria' ? 'Sangria registrada' : 'Reforço registrado'); await draw(); });
      return;
    }
    if (e.target.closest('#csClose')) {
      dialog(`<h2>Fechar caixa</h2><p class="mut" style="margin:0">Conte o dinheiro da gaveta e digite o total. O sistema compara com o esperado (${brl(cs.expected)}).</p>
        <form id="fClose"><label>Dinheiro contado (R$)<input id="clV" inputmode="decimal" required autofocus></label><p id="clDiff" class="mut" style="margin:0"></p>
        <label>Observação (opcional)<input id="clN" maxlength="300"></label><div class="row"><button class="pri">Fechar caixa</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').oninput = () => { const v = toCents($('#clV').value || 'x'); $('#clDiff').textContent = Number.isFinite(v) ? (v === cs.expected ? 'Bateu certinho.' : v > cs.expected ? `Sobrando ${brl(v - cs.expected)}.` : `Faltando ${brl(cs.expected - v)}.`) : ''; };
      $('#dlgBody').onsubmit = attempt(async ev => { ev.preventDefault(); const st = await rpc('cash_close', { p_tenant: S.id, p_counted: money('#clV', 'Valor'), p_note: $('#clN').value }); closeDlg();
        toast(st.last?.diff ? `Caixa fechado: ${st.last.diff > 0 ? 'sobrou' : 'faltou'} ${brl(Math.abs(st.last.diff))}` : 'Caixa fechado: bateu certinho'); await draw(); });
    }
  });
  app.onchange = attempt(async e => { if (e.target.id === 'cDay' && e.target.value) { day = e.target.value; await draw(); } });
  cleanup = () => { app.onclick = app.onchange = app.onsubmit = null; };
  await draw();
}

/* ---------- clientes ---------- */
async function pCustomers(S) {
  let list = [], term = '', gone = ''; // filtro/segmento ('' = todos os clientes); com filtro, a tela vira campanha de WhatsApp
  const D = c => mins(c.lastOrder) / 1440, firstD = c => mins(c.firstOrder) / 1440;
  // Segmentos (RFM simples): quem gasta mais, quem volta sempre, quem acabou de chegar, quem está sumindo
  const vipCut = () => { const v = list.filter(c => c.orders > 0).map(c => c.spent).sort((a, b) => b - a); return v.length ? v[Math.max(0, Math.ceil(v.length * 0.1) - 1)] : Infinity; };
  const SEGS = {
    vip: { t: 'VIP', h: '10% que mais gastam e pediram nos últimos 60 dias', f: c => c.spent >= vipCut() && D(c) <= 60,
      msg: 'Olá, {nome}! Você é um dos clientes mais especiais da {loja}. Preparamos um mimo para você 😊{cupom}\n{link}' },
    fieis: { t: 'Fiéis', h: '4+ pedidos e pediram nos últimos 30 dias', f: c => c.orders >= 4 && D(c) <= 30,
      msg: 'Olá, {nome}! Obrigado por pedir sempre na {loja}. 💛{cupom}\n{link}' },
    novos: { t: 'Novos', h: 'primeiro pedido nos últimos 30 dias', f: c => firstD(c) <= 30 && c.orders <= 2,
      msg: 'Olá, {nome}! Que bom ter você na {loja}. Que tal pedir de novo?{cupom}\n{link}' },
    risco: { t: 'Em risco', h: '2+ pedidos, sem pedir há 31 a 60 dias', f: c => c.orders >= 2 && D(c) > 30 && D(c) <= 60,
      msg: 'Olá, {nome}! Faz um tempinho que você não pede na {loja}. Sentimos sua falta!{cupom}\n{link}' },
    perdidos: { t: 'Perdidos', h: 'sem pedir há mais de 60 dias', f: c => c.orders > 0 && D(c) > 60,
      msg: 'Olá, {nome}! Aqui é da {loja}. Estamos com novidades no cardápio e queremos você de volta!{cupom}\n{link}' },
    g30: { t: 'Sumidos 30+ dias', h: 'sem pedir há mais de 30 dias', f: c => c.orders > 0 && D(c) > 30 },
  };
  const DEFAULT_CAMP = 'Olá, {nome}! Aqui é da {loja}. Sentimos sua falta! 😊{cupom}\nPeça por aqui: {link}';
  const camp = local.get(`camp:${S.id}`, { msg: DEFAULT_CAMP, coupon: '' });
  const sent = local.get(`sent:${S.id}`, {}); // telefone → data em que a mensagem da campanha foi aberta
  const coupons = await q(sb.from('coupons').select('code, percent, free_shipping, active').eq('tenant_id', S.id).eq('active', true).order('id')).catch(() => []);
  const cupTxt = c => c ? `\nUse o cupom *${c.code}*: ${[c.percent ? `${c.percent}% de desconto` : '', c.free_shipping ? 'entrega grátis' : ''].filter(Boolean).join(' e ')}.` : '';
  const msgFor = c => camp.msg.replaceAll('{nome}', c.name.split(' ')[0]).replaceAll('{loja}', S.name)
    .replaceAll('{cupom}', cupTxt(coupons.find(x => x.code === camp.coupon))).replaceAll('{link}', `${storeLink(S)}?repetir=1`);
  const saveCamp = () => local.set(`camp:${S.id}`, camp);
  const pkey = ph => String(ph || '').replace(/\D/g, '').slice(-11);
  let blocked = new Map();
  const load = async () => {
    const [l, bl] = await Promise.all([rpc('store_customers', { p_tenant: S.id, p_search: term || null, p_limit: gone ? 2000 : 200 }),
      q(sb.from('blocked_phones').select('phone_key, note').eq('tenant_id', S.id)).catch(() => null)]);
    list = l; blocked = new Map((bl || []).map(b => [b.phone_key, b.note || ''])); draw();
  };
  const shown = () => gone ? list.filter(SEGS[gone].f) : list;
  const draw = () => {
    const box = $('#custList'), rows = shown();
    const html = `${gone ? `<p class="mut" style="margin:0 0 8px"><b>${rows.length} cliente(s)</b> · ${esc(SEGS[gone].h)} · ${rows.filter(c => sent[c.phone]).length} já contatado(s)</p>` : ''}
      <div class="scroll"><table class="stack"><thead><tr><th>Cliente</th><th class="n">Pedidos</th><th class="n">Total gasto</th><th>Último pedido</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td data-l="Cliente"><b>${esc(c.name)}</b>${blocked.has(pkey(c.phone)) ? ` <span class="badge b-r" title="${esc(blocked.get(pkey(c.phone)))}">bloqueado</span>` : ''}<br><span class="mut">${esc(c.phone)}${c.address ? ' · ' + esc(c.address) : ''}</span></td>
        <td data-l="Pedidos" class="n">${c.orders}${S.loyalty_enabled && c.stamps != null ? `<br><span class="mut">${Math.min(c.stamps, S.loyalty_every)}/${S.loyalty_every} selos</span>` : ''}</td><td data-l="Total gasto" class="n price">${brl(c.spent)}</td>
        <td data-l="Último pedido">${new Date(c.lastOrder).toLocaleDateString('pt-BR')}${mins(c.lastOrder) > 30 * 1440 ? ` <span class="badge b-a">sumido há ${Math.floor(mins(c.lastOrder) / 1440)} dias</span>` : ''}</td>
        <td data-l=""><span class="row">${gone
          ? (waLink(c.phone, '') ? `<a class="btn ${sent[c.phone] ? 'ghost' : 'pri'} sm" data-send="${esc(c.phone)}" href="${esc(waLink(c.phone, msgFor(c)))}" target="_blank" rel="noopener">${sent[c.phone] ? `Enviado em ${new Date(sent[c.phone]).toLocaleDateString('pt-BR')} · reenviar` : 'Enviar no WhatsApp'}</a>` : '<span class="mut">telefone inválido</span>')
          : `${waBtn(waLink(c.phone, `Olá, ${c.name.split(' ')[0]}! Aqui é da ${S.name}.`))}${blocked.has(pkey(c.phone)) ? `<button class="ghost sm" data-unblock="${esc(c.phone)}">Desbloquear</button>` : `<button class="ghost sm" data-block="${esc(c.phone)}">Bloquear</button>`}<button class="ghost sm" data-anon="${esc(c.phone)}">Excluir dados</button>`}</span></td></tr>`).join('') || `<tr><td class="mut">${gone ? 'Nenhum cliente sumido. Ótimo sinal!' : 'Nenhum cliente encontrado.'}</td></tr>`}</tbody></table></div>`;
    if (box) { box.innerHTML = html; return; }
    app.innerHTML = `<div class="row between"><div><h2>Clientes</h2><p class="lead">Quem já pediu na sua loja, montado a partir dos pedidos.</p></div>
      <span class="row"><button class="ghost" id="csv">Baixar planilha (CSV)</button></span></div>
      <div class="row" style="margin-bottom:12px">${[['', 'Todos'], ...Object.entries(SEGS).map(([k, v]) => [k, v.t])].map(([d, t]) => `<button class="sm ${d === gone ? 'pri' : 'ghost'}" data-gone="${d}" title="${esc(d ? SEGS[d].h : 'todos os clientes')}">${t}${d && gone && !term ? ` <span class="mut">${list.filter(SEGS[d].f).length}</span>` : ''}</button>`).join('')}</div>
      ${gone ? `<div class="panel" style="margin-bottom:16px"><h3>Campanha: ${esc(SEGS[gone].t)}</h3>
        <p class="mut" style="margin:0">Escreva a mensagem uma vez e envie para cada cliente com um toque. O WhatsApp abre com o texto pronto; você só confirma o envio. Use {nome}, {loja}, {cupom} e {link} (o link já abre a loja com o último pedido no carrinho).</p>
        <label>Mensagem<textarea id="cMsg" rows="3" maxlength="600">${esc(camp.msg)}</textarea></label>
        <label>Cupom de volta<select id="cCupSel"><option value="">Sem cupom</option>${coupons.map(c => `<option value="${esc(c.code)}" ${c.code === camp.coupon ? 'selected' : ''}>${esc(c.code)} · ${[c.percent ? c.percent + '%' : '', c.free_shipping ? 'entrega grátis' : ''].filter(Boolean).join(' + ')}</option>`).join('')}</select></label>
        ${coupons.length ? '' : '<p class="mut" style="margin:0">Para oferecer um desconto, crie um cupom em <a href="/painel/config" data-link>Configurações</a>.</p>'}
        <p class="mut" style="margin:0"><b>Prévia:</b> <span id="cPrev" style="white-space:pre-wrap">${esc(msgFor({ name: 'Maria' }))}</span></p></div>` : ''}
      <div class="panel"><input id="custQ" type="search" placeholder="Buscar por nome ou telefone" value="${esc(term)}"><div id="custList">${html}</div>
      ${gone ? '' : '<p class="mut" style="margin:0">"Excluir dados" atende pedidos de exclusão da LGPD: apaga nome, telefone e endereço desse cliente em todos os pedidos da loja. Os valores continuam nos relatórios.</p>'}</div>`;
  };
  let tmr;
  app.oninput = e => {
    if (e.target.id === 'cMsg') { camp.msg = e.target.value; clearTimeout(tmr); tmr = setTimeout(() => { saveCamp(); $('#cPrev').textContent = msgFor({ name: 'Maria' }); const box = $('#custList'); if (box) draw(); }, 250); return; }
    if (e.target.id !== 'custQ') return; clearTimeout(tmr); tmr = setTimeout(() => { term = e.target.value.trim(); load().catch(err => toast(err.message)); }, 300);
  };
  app.onchange = e => { if (e.target.id === 'cCupSel') { camp.coupon = e.target.value; saveCamp(); $('#cPrev').textContent = msgFor({ name: 'Maria' }); draw(); } };
  app.onclick = attempt(async e => {
    const l = e.target.closest('a[data-send]');
    if (l) { sent[l.dataset.send] = new Date().toISOString(); local.set(`sent:${S.id}`, sent); setTimeout(draw, 300); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.gone != null) {
      const was = gone; gone = b.dataset.gone;
      // troca a mensagem pela sugerida do segmento, se a atual ainda é uma das sugestões
      const presets = [...Object.values(SEGS).map(x => x.msg).filter(Boolean), DEFAULT_CAMP];
      if (gone && SEGS[gone].msg && presets.includes(camp.msg)) { camp.msg = SEGS[gone].msg; saveCamp(); }
      if (gone && !SEGS[gone].msg && presets.includes(camp.msg)) { camp.msg = DEFAULT_CAMP; saveCamp(); }
      app.innerHTML = ''; if (!was !== !gone) await load(); else draw(); return;
    }
    if (b.dataset.block) {
      dialog(`<h2>Bloquear cliente</h2><p class="mut" style="margin:0">Pedidos pela loja online com o telefone <b>${esc(b.dataset.block)}</b> serão recusados com a mensagem "Fale com a loja". Pelo balcão e telefone vocês continuam lançando normalmente.</p>
        <form id="fBlock"><label>Motivo (só a loja vê)<input id="bkN" maxlength="120" placeholder="trote, golpe, não pagou…"></label><div class="row"><button class="pri">Bloquear</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').onsubmit = attempt(async ev => { ev.preventDefault(); await rpc('set_blocked', { p_tenant: S.id, p_phone: b.dataset.block, p_blocked: true, p_note: $('#bkN').value }); closeDlg(); toast('Cliente bloqueado'); await load(); });
      return;
    }
    if (b.dataset.unblock) { await rpc('set_blocked', { p_tenant: S.id, p_phone: b.dataset.unblock, p_blocked: false }); toast('Cliente desbloqueado'); return load(); }
    if (b.dataset.anon) { if (!sure(b)) return; const n = await rpc('anonymize_customer', { p_tenant: S.id, p_phone: b.dataset.anon }); toast(`Dados removidos de ${n} pedido(s)`); await load(); }
    if (b.id === 'csv') {
      const rows = [['Nome', 'Telefone', 'Endereço', 'Pedidos', 'Total gasto', 'Primeiro pedido', 'Último pedido'],
        ...shown().map(c => [c.name, c.phone, c.address || '', c.orders, fromCents(c.spent), new Date(c.firstOrder).toLocaleDateString('pt-BR'), new Date(c.lastOrder).toLocaleDateString('pt-BR')])];
      const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(';')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `clientes-${S.slug}.csv`; a.click(); URL.revokeObjectURL(a.href);
    }
  });
  cleanup = () => { app.oninput = app.onclick = app.onchange = null; clearTimeout(tmr); };
  await load();
}

/* ---------- estoque de insumos e ficha técnica ---------- */
const UNITS = { un: 'un', g: 'g', kg: 'kg', ml: 'ml', l: 'L' };
const num = v => { const n = Number(String(v ?? '').trim().replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const fmtQ = (q, u) => `${Number(q).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${UNITS[u] || u}`;
const fmtCost = c => (Number(c) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: Number(c) < 100 ? 4 : 2 });
async function pStock(S, owner) {
  let ings = [], recipes = [], prods = [], moves = [], optRec = [];
  const load = async () => {
    [ings, recipes, prods, moves] = await Promise.all([
      q(sb.from('ingredients').select('*').eq('tenant_id', S.id).order('name')),
      q(sb.from('product_ingredients').select('product_id, ingredient_id, qty').eq('tenant_id', S.id)),
      q(sb.from('products').select('id, name, category, price, groups:option_groups(name, sort, options(name, sort))').eq('tenant_id', S.id).order('category').order('sort')),
      q(sb.from('ingredient_moves').select('ingredient_id, delta, reason, note, at, order_id').eq('tenant_id', S.id).order('at', { ascending: false }).limit(30))]);
    optRec = await q(sb.from('option_ingredients').select('product_id, option_name, ingredient_id, qty').eq('tenant_id', S.id)).catch(() => []);
    draw();
  };
  const ing = id => ings.find(i => i.id === id);
  const unitCost = pid => recipes.filter(r => r.product_id === pid).reduce((a, r) => a + r.qty * (ing(r.ingredient_id)?.unit_cost || 0), 0);
  const low = () => ings.filter(i => +i.min_stock > 0 && +i.stock <= +i.min_stock);
  const draw = () => {
    const value = ings.reduce((a, i) => a + Math.max(0, +i.stock) * +i.unit_cost, 0);
    app.innerHTML = `<div class="row between"><div><h2>Estoque</h2><p class="lead">Insumos baixam sozinhos a cada venda, pela ficha técnica de cada produto, e voltam se o pedido for cancelado.</p></div>
      ${owner ? '<button class="pri" id="iNew">+ Novo insumo</button>' : ''}</div>
    <div class="kpis"><div class="kpi"><span class="mut">Insumos</span><b>${ings.length}</b></div><div class="kpi"><span class="mut">Acabando</span><b class="${low().length ? 'neg' : ''}">${low().length}</b><span class="mut">no mínimo ou abaixo</span></div>
      <div class="kpi"><span class="mut">Valor em estoque</span><b class="price">${brl(Math.round(value))}</b></div><div class="kpi"><span class="mut">Produtos com ficha</span><b>${new Set(recipes.map(r => r.product_id)).size}</b><span class="mut">de ${prods.length}</span></div></div>
    ${low().length ? `<p class="stuck" style="display:block">⚠ Acabando: ${low().map(i => `<b>${esc(i.name)}</b> (${fmtQ(i.stock, i.unit)})`).join(', ')}</p>` : ''}
    <div class="panel" style="margin-bottom:16px"><h3>Insumos</h3><div class="scroll"><table class="stack"><thead><tr><th>Insumo</th><th class="n">Estoque</th><th class="n">Mínimo</th><th class="n">Custo</th><th class="n">Valor</th><th></th></tr></thead><tbody>
      ${ings.map(i => `<tr><td data-l="Insumo"><b>${esc(i.name)}</b></td><td data-l="Estoque" class="n ${+i.min_stock > 0 && +i.stock <= +i.min_stock ? 'neg' : ''}">${fmtQ(i.stock, i.unit)}</td><td data-l="Mínimo" class="n">${+i.min_stock ? fmtQ(i.min_stock, i.unit) : '—'}</td>
        <td data-l="Custo" class="n">${fmtCost(i.unit_cost)}/${UNITS[i.unit]}</td><td data-l="Valor" class="n price">${brl(Math.round(Math.max(0, +i.stock) * +i.unit_cost))}</td>
        <td data-l=""><span class="row"><button class="ok sm" data-in="${i.id}">Entrada</button><button class="ghost sm" data-count="${i.id}">Contagem</button>${owner ? `<button class="ghost sm" data-edit="${i.id}">Editar</button>` : ''}</span></td></tr>`).join('') || '<tr><td class="mut" colspan="6">Nenhum insumo ainda. Comece pelos que mais pesam no custo: queijo, carne, massa, embalagens.</td></tr>'}</tbody></table></div></div>
    <div class="panel" style="margin-bottom:16px"><h3>Ficha técnica e margem</h3><p class="mut" style="margin:0 0 8px">Quanto de cada insumo vai em 1 unidade do produto. Com isso o sistema calcula o custo e a margem de cada item.</p>
      <div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th>Ficha</th><th class="n">Preço</th><th class="n">Custo</th><th class="n">Margem</th><th></th></tr></thead><tbody>
      ${prods.map(p => { const rs = recipes.filter(r => r.product_id === p.id), c = unitCost(p.id), mg = p.price ? (p.price - c) / p.price : 0; return `<tr><td data-l="Produto"><b>${esc(p.name)}</b><br><span class="mut">${esc(p.category)}</span></td>
        <td data-l="Ficha">${rs.length ? rs.map(r => `${esc(ing(r.ingredient_id)?.name || '?')} ${fmtQ(r.qty, ing(r.ingredient_id)?.unit)}`).join(', ') : '<span class="mut">sem ficha</span>'}${optRec.some(o => o.product_id === p.id) ? `<br><span class="mut">+ extras em ${new Set(optRec.filter(o => o.product_id === p.id).map(o => o.option_name)).size} opção(ões)</span>` : ''}</td>
        <td data-l="Preço" class="n price">${brl(p.price)}</td><td data-l="Custo" class="n price">${rs.length ? brl(Math.round(c)) : '—'}</td>
        <td data-l="Margem" class="n">${rs.length ? `<b class="${mg < 0.5 ? 'neg' : ''}">${Math.round(mg * 100)}%</b>` : '—'}</td>
        <td data-l="">${owner ? `<button class="ghost sm" data-recipe="${p.id}">${rs.length ? 'Editar ficha' : 'Montar ficha'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="mut" style="margin:6px 0 0">Margem abaixo de 50% fica em vermelho. Preço considerado: o preço base, sem adicionais.</p></div>
    <div class="panel"><h3>Últimos movimentos</h3>${moves.map(m => `<div class="ci"><span>${new Date(m.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · <b>${esc(ing(m.ingredient_id)?.name || '?')}</b> · ${({ pedido: 'venda', cancelamento: 'cancelamento', entrada: 'entrada', ajuste: 'contagem' })[m.reason]}${m.note ? ` · ${esc(m.note)}` : ''}</span><span class="${m.delta < 0 ? 'neg' : ''}">${m.delta > 0 ? '+' : ''}${fmtQ(m.delta, ing(m.ingredient_id)?.unit)}</span></div>`).join('') || '<p class="empty">Nenhum movimento ainda.</p>'}</div>`;
  };
  const ingForm = i => dialog(`<h2>${i ? 'Editar insumo' : 'Novo insumo'}</h2><form id="fIng">
      <label>Nome<input id="inN" required maxlength="60" value="${esc(i?.name || '')}" placeholder="Mussarela, massa, caixa de pizza…"></label>
      <div class="two" style="gap:10px"><label>Unidade<select id="inU">${Object.entries(UNITS).map(([k, l]) => `<option value="${k}" ${(i?.unit || 'g') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Estoque mínimo (aviso)<input id="inM" inputmode="decimal" value="${i ? String(+i.min_stock).replace('.', ',') : ''}" placeholder="0"></label></div>
      <label>Custo por unidade de medida (R$)<input id="inC" inputmode="decimal" value="${i ? String(+i.unit_cost / 100).replace('.', ',') : ''}" placeholder="ex.: 0,045 por grama"></label>
      <p class="mut" style="margin:0">Dica: o custo também se ajusta sozinho quando você registra uma entrada com o valor pago.</p>
      <div class="row"><button class="pri">Salvar</button>${i ? '<button type="button" class="ghost" id="inDel">Excluir insumo</button>' : ''}<button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'iNew' || b.dataset.edit) {
      const i = b.dataset.edit ? ing(+b.dataset.edit) : null; ingForm(i);
      $('#dlgBody').onclick = attempt(async ev => { if (!ev.target.closest('#inDel') || !sure(ev.target.closest('#inDel'))) return; await q(sb.from('ingredients').delete().eq('id', i.id)); closeDlg(); toast('Insumo excluído'); await load(); });
      $('#dlgBody').onsubmit = attempt(async ev => {
        ev.preventDefault(); const m = num($('#inM').value || '0'), c = num($('#inC').value || '0');
        if (!(m >= 0) || !(c >= 0)) throw new Error('Confira o mínimo e o custo');
        const row = { name: $('#inN').value.trim(), unit: $('#inU').value, min_stock: m, unit_cost: Math.round(c * 100 * 10000) / 10000 };
        await q(i ? sb.from('ingredients').update(row).eq('id', i.id) : sb.from('ingredients').insert({ ...row, tenant_id: S.id }));
        closeDlg(); toast('Insumo salvo'); await load();
      });
      return;
    }
    if (b.dataset.in || b.dataset.count) {
      const i = ing(+(b.dataset.in || b.dataset.count)), entry = !!b.dataset.in;
      dialog(`<h2>${entry ? 'Entrada' : 'Contagem'}: ${esc(i.name)}</h2><p class="mut" style="margin:0">Estoque atual no sistema: <b>${fmtQ(i.stock, i.unit)}</b>.</p><form id="fMv">
        <label>${entry ? 'Quantidade comprada' : 'Quantidade que há de fato'} (${UNITS[i.unit]})<input id="mvQ" inputmode="decimal" required autofocus></label>
        ${entry ? '<label>Valor pago no total (R$, opcional)<input id="mvC" inputmode="decimal" placeholder="atualiza o custo médio"></label>' : ''}
        <label>Observação (opcional)<input id="mvN" maxlength="120" placeholder="${entry ? 'fornecedor, nota…' : 'contagem de sexta…'}"></label>
        <div class="row"><button class="pri">Registrar</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').onsubmit = attempt(async ev => {
        ev.preventDefault(); const qv = num($('#mvQ').value), cv = entry && $('#mvC').value.trim() ? toCents($('#mvC').value) : null;
        if (!(qv >= 0)) throw new Error('Quantidade inválida');
        await rpc('ingredient_move', { p_ingredient: i.id, p_kind: entry ? 'entrada' : 'ajuste', p_qty: qv, p_total_cost: cv, p_note: $('#mvN').value });
        closeDlg(); toast(entry ? 'Entrada registrada' : 'Estoque ajustado'); await load();
      });
      return;
    }
    if (b.dataset.recipe) {
      const p = prods.find(x => x.id === +b.dataset.recipe); if (!ings.length) return toast('Cadastre os insumos primeiro');
      const optNames = [...new Set((p.groups || []).sort((a, b) => a.sort - b.sort).flatMap(g => (g.options || []).sort((a, b) => a.sort - b.sort).map(o => o.name)))];
      let target = '', rows;
      const rowsFor = t => { const r = (t ? optRec.filter(o => o.product_id === p.id && o.option_name === t) : recipes.filter(x => x.product_id === p.id)).map(x => ({ id: x.ingredient_id, qty: +x.qty }));
        return r.length ? r : [{ id: ings[0].id, qty: '' }]; };
      rows = rowsFor('');
      const paintR = () => { $('#rRows').innerHTML = rows.map((r, k) => `<div class="row" style="flex-wrap:nowrap"><select data-ri="${k}" style="flex:2">${ings.map(i => `<option value="${i.id}" ${i.id === r.id ? 'selected' : ''}>${esc(i.name)} (${UNITS[i.unit]})</option>`).join('')}</select>
        <input data-rq="${k}" inputmode="decimal" value="${String(r.qty).replace('.', ',')}" placeholder="qtd" style="flex:1"><button type="button" class="ghost sm" data-rdel="${k}" aria-label="Remover">✕</button></div>`).join('');
        paintCost(); };
      const paintCost = () => { const c = rows.reduce((a, r) => a + (num(r.qty) || 0) * (ing(r.id)?.unit_cost || 0), 0); $('#rCost').textContent = `Custo: ${brl(Math.round(c))} · margem ${p.price ? Math.round((p.price - c) / p.price * 100) : 0}%`; };
      dialog(`<h2>Ficha técnica: ${esc(p.name)}</h2>
        ${optNames.length ? `<label>Ficha de<select id="rTarget"><option value="">${esc(p.name)} (base, vai sempre)</option>${optNames.map(n => `<option value="${esc(n)}">Opção: ${esc(n)} (só quando escolhida)</option>`).join('')}</select></label>
          <p class="mut" style="margin:0">Use as opções para o que muda: tamanho Grande +100 g de queijo, adicional de bacon 30 g…</p>` : ''}
        <p class="mut" style="margin:0" id="rHint">Quanto vai em <b>1 unidade</b> (ex.: mussarela 200 g, caixa 1 un).</p>
        <form id="fRec"><div id="rRows" style="display:grid;gap:8px"></div><button type="button" class="ghost sm" id="rAdd">+ Insumo</button><p id="rCost" class="mut" style="margin:0"></p>
        <div class="row"><button class="pri">Salvar ficha</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      paintR();
      $('#dlgBody').oninput = ev => { const k = ev.target.dataset.rq; if (k != null) { rows[+k].qty = ev.target.value; paintCost(); } };
      $('#dlgBody').onchange = ev => {
        if (ev.target.id === 'rTarget') { target = ev.target.value; rows = rowsFor(target); $('#rHint').innerHTML = target ? `Insumos <b>a mais</b> quando o cliente escolhe <b>${esc(target)}</b>, por unidade.` : 'Quanto vai em <b>1 unidade</b> (ex.: mussarela 200 g, caixa 1 un).'; return paintR(); }
        const k = ev.target.dataset.ri; if (k != null) { rows[+k].id = +ev.target.value; paintR(); } };
      $('#dlgBody').onclick = ev => { if (ev.target.closest('#rAdd')) { rows.push({ id: ings[0].id, qty: '' }); paintR(); } const d = ev.target.closest('[data-rdel]'); if (d) { rows.splice(+d.dataset.rdel, 1); paintR(); } };
      $('#dlgBody').onsubmit = attempt(async ev => {
        ev.preventDefault(); const items = rows.filter(r => String(r.qty).trim() !== '').map(r => ({ ingredientId: r.id, qty: num(r.qty) }));
        if (items.some(x => !(x.qty > 0))) throw new Error('Quantidade inválida');
        if (target) await rpc('set_option_recipe', { p_product: p.id, p_option: target, p_items: items });
        else await rpc('set_recipe', { p_product: p.id, p_items: items });
        closeDlg(); toast(target ? `Ficha de "${target}" salva` : 'Ficha salva'); await load();
      });
    }
  });
  cleanup = () => { app.onclick = null; };
  await load();
}

/* ---------- mesas: conta de cada mesa ---------- */
// Fechar a conta da mesa: uma forma de pagamento, ou dividida entre pessoas (cada parte com sua forma)
function closeTableDialog(S, m, after) {
  const due = m.total - m.paidOnline, PAY = [['Dinheiro', 'Dinheiro'], ['Pix', 'Pix'], ['Cartão na entrega', 'Cartão']];
  let parts = null;   // null = uma forma só; senão [{ amount, method }]
  const split = n => { n = Math.max(2, Math.min(30, n)); const base = Math.floor(due / n); return Array.from({ length: n }, (_, i) => ({ amount: base + (i < due - base * n ? 1 : 0), method: parts?.[i]?.method || 'Pix' })); };
  const draw = () => {
    const sum = parts ? parts.reduce((a, p) => a + (Number.isInteger(p.amount) ? p.amount : 0), 0) : 0, left = due - sum;
    $('#dlgBody').innerHTML = `<h2>Fechar conta · Mesa ${esc(m.table)}</h2>
      <div class="tot"><span>A pagar</span><span class="price">${brl(due)}</span></div>
      ${due > 0 ? `<div class="segs" style="grid-template-columns:1fr 1fr"><button type="button" data-mode="one" class="${parts ? '' : 'on'}">Uma forma de pagamento</button><button type="button" data-mode="split" class="${parts ? 'on' : ''}">Dividir a conta</button></div>` : ''}
      ${!parts ? `<p class="mut" style="margin:0">Como foi pago?</p>
        <div class="row">${PAY.map(([v, l]) => `<button class="pri" data-pay="${v}">${l}</button>`).join('')}<button class="ghost" data-close>Cancelar</button></div>`
      : `<label>Dividir por <span class="row" style="flex-wrap:nowrap;gap:6px"><button type="button" class="ghost sm" data-n="-1">−</button><b style="min-width:2ch;text-align:center">${parts.length}</b><button type="button" class="ghost sm" data-n="1">+</button> pessoas</span></label>
        <div class="splits">${parts.map((p, i) => `<div class="row splitrow"><span class="mut" style="min-width:5.5em">Pessoa ${i + 1}</span>
          <input data-amt="${i}" inputmode="decimal" value="${Number.isInteger(p.amount) ? fromCents(p.amount) : ''}" aria-label="Valor da pessoa ${i + 1}">
          <select data-met="${i}" aria-label="Forma de pagamento da pessoa ${i + 1}">${PAY.map(([v, l]) => `<option value="${v}" ${p.method === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>
        <p class="${left ? 'stuck' : 'mut'}" style="display:block;margin:0">${left === 0 ? '✓ A soma fecha com a conta.' : left > 0 ? `Faltam ${brl(left)} para fechar a conta.` : `Passou ${brl(-left)} do total da conta.`}</p>
        <div class="row"><button class="pri" id="splitGo" ${left === 0 ? '' : 'disabled'}>Fechar conta dividida</button><button type="button" class="ghost" data-split-eq>Dividir igual</button><button class="ghost" data-close>Cancelar</button></div>`}
      ${m.pending ? `<p class="mut">⚠ ${m.pending} pedido(s) ainda na cozinha. Ao fechar, eles saem da fila como servidos.</p>` : ''}`;
  };
  dialog(''); draw();
  const done = n => { closeDlg(); toast(`Conta da mesa ${m.table} fechada`); return after(); };
  $('#dlgBody').onclick = attempt(async ev => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.mode) { parts = b.dataset.mode === 'split' ? split(2) : null; return draw(); }
    if (b.dataset.n) { parts = split(parts.length + +b.dataset.n); return draw(); }
    if (b.hasAttribute('data-split-eq')) { parts = split(parts.length); return draw(); }
    if (b.dataset.pay) { b.disabled = true; try { await rpc('close_table', { p_tenant: S.id, p_table: m.table, p_payment: b.dataset.pay }); await done(); } finally { b.disabled = false; } return; }
    if (b.id === 'splitGo') { b.disabled = true; try { await rpc('close_table_split', { p_tenant: S.id, p_table: m.table, p_payments: parts.map(p => ({ method: p.method, amount: p.amount })) }); await done(); } finally { b.disabled = false; } }
  });
  $('#dlgBody').onchange = ev => {
    const t = ev.target;
    if (t.dataset.amt != null) { const v = toCents(t.value || '0'); parts[+t.dataset.amt].amount = Number.isInteger(v) && v >= 0 ? v : NaN; draw(); }
    if (t.dataset.met != null) parts[+t.dataset.met].method = t.value;
  };
}

function printBill(S, m) {
  // junta itens iguais (mesmo produto, opções e preço) de todos os pedidos da mesa
  const agg = []; for (const i of m.items) { const k = agg.find(x => x.name === i.name && x.options === i.options && x.unit === i.unit); k ? k.qty += i.qty : agg.push({ ...i }); }
  $('#print').innerHTML = `<div class="tkt"><b class="big">${esc(S.name)}</b><div>CONTA · <b class="big">MESA ${esc(m.table)}</b></div>
    <div>${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · pedidos ${m.orders.map(o => '#' + o.number).join(', ')}</div><hr>
    ${agg.map(x => `<div class="li"><span>${x.qty}x ${esc(x.name)}</span><span>${brl(x.qty * x.unit)}</span></div>${x.options ? `<div class="sub">${esc(x.options)}</div>` : ''}`).join('')}<hr>
    <div class="li"><span>Subtotal</span><span>${brl(m.subtotal)}</span></div>
    ${m.discount ? `<div class="li"><span>Descontos</span><span>-${brl(m.discount)}</span></div>` : ''}${m.service ? `<div class="li"><span>Serviço (opcional)</span><span>${brl(m.service)}</span></div>` : ''}
    <div class="li big"><b>TOTAL</b><b>${brl(m.total)}</b></div>${m.paidOnline ? `<div class="li"><span>Já pago online</span><span>-${brl(m.paidOnline)}</span></div><div class="li big"><b>A PAGAR</b><b>${brl(m.total - m.paidOnline)}</b></div>` : ''}
    <div class="sub">Não é documento fiscal.</div></div>`;
  window.print();
}
async function pTables(S) {
  let tables = [];
  const load = async () => { tables = await rpc('open_tables', { p_tenant: S.id }); draw(); };
  const draw = () => {
    app.innerHTML = `<h2>Mesas</h2><p class="lead">Contas abertas: todos os pedidos de cada mesa somados até o fechamento. ${tables.length ? `${tables.length} mesa(s) ocupada(s) · ${brl(tables.reduce((a, m) => a + m.total, 0))} em aberto.` : ''}</p>
    <div class="tables">${tables.map(m => { const due = m.total - m.paidOnline; return `<div class="panel tablecard"><div class="row between"><h3 style="margin:0">Mesa ${esc(m.table)}</h3><span class="mut">desde ${hhmm(m.since)} · ${mins(m.since)} min</span></div>
      <p class="mut" style="margin:4px 0">${m.orders.map(o => `#${o.number} <span class="badge ${o.status === 'entregue' ? 'b-g' : o.status === 'pronto' ? 'b-a' : ''}">${o.status === 'entregue' ? 'servido' : esc((SLABEL[o.status] || o.status).toLowerCase())}</span>`).join(' ')}</p>
      <div class="li"><span>${m.items.reduce((a, i) => a + i.qty, 0)} itens</span><span class="price">${brl(m.subtotal)}</span></div>
      ${m.service ? `<div class="li"><span class="mut">Serviço</span><span class="price">${brl(m.service)}</span></div>` : ''}${m.discount ? `<div class="li"><span class="mut">Descontos</span><span class="price">−${brl(m.discount)}</span></div>` : ''}
      <div class="tot"><span>${m.paidOnline ? 'A pagar' : 'Total'}</span><span class="price">${brl(due)}</span></div>
      ${m.pending ? `<p class="mut" style="margin:0">⚠ ${m.pending} pedido(s) ainda na cozinha</p>` : ''}
      <div class="row"><button class="ghost sm" data-bill="${esc(m.table)}">Imprimir conta</button><button class="pri sm" data-close-t="${esc(m.table)}">Fechar conta</button></div></div>`; }).join('') || '<p class="empty">Nenhuma mesa com conta aberta.</p>'}</div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    const m = tables.find(x => x.table === (b.dataset.bill || b.dataset.closeT)); if (!m) return;
    if (b.dataset.bill) return printBill(S, m);
    closeTableDialog(S, m, load);
  });
  const stop = live(S.id, () => load().catch(() => {}));
  cleanup = () => { stop(); app.onclick = null; };
  await load();
}

/* ---------- totem de autoatendimento ---------- */
async function pKiosk(S) {
  document.body.classList.add('kds-on', 'kiosk'); setColor(S.color); brand(S.name, S.logo_path);
  local.set('kioskLock', true);
  const all = sortMenu(await q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)));
  let stage = 'start', cart = [], cat = null, name = '', away = false, done = null, idleT, warnT, backT;
  const items = () => all.filter(p => p.stock !== 0 && catOpen(S, p.category, new Date()));
  const cats = () => [...new Set(items().map(p => p.category))];
  const total = () => cart.reduce((t, c) => t + c.unit * c.qty, 0), count = () => cart.reduce((t, c) => t + c.qty, 0);
  const reset = () => { cart = []; name = ''; away = false; done = null; cat = null; stage = 'start'; closeDlg(); draw(); };
  const add = it => { const k = cart.find(c => c.productId === it.productId && c.optionIds.join() === it.optionIds.join() && c.notes === it.notes); k ? k.qty += it.qty : cart.push(it); toast(`${it.name} no pedido`); draw(); };
  const logo = S.logo_path ? `<img class="klogo" src="${esc(imgUrl(S.logo_path))}" alt="">` : '';
  const draw = () => {
    const open = openState(S).open;
    if (stage === 'start') {
      app.innerHTML = `<div class="kstart" data-k="begin">${logo}<h1>${esc(S.name)}</h1>
        ${open ? '<button class="pri kbig" data-k="begin">Toque para fazer seu pedido</button><p>Escolha, confirme e pague no caixa. Chamamos pelo número.</p>' : '<p class="kclosed">Estamos fechados agora</p>'}
        <button class="kexit" data-k="exit" aria-label="Sair do totem">⋯</button></div>`;
      return;
    }
    if (stage === 'done') {
      app.innerHTML = `<div class="kstart"><p class="kok">Pedido feito!</p><div class="knum">${done.number}</div>
        <h2>${done.status === 'preparo' ? 'Já estamos preparando.' : 'Agora é só pagar no caixa.'}</h2>
        <p>${done.status === 'preparo' ? 'Pague no caixa e aguarde: chamamos pelo número ' : 'Diga o número '}<b>${done.number}</b>${done.status === 'preparo' ? '.' : ' no caixa. Depois é só aguardar ser chamado.'}</p>
        <p class="kprice">Total: ${brl(done.total)}</p><button class="pri kbig" data-k="new">Fazer outro pedido</button></div>`;
      return;
    }
    const cs = cats(); if (!cs.includes(cat)) cat = cs[0];
    app.innerHTML = `<div class="kwrap">
      <aside class="kcats">${logo}${cs.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</aside>
      <section class="kmenu"><h2>${esc(cat || '')}</h2><div class="kgrid">${items().filter(p => p.category === cat).map(p => `<button class="kitem" data-p="${p.id}">${picture(p, S.color)}<b>${esc(p.name)}</b><span class="mut">${esc(p.description || '')}</span><span class="price">${brl(p.price)}${p.groups.length ? ' <small class="mut">+ opções</small>' : ''}</span></button>`).join('') || '<p class="mut">Nada nesta categoria agora.</p>'}</div></section>
      <aside class="kcart"><h2>Seu pedido</h2>
        <div class="klist">${cart.map((c, i) => `<div class="kline"><div><b>${esc(c.name)}</b>${c.optText ? `<br><small class="mut">${esc(c.optText)}</small>` : ''}${c.notes ? `<br><small class="mut">${esc(c.notes)}</small>` : ''}<br><span class="price">${brl(c.unit * c.qty)}</span></div>
          <span class="kq"><button data-q="${i}" data-d="-1" aria-label="Menos">−</button><b>${c.qty}</b><button data-q="${i}" data-d="1" aria-label="Mais">+</button></span></div>`).join('') || '<p class="mut">Toque nos produtos para adicionar.</p>'}</div>
        <div class="tot"><span>Total</span><span class="price">${brl(total())}</span></div>
        ${stage === 'menu' ? `<button class="pri kbig" data-k="finish" ${cart.length ? '' : 'disabled'}>Finalizar (${count()})</button>`
        : `<form id="kF" class="grid" style="gap:10px"><label>Seu nome, para chamarmos<input id="kName" value="${esc(name)}" required maxlength="40" autocomplete="off" placeholder="Ex.: Ana"></label>
            <div class="segs" style="grid-template-columns:1fr 1fr"><button type="button" data-away="0" class="${away ? '' : 'on'}">Comer aqui</button><button type="button" data-away="1" class="${away ? 'on' : ''}">Para levar</button></div>
            <p class="mut" style="margin:0">Pagamento no caixa: dinheiro, Pix ou cartão.</p>
            <button class="pri kbig" id="kSend">Confirmar pedido</button><button type="button" class="ghost" data-k="back">Voltar ao cardápio</button></form>`}
        <button class="ghost" data-k="cancel">Cancelar pedido</button></aside></div>`;
    if (stage === 'name') $('#kName')?.focus();
  };
  // Sem toque por 90 s: pergunta se ainda tem alguém; mais 20 s, recomeça
  const poke = () => {
    clearTimeout(idleT); clearTimeout(warnT);
    if (stage === 'start') return;
    idleT = setTimeout(() => {
      if (stage === 'done') return reset();
      dialog('<h2>Ainda está aí?</h2><p>Toque em continuar para manter seu pedido.</p><div class="row"><button class="pri kbig" data-close>Continuar</button></div>');
      warnT = setTimeout(reset, 20000);
    }, stage === 'done' ? 15000 : 90000);
  };
  const onAny = () => poke();
  document.addEventListener('pointerdown', onAny, true); document.addEventListener('keydown', onAny, true);
  const exit = () => {
    const pin = local.get('kioskPin', '');
    dialog(`<h2>Sair do totem</h2>${pin ? '<label>PIN do totem<input id="kPin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>' : '<p>Voltar para o painel da loja?</p>'}
      <div class="row"><button class="pri" id="kOut">Sair</button><button class="ghost" data-close>Cancelar</button></div>`);
    $('#dlgBody').onclick = e => {
      if (!e.target.closest('#kOut')) return;
      if (pin && $('#kPin').value !== pin) return toast('PIN incorreto');
      local.set('kioskLock', false); closeDlg(); go('/painel');
    };
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button,[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'exit') return exit();
    if (k === 'begin' && openState(S).open) { stage = 'menu'; draw(); return poke(); }
    if (k === 'new') return reset();
    if (k === 'cancel') { if (!cart.length) return reset(); dialog('<h2>Cancelar o pedido?</h2><p>Os itens escolhidos serão apagados.</p><div class="row"><button class="pri" id="kYes">Sim, cancelar</button><button class="ghost" data-close>Continuar pedindo</button></div>'); $('#dlgBody').onclick = ev => { if (ev.target.closest('#kYes')) reset(); }; return; }
    if (k === 'finish') { stage = 'name'; return draw(); }
    if (k === 'back') { name = $('#kName')?.value || name; stage = 'menu'; return draw(); }
    if (b.dataset.away != null) { name = $('#kName')?.value || name; away = b.dataset.away === '1'; return draw(); }
    if (b.dataset.cat) { cat = b.dataset.cat; draw(); return $('.kmenu')?.scrollTo(0, 0); }
    if (b.dataset.p) { const p = all.find(x => x.id === +b.dataset.p); return openBuilder(p, add); }
    if (b.dataset.q != null) { const c = cart[+b.dataset.q]; c.qty += +b.dataset.d; if (c.qty <= 0) cart.splice(+b.dataset.q, 1); return draw(); }
  });
  app.onsubmit = attempt(async e => {
    e.preventDefault();
    name = $('#kName').value.trim(); if (!name) throw new Error('Digite seu nome');
    const btn = $('#kSend'); btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await rpc('kiosk_place_order', { p_tenant: S.id, p: { customer: { name }, fulfillment: 'pickup', payment: 'Pagar no caixa',
        items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: (away ? (c.notes ? `Para levar · ${c.notes}` : 'Para levar') : c.notes).slice(0, 140) })) } });
      done = r; cart = []; stage = 'done'; draw(); poke();
    } finally { const b2 = $('#kSend'); if (b2) { b2.disabled = false; b2.textContent = 'Confirmar pedido'; } }
  });
  const tick = setInterval(() => { if (stage === 'start') draw(); }, 60000);   // abre/fecha sozinho pelo horário
  try { await document.documentElement.requestFullscreen?.(); } catch {}
  cleanup = () => { clearInterval(tick); clearTimeout(idleT); clearTimeout(warnT); clearTimeout(backT); document.removeEventListener('pointerdown', onAny, true); document.removeEventListener('keydown', onAny, true);
    app.onclick = app.onsubmit = null; document.body.classList.remove('kds-on', 'kiosk'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  draw();
}

/* ---------- garçom: mapa das mesas no celular ---------- */
async function pWaiter(S) {
  let tables = [];
  const load = async () => { tables = await rpc('open_tables', { p_tenant: S.id }); draw(); };
  const labels = () => { const n = Array.from({ length: S.tables_count || 10 }, (_, i) => String(i + 1)); return [...n, ...tables.map(t => t.table).filter(t => !n.includes(t))]; };
  const draw = () => {
    const busy = Object.fromEntries(tables.map(t => [t.table, t]));
    app.innerHTML = `<div class="row between"><div><h2>Garçom</h2><p class="lead">Toque na mesa para lançar itens, pedir a conta ou fechar. ${tables.length ? `${tables.length} ocupada(s).` : 'Todas livres.'}</p></div></div>
      <div class="wgrid">${labels().map(l => { const m = busy[l]; return `<button class="wtable ${m ? (m.pending ? 'busy cook' : 'busy') : ''}" data-t="${esc(l)}"><b>${esc(l)}</b>${m ? `<span>${brl(m.total - m.paidOnline)}</span><small>${mins(m.since)} min${m.pending ? ' · cozinha' : ''}</small>` : '<small>livre</small>'}</button>`; }).join('')}</div>
      <p class="mut" style="margin-top:12px"><span class="wdot busy"></span> ocupada · <span class="wdot cook"></span> com pedido na cozinha</p>`;
  };
  const sheet = l => {
    const m = tables.find(t => t.table === l), add = `/painel/novo?mesa=${encodeURIComponent(l)}&volta=garcom`;
    if (!m) return go(add);
    const agg = []; for (const i of m.items) { const k = agg.find(x => x.name === i.name && x.options === i.options && x.unit === i.unit); k ? k.qty += i.qty : agg.push({ ...i }); }
    dialog(`<h2>Mesa ${esc(l)}</h2><p class="mut" style="margin:0">Aberta desde ${hhmm(m.since)} · ${m.orders.length} pedido(s)${m.pending ? ` · ${m.pending} na cozinha` : ''}</p>
      <div class="scroll" style="max-height:40vh"><div style="display:grid;gap:8px">${agg.map(x => `<div class="ci"><span>${x.qty}× ${esc(x.name)}${x.options ? `<br><small class="mut">${esc(x.options)}</small>` : ''}</span><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('')}
      ${m.service ? `<div class="ci"><span class="mut">Serviço</span><span class="price">${brl(m.service)}</span></div>` : ''}</div></div>
      <div class="tot"><span>${m.paidOnline ? 'A pagar' : 'Total'}</span><span class="price">${brl(m.total - m.paidOnline)}</span></div>
      <div class="wact"><a class="btn pri" href="${add}" data-link id="wAdd">+ Adicionar itens</a><button class="ghost" id="wBill">Imprimir conta</button><button class="pri" id="wClose">Fechar conta</button></div>`);
    $('#dlgBody').onclick = attempt(async e => {
      if (e.target.closest('#wAdd')) return closeDlg();
      if (e.target.closest('#wBill')) return printBill(S, m);
      if (e.target.closest('#wClose')) return closeTableDialog(S, m, load);
    });
  };
  app.onclick = e => { const b = e.target.closest('[data-t]'); if (b) sheet(b.dataset.t); };
  const stop = live(S.id, () => load().catch(() => {}));
  const tick = setInterval(() => load().catch(() => {}), 60000);
  cleanup = () => { stop(); clearInterval(tick); app.onclick = null; };
  await load();
}

/* ---------- várias unidades ---------- */
// Cores fixas por unidade (paleta categórica validada; a cor segue a loja, não a posição no ranking)
const UNIT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
function unitsChart(el, rep, colorOf) {
  const W = el.clientWidth || 800, H = 240, P = { l: 56, r: 16, t: 12, b: 26 }, days = rep.daily, ids = rep.units.slice(0, 8).map(u => u.id);
  const max = Math.max(1, ...days.flatMap(d => ids.map(id => d.units[id] || 0)));
  const step = 10 ** Math.floor(Math.log10(max)), nice = Math.ceil(max / step) * step;
  const x = i => P.l + (days.length < 2 ? 0 : i * (W - P.l - P.r) / (days.length - 1)), y = v => P.t + (H - P.t - P.b) * (1 - v / nice);
  const grid = [0, .25, .5, .75, 1].map(f => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(nice * f)}" y2="${y(nice * f)}" class="gl"/><text x="${P.l - 6}" y="${y(nice * f) + 4}" text-anchor="end" class="ax">${f ? brl(nice * f).replace(/,00$/, '') : '0'}</text>`).join('');
  const every = Math.ceil(days.length / 8), xl = days.map((d, i) => (i % every === 0 && days.length - 1 - i >= every / 2) || i === days.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="ax">${d.day.slice(8, 10)}/${d.day.slice(5, 7)}</text>` : '').join('');
  const lines = ids.map(id => `<polyline fill="none" stroke="${colorOf(id)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${days.map((d, i) => `${x(i).toFixed(1)},${y(d.units[id] || 0).toFixed(1)}`).join(' ')}"/>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Vendas por dia de cada unidade">${grid}${xl}${lines}<line id="ucx" y1="${P.t}" y2="${H - P.b}" class="cx" hidden/>${ids.map(id => `<circle data-u="${id}" r="4" fill="${colorOf(id)}" stroke="var(--card)" stroke-width="2" hidden/>`).join('')}<rect x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent" id="uhit"/></svg><div class="utip" hidden></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.utip'), cx = el.querySelector('#ucx');
  const hide = () => { tip.hidden = true; cx.setAttribute('hidden', ''); el.querySelectorAll('circle').forEach(c => c.setAttribute('hidden', '')); };
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(days.length - 1, Math.round((px - P.l) / ((W - P.l - P.r) / Math.max(1, days.length - 1))))), d = days[i];
    cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i)); cx.removeAttribute('hidden');
    el.querySelectorAll('circle').forEach(c => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(d.units[c.dataset.u] || 0)); c.removeAttribute('hidden'); });
    const rows = rep.units.slice(0, 8).map(u => ({ u, v: d.units[u.id] || 0 })).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<b>${d.day.split('-').reverse().join('/')}</b>${rows.map(({ u, v }) => `<div class="tr"><span class="sw" style="background:${colorOf(u.id)}"></span><span>${esc(u.name)}</span><b>${brl(v)}</b></div>`).join('')}<div class="mut">Total ${brl(rows.reduce((a, r) => a + r.v, 0))}</div>`;
    tip.hidden = false; const left = x(i) * r.width / W; tip.style.left = `${Math.min(Math.max(left + 12, 0), r.width - tip.offsetWidth - 4)}px`;
  });
  svg.addEventListener('pointerleave', hide);
}
async function pUnits(S) {
  let days = 30, rep = null;
  const loadRep = async () => { rep = await rpc('units_report', { p_days: days }).catch(() => null); };
  const draw = async () => {
    const us = await rpc('my_units');
    const order = [...us].sort((a, b) => String(a.id).localeCompare(String(b.id))), colorOf = id => UNIT_COLORS[order.findIndex(u => u.id === id) % 8] || '#888';
    const sum = k => us.reduce((a, u) => a + u[k].revenue, 0), cnt = k => us.reduce((a, u) => a + u[k].orders, 0);
    app.innerHTML = `<div class="row between"><div><h2>Unidades</h2><p class="lead">Todas as lojas da sua conta num lugar só. Cada unidade tem cardápio, pedidos, equipe e assinatura próprios.</p></div>
      <button class="pri" id="uNew">+ Nova unidade</button></div>
    <div class="kpis"><div class="kpi"><span class="mut">Vendas hoje (todas)</span><b class="price">${brl(sum('today'))}</b><span class="mut">${cnt('today')} pedido(s)</span></div>
      <div class="kpi"><span class="mut">Vendas no mês (todas)</span><b class="price">${brl(sum('month'))}</b><span class="mut">${cnt('month')} pedido(s)</span></div>
      <div class="kpi"><span class="mut">Unidades</span><b>${us.length}</b><span class="mut">${us.filter(u => u.open).length} aberta(s) agora</span></div>
      <div class="kpi"><span class="mut">Pedidos em andamento</span><b>${us.reduce((a, u) => a + u.openOrders, 0)}</b><span class="mut">em todas as unidades</span></div></div>
    <div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Unidade</th><th>Agora</th><th class="n">Hoje</th><th class="n">No mês</th><th class="n">Em andamento</th><th></th></tr></thead><tbody>
      ${us.map(u => `<tr><td data-l="Unidade"><span class="dot" style="background:${esc(u.color)}"></span><b>${esc(u.name)}</b>${u.id === S.id ? ' <span class="badge">esta</span>' : ''}<br><span class="mut">${esc(u.domain || '/loja/' + u.slug)}</span></td>
        <td data-l="Agora">${!u.active ? '<span class="badge b-r">Suspensa</span>' : !u.billingOk ? '<span class="badge b-r">Assinatura pendente</span>' : u.open ? '<span class="badge b-g">Aberta</span>' : '<span class="badge">Fechada</span>'}</td>
        <td data-l="Hoje" class="n"><span class="price">${brl(u.today.revenue)}</span><br><span class="mut">${u.today.orders} ped.</span></td>
        <td data-l="No mês" class="n"><span class="price">${brl(u.month.revenue)}</span><br><span class="mut">${u.month.orders} ped.</span></td>
        <td data-l="Em andamento" class="n">${u.openOrders}</td>
        <td data-l=""><span class="row">${u.id === S.id ? '' : `<button class="ghost sm" data-go="${u.id}">Abrir painel</button>`}<a class="btn ghost sm" href="${esc(storeLink({ slug: u.slug, custom_domain: u.domain }))}" target="_blank" rel="noopener">Ver loja</a></span></td></tr>`).join('')}</tbody></table></div></div>
    ${rep && us.length > 1 ? (() => { const T = rep.units.reduce((a, u) => ({ rev: a.rev + u.revenue, n: a.n + u.orders, c: a.c + u.customers }), { rev: 0, n: 0, c: 0 });
      return `<div class="row between" style="margin-top:28px"><h3 style="margin:0">Desempenho da rede</h3><div class="segs" style="grid-template-columns:repeat(3,auto)">${[7, 30, 90].map(d => `<button data-udays="${d}" class="${d === days ? 'on' : ''}">${d} dias</button>`).join('')}</div></div>
      <div class="kpis"><div class="kpi"><span class="mut">Vendas (${days} dias)</span><b class="price">${brl(T.rev)}</b><span class="mut">${T.n} pedido(s)</span></div>
        <div class="kpi"><span class="mut">Ticket médio da rede</span><b class="price">${T.n ? brl(Math.round(T.rev / T.n)) : '—'}</b><span class="mut">por pedido</span></div>
        <div class="kpi"><span class="mut">Clientes</span><b>${T.c}</b><span class="mut">telefones diferentes (somando as lojas)</span></div>
        <div class="kpi"><span class="mut">Melhor unidade</span><b style="font-size:20px">${esc(rep.units[0]?.name || '—')}</b><span class="mut">${T.rev ? Math.round(rep.units[0].revenue * 100 / T.rev) : 0}% das vendas</span></div></div>
      <div class="panel" style="margin-top:16px"><h3 style="margin-top:0">Vendas por dia</h3>
        <div class="ulegend">${rep.units.slice(0, 8).map(u => `<span><span class="sw" style="background:${colorOf(u.id)}"></span>${esc(u.name)}</span>`).join('')}${rep.units.length > 8 ? `<span class="mut">+${rep.units.length - 8} unidade(s) fora do gráfico (veja a tabela)</span>` : ''}</div>
        <div id="uChart" class="uchart"></div></div>
      <div class="panel" style="margin-top:16px"><div class="scroll"><table class="stack"><thead><tr><th>Unidade</th><th class="n">Vendas</th><th>Participação</th><th class="n">Pedidos</th><th class="n">Ticket</th><th class="n">Cancelados</th><th class="n">Preparo</th><th class="n">Nota</th></tr></thead><tbody>
        ${rep.units.map(u => { const sh = T.rev ? u.revenue * 100 / T.rev : 0; return `<tr><td data-l="Unidade"><span class="sw" style="background:${colorOf(u.id)}"></span><b>${esc(u.name)}</b></td>
          <td data-l="Vendas" class="n price">${brl(u.revenue)}</td>
          <td data-l="Participação"><span class="share"><span style="width:${sh.toFixed(1)}%;background:${colorOf(u.id)}"></span></span> ${Math.round(sh)}%</td>
          <td data-l="Pedidos" class="n">${u.orders}</td><td data-l="Ticket" class="n">${u.ticket ? brl(u.ticket) : '—'}</td>
          <td data-l="Cancelados" class="n">${u.cancelRate != null ? `${String(u.cancelRate).replace('.', ',')}%` : '—'}</td>
          <td data-l="Preparo" class="n">${u.prepMin != null ? `${u.prepMin} min` : '—'}</td>
          <td data-l="Nota" class="n">${u.rating ? `★ ${String(u.rating).replace('.', ',')} <span class="mut">(${u.ratings})</span>` : '—'}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="mut" style="margin:8px 0 0">Preparo = tempo mediano do pedido feito até ficar pronto. Cancelados = % dos pedidos do período.</p></div>
      ${rep.products.length ? `<div class="panel" style="margin-top:16px"><h3 style="margin-top:0">Mais vendidos da rede</h3><div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th class="n">Total</th>${rep.units.slice(0, 8).map(u => `<th class="n"><span class="sw" style="background:${colorOf(u.id)}"></span>${esc(u.name)}</th>`).join('')}<th class="n">Vendas</th></tr></thead><tbody>
        ${rep.products.map(p => `<tr><td data-l="Produto">${esc(p.name)}</td><td data-l="Total" class="n"><b>${p.qty}</b></td>${rep.units.slice(0, 8).map(u => `<td data-l="${esc(u.name)}" class="n">${p.byUnit[u.id] || '—'}</td>`).join('')}<td data-l="Vendas" class="n price">${brl(p.revenue)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`; })() : ''}`;
    if (rep && us.length > 1 && $('#uChart')) unitsChart($('#uChart'), rep, colorOf);
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go) { local.set('tenant', b.dataset.go); return go('/painel'); }
    if (b.dataset.udays) { days = +b.dataset.udays; await loadRep(); return draw(); }
    if (b.id === 'uNew') {
      dialog(`<h2>Nova unidade</h2><p class="mut" style="margin:0">A nova loja começa com uma cópia do cardápio (com opções e fotos), das taxas de entrega, das promoções, dos horários e das regras de <b>${esc(S.name)}</b>. Endereço, telefone, equipe, cupons e Mercado Pago você configura depois.</p>
        <form id="fUnit"><label>Nome da unidade<input id="uN" required maxlength="80" placeholder="${esc(S.name)} — Centro"></label>
        <label>Endereço da loja (opcional)<input id="uS" maxlength="40" placeholder="${esc(S.slug)}-centro"></label>
        <p class="mut" style="margin:0">Cada unidade tem a própria assinatura (com teste grátis).</p>
        <div class="row"><button class="pri">Criar unidade</button><button class="ghost" type="button" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').onsubmit = attempt(async ev => {
        ev.preventDefault(); const btn = ev.target.querySelector('button.pri'); btn.disabled = true;
        try {
          const t = await rpc('create_unit', { p_from: S.id, p_name: $('#uN').value, p_slug: $('#uS').value.trim() || null });
          closeDlg(); toast(`Unidade "${t.name}" criada`); local.set('tenant', t.id); go('/painel/config');
        } finally { btn.disabled = false; }
      });
    }
  });
  cleanup = () => { app.onclick = null; };
  await loadRep(); await draw();
}

// Planilha de pedidos do período (para o contador): uma linha por pedido, itens numa coluna. Busca em lotes de 1.000.
async function exportOrders(S, days) {
  const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)) : new Date(Date.now() - days * 864e5);
  const all = [];
  for (let i = 0; i < 50; i++) {
    const page = await q(sb.from('orders').select('number, created_at, channel, fulfillment, table_label, customer_name, customer_phone, address, zone_name, payment, payment_status, status, subtotal, fee, service_fee, discount, promo_discount, total, coupon_code, items:order_items(product_name, options_text, qty, unit_price)')
      .eq('tenant_id', S.id).gte('created_at', from.toISOString()).neq('status', 'pagamento').order('created_at').range(i * 1000, i * 1000 + 999));
    all.push(...page); if (page.length < 1000) break;
  }
  if (!all.length) return toast('Nenhum pedido no período');
  const FUL = { delivery: 'Entrega', pickup: 'Retirada', table: 'Mesa' };
  const money = c => fromCents(c || 0);
  const rows = [['Número', 'Data', 'Hora', 'Canal', 'Tipo', 'Cliente', 'Telefone', 'Endereço', 'Bairro/Mesa', 'Pagamento', 'Pago online', 'Situação', 'Produtos', 'Entrega', 'Serviço', 'Desconto', 'Promoção', 'Total', 'Cupom', 'Itens'],
    ...all.map(o => { const d = new Date(o.created_at); return [o.number, d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      CHANNEL[o.channel] || o.channel || 'Site', FUL[o.fulfillment] || o.fulfillment, o.customer_name, o.customer_phone, o.address || '', o.zone_name || '',
      o.payment, o.payment_status === 'paid' ? 'sim' : 'não', SLABEL[o.status] || o.status, money(o.subtotal), money(o.fee), money(o.service_fee), money(o.discount), money(o.promo_discount), money(o.total), o.coupon_code || '',
      (o.items || []).map(x => `${x.qty}x ${x.product_name}${x.options_text ? ` (${x.options_text})` : ''}`).join(' | ')]; })];
  const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(';')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `pedidos-${S.slug}-${days === 1 ? 'hoje' : days + 'dias'}.csv`; a.click(); URL.revokeObjectURL(a.href);
  toast(`${all.length} pedido(s) na planilha`);
}

// Mapa de horários: linhas = dias (seg→dom), colunas = horas com movimento; cor mais forte = mais pedidos.
function heatmap(cells, days) {
  const max = Math.max(...cells.map(c => c.orders)), peak = cells.find(c => c.orders === max);
  const hours = cells.map(c => c.hour), h0 = Math.min(...hours), h1 = Math.max(...hours), H = Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i);
  const at = (d, h) => cells.find(c => c.dow === d && c.hour === h);
  return `<div class="panel"><h3>Horários de pico</h3><p class="mut" style="margin:0 0 8px">Pico: <b>${DAYS[peak.dow].toLowerCase()} às ${peak.hour}h</b> (${max} pedidos nos últimos ${days} dias). Use para escalar equipe e entregadores.</p>
    <div class="scroll"><table class="heat"><thead><tr><th></th>${H.map(h => `<th>${h}h</th>`).join('')}</tr></thead><tbody>
    ${[1, 2, 3, 4, 5, 6, 0].map(d => `<tr><th>${DAYS[d].slice(0, 3)}</th>${H.map(h => { const c = at(d, h); return `<td style="--a:${c ? (0.12 + 0.88 * c.orders / max).toFixed(2) : 0}" title="${DAYS[d]} ${h}h: ${c ? `${c.orders} pedido(s) · ${brl(c.revenue)}` : 'sem pedidos'}">${c && c.orders / max >= 0.5 ? c.orders : ''}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div></div>`;
}

/* ---------- relatórios ---------- */
const nextMonth = ym => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
async function pReports(S) {
  let days = 7;
  // Financeiro do mês: faturamento − custo dos insumos vendidos − despesas = resultado
  let month = new Date().toLocaleDateString('en-CA', { timeZone: S.timezone || 'America/Sao_Paulo' }).slice(0, 7);
  const CATS = ['Aluguel', 'Salários', 'Energia', 'Água', 'Gás', 'Embalagens', 'Ingredientes avulsos', 'Marketing', 'Taxas e impostos', 'Aplicativos', 'Manutenção', 'Outros'];
  // Engenharia de cardápio: popularidade × margem (método Kasavana & Smith) + curva ABC da receita
  // Avaliação por produto: a nota de cada pedido vale para os produtos dele
  const drawPRat = async () => {
    const box = $('#prat'); if (!box) return;
    const d = Math.max(days, 30), all = await rpc('product_ratings', { p_tenant: S.id, p_days: d }).catch(() => null);
    if (!all || !all.length) { box.innerHTML = ''; return; }
    const rows = all.filter(x => x.count >= 2), worst = rows.filter(x => x.avg < 4).slice(0, 5), best = [...rows].sort((a, b) => b.avg - a.avg || b.count - a.count).slice(0, 5);
    const stars = v => `<span class="stars">${'★'.repeat(Math.round(v))}${'☆'.repeat(5 - Math.round(v))}</span> <b>${String(v).replace('.', ',')}</b>`;
    box.innerHTML = `<div class="panel" style="margin-top:20px"><h3>Avaliação por produto <span class="mut" style="font-weight:400">· últimos ${d} dias</span></h3>
      <p class="mut" style="margin:0 0 10px">A nota de cada pedido vale para os produtos que estavam nele. Produtos com menos de 2 avaliações não entram. Na loja online, a nota aparece a partir de 3 avaliações.</p>
      ${rows.length ? `<div class="two"><div><h4 style="margin:0 0 6px">Mais elogiados</h4>${best.map(x => `<div class="ci"><span>${esc(x.name)}<br><small class="mut">${x.count} avaliação(ões)</small></span><span>${stars(x.avg)}</span></div>`).join('')}</div>
        <div><h4 style="margin:0 0 6px">Precisam de atenção</h4>${worst.map(x => `<div class="ci"><span>${esc(x.name)}<br><small class="mut">${x.low} nota(s) baixa(s) de ${x.count}</small>${x.comments.filter(c => c.rating <= 3).slice(0, 2).map(c => `<br><small>“${esc(c.comment)}”</small>`).join('')}</span><span>${stars(x.avg)}</span></div>`).join('') || '<p class="mut">Nenhum produto com nota abaixo de 4. 👏</p>'}</div></div>` : '<p class="mut">Ainda há poucas avaliações para comparar os produtos.</p>'}</div>`;
  };
  const drawEng = async () => {
    const box = $('#eng'); if (!box) return;
    const d = Math.max(days, 30), all = await rpc('menu_engineering', { p_tenant: S.id, p_days: d }).catch(() => null);
    if (!all) { box.innerHTML = ''; return; }
    const sold = all.filter(x => x.qty > 0), totQ = sold.reduce((a, x) => a + x.qty, 0), totR = sold.reduce((a, x) => a + x.revenue, 0);
    if (sold.length < 3) { box.innerHTML = ''; return; }
    const withR = sold.filter(x => x.hasRecipe), unit = x => (x.revenue - x.cost) / x.qty;
    const avgM = withR.length ? withR.reduce((a, x) => a + (x.revenue - x.cost), 0) / withR.reduce((a, x) => a + x.qty, 0) : null;
    const popCut = 0.7 / sold.length;   // popular = vende pelo menos 70% da média de participação
    let acc = 0; const abc = new Map(sold.map(x => { acc += x.revenue; return [x.id, acc / totR <= 0.8 ? 'A' : acc / totR <= 0.95 ? 'B' : 'C']; }));
    const cls = x => { const pop = x.qty / totQ >= popCut; if (!x.hasRecipe || avgM === null) return pop ? 'pop' : 'low';
      const hi = unit(x) >= avgM; return pop && hi ? 'estrela' : pop ? 'burro' : hi ? 'enigma' : 'abacaxi'; };
    const Q = { estrela: ['★ Estrelas', 'vendem muito e dão boa margem', 'Mantenha em destaque, com boa foto. Evite mexer no preço.'],
      burro: ['Burros de carga', 'vendem muito, mas a margem é baixa', 'Revise a ficha e a porção, negocie insumos ou suba um pouco o preço.'],
      enigma: ['Quebra-cabeças', 'boa margem, mas vendem pouco', 'Divulgue: foto melhor, vitrine, promoção, sugestão no carrinho.'],
      abacaxi: ['Abacaxis', 'vendem pouco e a margem é baixa', 'Repense a receita ou tire do cardápio.'] };
    const groups = Object.keys(Q).map(k => [k, sold.filter(x => cls(x) === k)]);
    const noRec = sold.filter(x => !x.hasRecipe), never = all.filter(x => !x.qty && x.available);
    box.innerHTML = `<div class="panel" style="margin-bottom:16px"><h3>Engenharia de cardápio <span class="mut" style="font-weight:400">· últimos ${d} dias</span></h3>
      <p class="mut" style="margin:0 0 10px">Cada produto é classificado pelo quanto vende e pela margem de cada unidade (preço menos o custo da ficha técnica). Margem média: ${avgM === null ? '— (monte as fichas na aba Estoque)' : brl(Math.round(avgM)) + ' por item'}.</p>
      ${avgM === null ? '' : `<div class="quad">${groups.map(([k, xs]) => `<div class="q q-${k}"><b>${Q[k][0]} (${xs.length})</b><span class="mut">${Q[k][1]}</span>
        <span>${xs.slice(0, 6).map(x => esc(x.name)).join(', ') || '—'}${xs.length > 6 ? ` e mais ${xs.length - 6}` : ''}</span><span class="tip">${Q[k][2]}</span></div>`).join('')}</div>`}
      <details style="margin-top:10px"><summary class="mut">Tabela completa e curva ABC (A = produtos que fazem 80% da receita)</summary><div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th class="n">Vendidos</th><th class="n">Receita</th><th>ABC</th><th class="n">Margem/un</th><th>Classe</th></tr></thead><tbody>
        ${sold.map(x => `<tr><td data-l="Produto"><b>${esc(x.name)}</b><br><span class="mut">${esc(x.category)}</span></td><td data-l="Vendidos" class="n">${x.qty}</td><td data-l="Receita" class="n price">${brl(x.revenue)}</td>
          <td data-l="ABC"><span class="badge ${abc.get(x.id) === 'A' ? 'b-g' : abc.get(x.id) === 'B' ? 'b-a' : ''}">${abc.get(x.id)}</span></td>
          <td data-l="Margem/un" class="n">${x.hasRecipe ? brl(Math.round(unit(x))) : '<span class="mut">sem ficha</span>'}</td><td data-l="Classe">${Q[cls(x)]?.[0] || (cls(x) === 'pop' ? 'popular' : 'pouco vendido')}</td></tr>`).join('')}</tbody></table></div></details>
      ${noRec.length && avgM !== null ? `<p class="mut" style="margin:8px 0 0">${noRec.length} produto(s) vendido(s) sem ficha técnica ficaram fora da matriz.</p>` : ''}
      ${never.length ? `<p class="mut" style="margin:6px 0 0">Nenhuma venda no período: ${never.slice(0, 8).map(x => esc(x.name)).join(', ')}${never.length > 8 ? '…' : ''}.</p>` : ''}</div>`;
  };
  // Atividades da equipe: quem mudou preço, cancelou pedido, mexeu no caixa, criou cupom…
  let actFilter = '';
  const drawActs = async () => {
    const box = $('#acts'); if (!box) return;
    const list = await q(sb.from('activity_log').select('at, email, action, detail').eq('tenant_id', S.id).order('at', { ascending: false }).limit(200)).catch(() => null);
    if (!list) { box.innerHTML = ''; return; }
    const acts = [...new Set(list.map(x => x.action))].sort(), shown = actFilter ? list.filter(x => x.action === actFilter) : list;
    const wasOpen = box.querySelector('details')?.open;
    box.innerHTML = `<details class="panel" style="margin-bottom:16px" ${wasOpen ? 'open' : ''}><summary><b>Atividades da equipe</b> <span class="mut">· ${list.length ? `última: ${esc(list[0].action.toLowerCase())} por ${esc(list[0].email || '?')} às ${hhmm(list[0].at)}` : 'nenhuma ainda'}</span></summary>
      ${list.length ? `<div class="row" style="margin:10px 0"><select id="actF" style="width:auto"><option value="">Todas as ações</option>${acts.map(a => `<option ${a === actFilter ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></div>
      <div class="scroll"><table class="stack"><thead><tr><th>Quando</th><th>Quem</th><th>O quê</th><th>Detalhe</th></tr></thead><tbody>
      ${shown.map(x => `<tr><td data-l="Quando">${new Date(x.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td><td data-l="Quem">${esc(x.email || '?')}</td><td data-l="O quê"><b>${esc(x.action)}</b></td><td data-l="Detalhe">${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></div>
      <p class="mut" style="margin:6px 0 0">Registra preços, produtos esgotados, cancelamentos, caixa, cupons, equipe, bloqueios e despesas. Guardado por 180 dias.</p>` : '<p class="mut">As ações da equipe aparecem aqui conforme forem acontecendo.</p>'}</details>`;
  };
  const drawFin = async () => {
    const box = $('#fin'); if (!box) return;
    let f, ex;
    try { [f, ex] = await Promise.all([rpc('profit_report', { p_tenant: S.id, p_month: month + '-01' }),
      q(sb.from('expenses').select('id, day, category, description, amount').eq('tenant_id', S.id).gte('day', month + '-01').lt('day', nextMonth(month) + '-01').order('day', { ascending: false }))]); }
    catch { box.innerHTML = ''; return; }
    const pct = v => f.revenue ? Math.round(v / f.revenue * 100) + '%' : '—';
    const mg = await q(sb.from('tenants').select('monthly_goal').eq('id', S.id).single()).then(x => x.monthly_goal).catch(() => 0);
    box.innerHTML = `<div class="panel" style="margin-bottom:16px"><div class="row between"><h3 style="margin:0">Resultado do mês</h3><span class="row"><input type="month" id="finM" value="${month}" style="width:auto"><button class="pri sm" id="expNew">+ Despesa</button></span></div>
      <div class="kpis" style="margin:10px 0"><div class="kpi"><span class="mut">Faturamento</span><b class="price">${brl(f.revenue)}</b><span class="mut">${f.orders} pedidos</span></div>
        <div class="kpi"><span class="mut">Insumos vendidos</span><b class="price">${brl(f.ingredients)}</b><span class="mut">${pct(f.ingredients)} · pela ficha técnica</span></div>
        <div class="kpi"><span class="mut">Despesas</span><b class="price">${brl(f.expenses)}</b><span class="mut">${pct(f.expenses)}</span></div>
        <div class="kpi"><span class="mut">Resultado</span><b class="price ${f.result < 0 ? 'neg' : ''}">${brl(f.result)}</b><span class="mut">${f.revenue ? `margem ${pct(f.result)}` : ''}</span></div></div>
      ${mg ? `<div class="goal"><span>Meta do mês: <b class="price">${brl(f.revenue)}</b> de ${brl(mg)} (${Math.round(f.revenue / mg * 100)}%)${f.revenue >= mg ? ' 🎉 batida!' : ''}</span><div class="progress"><i style="width:${Math.min(100, f.revenue / mg * 100)}%"></i></div></div>` : ''}
      ${!f.ingredients ? '<p class="mut" style="margin:0 0 8px">O custo dos insumos aparece quando os produtos têm ficha técnica (aba Estoque).</p>' : ''}
      ${ex.length ? `<details><summary class="mut">${ex.length} despesa(s) lançada(s) · ${f.byCategory.slice(0, 3).map(c => `${esc(c.category)} ${brl(c.amount)}`).join(' · ')}</summary>
        ${ex.map(x => `<div class="ci"><span>${x.day.split('-').reverse().join('/')} · <b>${esc(x.category)}</b>${x.description ? ` · ${esc(x.description)}` : ''}</span><span class="row"><span class="price">${brl(x.amount)}</span><button class="ghost sm" data-expdel="${x.id}">Excluir</button></span></div>`).join('')}</details>` : '<p class="mut" style="margin:0">Nenhuma despesa lançada neste mês.</p>'}</div>`;
  };
  const draw = async () => {
    const [r, hm, rv] = await Promise.all([rpc('store_report', { p_tenant: S.id, p_days: days }), rpc('sales_heatmap', { p_tenant: S.id, p_days: Math.max(days, 7) }).catch(() => null),
      q(sb.from('order_reviews').select('order_id, rating, comment, reply, created_at, order:orders(number, customer_name)').eq('tenant_id', S.id).order('created_at', { ascending: false }).limit(30)).catch(() => [])]);
    const bars = (rows, label, val, fmt, color) => { const m = Math.max(1, ...rows.map(val)); return rows.map(x => `<div class="bar"><span>${esc(label(x))}</span><i style="width:${val(x) / m * 100}%;${color ? `background:${color}` : ''}"></i><span class="price">${fmt(x)}</span></div>`).join('') || '<p class="empty">Sem dados no período</p>'; };
    app.innerHTML = `<div class="row between"><div><h2>Relatórios</h2><p class="lead">Pedidos não cancelados no período escolhido.</p></div>
      <span class="row">${[1, 7, 30, 90].map(d => `<button class="sm ${d === days ? 'pri' : 'ghost'}" data-days="${d}">${d === 1 ? 'Hoje' : d + ' dias'}</button>`).join('')}<button class="ghost sm" id="ordersCsv">Baixar pedidos (CSV)</button></span></div>
    <div id="fin"></div><div id="eng"></div><div id="prat"></div><div id="acts"></div>
    <div class="kpis"><div class="kpi"><span class="mut">Faturamento</span><b class="price">${brl(r.revenue)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${r.orders}</b><span class="mut">${r.cancelled} cancelado(s)</span></div>
      <div class="kpi"><span class="mut">Ticket médio</span><b class="price">${brl(r.avgTicket)}</b></div><div class="kpi"><span class="mut">Tempo médio até entregar</span><b>${r.avgDeliveryMin ?? '—'}${r.avgDeliveryMin != null ? ' min' : ''}</b></div></div>
    <div class="two"><div class="panel"><h3>Faturamento por dia</h3><div class="bars">${bars(r.byDay, x => x.d.split('-').reverse().slice(0, 2).join('/'), x => x.revenue, x => brl(x.revenue))}</div></div>
      ${hm?.length ? heatmap(hm, Math.max(days, 7)) : `<div class="panel"><h3>Pedidos por horário</h3><div class="bars">${bars(r.byHour, x => String(x.h).padStart(2, '0') + 'h', x => x.orders, x => x.orders + ' ped.')}</div></div>`}
      <div class="panel"><h3>Mais vendidos</h3><div class="bars">${bars(r.top, x => x.name, x => x.qty, x => x.qty + ' un.', 'var(--basil)')}</div></div>
      <div class="panel"><h3>Formas de pagamento</h3><div class="bars">${bars(r.payments, x => x.payment, x => x.revenue, x => brl(x.revenue), 'var(--basil)')}</div>
        <h3>Entregadores</h3><table><thead><tr><th>Nome</th><th class="n">Entregas</th><th class="n">Taxas a repassar</th></tr></thead><tbody>${r.couriers.map(c => `<tr><td>${esc(c.name)}</td><td class="n">${c.deliveries}</td><td class="n price">${brl(c.fees)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel" style="margin-top:20px"><h3>Avaliações dos clientes ${rv.length ? `· ★ ${(rv.reduce((a, x) => a + x.rating, 0) / rv.length).toFixed(1).replace('.', ',')} (${rv.length} recentes)` : ''}</h3>
      ${rv.map(x => `<div class="rv"><div class="row between"><span><b>#${x.order?.number}</b> · ${esc(x.order?.customer_name || '')}</span><span class="stars">${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)}</span></div>
        ${x.comment ? `<p style="margin:0">${esc(x.comment)}</p>` : ''}
        <form class="row" data-reply="${x.order_id}" style="flex-wrap:nowrap"><input name="reply" maxlength="500" placeholder="Responder publicamente" value="${esc(x.reply || '')}"><button class="ghost sm">${x.reply ? 'Atualizar' : 'Responder'}</button></form>
        <span class="mut" style="font-size:13px">${new Date(x.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span></div>`).join('') || '<p class="mut" style="margin:0">Nenhuma avaliação ainda. Depois da entrega, o cliente pode avaliar pela página do pedido.</p>'}</div>`;
    drawFin().catch(() => {}); drawActs().catch(() => {}); drawEng().catch(() => {}); drawPRat().catch(() => {});
  };
  app.onclick = attempt(async e => {
    const xd = e.target.closest('button[data-expdel]');
    if (xd) { if (!sure(xd)) return; await q(sb.from('expenses').delete().eq('id', +xd.dataset.expdel)); toast('Despesa excluída'); return drawFin(); }
    if (e.target.closest('#expNew')) {
      dialog(`<h2>Nova despesa</h2><form id="fExp"><div class="two" style="gap:10px"><label>Data<input id="exD" type="date" required value="${new Date().toLocaleDateString('en-CA', { timeZone: S.timezone || 'America/Sao_Paulo' })}"></label>
        <label>Valor (R$)<input id="exV" inputmode="decimal" required></label></div>
        <label>Categoria<input id="exC" list="expCats" required maxlength="40" placeholder="Aluguel, salários…"><datalist id="expCats">${CATS.map(c => `<option value="${c}">`).join('')}</datalist></label>
        <label>Descrição (opcional)<input id="exT" maxlength="120"></label>
        <div class="row"><button class="pri">Lançar</button><button type="button" class="ghost" data-close>Cancelar</button></div></form>`);
      $('#dlgBody').onsubmit = attempt(async ev => {
        ev.preventDefault(); const v = toCents($('#exV').value); if (!(v > 0)) throw new Error('Valor inválido');
        await q(sb.from('expenses').insert({ tenant_id: S.id, day: $('#exD').value, category: $('#exC').value.trim(), description: $('#exT').value.trim() || null, amount: v }));
        closeDlg(); toast('Despesa lançada'); await drawFin();
      });
      return;
    }
    const ex = e.target.closest('#ordersCsv');
    if (ex) { ex.disabled = true; try { await exportOrders(S, days); } finally { ex.disabled = false; } return; }
    const b = e.target.closest('button[data-days]'); if (b) { days = +b.dataset.days; await draw(); }
  });
  app.onsubmit = attempt(async e => { const f = e.target.closest('form[data-reply]'); if (!f) return; e.preventDefault(); await rpc('reply_review', { p_order: +f.dataset.reply, p_reply: f.reply.value }); toast('Resposta salva'); await draw(); });
  app.onchange = e => {
    if (e.target.id === 'finM' && e.target.value) { month = e.target.value; drawFin().catch(() => {}); }
    if (e.target.id === 'actF') { actFilter = e.target.value; drawActs().catch(() => {}); }
  };
  cleanup = () => { app.onclick = app.onsubmit = app.onchange = null; };
  await draw();
}

/* ---------- configurações ---------- */
async function pConfig(S) {
  const plans = await q(sb.from('plans').select('*').order('sort'));
  let couriers = [], st0 = null;
  const draw = async () => {
    let st, zones, coupons, team, nOrders, pix, bill, usage, promos, prodList;
    [st, zones, coupons, couriers, team, nOrders, pix, bill, usage, promos, prodList] = await Promise.all([
      tenantsQuery(c => sb.from('tenants').select(c).eq('id', S.id).single()), q(sb.from('zones').select('*').eq('tenant_id', S.id).order('id')),
      q(sb.from('coupons').select('*').eq('tenant_id', S.id).order('id')), q(sb.from('couriers').select('id, tenant_id, name, phone, active').eq('tenant_id', S.id).order('id')),
      rpc('list_team', { p_tenant: S.id }), sb.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', S.id).then(r => r.count || 0),
      rpc('pix_settings', { p_tenant: S.id }).catch(() => null), rpc('billing_info', { p_tenant: S.id }).catch(() => null), rpc('coupon_usage', { p_tenant: S.id }).catch(() => ({})),
      q(sb.from('promotions').select('*').eq('tenant_id', S.id).order('id')).catch(() => []), q(sb.from('products').select('id, name, category').eq('tenant_id', S.id).order('sort'))]);
    const prodById = Object.fromEntries(prodList.map(p => [p.id, p]));
    st0 = st;
    const link = storeLink(st);
    app.innerHTML = `<h2>Configurações</h2><p class="lead">Endereço da sua loja: <a href="${link}" target="_blank" rel="noopener">${esc(link)}</a> <button class="ghost sm" id="copy">Copiar</button></p>
    ${nOrders ? '' : '<div class="panel" style="margin-bottom:20px"><h3>Quer ver o sistema funcionando?</h3><p class="mut" style="margin:0">Gere pedidos de exemplo para testar a fila, as entregas e os relatórios.</p><button class="ok" id="demo">Gerar 12 pedidos de exemplo</button></div>'}
    <div class="two"><form class="panel" id="fStore"><h3>Loja</h3>
      <label>Nome<input id="sN" required maxlength="80" value="${esc(st.name)}"></label>
      <div class="two" style="gap:10px"><label>Telefone<input id="sPh" maxlength="30" value="${esc(st.phone)}"></label><label>Prazo de entrega<input id="sEta" maxlength="40" value="${esc(st.eta_text)}"></label></div>
      <div class="two" style="gap:10px"><label>Pedido mínimo (R$)<input id="sMin" inputmode="decimal" value="${fromCents(st.min_order)}"></label><label>Cor da marca<input type="color" id="sC" value="${st.color}"></label></div>
      <label class="chk"><input type="checkbox" id="sOpen" ${st.is_open ? 'checked' : ''}> Receber pedidos (desmarque para pausar a loja agora)</label>
      <label class="chk"><input type="checkbox" id="sPick" ${st.allow_pickup ? 'checked' : ''}> Aceitar retirada na loja</label>
      <button class="pri">Salvar loja</button></form>
    <form class="panel" id="fHours"><h3>Horário de funcionamento</h3>
      <p class="mut" style="margin:0">Agora: ${(() => { const o = openState(st); return o.open ? `<span class="badge b-g">Aberta ${esc(o.label)}</span>` : `<span class="badge b-r">${esc(o.label)}</span>`; })()}</p>
      <label class="chk"><input type="checkbox" id="hAuto" ${st.auto_hours ? 'checked' : ''}> Abrir e fechar sozinha nos horários abaixo</label>
      <table class="hours"><tbody>${DAYS.map((d, i) => { const r = (st.hours || {})[i] || [];
        return `<tr><td>${d}</td><td><span class="row" style="flex-wrap:nowrap"><input type="time" id="h${i}a" value="${r[0]?.[0] || ''}" aria-label="${d} abre"><span>às</span><input type="time" id="h${i}b" value="${r[0]?.[1] || ''}" aria-label="${d} fecha"></span></td>
          <td><span class="row" style="flex-wrap:nowrap"><input type="time" id="h${i}c" value="${r[1]?.[0] || ''}" aria-label="${d} abre 2º turno"><span>às</span><input type="time" id="h${i}d" value="${r[1]?.[1] || ''}" aria-label="${d} fecha 2º turno"></span></td></tr>`; }).join('')}</tbody></table>
      <p class="mut" style="margin:0">Deixe em branco os dias em que não abre. O 2º turno é opcional (ex.: almoço e jantar). Pode fechar depois da meia-noite, como 18:00 às 02:00.</p>
      <span class="row"><button type="button" class="ghost sm" id="copyMon">Copiar segunda para todos os dias</button><button class="pri">Salvar horários</button></span></form>
    ${'closed_dates' in st ? `<form class="panel" id="fClosed"><h3>Feriados e fechamentos especiais</h3>
      <p class="mut" style="margin:0">Nesses dias a loja fica fechada o dia todo, e ninguém consegue agendar para eles. Para fechar só por alguns minutos, use a pausa rápida na tela de preparo.</p>
      ${(st.closed_dates || []).filter(d => d.date >= ymdIn(st.timezone, new Date())).sort((a, b) => a.date.localeCompare(b.date)).map(d => `<div class="ci"><span><b>${d.date.split('-').reverse().join('/')}</b> · ${esc(new Date(d.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long' }))}${d.note ? ` · ${esc(d.note)}` : ''}</span><button type="button" class="ghost sm" data-rmdate="${esc(d.date)}">Remover</button></div>`).join('') || '<p class="empty" style="margin:0">Nenhuma data marcada.</p>'}
      <div class="row"><label>Data<input id="cdD" type="date" min="${ymdIn(st.timezone, new Date())}"></label><label style="flex:1">Motivo (opcional)<input id="cdN" maxlength="60" placeholder="Natal, férias coletivas…"></label><button class="pri" style="align-self:end">Adicionar</button></div></form>` : ''}
    <form class="panel" id="fAuto" hidden><h3>Aceite automático</h3><p class="mut" style="margin:0">Pedidos novos entram direto em <b>Em preparo</b>, sem precisar tocar em Aceitar. Pedidos com Pix ou cartão online só entram quando o pagamento é confirmado; agendados continuam esperando a hora. Se a impressão estiver ligada no Preparo, a comanda sai assim que o pedido chega.</p>
      <label class="chk"><input type="checkbox" id="aaOn"> Aceitar pedidos automaticamente</label>
      <button class="pri">Salvar</button></form>
    <form class="panel" id="fKiosk"><h3>Totem de autoatendimento</h3>
      <p class="mut" style="margin:0">Transforme um tablet em totem: o cliente escolhe os produtos, digita o nome e paga no caixa. O pedido chega no Preparo marcado como <b>Totem</b>. Use um tablet logado com uma conta da equipe.</p>
      <label>PIN para sair do totem (opcional, fica só neste aparelho)<input id="kioskPin" type="password" inputmode="numeric" maxlength="8" pattern="[0-9]{4,8}" value="${esc(local.get('kioskPin', ''))}" style="max-width:200px" autocomplete="off"></label>
      <button class="pri">Abrir o totem neste aparelho</button></form>
    <form class="panel" id="fCall" hidden><h3>Painel de chamada</h3><p class="mut" style="margin:0">Tela para TV voltada aos clientes, com os pedidos de retirada sendo preparados e prontos. <a href="/chamada/${esc(st.slug)}" target="_blank" rel="noopener">Abrir o painel</a></p>
      <label class="chk"><input type="checkbox" id="cnOn"> Mostrar o nome do cliente junto do número</label>
      <p class="mut" style="margin:0">Aparece só o primeiro nome e a inicial do sobrenome (ex.: <b>Maria S.</b>). Telefone e endereço nunca aparecem.</p>
      <button class="pri">Salvar</button></form>
    <form class="panel" id="fGoals"><h3>Metas de vendas</h3><p class="mut" style="margin:0">A meta do dia aparece para a equipe no Preparo, com uma barra de progresso. A do mês aparece no Resultado do mês, em Relatórios. Deixe em branco para não usar.</p>
      <div class="two" style="gap:10px"><label>Meta do dia (R$)<input id="gD" inputmode="decimal" placeholder="ex.: 1.500,00"></label><label>Meta do mês (R$)<input id="gM" inputmode="decimal" placeholder="ex.: 40.000,00"></label></div>
      <button class="pri">Salvar metas</button></form>
    <form class="panel" id="fShow"><h3>Vitrine da loja</h3>
      ${'logo_path' in st ? `<div class="row logo-ed"><span class="logo-prev">${st.logo_path ? `<img src="${esc(imgUrl(st.logo_path))}" alt="Logotipo da loja">` : '<span class="mut">Sem logo</span>'}</span>
        <label>Logotipo (quadrado, PNG com fundo transparente fica melhor)<input type="file" id="shLogo" accept="image/png,image/jpeg,image/webp"></label>${st.logo_path ? '<button type="button" class="ghost sm" id="shLogoRm">Remover logotipo</button>' : ''}</div>
      <p class="mut" style="margin:0">O logotipo aparece no topo da loja online, no painel, no painel de chamada e no cardápio impresso.</p>` : ''}
      <div class="banner-ed">${st.banner_path ? `<img src="${esc(imgUrl(st.banner_path))}" alt="Banner da loja">` : '<span class="mut">Sem banner</span>'}</div>
      <span class="row"><label>Banner (foto larga, ex.: fachada ou produtos)<input type="file" id="shBanner" accept="image/jpeg,image/png,image/webp"></label>${st.banner_path ? '<button type="button" class="ghost sm" id="shRm">Remover banner</button>' : ''}</span>
      <label>Descrição (aparece no topo da loja)<input id="shDesc" maxlength="300" value="${esc(st.description || '')}" placeholder="Ex.: Pizza no forno a lenha desde 1998"></label>
      <div class="two" style="gap:10px"><label>Endereço<input id="shAddr" maxlength="200" value="${esc(st.address || '')}" placeholder="Rua, número - bairro, cidade"></label><label>Instagram (sem @)<input id="shInsta" maxlength="30" pattern="[A-Za-z0-9._]{0,30}" value="${esc(st.instagram || '')}"></label></div>
      <h3>Pedidos agendados</h3>
      <label class="chk"><input type="checkbox" id="scOn" ${st.allow_scheduling ? 'checked' : ''}> Permitir que o cliente agende dia e horário</label>
      <div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:10px"><label>Até quantos dias<input id="scDays" type="number" min="1" max="30" value="${st.schedule_days ?? 3}"></label>
        <label>Antecedência mínima (min)<input id="scLead" type="number" min="15" max="1440" value="${st.schedule_lead_minutes ?? 60}"></label>
        <label>Intervalo dos horários<select id="scSlot">${[15, 20, 30, 60].map(m => `<option value="${m}" ${(st.schedule_slot_minutes ?? 30) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label></div>
      <p class="mut" style="margin:0">Os horários oferecidos seguem o horário de funcionamento (se estiver ligado). Com a loja fechada, o cliente ainda pode agendar para quando ela abrir. Pedidos agendados aparecem no preparo 1 hora antes.</p>
      <button class="pri">Salvar vitrine e agendamento</button></form>
    <form class="panel" id="fPromo"><h3>Promoções automáticas</h3>
      ${promos.map(pm => `<div class="row between promo-row"><span><b>${esc(pm.name)}</b><br><span class="mut">${esc(promoLabel(pm, prodById))}</span></span>
        <span class="row"><button type="button" class="sm ${pm.active ? 'ok' : 'ghost'}" data-ptog="${pm.id}" data-on="${pm.active ? 1 : 0}">${pm.active ? 'Ativa' : 'Pausada'}</button><button type="button" class="ghost sm" data-del="promotions:${pm.id}" aria-label="Remover">×</button></span></div>`).join('') || '<p class="mut" style="margin:0">Nenhuma promoção ainda.</p>'}
      <div class="grid" style="gap:8px">
        <div class="two" style="gap:8px"><label>Nome<input id="pmName" maxlength="60" placeholder="Ex.: Happy hour de bebidas"></label>
          <label>Tipo<select id="pmKind"><option value="buy_x_pay_y">Leve X, pague Y</option><option value="percent">% de desconto</option></select></label></div>
        <div class="two" style="gap:8px"><label>Vale para<select id="pmScope"><option value="">Toda a loja</option>
          <optgroup label="Categoria">${[...new Set(prodList.map(p => p.category))].map(c => `<option value="c:${esc(c)}">${esc(c)}</option>`).join('')}</optgroup>
          <optgroup label="Produto">${prodList.map(p => `<option value="p:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup></select></label>
          <span class="row" style="flex-wrap:nowrap"><label class="pmBP">Leve<input id="pmBuy" type="number" min="2" max="20" value="3"></label><label class="pmBP">Pague<input id="pmPay" type="number" min="1" max="19" value="2"></label><label id="pmPctL" hidden>% off<input id="pmPct" type="number" min="1" max="90" value="20"></label></span></div>
        <div class="row">${DAYS.map((d, i) => `<label class="chk"><input type="checkbox" class="pmDay" value="${i}"> ${d.slice(0, 3)}</label>`).join('')}</div>
        <div class="row" style="flex-wrap:nowrap"><label>Das<input id="pmFrom" type="time"></label><label>Até<input id="pmTo" type="time"></label></div>
        <p class="mut" style="margin:0">Sem dias marcados = todos os dias. Sem horário = o dia todo (pode passar da meia-noite, ex.: 22:00 às 02:00). No "leve X, pague Y", saem de graça as unidades mais baratas entre as participantes. As promoções somam com cupom e fidelidade.</p>
        <button class="pri">Criar promoção</button></div></form>
    <form class="panel" id="fDeliv"><h3>Taxa de entrega</h3>
      <label>Frete grátis para pedidos a partir de (R$)<input id="fdAbove" inputmode="decimal" placeholder="em branco = sem frete grátis" value="${st.free_delivery_above ? fromCents(st.free_delivery_above) : ''}"></label>
      <label class="chk"><input type="radio" name="dMode" value="zones" ${st.delivery_mode !== 'distance' ? 'checked' : ''}> Por bairro (lista de bairros e taxas)</label>
      <label class="chk"><input type="radio" name="dMode" value="distance" ${st.delivery_mode === 'distance' ? 'checked' : ''}> Por distância (km a partir da loja)</label>
      <div class="grid" style="gap:10px">
        <label>Localização da loja (latitude, longitude)<input id="dCoord" placeholder="-23.5503, -46.6339" value="${st.lat != null ? `${st.lat}, ${st.lng}` : ''}"></label>
        <div class="row" style="flex-wrap:nowrap"><input id="dCep" inputmode="numeric" maxlength="9" placeholder="CEP da loja" style="width:130px"><input id="dNum" placeholder="Número" style="width:100px"><button type="button" class="ghost" id="dLoc">Localizar</button>
          ${st.lat != null ? `<a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${st.lat},${st.lng}">Ver no mapa</a>` : ''}</div>
        <p class="mut" style="margin:0">Dica: no Google Maps, clique com o botão direito na porta da loja e clique nas coordenadas para copiar. A distância é calculada em linha reta, então deixe uma folga nas faixas.</p>
        <table class="tiers"><thead><tr><th>Até (km)</th><th>Taxa (R$)</th></tr></thead><tbody>
          ${[...(st.distance_tiers || []), ...Array(Math.max(0, 6 - (st.distance_tiers || []).length)).fill(['', null])].slice(0, 6).map(([km, fee], i) => `<tr><td><input id="tk${i}" inputmode="decimal" value="${km === '' ? '' : String(km).replace('.', ',')}" aria-label="Até km"></td><td><input id="tf${i}" inputmode="decimal" value="${fee == null ? '' : fromCents(fee)}" aria-label="Taxa"></td></tr>`).join('')}</tbody></table>
        <p class="mut" style="margin:0">Acima da maior distância, a loja não entrega. Deixe linhas em branco se não precisar.</p></div>
      <h3>Pedidos na mesa (QR Code)</h3>
      <label class="chk"><input type="checkbox" id="mOn" ${st.allow_tables ? 'checked' : ''}> Aceitar pedidos na mesa pelo QR Code</label>
      <span class="row"><label>Quantidade de mesas<input id="mCount" type="number" min="1" max="200" value="${st.tables_count ?? 10}" style="width:120px"></label>${'service_percent' in st ? `<label>Taxa de serviço (%)<input id="mSvc" type="number" min="0" max="20" value="${st.service_percent || 0}" style="width:120px" title="0 = sem taxa. O cliente pode desmarcar."></label>` : ''}<button type="button" class="ghost" id="mPrint" ${st.allow_tables ? '' : 'disabled'}>Imprimir QR Codes das mesas</button></span>
      <p class="mut" style="margin:0">Cada mesa recebe um QR Code. O cliente escaneia, faz o pedido pelo celular e paga no caixa (ou por Pix, se ativo). O pedido chega na cozinha marcado com o número da mesa.</p>
      <h3>Programa de fidelidade</h3>
      <label class="chk"><input type="checkbox" id="lOn" ${st.loyalty_enabled ? 'checked' : ''}> Dar desconto para clientes fiéis</label>
      <div class="two" style="gap:10px"><label>A cada (pedidos entregues)<input id="lEvery" type="number" min="2" max="50" value="${st.loyalty_every ?? 10}"></label><label>Desconto no pedido seguinte (%)<input id="lPct" type="number" min="1" max="50" value="${st.loyalty_percent ?? 10}"></label></div>
      <p class="mut" style="margin:0">O cliente é reconhecido pelo telefone. O desconto entra sozinho no pedido seguinte e não soma com cupom (vale o maior). Ele acompanha os selos na página do pedido.</p>
      ${'cashback_percent' in st ? `<h3>Cashback</h3>
      <div class="two" style="gap:10px"><label>% de volta em cada pedido entregue (0 = desligado)<input id="cbPct" type="number" min="0" max="30" value="${st.cashback_percent || 0}"></label>
        <label>O saldo vale por (dias)<input id="cbDays" type="number" min="7" max="365" value="${st.cashback_days || 90}"></label></div>
      ${'referral_reward' in st ? `<h3>Indique e ganhe</h3>
      <label>Crédito para quem indica e para o amigo indicado (R$, 0 = desligado)<input id="refRw" inputmode="decimal" value="${st.referral_reward ? fromCents(st.referral_reward) : '0'}" style="max-width:160px"></label>
      <p class="mut" style="margin:0">Cada cliente ganha um link de indicação na página do pedido. Quando o 1º pedido do amigo é entregue, os dois ganham esse valor de crédito para usar na loja (vale pelo mesmo prazo do cashback). Só vale para quem nunca comprou na loja.</p>` : ''}
      <p class="mut" style="margin:0">O cliente acumula saldo pelo telefone e escolhe usar no pedido seguinte. Cancelamento estorna. Pode somar com a fidelidade.</p>` : ''}
      <button class="pri">Salvar entrega e fidelidade</button></form>
    <div class="panel"><h3>Bairros e taxas</h3>${zones.some(z => 'min_order' in z) ? '<p class="mut" style="margin:0 0 6px">Taxa de entrega e, se quiser, um pedido mínimo próprio para bairros mais longe.</p>' : ''}<table><tbody>${zones.map(z => `<tr><td>${esc(z.name)}</td><td class="n" style="width:120px"><input inputmode="decimal" value="${fromCents(z.fee)}" data-zone="${z.id}" aria-label="Taxa ${esc(z.name)}" title="Taxa de entrega"></td>${'min_order' in z ? `<td class="n" style="width:130px"><input inputmode="decimal" value="${z.min_order ? fromCents(z.min_order) : ''}" placeholder="mín. (opcional)" data-zmin="${z.id}" aria-label="Pedido mínimo ${esc(z.name)}" title="Pedido mínimo para este bairro"></td>` : ''}<td class="n"><button class="ghost sm" data-del="zones:${z.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fZone" class="row" style="flex-wrap:nowrap"><input id="zN" placeholder="Bairro" required maxlength="60"><input id="zF" inputmode="decimal" placeholder="Taxa" style="width:100px" required><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Cupons</h3><table><tbody>${coupons.map(c => `<tr><td><b>${esc(c.code)}</b><br><span class="mut">${[c.percent ? c.percent + '% de desconto' : '', c.free_shipping ? 'frete grátis' : '',
        c.min_subtotal ? `a partir de ${brl(c.min_subtotal)}` : '', c.first_order_only ? 'só 1ª compra' : '', c.max_per_customer ? `${c.max_per_customer}x por cliente` : '',
        c.valid_until ? `até ${new Date(c.valid_until).toLocaleDateString('pt-BR')}${new Date(c.valid_until) < Date.now() ? ' (expirado)' : ''}` : ''].filter(Boolean).join(' · ')}</span>
        <br><span class="mut">Usado ${usage[c.code] || 0}${c.max_uses ? ` de ${c.max_uses}` : ''} vez(es)</span></td><td class="n"><button class="sm ${c.active ? 'ok' : 'ghost'}" data-cup="${c.id}" data-on="${c.active ? 1 : 0}">${c.active ? 'Ativo' : 'Pausado'}</button> <button class="ghost sm" data-del="coupons:${c.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
      <form id="fCup" class="grid" style="gap:8px"><div class="row"><input id="cuC" placeholder="CÓDIGO" required pattern="[A-Za-z0-9]{2,20}" style="flex:1"><input id="cuP" type="number" min="0" max="90" placeholder="% desc." style="width:100px"><label class="chk"><input type="checkbox" id="cuF"> Frete grátis</label></div>
        <details><summary class="mut">Regras opcionais (mínimo, validade, limites)</summary><div class="grid" style="gap:8px;margin-top:8px">
          <div class="two" style="gap:8px"><label>Pedido mínimo (R$)<input id="cuMin" inputmode="decimal" placeholder="0,00"></label><label>Válido até<input id="cuUntil" type="date"></label></div>
          <div class="two" style="gap:8px"><label>Limite total de usos<input id="cuMax" type="number" min="1" placeholder="sem limite"></label><label>Usos por cliente<input id="cuPer" type="number" min="1" placeholder="sem limite"></label></div>
          <label class="chk"><input type="checkbox" id="cuFirst"> Só na primeira compra do cliente</label></div></details>
        <button class="ghost">Criar cupom</button></form></div>
    <div class="panel"><h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td class="n"><span class="row" style="justify-content:flex-end"><button class="ghost sm" data-clink="${c.id}">Enviar link</button><button class="ghost sm" data-crot="${c.id}">Novo link</button><button class="ghost sm" data-del="couriers:${c.id}" aria-label="Remover">×</button></span></td></tr>`).join('')}</tbody></table>
      <p class="mut" style="margin:0">Cada entregador recebe um link próprio para ver as entregas dele no celular e marcar "Entreguei", sem precisar de senha. "Novo link" desativa o anterior.</p>
      <form id="fCour" class="row" style="flex-wrap:nowrap"><input id="crN" placeholder="Nome" required maxlength="60"><input id="crP" placeholder="Telefone"><button class="ghost">Adicionar</button></form></div>
    <div class="panel"><h3>Equipe</h3><table><tbody>${team.map(u => `<tr><td>${esc(u.email)}</td><td>${u.role === 'owner' ? 'Dono' : 'Atendente'}</td><td class="n">${u.role === 'staff' ? `<button class="ghost sm" data-staff="${u.user_id}" aria-label="Remover">×</button>` : ''}</td></tr>`).join('')}</tbody></table>
      <form id="fTeam" class="row" style="flex-wrap:nowrap"><input id="tE" type="email" placeholder="E-mail do atendente" required><button class="ghost">Adicionar</button></form>
      <p class="mut" style="margin:0">O atendente precisa criar uma conta em /entrar/cadastro antes. Ele opera pedidos, entregas e disponibilidade do cardápio, sem acesso a relatórios e configurações.</p></div>
    <form class="panel" id="fPix"><h3>Pix e cartão online (Mercado Pago)</h3>
      ${pix ? `<p class="mut" style="margin:0">Situação: ${pix.enabled ? '<span class="badge b-g">Ativo na loja</span>' : '<span class="badge">Desligado</span>'}
        ${pix.configured ? ` · Access Token cadastrado (${esc(pix.hint)})${pix.test ? ' · <span class="badge b-a">modo de teste</span>' : ''}` : ''}</p>` : '<p class="mut" style="margin:0">Rode a migração do Pix no Supabase para usar este recurso.</p>'}
      <p class="mut" style="margin:0">O cliente paga com QR Code na hora de pedir, o dinheiro cai direto na sua conta do Mercado Pago e o pedido só aparece no preparo depois de pago.</p>
      <details><summary class="mut">Como pegar o Access Token</summary><ol class="mut">
        <li>Entre em mercadopago.com.br/developers com a conta que vai receber.</li>
        <li>Clique em <b>Suas integrações → Criar aplicação</b> (pagamentos online, sem plataforma pronta).</li>
        <li>Em <b>Credenciais de produção</b>, copie o <b>Access Token</b> (começa com APP_USR-). Para testar sem dinheiro de verdade, use o de <b>teste</b> (TEST-).</li>
        <li>Sua conta precisa ter uma <b>chave Pix cadastrada</b> no Mercado Pago.</li></ol></details>
      <label>Access Token<input id="pxTok" type="password" autocomplete="off" placeholder="${pix?.configured ? 'Deixe em branco para manter o atual' : 'APP_USR-...'}"></label>
      <label class="chk"><input type="checkbox" id="pxOn" ${pix?.enabled ? 'checked' : ''}> Oferecer "Pix agora" na loja</label>
      <label class="chk"><input type="checkbox" id="pxCard" ${pix?.cardEnabled ? 'checked' : ''} ${pix && 'cardEnabled' in pix ? '' : 'disabled'}> Oferecer "Cartão de crédito agora" na loja <span class="mut">(até 12x, taxas do Mercado Pago)</span></label>
      <button class="pri" ${pix ? '' : 'disabled'}>Salvar Pix</button></form>
    <form class="panel" id="fDom"><h3>Domínio próprio</h3>
      <p class="mut" style="margin:0">Use um endereço com o nome da sua marca, como <b>pedidos.minhaloja.com.br</b>, no lugar do link do Balcão. O link antigo continua funcionando.</p>
      ${'custom_domain' in st ? `<label>Domínio<input id="dDom" maxlength="120" placeholder="pedidos.minhaloja.com.br" value="${esc(st.custom_domain || '')}"></label>
      <details ${st.custom_domain ? 'open' : ''}><summary class="mut">Como ligar o domínio</summary><ol class="mut">
        <li>Compre o domínio (por exemplo no Registro.br) ou use um que você já tem.</li>
        <li>No painel de DNS do domínio, crie um registro <b>CNAME</b> com nome <b>${esc((st.custom_domain || 'pedidos.minhaloja.com.br').split('.')[0])}</b> apontando para <b>cname.vercel-dns.com</b>.</li>
        <li>Salve aqui e avise o suporte do ${esc(PLATFORM.name)} para ativar o domínio. O endereço começa a funcionar em até algumas horas, com cadeado (https).</li></ol></details>
      <button class="pri">Salvar domínio</button>` : '<p class="mut" style="margin:0">Rode a migração 20261125000000_cartao_dominio_unidades.sql no Supabase para usar este recurso.</p>'}</form>
    <div class="panel" id="assinatura"><h3>Assinatura do Balcão</h3>
      ${bill ? `<p style="margin:0">${{ trial: `<span class="badge">Teste grátis</span> termina em ${new Date(bill.trialEndsAt).toLocaleDateString('pt-BR')} (${bill.daysLeft} dia${bill.daysLeft === 1 ? '' : 's'})`,
        active: `<span class="badge b-g">Ativa</span> próxima cobrança em ${bill.paidUntil ? new Date(bill.paidUntil).toLocaleDateString('pt-BR') : '—'}`,
        past_due: '<span class="badge b-a">Pagamento com problema</span> atualize o cartão para não perder a loja',
        canceled: '<span class="badge b-r">Cancelada</span>', free: '<span class="badge b-g">Liberada pela plataforma</span>' }[bill.status] || ''}
        ${bill.ok ? '' : ' · <b>a loja não está recebendo pedidos</b>'}</p>` : '<p class="mut" style="margin:0">Rode a migração de assinaturas no Supabase para ver este quadro.</p>'}
      <div class="plans">${plans.map(p => `<div class="plan ${st.plan === p.name ? 'on' : ''}"><b>${esc(p.name)}</b><span class="price"><b>${brl(p.price)}</b>/mês</span><span class="mut">${esc(p.features)}</span>${st.plan === p.name ? '<span class="badge b-g">Plano atual</span>' : `<button class="ghost sm" data-plan="${esc(p.name)}">Mudar</button>`}</div>`).join('')}</div>
      ${bill && bill.status !== 'free' ? `<span class="row">
        ${bill.status === 'active' ? '' : `<button class="pri" id="subNow">${bill.hasSubscription ? 'Assinar de novo / trocar cartão' : 'Assinar com cartão'}</button>`}
        ${bill.status === 'active' ? '<button class="ghost" id="subNow">Trocar cartão</button>' : ''}
        ${bill.hasSubscription ? '<button class="ghost" id="subSync">Atualizar status</button>' : ''}
        ${bill.hasSubscription && bill.status !== 'canceled' ? '<button class="ghost" id="subCancel">Cancelar assinatura</button>' : ''}</span>
      <p class="mut" style="margin:0">Pagamento mensal no cartão pelo Mercado Pago. ${bill.status === 'trial' ? 'Assinando agora, a primeira cobrança só acontece quando o teste grátis terminar.' : ''}</p>` : ''}</div>
    <form class="panel danger" id="fDel"><h3>Excluir loja</h3><p class="mut" style="margin:0">Apaga a loja e todos os dados dela (cardápio, pedidos, clientes, equipe). <b>Não tem volta.</b> Cancele a assinatura antes.</p>
      <label>Para confirmar, digite o endereço da loja: <b>${esc(st.slug)}</b><input id="delSlug" autocomplete="off"></label>
      <button class="ghost">Excluir loja definitivamente</button></form></div>`;
    q(sb.from('tenants').select('daily_goal, monthly_goal').eq('id', S.id).single()).then(g => { if ($('#gD')) { $('#gD').value = g.daily_goal ? fromCents(g.daily_goal) : ''; $('#gM').value = g.monthly_goal ? fromCents(g.monthly_goal) : ''; } })
      .catch(() => { const f = $('#fGoals'); if (f) f.hidden = true; });
    q(sb.from('tenants').select('auto_accept').eq('id', S.id).single()).then(r => { if ($('#fAuto')) { $('#aaOn').checked = !!r.auto_accept; $('#fAuto').hidden = false; } }).catch(() => {});
    q(sb.from('tenants').select('call_names').eq('id', S.id).single()).then(r => { if ($('#fCall')) { $('#cnOn').checked = !!r.call_names; $('#fCall').hidden = false; } }).catch(() => {});
  };
  const refreshBrand = async () => { await loadMe(); setColor(ME.tenant.color); brand(ME.tenant.name, ME.tenant.logo_path); };
  app.onclick = attempt(async e => {
    // botões de envio de formulário são tratados no onsubmit; os demais (fora de formulários) aqui
    const b = e.target.closest('button'); if (!b || (b.type === 'submit' && b.closest('form'))) return;
    if (b.id === 'shLogoRm') { await q(sb.from('tenants').update({ logo_path: null }).eq('id', S.id)); if (st0?.logo_path) sb.storage.from(BUCKET).remove([st0.logo_path]).catch(() => {}); await refreshBrand(); toast('Logotipo removido'); return draw(); }
    if (b.id === 'shRm') { await q(sb.from('tenants').update({ banner_path: null }).eq('id', S.id)); if (st0?.banner_path) sb.storage.from(BUCKET).remove([st0.banner_path]).catch(() => {}); toast('Banner removido'); return draw(); }
    if (b.id === 'mPrint') { await printTableQrs(storeLink(S), Math.max(1, Math.min(200, +$('#mCount').value || 10)), S.name); return; }
    if (b.id === 'dLoc') {
      const info = await lookupCep($('#dCep').value);
      if (!info) throw new Error('CEP não encontrado');
      const pos = await locateAddress({ street: info.street, number: $('#dNum').value.trim(), city: info.city, state: info.state, cep: $('#dCep').value }, info);
      if (!pos) throw new Error('Não encontramos no mapa. Cole as coordenadas do Google Maps.');
      $('#dCoord').value = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`; toast('Localização encontrada. Confira em "Ver no mapa" depois de salvar.'); return;
    }
    if (b.dataset.rmdate) { const cd = (st0.closed_dates || []).filter(d => d.date !== b.dataset.rmdate); await q(sb.from('tenants').update({ closed_dates: cd }).eq('id', S.id)); toast('Data removida'); return draw(); }
    if (b.id === 'copyMon') { for (let i = 0; i < 7; i++) for (const k of 'abcd') $(`#h${i}${k}`).value = $(`#h1${k}`).value; return; }
    if (b.id === 'copy') { try { await navigator.clipboard.writeText(storeLink(st0 || S)); local.set(`shared:${S.id}`, true); toast('Link copiado'); } catch { toast('Copie o link manualmente'); } return; }
    if (b.id === 'demo') { b.disabled = true; await rpc('generate_demo_orders', { p_tenant: S.id, p_count: 12 }); toast('Pedidos de exemplo criados'); }
    if (b.dataset.del) { if (!sure(b)) return; const [t, id] = b.dataset.del.split(':'); await q(sb.from(t).delete().eq('id', +id)); }
    if (b.dataset.clink || b.dataset.crot) {
      const id = +(b.dataset.clink || b.dataset.crot);
      if (b.dataset.crot && !sure(b)) return;
      const tok = await rpc('courier_link', { p_courier: id, p_rotate: !!b.dataset.crot });
      const c = couriers.find(x => x.id === id), link = `${location.origin}/entregador/${tok}`;
      const wa = waLink(c?.phone, `Olá, ${c?.name}! Este é o seu link de entregas da ${S.name}: ${link}`);
      if (wa) window.open(wa, '_blank', 'noopener');
      else { try { await navigator.clipboard.writeText(link); toast('Link copiado'); } catch { prompt('Copie o link do entregador:', link); } }
      if (b.dataset.clink) return;
    }
    if (b.dataset.staff) { if (!sure(b)) return; await rpc('remove_staff', { p_tenant: S.id, p_user: b.dataset.staff }); }
    if (b.dataset.ptog) await q(sb.from('promotions').update({ active: b.dataset.on !== '1' }).eq('id', +b.dataset.ptog));
    if (b.dataset.cup) await q(sb.from('coupons').update({ active: b.dataset.on !== '1' }).eq('id', +b.dataset.cup));
    if (b.dataset.plan) {
      await rpc('change_plan', { p_tenant: S.id, p_plan: b.dataset.plan });
      try { const r = await billingCall({ action: 'update_amount', tenant: S.id }); toast(r?.updated ? 'Plano alterado. A mensalidade foi atualizada.' : 'Plano alterado'); } catch { toast('Plano alterado'); }
    }
    if (b.id === 'subNow') { b.disabled = true; b.textContent = 'Abrindo o Mercado Pago…'; const r = await billingCall({ action: 'subscribe', tenant: S.id }); location.href = r.url; return; }
    if (b.id === 'subSync') { const r = await billingCall({ action: 'sync', tenant: S.id }); toast(`Status: ${{ trial: 'teste grátis', active: 'ativa', past_due: 'pagamento com problema', canceled: 'cancelada', free: 'liberada' }[r.status] || r.status}`); }
    if (b.id === 'subCancel') { if (!sure(b)) return; await billingCall({ action: 'cancel', tenant: S.id }); toast('Assinatura cancelada'); }
    if (['subSync', 'subCancel'].includes(b.id)) { await loadMe(); $('#banner').innerHTML = billingBanner(ME.tenant, true); }
    await draw();
  });
  app.onchange = attempt(async e => {
    if (e.target.id === 'pmKind') { const pct = e.target.value === 'percent'; document.querySelectorAll('.pmBP').forEach(x => x.hidden = pct); $('#pmPctL').hidden = !pct; return; }
    if (e.target.id === 'shLogo' && e.target.files[0]) {
      if (e.target.files[0].size > 8 * 1024 * 1024) throw new Error('Imagem grande demais (máx. 8 MB)');
      toast('Enviando logotipo…');
      const blob = await shrinkImage(e.target.files[0], 512, 'image/png');   // PNG mantém o fundo transparente
      const path = `${S.id}/logo-${crypto.randomUUID()}.png`;
      await q(sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/png', cacheControl: '31536000' }));
      await q(sb.from('tenants').update({ logo_path: path }).eq('id', S.id));
      if (st0?.logo_path) sb.storage.from(BUCKET).remove([st0.logo_path]).catch(() => {});
      await refreshBrand(); toast('Logotipo atualizado'); return draw();
    }
    if (e.target.id === 'shBanner' && e.target.files[0]) {
      toast('Enviando banner…');
      const blob = await shrinkImage(e.target.files[0], 1600);
      const path = `${S.id}/banner-${crypto.randomUUID()}.jpg`;
      await q(sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }));
      await q(sb.from('tenants').update({ banner_path: path }).eq('id', S.id));
      if (st0?.banner_path) sb.storage.from(BUCKET).remove([st0.banner_path]).catch(() => {});
      toast('Banner atualizado'); return draw();
    }
    if (e.target.dataset.zmin) { const v = e.target.value.trim() ? toCents(e.target.value) : 0; if (!Number.isInteger(v) || v < 0) throw new Error('Mínimo inválido');
      await q(sb.from('zones').update({ min_order: v }).eq('id', +e.target.dataset.zmin)); return toast(v ? 'Pedido mínimo do bairro salvo' : 'Bairro sem mínimo próprio'); }
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
    if (id === 'fKiosk') { const pin = $('#kioskPin').value.trim(); if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('O PIN deve ter de 4 a 8 números'); local.set('kioskPin', pin); return go('/painel/totem'); }
    if (id === 'fCall') await q(sb.from('tenants').update({ call_names: $('#cnOn').checked }).eq('id', S.id));
    if (id === 'fAuto') await q(sb.from('tenants').update({ auto_accept: $('#aaOn').checked }).eq('id', S.id));
    if (id === 'fGoals') {
      const g = id => $(id).value.trim() ? toCents($(id).value) : 0, d = g('#gD'), m = g('#gM');
      if (!Number.isInteger(d) || d < 0 || !Number.isInteger(m) || m < 0) throw new Error('Meta inválida');
      await q(sb.from('tenants').update({ daily_goal: d, monthly_goal: m }).eq('id', S.id));
    }
    if (id === 'fClosed') {
      const date = $('#cdD').value; if (!date) throw new Error('Escolha a data');
      const today = ymdIn(st0.timezone, new Date());
      // mantém só datas de hoje em diante e troca a nota se a data já existir
      const cd = [...(st0.closed_dates || []).filter(d => d.date >= today && d.date !== date), { date, ...($('#cdN').value.trim() ? { note: $('#cdN').value.trim() } : {}) }].sort((a, b) => a.date.localeCompare(b.date));
      await q(sb.from('tenants').update({ closed_dates: cd }).eq('id', S.id));
    }
    if (id === 'fHours') {
      const hours = {};
      for (let i = 0; i < 7; i++) {
        const rs = [['a', 'b'], ['c', 'd']].map(([x, y]) => [$(`#h${i}${x}`).value, $(`#h${i}${y}`).value]).filter(([o, c]) => o || c);
        for (const [o, c] of rs) { if (!o || !c) throw new Error(`${DAYS[i]}: preencha abertura e fechamento`); if (o === c) throw new Error(`${DAYS[i]}: abertura e fechamento iguais`); }
        if (rs.length) hours[i] = rs;
      }
      if ($('#hAuto').checked && !Object.keys(hours).length) throw new Error('Preencha pelo menos um dia antes de ligar o horário automático');
      await q(sb.from('tenants').update({ hours, auto_hours: $('#hAuto').checked }).eq('id', S.id));
    }
    if (id === 'fPromo') {
      const kind = $('#pmKind').value, scope = $('#pmScope').value, from = $('#pmFrom').value, to = $('#pmTo').value;
      const name = $('#pmName').value.trim(); if (!name) throw new Error('Dê um nome para a promoção');
      if ((from && !to) || (!from && to) || (from && from === to)) throw new Error('Horário: preencha início e fim diferentes, ou deixe os dois em branco');
      const buy = +$('#pmBuy').value, pay = +$('#pmPay').value, pct = +$('#pmPct').value;
      if (kind === 'buy_x_pay_y' && !(buy >= 2 && buy <= 20 && pay >= 1 && pay < buy)) throw new Error('Leve X, pague Y: o "pague" precisa ser menor que o "leve"');
      if (kind === 'percent' && !(pct >= 1 && pct <= 90)) throw new Error('Desconto de 1% a 90%');
      const days = [...document.querySelectorAll('.pmDay:checked')].map(x => +x.value);
      await q(sb.from('promotions').insert({ tenant_id: S.id, name, kind,
        product_id: scope.startsWith('p:') ? +scope.slice(2) : null, category: scope.startsWith('c:') ? scope.slice(2) : null,
        buy_qty: kind === 'buy_x_pay_y' ? buy : null, pay_qty: kind === 'buy_x_pay_y' ? pay : null, percent: kind === 'percent' ? pct : null,
        days: days.length && days.length < 7 ? days : null, start_time: from || null, end_time: to || null }));
    }
    if (id === 'fShow') {
      const days = +$('#scDays').value, lead = +$('#scLead').value;
      if (!(days >= 1 && days <= 30) || !(lead >= 15 && lead <= 1440)) throw new Error('Agendamento: até 1 a 30 dias, antecedência de 15 a 1440 minutos');
      const insta = $('#shInsta').value.trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9._]{0,30}$/.test(insta)) throw new Error('Instagram: use só letras, números, ponto e _');
      await q(sb.from('tenants').update({ description: $('#shDesc').value.trim(), address: $('#shAddr').value.trim(), instagram: insta,
        allow_scheduling: $('#scOn').checked, schedule_days: days, schedule_lead_minutes: lead, schedule_slot_minutes: +$('#scSlot').value }).eq('id', S.id));
      await refreshBrand();
    }
    if (id === 'fDeliv') {
      const mode = document.querySelector('input[name="dMode"]:checked').value;
      const m = $('#dCoord').value.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
      if ($('#dCoord').value.trim() && !m) throw new Error('Coordenadas no formato: -23.5503, -46.6339');
      const tiers = [];
      for (let i = 0; i < 6; i++) {
        const km = $(`#tk${i}`).value.trim(), fee = $(`#tf${i}`).value.trim();
        if (!km && !fee) continue;
        const k = Number(km.replace(',', '.')), f = toCents(fee || '0');
        if (!(k > 0 && k <= 100) || !Number.isInteger(f) || f < 0) throw new Error(`Faixa ${i + 1}: confira os km e a taxa`);
        tiers.push([k, f]);
      }
      tiers.sort((a, b) => a[0] - b[0]);
      const above = $('#fdAbove').value.trim() ? toCents($('#fdAbove').value) : null;
      if (above !== null && !(Number.isInteger(above) && above > 0)) throw new Error('Frete grátis: informe um valor válido');
      if (!tiers.length) throw new Error('Cadastre pelo menos uma faixa de distância');
      if (mode === 'distance' && !m) throw new Error('Informe a localização da loja para cobrar por distância');
      const every = +$('#lEvery').value, pct = +$('#lPct').value;
      if (!(every >= 2 && every <= 50) || !(pct >= 1 && pct <= 50)) throw new Error('Fidelidade: a cada 2 a 50 pedidos, desconto de 1% a 50%');
      await q(sb.from('tenants').update({ delivery_mode: mode, lat: m ? +m[1] : null, lng: m ? +m[2] : null, distance_tiers: tiers,
        free_delivery_above: above, loyalty_enabled: $('#lOn').checked, loyalty_every: every, loyalty_percent: pct,
        allow_tables: $('#mOn').checked, tables_count: Math.max(1, Math.min(200, +$('#mCount').value || 10)),
        ...($('#mSvc') ? { service_percent: Math.max(0, Math.min(20, Math.round(+$('#mSvc').value || 0))) } : {}),
        ...($('#refRw') ? { referral_reward: (() => { const v = toCents($('#refRw').value || '0'); if (!Number.isInteger(v) || v < 0 || v > 10000) throw new Error('Indique e ganhe: de R$ 0 a R$ 100'); return v; })() } : {}),
        ...($('#cbPct') ? { cashback_percent: Math.max(0, Math.min(30, Math.round(+$('#cbPct').value || 0))), cashback_days: Math.max(7, Math.min(365, Math.round(+$('#cbDays').value || 90))) } : {}) }).eq('id', S.id));
      await refreshBrand();
    }
    if (id === 'fDom') { const d = await rpc('set_custom_domain', { p_tenant: S.id, p_domain: $('#dDom').value }); toast(d ? `Domínio salvo: ${d}. Agora avise o suporte para ativar.` : 'Domínio removido'); await draw(); return; }
    if (id === 'fPix') {
      const ps = await rpc('set_pix_settings', { p_tenant: S.id, p_token: $('#pxTok').value.trim() || null, p_enabled: $('#pxOn').checked });
      if (ps && 'cardEnabled' in ps && ps.cardEnabled !== $('#pxCard').checked) await rpc('set_card_online', { p_tenant: S.id, p_enabled: $('#pxCard').checked });
    }
    if (id === 'fZone') { const fee = toCents($('#zF').value); if (!Number.isInteger(fee) || fee < 0) throw new Error('Taxa inválida'); await q(sb.from('zones').insert({ tenant_id: S.id, name: $('#zN').value.trim(), fee })); }
    if (id === 'fCup') {
      const min = $('#cuMin').value.trim() ? toCents($('#cuMin').value) : 0;
      if (!Number.isInteger(min) || min < 0) throw new Error('Pedido mínimo inválido');
      const pct = +$('#cuP').value || 0;
      if (!pct && !$('#cuF').checked) throw new Error('Informe o % de desconto ou marque frete grátis');
      const until = $('#cuUntil').value ? new Date(`${$('#cuUntil').value}T23:59:59-03:00`).toISOString() : null;
      await q(sb.from('coupons').insert({ tenant_id: S.id, code: $('#cuC').value.trim().toUpperCase(), percent: pct, free_shipping: $('#cuF').checked,
        min_subtotal: min, valid_until: until, max_uses: +$('#cuMax').value || null, max_per_customer: +$('#cuPer').value || null, first_order_only: $('#cuFirst').checked }));
    }
    if (id === 'fCour') await q(sb.from('couriers').insert({ tenant_id: S.id, name: $('#crN').value.trim(), phone: $('#crP').value.trim() }));
    if (id === 'fTeam') await rpc('add_staff', { p_tenant: S.id, p_email: $('#tE').value });
    if (id === 'fDel') { await rpc('delete_my_tenant', { p_tenant: S.id, p_confirm_slug: $('#delSlug').value }); local.set('tenant', null); toast('Loja excluída'); return go('/'); }
    toast('Salvo'); await draw();
  });
  cleanup = () => { app.onclick = app.onchange = app.onsubmit = null; };
  // voltando do Mercado Pago: confere a assinatura na hora (o aviso automático pode demorar)
  if (new URLSearchParams(location.search).get('assinatura') === 'retorno') {
    history.replaceState(null, '', '/painel/config#assinatura');
    try { await billingCall({ action: 'sync', tenant: S.id }); await loadMe(); $('#banner').innerHTML = billingBanner(ME.tenant, true); toast('Assinatura atualizada'); } catch (e) { toast(e.message); }
  }
  await draw();
  if (location.hash === '#assinatura') $('#assinatura')?.scrollIntoView({ behavior: 'smooth' });
}

/* ================= PLATAFORMA ================= */
function billLabel(t) {
  if (!t.billingStatus) return '—';
  const d = x => x ? new Date(x).toLocaleDateString('pt-BR') : '—';
  const lbl = { trial: `Teste até ${d(t.trialEndsAt)}`, active: `Ativa até ${d(t.paidUntil)}`, past_due: 'Pagamento com problema', canceled: 'Cancelada', free: 'Grátis' }[t.billingStatus];
  return `<span class="badge ${t.canSell ? (t.billingStatus === 'trial' ? '' : 'b-g') : 'b-r'}">${lbl}${t.canSell ? '' : ' · bloqueada'}</span>`;
}
// Migrações que o site espera encontrar no banco (a tela Plataforma avisa as que faltam).
const MIGRATIONS = ['20261113000000_balcao.sql', '20261114000000_horarios_fotos.sql', '20261115000000_pix_online.sql', '20261116000000_assinaturas.sql',
  '20261117000000_entregador_clientes_lgpd.sql', '20261118000000_distancia_fidelidade.sql', '20261119000000_balcao_mesa_caixa.sql', '20261120000000_cupons_avaliacoes_estoque.sql',
  '20261121000000_agendamento_vitrine.sql', '20261122000000_promocoes.sql', '20261123000000_checagem.sql', '20261124000000_saude_plataforma.sql',
  '20261125000000_cartao_dominio_unidades.sql', '20261126000000_seguranca.sql',
  '20261127000000_mesa_servico_pedidos_antigos.sql', '20261128000000_vitrine_previsao_mesas.sql',
  '20261129000000_pausa_feriados_estacoes.sql', '20261130000000_caixa_acerto_bloqueio.sql',
  '20261201000000_insumos_financeiro.sql', '20261202000000_adicionais_importacao.sql', '20261203000000_cashback_atividades.sql',
  '20261204000000_metas_cardapio_chamada.sql', '20261205000000_aceite_reajuste.sql', '20261206000000_logotipo.sql', '20261207000000_chamada_nomes.sql', '20261208000000_sugestoes_garcom_avisos.sql', '20261209000000_totem_indicacao.sql', '20261210000000_entregador_ao_vivo.sql', '20261211000000_unidades_notas_produto.sql'];
const sparkCols = (rows, val, fmt, color) => { const m = Math.max(1, ...rows.map(val));
  return `<div class="spark">${rows.map(x => `<i title="${esc(x.d.split('-').reverse().join('/'))}: ${esc(fmt(x))}" style="height:${Math.max(2, val(x) / m * 100)}%;background:${color || 'var(--amber)'}"></i>`).join('')}</div>
    <div class="row between mut" style="font-size:12px"><span>${rows[0]?.d.split('-').reverse().slice(0, 2).join('/')}</span><span>hoje</span></div>`; };
// Gera as chaves dos avisos no próprio navegador: a privada só aparece aqui, uma vez, para ir aos segredos da função
async function pushSetupDialog(after) {
  const b64u = a => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64u(await crypto.subtle.exportKey('raw', k.publicKey)), priv = (await crypto.subtle.exportKey('jwk', k.privateKey)).d;
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32))), url = `${SUPABASE_URL}/functions/v1/push`;
  await rpc('push_setup', { p_public: pub, p_secret: secret, p_url: url });
  const row = (n, v) => `<label>${n}<span class="row" style="flex-wrap:nowrap"><input readonly value="${esc(v)}"><button type="button" class="ghost sm" data-copy="${esc(v)}">Copiar</button></span></label>`;
  dialog(`<h2>Avisos no celular: falta só o Supabase</h2>
    <p style="margin:0">As chaves foram geradas e o banco já está configurado. <b>Copie agora</b>: a chave privada não fica salva em nenhum lugar e não aparece de novo.</p>
    <ol class="mut" style="margin:0;padding-left:18px">
      <li>No Supabase, abra <b>Edge Functions → Secrets</b> e crie os três segredos abaixo.</li>
      <li>Em <b>Edge Functions → Deploy a new function → Via Editor</b>, crie a função <b>push</b> com o conteúdo de <code>supabase/functions/push/index.ts</code> e, nas configurações dela, desligue <b>Verify JWT</b>.</li>
      <li>Em <b>Database → Extensions</b>, ative <b>pg_net</b> (se ainda não estiver ativa).</li></ol>
    ${row('VAPID_PUBLIC_KEY', pub)}${row('VAPID_PRIVATE_KEY', priv)}${row('PUSH_SECRET', secret)}
    <div class="row"><button class="pri" data-close>Pronto, copiei</button></div>`, true);
  $('#dlgBody').onclick = e => { const c = e.target.closest('[data-copy]'); if (c) navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Copiado')).catch(() => {}); };
  after();
}
async function vPlatform() {
  let hDays = 30;
  setColor('#1d1716'); brand('Balcão');
  header('<a class="on" href="/plataforma" data-link>Plataforma</a>' + (ME.tenant ? '<a href="/painel" data-link>Minha loja</a>' : ''));
  const plans = await q(sb.from('plans').select('name').order('sort'));
  const draw = async () => {
    const [o, sch, h] = await Promise.all([rpc('platform_overview'), rpc('schema_status').catch(() => null), rpc('platform_health', { p_days: hDays }).catch(() => null)]);
    const doms = await rpc('platform_domains').catch(() => null);
    const push = await rpc('push_status').catch(() => null);
    const pushBox = !push ? '' : `<div class="panel" style="margin-bottom:20px"><div class="row between"><h3 style="margin:0">Avisos no celular do cliente</h3>
        <span class="badge ${push.configured ? 'b-g' : 'b-a'}">${push.configured ? 'Ativados' : 'Não configurados'}</span></div>
      <p class="mut" style="margin:6px 0">O cliente toca em "Me avise no celular" na página do pedido e recebe uma notificação quando o pedido é aceito, fica pronto, sai para entrega ou é cancelado.
        ${push.configured ? `${push.subscriptions} aparelho(s) inscrito(s) · ${push.sent7d} aviso(s) enviados em 7 dias${push.pending ? ` · <b>${push.pending} na fila sem envio</b> (confira a função push e os segredos)` : ''}.` : ''}
        ${push.configured && !push.pgNet ? '<br><b>A extensão pg_net não está ligada:</b> em Database → Extensions, ative <b>pg_net</b>.' : ''}</p>
      <button class="${push.configured ? 'ghost' : 'pri'} sm" id="pushGen">${push.configured ? 'Gerar chaves novas' : 'Gerar chaves e ativar'}</button></div>`;
    const missing = sch ? MIGRATIONS.map((file, i) => ({ n: i + 1, file, ok: sch.find(m => m.file === file)?.ok ?? false })).filter(m => !m.ok) : null;
    const dbBox = !missing ? `<div class="banner warn" style="margin-bottom:16px;text-align:left;border:1px solid var(--line);border-radius:12px"><b>Não consegui conferir o banco.</b> Rode no SQL Editor do Supabase a migração <code>20261123000000_checagem.sql</code> (e as anteriores que faltarem). Depois recarregue esta página.</div>`
      : missing.length ? `<div class="banner warn" style="margin-bottom:16px;text-align:left;border:1px solid var(--line);border-radius:12px"><b>Faltam ${missing.length} migraç${missing.length > 1 ? 'ões' : 'ão'} no banco.</b> Rode no SQL Editor do Supabase, nesta ordem, cada uma numa consulta nova:<ol style="margin:6px 0 0">${missing.map(m => `<li><code>${esc(m.file)}</code></li>`).join('')}</ol>Os arquivos estão na pasta <code>supabase/migrations</code> do GitHub. Enquanto faltarem, algumas telas mostram erro.</div>`
      : `<p class="mut" style="margin:-8px 0 16px">✓ Banco de dados em dia (${MIGRATIONS.length} migrações).</p>`;
    const sum = (k) => h ? h.days.reduce((a, x) => a + x[k], 0) : 0;
    const mail = t => t.ownerEmail ? `<a href="mailto:${esc(t.ownerEmail)}">${esc(t.ownerEmail)}</a>` : '<span class="mut">—</span>';
    const ago = d => d ? `${Math.floor(mins(d) / 1440)} dias` : 'nunca';
    const healthBox = !h ? '' : `<div class="row between" style="margin:8px 0 12px"><h3 style="margin:0">Saúde da plataforma</h3>
        <span class="row">${[7, 30, 90].map(d => `<button class="sm ${d === hDays ? 'pri' : 'ghost'}" data-hdays="${d}">${d} dias</button>`).join('')}</span></div>
      <div class="kpis"><div class="kpi"><span class="mut">Pedidos no período</span><b>${sum('orders')}</b><span class="mut">${brl(sum('gmv'))} vendidos</span></div>
        <div class="kpi"><span class="mut">Lojas com pedido (7 dias)</span><b>${h.activeStores7d}</b><span class="mut">de ${o.tenants.filter(t => t.active).length} ativas</span></div>
        <div class="kpi"><span class="mut">Novos cadastros</span><b>${sum('signups')}</b><span class="mut">no período</span></div>
        <div class="kpi"><span class="mut">Precisam de atenção</span><b>${h.pastDue.length + h.trialsEnding.length}</b><span class="mut">${h.pastDue.length} cobrança(s) · ${h.trialsEnding.length} teste(s) acabando</span></div></div>
      <div class="two" style="margin-bottom:20px"><div class="panel"><h3>Pedidos por dia</h3>${sparkCols(h.days, x => x.orders, x => `${x.orders} pedidos · ${brl(x.gmv)}`)}</div>
        <div class="panel"><h3>Cadastros por dia</h3>${sparkCols(h.days, x => x.signups, x => `${x.signups} cadastro(s)`, 'var(--basil)')}</div>
        <div class="panel"><h3>Testes acabando (${h.trialsEnding.length})</h3><p class="mut" style="margin:0 0 8px">Bom momento para oferecer ajuda e converter em assinatura.</p>
          ${h.trialsEnding.map(t => `<div class="ci"><span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a><br>${mail(t)}</span><span class="mut" style="text-align:right">${new Date(t.trialEndsAt) < Date.now() ? '<span class="badge b-r">acabou</span>' : `acaba ${new Date(t.trialEndsAt).toLocaleDateString('pt-BR')}`}<br>último pedido: ${ago(t.lastOrder)}</span></div>`).join('') || '<p class="empty">Nenhum</p>'}
          <h3>Cobrança com problema (${h.pastDue.length})</h3>
          ${h.pastDue.map(t => `<div class="ci"><span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a><br>${mail(t)}</span><span><span class="badge ${t.status === 'canceled' ? 'b-r' : 'b-a'}">${t.status === 'canceled' ? 'Cancelada' : 'Pagamento falhou'}</span></span></div>`).join('') || '<p class="empty">Nenhuma</p>'}</div>
        <div class="panel"><h3>Lojas paradas (${h.idle.length})</h3><p class="mut" style="margin:0 0 8px">Ativas, mas sem nenhum pedido há mais de 7 dias. Risco de cancelar.</p>
          ${h.idle.slice(0, 15).map(t => `<div class="ci"><span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a><br>${mail(t)}</span><span class="mut" style="text-align:right">${t.lastOrder ? `sem pedir há ${ago(t.lastOrder)}` : `nenhum pedido<br>cadastro há ${ago(t.createdAt)}`}</span></div>`).join('') || '<p class="empty">Nenhuma. Todas vendendo!</p>'}
          ${h.idle.length > 15 ? `<p class="mut">e mais ${h.idle.length - 15}…</p>` : ''}</div></div>`;
    app.innerHTML = `<h2>Plataforma</h2><p class="lead">Todas as empresas assinantes. Novas empresas se cadastram sozinhas em <a href="/entrar/cadastro" data-link>/entrar/cadastro</a>.</p>
    ${dbBox}
    <div class="kpis"><div class="kpi"><span class="mut">Empresas</span><b>${o.tenants.length}</b><span class="mut">${o.paying ?? 0} pagando · ${o.trials ?? 0} em teste</span></div><div class="kpi"><span class="mut">Receita mensal (MRR)</span><b class="price">${brl(o.mrr)}</b><span class="mut">+ ${brl(o.potentialMrr || 0)} se os testes virarem assinatura</span></div>
      <div class="kpi"><span class="mut">Vendido pelas lojas</span><b class="price">${brl(o.gmv)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${o.orders}</b></div></div>
    ${healthBox}
    ${pushBox}
    ${doms?.length ? `<div class="panel" style="margin-bottom:20px"><h3>Domínios próprios (${doms.length})</h3>
      <p class="mut" style="margin:0 0 8px">Para ativar, adicione cada domínio na Vercel: projeto → <b>Settings → Domains → Add</b>. A Vercel confere o DNS da loja e cria o certificado sozinha.</p>
      ${doms.map(d => `<div class="ci"><span><b>${esc(d.domain)}</b><br><span class="mut">${esc(d.name)}</span></span><span class="row"><button class="ghost sm" data-copydom="${esc(d.domain)}">Copiar</button><a class="btn ghost sm" href="https://${esc(d.domain)}" target="_blank" rel="noopener">Testar</a></span></div>`).join('')}</div>` : ''}
    <div class="panel"><h3>Empresas</h3><div class="scroll"><table class="stack"><thead><tr><th>Empresa</th><th>Segmento</th><th>Dono</th><th>Plano</th><th>Assinatura</th><th class="n">Pedidos</th><th class="n">Vendas</th><th></th></tr></thead><tbody>
      ${o.tenants.map(t => `<tr><td data-l="Empresa"><span class="dot" style="background:${esc(t.color)}"></span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a> ${t.active ? '' : '<span class="badge b-r">Suspensa</span>'}</td><td data-l="Segmento">${esc(t.segmentName)}</td><td data-l="Dono"><span class="mut">${esc(t.ownerEmail || '—')}</span></td>
        <td data-l="Plano"><select data-plan="${t.id}" aria-label="Plano">${plans.map(p => `<option ${p.name === t.plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>
        <td data-l="Assinatura">${billLabel(t)}<span class="row" style="margin-top:4px"><button class="ghost sm" data-bill="${t.id}" data-st="active" data-days="30">+30 dias</button><button class="ghost sm" data-bill="${t.id}" data-st="trial" data-days="7">+7 dias teste</button>${t.billingStatus === 'free' ? '' : `<button class="ghost sm" data-bill="${t.id}" data-st="free">Grátis</button>`}</span></td>
        <td data-l="Pedidos" class="n">${t.orders}</td><td data-l="Vendas" class="n price">${brl(t.revenue)}</td><td data-l=""><button class="ghost sm" data-act="${t.id}" data-on="${t.active ? 1 : 0}">${t.active ? 'Suspender' : 'Reativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Nenhuma empresa ainda.</td></tr>'}</tbody></table></div></div>`;
  };
  app.onclick = attempt(async e => {
    const hd = e.target.closest('button[data-hdays]'); if (hd) { hDays = +hd.dataset.hdays; return draw(); }
    if (e.target.closest('#pushGen')) return pushSetupDialog(draw);
    const cd = e.target.closest('button[data-copydom]'); if (cd) { try { await navigator.clipboard.writeText(cd.dataset.copydom); toast('Domínio copiado'); } catch { toast(cd.dataset.copydom); } return; }
    const bb = e.target.closest('button[data-bill]');
    if (bb) { await rpc('platform_set_billing', { p_tenant: bb.dataset.bill, p_status: bb.dataset.st, p_add_days: bb.dataset.days ? +bb.dataset.days : null }); toast('Assinatura atualizada'); return draw(); }
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
