// Teste de segurança: tenta abusar do banco como visitante, como outra loja e como funcionário.
// Cada teste é um ataque que precisa FALHAR. Uso: PGHOST=... PGPORT=... PGUSER=postgres npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'balcao_security';
const psql = (args, input) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
function sql(query, as = 'admin') {
  const head = as === 'admin' ? '' : as === null ? 'set local role anon;' : `set local role authenticated; set local request.jwt.claim.sub = '${as}';`;
  try { return psql(['-d', DB], `begin; ${head} ${query}; commit;`).trim(); }
  catch (e) { throw new Error((e.stderr || e.message).replace(/^psql:.*?ERROR:\s*/m, '').split('\n')[0]); }
}
const json = (q, as) => JSON.parse(sql(`select (${q})::text`, as));
const denied = (q, as, re = /permission denied|Sem permissão|row-level security|violates row-level|não encontrad/) => assert.throws(() => sql(q, as), re);
// Ataque que precisa dar em nada: ou o banco recusa, ou não afeta/retorna nenhuma linha.
const nothing = (q, as) => { try { assert.equal(sql(q, as), '0'); } catch (e) { assert.match(e.message, /permission denied|row-level security/); } };
const lit = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

const U = { pizza: randomUUID(), burger: randomUUID(), staff: randomUUID(), stranger: randomUUID(), admin: randomUUID() };
let pizzaId, burgerId, pizzaOrder, pizzaCode;
const customer = { name: 'Cliente Real', phone: '11988887777' };

before(() => {
  psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]);
  psql(['-d', 'postgres', '-c', `create database ${DB}`]);
  psql(['-d', DB, '-f', path.join(ROOT, 'test/supabase-shim.sql')]);
  for (const f of fs.readdirSync(path.join(ROOT, 'supabase/migrations')).sort()) psql(['-d', DB, '-f', path.join(ROOT, 'supabase/migrations', f)]);
  sql(`insert into auth.users (id, email) values ('${U.pizza}','dono@pizza.t'),('${U.burger}','dono@burger.t'),('${U.staff}','staff@pizza.t'),('${U.stranger}','qualquer@um.t'),('${U.admin}','adm@t.t');
       insert into platform_admins values ('${U.admin}')`);
  pizzaId = sql(`select (create_my_tenant('Pizza Alvo', 'pizzaria', 'alvo')).id`, U.pizza);
  burgerId = sql(`select (create_my_tenant('Burger Atacante', 'hamburgueria', 'atacante')).id`, U.burger);
  sql(`select add_staff('${pizzaId}', 'staff@pizza.t')`, U.pizza);
  sql(`update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0 where id in ('${pizzaId}', '${burgerId}')`);
  sql(`insert into tenant_pix (tenant_id, mp_access_token) values ('${pizzaId}', 'APP_USR-segredo-da-loja')`);
  sql(`insert into coupons (tenant_id, code, percent) values ('${pizzaId}', 'SEGREDO50', 50)`);
  const p = json(`(select to_jsonb(p) from products p where tenant_id = '${pizzaId}' and not exists (select 1 from option_groups g where g.product_id = p.id) order by id limit 1)`);
  const r = json(`place_order('alvo', ${lit({ customer, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] })})`, null);
  pizzaCode = r.code; pizzaOrder = +sql(`select id from orders where public_code = '${r.code}'`);
});

const simpleProduct = id => json(`(select to_jsonb(p) from products p where tenant_id = '${id}' and not exists (select 1 from option_groups g where g.product_id = p.id) order by id limit 1)`);

test('visitante não lê dados privados (pedidos, clientes, cupons, tokens, equipe)', () => {
  for (const t of ['orders', 'order_items', 'order_events', 'order_reviews', 'coupons', 'couriers', 'memberships', 'platform_admins', 'cash_sessions', 'cash_moves', 'blocked_phones', 'ingredients', 'product_ingredients', 'ingredient_moves', 'expenses', 'rate_hits', 'option_ingredients', 'cashback_ledger', 'activity_log'])
    nothing(`select count(*) from ${t}`, null);
  denied(`select * from tenant_pix`, null);
});

