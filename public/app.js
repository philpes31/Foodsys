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
const fromCents = c => ((c || 0) / 100).toFixed(2).replace('.', ',');
const mins = t => Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 60000));
const hhmm = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const CHANNEL = { online: 'Site', balcao: 'Balcão', telefone: 'Telefone', mesa: 'Mesa' };
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
async function shrinkImage(file, max = 900) {
  if (!/^image\//.test(file.type)) throw new Error('Escolha um arquivo de imagem');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('Não foi possível ler a imagem')), 'image/jpeg', .82));
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
      if (at.getTime() >= minAt && at.getTime() <= maxAt) slots.push({ iso: at.toISOString(), label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
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

/* ---------- comanda (impressora térmica 80 mm) ---------- */
// Folha A4 com os QR Codes das mesas (imagem gerada pelo serviço público goqr.me/api.qrserver.com)
async function printTableQrs(slug, count, storeName) {
  const url = n => `${location.origin}/loja/${slug}?mesa=${n}`;
  $('#print').innerHTML = `<div class="qrsheet">${Array.from({ length: count }, (_, i) => `<div class="qrcard"><b>${esc(storeName)}</b>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=${encodeURIComponent(url(i + 1))}" alt="QR Code da mesa ${i + 1}">
    <span class="big">Mesa ${i + 1}</span><span>Aponte a câmera para pedir</span></div>`).join('')}</div>`;
  toast('Preparando os QR Codes…');
  await Promise.all([...$('#print').querySelectorAll('img')].map(img => img.complete ? 0 : new Promise(ok => { img.onload = img.onerror = ok; })));
  window.print();
}

function printTicket(o, storeName) {
  const box = $('#print');
  box.innerHTML = `<div class="tkt"><b class="big">${esc(storeName)}</b><div>Pedido <b class="big">#${o.number}</b></div>${o.scheduled_for ? `<div><b class="big">AGENDADO: ${esc(fmtWhen(o.scheduled_for))}</b></div>` : ''}
    <div>${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div><hr>
    <div><b>${esc(o.customer_name)}</b> · ${esc(o.customer_phone)}</div>
    <div>${o.fulfillment === 'table' ? `<b class="big">MESA ${esc(o.table_label)}</b>` : o.fulfillment === 'pickup' ? `<b>RETIRADA${o.channel === 'balcao' ? ' · BALCÃO' : ' NA LOJA'}</b>` : `<b>ENTREGA</b> · ${esc(o.address)} — ${esc(o.zone_name)}`}</div><hr>
    ${o.items.map(x => `<div class="li"><b>${x.qty}x ${esc(x.product_name)}</b><span>${brl(x.qty * x.unit_price)}</span></div>${x.options_text ? `<div class="sub">${esc(x.options_text)}</div>` : ''}${x.notes ? `<div class="sub">OBS: ${esc(x.notes)}</div>` : ''}`).join('')}<hr>
    <div class="li"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
    ${o.fee ? `<div class="li"><span>Entrega</span><span>${brl(o.fee)}</span></div>` : ''}${o.promo_discount ? `<div class="li"><span>Promoção</span><span>-${brl(o.promo_discount)}</span></div>` : ''}${o.discount ? `<div class="li"><span>Desconto</span><span>-${brl(o.discount)}</span></div>` : ''}
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
  cleanup?.(); cleanup = null; closeDlg(); window.scrollTo(0, 0); $('#banner').innerHTML = ''; setManifest(null);
  if (!configured) return vSetup();
  const p = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (p[0] === 'loja' && p[1]) return await vShop(p[1]);
    if (p[0] === 'pedido' && p[1]) return await vTrack(p[1]);
    if (p[0] === 'entrar') return vAuth(p[1]);
    if (p[0] === 'termos' || p[0] === 'privacidade') return vLegal(p[0]);
    if (p[0] === 'entregador' && p[1]) return await vCourier(p[1]);
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
  setColor('#d62828'); $('#bName').textContent = PLATFORM.name; header('', false);
  const missing = !PLATFORM.company || !PLATFORM.cnpj || !PLATFORM.email || !PLATFORM.city;
  app.innerHTML = `<article class="panel legal">${missing ? '<p class="banner warn" style="margin:0">Modelo: preencha os dados da empresa em <code>public/config.js</code> (PLATFORM) e revise o texto com um advogado.</p>' : ''}
    ${which === 'termos' ? termsHtml(PLATFORM) : privacyHtml(PLATFORM)}</article>`;
}

/* ---------- página do entregador (link secreto, sem login) ---------- */
async function vCourier(token) {
  let lastSig = '';
  const draw = async (force) => {
    const r = await rpc('courier_portal', { p_token: token });
    if (!r) { app.innerHTML = '<div class="panel auth"><h2>Link inválido</h2><p>Peça um link novo para a loja.</p></div>'; header('', false); return false; }
    const sig = JSON.stringify(r); if (!force && sig === lastSig) return true; lastSig = sig;
    setColor(r.store.color); $('#bName').textContent = r.store.name; header('', false);
    app.innerHTML = `<div class="courier"><h2>Olá, ${esc(r.courier.name.split(' ')[0])}!</h2>
      <p class="lead">Hoje: <b>${r.today.deliveries}</b> entrega(s) · ${brl(r.today.fees)} em taxas. Esta página atualiza sozinha.</p>
      ${r.deliveries.map(d => `<div class="panel dl">
        <div class="row between"><b class="big">#${d.number}</b><span class="mut">saiu há ${mins(d.since)} min</span></div>
        <div><b>${esc(d.customerName)}</b></div>
        <div class="addr">${esc(d.address)}<br><span class="mut">${esc(d.zone)}</span></div>
        <div class="${d.paid ? 'badge b-g' : 'badge b-a'}" style="font-size:14px;padding:6px 10px">${d.paid ? 'JÁ PAGO · não cobrar' : `Cobrar ${brl(d.total)} · ${esc(d.payment)}${d.changeFor ? ` · levar troco p/ ${brl(d.changeFor)}` : ''}`}</div>
        <div class="mut">${d.items.map(esc).join(' · ')}</div>
        <div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
          <a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(/ km$/.test(d.zone) ? d.address : d.address + ', ' + d.zone)}" target="_blank" rel="noopener">Mapa</a>
          ${waBtn(waLink(d.customerPhone, `Olá, ${d.customerName.split(' ')[0]}! Sou o entregador da ${r.store.name} e estou chegando com seu pedido #${d.number}.`), 'WhatsApp').replace('btn ghost sm', 'btn ghost') || '<span></span>'}
          <a class="btn ghost" href="tel:${esc(String(d.customerPhone).replace(/[^\d+]/g, ''))}">Ligar</a></div>
        <button class="ok" data-done="${d.id}">Entreguei</button></div>`).join('') || '<div class="panel"><p class="empty">Nenhuma entrega com você agora.</p></div>'}
      ${r.store.phone ? `<p class="mut">Dúvidas: ${esc(r.store.phone)}</p>` : ''}</div>`;
    return true;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button[data-done]'); if (!b) return;
    if (!sure(b)) return;
    await rpc('courier_deliver', { p_token: token, p_order: +b.dataset.done }); toast('Entrega confirmada'); await draw(true);
  });
  if (await draw(true)) { const h = setInterval(() => draw().catch(() => {}), 15000); cleanup = () => { clearInterval(h); app.onclick = null; }; }
  else cleanup = () => { app.onclick = null; };
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
  const S = (await q(sb.from('tenants').select('*, seg:segment_templates(name)').eq('slug', slug).limit(1)))[0];
  if (!S) throw new Error('Loja não encontrada');
  const [rawP, zones] = await Promise.all([
    q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)),
    q(sb.from('zones').select('id, name, fee').eq('tenant_id', S.id).order('name'))]);
  const products = sortMenu(rawP), OS = openState(S), DIST = S.delivery_mode === 'distance';
  const RV = await rpc('store_reviews', { p_slug: slug, p_limit: 10 }).catch(() => null);
  const PROMOS = await q(sb.from('promotions').select('*').eq('tenant_id', S.id).eq('active', true)).catch(() => []);
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  // Pedido na mesa: o QR Code da mesa abre /loja/<loja>?mesa=7
  const mesaParam = (new URLSearchParams(location.search).get('mesa') || '').toUpperCase().trim();
  const TABLE = S.allow_tables && /^[A-Z0-9][A-Z0-9 -]{0,9}$/.test(mesaParam) ? mesaParam : null;
  const SLOTS = !TABLE && S.allow_scheduling && S.is_open && billingOk(S) ? scheduleSlots(S) : [];
  const CAN_ORDER = OS.open || SLOTS.length > 0, SCHED_ONLY = !OS.open && SLOTS.length > 0;
  let geo = null; // { lat, lng, quote: { km, fee, inArea, maxKm } } no modo por distância
  const zoneTxt = () => !geo?.quote ? '' : geo.quote.inArea
    ? `Distância aproximada: <b>${kmTxt(geo.quote.km)}</b> · taxa ${geo.quote.fee ? brl(geo.quote.fee) : 'grátis'}`
    : `<span class="badge b-r">Fora da área de entrega: ${kmTxt(geo.quote.km)} (a loja entrega até ${kmTxt(geo.quote.maxKm)})</span>`;
  setColor(S.color); $('#bName').textContent = S.name; header('', false); document.title = `${S.name} — pedido online`; setManifest(S);
  const cartKey = `cart:${slug}`;
  let cart = local.get(cartKey, []).filter(c => products.some(p => p.id === c.productId)), cat = null, coupon = null;
  const cats = [...new Set(products.map(p => p.category))];
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
  const totals = () => {
    const sub = cart.reduce((t, c) => t + c.qty * c.unit, 0), pickup = !!TABLE || $('#cMode')?.value === 'pickup';
    const z = DIST ? null : zones.find(z => String(z.id) === $('#cZone')?.value) || zones[0];
    let fee = pickup ? 0 : DIST ? (geo?.quote?.fee || 0) : z ? z.fee : 0, disc = 0;
    const freeShip = !pickup && S.free_delivery_above && sub >= S.free_delivery_above;
    if (freeShip) fee = 0;
    if (coupon) { if (coupon.percent) disc = Math.round(sub * coupon.percent / 100); if (coupon.freeShipping) fee = 0; }
    const when = $('#kWhen')?.value ? new Date($('#kWhen').value) : new Date();
    const pr = promoDiscount(PROMOS, cart, byId, S.timezone, when), promo = Math.min(pr.total, sub);
    return { sub, fee, disc, promo, promoNames: pr.names, total: Math.max(0, sub + fee - disc - promo), pickup, zone: z, freeShip, feeKnown: pickup || freeShip || !DIST || !!geo?.quote?.inArea };
  };
  const paint = () => {
    cat = cats.includes(cat) ? cat : cats[0];
    const list = products.filter(p => p.category === cat), count = cart.reduce((t, c) => t + c.qty, 0);
    app.innerHTML = `${TABLE ? `<div class="banner" style="margin:-24px calc(-1 * max(4vw,16px)) 16px">Você está pedindo para a <b>Mesa ${esc(TABLE)}</b>. O pedido vai direto para a cozinha.</div>` : ''}${S.banner_path ? `<div class="hero-banner" style="background-image:linear-gradient(0deg,#000a,#0000 60%),url('${esc(imgUrl(S.banner_path))}')"><h1>${esc(S.name)}</h1></div>` : `<h2>${esc(S.name)}</h2>`}
    ${S.description ? `<p class="desc">${esc(S.description)}</p>` : ''}
    <p class="lead">${SCHED_ONLY ? '<span class="badge b-a">Fechado agora · agende seu pedido</span> · ' : ''}${RV?.count ? `<button class="rating" id="seeReviews">★ ${String(RV.avg).replace('.', ',')} <span class="mut">(${RV.count} avaliaç${RV.count > 1 ? 'ões' : 'ão'})</span></button> · ` : ''}${esc(S.seg?.name)} · ${OS.open ? `<span class="badge b-g">Aberto${OS.label ? ' ' + OS.label : ' agora'}</span>` : `<span class="badge b-r">${esc(OS.label || 'Fechado')}</span>`} · entrega em ${esc(S.eta_text)}${S.min_order ? ` · pedido mínimo ${brl(S.min_order)}` : ''}${S.phone ? ` · ${esc(S.phone)}` : ''}
      ${waLink(S.phone, `Olá, ${S.name}!`) ? ` · <a href="${esc(waLink(S.phone, `Olá, ${S.name}!`))}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ''}
      ${S.instagram ? ` · <a href="https://instagram.com/${esc(S.instagram)}" target="_blank" rel="noopener">@${esc(S.instagram)}</a>` : ''}
      ${S.address ? `<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(S.address)}" target="_blank" rel="noopener">${esc(S.address)}</a>` : ''}</p>
    ${S.auto_hours && Object.keys(S.hours || {}).length ? `<details class="hours-pub"><summary class="mut">Horário de funcionamento</summary><table>${DAYS.map((d, i) => `<tr><td>${d}</td><td>${((S.hours || {})[i] || []).map(r => r.join(' às ')).join(' · ') || 'Fechado'}</td></tr>`).join('')}</table></details>` : ''}
    ${PROMOS.length || S.free_delivery_above ? `<div class="promos">${S.free_delivery_above ? `<span class="promo">Frete grátis acima de ${brl(S.free_delivery_above)}</span>` : ''}${PROMOS.map(pm => `<span class="promo ${promoActive(pm, S.timezone) ? '' : 'off'}">${esc(promoLabel(pm, byId))}${promoActive(pm, S.timezone) ? '' : ' (fora do horário)'}</span>`).join('')}</div>` : ''}
    <div class="shop"><section>
      <div class="cats">${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="menu">${list.map(p => `<article class="item">${picture(p, S.color)}<div class="b">${PROMOS.some(pm => promoActive(pm, S.timezone) && promoMatches(pm, p)) ? '<span class="badge b-g">Em promoção</span>' : ''}<h3>${esc(p.name)}</h3><span class="mut">${esc(p.description)}</span>
        <div class="foot"><span class="price">${p.groups.some(g => g.min_sel && g.options.some(o => o.price)) ? '<span class="mut">a partir de </span>' : ''}<b>${brl(p.price)}</b></span>
        ${p.stock === 0 ? '<span class="badge b-r">Esgotado</span>' : `<button class="pri sm" data-add="${p.id}" ${CAN_ORDER ? '' : 'disabled'}>Adicionar</button>`}</div>${p.stock > 0 && p.stock <= 5 ? `<span class="badge b-a">Últimas ${p.stock} unidade${p.stock > 1 ? 's' : ''}</span>` : ''}</div></article>`).join('') || '<p class="empty">Cardápio vazio.</p>'}</div>
    </section>
    <aside class="cart" aria-label="Carrinho"><h3>Seu pedido</h3>
      ${cart.length ? cart.map((x, i) => `<div class="ci"><div><b>${x.qty}× ${esc(x.name)}</b>${x.optText ? `<br><span class="mut">${esc(x.optText)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}<br><button class="ghost sm" data-dec="${i}" aria-label="Diminuir">−</button> <button class="ghost sm" data-inc="${i}" aria-label="Aumentar">+</button></div><span class="price">${brl(x.qty * x.unit)}</span></div>`).join('') : `<p class="empty">Carrinho vazio.</p>${againItems().length ? `<button class="ghost" id="again" style="width:100%">↻ Pedir de novo<br><span class="mut" style="font-weight:400">${esc(againItems().map(x => `${x.qty}× ${x.name}`).join(', ').slice(0, 90))}</span></button>` : ''}`}
      ${TABLE ? `<p style="margin:0">Pedido para a <b>Mesa ${esc(TABLE)}</b></p>` : `<label>Como receber<select id="cMode"><option value="delivery">Entrega</option>${S.allow_pickup ? '<option value="pickup">Retirar na loja</option>' : ''}</select></label>`}
      <label id="zWrap" ${DIST || TABLE ? 'hidden' : ''}>Bairro<select id="cZone">${zones.map(z => `<option value="${z.id}">${esc(z.name)} · ${z.fee ? brl(z.fee) : 'grátis'}</option>`).join('')}</select></label>
      <label>Cupom<span class="row" style="flex-wrap:nowrap"><input id="cCup" placeholder="Ex.: PRIMEIRA10" value="${esc(coupon?.code || '')}"><button class="ghost" id="cupBtn">Aplicar</button></span></label>
      <div id="tots"></div><button class="pri" id="checkout">Finalizar pedido</button></aside></div>
    ${count ? `<button class="pri cartbar" id="toCart">Ver carrinho · ${count} ${count > 1 ? 'itens' : 'item'} · ${brl(cart.reduce((t, c) => t + c.qty * c.unit, 0))}</button>` : ''}`;
    paintTotals();
  };
  const paintTotals = () => {
    const t = totals(), low = !t.pickup && S.min_order && t.sub < S.min_order; $('#zWrap').hidden = t.pickup || DIST;
    $('#tots').innerHTML = `<div class="ci"><span>Subtotal</span><span class="price">${brl(t.sub)}</span></div>${TABLE ? '' : `<div class="ci"><span>Entrega${DIST && geo?.quote && !t.pickup ? ` (${kmTxt(geo.quote.km)})` : ''}</span><span class="price">${!t.feeKnown ? 'pelo endereço' : t.fee ? brl(t.fee) : 'Grátis'}</span></div>`}${t.disc ? `<div class="ci"><span>Desconto</span><span class="price">−${brl(t.disc)}</span></div>` : ''}${t.promo ? `<div class="ci"><span>Promoção <span class="mut">(${esc(t.promoNames.join(', '))})</span></span><span class="price">−${brl(t.promo)}</span></div>` : ''}<div class="tot"><span>Total</span><span class="price">${brl(t.total)}</span></div>${low && cart.length ? `<span class="badge b-a">Faltam ${brl(S.min_order - t.sub)} para o pedido mínimo</span>` : ''}${!TABLE && !t.pickup && S.free_delivery_above && cart.length && !t.freeShip ? `<span class="badge b-g">Faltam ${brl(S.free_delivery_above - t.sub)} para o frete grátis</span>` : ''}`;
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
      ${S.loyalty_enabled ? `<p class="mut" style="margin:0">Fidelidade: a cada ${S.loyalty_every} pedidos entregues, ${S.loyalty_percent}% de desconto no próximo, aplicado automaticamente.</p>` : ''}
      ${SLOTS.length ? `<label>Quando?<select id="kWhen">${SCHED_ONLY ? '' : `<option value="">O quanto antes (${esc(S.eta_text)})</option>`}${SLOTS.map(d => `<optgroup label="${esc(d.day)}">${d.slots.map(x => `<option value="${x.iso}">${esc(d.day)} às ${x.label}</option>`).join('')}</optgroup>`).join('')}</select></label>` : ''}
      <label>Pagamento<select id="kPay">${TABLE ? '<option value="Pagar no caixa" selected>Pagar no caixa / na mesa</option>' : ''}${S.pix_online ? `<option value="Pix online" ${TABLE ? '' : 'selected'}>Pix agora (QR Code, confirmação automática)</option>` : ''}${TABLE ? '' : '<option value="Pix">Pix na entrega</option><option>Cartão na entrega</option><option>Dinheiro</option>'}</select></label>
      <label id="kEm" ${S.pix_online ? '' : 'hidden'}>E-mail (para o comprovante do Pix)<input id="kEmail" type="email" autocomplete="email" value="${esc(last.email || '')}" placeholder="voce@email.com"></label>
      <label id="kTr" hidden>Troco para (R$)<input id="kT" inputmode="decimal" placeholder="Ex.: 100"></label>
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
          changeFor: $('#kT').value ? toCents($('#kT').value) : undefined, coupon: coupon?.code,
          items: cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, notes: c.notes })) } });
        local.set('customer', { ...last, ...customer, ...(email ? { email } : {}), ...(t.pickup || TABLE ? {} : { cep: $('#kCep').value, rua: $('#kRua').value, num: $('#kNum').value, comp: $('#kComp').value }) });
        local.set(lastKey, cart.map(c => ({ productId: c.productId, qty: c.qty, optionIds: c.optionIds, optText: c.optText, notes: c.notes })));
        cart = []; saveCart();
        if (r.pix) { $('#kGo').textContent = 'Gerando Pix…'; try { await pixCall({ action: 'create', code: r.code, email }); } catch (err) { toast(err.message); } }
        closeDlg(); go(`/pedido/${r.code}`);
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
      <button class="ghost" onclick="document.getElementById('dlg').click()">Fechar</button>`);
  });
  app.onchange = e => { if (['cMode', 'cZone'].includes(e.target.id)) paintTotals(); };
  cleanup = () => { app.onclick = app.onchange = null; document.title = 'Balcão'; };
  paint();
}

/* ---------- acompanhamento do pedido ---------- */
async function vTrack(code) {
  let lastSig = '', rating = 0;
  const draw = async (force) => {
    const r = await rpc('track_order', { p_code: code });
    if (!r) throw new Error('Pedido não encontrado');
    const { store: S, order: o } = r;
    const sig = JSON.stringify(r);
    if (!force && sig === lastSig) return o.status;
    lastSig = sig;
    if (o.status === 'pagamento') { drawPix(S, o); return o.status; }
    setColor(S.color); $('#bName').textContent = S.name; header('', false);
    const flow = o.fulfillment !== 'delivery' ? ['novo', 'preparo', 'pronto', 'entregue'] : ['novo', 'preparo', 'pronto', 'rota', 'entregue'];
    const idx = flow.indexOf(o.status), at = Object.fromEntries(o.events.map(e => [e.status, e.at]));
    app.innerHTML = `<h2>Pedido #${o.number}</h2><p class="lead">Olá, ${esc(o.customerName)}! Esta página atualiza sozinha.</p>
    ${o.scheduledFor && !['entregue', 'cancelado'].includes(o.status) ? `<p class="banner" style="margin:0 0 16px;max-width:760px">Pedido <b>agendado para ${esc(fmtWhen(o.scheduledFor))}</b>.</p>` : ''}
    <div class="panel" style="max-width:760px">
      ${o.paymentStatus === 'paid' ? '<span class="badge b-g">Pagamento confirmado</span>' : ''}
      ${o.status === 'cancelado' ? `<span class="badge b-r">${o.paymentStatus === 'expired' ? 'Pedido cancelado: o Pix não foi pago dentro do prazo.' : 'Pedido cancelado pela loja.'}${S.phone ? ' Contato: ' + esc(S.phone) : ''}</span>` :
      `<div class="steps">${flow.map((s, i) => `<span class="${i <= idx ? 'on' : ''}">${s === 'pronto' && o.fulfillment === 'pickup' ? 'Pronto p/ retirar' : s === 'entregue' && o.fulfillment === 'table' ? 'Servido' : SLABEL[s]}${at[s] ? `<br><small>${hhmm(at[s])}</small>` : ''}</span>`).join('')}</div>`}
      ${o.courier ? `<p><b>${esc(o.courier)}</b> está a caminho de ${esc(o.address)}, ${esc(o.zone)}.</p>` : ''}
      <table><tbody>${o.items.map(x => `<tr><td>${x.qty}× ${esc(x.product_name)}${x.options_text ? `<br><span class="mut">${esc(x.options_text)}</span>` : ''}${x.notes ? `<br><span class="mut">Obs: ${esc(x.notes)}</span>` : ''}</td><td class="n price">${brl(x.qty * x.unit_price)}</td></tr>`).join('')}
      <tr><td>${o.fulfillment === 'pickup' ? 'Retirada na loja' : o.fulfillment === 'table' ? esc(o.zone) : `Entrega (${esc(o.zone)})`}</td><td class="n price">${brl(o.fee)}</td></tr>
      ${o.discount ? `<tr><td>Desconto ${o.loyaltyDiscount ? 'de fidelidade' : esc(o.coupon || '')}</td><td class="n price">−${brl(o.discount)}</td></tr>` : ''}
      ${o.promoDiscount ? `<tr><td>Promoção (${esc(o.promoNames || '')})</td><td class="n price">−${brl(o.promoDiscount)}</td></tr>` : ''}
      <tr><td><b>Total · ${esc(o.payment)}</b></td><td class="n price"><b>${brl(o.total)}</b></td></tr></tbody></table>
      ${o.loyalty ? `<div class="loyal"><b>Cartão fidelidade</b>${o.loyaltyDiscount ? `<span class="badge b-g">Você ganhou ${o.loyalty.percent}% neste pedido!</span>` : ''}
        <div class="stamps">${Array.from({ length: o.loyalty.every }, (_, i) => `<i class="${i < Math.min(o.loyalty.stamps, o.loyalty.every) ? 'on' : ''}"></i>`).join('')}</div>
        <span class="mut">${o.loyalty.stamps >= o.loyalty.every ? `Seu próximo pedido tem ${o.loyalty.percent}% de desconto.` : `${o.loyalty.stamps} de ${o.loyalty.every} pedidos entregues. Faltam ${o.loyalty.every - o.loyalty.stamps} para ganhar ${o.loyalty.percent}% de desconto.`}</span></div>` : ''}
      ${o.canReview ? `<div class="loyal" id="rvBox"><b>Como foi o seu pedido?</b><div class="starpick">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" aria-label="${n} estrela${n > 1 ? 's' : ''}">☆</button>`).join('')}</div>
        <textarea id="rvText" rows="2" maxlength="500" placeholder="Conte o que achou (opcional)"></textarea><button class="pri" id="rvSend" disabled>Enviar avaliação</button></div>` : ''}
      ${o.review ? `<div class="loyal"><b>Sua avaliação</b><span class="stars">${'★'.repeat(o.review.rating)}${'☆'.repeat(5 - o.review.rating)}</span>${o.review.comment ? `<span>${esc(o.review.comment)}</span>` : ''}${o.review.reply ? `<span class="mut">Resposta da loja: ${esc(o.review.reply)}</span>` : ''}</div>` : ''}
      <div class="row"><a class="btn ghost" href="/loja/${esc(S.slug)}" data-link>Voltar à loja</a>${['entregue', 'cancelado'].includes(o.status) && o.fulfillment !== 'table' ? `<a class="btn pri" href="/loja/${esc(S.slug)}?repetir=1" data-link>↻ Pedir de novo</a>` : ''}</div></div>`;
    return o.status;
  };
  // Tela de pagamento: QR Code, copia-e-cola, prazo e botão "Já paguei"
  const drawPix = (S, o) => {
    setColor(S.color); $('#bName').textContent = S.name; header('', false);
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
    if (b.id === 'rvSend') { b.disabled = true; try { await rpc('review_order', { p_code: code, p_rating: rating, p_comment: $('#rvText').value }); toast('Obrigado pela avaliação!'); await draw(true); } finally { b.disabled = false; } return; }
    if (b.id === 'pixCopy') { const ta = $('#pixCode'); try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); } toast('Código copiado. Cole no app do banco.'); }
    if (b.id === 'pixNew') { b.disabled = true; try { await pixCall({ action: 'create', code, email: $('#pixEmail').value }); await draw(true); } finally { b.disabled = false; } }
    if (b.id === 'pixCheck') { b.disabled = true; try { const r = await pixCall({ action: 'check', code }); toast(r.paid ? 'Pagamento confirmado!' : 'Ainda não caiu. Pode levar alguns segundos.'); await draw(true); } finally { b.disabled = false; } }
  });
  const st = await draw(true);
  if (!['entregue', 'cancelado'].includes(st)) {
    const h = setInterval(async () => { try { if (['entregue', 'cancelado'].includes(await draw())) clearInterval(h); } catch {} }, 5000);
    cleanup = () => { clearInterval(h); app.onclick = null; };
  } else cleanup = () => { app.onclick = null; };
}

