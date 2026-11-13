// Testes da migração do Supabase num Postgres local (16+), com uma simulação mínima do auth do Supabase.
// Uso: PGHOST=... PGPORT=... PGUSER=postgres npm test   (cria e apaga o banco "balcao_test")
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'balcao_test';
const psql = (args, input) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

// Executa SQL como um usuário (uuid), como anônimo (null) ou como superusuário ('admin').
function sql(query, as = 'admin') {
  const head = as === 'admin' ? '' : as === null ? 'set local role anon;' : `set local role authenticated; set local request.jwt.claim.sub = '${as}';`;
  try {
    const out = psql(['-d', DB], `begin; ${head} ${query}; commit;`).trim();
    return out;
  } catch (e) { throw new Error((e.stderr || e.message).replace(/^psql:.*?ERROR:\s*/m, '').split('\n')[0]); }
}
const json = (q, as) => JSON.parse(sql(`select (${q})::text`, as));
const fails = (q, as, re) => assert.throws(() => sql(q, as), re);

const U = { pizza: randomUUID(), burger: randomUUID(), staff: randomUUID(), admin: randomUUID() };
let pizzaId, burgerId;

before(() => {
  psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]);
  psql(['-d', 'postgres', '-c', `create database ${DB}`]);
  psql(['-d', DB, '-f', path.join(ROOT, 'test/supabase-shim.sql')]);
  psql(['-d', DB, '-f', path.join(ROOT, 'supabase/migrations/20261113000000_balcao.sql')]);
  sql(`insert into auth.users (id, email) values ('${U.pizza}','dono@pizza.test'),('${U.burger}','dono@burger.test'),('${U.staff}','atendente@pizza.test'),('${U.admin}','admin@balcao.test');
       insert into platform_admins values ('${U.admin}')`);
  pizzaId = sql(`select (create_my_tenant('Forno da Vila', 'pizzaria')).id`, U.pizza);
  burgerId = sql(`select (create_my_tenant('Brasa Burger', 'hamburgueria', 'brasa')).id`, U.burger);
});

const menu = slug => json(`(select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price', p.price, 'groups',
  (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'min', g.min_sel, 'options',
     (select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price', o.price) order by o.sort) from options o where o.group_id = g.id)) order by g.sort), '[]')
   from option_groups g where g.product_id = p.id))) from products p join tenants t on t.id = p.tenant_id where t.slug = '${slug}')`, null);
const zones = slug => json(`(select jsonb_agg(z order by z.id) from zones z join tenants t on t.id = z.tenant_id where t.slug = '${slug}')`, null);
const order = (slug, body) => json(`place_order('${slug}', '${JSON.stringify(body).replace(/'/g, "''")}'::jsonb)`, null);
const customer = { name: 'Maria Teste', phone: '11999990000' };

test('cadastro self-service cria a loja com o modelo do segmento', () => {
  assert.equal(sql(`select slug from tenants where id = '${pizzaId}'`), 'forno-da-vila');
  assert.equal(sql(`select slug from tenants where id = '${burgerId}'`), 'brasa');
  assert.ok(menu('forno-da-vila').length >= 5);
  assert.equal(sql(`select role from memberships where tenant_id = '${pizzaId}'`, U.pizza), 'owner');
  fails(`select create_my_tenant('X', 'pizzaria')`, null, /permission denied|Faça login/);
});

test('pedido anônimo: preço calculado no banco, com opções e cupom', () => {
  const pizza = menu('forno-da-vila').find(p => p.name === 'Margherita');
  const g = pizza.groups.find(g => g.name === 'Tamanho').options.find(o => o.name.startsWith('Grande'));
  const b = pizza.groups.find(g => g.name === 'Borda recheada').options[0];
  const z = zones('forno-da-vila')[0];
  const r = order('forno-da-vila', { customer, fulfillment: 'delivery', zoneId: z.id, address: 'Rua A, 10', payment: 'Pix', coupon: 'primeira10',
    items: [{ productId: pizza.id, qty: 2, optionIds: [g.id, b.id], price: 1 }] });
  const sub = (pizza.price + g.price + b.price) * 2;
  assert.equal(r.total, sub + z.fee - Math.round(sub * 0.1));
  const t = json(`track_order('${r.code}')`, null);
  assert.equal(t.order.status, 'novo');
  assert.equal(t.order.items[0].options_text, 'Grande (8 fatias), Catupiry');
});