test('visitante não altera cardápio, preços nem lojas', () => {
  denied(`update products set price = 1 where tenant_id = '${pizzaId}'`, null);
  denied(`delete from products where tenant_id = '${pizzaId}'`, null);
  denied(`insert into zones (tenant_id, name, fee) values ('${pizzaId}', 'X', 0)`, null);
  denied(`update tenants set is_open = false where id = '${pizzaId}'`, null);
});

test('outra loja não vê nem mexe nos dados da loja alvo', () => {
  nothing(`select count(*) from orders where tenant_id = '${pizzaId}'`, U.burger);
  nothing(`select count(*) from coupons where tenant_id = '${pizzaId}'`, U.burger);
  nothing(`with x as (update products set price = 1 where tenant_id = '${pizzaId}' returning 1) select count(*) from x`, U.burger);
  nothing(`with x as (delete from zones where tenant_id = '${pizzaId}' returning 1) select count(*) from x`, U.burger);
  nothing(`with x as (update tenants set name = 'hackeada' where id = '${pizzaId}' returning 1) select count(*) from x`, U.burger);
  denied(`insert into coupons (tenant_id, code, percent) values ('${pizzaId}', 'HACK', 90)`, U.burger);
  denied(`insert into couriers (tenant_id, name, phone) values ('${pizzaId}', 'Falso', '11900000000')`, U.burger);
  denied(`select change_order_status(${pizzaOrder}, 'cancelado')`, U.burger);
  for (const fn of [`store_customers('${pizzaId}')`, `cash_report('${pizzaId}')`, `store_report('${pizzaId}', 30)`, `pix_settings('${pizzaId}')`,
    `set_pix_settings('${pizzaId}', 'APP_USR-x', true)`, `list_team('${pizzaId}')`, `coupon_usage('${pizzaId}')`, `billing_info('${pizzaId}')`,
    `create_unit('${pizzaId}', 'Clone', null)`, `set_custom_domain('${pizzaId}', 'roubo.com.br')`, `anonymize_customer('${pizzaId}', '11988887777')`,
    `courier_link('${pizzaId}', 1, false)`, `delete_my_tenant('${pizzaId}', 'alvo')`, `staff_place_order('${pizzaId}', '{}'::jsonb)`])
    denied(`select ${fn}`, U.burger, /permission denied|Sem permissão|does not exist|não encontrad/i);
});

test('dono não muda o próprio plano, assinatura, suspensão nem liga Pix sem token', () => {
  for (const col of [`plan = 'Rede'`, `billing_status = 'active'`, `paid_until = now() + interval '10 years'`, `active = true`, `pix_online = true`, `card_online = true`, `custom_domain = 'x.com'`, `slug = 'outro'`])
    denied(`update tenants set ${col} where id = '${pizzaId}'`, U.pizza);
  for (const fn of [`platform_overview()`, `platform_health(30)`, `platform_domains()`, `platform_set_billing('${pizzaId}', 'active', 3650)`, `platform_update_tenant('${pizzaId}', 'Rede', true)`])
    denied(`select ${fn}`, U.pizza);
});

test('funcionário não faz o que é só do dono', () => {
  for (const fn of [`store_customers('${pizzaId}')`, `set_pix_settings('${pizzaId}', 'APP_USR-x', true)`, `create_unit('${pizzaId}', 'Clone', null)`,
    `add_staff('${pizzaId}', 'qualquer@um.t')`, `delete_my_tenant('${pizzaId}', 'alvo')`, `anonymize_customer('${pizzaId}', '11988887777')`])
    denied(`select ${fn}`, U.staff);
  denied(`insert into coupons (tenant_id, code, percent) values ('${pizzaId}', 'STAFF90', 90)`, U.staff);
  nothing(`with x as (update tenants set min_order = 0 where id = '${pizzaId}' returning 1) select count(*) from x`, U.staff);
});

