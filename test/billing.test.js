// Testes da Edge Function "billing" com banco, login e Mercado Pago simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../supabase/functions/billing/index.ts';

const SUPA = 'https://proj.supabase.co';
const TENANT = '11111111-2222-3333-4444-555555555555';
const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001';
const silent = { error() {} };

function setup({ tenant = {}, pre = {}, user = { id: OWNER, email: 'dono@loja.com' }, mpToken = 'APP_USR-plataforma' } = {}) {
  const calls = [];
  const t = { id: TENANT, name: 'Forno', slug: 'forno', plan: 'Pro', price: 14900, status: 'trial', trialEndsAt: '2026-11-27T00:00:00Z',
    paidUntil: null, preapprovalId: null, owners: [{ userId: OWNER, email: 'dono@loja.com' }], ...tenant };
  const preapproval = { id: 'PRE-1', status: 'authorized', next_payment_date: '2026-11-27T00:00:00Z', external_reference: TENANT, init_point: 'https://mp/checkout/PRE-1', ...pre };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url === `${SUPA}/auth/v1/user`) return init.headers.Authorization === 'Bearer eyJusuario' ? res(user) : res({ msg: 'invalid' }, 401);
    if (url.startsWith(`${SUPA}/rest/v1/rpc/`)) {
      const fn = url.split('/').pop();
      if (fn === 'billing_tenant') return res(body.p_tenant === TENANT ? t : null);
      if (fn === 'billing_set_preapproval') return res(null);
      if (fn === 'billing_apply') return res(body.p_mp_status === 'authorized' ? 'active' : body.p_mp_status === 'cancelled' ? 'canceled' : 'past_due');
    }
    if (url === 'https://api.mercadopago.com/preapproval' && init.method === 'POST') return res(preapproval, 201);
    if (url.startsWith('https://api.mercadopago.com/preapproval/PRE-1')) return res(init.method === 'PUT' ? { ...preapproval, ...(body.status ? { status: body.status } : {}) } : preapproval);
    if (url === 'https://api.mercadopago.com/authorized_payments/777') return res({ id: 777, preapproval_id: 'PRE-1' });
    return res({ message: 'rota inesperada ' + url }, 404);
  };
  const handler = makeHandler({ supabaseUrl: SUPA, serviceKey: 'sb_secret_x', mpToken, siteUrl: 'https://loja.vercel.app/', fetchImpl, now: () => new Date('2026-11-14T00:00:00Z'), log: silent });
  const post = async (body, { qs = '', token = 'eyJusuario' } = {}) => {
    const r = await handler(new Request(`${SUPA}/functions/v1/billing${qs}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
    return { status: r.status, data: await r.json() };
  };
  return { post, calls };
}

test('subscribe: cria assinatura com o valor do plano e 1ª cobrança no fim do teste grátis', async () => {
  const { post, calls } = setup();
  const r = await post({ action: 'subscribe', tenant: TENANT });
  assert.equal(r.status, 200);
  assert.equal(r.data.url, 'https://mp/checkout/PRE-1');
  const c = calls.find(x => x.url === 'https://api.mercadopago.com/preapproval');
  assert.equal(c.headers.Authorization, 'Bearer APP_USR-plataforma');
  assert.equal(c.body.auto_recurring.transaction_amount, 149);
  assert.equal(c.body.auto_recurring.start_date, '2026-11-27T00:00:00.000Z');
  assert.equal(c.body.external_reference, TENANT);
  assert.equal(c.body.payer_email, 'dono@loja.com');
  assert.equal(c.body.back_url, 'https://loja.vercel.app/painel/config?assinatura=retorno');
  assert.ok(calls.some(x => x.url.endsWith('/billing_set_preapproval')));
});

test('subscribe: teste já vencido cobra na hora; loja liberada não assina', async () => {
  const late = setup({ tenant: { trialEndsAt: '2026-11-01T00:00:00Z' } });
  await late.post({ action: 'subscribe', tenant: TENANT });
  const c = late.calls.find(x => x.url === 'https://api.mercadopago.com/preapproval');
  assert.equal(c.body.auto_recurring.start_date, '2026-11-14T00:01:00.000Z');
  assert.equal((await setup({ tenant: { status: 'free' } }).post({ action: 'subscribe', tenant: TENANT })).status, 400);
});

test('só o dono logado mexe na assinatura', async () => {
  assert.equal((await setup().post({ action: 'subscribe', tenant: TENANT }, { token: null })).status, 401);
  assert.equal((await setup().post({ action: 'subscribe', tenant: TENANT }, { token: 'eyJfalso' })).status, 401);
  assert.equal((await setup({ user: { id: 'outra-pessoa', email: 'x@y.com' } }).post({ action: 'subscribe', tenant: TENANT })).status, 403);
  assert.equal((await setup().post({ action: 'subscribe', tenant: 'nao-uuid' })).status, 400);
});

test('sync e cancel conferem e atualizam pelo Mercado Pago', async () => {
  const s = setup({ tenant: { preapprovalId: 'PRE-1' } });
  assert.deepEqual((await s.post({ action: 'sync', tenant: TENANT })).data, { status: 'active', mpStatus: 'authorized' });
  const applied = s.calls.find(x => x.url.endsWith('/billing_apply')).body;
  assert.deepEqual(applied, { p_tenant: TENANT, p_preapproval: 'PRE-1', p_mp_status: 'authorized', p_next_payment: '2026-11-27T00:00:00Z' });
  assert.deepEqual((await s.post({ action: 'cancel', tenant: TENANT })).data, { status: 'canceled' });
  assert.ok(s.calls.some(x => x.method === 'PUT' && x.body.status === 'cancelled'));
});

test('troca de plano atualiza o valor da mensalidade ativa', async () => {
  const s = setup({ tenant: { preapprovalId: 'PRE-1', plan: 'Rede', price: 34900 } });
  assert.deepEqual((await s.post({ action: 'update_amount', tenant: TENANT })).data, { updated: true });
  assert.equal(s.calls.find(x => x.method === 'PUT').body.auto_recurring.transaction_amount, 349);
});

test('webhook: assinatura e cobrança mensal são reconferidas na API', async () => {
  const s = setup();
  assert.deepEqual((await s.post({ type: 'subscription_preapproval', data: { id: 'PRE-1' } }, { qs: '?action=webhook', token: null })).data, { ok: true, status: 'active' });
  assert.deepEqual((await s.post({ type: 'subscription_authorized_payment', data: { id: '777' } }, { qs: '?action=webhook', token: null })).data, { ok: true, status: 'active' });
  assert.deepEqual((await s.post({ type: 'payment', data: { id: '1' } }, { qs: '?action=webhook', token: null })).data, { ignored: true });
  const bad = setup({ pre: { external_reference: 'nada' } });
  assert.deepEqual((await bad.post({ type: 'subscription_preapproval', data: { id: 'PRE-1' } }, { qs: '?action=webhook', token: null })).data, { ignored: true });
});

test('sem token da plataforma, mensagem clara', async () => {
  const r = await setup({ mpToken: '' }).post({ action: 'subscribe', tenant: TENANT });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /MP_PLATFORM_TOKEN/);
});
