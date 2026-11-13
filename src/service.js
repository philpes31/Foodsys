// Regras de negócio: empresas, cardápio, pedidos, status e relatórios.
import { tx } from './db.js';
import { hashPassword, randomCode } from './auth.js';
import { SEGMENTS, PLANS, templateProducts, cents } from './templates.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = m => new HttpError(400, m);

export const STATUS_FLOW = {
  novo: ['preparo', 'cancelado'],
  preparo: ['pronto', 'cancelado'],
  pronto: ['rota', 'entregue', 'cancelado'],
  rota: ['entregue']
};

export function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'loja';
}

/* ---------------- Empresas ---------------- */
export function createTenant(db, { name, slug, segment, color, plan, owner }) {
  if (!name?.trim()) throw bad('Informe o nome da empresa');
  if (!SEGMENTS[segment]) throw bad('Segmento inválido');
  if (plan && !PLANS[plan]) throw bad('Plano inválido');
  if (!owner?.email || !owner?.password || owner.password.length < 8) throw bad('Dono precisa de e-mail e senha com 8+ caracteres');
  let s = slugify(slug || name);
  if (db.prepare('SELECT 1 FROM tenants WHERE slug=?').get(s)) {
    if (slug) throw new HttpError(409, 'Esse endereço de loja já está em uso');
    s = `${s}-${randomCode(4).toLowerCase()}`;
  }
  owner.email = String(owner.email).trim();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(owner.email)) throw new HttpError(409, 'E-mail já cadastrado');
  const seg = SEGMENTS[segment];
  return tx(db, () => {
    const t = db.prepare(`INSERT INTO tenants (slug,name,segment,color,plan,min_order,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(s, name.trim(), segment, color || seg.color, plan || 'Pro', segment === 'mercado' ? 3000 : 0, Date.now());
    const tid = Number(t.lastInsertRowid);
    db.prepare(`INSERT INTO users (tenant_id,name,email,pass_hash,role,created_at) VALUES (?,?,?,?, 'owner', ?)`)
      .run(tid, owner.name || name, owner.email.trim(), hashPassword(owner.password), Date.now());
    for (const p of templateProducts(segment)) insertProduct(db, tid, p);
    const z = db.prepare('INSERT INTO zones (tenant_id,name,fee) VALUES (?,?,?)');
    [['Centro', 5], ['Jardim América', 7], ['Vila Nova', 8], ['Boa Vista', 10]].forEach(([n, f]) => z.run(tid, n, cents(f)));
    db.prepare('INSERT INTO coupons (tenant_id,code,percent) VALUES (?,?,10)').run(tid, 'PRIMEIRA10');
    db.prepare('INSERT INTO coupons (tenant_id,code,free_shipping) VALUES (?,?,1)').run(tid, 'FRETEGRATIS');
    return getTenant(db, tid);
  });
}

export const getTenant = (db, id) => db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
export const getTenantBySlug = (db, slug) => db.prepare('SELECT * FROM tenants WHERE slug=?').get(slug);

export function publicTenant(t) {
  return { slug: t.slug, name: t.name, segment: t.segment, segmentName: SEGMENTS[t.segment]?.name, prepName: SEGMENTS[t.segment]?.prep,
    color: t.color, plan: t.plan, minOrder: t.min_order, isOpen: !!t.is_open && !!t.active, allowPickup: !!t.allow_pickup, eta: t.eta_text, phone: t.phone };
}

export function updateTenant(db, tid, b) {
  const t = getTenant(db, tid);
  const v = {
    name: b.name?.trim() || t.name,
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : t.color,
    min_order: Number.isInteger(b.minOrder) && b.minOrder >= 0 ? b.minOrder : t.min_order,
    is_open: b.isOpen === undefined ? t.is_open : b.isOpen ? 1 : 0,
    allow_pickup: b.allowPickup === undefined ? t.allow_pickup : b.allowPickup ? 1 : 0,
    eta_text: typeof b.eta === 'string' ? b.eta.slice(0, 40) : t.eta_text,
    phone: typeof b.phone === 'string' ? b.phone.slice(0, 30) : t.phone
  };
  db.prepare('UPDATE tenants SET name=?,color=?,min_order=?,is_open=?,allow_pickup=?,eta_text=?,phone=? WHERE id=?')
    .run(v.name, v.color, v.min_order, v.is_open, v.allow_pickup, v.eta_text, v.phone, tid);
  return publicTenant(getTenant(db, tid));
}

/* ---------------- Cardápio ---------------- */
function insertProduct(db, tid, p) {
  const r = db.prepare('INSERT INTO products (tenant_id,category,name,description,price,icon,available,sort) VALUES (?,?,?,?,?,?,?,?)')
    .run(tid, p.category, p.name, p.description || '', p.price, p.icon || 'box', p.available === false ? 0 : 1, p.sort || 0);
  const pid = Number(r.lastInsertRowid);
  writeGroups(db, pid, p.groups || []);
  return pid;
}

function writeGroups(db, pid, groups) {
  db.prepare('DELETE FROM option_groups WHERE product_id=?').run(pid);
  const g = db.prepare('INSERT INTO option_groups (product_id,name,min_sel,max_sel,sort) VALUES (?,?,?,?,?)');
  const o = db.prepare('INSERT INTO options (group_id,name,price,sort) VALUES (?,?,?,?)');
  groups.forEach((gr, gi) => {
    const gid = Number(g.run(pid, gr.name, gr.min_sel, gr.max_sel, gi).lastInsertRowid);
    gr.options.forEach((op, oi) => o.run(gid, op.name, op.price, oi));
  });
}

function validateProduct(b) {
  const p = {
    category: String(b.category || '').trim().slice(0, 40), name: String(b.name || '').trim().slice(0, 80),
    description: String(b.description || '').trim().slice(0, 200), price: b.price, icon: String(b.icon || 'box').slice(0, 12),
    available: b.available !== false, sort: Number.isInteger(b.sort) ? b.sort : 0, groups: b.groups || []
  };
  if (!p.name || !p.category) throw bad('Produto precisa de nome e categoria');
  if (!Number.isInteger(p.price) || p.price < 0) throw bad('Preço inválido (em centavos)');
  if (!Array.isArray(p.groups) || p.groups.length > 10) throw bad('Grupos de opções inválidos');
  p.groups = p.groups.map(g => {
    const name = String(g.name || '').trim().slice(0, 60);
    const options = (Array.isArray(g.options) ? g.options : []).map(o => ({ name: String(o.name || '').trim().slice(0, 60), price: o.price }));
    const min = g.min_sel, max = g.max_sel;
    if (!name) throw bad('Todo grupo precisa de nome');
    if (!options.length || options.length > 40) throw bad(`O grupo "${name}" precisa de 1 a 40 opções`);
    if (options.some(o => !o.name || !Number.isInteger(o.price) || o.price < 0)) throw bad(`Opção inválida no grupo "${name}"`);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max || min > options.length)
      throw bad(`Mínimo/máximo inválidos no grupo "${name}"`);
    return { name, min_sel: min, max_sel: Math.min(max, options.length), options };
  });
  return p;
}

export function listProducts(db, tid, { onlyAvailable = false } = {}) {
  const prods = db.prepare('SELECT * FROM products WHERE tenant_id=? ORDER BY sort, id').all(tid);
  const groups = db.prepare(`SELECT g.* FROM option_groups g JOIN products p ON p.id=g.product_id WHERE p.tenant_id=? ORDER BY g.sort, g.id`).all(tid);
  const opts = db.prepare(`SELECT o.* FROM options o JOIN option_groups g ON g.id=o.group_id JOIN products p ON p.id=g.product_id WHERE p.tenant_id=? ORDER BY o.sort, o.id`).all(tid);
  return prods.filter(p => !onlyAvailable || p.available).map(p => ({
    id: p.id, category: p.category, name: p.name, description: p.description, price: p.price, icon: p.icon, available: !!p.available, sort: p.sort,
    groups: groups.filter(g => g.product_id === p.id).map(g => ({
      id: g.id, name: g.name, min_sel: g.min_sel, max_sel: g.max_sel,
      options: opts.filter(o => o.group_id === g.id).map(o => ({ id: o.id, name: o.name, price: o.price }))
    }))
  }));
}

export function saveProduct(db, tid, id, body) {
  const p = validateProduct(body);
  return tx(db, () => {
    if (id) {
      const ex = db.prepare('SELECT id FROM products WHERE id=? AND tenant_id=?').get(id, tid);
      if (!ex) throw new HttpError(404, 'Produto não encontrado');
      db.prepare('UPDATE products SET category=?,name=?,description=?,price=?,icon=?,available=?,sort=? WHERE id=?')
        .run(p.category, p.name, p.description, p.price, p.icon, p.available ? 1 : 0, p.sort, id);
      writeGroups(db, id, p.groups);
      return id;
    }
    return insertProduct(db, tid, p);
  });
}

/* ---------------- Pedidos ---------------- */
function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }

export function placeOrder(db, tenant, body) {
  if (!tenant.active) throw new HttpError(403, 'Loja indisponível');
  if (!tenant.is_open) throw new HttpError(409, 'A loja está fechada no momento');
  const limit = PLANS[tenant.plan]?.monthlyOrders;
  if (limit) {
    const n = db.prepare('SELECT COUNT(*) c FROM orders WHERE tenant_id=? AND created_at>=?').get(tenant.id, monthStart()).c;
    if (n >= limit) throw new HttpError(429, 'A loja atingiu o limite de pedidos do plano neste mês');
  }
  const name = String(body.customer?.name || '').trim().slice(0, 80);
  const phone = String(body.customer?.phone || '').trim().slice(0, 30);
  if (!name || phone.replace(/\D/g, '').length < 8) throw bad('Informe nome e telefone válidos');
  const fulfillment = body.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  if (fulfillment === 'pickup' && !tenant.allow_pickup) throw bad('Esta loja não aceita retirada');
  let fee = 0, zoneName = '', address = '';
  if (fulfillment === 'delivery') {
    const z = db.prepare('SELECT * FROM zones WHERE id=? AND tenant_id=?').get(Number.isInteger(body.zoneId) ? body.zoneId : -1, tenant.id);
    if (!z) throw bad('Escolha um bairro atendido');
    address = String(body.address || '').trim().slice(0, 200);
    if (address.length < 5) throw bad('Informe o endereço de entrega');
    fee = z.fee; zoneName = z.name;
  }
  const payment = ['Pix', 'Cartão na entrega', 'Dinheiro'].includes(body.payment) ? body.payment : null;
  if (!payment) throw bad('Forma de pagamento inválida');

  // Preço calculado no servidor a partir do cardápio — nunca confiar no valor enviado pelo navegador.
  const menu = new Map(listProducts(db, tenant.id).map(p => [p.id, p]));
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw bad('Carrinho vazio');
  const items = body.items.map(it => {
    const p = menu.get(it.productId);
    if (!p || !p.available) throw bad('Um dos produtos não está mais disponível');
    const qty = it.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw bad('Quantidade inválida');
    const chosen = new Set(Array.isArray(it.optionIds) ? it.optionIds : []);
    let unit = p.price; const labels = [];
    for (const g of p.groups) {
      const picked = g.options.filter(o => chosen.has(o.id));
      if (picked.length < g.min_sel || picked.length > g.max_sel) throw bad(`Escolha entre ${g.min_sel} e ${g.max_sel} em "${g.name}" (${p.name})`);
      picked.forEach(o => { unit += o.price; labels.push(o.name); chosen.delete(o.id); });
    }
    if (chosen.size) throw bad('Opção inválida para o produto');
    return { product_id: p.id, product_name: p.name, options_text: labels.join(', '), qty, unit_price: unit, notes: String(it.notes || '').slice(0, 140) };
  });
  const subtotal = items.reduce((t, i) => t + i.qty * i.unit_price, 0);
  if (subtotal < tenant.min_order) throw bad('Pedido abaixo do valor mínimo da loja');
  let discount = 0, couponCode = null;
  if (body.coupon) {
    const c = db.prepare('SELECT * FROM coupons WHERE tenant_id=? AND code=? AND active=1').get(tenant.id, String(body.coupon).toUpperCase());
    if (!c) throw bad('Cupom inválido');
    couponCode = c.code;
    if (c.percent) discount = Math.round(subtotal * c.percent / 100);
    if (c.free_shipping) fee = 0;
  }
  const total = subtotal + fee - discount;
  const changeFor = payment === 'Dinheiro' && Number.isInteger(body.changeFor) && body.changeFor > total ? body.changeFor : null;
  const now = Date.now();
  return tx(db, () => {
    const number = (db.prepare('SELECT MAX(number) m FROM orders WHERE tenant_id=?').get(tenant.id).m || 100) + 1;
    const code = randomCode(10);
    const r = db.prepare(`INSERT INTO orders (tenant_id,number,public_code,customer_name,customer_phone,fulfillment,address,zone_name,payment,change_for,subtotal,fee,discount,total,coupon_code,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'novo',?,?)`)
      .run(tenant.id, number, code, name, phone, fulfillment, address, zoneName, payment, changeFor, subtotal, fee, discount, total, couponCode, now, now);
    const oid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,options_text,qty,unit_price,notes) VALUES (?,?,?,?,?,?,?)');
    items.forEach(i => ins.run(oid, i.product_id, i.product_name, i.options_text, i.qty, i.unit_price, i.notes));
    db.prepare('INSERT INTO order_events (order_id,status,at) VALUES (?,?,?)').run(oid, 'novo', now);
    return getOrder(db, tenant.id, oid);
  });
}

export function getOrder(db, tid, id) {
  const o = db.prepare(`SELECT o.*, c.name courier_name FROM orders o LEFT JOIN couriers c ON c.id=o.courier_id WHERE o.id=? AND o.tenant_id=?`).get(id, tid);
  if (!o) return null;
  o.items = db.prepare('SELECT product_name,options_text,qty,unit_price,notes FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.events = db.prepare('SELECT status,at FROM order_events WHERE order_id=? ORDER BY id').all(id);
  return o;
}

export function listOrders(db, tid, { status, limit = 200 } = {}) {
  const st = status ? String(status).split(',') : null;
  const rows = st
    ? db.prepare(`SELECT id FROM orders WHERE tenant_id=? AND status IN (${st.map(() => '?').join(',')}) ORDER BY created_at LIMIT ?`).all(tid, ...st, limit)
    : db.prepare('SELECT id FROM orders WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?').all(tid, limit);
  return rows.map(r => getOrder(db, tid, r.id));
}

export function changeStatus(db, tid, id, { status, courierId }) {
  const o = getOrder(db, tid, id);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (!(STATUS_FLOW[o.status] || []).includes(status)) throw new HttpError(409, `Não é possível ir de "${o.status}" para "${status}"`);
  if (status === 'rota') {
    if (o.fulfillment !== 'delivery') throw new HttpError(409, 'Pedido de retirada não sai para entrega');
    const c = Number.isInteger(courierId) && db.prepare('SELECT * FROM couriers WHERE id=? AND tenant_id=? AND active=1').get(courierId, tid);
    if (!c) throw bad('Escolha um entregador ativo');
  }
  if (status === 'entregue' && o.status === 'pronto' && o.fulfillment === 'delivery') throw new HttpError(409, 'Despache o pedido antes de confirmar a entrega');
  const now = Date.now();
  tx(db, () => {
    db.prepare('UPDATE orders SET status=?, courier_id=COALESCE(?,courier_id), updated_at=? WHERE id=?').run(status, status === 'rota' ? courierId : null, now, id);
    db.prepare('INSERT INTO order_events (order_id,status,at) VALUES (?,?,?)').run(id, status, now);
  });
  return getOrder(db, tid, id);
}

/* ---------------- Relatórios ---------------- */
export function report(db, tid, days = 7) {
  const from = Date.now() - days * 86400000;
  const valid = `tenant_id=? AND created_at>=? AND status!='cancelado'`;
  const k = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders WHERE ${valid}`).get(tid, from);
  const cancelled = db.prepare(`SELECT COUNT(*) c FROM orders WHERE tenant_id=? AND created_at>=? AND status='cancelado'`).get(tid, from).c;
  const avg = db.prepare(`SELECT AVG(e.at - o.created_at) ms FROM orders o JOIN order_events e ON e.order_id=o.id AND e.status='entregue' WHERE o.tenant_id=? AND o.created_at>=?`).get(tid, from).ms;
  const byHour = db.prepare(`SELECT CAST(strftime('%H', created_at/1000, 'unixepoch', 'localtime') AS INTEGER) h, COUNT(*) orders, SUM(total) revenue FROM orders WHERE ${valid} GROUP BY h ORDER BY h`).all(tid, from);
  const byDay = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') d, COUNT(*) orders, SUM(total) revenue FROM orders WHERE ${valid} GROUP BY d ORDER BY d`).all(tid, from);
  const top = db.prepare(`SELECT i.product_name name, SUM(i.qty) qty, SUM(i.qty*i.unit_price) revenue FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.tenant_id=? AND o.created_at>=? AND o.status!='cancelado' GROUP BY i.product_name ORDER BY qty DESC LIMIT 8`).all(tid, from);
  const payments = db.prepare(`SELECT payment, COUNT(*) orders, SUM(total) revenue FROM orders WHERE ${valid} GROUP BY payment ORDER BY revenue DESC`).all(tid, from);
  const couriers = db.prepare(`SELECT c.name, COUNT(o.id) deliveries, COALESCE(SUM(o.fee),0) fees FROM couriers c LEFT JOIN orders o ON o.courier_id=c.id AND o.status='entregue' AND o.created_at>=? WHERE c.tenant_id=? GROUP BY c.id ORDER BY deliveries DESC`).all(from, tid);
  return { days, orders: k.orders, revenue: k.revenue, avgTicket: k.orders ? Math.round(k.revenue / k.orders) : 0, cancelled,
    avgDeliveryMin: avg ? Math.round(avg / 60000) : null, byHour, byDay, top, payments, couriers };
}

export function platformOverview(db) {
  const tenants = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM orders o WHERE o.tenant_id=t.id) orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.tenant_id=t.id AND o.status!='cancelado') revenue,
    (SELECT email FROM users u WHERE u.tenant_id=t.id AND u.role='owner' ORDER BY id LIMIT 1) owner_email
    FROM tenants t ORDER BY t.created_at`).all();
  const active = tenants.filter(t => t.active);
  return {
    mrr: active.reduce((s, t) => s + (PLANS[t.plan]?.price || 0), 0),
    gmv: tenants.reduce((s, t) => s + t.revenue, 0),
    orders: tenants.reduce((s, t) => s + t.orders, 0),
    tenants: tenants.map(t => ({ id: t.id, slug: t.slug, name: t.name, segment: t.segment, segmentName: SEGMENTS[t.segment]?.name, color: t.color, plan: t.plan,
      active: !!t.active, orders: t.orders, revenue: t.revenue, ownerEmail: t.owner_email, createdAt: t.created_at }))
  };
}
