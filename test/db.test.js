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
  // os testes de regras fazem dezenas de pedidos seguidos com o mesmo telefone; o limite de tentativas é testado em security.test.js
  psql(['-d', 'postgres', '-c', `alter database ${DB} set balcao.rate_limit = 'off'`]);
  for (const f of ['20261113000000_balcao.sql', '20261114000000_horarios_fotos.sql', '20261115000000_pix_online.sql', '20261116000000_assinaturas.sql', '20261117000000_entregador_clientes_lgpd.sql', '20261118000000_distancia_fidelidade.sql', '20261119000000_balcao_mesa_caixa.sql', '20261120000000_cupons_avaliacoes_estoque.sql', '20261121000000_agendamento_vitrine.sql', '20261122000000_promocoes.sql', '20261123000000_checagem.sql', '20261124000000_saude_plataforma.sql', '20261125000000_cartao_dominio_unidades.sql', '20261126000000_seguranca.sql', '20261127000000_mesa_servico_pedidos_antigos.sql', '20261128000000_vitrine_previsao_mesas.sql', '20261129000000_pausa_feriados_estacoes.sql', '20261130000000_caixa_acerto_bloqueio.sql', '20261201000000_insumos_financeiro.sql']) psql(['-d', DB, '-f', path.join(ROOT, 'supabase/migrations', f)]);
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

test('checagem: schema_status mostra todas as migrações em dia e funciona para visitantes', () => {
  const st = json(`public.schema_status()`, null);
  assert.equal(st.length, 19);
  assert.ok(st.every(m => m.ok), JSON.stringify(st.filter(m => !m.ok)));
  sql(`alter table orders rename column scheduled_for to scheduled_tmp`);
  try { assert.deepEqual(json(`public.schema_status()`, null).filter(m => !m.ok).map(m => m.n), [9]); }
  finally { sql(`alter table orders rename column scheduled_tmp to scheduled_for`); }
});

test('saúde da plataforma: só o administrador vê; traz dias, lojas paradas e testes acabando', () => {
  fails(`select platform_health()`, U.pizza, /Sem permissão/);
  fails(`select platform_health()`, null, /permission denied/);
  const u = randomUUID(); sql(`insert into auth.users (id, email) values ('${u}', 'parada@loja.test')`);
  const idleId = sql(`select (create_my_tenant('Loja Parada', 'pizzaria', 'parada')).id`, u);
  sql(`update tenants set created_at = now() - interval '20 days' where id = '${idleId}'`);
  sql(`update tenants set billing_status = 'trial', trial_ends_at = now() + interval '2 days' where id = '${pizzaId}'`);
  const h = json(`platform_health(14)`, U.admin);
  assert.equal(h.days.length, 14);
  assert.ok(h.days.every(d => 'orders' in d && 'signups' in d));
  assert.ok(h.idle.some(t => t.id === idleId), 'loja sem pedidos há 20 dias aparece como parada');
  assert.ok(!h.idle.some(t => t.id === pizzaId), 'loja com pedidos recentes não aparece');
  assert.ok(h.trialsEnding.some(t => t.id === pizzaId));
  assert.ok(h.activeStores7d >= 1);
});

test('cartão online: só com token, pedido espera aprovação, recusa não cancela e o painel não lança', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', allow_pickup = true, min_order = 0 where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const body = { customer, fulfillment: 'pickup', payment: 'Cartão online', items: [{ productId: p.id, qty: 1 }] };
  assert.throws(() => order('forno-da-vila', body), /não aceita cartão online/);
  fails(`select set_card_online('${pizzaId}', true)`, U.burger, /Sem permissão/);
  assert.equal(json(`set_card_online('${pizzaId}', true)`, U.pizza).cardEnabled, true);
  const r = order('forno-da-vila', body);
  assert.deepEqual([r.card, r.pix], [true, false]);
  const o = json(`pix_order('${r.code}')`, 'service');
  assert.deepEqual([o.status, o.paymentStatus, o.cardOnline, o.storeSlug], ['pagamento', 'pending', true, 'forno-da-vila']);
  // cartão recusado: o pedido continua esperando outra tentativa
  assert.equal(sql(`select pix_apply('${pizzaId}', ${o.id}, 'MP-A', 'rejected', ${r.total})`, 'service'), 'pagamento');
  // outra tentativa (outro pagamento) aprovada
  assert.equal(sql(`select pix_apply('${pizzaId}', ${o.id}, 'MP-B', 'approved', ${r.total})`, 'service'), 'novo');
  assert.equal(sql(`select pix_apply('${pizzaId}', ${o.id}, 'MP-C', 'approved', ${r.total})`, 'service'), 'novo');
  assert.equal(json(`track_order('${r.code}')`, null).order.paymentStatus, 'paid');
  fails(`select staff_place_order('${pizzaId}', '${JSON.stringify({ ...body, channel: 'balcao' })}'::jsonb)`, U.pizza, /No painel/);
  sql(`select set_card_online('${pizzaId}', false)`, U.pizza);
});

