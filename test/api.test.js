// Testes de ponta a ponta da API: rodam um servidor com banco em memória.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, bootstrap } from '../src/server.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';

let server, base;
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const login = async (email, password = DEMO_PASSWORD) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).data.token;

before(async () => {
  const db = openDb(':memory:');
  const log = console.log; console.log = () => {};
  bootstrap(db, { PLATFORM_EMAIL: 'admin@teste.app', PLATFORM_PASSWORD: 'senha-forte-123' });
  seedDemo(db);
  console.log = log;
  server = createApp({ db, secret: 'teste' });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('loja pública mostra cardápio e bairros', async () => {
  const { status, data } = await call('/api/public/stores/forno-da-vila');
  assert.equal(status, 200);
  assert.equal(data.store.segment, 'pizzaria');
  assert.ok(data.products.length > 3);
  assert.ok(data.zones.length > 0);
});

test('pedido: preço é calculado no servidor, com opções e cupom', async () => {
  const { data } = await call('/api/public/stores/forno-da-vila');
  const pizza = data.products.find(p => p.name === 'Margherita');
  const tam = pizza.groups.find(g => g.name === 'Tamanho').options.find(o => o.name.startsWith('Grande'));
  const borda = pizza.groups.find(g => g.name === 'Borda recheada').options[0];
  const zone = data.zones[0];
  const r = await call('/api/public/stores/forno-da-vila/orders', { method: 'POST', body: {
    customer: { name: 'Teste Silva', phone: '11999990000' }, fulfillment: 'delivery', zoneId: zone.id, address: 'Rua A, 10', payment: 'Pix',
    coupon: 'primeira10', items: [{ productId: pizza.id, qty: 2, optionIds: [tam.id, borda.id], price: 1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const unit = pizza.price + tam.price + borda.price, sub = unit * 2;
  assert.equal(r.data.total, sub + zone.fee - Math.round(sub * 0.1));
  const t = await call(`/api/public/orders/${r.data.code}`);
  assert.equal(t.data.order.status, 'novo');
  assert.equal(t.data.order.items[0].unit_price, unit);
});

test('pedido rejeita grupo obrigatório sem escolha e opção de outro produto', async () => {
  const { data } = await call('/api/public/stores/forno-da-vila');
  const [a, b] = data.products.filter(p => p.groups.some(g => g.min_sel));
  const base = { customer: { name: 'X', phone: '11999990000' }, fulfillment: 'pickup', payment: 'Pix' };
  let r = await call('/api/public/stores/forno-da-vila/orders', { method: 'POST', body: { ...base, items: [{ productId: a.id, qty: 1, optionIds: [] }] } });
  assert.equal(r.status, 400);
  r = await call('/api/public/stores/forno-da-vila/orders', { method: 'POST', body: { ...base, items: [{ productId: a.id, qty: 1, optionIds: [b.groups[0].options[0].id] }] } });
  assert.equal(r.status, 400);
});

test('pedido mínimo do mercado é respeitado', async () => {
  const { data } = await call('/api/public/stores/mercadinho-bom-preco');
  const cheap = data.products.find(p => p.price < 500);
  const r = await call('/api/public/stores/mercadinho-bom-preco/orders', { method: 'POST', body: { customer: { name: 'X', phone: '11999990000' }, fulfillment: 'pickup', payment: 'Pix', items: [{ productId: cheap.id, qty: 1 }] } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /mínimo/);
});

test('fluxo de status: preparo → pronto → rota → entregue, com regras', async () => {
  const token = await login('dono@fornodavila.demo');
  const novos = (await call('/api/orders?status=novo', { token })).data;
  const o = novos.find(x => x.fulfillment === 'delivery');
  assert.equal((await call(`/api/orders/${o.id}/status`, { method: 'POST', token, body: { status: 'entregue' } })).status, 409);
  for (const s of ['preparo', 'pronto']) assert.equal((await call(`/api/orders/${o.id}/status`, { method: 'POST', token, body: { status: s } })).status, 200);
  assert.equal((await call(`/api/orders/${o.id}/status`, { method: 'POST', token, body: { status: 'rota' } })).status, 400);
  const courier = (await call('/api/couriers', { token })).data.find(c => c.active);
  const r = await call(`/api/orders/${o.id}/status`, { method: 'POST', token, body: { status: 'rota', courierId: courier.id } });
  assert.equal(r.data.courier_name, courier.name);
  assert.equal((await call(`/api/orders/${o.id}/status`, { method: 'POST', token, body: { status: 'entregue' } })).data.status, 'entregue');
});

test('isolamento entre empresas', async () => {
  const burger = await login('dono@brasaburger.demo');
  const pizzaOrders = (await call('/api/orders', { token: await login('dono@fornodavila.demo') })).data;
  const r = await call(`/api/orders/${pizzaOrders[0].id}`, { token: burger });
  assert.equal(r.status, 404);
  const prods = (await call('/api/products', { token: burger })).data;
  assert.ok(prods.every(p => !/Margherita/.test(p.name)));
});

test('editor de produto salva grupos de opções e valida mínimo/máximo', async () => {
  const token = await login('dono@acaidapraia.demo');
  const ok = await call('/api/products', { method: 'POST', token, body: { category: 'Bowls', name: 'Bowl tropical', price: 2500, groups: [
    { name: 'Base', min_sel: 1, max_sel: 1, options: [{ name: 'Açaí', price: 0 }, { name: 'Cupuaçu', price: 200 }] },
    { name: 'Frutas', min_sel: 0, max_sel: 3, options: [{ name: 'Manga', price: 150 }, { name: 'Kiwi', price: 250 }] }] } });
  assert.equal(ok.status, 200);
  const p = (await call('/api/products', { token })).data.find(x => x.id === ok.data.id);
  assert.equal(p.groups.length, 2);
  assert.equal(p.groups[1].max_sel, 2, 'máximo é limitado ao número de opções');
  const bad = await call('/api/products', { method: 'POST', token, body: { category: 'X', name: 'Y', price: 100, groups: [{ name: 'G', min_sel: 3, max_sel: 1, options: [{ name: 'a', price: 0 }] }] } });
  assert.equal(bad.status, 400);
});

test('permissões: atendente não altera cardápio; plataforma cria empresa', async () => {
  const owner = await login('dono@brasaburger.demo');
  await call('/api/team', { method: 'POST', token: owner, body: { name: 'Atendente', email: 'att@brasa.demo', password: 'atendente1' } });
  const staff = await login('att@brasa.demo', 'atendente1');
  assert.equal((await call('/api/products', { method: 'POST', token: staff, body: { category: 'A', name: 'B', price: 1 } })).status, 403);
  assert.equal((await call('/api/reports', { token: staff })).status, 200);
  assert.equal((await call('/api/platform/overview', { token: owner })).status, 403);

  const admin = await login('admin@teste.app', 'senha-forte-123');
  const created = await call('/api/platform/tenants', { method: 'POST', token: admin, body: { name: 'Farmácia Saúde', segment: 'farmacia', plan: 'Básico', owner: { name: 'Ana', email: 'ana@farma.demo', password: 'farmacia123' } } });
  assert.equal(created.status, 200);
  assert.equal(created.data.slug, 'farmacia-saude');
  const pub = await call('/api/public/stores/farmacia-saude');
  assert.ok(pub.data.products.length >= 5);
  const ov = await call('/api/platform/overview', { token: admin });
  assert.equal(ov.data.tenants.length, 5);
});

test('empresa suspensa sai do ar', async () => {
  const admin = await login('admin@teste.app', 'senha-forte-123');
  const t = (await call('/api/platform/overview', { token: admin })).data.tenants.find(x => x.slug === 'acai-da-praia');
  await call(`/api/platform/tenants/${t.id}`, { method: 'PATCH', token: admin, body: { active: false } });
  assert.equal((await call('/api/public/stores/acai-da-praia')).status, 404);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'dono@acaidapraia.demo', password: DEMO_PASSWORD } })).status, 403);
});

test('relatório tem indicadores', async () => {
  const r = await call('/api/reports?days=7', { token: await login('dono@fornodavila.demo') });
  assert.ok(r.data.orders > 5);
  assert.ok(r.data.revenue > 0);
  assert.ok(r.data.top.length > 0);
});