test('pedido: preço, total e status vêm do banco, nunca do cliente', () => {
  const p = simpleProduct(pizzaId);
  const r = json(`place_order('alvo', ${lit({ customer, fulfillment: 'pickup', payment: 'Dinheiro', total: 1, subtotal: 1, discount: 99999, status: 'entregue', paymentStatus: 'paid', items: [{ productId: p.id, qty: 1, price: 1, unit_price: 1 }] })})`, null);
  assert.equal(r.total, p.price);
  assert.deepEqual(sql(`select status || ',' || payment_status from orders where public_code = '${r.code}'`).split(','), ['novo', 'na']);
});

test('pedido: quantidades, produtos e opções inválidos são recusados', () => {
  const p = simpleProduct(pizzaId), other = simpleProduct(burgerId);
  const bad = items => assert.throws(() => sql(`select place_order('alvo', ${lit({ customer, fulfillment: 'pickup', payment: 'Dinheiro', items })})`, null), /./);
  bad([{ productId: p.id, qty: 0 }]);
  bad([{ productId: p.id, qty: -5 }]);
  bad([{ productId: p.id, qty: 100000 }]);
  bad([{ productId: p.id, qty: 1.5 }]);
  bad([{ productId: other.id, qty: 1 }]);                         // produto de outra loja
  bad([{ productId: 999999999, qty: 1 }]);
  bad([]);
  const opt = json(`(select to_jsonb(o) from options o where tenant_id = '${burgerId}' limit 1)`);
  if (opt) bad([{ productId: p.id, qty: 1, optionIds: [opt.id] }]); // opção de outra loja
  sql(`update products set available = false where id = ${p.id}`);
  bad([{ productId: p.id, qty: 1 }]);                              // esgotado
  sql(`update products set available = true where id = ${p.id}`);
});

test('pedido: forma de pagamento, bairro e cupom de outra loja não passam', () => {
  const p = simpleProduct(pizzaId);
  const base = { customer, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] };
  assert.throws(() => sql(`select place_order('alvo', ${lit({ ...base, payment: 'Pix online' })})`, null), /não aceita Pix online/);
  assert.throws(() => sql(`select place_order('alvo', ${lit({ ...base, payment: 'Cartão online' })})`, null), /não aceita cartão/);
  assert.throws(() => sql(`select place_order('alvo', ${lit({ ...base, payment: 'Vale' })})`, null), /inválida/);
  const z = json(`(select to_jsonb(z) from zones z where tenant_id = '${burgerId}' limit 1)`);
  assert.throws(() => sql(`select place_order('alvo', ${lit({ ...base, fulfillment: 'delivery', zoneId: z.id, address: 'Rua X, 1' })})`, null), /./);
  sql(`insert into coupons (tenant_id, code, percent) values ('${burgerId}', 'DOOUTRO', 90)`);
  assert.throws(() => sql(`select place_order('alvo', ${lit({ ...base, coupon: 'DOOUTRO' })})`, null), /Cupom inválido/);
});

test('acompanhamento e entregador: código errado não revela nada', () => {
  assert.equal(sql(`select coalesce(track_order('ABCDEF123456')::text, 'null')`, null), 'null');
  assert.equal(sql(`select coalesce(track_order('${pizzaCode.slice(0, 11)}')::text, 'null')`, null), 'null');
  assert.match(pizzaCode, /^[0-9A-F]{12}$/);                       // 48 bits: inviável adivinhar
  assert.equal(sql(`select coalesce(courier_portal('${'0'.repeat(64)}')::text, 'null')`, null), 'null');
  assert.throws(() => sql(`select courier_deliver('${'0'.repeat(64)}', ${pizzaOrder})`, null), /./);
  assert.throws(() => sql(`select review_order('${pizzaCode}', 5, 'ainda não entregue')`, null), /./);
});