test('domínio próprio: validação, unicidade e busca pelo endereço', () => {
  fails(`select set_custom_domain('${pizzaId}', 'x.com')`, U.burger, /Sem permissão/);
  fails(`select set_custom_domain('${pizzaId}', 'não é domínio')`, U.pizza, /Domínio inválido/);
  fails(`select set_custom_domain('${pizzaId}', 'loja.vercel.app')`, U.pizza, /domínio seu/);
  assert.equal(sql(`select set_custom_domain('${pizzaId}', 'https://Pedidos.FornoDaVila.com.br/')`, U.pizza), 'pedidos.fornodavila.com.br');
  const u2 = randomUUID(); sql(`insert into auth.users (id, email) values ('${u2}', 'dominio@loja.test')`);
  const otherId = sql(`select (create_my_tenant('Outra Loja', 'pizzaria', 'outra-loja')).id`, u2);
  fails(`select set_custom_domain('${otherId}', 'pedidos.fornodavila.com.br')`, u2, /já está em uso/);
  assert.equal(sql(`select store_by_domain('pedidos.fornodavila.com.br')`, null), 'forno-da-vila');
  assert.equal(sql(`select store_by_domain('www.pedidos.fornodavila.com.br')`, null), 'forno-da-vila');
  assert.equal(sql(`select coalesce(store_by_domain('outro.com'), 'nada')`, null), 'nada');
  fails(`select platform_domains()`, U.pizza, /Sem permissão/);
  assert.equal(json(`platform_domains()`, U.admin)[0].domain, 'pedidos.fornodavila.com.br');
  assert.equal(sql(`select coalesce(set_custom_domain('${pizzaId}', ''), 'removido')`, U.pizza), 'removido');
});

test('várias unidades: copia cardápio, opções, zonas e promoções; resumo só das lojas do dono', () => {
  fails(`select create_unit('${pizzaId}', 'Filial', null)`, U.burger, /Sem permissão/);
  fails(`select create_unit('${pizzaId}', 'Filial', null)`, U.staff, /Sem permissão/);
  const src = menu('forno-da-vila');
  const promoProd = src.find(x => x.groups.length) || src[0];
  sql(`insert into promotions (tenant_id, name, kind, product_id, percent, active) values ('${pizzaId}', 'Promo item', 'percent', ${promoProd.id}, 10, true)`);
  const u = json(`(select to_jsonb(create_unit('${pizzaId}', 'Forno da Vila Centro', 'forno-centro')))`, U.pizza);
  assert.equal(u.slug, 'forno-centro');
  const dst = menu('forno-centro');
  assert.equal(dst.length, src.length);
  assert.deepEqual(dst.map(x => [x.name, x.price, x.groups.length]).sort(), src.map(x => [x.name, x.price, x.groups.length]).sort());
  assert.ok(dst.every(x => !src.some(s => s.id === x.id)), 'produtos são cópias novas');
  assert.equal(sql(`select count(*) from zones where tenant_id = '${u.id}'`), sql(`select count(*) from zones where tenant_id = '${pizzaId}'`));
  const pm = json(`(select to_jsonb(p) from promotions p where tenant_id = '${u.id}' and name = 'Promo item')`);
  assert.equal(pm.product_id, dst.find(x => x.name === promoProd.name).id);
  assert.equal(sql(`select role from memberships where tenant_id = '${u.id}' and user_id = '${U.pizza}'`), 'owner');
  const units = json(`my_units()`, U.pizza);
  assert.deepEqual(units.map(x => x.slug).sort(), ['forno-centro', 'forno-da-vila']);
  assert.ok(units.every(x => 'today' in x && 'month' in x));
  assert.deepEqual(json(`my_units()`, U.staff), []);
});

