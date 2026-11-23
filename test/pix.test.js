// Testes da Edge Function "pix" com o banco e o Mercado Pago simulados (sem internet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../supabase/functions/pix/index.ts';

const TENANT = '11111111-2222-3333-4444-555555555555';
const SUPA = 'https://proj.supabase.co';
const silent = { error() {} };

function setup({ order = {}, mpPayment = {} } = {}) {
  const calls = [];
  const db = {
    order: { id: 7, number: 101, code: 'ABCDEF123456', total: 4550, status: 'pagamento', payment: 'Pix online', paymentStatus: 'pending',
      pixRef: null, pixQr: null, pixExpiresAt: null, customerName: 'Maria Silva', tenantId: TENANT, storeName: 'Forno', pixOnline: true, token: 'TEST-abc', ...order }
  };
  const pay = { id: 999, status: 'approved', transaction_amount: 45.5, payment_method_id: 'pix', external_reference: '7',
    point_of_interaction: { transaction_data: { qr_code: '00020126PIX', qr_code_base64: 'iVBOR' } }, ...mpPayment };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body });
    const res = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.startsWith(`${SUPA}/rest/v1/rpc/`)) {
      const fn = url.split('/').pop();
      if (fn === 'pix_order') return res(body.p_code === db.order.code ? db.order : null);
      if (fn === 'pix_token') return res(body.p_tenant === TENANT ? 'TEST-abc' : null);
      if (fn === 'pix_save') { Object.assign(db.order, { pixRef: body.p_ref, pixQr: body.p_qr }); return res(null); }
      if (fn === 'pix_apply') return res(body.p_mp_status === 'approved' ? 'novo' : 'pagamento');
      if (fn === 'pix_expire_overdue') return res(0);
    }
    if (url === 'https://api.mercadopago.com/v1/payments' && init.method === 'POST') return res(pay, 201);
    if (url.startsWith('https://api.mercadopago.com/v1/payments/')) return url.endsWith('/999') ? res(pay) : res({ message: 'not found' }, 404);
    return res({ message: 'rota inesperada ' + url }, 500);
  };
  const handler = makeHandler({ supabaseUrl: SUPA, serviceKey: 'sb_secret_x', fetchImpl, now: () => new Date('2026-11-14T00:00:00Z'), log: silent });
  const post = async (body, qs = '') => { const r = await handler(new Request(`${SUPA}/functions/v1/pix${qs}`, { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, data: await r.json() }; };
  return { post, calls, db };
}

test('create: gera o Pix no Mercado Pago com o valor do banco e guarda o QR', async () => {
  const { post, calls } = setup();
  const r = await post({ action: 'create', code: 'ABCDEF123456', email: 'maria@email.com', total: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.qr, '00020126PIX');
  const mpCall = calls.find(c => c.url === 'https://api.mercadopago.com/v1/payments');
  assert.equal(mpCall.body.transaction_amount, 45.5);           // vem do banco, não do navegador
  assert.equal(mpCall.body.external_reference, '7');
  assert.equal(mpCall.headers.Authorization, 'Bearer TEST-abc');
  assert.ok(mpCall.headers['X-Idempotency-Key']);
  assert.match(mpCall.body.notification_url, new RegExp(`action=webhook&t=${TENANT}`));
  const rpcCall = calls.find(c => c.url.endsWith('/pix_order'));
  assert.equal(rpcCall.headers.apikey, 'sb_secret_x');
  assert.equal(rpcCall.headers.Authorization, undefined);         // chave nova: só no apikey
  assert.ok(calls.some(c => c.url.endsWith('/pix_save')));
});

test('create: reaproveita o QR ainda válido e exige e-mail', async () => {
  const valid = setup({ order: { pixRef: '999', pixQr: 'JA', pixExpiresAt: '2026-11-14T00:20:00Z' } });
  const r = await valid.post({ action: 'create', code: 'ABCDEF123456' });
  assert.equal(r.data.qr, 'JA');
  assert.equal(valid.calls.some(c => c.url.includes('mercadopago')), false);
  const noEmail = setup();
  assert.equal((await noEmail.post({ action: 'create', code: 'ABCDEF123456', email: 'x' })).status, 400);
  assert.equal((await noEmail.post({ action: 'create', code: 'NAOEXISTE1' })).status, 404);
  assert.equal((await noEmail.post({ action: 'create', code: "1' or 1=1" })).status, 400);
});

test('create: pedido já pago ou loja sem Pix', async () => {
  assert.deepEqual((await setup({ order: { status: 'novo', paymentStatus: 'paid' } }).post({ action: 'create', code: 'ABCDEF123456' })).data, { status: 'novo', paid: true });
  assert.equal((await setup({ order: { pixOnline: false } }).post({ action: 'create', code: 'ABCDEF123456', email: 'a@b.com' })).status, 400);
});

test('webhook: confere o pagamento na API antes de aplicar', async () => {
  const { post, calls } = setup();
  const r = await post({ type: 'payment', data: { id: '999' } }, `?action=webhook&t=${TENANT}`);
  assert.deepEqual(r.data, { ok: true, status: 'novo' });
  const get = calls.find(c => c.url === 'https://api.mercadopago.com/v1/payments/999');
  assert.equal(get.headers.Authorization, 'Bearer TEST-abc');
  const applied = calls.find(c => c.url.endsWith('/pix_apply')).body;
  assert.deepEqual(applied, { p_tenant: TENANT, p_order: 7, p_ref: '999', p_mp_status: 'approved', p_amount: 4550 });
});

test('webhook: ignora avisos estranhos e sempre responde 200', async () => {
  const { post, calls } = setup();
  assert.deepEqual((await post({ type: 'merchant_order', data: { id: '1' } }, `?action=webhook&t=${TENANT}`)).data, { ignored: true });
  assert.deepEqual((await post({ type: 'payment', data: { id: '1' } }, `?action=webhook&t=nao-e-uuid`)).data, { ignored: true });
  const notFound = await post({ type: 'payment', data: { id: '123' } }, `?action=webhook&t=${TENANT}`);
  assert.equal(notFound.status, 200);
  assert.equal(notFound.data.ok, false);
  assert.equal(calls.some(c => c.url.endsWith('/pix_apply')), false);
});

test('check: botão "Já paguei" consulta o Mercado Pago', async () => {
  const { post } = setup({ order: { pixRef: '999' } });
  assert.deepEqual((await post({ action: 'check', code: 'ABCDEF123456' })).data, { status: 'novo', paid: true, mpStatus: 'approved' });
});

test('token inválido vira mensagem clara', async () => {
  const s = setup();
  const h = makeHandler({ supabaseUrl: SUPA, serviceKey: 'eyJabc', log: silent, fetchImpl: async (url, init) =>
    url.includes('mercadopago') ? new Response('{}', { status: 401 }) : new Response(JSON.stringify(s.db.order)) });
  const r = await h(new Request(`${SUPA}/functions/v1/pix`, { method: 'POST', body: JSON.stringify({ action: 'create', code: 'ABCDEF123456', email: 'a@b.com' }) }));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Access Token/);
});

test('card: cria o checkout de cartão com o valor do banco e volta para o pedido', async () => {
  const { post, calls } = setup({ order: { payment: 'Cartão online', cardOnline: true } });
  const orig = calls.length;
  const s = setup({ order: { payment: 'Cartão online', cardOnline: true } });
  // rota extra do Mercado Pago para preferências
  const r = await (async () => {
    const pref = { id: 'PREF1', init_point: 'https://mp/real', sandbox_init_point: 'https://mp/sandbox' };
    const h = makeHandler({ supabaseUrl: SUPA, serviceKey: 'sb_secret_x', log: silent, now: () => new Date('2026-11-14T00:00:00Z'), fetchImpl: async (url, init = {}) => {
      s.calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      if (url.endsWith('/pix_order')) return new Response(JSON.stringify(s.db.order));
      if (url.endsWith('/pix_expire_overdue')) return new Response('0');
      if (url === 'https://api.mercadopago.com/checkout/preferences') return new Response(JSON.stringify(pref), { status: 201 });
      return new Response('{}', { status: 500 });
    } });
    const res = await h(new Request(`${SUPA}/functions/v1/pix`, { method: 'POST', body: JSON.stringify({ action: 'card', code: 'ABCDEF123456', origin: 'https://forno.com.br' }) }));
    return { status: res.status, data: await res.json() };
  })();
  assert.equal(r.status, 200);
  assert.equal(r.data.url, 'https://mp/sandbox');            // token de teste usa o sandbox
  const pc = s.calls.find(c => c.url.endsWith('/checkout/preferences')).body;
  assert.equal(pc.items[0].unit_price, 45.5);
  assert.equal(pc.external_reference, '7');
  assert.equal(pc.back_urls.success, 'https://forno.com.br/pedido/ABCDEF123456');
  assert.match(pc.notification_url, new RegExp(`action=webhook&t=${TENANT}`));
  assert.equal(orig, calls.length);
  // origem estranha, pedido Pix ou loja sem cartão
  assert.equal((await post({ action: 'card', code: 'ABCDEF123456', origin: 'javascript:alert(1)' })).status, 400);
  assert.equal((await setup().post({ action: 'card', code: 'ABCDEF123456', origin: 'https://a.com' })).status, 400);
  assert.equal((await setup({ order: { payment: 'Cartão online', cardOnline: false } }).post({ action: 'card', code: 'ABCDEF123456', origin: 'https://a.com' })).status, 400);
});

test('check de cartão: procura a tentativa aprovada; webhook aceita pagamento com cartão', async () => {
  const s = setup({ order: { payment: 'Cartão online', cardOnline: true }, mpPayment: { payment_method_id: 'visa', id: 999 } });
  const h = makeHandler({ supabaseUrl: SUPA, serviceKey: 'sb_secret_x', log: silent, fetchImpl: async (url, init = {}) => {
    s.calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/pix_order')) return new Response(JSON.stringify(s.db.order));
    if (url.endsWith('/pix_apply')) return new Response(JSON.stringify('novo'));
    if (url.includes('/v1/payments/search')) return new Response(JSON.stringify({ results: [{ id: 1, status: 'rejected', external_reference: '7' }, { id: 2, status: 'approved', external_reference: '7', transaction_amount: 45.5 }] }));
    return new Response('{}', { status: 500 });
  } });
  const r = await h(new Request(`${SUPA}/functions/v1/pix`, { method: 'POST', body: JSON.stringify({ action: 'check', code: 'ABCDEF123456' }) }));
  assert.deepEqual(await r.json(), { status: 'novo', paid: true, mpStatus: 'approved' });
  assert.deepEqual(s.calls.find(c => c.url.endsWith('/pix_apply')).body, { p_tenant: TENANT, p_order: 7, p_ref: '2', p_mp_status: 'approved', p_amount: 4550 });
  const w = await s.post({ type: 'payment', data: { id: '999' } }, `?action=webhook&t=${TENANT}`);
  assert.deepEqual(w.data, { ok: true, status: 'novo' });
});

// ---- maquininha Point no totem ----
function setupPoint({ order = {}, mo = {}, member = true, owner = true } = {}) {
  const calls = [];
  const db = { order: { id: 9, number: 140, code: 'KIOSK1234567', total: 4700, status: 'pagamento', payment: 'Cartão no totem', paymentStatus: 'pending', pixRef: null,
    customerName: 'Ana', tenantId: TENANT, storeName: 'Forno', token: 'APP_USR-x', pointTerminal: 'NEWLAND_N950__N950NCB801293324', channel: 'totem', ...order } };
  const mpOrder = { id: 'ORD01ABC', status: 'at_terminal', external_reference: '9', total_amount: '47.00', transactions: { payments: [{ id: 'PAY1', amount: '47.00', status: 'created' }] }, ...mo };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body });
    const res = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.startsWith(`${SUPA}/rest/v1/rpc/`)) {
      const fn = url.split('/').pop();
      if (fn === 'is_kiosk' || fn === 'is_owner') return res(init.headers.Authorization === 'Bearer user-jwt-aaaaaaaaaaaaaaaaaaaa' && init.headers.apikey === 'anon-key' && body.p_tenant === TENANT && (fn === 'is_kiosk' ? member : owner));
      if (fn === 'pix_order') return res(body.p_code === db.order.code ? db.order : null);
      if (fn === 'pix_token') return res(body.p_tenant === TENANT ? 'APP_USR-x' : null);
      if (fn === 'point_save') { db.order.pixRef = body.p_ref; return res(null); }
      if (fn === 'pix_apply') return res(body.p_mp_status === 'approved' ? 'novo' : 'pagamento');
    }
    if (url === 'https://api.mercadopago.com/v1/orders' && init.method === 'POST') return res(mpOrder, 201);
    if (url === 'https://api.mercadopago.com/v1/orders/ORD01ABC') return res(mpOrder);
    if (url === 'https://api.mercadopago.com/v1/orders/ORD01ABC/cancel') return res({ ...mpOrder, status: 'canceled' });
    if (url.startsWith('https://api.mercadopago.com/terminals/v1/list')) return res({ data: { terminals: [{ id: 'NEWLAND_N950__N950NCB801293324', pos_id: '1', store_id: '2', operating_mode: 'STANDALONE' }] } });
    if (url === 'https://api.mercadopago.com/terminals/v1/setup' && init.method === 'PATCH') return res({ terminals: body.terminals });
    return res({ message: 'rota inesperada ' + url }, 500);
  };
  const handler = makeHandler({ supabaseUrl: SUPA, serviceKey: 'sb_secret_x', anonKey: 'anon-key', fetchImpl, now: () => new Date('2026-11-23T12:00:00Z'), log: silent });
  const post = async (body, auth = 'Bearer user-jwt-aaaaaaaaaaaaaaaaaaaa', qs = '') => { const r = await handler(new Request(`${SUPA}/functions/v1/pix${qs}`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) })); return { status: r.status, data: await r.json() }; };
  return { post, calls, db };
}