test('texto malicioso é guardado como texto (sem injeção de SQL)', () => {
  const p = simpleProduct(pizzaId);
  const evil = { name: `Robert'); drop table orders;-- <img src=x onerror=alert(1)>`, phone: '11977776666' };
  const r = json(`place_order('alvo', ${lit({ customer: evil, fulfillment: 'pickup', payment: 'Dinheiro', notes: '<script>', items: [{ productId: p.id, qty: 1, notes: `'; delete from products; --` }] })})`, null);
  assert.equal(sql(`select customer_name from orders where public_code = '${r.code}'`), evil.name.slice(0, 80));
  assert.ok(+sql(`select count(*) from products where tenant_id = '${pizzaId}'`) > 0);
  assert.equal(sql(`select to_regclass('public.orders') is not null`), 't');
});

test('fotos: ninguém mexe na pasta de outra loja', () => {
  assert.equal(sql(`select can_manage_image('${pizzaId}/foto.jpg')`, U.burger), 'f');
  assert.equal(sql(`select can_manage_image('${pizzaId}/foto.jpg')`, U.pizza), 't');
  assert.equal(sql(`select can_manage_image('../${pizzaId}/foto.jpg')`, U.pizza), 'f');
  assert.throws(() => sql(`select can_manage_image('${pizzaId}/foto.jpg')`, null), /permission denied/);
});

test('privacidade: ninguém de fora descobre se um telefone já comprou na loja', () => {
  denied(`select loyalty_stamps('${pizzaId}', '11988887777')`, U.stranger);
  denied(`select loyalty_stamps('${pizzaId}', '11988887777')`, null);
});

test('privacidade: dados de cobrança da loja não ficam públicos', () => {
  denied(`select mp_preapproval_id from tenants where id = '${pizzaId}'`, null);
  denied(`select mp_preapproval_id from tenants where id = '${pizzaId}'`, U.burger);
  assert.equal(sql(`select name from tenants where id = '${pizzaId}'`, null), 'Pizza Alvo'); // vitrine continua pública
});

test('abuso: enxurrada de pedidos falsos é barrada', () => {
  const p = simpleProduct(pizzaId);
  const spam = i => sql(`select place_order('alvo', ${lit({ customer: { name: 'Spam', phone: '11955554444' }, fulfillment: 'pickup', payment: 'Dinheiro', items: [{ productId: p.id, qty: 1 }] })})`, null);
  let blocked = false;
  for (let i = 0; i < 12; i++) { try { spam(i); } catch (e) { blocked = /Muitos pedidos/.test(e.message); if (blocked) break; throw e; } }
  assert.ok(blocked, 'o mesmo telefone não consegue fazer dezenas de pedidos em minutos');
});

test('abuso: tentativa de adivinhar cupom é barrada', () => {
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) { try { sql(`select check_coupon('alvo', 'TENTA${i}')`, null); } catch (e) { blocked = /Muitas tentativas/.test(e.message); if (!blocked) throw e; } }
  assert.ok(blocked);
});

test('concorrência: 20 pedidos ao mesmo tempo não furam o limite de usos do cupom', async () => {
  const { execFile } = await import('node:child_process');
  const p = simpleProduct(pizzaId);
  sql(`insert into coupons (tenant_id, code, percent, max_uses) values ('${pizzaId}', 'SOTRES', 10, 3)`);
  const one = i => new Promise(res => execFile('psql', ['-X', '-q', '-At', '-d', DB, '-c',
    `begin; set local role anon; select place_order('alvo', ${lit({ customer: { name: 'Corrida', phone: `1196000${String(i).padStart(4, '0')}` }, fulfillment: 'pickup', payment: 'Dinheiro', coupon: 'SOTRES', items: [{ productId: p.id, qty: 1 }] })}); commit;`],
    err => res(!err)));
  const ok = (await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)))).filter(Boolean).length;
  assert.equal(ok, 3);
  assert.equal(sql(`select count(*) from orders where coupon_code = 'SOTRES'`), '3');
  assert.equal(sql(`select count(*) from (select number from orders where tenant_id = '${pizzaId}' group by number having count(*) > 1) x`), '0');
});