test('taxa de serviço na mesa: % sobre os produtos, opcional para o cliente, aparece no acompanhamento e no caixa', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', allow_tables = true, service_percent = 10, min_order = 0 where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const base = { customer: { name: 'Mesa Teste', phone: '11933332222' }, fulfillment: 'table', table: '7', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 4 }] };
  const r = order('forno-da-vila', base);
  assert.equal(r.total, p.price * 4 + Math.round(p.price * 4 * 0.1));
  const t = json(`track_order('${r.code}')`, null).order;
  assert.equal(t.serviceFee, Math.round(p.price * 4 * 0.1));
  const r2 = order('forno-da-vila', { ...base, service: false });
  assert.equal(r2.total, p.price * 4);
  // entrega e retirada não têm taxa de serviço
  const r3 = order('forno-da-vila', { ...base, fulfillment: 'pickup', payment: 'Dinheiro' });
  assert.equal(r3.total, p.price * 4);
  assert.ok(json(`cash_report('${pizzaId}')`, U.pizza).serviceFees >= Math.round(p.price * 4 * 0.1));
  fails(`update tenants set service_percent = 50 where id = '${pizzaId}'`, U.pizza, /check constraint/);
  sql(`update tenants set service_percent = 0 where id = '${pizzaId}'`);
});

test('pedidos esquecidos: encerra só os abertos há mais tempo, com permissão da loja', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const r = order('forno-da-vila', { customer: { name: 'Antigo', phone: '11922221111' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] });
  const fresh = order('forno-da-vila', { customer: { name: 'Novo', phone: '11922221112' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] });
  sql(`update orders set created_at = now() - interval '30 hours' where public_code = '${r.code}'`);
  fails(`select close_stale_orders('${pizzaId}', 12, 'entregue')`, U.burger, /Sem permissão/);
  fails(`select close_stale_orders('${pizzaId}', 1, 'entregue')`, U.pizza, /mais de 2 horas/);
  fails(`select close_stale_orders('${pizzaId}', 12, 'pago')`, U.pizza, /entregue ou cancelado/);
  assert.ok(+sql(`select close_stale_orders('${pizzaId}', 12, 'entregue')`, U.staff) >= 1);
  assert.equal(sql(`select status from orders where public_code = '${r.code}'`), 'entregue');
  assert.equal(sql(`select status from orders where public_code = '${fresh.code}'`), 'novo');
  assert.equal(sql(`select count(*) from order_events e join orders o on o.id = e.order_id where o.public_code = '${r.code}' and e.status = 'entregue'`), '1');
});