test('point: dono lista as maquininhas e liga o modo integrado; equipe e anônimo não', async () => {
  const { post, calls } = setupPoint();
  const r = await post({ action: 'point_terminals', tenant: TENANT });
  assert.deepEqual(r.data.terminals, [{ id: 'NEWLAND_N950__N950NCB801293324', mode: 'STANDALONE', posId: '1', storeId: '2' }]);
  assert.equal(calls.find(c => c.url.includes('/terminals/v1/list')).headers.Authorization, 'Bearer APP_USR-x');
  const s = await post({ action: 'point_setup', tenant: TENANT, terminal: 'NEWLAND_N950__N950NCB801293324' });
  assert.equal(s.data.ok, true);
  assert.deepEqual(calls.find(c => c.url.endsWith('/terminals/v1/setup')).body, { terminals: [{ id: 'NEWLAND_N950__N950NCB801293324', operating_mode: 'PDV' }] });
  assert.equal((await setupPoint({ owner: false }).post({ action: 'point_terminals', tenant: TENANT })).status, 403);
  assert.equal((await setupPoint().post({ action: 'point_terminals', tenant: TENANT }, null)).status, 401);
  assert.equal((await setupPoint().post({ action: 'point_setup', tenant: TENANT, terminal: "x'; drop" })).status, 400);
});

