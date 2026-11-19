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
  for (const t of ['orders', 'order_items', 'order_events', 'order_reviews', 'coupons', 'couriers', 'memberships', 'platform_admins', 'cash_sessions', 'cash_moves', 'blocked_phones', 'ingredients', 'product_ingredients', 'ingredient_moves', 'expenses', 'rate_hits', 'option_ingredients'])
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