test('categorias com horário: fora da janela o pedido é recusado com o horário; dentro passa', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0, allow_pickup = true, timezone = 'America/Sao_Paulo' where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  p.category = sql(`select category from products where id = ${p.id}`);
  const now = sql(`select to_char(now() at time zone 'America/Sao_Paulo', 'HH24:MI')`);
  const base = { customer: { name: 'Hora', phone: '11944443333' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  // janela que acabou de fechar (termina agora) → recusa
  sql(`update tenants set category_hours = jsonb_build_object('${p.category}', jsonb_build_object('from', to_char((now() at time zone 'America/Sao_Paulo') - interval '2 hours', 'HH24:MI'), 'to', '${now}')) where id = '${pizzaId}'`);
  assert.throws(() => order('forno-da-vila', base), new RegExp(`"${p.category}" só é vendido das`));
  // janela aberta agora (inclusive atravessando a meia-noite) → passa
  sql(`update tenants set category_hours = jsonb_build_object('${p.category}', jsonb_build_object('from', to_char((now() at time zone 'America/Sao_Paulo') - interval '1 hour', 'HH24:MI'), 'to', to_char((now() at time zone 'America/Sao_Paulo') + interval '1 hour', 'HH24:MI'))) where id = '${pizzaId}'`);
  assert.ok(order('forno-da-vila', base).code);
  // dia da semana fora da lista → recusa
  sql(`update tenants set category_hours = jsonb_build_object('${p.category}', jsonb_build_object('from', '00:00', 'to', '23:59', 'days', jsonb_build_array((extract(dow from now() at time zone 'America/Sao_Paulo')::int + 1) % 7))) where id = '${pizzaId}'`);
  assert.throws(() => order('forno-da-vila', base), /só é vendido/);
  sql(`update tenants set category_hours = '{}' where id = '${pizzaId}'`);
});

test('previsão: mediana do histórico da loja; sem histórico não inventa número', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const base = { customer: { name: 'Prev', phone: '11955554433' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  sql(`delete from order_events where tenant_id = '${pizzaId}' and status = 'pronto'`);
  const first = order('forno-da-vila', base);
  assert.equal(json(`track_order('${first.code}')`, null).order.etaAt, null);
  for (const m of [18, 20, 22, 25, 30]) {
    const r = order('forno-da-vila', base);
    sql(`update orders set created_at = now() - interval '${m + 60} minutes' where public_code = '${r.code}';
         insert into order_events (order_id, tenant_id, status, at) select id, tenant_id, 'pronto', now() - interval '60 minutes' from orders where public_code = '${r.code}'`);
  }
  const t = json(`track_order('${first.code}')`, null).order;
  const mins = Math.round((new Date(t.etaAt) - new Date(sql(`select created_at from orders where public_code = '${first.code}'`))) / 60000);
  assert.equal(mins, 22);
  assert.equal(json(`store_eta('forno-da-vila')`, null).pickup, 22);
  assert.throws(() => sql(`select typical_minutes('${pizzaId}', 'pickup')`, null), /permission denied/);
});

test('mais pedidos: só produtos com 3+ pedidos, do mais vendido para o menos', () => {
  const ps = menu('forno-da-vila').filter(x => !x.groups.length).slice(0, 2);
  sql(`update tenants set category_hours = '{}' where id = '${pizzaId}'`);
  for (let i = 0; i < 3; i++) order('forno-da-vila', { customer: { name: 'Pop', phone: `1196666${String(i).padStart(4, '0')}` }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: ps[1].id, qty: 5 }] });
  const top = json(`popular_products('forno-da-vila')`, null);
  assert.equal(top[0], ps[1].id);
  sql(`update products set available = false where id = ${ps[1].id}`);
  assert.ok(!json(`popular_products('forno-da-vila')`, null).includes(ps[1].id), 'esgotado sai da vitrine');
  sql(`update products set available = true where id = ${ps[1].id}`);
});