/* ================= PAINEL DA EMPRESA ================= */
async function vPanel(tab) {
  const S = ME.tenant, owner = ME.role === 'owner';
  setColor(S.color); $('#bName').textContent = S.name;
  const tabs = [['pedidos', S.seg?.prep || 'Preparo'], ['entregas', 'Entregas'], ['cardapio', 'Cardápio'], ['caixa', 'Caixa'], ...(owner ? [['clientes', 'Clientes'], ['relatorios', 'Relatórios'], ['config', 'Configurações']] : [])];
  if (tab === 'kds') return pKitchenScreen(S);
  if (!tabs.some(t => t[0] === tab) && tab !== 'novo') tab = 'pedidos';
  $('#banner').innerHTML = billingBanner(S, owner);
  header(tabs.map(([k, n]) => `<a href="/painel/${k}" data-link class="${k === tab ? 'on' : ''}">${esc(n)}</a>`).join('') + `<a href="/loja/${S.slug}" target="_blank" rel="noopener">Ver loja ↗</a>` + (ME.isAdmin ? '<a href="/plataforma" data-link>Plataforma</a>' : ''));
  await ({ pedidos: pOrders, entregas: pDelivery, cardapio: pMenu, caixa: pCash, novo: pNewOrder, clientes: pCustomers, relatorios: pReports, config: pConfig })[tab](S, owner);
}

