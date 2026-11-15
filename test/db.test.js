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
  const head = as === 'admin' ? '' : as === null ? 'set local role anon;' : as === 'service' ? 'set local role service_role;' : `set local role authenticated; set local request.jwt.claim.sub = '${as}';`;
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
  for (const f of ['20261113000000_balcao.sql', '20261114000000_horarios_fotos.sql', '20261115000000_pix_online.sql', '20261116000000_assinaturas.sql', '20261117000000_entregador_clientes_lgpd.sql', '20261118000000_distancia_fidelidade.sql', '20261119000000_balcao_mesa_caixa.sql', '20261120000000_cupons_avaliacoes_estoque.sql', '20261121000000_agendamento_vitrine.sql', '20261122000000_promocoes.sql']) psql(['-d', DB, '-f', path.join(ROOT, 'supabase/migrations', f)]);
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
  // pedido mínimo vale para entrega (retirada e mesa não)
  assert.throws(() => order('forno-da-vila', { ...base, fulfillment: 'delivery', zoneId: zones('forno-da-vila')[0].id, address: 'Rua A, 10', items: [{ productId: a.id, qty: 1, optionIds: [a.groups[0].options[0].id] }] }), /mínimo/);
  assert.ok(order('forno-da-vila', { ...base, items: [{ productId: a.id, qty: 1, optionIds: [a.groups[0].options[0].id] }] }).code);
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
  assert.equal(o.mrr, 0);                         // ninguém pagando ainda: as duas estão no teste grátis
  assert.equal(o.potentialMrr, 34900 + 14900);
  assert.equal(o.trials, 2);
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

test('horário automático: dentro, fora e virada da meia-noite', () => {
  const at = (iso) => sql(`select store_open_at(t, '${iso}'::timestamptz) from tenants t where id = '${pizzaId}'`);
  // sexta (5): 18:00–02:00 | sábado (6): 11:00–14:00 ; horário de São Paulo (-03)
  sql(`update tenants set auto_hours = true, hours = '{"5":[["18:00","02:00"]],"6":[["11:00","14:00"]]}' where id = '${pizzaId}'`, U.pizza);
  assert.equal(at('2026-11-13T19:00:00-03:00'), 't');   // sexta 19h
  assert.equal(at('2026-11-13T17:59:00-03:00'), 'f');   // sexta antes de abrir
  assert.equal(at('2026-11-14T01:30:00-03:00'), 't');   // sábado 1h30, ainda faixa de sexta
  assert.equal(at('2026-11-14T02:00:00-03:00'), 'f');   // fechou às 2h
  assert.equal(at('2026-11-14T12:00:00-03:00'), 't');   // sábado almoço
  assert.equal(at('2026-11-15T12:00:00-03:00'), 'f');   // domingo sem horário
  fails(`update tenants set hours = '{"9":[["25:00","10:00"]]}' where id = '${pizzaId}'`, U.pizza, /check constraint|valid_hours/);
  sql(`update tenants set auto_hours = false where id = '${pizzaId}'`, U.pizza);
});

test('pedido respeita o horário automático', () => {
  sql(`update tenants set auto_hours = true, hours = '{}' where id = '${pizzaId}'`, U.pizza);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  assert.throws(() => order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] }), /fechada/);
  sql(`update tenants set auto_hours = false where id = '${pizzaId}'`, U.pizza);
  assert.ok(order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] }).code);
});

test('fotos: dono grava só na pasta da própria empresa', () => {
  sql(`insert into storage.objects (bucket_id, name) values ('product-images', '${pizzaId}/foto.jpg')`, U.pizza);
  fails(`insert into storage.objects (bucket_id, name) values ('product-images', '${pizzaId}/hack.jpg')`, U.burger, /row-level security/);
  fails(`insert into storage.objects (bucket_id, name) values ('product-images', '../x.jpg')`, U.pizza, /row-level security/);
  fails(`insert into storage.objects (bucket_id, name) values ('product-images', '${pizzaId}/x.jpg')`, U.staff, /row-level security/);
  const pid = sql(`select id from products where tenant_id = '${pizzaId}' and name = 'Margherita'`);
  const body = (img) => `'{"category":"Pizzas","name":"Margherita","price":4200,"image_path":"${img}"}'`;
  sql(`select save_product('${pizzaId}', ${pid}, ${body(pizzaId + '/foto.jpg')})`, U.pizza);
  assert.equal(sql(`select image_path from products where id = ${pid}`, null), `${pizzaId}/foto.jpg`);
  fails(`select save_product('${pizzaId}', ${pid}, ${body(burgerId + '/foto.jpg')})`, U.pizza, /Foto inválida/);
  fails(`select save_product('${pizzaId}', ${pid}, ${body('http://evil/x.jpg')})`, U.pizza, /Foto inválida/);
});