test('point: cobra na maquininha com o valor do banco, confere e aplica quando aprovado', async () => {
  const { post, calls, db } = setupPoint();
  const r = await post({ action: 'point_charge', code: 'KIOSK1234567', total: 1 });
  assert.equal(r.status, 200); assert.equal(r.data.mpStatus, 'at_terminal');
  const mo = calls.find(c => c.url === 'https://api.mercadopago.com/v1/orders');
  assert.equal(mo.body.type, 'point'); assert.equal(mo.body.external_reference, '9');
  assert.equal(mo.body.transactions.payments[0].amount, '47.00');                  // vem do banco
  assert.equal(mo.body.config.point.terminal_id, 'NEWLAND_N950__N950NCB801293324');
  assert.ok(mo.headers['X-Idempotency-Key']);
  assert.equal(db.order.pixRef, 'ORD01ABC');
  // ainda na maquininha: não aplica
  let c = await post({ action: 'point_check', code: 'KIOSK1234567' });
  assert.equal(c.data.paid, false); assert.ok(!calls.some(x => x.url.endsWith('/pix_apply')));
  // aprovado
  const paid = setupPoint({ order: { pixRef: 'ORD01ABC' }, mo: { status: 'processed', transactions: { payments: [{ id: 'PAY1', amount: '47.00', status: 'processed' }] } } });
  c = await paid.post({ action: 'point_check', code: 'KIOSK1234567' });
  assert.equal(c.data.paid, true); assert.equal(c.data.status, 'novo');
  assert.deepEqual(paid.calls.find(x => x.url.endsWith('/pix_apply')).body, { p_tenant: TENANT, p_order: 9, p_ref: 'ORD01ABC', p_mp_status: 'approved', p_amount: 4700 });
  // order de outro pedido: recusa
  const wrong = setupPoint({ order: { pixRef: 'ORD01ABC' }, mo: { external_reference: '77', status: 'processed' } });
  assert.equal((await wrong.post({ action: 'point_check', code: 'KIOSK1234567' })).status, 400);
});