// ---------- recursos novos (migrações 21 a 34) ----------
test('visitante não lê as tabelas novas (vales, reservas, pagamentos, avisos, indicações)', () => {
  for (const t of ['table_payments', 'gift_cards', 'gift_card_moves', 'reservations', 'courier_payouts', 'referral_codes', 'push_subscriptions', 'push_queue', 'platform_settings'])
    nothing(`select count(*) from ${t}`, null);
  for (const t of ['referral_codes', 'push_subscriptions', 'push_queue', 'platform_settings']) nothing(`select count(*) from ${t}`, U.stranger);
});

test('configurações internas da loja não aparecem para quem só tem conta', () => {
  for (const c of ['daily_goal', 'monthly_goal', 'auto_accept', 'call_names', 'point_terminal_id', 'reservation_capacity', 'reservation_auto'])
    denied(`select ${c} from tenants where id = '${pizzaId}'`, U.stranger);
  assert.equal(sql(`select coalesce(tenant_settings('${pizzaId}')::text, 'null')`, U.stranger), 'null');
  assert.equal(sql(`select coalesce(tenant_settings('${pizzaId}')::text, 'null')`, U.burger), 'null');
  assert.ok(json(`tenant_settings('${pizzaId}')`, U.staff).daily_goal !== undefined);
});

test('outra loja não usa as funções novas na loja alvo', () => {
  const p = simpleProduct(pizzaId);
  denied(`select set_product_suggest(${p.id}, true)`, U.burger);
  denied(`select bulk_reprice('${pizzaId}', null, 50, 0, 'none', false, true)`, U.burger);
  denied(`select set_category_availability('${pizzaId}', '${p.category}', false)`, U.burger);
  denied(`select close_table_split('${pizzaId}', '1', ${lit([{ method: 'Pix', amount: 100 }])})`, U.burger);
  denied(`select kiosk_place_order('${pizzaId}', ${lit({ customer: { name: 'X' }, fulfillment: 'pickup', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 1 }] })})`, U.burger);
  denied(`select kiosk_pay_at_counter('${pizzaId}', '${pizzaCode}')`, U.burger);
  denied(`select kiosk_cancel('${pizzaId}', '${pizzaCode}')`, U.burger);
  assert.equal(sql(`select coalesce(kiosk_status('${pizzaId}', '${pizzaCode}')::text, 'null')`, U.burger), 'null');
  denied(`select gift_card_create('${pizzaId}', 5000, '', '', '', 'Pix', 365)`, U.burger);
  denied(`select courier_statement('${pizzaId}', current_date, current_date)`, U.burger);
  assert.deepEqual(json(`courier_positions('${pizzaId}')`, U.burger), []);
  assert.deepEqual(json(`product_ratings('${pizzaId}', 30)`, U.burger), []);
  assert.ok(!json(`units_report(30)`, U.burger).units.some(u => u.id === pizzaId));
  denied(`select push_setup('${'B'.repeat(87)}', '${'s'.repeat(40)}', 'https://x.supabase.co/functions/v1/push')`, U.burger);
  denied(`select push_status()`, U.pizza);
  // não mexe em registros da loja alvo mesmo sabendo os ids
  const c = sql(`insert into couriers (tenant_id, name, phone) values ('${pizzaId}', 'Moto Alvo', '11900000001') returning id`);
  denied(`select set_courier_pay(${c}, 'fixo', 100000, 0, 'golpe@pix')`, U.burger);
  denied(`select courier_pay(${c}, current_date, current_date, 'Pix', '')`, U.burger);
  const g = json(`gift_card_create('${pizzaId}', 5000, '', '', '', 'Pix', 365)`, U.pizza);
  const gid = sql(`select id from gift_cards where code = '${g.code}'`);
  denied(`select gift_card_cancel(${gid})`, U.burger);
  assert.equal(sql(`select coalesce(gift_card_check('atacante', '${g.code}')::text, 'null')`, null), 'null');   // vale de outra loja não vale aqui
  nothing(`update gift_cards set balance = 999999 where id = ${gid}`, U.burger);
});