test('anônimo não lê pedidos nem cupons e não grava direto nas tabelas', () => {
  fails('select count(*) from orders', null, /permission denied/);
  fails('select count(*) from coupons', null, /permission denied/);
  fails(`insert into orders (tenant_id) values ('${pizzaId}')`, null, /permission denied/);
  fails(`update products set price = 1`, U.burger, /permission denied/);
});

test('regras do pedido: grupo obrigatório, opção de outro produto, pedido mínimo, loja fechada', () => {
  const m = menu('forno-da-vila'), [a, b] = m.filter(p => p.groups.some(g => g.min > 0));
  const base = { customer, fulfillment: 'pickup', payment: 'Pix' };
  assert.throws(() => order('forno-da-vila', { ...base, items: [{ productId: a.id, qty: 1, optionIds: [] }] }), /Escolha entre 1 e 1/);
  assert.throws(() => order('forno-da-vila', { ...base, items: [{ productId: a.id, qty: 1, optionIds: [b.groups[0].options[0].id] }] }), /Opção inválida/);
  assert.throws(() => order('forno-da-vila', { ...base, payment: 'Bitcoin', items: [{ productId: a.id, qty: 1 }] }), /pagamento/);
  sql(`update tenants set min_order = 999999 where id = '${pizzaId}'`, U.pizza);
  assert.throws(() => order('forno-da-vila', { ...base, items: [{ productId: a.id, qty: 1, optionIds: [a.groups[0].options[0].id] }] }), /mínimo/);
  sql(`update tenants set min_order = 0, is_open = false where id = '${pizzaId}'`, U.pizza);
  assert.throws(() => order('forno-da-vila', { ...base, items: [{ productId: a.id, qty: 1, optionIds: [a.groups[0].options[0].id] }] }), /fechada/);
  sql(`update tenants set is_open = true where id = '${pizzaId}'`, U.pizza);
});

test('fluxo de status com entregador', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const r = order('forno-da-vila', { customer, fulfillment: 'delivery', zoneId: zones('forno-da-vila')[1].id, address: 'Rua B, 20', payment: 'Dinheiro', changeFor: 10000, items: [{ productId: p.id, qty: 1 }] });
  const id = sql(`select id from orders where public_code = '${r.code}'`);
  fails(`select change_order_status(${id}, 'entregue')`, U.pizza, /Não é possível/);
  sql(`select change_order_status(${id}, 'preparo'); select change_order_status(${id}, 'pronto')`, U.pizza);
  fails(`select change_order_status(${id}, 'rota')`, U.pizza, /entregador/);
  const c = sql(`insert into couriers (tenant_id, name) values ('${pizzaId}', 'Carlos') returning id`, U.pizza);
  sql(`select change_order_status(${id}, 'rota', ${c})`, U.pizza);
  assert.equal(json(`track_order('${r.code}')`, null).order.courier, 'Carlos');
  sql(`select change_order_status(${id}, 'entregue')`, U.pizza);
  assert.equal(sql(`select count(*) from order_events where order_id = ${id}`), '5');
});

test('isolamento entre empresas', () => {
  assert.equal(sql(`select count(*) from orders where tenant_id = '${pizzaId}'`, U.burger), '0');
  assert.equal(sql(`select count(*) from coupons where tenant_id = '${pizzaId}'`, U.burger), '0');
  assert.equal(sql(`update tenants set name = 'Hack' where id = '${pizzaId}' returning id`, U.burger), '');
  fails(`select save_product('${pizzaId}', null, '{"name":"X","category":"Y","price":1}')`, U.burger, /Sem permissão/);
  const oid = sql(`select id from orders where tenant_id = '${pizzaId}' and status = 'novo' limit 1`);
  fails(`select change_order_status(${oid}, 'preparo')`, U.burger, /não encontrado/);
  fails(`insert into zones (tenant_id, name, fee) values ('${pizzaId}', 'Invasão', 0)`, U.burger, /row-level security/);
  fails(`select store_report('${pizzaId}', 7)`, U.burger, /Sem permissão/);
});

test('dono não muda plano nem status ativo direto na tabela', () => {
  fails(`update tenants set plan = 'Rede' where id = '${pizzaId}'`, U.pizza, /permission denied/);
  fails(`update tenants set active = true where id = '${pizzaId}'`, U.pizza, /permission denied/);
  sql(`select change_plan('${pizzaId}', 'Rede')`, U.pizza);
  assert.equal(sql(`select plan from tenants where id = '${pizzaId}'`), 'Rede');
});