test('point: exige equipe da loja, pedido de cartão no totem e maquininha configurada', async () => {
  assert.equal((await setupPoint({ member: false }).post({ action: 'point_charge', code: 'KIOSK1234567' })).status, 403);
  assert.equal((await setupPoint().post({ action: 'point_charge', code: 'KIOSK1234567' }, null)).status, 401);
  assert.equal((await setupPoint({ order: { payment: 'Pix online' } }).post({ action: 'point_charge', code: 'KIOSK1234567' })).status, 400);
  assert.equal((await setupPoint({ order: { pointTerminal: null } }).post({ action: 'point_charge', code: 'KIOSK1234567' })).status, 400);
  assert.deepEqual((await setupPoint({ order: { status: 'novo', paymentStatus: 'paid' } }).post({ action: 'point_charge', code: 'KIOSK1234567' })).data, { status: 'novo', paid: true });
  const cancel = setupPoint({ order: { pixRef: 'ORD01ABC' } });
  assert.equal((await cancel.post({ action: 'point_cancel', code: 'KIOSK1234567' })).data.ok, true);
  assert.ok(cancel.calls.some(c => c.url.endsWith('/ORD01ABC/cancel')));
});

test('point: aviso do Mercado Pago (order) é reconferido na API', async () => {
  const { post, calls } = setupPoint({ mo: { status: 'processed' } });
  const r = await post({ type: 'order', data: { id: 'ORD01ABC' } }, null, `?action=webhook&t=${TENANT}`);
  assert.deepEqual(r.data, { ok: true, status: 'novo' });
  assert.ok(calls.some(c => c.url === 'https://api.mercadopago.com/v1/orders/ORD01ABC'));
});