test('conta da mesa: soma os pedidos, fecha com a forma de pagamento e some da lista', () => {
  sql(`update tenants set allow_tables = true, service_percent = 10 where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const base = { customer: { name: 'Mesa', phone: '' }, fulfillment: 'table', table: '12', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 2 }] };
  const a = order('forno-da-vila', base), b = order('forno-da-vila', { ...base, items: [{ productId: p.id, qty: 1 }] });
  fails(`select open_tables('${pizzaId}')`, U.burger, /Sem permissão/);
  const m = json(`open_tables('${pizzaId}')`, U.staff).find(x => x.table === '12');
  assert.equal(m.orders.length, 2);
  assert.equal(m.total, a.total + b.total);
  assert.equal(m.items.reduce((s, i) => s + i.qty, 0), 3);
  fails(`select close_table('${pizzaId}', '12', 'Fiado')`, U.staff, /inválida/);
  fails(`select close_table('${pizzaId}', '12', 'Pix')`, U.burger, /Sem permissão/);
  assert.equal(+sql(`select close_table('${pizzaId}', '12', 'Pix')`, U.staff), 2);
  assert.deepEqual(sql(`select string_agg(distinct payment || '/' || status, ',') from orders where public_code in ('${a.code}', '${b.code}')`), 'Pix/entregue');
  assert.ok(!json(`open_tables('${pizzaId}')`, U.staff).some(x => x.table === '12'));
  fails(`select close_table('${pizzaId}', '12', 'Pix')`, U.staff, /Nenhum pedido aberto/);
  sql(`update tenants set service_percent = 0 where id = '${pizzaId}'`);
});

test('pausa rápida: loja pausada não recebe pedido; entregas pausadas aceitam retirada; volta sozinho', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0, allow_pickup = true, closed_dates = '[]', category_hours = '{}' where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const z = json(`(select to_jsonb(z) from zones z where tenant_id = '${pizzaId}' order by id limit 1)`);
  const pick = { customer: { name: 'Pausa', phone: '11977771111' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  const del = { ...pick, fulfillment: 'delivery', zoneId: z.id, address: 'Rua A, 1' };
  fails(`select set_pause('${pizzaId}', 'store', 30)`, U.burger, /Sem permissão/);
  fails(`select set_pause('${pizzaId}', 'tudo', 30)`, U.pizza, /store ou delivery/);
  assert.ok(json(`set_pause('${pizzaId}', 'delivery', 30)`, U.staff).deliveryPausedUntil);
  assert.throws(() => order('forno-da-vila', del), /Entregas pausadas até as/);
  assert.ok(order('forno-da-vila', pick).code);
  // no balcão (telefone) a loja ainda consegue lançar entrega
  assert.ok(json(`staff_place_order('${pizzaId}', '${JSON.stringify({ ...del, channel: 'telefone' })}'::jsonb)`, U.staff).code);
  sql(`select set_pause('${pizzaId}', 'delivery', 0)`, U.staff);
  assert.ok(order('forno-da-vila', del).code);
  sql(`select set_pause('${pizzaId}', 'store', 15)`, U.pizza);
  assert.throws(() => order('forno-da-vila', pick), /fechada/);
  sql(`update tenants set paused_until = now() - interval '1 minute' where id = '${pizzaId}'`);
  assert.ok(order('forno-da-vila', pick).code, 'pausa vencida libera sozinha');
});

test('fechamentos especiais: dia fechado recusa pedido agora e agendado para aquele dia', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const pick = { customer: { name: 'Feriado', phone: '11977772222' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  sql(`update tenants set closed_dates = jsonb_build_array(jsonb_build_object('date', to_char(now() at time zone timezone, 'YYYY-MM-DD'), 'note', 'Feriado')) where id = '${pizzaId}'`);
  assert.throws(() => order('forno-da-vila', pick), /fechada/);
  sql(`update tenants set allow_scheduling = true, schedule_days = 3, schedule_lead_minutes = 30,
       closed_dates = jsonb_build_array(jsonb_build_object('date', to_char((now() + interval '1 day') at time zone timezone, 'YYYY-MM-DD'))) where id = '${pizzaId}'`);
  const when = sql(`select to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
  assert.throws(() => order('forno-da-vila', { ...pick, scheduledFor: when }), /fechada nesse dia/);
  assert.ok(order('forno-da-vila', pick).code, 'hoje não está mais fechado');
  sql(`update tenants set closed_dates = '[]', allow_scheduling = false where id = '${pizzaId}'`);
});

test('mapa de horários e estações: só o dono vê o mapa; estações são gravadas pelo dono', () => {
  fails(`select sales_heatmap('${pizzaId}', 30)`, U.staff, /Sem permissão/);
  const h = json(`sales_heatmap('${pizzaId}', 30)`, U.pizza);
  assert.ok(h.length > 0 && h.every(c => c.dow >= 0 && c.dow <= 6 && c.hour >= 0 && c.hour <= 23 && c.orders > 0));
  sql(`update tenants set stations = '{"Bebidas":"Bar"}' where id = '${pizzaId}'`, U.pizza);
  assert.equal(sql(`select stations->>'Bebidas' from tenants where id = '${pizzaId}'`, null), 'Bar');
  fails(`update tenants set paused_until = null where id = '${pizzaId}'`, U.pizza, /permission denied/);
});

test('caixa por turno: abre com troco, soma vendas em dinheiro, sangria e reforço, fecha com diferença', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0, allow_pickup = true, paused_until = null, delivery_paused_until = null, closed_dates = '[]' where id = '${pizzaId}'`);
  sql(`delete from cash_sessions where tenant_id = '${pizzaId}'`);
  fails(`select cash_open('${pizzaId}', 10000)`, U.burger, /Sem permissão/);
  fails(`select cash_move('${pizzaId}', 'sangria', 100, null)`, U.staff, /Abra o caixa/);
  assert.equal(json(`cash_open('${pizzaId}', 10000)`, U.staff).expected, 10000);
  fails(`select cash_open('${pizzaId}', 5000)`, U.staff, /Já existe um caixa aberto/);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const r = order('forno-da-vila', { customer: { name: 'Caixa', phone: '11988112233' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 2 }] });
  order('forno-da-vila', { customer: { name: 'Caixa Pix', phone: '11988112234' }, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: p.id, qty: 5 }] });
  sql(`select cash_move('${pizzaId}', 'suprimento', 2000, 'moedas')`, U.staff);
  const st = json(`cash_move('${pizzaId}', 'sangria', 5000, 'depósito')`, U.pizza);
  assert.equal(st.cashSales, r.total);
  assert.equal(st.expected, 10000 + r.total + 2000 - 5000);
  assert.equal(st.moves.length, 2);
  fails(`select cash_move('${pizzaId}', 'roubo', 100, null)`, U.staff, /Tipo inválido/);
  const closed = json(`cash_close('${pizzaId}', ${st.expected - 300}, 'faltou troco')`, U.staff);
  assert.equal(closed.open, false);
  assert.equal(closed.last.diff, -300);
  fails(`select cash_close('${pizzaId}', 0, null)`, U.staff, /Nenhum caixa aberto/);
  assert.equal(sql(`select count(*) from cash_sessions where tenant_id = '${pizzaId}'`, U.burger), '0');
});

test('acerto do entregador: entregas, taxas e dinheiro a devolver no dia', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const z = json(`(select to_jsonb(z) from zones z where tenant_id = '${pizzaId}' order by id limit 1)`);
  const cid = sql(`insert into couriers (tenant_id, name, phone) values ('${pizzaId}', 'Zé Acerto', '11955550000') returning id`);
  const mk = pay => order('forno-da-vila', { customer: { name: 'Ac', phone: `119777${Math.floor(Math.random() * 1e5).toString().padStart(5, '0')}` }, fulfillment: 'delivery', zoneId: z.id, address: 'Rua B, 2', payment: pay, items: [{ productId: p.id, qty: 1 }] });
  const a = mk('Dinheiro'), b = mk('Cartão na entrega'), c = mk('Dinheiro');
  sql(`update orders set courier_id = ${cid}, status = 'entregue' where public_code in ('${a.code}', '${b.code}');
       update orders set courier_id = ${cid}, status = 'rota' where public_code = '${c.code}'`);
  fails(`select courier_settlement('${pizzaId}', null)`, U.burger, /Sem permissão/);
  const z1 = json(`courier_settlement('${pizzaId}', null)`, U.staff).find(x => x.name === 'Zé Acerto');
  assert.deepEqual([z1.deliveries, z1.onRoute, z1.cash, z1.card], [2, 1, a.total, b.total]);
  assert.equal(z1.fees, z.fee * 2);
  assert.equal(z1.orders.length, 3);
});

test('bloqueio de cliente: telefone bloqueado não pede pela loja; só o dono bloqueia', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const base = { customer: { name: 'Trote', phone: '(11) 96543-2100' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  fails(`select set_blocked('${pizzaId}', '11965432100', true, 'trote')`, U.staff, /Sem permissão/);
  fails(`select set_blocked('${pizzaId}', '123', true, null)`, U.pizza, /Telefone inválido/);
  sql(`select set_blocked('${pizzaId}', '+55 11 96543-2100', true, 'trote')`, U.pizza);
  assert.throws(() => order('forno-da-vila', base), /Fale com a loja/);
  assert.equal(sql(`select count(*) from blocked_phones`, U.staff), '0');
  assert.equal(sql(`select count(*) from blocked_phones where tenant_id = '${pizzaId}'`, U.pizza), '1');
  sql(`select set_blocked('${pizzaId}', '11965432100', false, null)`, U.pizza);
  assert.ok(order('forno-da-vila', base).code);
});

test('insumos: ficha técnica baixa na venda, volta no cancelamento, entrada recalcula custo médio', () => {
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0, allow_pickup = true, paused_until = null, closed_dates = '[]', category_hours = '{}' where id = '${pizzaId}'`);
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  fails(`insert into ingredients (tenant_id, name, unit) values ('${pizzaId}', 'Garrafa', 'un')`, U.staff, /row-level security/);
  const g = sql(`insert into ingredients (tenant_id, name, unit, min_stock, unit_cost) values ('${pizzaId}', 'Garrafa', 'un', 5, 150) returning id`, U.pizza);
  const t = sql(`insert into ingredients (tenant_id, name, unit, unit_cost) values ('${pizzaId}', 'Tampa', 'un', 10) returning id`, U.pizza);
  const other = sql(`insert into ingredients (tenant_id, name, unit) select id, 'Pão', 'un' from tenants where id <> '${pizzaId}' limit 1 returning id`);
  fails(`select set_recipe(${p.id}, '[{"ingredientId":${g},"qty":1}]')`, U.staff, /Sem permissão/);
  fails(`select set_recipe(${p.id}, '[{"ingredientId":${other},"qty":1}]')`, U.pizza, /inválida/);
  assert.equal(+sql(`select set_recipe(${p.id}, '[{"ingredientId":${g},"qty":1},{"ingredientId":${t},"qty":1}]')`, U.pizza), 2);
  // entrada: 10 garrafas por R$ 20,00 → custo médio sobre estoque 0 = 200 centavos/un
  assert.equal(+json(`ingredient_move(${g}, 'entrada', 10, 2000, 'compra')`, U.staff).unit_cost, 200);
  sql(`select ingredient_move(${t}, 'entrada', 10, null, null)`, U.staff);
  const r = order('forno-da-vila', { customer: { name: 'Insumo', phone: '11933221100' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 3 }] });
  assert.equal(+sql(`select stock from ingredients where id = ${g}`), 7);
  assert.equal(+sql(`select stock from ingredients where id = ${t}`), 7);
  const oid = sql(`select id from orders where public_code = '${r.code}'`);
  sql(`update orders set status = 'cancelado' where id = ${oid}`);
  assert.equal(+sql(`select stock from ingredients where id = ${g}`), 10);
  sql(`update orders set status = 'novo' where id = ${oid}`);          // voltou (Pix pago depois)
  assert.equal(+sql(`select stock from ingredients where id = ${g}`), 7);
  sql(`update orders set status = 'cancelado' where id = ${oid}`);
  assert.equal(+sql(`select stock from ingredients where id = ${g}`), 10);
  // ajuste pela contagem: há 9 de fato
  assert.equal(+json(`ingredient_move(${g}, 'ajuste', 9, null, 'contagem')`, U.staff).stock, 9);
  fails(`select ingredient_move(${g}, 'entrada', 5, 100, null)`, U.burger, /Sem permissão/);
  assert.equal(sql(`select count(*) from ingredient_moves where ingredient_id = ${g}`, U.burger), '0');
  sql(`select set_recipe(${p.id}, '[]')`, U.pizza);
});