test('atendente opera pedidos mas não mexe em cardápio, relatórios e loja', () => {
  sql(`select add_staff('${pizzaId}', 'ATENDENTE@pizza.test')`, U.pizza);
  assert.equal(json(`(select jsonb_agg(role order by role) from list_team('${pizzaId}'))`, U.pizza).join(), 'owner,staff');
  const oid = sql(`select id from orders where tenant_id = '${pizzaId}' and status = 'novo' limit 1`);
  sql(`select change_order_status(${oid}, 'preparo')`, U.staff);
  const pid = sql(`select id from products where tenant_id = '${pizzaId}' limit 1`);
  sql(`select set_product_availability(${pid}, false)`, U.staff);
  assert.equal(sql(`select available from products where id = ${pid}`), 'f');
  fails(`select save_product('${pizzaId}', ${pid}, '{"name":"X","category":"Y","price":1}')`, U.staff, /Sem permissão/);
  fails(`select store_report('${pizzaId}', 7)`, U.staff, /Sem permissão/);
  assert.equal(sql(`update tenants set name = 'Outra' where id = '${pizzaId}' returning id`, U.staff), '');
  fails(`select add_staff('${pizzaId}', 'ninguem@x.test')`, U.pizza, /ainda não tem conta/);
  sql(`select set_product_availability(${pid}, true)`, U.pizza);
});

test('editor de produto: grupos de opções e validação', () => {
  const id = sql(`select save_product('${burgerId}', null, '{"category":"Bowls","name":"Bowl","price":2500,"groups":[
    {"name":"Base","min_sel":1,"max_sel":1,"options":[{"name":"Arroz","price":0},{"name":"Quinoa","price":300}]},
    {"name":"Extras","min_sel":0,"max_sel":5,"options":[{"name":"Ovo","price":200},{"name":"Queijo","price":300}]}]}')`, U.burger);
  assert.equal(sql(`select string_agg(name || ':' || max_sel, ',' order by sort) from option_groups where product_id = ${id}`), 'Base:1,Extras:2');
  fails(`select save_product('${burgerId}', null, '{"category":"X","name":"Y","price":100,"groups":[{"name":"G","min_sel":3,"max_sel":1,"options":[{"name":"a","price":0}]}]}')`, U.burger, /Mínimo\/máximo/);
  fails(`select save_product('${burgerId}', null, '{"category":"X","name":"Y","price":-5}')`, U.burger, /Preço inválido/);
  sql(`select save_product('${burgerId}', ${id}, '{"category":"Bowls","name":"Bowl grande","price":3000,"groups":[]}')`, U.burger);
  assert.equal(sql(`select count(*) from option_groups where product_id = ${id}`), '0');
});

test('pedidos de exemplo e relatório', () => {
  assert.equal(sql(`select generate_demo_orders('${burgerId}', 12)`, U.burger), '12');
  const r = json(`store_report('${burgerId}', 7)`, U.burger);
  assert.ok(r.orders >= 10, JSON.stringify(r));
  assert.ok(r.revenue > 0 && r.avgDeliveryMin > 0 && r.top.length > 0 && r.couriers.length > 0);
  assert.equal(sql(`select count(*) from orders where tenant_id = '${burgerId}' and status = 'cancelado'`), '1');
});

test('plataforma: visão geral, troca de plano e suspensão', () => {
  fails(`select platform_overview()`, U.pizza, /Sem permissão/);
  const o = json('platform_overview()', U.admin);
  assert.equal(o.tenants.length, 2);
  assert.equal(o.mrr, 34900 + 14900);
  sql(`select platform_update_tenant('${burgerId}', null, false)`, U.admin);
  assert.equal(sql(`select count(*) from tenants where slug = 'brasa'`, null), '0');
  assert.equal(sql(`select count(*) from products where tenant_id = '${burgerId}'`, null), '0');
  assert.equal(sql(`select count(*) from orders where tenant_id = '${burgerId}'`, U.burger), '0');
  assert.throws(() => order('brasa', { customer, fulfillment: 'pickup', payment: 'Pix', items: [] }), /não encontrada/);
  sql(`select platform_update_tenant('${burgerId}', 'Básico', true)`, U.admin);
});

test('limite mensal do plano Básico', () => {
  sql(`update plans set monthly_orders = 12 where name = 'Básico'`);
  const p = menu('brasa').find(x => x.groups.length === 0);
  assert.throws(() => order('brasa', { customer, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] }), /limite/);
  sql(`update plans set monthly_orders = 300 where name = 'Básico'`);
});
