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
