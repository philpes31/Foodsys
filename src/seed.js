// Dados de demonstração: 4 empresas de segmentos diferentes com pedidos simulados.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createTenant, placeOrder, listProducts, getTenant } from './service.js';

export const DEMO = [
  { name: 'Forno da Vila', slug: 'forno-da-vila', segment: 'pizzaria', plan: 'Pro', email: 'dono@fornodavila.demo', orders: 14 },
  { name: 'Brasa Burger', slug: 'brasa-burger', segment: 'hamburgueria', plan: 'Rede', email: 'dono@brasaburger.demo', orders: 11 },
  { name: 'Açaí da Praia', slug: 'acai-da-praia', segment: 'acai', plan: 'Básico', email: 'dono@acaidapraia.demo', orders: 8 },
  { name: 'Mercadinho Bom Preço', slug: 'mercadinho-bom-preco', segment: 'mercado', plan: 'Pro', email: 'dono@bompreco.demo', orders: 6 }
];
export const DEMO_PASSWORD = 'demo1234';

const NAMES = ['Ana Souza', 'Bruno Lima', 'Camila Reis', 'Diego Alves', 'Elisa Prado', 'Fábio Nunes', 'Gabi Torres', 'Hugo Melo', 'Iara Costa', 'João Pires', 'Karen Dias', 'Lucas Rocha', 'Marina Luz', 'Nina Faria'];
const FINAL = ['entregue', 'entregue', 'entregue', 'entregue', 'entregue', 'entregue', 'entregue', 'entregue', 'cancelado', 'rota', 'pronto', 'preparo', 'novo', 'novo'];
const NEXT = { novo: 'preparo', preparo: 'pronto', pronto: 'rota', rota: 'entregue' };

export function seedDemo(db) {
  for (const d of DEMO) {
    const t = createTenant(db, { name: d.name, slug: d.slug, segment: d.segment, plan: d.plan, owner: { name: `Dono ${d.name}`, email: d.email, password: DEMO_PASSWORD } });
    const cIns = db.prepare('INSERT INTO couriers (tenant_id,name,phone,active) VALUES (?,?,?,?)');
    const couriers = [['Carlos', '(11) 98888-1001', 1], ['Juliana', '(11) 98888-1002', 1], ['Rafael', '(11) 98888-1003', 0]]
      .map(c => Number(cIns.run(t.id, ...c).lastInsertRowid));
    const prods = listProducts(db, t.id), zones = db.prepare('SELECT * FROM zones WHERE tenant_id=?').all(t.id);
    const tenant = { ...getTenant(db, t.id), min_order: 0 }; // ignora pedido mínimo só na simulação
    for (let i = 0; i < d.orders; i++) {
      const pick = k => { const p = prods[k % prods.length]; return { productId: p.id, qty: 1 + (k % 4 === 3 ? 1 : 0), optionIds: p.groups.filter(g => g.min_sel).map(g => g.options[k % g.options.length].id) }; };
      const items = [pick(i)]; if (i % 2) items.push(pick(i + 3));
      if (d.segment === 'mercado') items.push(pick(i + 1), pick(i + 2));
      const pickup = i % 5 === 4;
      const o = placeOrder(db, tenant, { customer: { name: NAMES[i % NAMES.length], phone: `(11) 9${8100 + i * 37}-${1000 + i * 91}` },
        fulfillment: pickup ? 'pickup' : 'delivery', zoneId: zones[i % zones.length].id, address: `Rua das Flores, ${100 + i * 13}`,
        payment: ['Pix', 'Cartão na entrega', 'Dinheiro'][i % 3], items, coupon: i % 6 === 2 ? 'PRIMEIRA10' : undefined });
      // volta o relógio para espalhar os pedidos ao longo do dia
      const final = FINAL[FINAL.length - d.orders + i] || 'entregue';
      let at = Date.now() - (d.orders - i) * 23 * 60000 - 5 * 60000;
      db.prepare('UPDATE orders SET created_at=?, updated_at=? WHERE id=?').run(at, at, o.id);
      db.prepare('UPDATE order_events SET at=? WHERE order_id=?').run(at, o.id);
      let st = 'novo';
      const step = s => { at += (s === 'pronto' ? 14 : s === 'entregue' ? 16 : 4) * 60000; at = Math.min(at, Date.now());
        db.prepare('UPDATE orders SET status=?, updated_at=?, courier_id=COALESCE(?,courier_id) WHERE id=?').run(s, at, s === 'rota' ? couriers[i % 2] : null, o.id);
        db.prepare('INSERT INTO order_events (order_id,status,at) VALUES (?,?,?)').run(o.id, s, at); st = s; };
      if (final === 'cancelado') { step('cancelado'); continue; }
      const target = pickup && final === 'rota' ? 'pronto' : final;
      while (st !== target) step(pickup && st === 'pronto' ? 'entregue' : NEXT[st]);
    }
  }
  console.log(`Empresas de demonstração criadas (senha: ${DEMO_PASSWORD}): ${DEMO.map(d => d.email).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.DB_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'balcao.db'));
  if (db.prepare('SELECT 1 FROM tenants').get()) console.log('O banco já tem empresas; nada foi feito.');
  else seedDemo(db);
}