test('financeiro: despesas só do dono; resultado = faturamento − insumos − despesas', () => {
  const p = menu('forno-da-vila').find(x => x.name === 'Água sem gás');
  const g = sql(`select id from ingredients where tenant_id = '${pizzaId}' and name = 'Garrafa'`);
  sql(`select set_recipe(${p.id}, '[{"ingredientId":${g},"qty":2}]')`, U.pizza);
  const before = json(`profit_report('${pizzaId}', null)`, U.pizza);
  const r = order('forno-da-vila', { customer: { name: 'Fin', phone: '11933221199' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] });
  fails(`insert into expenses (tenant_id, day, category, amount) values ('${pizzaId}', current_date, 'Aluguel', 100000)`, U.staff, /row-level security/);
  sql(`insert into expenses (tenant_id, day, category, description, amount) values ('${pizzaId}', current_date, 'Aluguel', 'novembro', 100000)`, U.pizza);
  const after = json(`profit_report('${pizzaId}', null)`, U.pizza);
  assert.equal(after.revenue - before.revenue, r.total);
  assert.equal(after.ingredients - before.ingredients, 2 * 200);             // 2 garrafas × R$ 2,00
  assert.equal(after.expenses - before.expenses, 100000);
  assert.equal(after.result, after.revenue - after.ingredients - after.expenses);
  assert.ok(after.byCategory.some(c => c.category === 'Aluguel'));
  fails(`select profit_report('${pizzaId}', null)`, U.staff, /Sem permissão/);
  assert.equal(sql(`select count(*) from expenses`, U.staff), '0');
  sql(`select set_recipe(${p.id}, '[]')`, U.pizza);
});