function billingBanner(t, owner) {
  if (!t.billing_status || t.billing_status === 'free') return '';
  const link = owner ? ' <a href="/painel/config#assinatura" data-link>Ver assinatura</a>' : ' Avise o dono da loja.';
  if (!billingOk(t)) return `<div class="banner bad">Sua loja <b>não está recebendo pedidos</b>: a assinatura está pendente.${link}</div>`;
  if (t.billing_status === 'trial') { const d = daysUntil(t.trial_ends_at); return `<div class="banner ${d <= 3 ? 'warn' : ''}">Teste grátis: ${d === 0 ? 'termina hoje' : `faltam <b>${d} dia${d > 1 ? 's' : ''}</b>`}.${owner ? ' <a href="/painel/config#assinatura" data-link>Assinar agora</a>' : ''}</div>`; }
  if (t.billing_status === 'past_due' || t.billing_status === 'canceled') return `<div class="banner warn">${t.billing_status === 'canceled' ? 'Assinatura cancelada' : 'Pagamento da assinatura com problema'}: a loja para de receber pedidos em ${daysUntil(new Date(t.paid_until || t.trial_ends_at).getTime() + 3 * 864e5)} dia(s).${link}</div>`;
  return '';
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
  // Impressão automática: 'off', 'accept' (ao aceitar) ou 'arrive' (assim que o pedido chega). Vale só para este aparelho.
  let pmode = local.get('printMode', local.get('autoPrint', false) ? 'accept' : 'off');
  const printedKey = `printed:${S.id}`;
  const printed = new Set(local.get(printedKey, []));
  const markPrinted = ids => { ids.forEach(id => printed.add(id)); local.set(printedKey, [...printed].slice(-300)); };
  const printArrivals = () => {
    if (pmode !== 'arrive') return;
    const fresh = orders.filter(o => o.status === 'novo' && !printed.has(o.id)).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    markPrinted(fresh.map(o => o.id));
    fresh.forEach((o, i) => setTimeout(() => printTicket(o, S.name), i * 1500));
  };
  const load = async () => { orders = await fetchOrders(S.id, ['novo', 'preparo', 'pronto']); draw(); printArrivals(); };
  const draw = () => {
    const cols = [['novo', 'Novos', 'Aceitar', 'preparo'], ['preparo', 'Em preparo', 'Marcar pronto', 'pronto'], ['pronto', 'Prontos', '', '']];
    const isLater = o => o.scheduled_for && o.status === 'novo' && new Date(o.scheduled_for) - Date.now() > 60 * 60000;
    const later = orders.filter(isLater).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for)), soon = orders.filter(o => !isLater(o));
    app.innerHTML = `<div class="row between"><div><h2>${esc(S.seg?.prep || 'Preparo')}</h2><p class="lead">Pedidos chegam aqui na hora, com aviso sonoro. Tickets com mais de 25 min ficam em alerta.</p></div>
      <span class="row"><label class="chk" style="gap:6px">Imprimir comanda <select id="printMode" style="width:auto;min-height:36px;padding:4px 8px">${[['off', 'só no botão'], ['accept', 'ao aceitar'], ['arrive', 'assim que chegar']].map(([v, t]) => `<option value="${v}" ${v === pmode ? 'selected' : ''}>${t}</option>`).join('')}</select></label><button class="ghost sm" id="printHelp" title="Imprimir sem abrir a janela">?</button><a class="btn ghost" href="/painel/kds" data-link>Tela da cozinha</a><a class="btn pri" href="/painel/novo" data-link>+ Novo pedido</a></span></div>
    ${later.length ? `<div class="panel sched"><h3>Agendados para mais tarde (${later.length})</h3><div class="row">${later.map(o => `<span class="badge b-a" title="${esc(o.customer_name)}">${esc(fmtWhen(o.scheduled_for, S.timezone))} · #${o.number} · ${esc(where(o))}</span>`).join('')}</div>
      <p class="mut" style="margin:0">Eles entram nas colunas 1 hora antes do horário marcado.</p></div>` : ''}
    <div class="board">${cols.map(([k, t, a, next]) => { const os = soon.filter(o => o.status === k).sort((x, y) => new Date(x.scheduled_for || x.created_at) - new Date(y.scheduled_for || y.created_at));
      return `<div class="col"><h3>${t}<span class="badge">${os.length}</span></h3>${os.map(o => `<div class="tk ${!o.scheduled_for && mins(o.created_at) > 25 ? 'late' : ''}">
        <div class="top"><span>#${o.number}</span><span class="price">${o.scheduled_for ? `<span class="badge b-a">⏰ ${hhmmTz(o.scheduled_for, S.timezone)}</span>` : `${mins(o.created_at)} min`}</span></div>
        <span class="mut">${o.fulfillment === 'table' ? `<span class="badge b-a">MESA ${esc(o.table_label)}</span> ` : ''}${o.channel && o.channel !== 'online' && o.channel !== 'mesa' ? `<span class="badge">${CHANNEL[o.channel]}</span> ` : ''}${esc(o.customer_name)} · ${esc(where(o))} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''}</span>
        ${o.payment_status === 'paid' ? '<span><span class="badge b-g">PAGO ONLINE</span></span>' : ''}
        ${itemsList(o)}<b class="price">${brl(o.total)}</b>
        <div class="row">${a ? `<button class="ok sm" data-st="${next}" data-id="${o.id}">${a}</button>` : o.fulfillment === 'delivery' ? '<span class="badge b-g">Aguardando entregador</span>' : `<button class="ok sm" data-st="entregue" data-id="${o.id}">${o.fulfillment === 'table' ? 'Servido' : 'Cliente retirou'}</button>`}
        ${k !== 'pronto' ? `<button class="ghost sm" data-st="cancelado" data-id="${o.id}">${k === 'novo' ? 'Recusar' : 'Cancelar'}</button>` : ''}
        <button class="ghost sm" data-print="${o.id}">Imprimir</button>${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)))}</div></div>`).join('') || '<p class="empty">Nada aqui</p>'}</div>`; }).join('')}</div>`;
  };
  app.onclick = attempt(async e => {
    const pr = e.target.closest('button[data-print]');
    if (pr) return printTicket(orders.find(o => o.id === +pr.dataset.print), S.name);
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
    if (b.dataset.st === 'preparo' && pmode === 'accept') printTicket(orders.find(o => o.id === +b.dataset.id), S.name);
    await load();
  });
  app.onchange = e => {
    if (e.target.id !== 'printMode') return;
    pmode = e.target.value; local.set('printMode', pmode);
    if (pmode === 'arrive') { markPrinted(orders.filter(o => o.status === 'novo').map(o => o.id)); toast('Os próximos pedidos serão impressos assim que chegarem'); }
  };
  const stop = live(S.id, p => {
    if (p?.new?.status === 'novo' && !orders.some(o => o.id === p.new.id)) { beep(); toast(`Novo pedido #${p.new.number}${p.new.payment_status === 'paid' ? ' (Pix pago)' : ''}`); }
    load().catch(() => {});
  });
  cleanup = () => { stop(); app.onclick = app.onchange = null; };
  await load();
}