test('funcionário não faz o que é só do dono nas funções novas', () => {
  const p = simpleProduct(pizzaId);
  denied(`select bulk_reprice('${pizzaId}', null, 10, 0, 'none', false, true)`, U.staff);
  denied(`select set_product_suggest(${p.id}, true)`, U.staff);
  denied(`select gift_card_create('${pizzaId}', 5000, '', '', '', 'Cortesia', 365)`, U.staff, /Só o dono/);
  const c = sql(`select id from couriers where tenant_id = '${pizzaId}' limit 1`);
  denied(`select set_courier_pay(${c}, 'fixo', 600, 0, null)`, U.staff);
  denied(`select courier_pay(${c}, current_date, current_date, 'Pix', '')`, U.staff);
  denied(`select add_member('${pizzaId}', 'qualquer@um.t', 'staff')`, U.staff);
  for (const col of ['auto_accept = true', 'referral_reward = 10000', 'call_names = true', "logo_path = null", "point_terminal_id = 'X1234'", 'reservations_on = true'])
    nothing(`with u as (update tenants set ${col} where id = '${pizzaId}' returning 1) select count(*) from u`, U.staff);
});

test('conta de totem só faz pedido pelo totem: não vê pedidos, clientes nem configurações', () => {
  const T = randomUUID();
  sql(`insert into auth.users (id, email) values ('${T}', 'totem@pizza.t')`);
  denied(`select add_member('${pizzaId}', 'totem@pizza.t', 'owner')`, U.pizza, /Papel inválido/);
  sql(`select add_member('${pizzaId}', 'totem@pizza.t', 'totem')`, U.pizza);
  for (const t of ['orders', 'order_items', 'cashback_ledger', 'gift_cards', 'reservations', 'expenses', 'cash_sessions', 'couriers', 'blocked_phones']) nothing(`select count(*) from ${t}`, T);
  assert.equal(sql(`select is_member('${pizzaId}')`, T), 'f');
  assert.deepEqual(json(`tenant_settings('${pizzaId}')`, T), { point_terminal_id: null });
  denied(`select set_category_availability('${pizzaId}', 'Bebidas', false)`, T);
  denied(`select gift_card_create('${pizzaId}', 5000, '', '', '', 'Dinheiro', 365)`, T);
  const p = simpleProduct(pizzaId);
  const r = json(`kiosk_place_order('${pizzaId}', ${lit({ customer: { name: 'Totem' }, fulfillment: 'pickup', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 1 }] })})`, T);
  assert.equal(r.status, 'novo');
  assert.equal(json(`kiosk_status('${pizzaId}', '${r.code}')`, T).status, 'novo');
  assert.equal(sql(`select coalesce(kiosk_status('${pizzaId}', '${pizzaCode}')::text, 'null')`, T), 'null');   // só pedidos do totem
  sql(`select remove_staff('${pizzaId}', '${T}')`, U.pizza);
  denied(`select kiosk_place_order('${pizzaId}', ${lit({ customer: { name: 'Totem' }, fulfillment: 'pickup', payment: 'Pagar no caixa', items: [{ productId: p.id, qty: 1 }] })})`, T);
});