test('Pix online: configuração do token é só do dono e o token nunca vaza', () => {
  const tok = 'TEST-1234567890123456789012-abcdef';
  fails(`select set_pix_settings('${pizzaId}', 'qualquer', true)`, U.pizza, /Access Token inválido/);
  fails(`select set_pix_settings('${pizzaId}', null, true)`, U.pizza, /Cadastre o Access Token/);
  fails(`select set_pix_settings('${pizzaId}', '${tok}', true)`, U.staff, /Sem permissão/);
  fails(`select set_pix_settings('${pizzaId}', '${tok}', true)`, U.burger, /Sem permissão/);
  const st = json(`set_pix_settings('${pizzaId}', '${tok}', true)`, U.pizza);
  assert.deepEqual([st.configured, st.enabled, st.test, st.hint], [true, true, true, '…cdef']);
  fails(`select * from tenant_pix`, U.pizza, /permission denied/);
  fails(`select * from tenant_pix`, null, /permission denied/);
  fails(`select pix_order('X')`, null, /permission denied/);
  fails(`select pix_token('${pizzaId}')`, U.pizza, /permission denied/);
  assert.equal(sql(`select pix_token('${pizzaId}')`, 'service'), tok);
});

test('Pix online: pedido espera pagamento, entra no preparo quando pago', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const body = { customer, fulfillment: 'pickup', payment: 'Pix online', items: [{ productId: p.id, qty: 2 }] };
  const r = order('forno-da-vila', body);
  assert.equal(r.pix, true);
  const o = json(`pix_order('${r.code}')`, 'service');
  assert.equal(o.status, 'pagamento');
  assert.equal(o.token.startsWith('TEST-'), true);
  assert.equal(sql(`select count(*) from orders where id = ${o.id} and status = 'novo'`, U.pizza), '0');
  fails(`select change_order_status(${o.id}, 'preparo')`, U.pizza, /Não é possível/);
  sql(`select pix_save(${o.id}, 'MP-1', '000201PIX', 'iVBOR', now() + interval '30 minutes')`, 'service');
  assert.equal(json(`track_order('${r.code}')`, null).order.pix.qr, '000201PIX');
  fails(`select pix_apply('${pizzaId}', ${o.id}, 'MP-1', 'approved', ${r.total - 1})`, 'service', /diferente do total/);
  fails(`select pix_apply('${pizzaId}', ${o.id}, 'MP-OUTRO', 'approved', ${r.total})`, 'service', /não corresponde/);
  fails(`select pix_apply('${burgerId}', ${o.id}, 'MP-1', 'approved', ${r.total})`, 'service', /não encontrado/);
  assert.equal(sql(`select pix_apply('${pizzaId}', ${o.id}, 'MP-1', 'approved', ${r.total})`, 'service'), 'novo');
  assert.equal(sql(`select pix_apply('${pizzaId}', ${o.id}, 'MP-1', 'approved', ${r.total})`, 'service'), 'novo');
  assert.equal(sql(`select count(*) from order_events where order_id = ${o.id} and status = 'novo'`), '1');
  const t = json(`track_order('${r.code}')`, null).order;
  assert.deepEqual([t.status, t.paymentStatus, t.pix], ['novo', 'paid', null]);
});

test('Pix online: expira, mas pagamento atrasado ainda vale', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const r = order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix online', items: [{ productId: p.id, qty: 1 }] });
  const id = json(`pix_order('${r.code}')`, 'service').id;
  sql(`update orders set created_at = now() - interval '2 hours' where id = ${id}`);
  assert.ok(+sql(`select pix_expire_overdue()`, 'service') >= 1);
  assert.equal(sql(`select status || '/' || payment_status from orders where id = ${id}`), 'cancelado/expired');
  assert.equal(sql(`select pix_apply('${pizzaId}', ${id}, 'MP-9', 'approved', ${r.total})`, 'service'), 'novo');
  // loja não aceita mais Pix online -> pedido recusado
  sql(`select set_pix_settings('${pizzaId}', null, false)`, U.pizza);
  assert.throws(() => order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix online', items: [{ productId: p.id, qty: 1 }] }), /não aceita Pix online/);
});

test('relatório ignora pedidos aguardando pagamento', () => {
  sql(`select set_pix_settings('${pizzaId}', null, true)`, U.pizza);
  const before = json(`store_report('${pizzaId}', 7)`, U.pizza).orders;
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix online', items: [{ productId: p.id, qty: 1 }] });
  assert.equal(json(`store_report('${pizzaId}', 7)`, U.pizza).orders, before);
});

