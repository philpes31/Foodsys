// Servidor HTTP: API REST + eventos em tempo real (SSE) + arquivos do frontend. Sem dependências externas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';
import { SEGMENTS, PLANS } from './templates.js';
import * as S from './service.js';

const { HttpError } = S;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

export function createApp({ db, secret }) {
  const routes = [];
  const add = (method, pattern, auth, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, auth, handler });
  };
  const sse = new Map(); // tenantId -> Set<res>
  const emit = (tid, type, data) => {
    for (const res of sse.get(tid) || []) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const loginHits = new Map();

  /* ---------- autenticação ---------- */
  function userFromReq(req, url) {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    const p = verifyToken(tok, secret);
    if (!p) return null;
    return db.prepare('SELECT id,tenant_id,name,email,role FROM users WHERE id=?').get(p.uid) || null;
  }
  const can = (user, auth) => {
    if (auth === 'public') return true;
    if (!user) return false;
    if (auth === 'platform') return user.role === 'platform';
    if (auth === 'owner') return user.role === 'owner';
    if (auth === 'staff') return user.role === 'owner' || user.role === 'staff';
    return false;
  };
  const num = v => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, 'ID inválido'); return n; };
  const own = (table, id, tid) => {
    const r = db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(num(id), tid);
    if (!r) throw new HttpError(404, 'Registro não encontrado');
    return r;
  };

  /* ---------- rotas públicas ---------- */
  add('GET', '/api/meta', 'public', () => ({
    segments: Object.fromEntries(Object.entries(SEGMENTS).map(([k, v]) => [k, { name: v.name, color: v.color, prep: v.prep, icon: v.icon }])),
    plans: PLANS
  }));

  add('POST', '/api/auth/login', 'public', ({ body, req }) => {
    const ip = req.socket.remoteAddress || '';
    const hits = (loginHits.get(ip) || []).filter(t => t > Date.now() - 60000);
    if (hits.length >= 10) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
    loginHits.set(ip, [...hits, Date.now()]);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email || '').trim());
    if (!u || !verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'E-mail ou senha incorretos');
    if (u.tenant_id && !S.getTenant(db, u.tenant_id).active) throw new HttpError(403, 'Empresa suspensa. Fale com o suporte.');
    return { token: signToken({ uid: u.id }, secret), user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  });

  add('GET', '/api/me', 'staff|platform', ({ user }) => ({
    user, store: user.tenant_id ? S.publicTenant(S.getTenant(db, user.tenant_id)) : null
  }));

  const storeOr404 = slug => {
    const t = S.getTenantBySlug(db, slug);
    if (!t || !t.active) throw new HttpError(404, 'Loja não encontrada');
    return t;
  };
  add('GET', '/api/public/stores/:slug', 'public', ({ params }) => {
    const t = storeOr404(params.slug);
    return { store: S.publicTenant(t), products: S.listProducts(db, t.id, { onlyAvailable: true }), zones: db.prepare('SELECT id,name,fee FROM zones WHERE tenant_id=? ORDER BY name').all(t.id) };
  });
  add('POST', '/api/public/stores/:slug/coupon', 'public', ({ params, body }) => {
    const t = storeOr404(params.slug);
    const c = db.prepare('SELECT code,percent,free_shipping FROM coupons WHERE tenant_id=? AND code=? AND active=1').get(t.id, String(body.code || '').trim().toUpperCase());
    if (!c) throw new HttpError(404, 'Cupom inválido');
    return { code: c.code, percent: c.percent, freeShipping: !!c.free_shipping };
  });
  add('POST', '/api/public/stores/:slug/orders', 'public', ({ params, body }) => {
    const t = storeOr404(params.slug);
    const o = S.placeOrder(db, t, body);
    emit(t.id, 'order', o);
    return { code: o.public_code, number: o.number, total: o.total };
  });
  add('GET', '/api/public/orders/:code', 'public', ({ params }) => {
    const r = db.prepare('SELECT id, tenant_id FROM orders WHERE public_code=?').get(params.code);
    if (!r) throw new HttpError(404, 'Pedido não encontrado');
    const o = S.getOrder(db, r.tenant_id, r.id), t = S.getTenant(db, r.tenant_id);
    return { store: S.publicTenant(t), order: { number: o.number, status: o.status, fulfillment: o.fulfillment, customerName: o.customer_name.split(' ')[0],
      address: o.address, zone: o.zone_name, payment: o.payment, items: o.items, subtotal: o.subtotal, fee: o.fee, discount: o.discount, total: o.total,
      coupon: o.coupon_code, courier: o.status === 'rota' ? o.courier_name : null, events: o.events } };
  });

  /* ---------- empresa (dono e equipe) ---------- */
  add('GET', '/api/store', 'staff', ({ user }) => S.publicTenant(S.getTenant(db, user.tenant_id)));
  add('PUT', '/api/store', 'owner', ({ user, body }) => S.updateTenant(db, user.tenant_id, body));
  add('PUT', '/api/store/plan', 'owner', ({ user, body }) => {
    if (!PLANS[body.plan]) throw new HttpError(400, 'Plano inválido');
    db.prepare('UPDATE tenants SET plan=? WHERE id=?').run(body.plan, user.tenant_id);
    return S.publicTenant(S.getTenant(db, user.tenant_id));
  });

  add('GET', '/api/products', 'staff', ({ user }) => S.listProducts(db, user.tenant_id));
  add('POST', '/api/products', 'owner', ({ user, body }) => ({ id: S.saveProduct(db, user.tenant_id, null, body) }));
  add('PUT', '/api/products/:id', 'owner', ({ user, body, params }) => ({ id: S.saveProduct(db, user.tenant_id, num(params.id), body) }));
  add('PATCH', '/api/products/:id/availability', 'staff', ({ user, body, params }) => {
    own('products', params.id, user.tenant_id);
    db.prepare('UPDATE products SET available=? WHERE id=?').run(body.available ? 1 : 0, num(params.id));
    return { ok: true };
  });
  add('DELETE', '/api/products/:id', 'owner', ({ user, params }) => {
    own('products', params.id, user.tenant_id);
    db.prepare('DELETE FROM products WHERE id=?').run(num(params.id));
    return { ok: true };
  });

  // CRUD simples para bairros, cupons e entregadores
  const simple = (name, table, fields, staffWrite = false) => {
    add('GET', `/api/${name}`, 'staff', ({ user }) => db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY id`).all(user.tenant_id));
    const clean = (b, cur = {}) => {
      const v = {};
      for (const [f, type] of Object.entries(fields)) {
        const x = b[f] === undefined ? cur[f] : b[f];
        if (type === 'text') { v[f] = String(x ?? '').trim().slice(0, 60); if (f === 'name' || f === 'code') { if (!v[f]) throw new HttpError(400, `Campo ${f} obrigatório`); } }
        if (type === 'upper') { v[f] = String(x ?? '').trim().toUpperCase().replace(/\s/g, '').slice(0, 20); if (!v[f]) throw new HttpError(400, 'Código obrigatório'); }
        if (type === 'int') { const n = x ?? 0; if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Valor inválido em ${f}`); v[f] = n; }
        if (type === 'pct') { const n = x ?? 0; if (!Number.isInteger(n) || n < 0 || n > 90) throw new HttpError(400, 'Percentual deve ser de 0 a 90'); v[f] = n; }
        if (type === 'bool') v[f] = x === undefined ? 1 : x ? 1 : 0;
      }
      return v;
    };
    const wrap = fn => args => { try { return fn(args); } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Já existe um registro com esse código'); throw e; } };
    add('POST', `/api/${name}`, 'owner', wrap(({ user, body }) => {
      const v = clean(body);
      const r = db.prepare(`INSERT INTO ${table} (tenant_id,${Object.keys(v)}) VALUES (?,${Object.keys(v).map(() => '?')})`).run(user.tenant_id, ...Object.values(v));
      return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid);
    }));
    add('PUT', `/api/${name}/:id`, staffWrite ? 'staff' : 'owner', wrap(({ user, body, params }) => {
      const cur = own(table, params.id, user.tenant_id), v = clean(body, cur);
      db.prepare(`UPDATE ${table} SET ${Object.keys(v).map(k => `${k}=?`)} WHERE id=?`).run(...Object.values(v), cur.id);
      return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(cur.id);
    }));
    add('DELETE', `/api/${name}/:id`, 'owner', ({ user, params }) => {
      const cur = own(table, params.id, user.tenant_id);
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(cur.id);
      return { ok: true };
    });
  };
  simple('zones', 'zones', { name: 'text', fee: 'int' });
  simple('coupons', 'coupons', { code: 'upper', percent: 'pct', free_shipping: 'bool', active: 'bool' });
  simple('couriers', 'couriers', { name: 'text', phone: 'text', active: 'bool' }, true);

  add('GET', '/api/orders', 'staff', ({ user, url }) => S.listOrders(db, user.tenant_id, { status: url.searchParams.get('status'), limit: Math.min(500, Number(url.searchParams.get('limit')) || 200) }));
  add('GET', '/api/orders/:id', 'staff', ({ user, params }) => S.getOrder(db, user.tenant_id, num(params.id)) || (() => { throw new HttpError(404, 'Pedido não encontrado'); })());
  add('POST', '/api/orders/:id/status', 'staff', ({ user, params, body }) => {
    const o = S.changeStatus(db, user.tenant_id, num(params.id), body);
    emit(user.tenant_id, 'order', o);
    return o;
  });
  add('GET', '/api/reports', 'staff', ({ user, url }) => S.report(db, user.tenant_id, Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 7))));

  add('GET', '/api/team', 'owner', ({ user }) => db.prepare('SELECT id,name,email,role FROM users WHERE tenant_id=? ORDER BY id').all(user.tenant_id));
  add('POST', '/api/team', 'owner', ({ user, body }) => {
    if (!body.email || !body.password || body.password.length < 8) throw new HttpError(400, 'Informe e-mail e senha com 8+ caracteres');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(String(body.email))) throw new HttpError(409, 'E-mail já cadastrado');
    const r = db.prepare(`INSERT INTO users (tenant_id,name,email,pass_hash,role,created_at) VALUES (?,?,?,?,'staff',?)`)
      .run(user.tenant_id, String(body.name || body.email).slice(0, 60), String(body.email).trim(), hashPassword(body.password), Date.now());
    return { id: Number(r.lastInsertRowid) };
  });
  add('DELETE', '/api/team/:id', 'owner', ({ user, params }) => {
    if (num(params.id) === user.id) throw new HttpError(400, 'Você não pode remover a si mesmo');
    db.prepare(`DELETE FROM users WHERE id=? AND tenant_id=? AND role='staff'`).run(num(params.id), user.tenant_id);
    return { ok: true };
  });

  /* ---------- plataforma (dono do SaaS) ---------- */
  add('GET', '/api/platform/overview', 'platform', () => S.platformOverview(db));
  add('POST', '/api/platform/tenants', 'platform', ({ body }) => S.publicTenant(S.createTenant(db, body)));
  add('PATCH', '/api/platform/tenants/:id', 'platform', ({ params, body }) => {
    const t = S.getTenant(db, num(params.id));
    if (!t) throw new HttpError(404, 'Empresa não encontrada');
    if (body.plan !== undefined && !PLANS[body.plan]) throw new HttpError(400, 'Plano inválido');
    db.prepare('UPDATE tenants SET plan=?, active=? WHERE id=?').run(body.plan ?? t.plan, body.active === undefined ? t.active : body.active ? 1 : 0, t.id);
    return { ok: true };
  });

  /* ---------- servidor ---------- */
  async function readBody(req) {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return {};
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'Requisição muito grande'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'JSON inválido'); }
  }
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  function serveStatic(req, res, url) {
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
        return serveStatic(req, res, url);
      }
      if (url.pathname === '/api/events') {
        const user = userFromReq(req, url);
        if (!user?.tenant_id) throw new HttpError(401, 'Faça login');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        if (!sse.has(user.tenant_id)) sse.set(user.tenant_id, new Set());
        sse.get(user.tenant_id).add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); sse.get(user.tenant_id)?.delete(res); });
        return;
      }
      const user = userFromReq(req, url);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const ok = r.auth.split('|').some(a => can(user, a));
        if (!ok) throw new HttpError(user ? 403 : 401, user ? 'Sem permissão' : 'Faça login');
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = await readBody(req);
        return send(res, 200, await r.handler({ req, url, params, body, user }));
      }
      throw new HttpError(404, 'Rota não encontrada');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Erro interno' });
    }
  });
}

/* ---------- inicialização ---------- */
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export function bootstrap(db, env) {
  if (!db.prepare(`SELECT 1 FROM users WHERE role='platform'`).get()) {
    const email = env.PLATFORM_EMAIL || 'admin@balcao.app';
    const pw = env.PLATFORM_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO users (tenant_id,name,email,pass_hash,role,created_at) VALUES (NULL,'Administrador',?,?,'platform',?)`).run(email, hashPassword(pw), Date.now());
    console.log(`Conta da plataforma criada: ${email}${env.PLATFORM_PASSWORD ? '' : ` / senha gerada: ${pw}`}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const env = process.env;
  const db = openDb(env.DB_PATH || path.join(ROOT, 'data', 'balcao.db'));
  let secret = env.SECRET;
  if (!secret) {
    const f = path.join(ROOT, 'data', '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8');
  }
  bootstrap(db, env);
  if (env.SEED_DEMO !== '0' && !db.prepare('SELECT 1 FROM tenants').get()) {
    const { seedDemo } = await import('./seed.js');
    seedDemo(db);
  }
  const port = Number(env.PORT) || 3000;
  createApp({ db, secret }).listen(port, () => console.log(`Balcão rodando em http://localhost:${port}`));
}