test('valores: formas de pagamento internas e vale-presente não são forjados pelo cliente', () => {
  const p = simpleProduct(pizzaId);
  for (const pay of ['Vale-presente', 'Dividido', 'Cartão no totem'])
    assert.throws(() => sql(`select place_order('alvo', ${lit({ customer: { name: 'Forja', phone: '11933330000' }, fulfillment: 'pickup', payment: pay, items: [{ productId: p.id, qty: 1 }] })})`, null), /Forma de pagamento inválida|pague/);
  assert.throws(() => sql(`select place_order('alvo', ${lit({ customer: { name: 'Forja', phone: '11933330001' }, fulfillment: 'pickup', payment: 'Dinheiro', giftCode: 'VP' + 'A'.repeat(8), items: [{ productId: p.id, qty: 1 }] })})`, null), /Vale-presente inválido/);
  denied(`select gift_card_create('${pizzaId}', -5000, '', '', '', 'Pix', 365)`, U.pizza, /Valor do vale/);
  denied(`update tenants set referral_reward = 1000000 where id = '${pizzaId}'`, U.pizza, /check constraint|violates/);
});

test('avisos no celular: endereço interno ou desconhecido é recusado', () => {
  for (const ep of ['https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://evil.example/fcm.googleapis.com/', 'http://fcm.googleapis.com/fcm/send/x'])
    assert.throws(() => sql(`select push_subscribe('${pizzaCode}', ${lit({ endpoint: ep, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } })})`, null), /Inscrição inválida/);
  assert.equal(sql(`select push_subscribe('${pizzaCode}', ${lit({ endpoint: 'https://fcm.googleapis.com/fcm/send/ok', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } })})`, null), 't');
});

test('funções internas não ficam expostas ao público', () => {
  for (const f of ['_audit()', '_cashback_on_status()', '_ingredients_on_item()', '_ingredients_on_status()', '_push_on_status()', '_gift_on_status()', '_referral_on_status()', '_auto_accept()', '_courier_forget()', 'schema_status()', 'push_take(bigint)', 'push_drop(bigint)', 'point_save(bigint, text)', 'pix_apply(uuid, bigint, text, text, integer)', '_courier_calc(bigint, date, date)', '_short_name(text)', 'cashback_balance(uuid, text)'])
    assert.equal(sql(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', f);
  // nenhuma função do banco roda como dono sem search_path fixo
  assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and prosecdef and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')`), '0');
  // toda tabela tem RLS
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and not relrowsecurity`), '0');
});

test('abuso: força bruta de vale-presente e enxurrada de reservas são barradas', () => {
  {
    let blocked = false;
    for (let i = 0; i < 20 && !blocked; i++) { try { sql(`select gift_card_check('alvo', 'VP${String(i).padStart(8, 'A')}')`, null); } catch (e) { blocked = /Muitas tentativas/.test(e.message); } }
    assert.ok(blocked, 'tentar códigos de vale em sequência é bloqueado');
    sql(`update tenants set reservations_on = true where id = '${pizzaId}'`);
    blocked = false;
    for (let i = 0; i < 12 && !blocked; i++) {
      try { sql(`select request_reservation('alvo', ${lit({ name: 'Spam', phone: '119' + String(10000000 + i), party: 2, at: new Date(Date.now() + 864e5).toISOString() })})`, null); }
      catch (e) { blocked = /Muitas tentativas/.test(e.message); }
    }
    assert.ok(blocked, 'pedidos de reserva em massa são bloqueados');
  }
});

test('chamados de ajuda: outra loja, visitante e prints alheios não passam; enxurrada é barrada', () => {
  const id = sql(`select support_open('${pizzaId}', 'Erro no caixa', 'erro', 'Detalhes com telefone do cliente 11999990000', null, null)`, U.pizza);
  nothing(`select count(*) from support_tickets`, U.burger);
  nothing(`select count(*) from support_messages`, U.burger);
  nothing(`select count(*) from support_tickets`, U.stranger);
  denied(`select count(*) from support_tickets`, null);
  denied(`select support_thread(${id})`, U.burger);
  denied(`select support_thread(${id})`, U.stranger);
  denied(`select support_reply(${id}, 'oi', null)`, U.stranger);
  denied(`select support_set_status(${id}, 'resolvido')`, U.burger);
  denied(`select support_open('${pizzaId}', 'Falso', 'erro', 'Chamado em nome de outra loja', null, null)`, U.burger);
  denied(`select support_list('${pizzaId}')`, U.burger);
  denied(`select support_admin_list(null)`, U.pizza);
  denied(`select support_open('${pizzaId}', 'Visitante', 'erro', 'tentativa sem login', null, null)`, null);
  // escrita direta nas tabelas é recusada até para a própria loja
  denied(`update support_tickets set status = 'respondido' where id = ${id}`, U.pizza);
  denied(`insert into support_messages (ticket_id, tenant_id, from_support, body) values (${id}, '${pizzaId}', true, 'resposta falsa do suporte')`, U.pizza);
  // prints: cada um só envia e vê na pasta da sua loja; pasta "suporte" só a plataforma
  sql(`insert into storage.objects (bucket_id, name) values ('support-files', '${pizzaId}/print.png')`, U.pizza);
  denied(`insert into storage.objects (bucket_id, name) values ('support-files', '${pizzaId}/plantado.png')`, U.burger);
  denied(`insert into storage.objects (bucket_id, name) values ('support-files', 'suporte/falso.png')`, U.pizza);
  nothing(`select count(*) from storage.objects where bucket_id = 'support-files'`, U.burger);
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'support-files'`, U.admin), '1');
  assert.equal(sql(`select public from storage.buckets where id = 'support-files'`), 'f');
  // enxurrada de chamados
  assert.throws(() => { for (let i = 0; i < 12; i++) sql(`select support_open('${pizzaId}', 'Spam ${i}', 'erro', 'mensagem repetida', null, null)`, U.staff); }, /Muitos chamados/);
});