test('assinatura: teste grátis, vencimento, carência e bloqueio de pedidos', () => {
  const info = json(`billing_info('${pizzaId}')`, U.pizza);
  assert.equal(info.status, 'trial'); assert.equal(info.ok, true); assert.ok(info.daysLeft >= 13);
  fails(`select billing_info('${pizzaId}')`, U.staff, /Sem permissão/);
  fails(`update tenants set billing_status = 'free' where id = '${pizzaId}'`, U.pizza, /permission denied/);
  const ok = (iso) => sql(`select billing_ok(t, '${iso}'::timestamptz) from tenants t where id = '${pizzaId}'`);
  sql(`update tenants set billing_status = 'active', paid_until = '2026-12-01T00:00:00Z' where id = '${pizzaId}'`);
  assert.equal(ok('2026-12-03T00:00:00Z'), 't');   // dentro da carência de 3 dias
  assert.equal(ok('2026-12-04T01:00:00Z'), 'f');
  sql(`update tenants set billing_status = 'trial', trial_ends_at = now() - interval '1 hour' where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  assert.throws(() => order('forno-da-vila', { customer, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] }), /indisponível/);
  // a loja continua visível e o dono continua acessando o painel
  assert.equal(sql(`select count(*) from tenants where slug = 'forno-da-vila'`, null), '1');
  assert.equal(json(`billing_info('${pizzaId}')`, U.pizza).ok, false);
});

test('assinatura: confirmação do Mercado Pago libera e cancelamento bloqueia', () => {
  fails(`select billing_apply('${pizzaId}', 'PRE-1', 'authorized', now() + interval '30 days')`, U.pizza, /permission denied/);
  assert.equal(sql(`select billing_apply('${pizzaId}', 'PRE-1', 'authorized', now() + interval '30 days')`, 'service'), 'active');
  assert.equal(json(`billing_info('${pizzaId}')`, U.pizza).ok, true);
  // aviso atrasado de uma assinatura antiga cancelada não derruba a nova
  assert.equal(sql(`select billing_apply('${pizzaId}', 'PRE-ANTIGA', 'cancelled', null)`, 'service'), 'active');
  assert.equal(sql(`select billing_apply('${pizzaId}', 'PRE-1', 'paused', null)`, 'service'), 'past_due');
  assert.equal(json(`billing_info('${pizzaId}')`, U.pizza).ok, true);   // ainda pago até a data
  assert.equal(sql(`select billing_apply('${pizzaId}', 'PRE-1', 'cancelled', null)`, 'service'), 'canceled');
  sql(`update tenants set paid_until = now() - interval '5 days' where id = '${pizzaId}'`);
  assert.equal(json(`billing_info('${pizzaId}')`, U.pizza).ok, false);
  const t = json(`billing_tenant('${pizzaId}')`, 'service');
  assert.equal(t.owners[0].email, 'dono@pizza.test');
  assert.equal(t.price, 34900);
});

test('assinatura: plataforma libera grátis ou dá dias', () => {
  fails(`select platform_set_billing('${pizzaId}', 'free')`, U.pizza, /Sem permissão/);
  sql(`select platform_set_billing('${pizzaId}', 'active', 30)`, U.admin);
  const i = json(`billing_info('${pizzaId}')`, U.pizza);
  assert.equal(i.status, 'active'); assert.ok(i.daysLeft >= 29 && i.daysLeft <= 30);
  sql(`select platform_set_billing('${pizzaId}', 'free')`, U.admin);
  assert.equal(sql(`select billing_apply('${pizzaId}', 'PRE-1', 'cancelled', null)`, 'service'), 'free');
  const o = json('platform_overview()', U.admin);
  assert.equal(typeof o.paying, 'number'); assert.ok('trials' in o);
  assert.equal(o.tenants.find(x => x.id === pizzaId).canSell, true);
});

test('entregador: link secreto mostra só as entregas dele e permite marcar entregue', () => {
  sql(`update tenants set billing_status = 'free' where id = '${burgerId}'`);
  const c = sql(`insert into couriers (tenant_id, name, phone) values ('${burgerId}', 'Lia', '11911112222') returning id`, U.burger);
  fails(`select access_token from couriers where id = ${c}`, U.burger, /permission denied/);
  assert.equal(sql(`select count(*) from (select id, name from couriers where id = ${c}) x`, U.burger), '1');
  fails(`select courier_link(${c})`, U.pizza, /Sem permissão/);
  fails(`select courier_link(${c})`, U.staff, /Sem permissão/);
  const tok = sql(`select courier_link(${c})`, U.burger);
  assert.equal(tok.length, 64);
  // despacha um pedido pronto de entrega para a Lia
  const p = menu('brasa').find(x => x.groups.length === 0);
  const r = order('brasa', { customer, fulfillment: 'delivery', zoneId: zones('brasa')[0].id, address: 'Rua C, 30', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] });
  const oid = sql(`select id from orders where public_code = '${r.code}'`);
  sql(`select change_order_status(${oid}, 'preparo'); select change_order_status(${oid}, 'pronto'); select change_order_status(${oid}, 'rota', ${c})`, U.burger);
  const portal = json(`courier_portal('${tok}')`, null);
  assert.equal(portal.courier.name, 'Lia');
  assert.equal(portal.deliveries.length, 1);
  assert.equal(portal.deliveries[0].address, 'Rua C, 30');
  assert.equal(sql(`select courier_portal('curto')`, null), '');
  fails(`select courier_deliver('${'x'.repeat(64)}', ${oid})`, null, /Link inválido/);
  sql(`select courier_deliver('${tok}', ${oid})`, null);
  assert.equal(sql(`select status from orders where id = ${oid}`), 'entregue');
  fails(`select courier_deliver('${tok}', ${oid})`, null, /não encontrada/);
  assert.equal(json(`courier_portal('${tok}')`, null).today.deliveries, 1);
  // trocar o link invalida o antigo
  const tok2 = sql(`select courier_link(${c}, true)`, U.burger);
  assert.notEqual(tok2, tok);
  assert.equal(sql(`select courier_portal('${tok}')`, null), '');
});

test('clientes: lista agrupada por telefone, busca e exclusão de dados (LGPD)', () => {
  const list = json(`store_customers('${burgerId}')`, U.burger);
  assert.ok(list.length >= 5);
  const maria = list.find(x => x.phone === '11999990000');
  assert.ok(maria.orders >= 1 && maria.spent > 0);
  assert.equal(json(`store_customers('${burgerId}', 'Ana')`, U.burger).every(x => /Ana/.test(x.name)), true);
  assert.ok(json(`store_customers('${burgerId}', '99999')`, U.burger).length >= 1);
  fails(`select store_customers('${burgerId}')`, U.pizza, /Sem permissão/);
  fails(`select anonymize_customer('${burgerId}', '11999990000')`, U.staff, /Sem permissão/);
  const n = +sql(`select anonymize_customer('${burgerId}', '(11) 99999-0000')`, U.burger);
  assert.ok(n >= 1);
  assert.equal(sql(`select count(*) from orders where tenant_id = '${burgerId}' and customer_phone = '11999990000'`), '0');
  assert.equal(json(`store_customers('${burgerId}')`, U.burger).some(x => x.phone === '11999990000'), false);
  // pedidos da pizzaria com o mesmo telefone não são afetados
  assert.ok(+sql(`select count(*) from orders where tenant_id = '${pizzaId}' and customer_phone = '11999990000'`) > 0);
});

test('LGPD: retenção e exclusão da loja', () => {
  sql(`update orders set created_at = now() - interval '30 months' where id = (select min(id) from orders where tenant_id = '${pizzaId}')`);
  fails(`select anonymize_old_orders(24)`, U.pizza, /Sem permissão/);
  assert.equal(sql(`select anonymize_old_orders(24)`, U.admin), '1');
  assert.equal(sql(`select anonymize_old_orders(24)`, 'service'), '0');
  assert.equal(sql(`select anonymize_old_orders(24)`), '0');
  fails(`select delete_my_tenant('${burgerId}', 'errado')`, U.burger, /para confirmar/);
  fails(`select delete_my_tenant('${burgerId}', 'brasa')`, U.staff, /Sem permissão/);
  sql(`select delete_my_tenant('${burgerId}', 'brasa')`, U.burger);
  assert.equal(sql(`select count(*) from tenants where id = '${burgerId}'`), '0');
  assert.equal(sql(`select count(*) from orders where tenant_id = '${burgerId}'`), '0');
});

test('entrega por distância: faixas, fora da área e cálculo no banco', () => {
  // loja na Praça da Sé (SP)
  fails(`update tenants set delivery_mode = 'distance', lat = null where id = '${pizzaId}'`, U.pizza, /check constraint/);
  fails(`update tenants set distance_tiers = '[[0, 100]]' where id = '${pizzaId}'`, U.pizza, /check constraint|valid_tiers/);
  sql(`update tenants set delivery_mode = 'distance', lat = -23.5503, lng = -46.6339, distance_tiers = '[[2, 500], [5, 800], [8, 1200]]' where id = '${pizzaId}'`, U.pizza);
  // Av. Paulista (~2,6 km em linha reta) -> faixa de até 5 km
  const q = json(`delivery_quote('forno-da-vila', -23.5614, -46.6559)`, null);
  assert.ok(q.km > 2 && q.km < 3, JSON.stringify(q)); assert.equal(q.fee, 800); assert.equal(q.inArea, true);
  const far = json(`delivery_quote('forno-da-vila', -23.0, -46.0)`, null);
  assert.equal(far.inArea, false); assert.equal(far.fee, null);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const base = { customer: { name: 'Teo', phone: '11955554444' }, fulfillment: 'delivery', address: 'Av. Paulista, 1000', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] };
  const r = order('forno-da-vila', { ...base, lat: -23.5614, lng: -46.6559, zoneId: 999999 });
  assert.equal(r.total, p.price + 800);
  assert.equal(sql(`select delivery_km || '|' || zone_name from orders where public_code = '${r.code}'`), sql(`select delivery_km || '|' || replace(delivery_km::text, '.', ',') || ' km' from orders where public_code = '${r.code}'`));
  assert.throws(() => order('forno-da-vila', { ...base, lat: -23.0, lng: -46.0 }), /fora da área/);
  assert.throws(() => order('forno-da-vila', base), /localizar o endereço/);
  assert.throws(() => order('forno-da-vila', { ...base, lat: 'x; drop table orders', lng: 1 }), /localizar o endereço/);
  // retirada continua sem taxa e sem localização
  assert.ok(order('forno-da-vila', { ...base, fulfillment: 'pickup' }).code);
  sql(`update tenants set delivery_mode = 'zones' where id = '${pizzaId}'`, U.pizza);
});

test('fidelidade: selos por pedido entregue e desconto automático no próximo', () => {
  fails(`update tenants set loyalty_every = 1 where id = '${pizzaId}'`, U.pizza, /check constraint/);
  sql(`update tenants set loyalty_enabled = true, loyalty_every = 3, loyalty_percent = 20 where id = '${pizzaId}'`, U.pizza);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const c2 = { name: 'Fiel', phone: '(21) 97777-6666' };
  const mk = (extra = {}) => order('forno-da-vila', { customer: c2, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 2 }], ...extra });
  const deliver = code => { const id = sql(`select id from orders where public_code = '${code}'`);
    sql(`select change_order_status(${id}, 'preparo'); select change_order_status(${id}, 'pronto'); select change_order_status(${id}, 'entregue')`, U.pizza); };
  for (let i = 0; i < 3; i++) { const r = mk(); assert.equal(r.total, p.price * 2); deliver(r.code); }
  assert.equal(json(`store_customers('${pizzaId}', '97777')`, U.pizza)[0].stamps, 3);
  const prize = mk();                                   // 3 selos -> 20% neste pedido
  assert.equal(prize.total, p.price * 2 - Math.round(p.price * 2 * 0.2));
  const tr = json(`track_order('${prize.code}')`, null).order;
  assert.equal(tr.loyaltyDiscount, Math.round(p.price * 2 * 0.2));
  assert.equal(tr.loyalty.stamps, 0);                   // prêmio usado: selos zeram
  assert.equal(mk().total, p.price * 2);                // próximo pedido sem desconto
  // se o pedido premiado for cancelado, o prêmio volta
  sql(`select change_order_status((select id from orders where public_code = '${prize.code}'), 'cancelado')`, U.pizza);
  assert.equal(json(`store_customers('${pizzaId}', '97777')`, U.pizza)[0].stamps, 3);
  // cupom maior que a fidelidade: vale o cupom
  sql(`update tenants set loyalty_percent = 5 where id = '${pizzaId}'`, U.pizza);
  const withCoupon = mk({ coupon: 'PRIMEIRA10' });
  assert.equal(withCoupon.total, p.price * 2 - Math.round(p.price * 2 * 0.1));
  assert.equal(sql(`select coalesce(coupon_code, '-') || '/' || loyalty_discount from orders where public_code = '${withCoupon.code}'`), 'PRIMEIRA10/0');
});

test('mesa por QR Code: só com mesas ativas, sem taxa, paga no caixa', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const t = { customer: { name: 'Bia' }, fulfillment: 'table', table: '7', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 3 }] };
  assert.throws(() => order('forno-da-vila', t), /não atende pedidos na mesa/);
  sql(`update tenants set allow_tables = true, tables_count = 20, min_order = 999999 where id = '${pizzaId}'`, U.pizza);
  const r = order('forno-da-vila', t);                       // pedido mínimo não vale para mesa
  assert.equal(r.total, p.price * 3);
  assert.equal(sql(`select channel || '|' || fulfillment || '|' || table_label || '|' || zone_name || '|' || fee from orders where public_code = '${r.code}'`), 'mesa|table|7|Mesa 7|0');
  assert.throws(() => order('forno-da-vila', { ...t, table: "1'; drop" }), /Mesa inválida/);
  assert.throws(() => order('forno-da-vila', { ...t, fulfillment: 'pickup', customer: { name: 'Bia', phone: '11912345678' } }), /pagamento inválida/);   // pagar no caixa só na mesa pelo site
  assert.throws(() => order('forno-da-vila', { ...t, customer: { name: '' } }), /Informe o nome/);
  const id = sql(`select id from orders where public_code = '${r.code}'`);
  sql(`select change_order_status(${id}, 'preparo'); select change_order_status(${id}, 'pronto')`, U.pizza);
  fails(`select change_order_status(${id}, 'rota', 1)`, U.pizza, /retirada não sai|Pedido de retirada/);
  sql(`select change_order_status(${id}, 'entregue')`, U.pizza);
  sql(`update tenants set min_order = 0 where id = '${pizzaId}'`, U.pizza);
});

test('pedido lançado pela equipe: balcão sem telefone, já em preparo', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const body = (extra) => JSON.stringify({ channel: 'balcao', customer: { name: '' }, fulfillment: 'pickup', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 1 }], ...extra }).replace(/'/g, "''");
  const r = json(`staff_place_order('${pizzaId}', '${body({})}'::jsonb)`, U.staff);
  assert.equal(sql(`select status || '|' || channel || '|' || customer_name from orders where id = ${r.id}`), 'preparo|balcao|Balcão');
  assert.equal(sql(`select string_agg(status, ',' order by id) from order_events where order_id = ${r.id}`), 'preparo');
  // telefone com entrega por bairro (loja está em modo bairros)
  const z = zones('forno-da-vila')[0];
  const tel = json(`staff_place_order('${pizzaId}', '${body({ channel: 'telefone', customer: { name: 'Seu Zé', phone: '1133334444' }, fulfillment: 'delivery', zoneId: z.id, address: 'Rua D, 4', payment: 'Dinheiro', changeFor: 5000 })}'::jsonb)`, U.pizza);
  assert.equal(tel.total, p.price + z.fee);
  fails(`select staff_place_order('${pizzaId}', '${body({ channel: 'telefone', customer: { name: 'Sem Fone' }, fulfillment: 'delivery', zoneId: z.id, address: 'Rua D, 4' })}'::jsonb)`, U.pizza, /telefone válidos/);
  fails(`select staff_place_order('${pizzaId}', '${body({ payment: 'Pix online' })}'::jsonb)`, U.pizza, /No painel/);
  fails(`select staff_place_order('${pizzaId}', '${body({ channel: 'online' })}'::jsonb)`, U.pizza, /Canal inválido/);
  fails(`select staff_place_order('${pizzaId}', '${body({})}'::jsonb)`, U.burger, /Sem permissão/);
  fails(`select staff_place_order('${pizzaId}', '${body({})}'::jsonb)`, null, /permission denied/);
  // loja fechada no site não impede o balcão
  sql(`update tenants set is_open = false where id = '${pizzaId}'`, U.pizza);
  assert.ok(json(`staff_place_order('${pizzaId}', '${body({})}'::jsonb)`, U.pizza).id);
  sql(`update tenants set is_open = true where id = '${pizzaId}'`, U.pizza);
});

test('fechamento de caixa do dia', () => {
  const r = json(`cash_report('${pizzaId}')`, U.staff);
  assert.ok(r.orders > 0);
  assert.equal(r.total, r.subtotal + r.fees - r.discounts);
  assert.equal(r.byPayment.reduce((a, x) => a + x.total, 0), r.total);
  assert.ok(r.byChannel.some(x => x.channel === 'balcao') && r.byChannel.some(x => x.channel === 'mesa'));
  assert.ok(r.byPayment.some(x => x.payment === 'Pagar no caixa'));
  assert.ok(r.cashChange >= 5000 - 500 - 1);
  assert.equal(json(`cash_report('${pizzaId}', '2020-01-01')`, U.pizza).orders, 0);
  fails(`select cash_report('${pizzaId}')`, U.burger, /Sem permissão/);
});

test('cupons: mínimo, validade, limite total, por cliente e 1ª compra', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const mk = (code, phone = '31988887777', qty = 2) => order('forno-da-vila', { customer: { name: 'Cupom', phone }, fulfillment: 'pickup', payment: 'Pix', coupon: code, items: [{ productId: p.id, qty }] });
  sql(`insert into coupons (tenant_id, code, percent, min_subtotal) values ('${pizzaId}', 'MIN50', 10, 5000)`, U.pizza);
  assert.throws(() => mk('MIN50'), /a partir de R\$ 50,00/);
  sql(`insert into coupons (tenant_id, code, percent, valid_until) values ('${pizzaId}', 'VELHO', 10, now() - interval '1 day')`, U.pizza);
  assert.throws(() => mk('VELHO'), /expirou/);
  assert.equal(sql(`select check_coupon('forno-da-vila', 'velho')`, null), '');
  sql(`insert into coupons (tenant_id, code, percent, max_uses) values ('${pizzaId}', 'DOIS', 10, 2)`, U.pizza);
  mk('DOIS', '31911110001'); mk('DOIS', '31911110002');
  assert.throws(() => mk('DOIS', '31911110003'), /limite de usos/);
  assert.equal(json(`check_coupon('forno-da-vila', 'dois')`, null).soldOut, true);
  sql(`insert into coupons (tenant_id, code, percent, max_per_customer) values ('${pizzaId}', 'UMPOR', 10, 1)`, U.pizza);
  mk('UMPOR', '31922220001');
  assert.throws(() => mk('UMPOR', '(31) 92222-0001'), /máximo de vezes/);
  assert.ok(mk('UMPOR', '31922220002').code);
  sql(`insert into coupons (tenant_id, code, percent, first_order_only) values ('${pizzaId}', 'BEMVINDO', 15, true)`, U.pizza);
  assert.ok(mk('BEMVINDO', '31933330001').code);
  assert.throws(() => mk('BEMVINDO', '31933330001'), /primeira compra/);
  assert.equal(json(`coupon_usage('${pizzaId}')`, U.pizza).DOIS, 2);
  fails(`select coupon_usage('${pizzaId}')`, U.staff, /Sem permissão/);
});

test('estoque: baixa no pedido, bloqueia sem saldo e devolve no cancelamento', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  fails(`select set_stock(${p.id}, 3)`, U.burger, /Sem permissão/);
  sql(`select set_stock(${p.id}, 3)`, U.staff);
  const mk = qty => order('forno-da-vila', { customer: { name: 'E', phone: '31944440000' }, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty }] });
  const r = mk(2);
  assert.equal(sql(`select stock from products where id = ${p.id}`), '1');
  assert.throws(() => mk(2), /Só restam 1 unidade\(s\) de Água sem gás/);
  assert.equal(sql(`select stock from products where id = ${p.id}`), '1');   // pedido recusado não mexe no estoque
  sql(`select change_order_status((select id from orders where public_code = '${r.code}'), 'cancelado')`, U.pizza);
  assert.equal(sql(`select stock from products where id = ${p.id}`), '3');
  assert.equal(json(`(select jsonb_agg(stock) from products where id = ${p.id})`, null)[0], 3);   // visível na loja
  sql(`select set_stock(${p.id}, null)`, U.pizza);
});

test('avaliações: só após entregue, uma por pedido, nota pública e resposta da loja', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const r = order('forno-da-vila', { customer: { name: 'Carla Dias', phone: '31955550000' }, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] });
  fails(`select review_order('${r.code}', 5, 'Ótimo')`, null, /depois que o pedido for entregue/);
  const id = sql(`select id from orders where public_code = '${r.code}'`);
  sql(`select change_order_status(${id}, 'preparo'); select change_order_status(${id}, 'pronto'); select change_order_status(${id}, 'entregue')`, U.pizza);
  assert.equal(json(`track_order('${r.code}')`, null).order.canReview, true);
  fails(`select review_order('${r.code}', 9, '')`, null, /1 a 5/);
  sql(`select review_order('${r.code}', 5, 'Chegou quentinha!')`, null);
  fails(`select review_order('${r.code}', 4, '')`, null, /já foi avaliado/);
  const t = json(`track_order('${r.code}')`, null).order;
  assert.deepEqual([t.canReview, t.review.rating], [false, 5]);
  fails(`select reply_review(${id}, 'Valeu!')`, U.staff, /Sem permissão/);
  sql(`select reply_review(${id}, 'Obrigado, Carla!')`, U.pizza);
  const pub = json(`store_reviews('forno-da-vila')`, null);
  assert.equal(pub.count, 1); assert.equal(+pub.avg, 5);
  assert.deepEqual([pub.recent[0].name, pub.recent[0].reply], ['Carla', 'Obrigado, Carla!']);
  assert.equal(JSON.stringify(pub).includes('31955550000'), false);
  fails(`select * from order_reviews`, null, /permission denied/);
  assert.equal(sql(`select count(*) from order_reviews`, U.burger), '0');
  // prazo de 7 dias
  const r2 = order('forno-da-vila', { customer: { name: 'X', phone: '31955550001' }, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 1 }] });
  const id2 = sql(`select id from orders where public_code = '${r2.code}'`);
  sql(`select change_order_status(${id2}, 'preparo'); select change_order_status(${id2}, 'pronto'); select change_order_status(${id2}, 'entregue')`, U.pizza);
  sql(`update orders set updated_at = now() - interval '8 days' where id = ${id2}`);
  fails(`select review_order('${r2.code}', 3, '')`, null, /prazo/);
});

test('pedido agendado: antecedência, limite de dias, horário de funcionamento e loja fechada agora', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const at = (sqlExpr) => sql(`select to_char((${sqlExpr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
  const mk = (when) => order('forno-da-vila', { customer: { name: 'Agenda', phone: '31966660000' }, fulfillment: 'pickup', payment: 'Pix', scheduledFor: when, items: [{ productId: p.id, qty: 1 }] });
  assert.throws(() => mk(at("now() + interval '3 hours'")), /não aceita pedidos agendados/);
  sql(`update tenants set allow_scheduling = true, schedule_days = 2, schedule_lead_minutes = 60, auto_hours = false, is_open = true where id = '${pizzaId}'`, U.pizza);
  assert.throws(() => mk(at("now() + interval '20 minutes'")), /60 minutos de antecedência/);
  assert.throws(() => mk(at("now() + interval '5 days'")), /até 2 dia/);
  assert.throws(() => mk('amanhã às 8'), /inválido/);
  const r = mk(at("now() + interval '3 hours'"));
  assert.ok(sql(`select scheduled_for is not null from orders where public_code = '${r.code}'`) === 't');
  assert.ok(json(`track_order('${r.code}')`, null).order.scheduledFor);
  // com horário automático: loja fechada agora aceita agendamento para quando estiver aberta
  const dow = +sql(`select extract(dow from (now() + interval '1 day') at time zone 'America/Sao_Paulo')`);
  sql(`update tenants set auto_hours = true, hours = '{"${dow}":[["10:00","22:00"]]}' where id = '${pizzaId}'`, U.pizza);
  const tomorrow = sql(`select to_char((now() + interval '1 day') at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`);
  assert.ok(mk(`${tomorrow}T12:00:00-03:00`).code);
  assert.throws(() => mk(`${tomorrow}T23:30:00-03:00`), /não funciona nesse horário/);
  // pausa manual bloqueia até agendamento
  sql(`update tenants set is_open = false where id = '${pizzaId}'`, U.pizza);
  assert.throws(() => mk(`${tomorrow}T12:00:00-03:00`), /pausada/);
  sql(`update tenants set is_open = true, auto_hours = false, allow_scheduling = false where id = '${pizzaId}'`, U.pizza);
});

test('vitrine: descrição, endereço, Instagram e banner só da própria pasta', () => {
  sql(`update tenants set description = 'Pizza no forno a lenha desde 1998', address = 'Rua Augusta, 100 - São Paulo', instagram = 'fornodavila' where id = '${pizzaId}'`, U.pizza);
  assert.equal(sql(`select instagram from tenants where slug = 'forno-da-vila'`, null), 'fornodavila');
  fails(`update tenants set instagram = '@forno da vila' where id = '${pizzaId}'`, U.pizza, /check constraint/);
  sql(`update tenants set banner_path = '${pizzaId}/banner.jpg' where id = '${pizzaId}'`, U.pizza);
  fails(`update tenants set banner_path = '00000000-0000-0000-0000-000000000000/x.jpg' where id = '${pizzaId}'`, U.pizza, /check constraint/);
  assert.equal(sql(`update tenants set description = 'hack' where id = '${pizzaId}' returning id`, U.staff), '');
});

test('promoções: leve 3 pague 2, % por categoria, dia/horário e frete grátis acima de valor', () => {
  const m = menu('forno-da-vila'), agua = m.find(x => x.name === 'Água sem gás'), refri = m.find(x => x.name === 'Refrigerante 2L');
  const coke = refri.groups[0].options[0].id;
  const mk = (items, extra = {}) => order('forno-da-vila', { customer: { name: 'Promo', phone: '31977770000' }, fulfillment: 'pickup', payment: 'Pix', items, ...extra });
  sql(`insert into promotions (tenant_id, name, kind, product_id, buy_qty, pay_qty) values ('${pizzaId}', 'Leve 3 pague 2 água', 'buy_x_pay_y', ${agua.id}, 3, 2)`, U.pizza);
  let r = mk([{ productId: agua.id, qty: 7 }]);                 // 7 águas: 2 grátis
  assert.equal(r.total, agua.price * 5);
  assert.equal(json(`track_order('${r.code}')`, null).order.promoNames, 'Leve 3 pague 2 água');
  // % na categoria Bebidas, só num horário que não é agora -> não aplica
  const nowH = +sql(`select extract(hour from now() at time zone 'America/Sao_Paulo')`);
  const off = (nowH + 3) % 24, offEnd = (nowH + 4) % 24;
  sql(`insert into promotions (tenant_id, name, kind, category, percent, start_time, end_time) values ('${pizzaId}', 'Happy hour', 'percent', 'Bebidas', 50, '${off}:00', '${offEnd}:00')`, U.pizza);
  r = mk([{ productId: refri.id, qty: 1, optionIds: [coke] }]);
  assert.equal(r.total, refri.price);
  // agora dentro do horário (faixa que passa da meia-noite também funciona)
  sql(`update promotions set start_time = '${(nowH + 23) % 24}:00', end_time = '${(nowH + 1) % 24}:59' where name = 'Happy hour'`);
  r = mk([{ productId: refri.id, qty: 1, optionIds: [coke] }]);
  assert.equal(r.total, Math.round(refri.price / 2));
  // dia da semana diferente de hoje -> não aplica
  const dow = +sql(`select extract(dow from now() at time zone 'America/Sao_Paulo')`);
  sql(`update promotions set days = array[${(dow + 1) % 7}] where name = 'Happy hour'`);
  assert.equal(mk([{ productId: refri.id, qty: 1, optionIds: [coke] }]).total, refri.price);
  // frete grátis acima de R$ 30
  sql(`update tenants set free_delivery_above = 3000 where id = '${pizzaId}'`, U.pizza);
  const z = zones('forno-da-vila')[0];
  const deliv = (qty) => mk([{ productId: refri.id, qty, optionIds: [coke] }], { fulfillment: 'delivery', zoneId: z.id, address: 'Rua P, 1' });
  assert.equal(deliv(1).total, refri.price + z.fee);
  assert.equal(deliv(3).total, refri.price * 3);
  // segurança: loja não cria promoção com produto de outra loja; anônimo só lê
  fails(`insert into promotions (tenant_id, name, kind, product_id, percent) values ('${pizzaId}', 'x', 'percent', 999999, 10)`, U.pizza, /row-level security/);
  fails(`insert into promotions (tenant_id, name, kind, percent) values ('${pizzaId}', 'x', 'percent', 10)`, U.staff, /row-level security/);
  fails(`insert into promotions (tenant_id, name, kind, buy_qty, pay_qty) values ('${pizzaId}', 'x', 'buy_x_pay_y', 2, 2)`, U.pizza, /check constraint/);
  assert.ok(+sql(`select count(*) from promotions`, null) >= 2);
  // fechamento de caixa soma o desconto das promoções
  const c = json(`cash_report('${pizzaId}')`, U.pizza);
  assert.equal(c.total, c.subtotal + c.fees - c.discounts);
  sql(`update tenants set free_delivery_above = null where id = '${pizzaId}'`, U.pizza);
  sql(`update promotions set active = false where tenant_id = '${pizzaId}'`, U.pizza);
});