async function pDelivery(S) {
  let ready = [], route = [], couriers = [];
  const load = async () => {
    [ready, route, couriers] = await Promise.all([fetchOrders(S.id, ['pronto']), fetchOrders(S.id, ['rota']), q(sb.from('couriers').select('id, tenant_id, name, phone, active').eq('tenant_id', S.id).order('id'))]);
    draw();
  };
  const draw = () => {
    const free = couriers.filter(c => c.active);
    app.innerHTML = `<h2>Entregas</h2><p class="lead">Despache os pedidos prontos e confirme quando forem entregues.</p>
    <div class="two"><div class="panel"><h3>Prontos (${ready.length})</h3>
      ${ready.map(o => `<div class="tk"><div class="top"><span>#${o.number} · ${esc(o.customer_name)}</span><span class="price">${brl(o.total)}</span></div>
        <span class="mut">${o.fulfillment === 'pickup' ? 'Retirada na loja' : o.fulfillment === 'table' ? `Mesa ${esc(o.table_label)}` : `${esc(o.address)} — ${esc(o.zone_name)}`} · ${esc(o.payment)}${o.change_for ? ` (troco p/ ${brl(o.change_for)})` : ''} · ${esc(o.customer_phone)}</span>
        ${o.fulfillment !== 'delivery' ? `<button class="ok sm" data-st="entregue" data-id="${o.id}">${o.fulfillment === 'table' ? 'Servido na mesa' : 'Cliente retirou'}</button>` : free.length ? `<span class="row" style="flex-wrap:nowrap"><select id="c${o.id}" aria-label="Entregador">${free.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="pri sm" data-st="rota" data-id="${o.id}">Despachar</button></span>` : '<span class="badge b-a">Cadastre ou ative um entregador</span>'}
        <span class="row">${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)), 'Avisar cliente')}${o.fulfillment === 'delivery' ? `<a class="btn ghost sm" href="${esc(mapsUrl(o))}" target="_blank" rel="noopener">Mapa</a>` : ''}</span></div>`).join('') || '<p class="empty">Nenhum pedido pronto</p>'}
    </div><div class="panel"><h3>Em rota (${route.length})</h3>
      ${route.map(o => `<div class="tk go"><div class="top"><span>#${o.number} · ${esc(o.courier?.name || '—')}</span><span class="price">${mins(o.updated_at)} min</span></div><span class="mut">${esc(o.address)} — ${esc(o.zone_name)} · ${esc(o.payment)}</span>
        <span class="row"><button class="ok sm" data-st="entregue" data-id="${o.id}">Confirmar entrega</button>${waBtn(waLink(couriers.find(c => c.id === o.courier_id)?.phone, courierMsg(o)), 'Enviar ao entregador')}${waBtn(waLink(o.customer_phone, customerMsg(o, S.name)), 'Avisar cliente')}</span></div>`).join('') || '<p class="empty">Ninguém na rua agora</p>'}
      <h3>Entregadores</h3><table><tbody>${couriers.map(c => `<tr><td>${esc(c.name)}<br><span class="mut">${esc(c.phone)}</span></td><td>${route.some(o => o.courier_id === c.id) ? '<span class="badge b-a">Em rota</span>' : c.active ? '<span class="badge b-g">Disponível</span>' : '<span class="badge">Folga</span>'}</td><td class="n"><button class="ghost sm" data-cour="${c.id}">${c.active ? 'Dar folga' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Cadastre entregadores em Configurações.</td></tr>'}</tbody></table>
    </div></div>`;
  };
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.st) {
      await setStatus(+b.dataset.id, b.dataset.st, b.dataset.st === 'rota' ? +$('#c' + b.dataset.id).value : null);
      if (b.dataset.st === 'rota') toast('Despachado. Use “Enviar ao entregador” para mandar o endereço pelo WhatsApp.');
    }
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
    app.innerHTML = `<div class="row between"><div><h2>Cardápio</h2><p class="lead">${owner ? 'Crie produtos com grupos de opções: tamanhos, sabores, adicionais, combos.' : 'Marque itens esgotados ou ajuste o estoque.'} Estoque em branco = sem controle; com número, baixa a cada pedido e volta se o pedido for cancelado.</p></div>${owner ? '<button class="pri" id="newP">Novo produto</button>' : ''}</div>
    ${cats.map(c => `<div class="panel" style="margin-bottom:16px"><h3>${esc(c)}</h3><div class="scroll"><table class="stack"><thead><tr><th>Produto</th><th>Opções</th><th class="n">Preço</th><th>Estoque</th><th>Disponível</th><th></th></tr></thead><tbody>
      ${prods.filter(p => p.category === c).map(p => `<tr><td data-l="Produto"><span class="row" style="flex-wrap:nowrap"><span class="thumb">${picture(p, S.color)}</span><span><b>${esc(p.name)}</b><br><span class="mut">${esc(p.description)}</span></span></span></td>
        <td data-l="Opções"><span class="mut">${p.groups.map(g => `${esc(g.name)} (${g.options.length})`).join(', ') || '—'}</span></td><td data-l="Preço" class="n price">${brl(p.price)}</td>
        <td data-l="Estoque"><input class="stockin" type="number" min="0" inputmode="numeric" data-stock="${p.id}" value="${p.stock ?? ''}" placeholder="sem controle" aria-label="Estoque de ${esc(p.name)}">${p.stock === 0 ? ' <span class="badge b-r">zerado</span>' : ''}</td>
        <td data-l="Disponível"><button class="sm ${p.available ? 'ok' : 'ghost'}" data-av="${p.id}">${p.available ? 'Sim' : 'Esgotado'}</button></td>
        <td data-l="">${owner ? `<button class="ghost sm" data-ed="${p.id}">Editar</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<p class="empty">Nenhum produto ainda.</p>'}`;
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
  app.onclick = attempt(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'newP') editor(null);
    if (b.dataset.ed) editor(prods.find(p => p.id === +b.dataset.ed));
    if (b.dataset.av) { const p = prods.find(x => x.id === +b.dataset.av); await rpc('set_product_availability', { p_product: p.id, p_available: !p.available }); await load(); }
  });
  app.onchange = attempt(async e => {
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
  let orders = [], sound = local.get('kdsSound', true);
  const age = o => mins(o.scheduled_for && new Date(o.scheduled_for) < new Date() ? o.scheduled_for : o.created_at);
  const tone = (o, k) => k === 'pronto' ? 'ok' : age(o) >= 20 ? 'bad' : age(o) >= 10 ? 'warn' : 'ok';
  const load = async () => { orders = await fetchOrders(S.id, ['novo', 'preparo', 'pronto']); draw(); };
  const draw = () => {
    const later = o => o.scheduled_for && o.status === 'novo' && new Date(o.scheduled_for) - Date.now() > 60 * 60000;
    const cols = [['novo', 'Novos'], ['preparo', 'Em preparo'], ['pronto', 'Prontos']];
    const act = (o, k) => k === 'novo' ? ['preparo', 'Começar'] : k === 'preparo' ? ['pronto', 'Pronto'] : o.fulfillment === 'delivery' ? null : ['entregue', o.fulfillment === 'table' ? 'Servido' : 'Retirado'];
    app.innerHTML = `<div class="kds"><div class="kbar"><b>${esc(S.name)}</b><span class="kclock">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="row"><button id="kSound">${sound ? 'Som ligado' : 'Som desligado'}</button><button id="kFull">Tela cheia</button><a class="btn" href="/painel" data-link>Sair</a></span></div>
      <div class="kcols">${cols.map(([k, t]) => { const os = orders.filter(o => o.status === k && !later(o)).sort((a, b) => new Date(a.scheduled_for || a.created_at) - new Date(b.scheduled_for || b.created_at));
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
    if (b.dataset.st) { b.disabled = true; await setStatus(+b.dataset.id, b.dataset.st); if (b.dataset.st === 'preparo' && local.get('autoPrint', false)) printTicket(orders.find(o => o.id === +b.dataset.id), S.name); await load(); }
  });
  const stop = live(S.id, p => { if (p?.new?.status === 'novo' && !orders.some(o => o.id === p.new.id) && sound) beep(); load().catch(() => {}); });
  const tick = setInterval(draw, 20000);
  // mantém a tela acesa em tablets/TVs que suportam
  let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  cleanup = () => { stop(); clearInterval(tick); app.onclick = null; document.body.classList.remove('kds-on'); lock?.release?.().catch(() => {}); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  await load();
}

/* ---------- lançar pedido (balcão, telefone, mesa) ---------- */
async function pNewOrder(S) {
  const [rawP, zones] = await Promise.all([
    q(sb.from('products').select(MENU_COLS).eq('tenant_id', S.id).eq('available', true)),
    q(sb.from('zones').select('id, name, fee').eq('tenant_id', S.id).order('name'))]);
  const products = sortMenu(rawP), DIST = S.delivery_mode === 'distance';
  let cart = [], st = { channel: 'balcao', ful: 'pickup', table: '1', name: '', phone: '', zone: zones[0]?.id || null, cep: '', rua: '', num: '', comp: '', pay: 'Pagar no caixa', change: '', term: '' }, geo = null, cepInfo = null;
  const sub = () => cart.reduce((t, c) => t + c.qty * c.unit, 0);
  const fee = () => st.ful !== 'delivery' ? 0 : DIST ? (geo?.quote?.fee || 0) : (zones.find(z => z.id === +st.zone)?.fee || 0);
  const read = () => { for (const k of ['name', 'phone', 'table', 'zone', 'cep', 'rua', 'num', 'comp', 'pay', 'change', 'term']) { const el = $('#n_' + k); if (el) st[k] = el.value; } };
  const draw = () => {
    const list = products.filter(p => !st.term || (p.name + ' ' + p.category).toLowerCase().includes(st.term.toLowerCase()));
    const cats = [...new Set(list.map(p => p.category))];
    app.innerHTML = `<div class="row between"><div><h2>Novo pedido</h2><p class="lead">Lance pedidos do balcão, do telefone ou da mesa. Eles entram direto em preparo.</p></div><a class="btn ghost" href="/painel" data-link>Voltar</a></div>
    <div class="shop"><section class="panel">
      <input id="n_term" type="search" placeholder="Buscar produto" value="${esc(st.term)}">
      ${cats.map(c => `<h3>${esc(c)}</h3><div class="plist">${list.filter(p => p.category === c).map(p => `<button class="pbtn" data-p="${p.id}" ${p.stock === 0 ? 'disabled' : ''}><span>${esc(p.name)}${p.stock != null ? `<br><small class="mut">${p.stock === 0 ? 'esgotado' : `estoque: ${p.stock}`}</small>` : ''}</span><span class="price">${brl(p.price)}${p.groups.length ? ' +' : ''}</span></button>`).join('')}</div>`).join('') || '<p class="empty">Nenhum produto.</p>'}
    </section>
    <aside class="cart"><h3>Pedido</h3>
      <div class="segs" style="grid-template-columns:repeat(3,minmax(0,1fr))">${['balcao', 'telefone', ...(S.allow_tables ? ['mesa'] : [])].map(c => `<button type="button" data-ch="${c}" class="${st.channel === c ? 'on' : ''}" style="min-height:44px">${CHANNEL[c]}</button>`).join('')}</div>
      ${st.channel === 'mesa' ? `<label>Mesa<select id="n_table">${Array.from({ length: S.tables_count || 10 }, (_, i) => `<option ${String(i + 1) === st.table ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>` : ''}
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
        if (local.get('autoPrint', false)) { const o = (await q(sb.from('orders').select(ORDER_COLS).eq('id', r.id)))[0]; if (o) printTicket(o, S.name); }
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
  const draw = async () => {
    r = await rpc('cash_report', { p_tenant: S.id, p_day: day });
    app.innerHTML = `<div class="row between"><div><h2>Caixa</h2><p class="lead">Fechamento do dia: confira os valores por forma de pagamento com a maquininha e a gaveta.</p></div>
      <span class="row"><input type="date" id="cDay" value="${day}" max="${today}" style="width:auto"><button class="pri" id="cPrint">Imprimir fechamento</button></span></div>
    <div class="kpis"><div class="kpi"><span class="mut">Total do dia</span><b class="price">${brl(r.total)}</b><span class="mut">${r.orders} pedido(s)</span></div>
      <div class="kpi"><span class="mut">Taxas de entrega</span><b class="price">${brl(r.fees)}</b></div>
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
      <div class="li"><span>Subtotal</span><span>${brl(r.subtotal)}</span></div><div class="li"><span>Taxas de entrega</span><span>${brl(r.fees)}</span></div>
      <div class="li"><span>Descontos</span><span>-${brl(r.discounts)}</span></div><div class="li big"><b>TOTAL (${r.orders})</b><b>${brl(r.total)}</b></div><hr>
      ${r.byChannel.map(x => `<div class="li"><span>${CHANNEL[x.channel] || x.channel} (${x.count})</span><span>${brl(x.total)}</span></div>`).join('')}
      <div class="li"><span>Cancelados (${r.cancelled.count})</span><span>${brl(r.cancelled.total)}</span></div>
      ${r.paidOnline ? `<div class="li"><span>Recebido online</span><span>${brl(r.paidOnline)}</span></div>` : ''}<hr><div>Conferido por: ____________________</div></div>`;
    window.print();
  };
  app.onclick = attempt(async e => { if (e.target.closest('#cPrint')) printCash(); });
  app.onchange = attempt(async e => { if (e.target.id === 'cDay' && e.target.value) { day = e.target.value; await draw(); } });
  cleanup = () => { app.onclick = app.onchange = null; };
  await draw();
}

/* ---------- clientes ---------- */
async function pCustomers(S) {
  let list = [], term = '', gone = 0; // gone = dias sem pedir (0 = todos os clientes)
  const camp = local.get(`camp:${S.id}`, { msg: 'Olá, {nome}! Aqui é da {loja}. Sentimos sua falta! 😊{cupom}\nPeça por aqui: {link}', coupon: '' });
  const sent = local.get(`sent:${S.id}`, {}); // telefone → data em que a mensagem da campanha foi aberta
  const coupons = await q(sb.from('coupons').select('code, percent, free_shipping, active').eq('tenant_id', S.id).eq('active', true).order('id')).catch(() => []);
  const cupTxt = c => c ? `\nUse o cupom *${c.code}*: ${[c.percent ? `${c.percent}% de desconto` : '', c.free_shipping ? 'entrega grátis' : ''].filter(Boolean).join(' e ')}.` : '';
  const msgFor = c => camp.msg.replaceAll('{nome}', c.name.split(' ')[0]).replaceAll('{loja}', S.name)
    .replaceAll('{cupom}', cupTxt(coupons.find(x => x.code === camp.coupon))).replaceAll('{link}', `${location.origin}/loja/${S.slug}?repetir=1`);
  const saveCamp = () => local.set(`camp:${S.id}`, camp);
  const load = async () => { list = await rpc('store_customers', { p_tenant: S.id, p_search: term || null, p_limit: gone ? 1000 : 200 }); draw(); };
  const shown = () => gone ? list.filter(c => mins(c.lastOrder) > gone * 1440 && c.orders > 0) : list;
  const draw = () => {
    const box = $('#custList'), rows = shown();
    const html = `${gone ? `<p class="mut" style="margin:0 0 8px">${rows.length} cliente(s) sem pedir há mais de ${gone} dias · ${rows.filter(c => sent[c.phone]).length} já contatado(s)</p>` : ''}
      <div class="scroll"><table class="stack"><thead><tr><th>Cliente</th><th class="n">Pedidos</th><th class="n">Total gasto</th><th>Último pedido</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td data-l="Cliente"><b>${esc(c.name)}</b><br><span class="mut">${esc(c.phone)}${c.address ? ' · ' + esc(c.address) : ''}</span></td>
        <td data-l="Pedidos" class="n">${c.orders}${S.loyalty_enabled && c.stamps != null ? `<br><span class="mut">${Math.min(c.stamps, S.loyalty_every)}/${S.loyalty_every} selos</span>` : ''}</td><td data-l="Total gasto" class="n price">${brl(c.spent)}</td>
        <td data-l="Último pedido">${new Date(c.lastOrder).toLocaleDateString('pt-BR')}${mins(c.lastOrder) > 30 * 1440 ? ` <span class="badge b-a">sumido há ${Math.floor(mins(c.lastOrder) / 1440)} dias</span>` : ''}</td>
        <td data-l=""><span class="row">${gone
          ? (waLink(c.phone, '') ? `<a class="btn ${sent[c.phone] ? 'ghost' : 'pri'} sm" data-send="${esc(c.phone)}" href="${esc(waLink(c.phone, msgFor(c)))}" target="_blank" rel="noopener">${sent[c.phone] ? `Enviado em ${new Date(sent[c.phone]).toLocaleDateString('pt-BR')} · reenviar` : 'Enviar no WhatsApp'}</a>` : '<span class="mut">telefone inválido</span>')
          : `${waBtn(waLink(c.phone, `Olá, ${c.name.split(' ')[0]}! Aqui é da ${S.name}.`))}<button class="ghost sm" data-anon="${esc(c.phone)}">Excluir dados</button>`}</span></td></tr>`).join('') || `<tr><td class="mut">${gone ? 'Nenhum cliente sumido. Ótimo sinal!' : 'Nenhum cliente encontrado.'}</td></tr>`}</tbody></table></div>`;
    if (box) { box.innerHTML = html; return; }
    app.innerHTML = `<div class="row between"><div><h2>Clientes</h2><p class="lead">Quem já pediu na sua loja, montado a partir dos pedidos.</p></div>
      <span class="row"><button class="ghost" id="csv">Baixar planilha (CSV)</button></span></div>
      <div class="row" style="margin-bottom:12px">${[[0, 'Todos'], [30, 'Sumidos há 30+ dias'], [60, '60+ dias'], [90, '90+ dias']].map(([d, t]) => `<button class="sm ${d === gone ? 'pri' : 'ghost'}" data-gone="${d}">${t}</button>`).join('')}</div>
      ${gone ? `<div class="panel" style="margin-bottom:16px"><h3>Campanha "volte a pedir"</h3>
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
    if (b.dataset.gone != null) { const was = gone; gone = +b.dataset.gone; app.innerHTML = ''; if (!was !== !gone) await load(); else draw(); return; }
    if (b.dataset.anon) { if (!sure(b)) return; const n = await rpc('anonymize_customer', { p_tenant: S.id, p_phone: b.dataset.anon }); toast(`Dados removidos de ${n} pedido(s)`); await load(); }
    if (b.id === 'csv') {
      const rows = [['Nome', 'Telefone', 'Endereço', 'Pedidos', 'Total gasto', 'Primeiro pedido', 'Último pedido'],
        ...shown().map(c => [c.name, c.phone, c.address || '', c.orders, fromCents(c.spent), new Date(c.firstOrder).toLocaleDateString('pt-BR'), new Date(c.lastOrder).toLocaleDateString('pt-BR')])];
      const csv = '\ufeff' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `clientes-${S.slug}.csv`; a.click(); URL.revokeObjectURL(a.href);
    }
  });
  cleanup = () => { app.oninput = app.onclick = app.onchange = null; clearTimeout(tmr); };
  await load();
}

/* ---------- relatórios ---------- */
async function pReports(S) {
  let days = 7;
  const draw = async () => {
    const [r, rv] = await Promise.all([rpc('store_report', { p_tenant: S.id, p_days: days }),
      q(sb.from('order_reviews').select('order_id, rating, comment, reply, created_at, order:orders(number, customer_name)').eq('tenant_id', S.id).order('created_at', { ascending: false }).limit(30)).catch(() => [])]);
    const bars = (rows, label, val, fmt, color) => { const m = Math.max(1, ...rows.map(val)); return rows.map(x => `<div class="bar"><span>${esc(label(x))}</span><i style="width:${val(x) / m * 100}%;${color ? `background:${color}` : ''}"></i><span class="price">${fmt(x)}</span></div>`).join('') || '<p class="empty">Sem dados no período</p>'; };
    app.innerHTML = `<div class="row between"><div><h2>Relatórios</h2><p class="lead">Pedidos não cancelados no período escolhido.</p></div>
      <span class="row">${[1, 7, 30, 90].map(d => `<button class="sm ${d === days ? 'pri' : 'ghost'}" data-days="${d}">${d === 1 ? 'Hoje' : d + ' dias'}</button>`).join('')}</span></div>
    <div class="kpis"><div class="kpi"><span class="mut">Faturamento</span><b class="price">${brl(r.revenue)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${r.orders}</b><span class="mut">${r.cancelled} cancelado(s)</span></div>
      <div class="kpi"><span class="mut">Ticket médio</span><b class="price">${brl(r.avgTicket)}</b></div><div class="kpi"><span class="mut">Tempo médio até entregar</span><b>${r.avgDeliveryMin ?? '—'}${r.avgDeliveryMin != null ? ' min' : ''}</b></div></div>
    <div class="two"><div class="panel"><h3>Faturamento por dia</h3><div class="bars">${bars(r.byDay, x => x.d.split('-').reverse().slice(0, 2).join('/'), x => x.revenue, x => brl(x.revenue))}</div></div>
      <div class="panel"><h3>Pedidos por horário</h3><div class="bars">${bars(r.byHour, x => String(x.h).padStart(2, '0') + 'h', x => x.orders, x => x.orders + ' ped.')}</div></div>
      <div class="panel"><h3>Mais vendidos</h3><div class="bars">${bars(r.top, x => x.name, x => x.qty, x => x.qty + ' un.', 'var(--basil)')}</div></div>
      <div class="panel"><h3>Formas de pagamento</h3><div class="bars">${bars(r.payments, x => x.payment, x => x.revenue, x => brl(x.revenue), 'var(--basil)')}</div>
        <h3>Entregadores</h3><table><thead><tr><th>Nome</th><th class="n">Entregas</th><th class="n">Taxas a repassar</th></tr></thead><tbody>${r.couriers.map(c => `<tr><td>${esc(c.name)}</td><td class="n">${c.deliveries}</td><td class="n price">${brl(c.fees)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel" style="margin-top:20px"><h3>Avaliações dos clientes ${rv.length ? `· ★ ${(rv.reduce((a, x) => a + x.rating, 0) / rv.length).toFixed(1).replace('.', ',')} (${rv.length} recentes)` : ''}</h3>
      ${rv.map(x => `<div class="rv"><div class="row between"><span><b>#${x.order?.number}</b> · ${esc(x.order?.customer_name || '')}</span><span class="stars">${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)}</span></div>
        ${x.comment ? `<p style="margin:0">${esc(x.comment)}</p>` : ''}
        <form class="row" data-reply="${x.order_id}" style="flex-wrap:nowrap"><input name="reply" maxlength="500" placeholder="Responder publicamente" value="${esc(x.reply || '')}"><button class="ghost sm">${x.reply ? 'Atualizar' : 'Responder'}</button></form>
        <span class="mut" style="font-size:13px">${new Date(x.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span></div>`).join('') || '<p class="mut" style="margin:0">Nenhuma avaliação ainda. Depois da entrega, o cliente pode avaliar pela página do pedido.</p>'}</div>`;
  };
  app.onclick = attempt(async e => { const b = e.target.closest('button[data-days]'); if (b) { days = +b.dataset.days; await draw(); } });
  app.onsubmit = attempt(async e => { const f = e.target.closest('form[data-reply]'); if (!f) return; e.preventDefault(); await rpc('reply_review', { p_order: +f.dataset.reply, p_reply: f.reply.value }); toast('Resposta salva'); await draw(); });
  cleanup = () => { app.onclick = app.onsubmit = null; };
  await draw();
}

/* ---------- configurações ---------- */
async function pConfig(S) {
  const plans = await q(sb.from('plans').select('*').order('sort'));
  let couriers = [], st0 = null;
  const draw = async () => {
    let st, zones, coupons, team, nOrders, pix, bill, usage, promos, prodList;
    [st, zones, coupons, couriers, team, nOrders, pix, bill, usage, promos, prodList] = await Promise.all([
      q(sb.from('tenants').select('*').eq('id', S.id).single()), q(sb.from('zones').select('*').eq('tenant_id', S.id).order('id')),
      q(sb.from('coupons').select('*').eq('tenant_id', S.id).order('id')), q(sb.from('couriers').select('id, tenant_id, name, phone, active').eq('tenant_id', S.id).order('id')),
      rpc('list_team', { p_tenant: S.id }), sb.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', S.id).then(r => r.count || 0),
      rpc('pix_settings', { p_tenant: S.id }).catch(() => null), rpc('billing_info', { p_tenant: S.id }).catch(() => null), rpc('coupon_usage', { p_tenant: S.id }).catch(() => ({})),
      q(sb.from('promotions').select('*').eq('tenant_id', S.id).order('id')).catch(() => []), q(sb.from('products').select('id, name, category').eq('tenant_id', S.id).order('sort'))]);
    const prodById = Object.fromEntries(prodList.map(p => [p.id, p]));
    st0 = st;
    const link = `${location.origin}/loja/${st.slug}`;
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
    <form class="panel" id="fShow"><h3>Vitrine da loja</h3>
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
      <span class="row"><label>Quantidade de mesas<input id="mCount" type="number" min="1" max="200" value="${st.tables_count ?? 10}" style="width:120px"></label><button type="button" class="ghost" id="mPrint" ${st.allow_tables ? '' : 'disabled'}>Imprimir QR Codes das mesas</button></span>
      <p class="mut" style="margin:0">Cada mesa recebe um QR Code. O cliente escaneia, faz o pedido pelo celular e paga no caixa (ou por Pix, se ativo). O pedido chega na cozinha marcado com o número da mesa.</p>
      <h3>Programa de fidelidade</h3>
      <label class="chk"><input type="checkbox" id="lOn" ${st.loyalty_enabled ? 'checked' : ''}> Dar desconto para clientes fiéis</label>
      <div class="two" style="gap:10px"><label>A cada (pedidos entregues)<input id="lEvery" type="number" min="2" max="50" value="${st.loyalty_every ?? 10}"></label><label>Desconto no pedido seguinte (%)<input id="lPct" type="number" min="1" max="50" value="${st.loyalty_percent ?? 10}"></label></div>
      <p class="mut" style="margin:0">O cliente é reconhecido pelo telefone. O desconto entra sozinho no pedido seguinte e não soma com cupom (vale o maior). Ele acompanha os selos na página do pedido.</p>
      <button class="pri">Salvar entrega e fidelidade</button></form>
    <div class="panel"><h3>Bairros e taxas</h3><table><tbody>${zones.map(z => `<tr><td>${esc(z.name)}</td><td class="n" style="width:120px"><input inputmode="decimal" value="${fromCents(z.fee)}" data-zone="${z.id}" aria-label="Taxa ${esc(z.name)}"></td><td class="n"><button class="ghost sm" data-del="zones:${z.id}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody></table>
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
    <form class="panel" id="fPix"><h3>Pix online (Mercado Pago)</h3>
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
      <button class="pri" ${pix ? '' : 'disabled'}>Salvar Pix</button></form>
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
  };
  const refreshBrand = async () => { await loadMe(); setColor(ME.tenant.color); $('#bName').textContent = ME.tenant.name; };
  app.onclick = attempt(async e => {
    // botões de envio de formulário são tratados no onsubmit; os demais (fora de formulários) aqui
    const b = e.target.closest('button'); if (!b || (b.type === 'submit' && b.closest('form'))) return;
    if (b.id === 'shRm') { await q(sb.from('tenants').update({ banner_path: null }).eq('id', S.id)); if (st0?.banner_path) sb.storage.from(BUCKET).remove([st0.banner_path]).catch(() => {}); toast('Banner removido'); return draw(); }
    if (b.id === 'mPrint') { await printTableQrs(S.slug, Math.max(1, Math.min(200, +$('#mCount').value || 10)), S.name); return; }
    if (b.id === 'dLoc') {
      const info = await lookupCep($('#dCep').value);
      if (!info) throw new Error('CEP não encontrado');
      const pos = await locateAddress({ street: info.street, number: $('#dNum').value.trim(), city: info.city, state: info.state, cep: $('#dCep').value }, info);
      if (!pos) throw new Error('Não encontramos no mapa. Cole as coordenadas do Google Maps.');
      $('#dCoord').value = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`; toast('Localização encontrada. Confira em "Ver no mapa" depois de salvar.'); return;
    }
    if (b.id === 'copyMon') { for (let i = 0; i < 7; i++) for (const k of 'abcd') $(`#h${i}${k}`).value = $(`#h1${k}`).value; return; }
    if (b.id === 'copy') { try { await navigator.clipboard.writeText(`${location.origin}/loja/${S.slug}`); toast('Link copiado'); } catch { toast('Copie o link manualmente'); } return; }
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
    if (e.target.id === 'shBanner' && e.target.files[0]) {
      toast('Enviando banner…');
      const blob = await shrinkImage(e.target.files[0], 1600);
      const path = `${S.id}/banner-${crypto.randomUUID()}.jpg`;
      await q(sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }));
      await q(sb.from('tenants').update({ banner_path: path }).eq('id', S.id));
      if (st0?.banner_path) sb.storage.from(BUCKET).remove([st0.banner_path]).catch(() => {});
      toast('Banner atualizado'); return draw();
    }
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
        allow_tables: $('#mOn').checked, tables_count: Math.max(1, Math.min(200, +$('#mCount').value || 10)) }).eq('id', S.id));
      await refreshBrand();
    }
    if (id === 'fPix') { await rpc('set_pix_settings', { p_tenant: S.id, p_token: $('#pxTok').value.trim() || null, p_enabled: $('#pxOn').checked }); }
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
async function vPlatform() {
  setColor('#1d1716'); $('#bName').textContent = 'Balcão';
  header('<a class="on" href="/plataforma" data-link>Plataforma</a>' + (ME.tenant ? '<a href="/painel" data-link>Minha loja</a>' : ''));
  const plans = await q(sb.from('plans').select('name').order('sort'));
  const draw = async () => {
    const [o, sch] = await Promise.all([rpc('platform_overview'), rpc('schema_status').catch(() => null)]);
    const missing = sch ? sch.filter(m => !m.ok) : null;
    const dbBox = !missing ? `<div class="banner warn" style="margin-bottom:16px;text-align:left;border:1px solid var(--line);border-radius:12px"><b>Não consegui conferir o banco.</b> Rode no SQL Editor do Supabase a migração <code>20261123000000_checagem.sql</code> (e as anteriores que faltarem). Depois recarregue esta página.</div>`
      : missing.length ? `<div class="banner warn" style="margin-bottom:16px;text-align:left;border:1px solid var(--line);border-radius:12px"><b>Faltam ${missing.length} migraç${missing.length > 1 ? 'ões' : 'ão'} no banco.</b> Rode no SQL Editor do Supabase, nesta ordem, cada uma numa consulta nova:<ol style="margin:6px 0 0">${missing.map(m => `<li><code>${esc(m.file)}</code></li>`).join('')}</ol>Os arquivos estão na pasta <code>supabase/migrations</code> do GitHub. Enquanto faltarem, algumas telas mostram erro.</div>`
      : `<p class="mut" style="margin:-8px 0 16px">✓ Banco de dados em dia (${sch.length} migrações).</p>`;
    app.innerHTML = `<h2>Plataforma</h2><p class="lead">Todas as empresas assinantes. Novas empresas se cadastram sozinhas em <a href="/entrar/cadastro" data-link>/entrar/cadastro</a>.</p>
    ${dbBox}
    <div class="kpis"><div class="kpi"><span class="mut">Empresas</span><b>${o.tenants.length}</b><span class="mut">${o.paying ?? 0} pagando · ${o.trials ?? 0} em teste</span></div><div class="kpi"><span class="mut">Receita mensal (MRR)</span><b class="price">${brl(o.mrr)}</b><span class="mut">+ ${brl(o.potentialMrr || 0)} se os testes virarem assinatura</span></div>
      <div class="kpi"><span class="mut">Vendido pelas lojas</span><b class="price">${brl(o.gmv)}</b></div><div class="kpi"><span class="mut">Pedidos</span><b>${o.orders}</b></div></div>
    <div class="panel"><h3>Empresas</h3><div class="scroll"><table class="stack"><thead><tr><th>Empresa</th><th>Segmento</th><th>Dono</th><th>Plano</th><th>Assinatura</th><th class="n">Pedidos</th><th class="n">Vendas</th><th></th></tr></thead><tbody>
      ${o.tenants.map(t => `<tr><td data-l="Empresa"><span class="dot" style="background:${esc(t.color)}"></span><a href="/loja/${esc(t.slug)}" target="_blank" rel="noopener">${esc(t.name)}</a> ${t.active ? '' : '<span class="badge b-r">Suspensa</span>'}</td><td data-l="Segmento">${esc(t.segmentName)}</td><td data-l="Dono"><span class="mut">${esc(t.ownerEmail || '—')}</span></td>
        <td data-l="Plano"><select data-plan="${t.id}" aria-label="Plano">${plans.map(p => `<option ${p.name === t.plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>
        <td data-l="Assinatura">${billLabel(t)}<span class="row" style="margin-top:4px"><button class="ghost sm" data-bill="${t.id}" data-st="active" data-days="30">+30 dias</button><button class="ghost sm" data-bill="${t.id}" data-st="trial" data-days="7">+7 dias teste</button>${t.billingStatus === 'free' ? '' : `<button class="ghost sm" data-bill="${t.id}" data-st="free">Grátis</button>`}</span></td>
        <td data-l="Pedidos" class="n">${t.orders}</td><td data-l="Vendas" class="n price">${brl(t.revenue)}</td><td data-l=""><button class="ghost sm" data-act="${t.id}" data-on="${t.active ? 1 : 0}">${t.active ? 'Suspender' : 'Reativar'}</button></td></tr>`).join('') || '<tr><td class="mut">Nenhuma empresa ainda.</td></tr>'}</tbody></table></div></div>`;
  };
  app.onclick = attempt(async e => {
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