test('avisos da equipe e monitor de erros: outra loja não se inscreve, erros não vazam, enxurrada barrada', () => {
  const dev = { endpoint: 'https://fcm.googleapis.com/fcm/send/intruso', keys: { p256dh: 'D'.repeat(87), auth: 'c'.repeat(22) } };
  denied(`select staff_push_subscribe('${pizzaId}', ${lit(dev)})`, U.burger);
  denied(`select staff_push_subscribe('${pizzaId}', ${lit(dev)})`, U.stranger);
  denied(`select staff_push_subscribe('${pizzaId}', ${lit(dev)})`, null);
  denied(`select staff_push_state('${pizzaId}', 'x')`, U.burger);
  denied(`select staff_push_unsubscribe('${pizzaId}', 'x')`, U.burger);
  assert.throws(() => sql(`select staff_push_subscribe('${pizzaId}', ${lit({ ...dev, endpoint: 'https://169.254.169.254/latest' })})`, U.pizza), /não suportado/);
  nothing(`select count(*) from staff_push_subs`, U.pizza);
  denied(`select count(*) from staff_push_subs`, null);
  denied(`select push_take(1)`, U.pizza);
  // erros: qualquer um registra, ninguém além da plataforma lê
  sql(`select log_client_error(null, 'erro com dado pessoal 11999990000', 'app.js:1', '/pedido/ABC', 'x')`, null);
  denied(`select count(*) from client_errors`, null);
  nothing(`select count(*) from client_errors`, U.pizza);
  denied(`select platform_errors(7, false)`, U.pizza);
  denied(`select platform_error_resolve('x')`, U.burger);
  denied(`select _push_send(1)`, U.pizza);
  assert.throws(() => { for (let i = 0; i < 35; i++) sql(`select log_client_error(null, 'spam ${'$'}{i} ${Math.random()}', '', '/', '')`, null); }, /Muitos registros/);
});
