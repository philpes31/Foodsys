// Testes da Edge Function "email": modelos de texto e envio pelo Resend com banco simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, render } from '../supabase/functions/email/index.ts';

const SECRET = 's'.repeat(40);
function setup(item, resendStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt, body: opt.body ? JSON.parse(opt.body) : null });
    if (url.includes('/rpc/email_take')) return new Response(JSON.stringify(item));
    if (url.includes('/rpc/email_result')) return new Response('');
    if (url === 'https://api.resend.com/emails') return new Response(resendStatus === 200 ? '{"id":"x"}' : '{"message":"domain not verified"}', { status: resendStatus });
    throw new Error('url inesperada ' + url);
  };
  const h = makeHandler({ supabaseUrl: 'https://db', serviceKey: 'sb_secret_x', resendKey: 're_x', secret: SECRET, from: 'Balcão <a@b.com>', site: 'https://loja.app', fetchImpl, log: { error() {} } });
  const call = (headers = { 'x-email-secret': SECRET }, body = { id: 5 }) => h(new Request('https://f', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { calls, call };
}

test('email: recusa sem segredo e com id inválido', async () => {
  const { call, calls } = setup(null);
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ 'x-email-secret': 'errado' })).status, 401);
  assert.equal((await call(undefined, { id: 'x' })).status, 400);
  assert.equal(calls.length, 0);
});

test('email: envia pelo Resend com assunto, links e escape do texto da loja', async () => {
  const { call, calls } = setup({ id: 5, kind: 'chamado_novo', to: ['admin@x.com'], data: { ticket: 9, subject: 'Caixa <b>travou</b>', store: 'Forno', category: 'erro', body: 'linha 1\n<script>x</script>', from: 'dono@forno.com' } });
  const r = await call(); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { sent: true });
  const send = calls.find(c => c.url === 'https://api.resend.com/emails');
  assert.equal(send.opt.headers.Authorization, 'Bearer re_x');
  assert.equal(send.opt.headers['Idempotency-Key'], 'balcao-email-5');
  assert.deepEqual(send.body.to, ['admin@x.com']); assert.equal(send.body.from, 'Balcão <a@b.com>');
  assert.match(send.body.subject, /^Chamado novo #9 · Forno: Caixa <b>travou<\/b>$/);
  assert.ok(!send.body.html.includes('<script>x</script>')); assert.ok(send.body.html.includes('&lt;script&gt;'));
  assert.ok(send.body.html.includes('https://loja.app/plataforma/chamados'));
});

test('email: erro do Resend fica gravado na fila', async () => {
  const { call, calls } = setup({ id: 5, kind: 'teste', to: ['a@x.com'], data: {} }, 403);
  const r = await call(); assert.deepEqual(await r.json(), { sent: false, status: 403 });
  const res = calls.find(c => c.url.includes('/rpc/email_result'));
  assert.match(res.body.p_error, /^Resend 403: .*domain not verified/);
});

test('email: item já enviado não manda de novo; tipo desconhecido vira erro', async () => {
  let s = setup(null); assert.deepEqual(await (await s.call()).json(), { sent: false, skipped: true });
  s = setup({ id: 5, kind: 'xyz', to: ['a@x.com'], data: {} });
  assert.equal((await (await s.call()).json()).sent, false);
  assert.ok(!s.calls.some(c => c.url === 'https://api.resend.com/emails'));
});

test('email: modelos de resumo do dia, teste acabando e resposta', () => {
  const r = render('resumo_dia', { store: 'Forno', date: '25/11/2026', orders: 4, total: 23990, canceled: 1, byPayment: [{ payment: 'Pix', count: 3, total: 20000 }], top: [{ name: 'Calabresa', qty: 3 }] }, '');
  assert.equal(r.subject, 'Resumo de 25/11/2026 · Forno: 4 pedido(s), R$ 239,90');
  assert.ok(r.html.includes('R$ 59,98') && r.html.includes('Calabresa') && r.html.includes('1 pedido(s) cancelado(s)'));
  assert.ok(!r.html.includes('href='));   // sem SITE_URL, sem botão
  assert.match(render('resumo_dia', { store: 'F', date: 'x', orders: 0, total: 0 }).html, /Nenhum pedido/);
  assert.match(render('teste_acabando', { store: 'F', endsAt: '2026-12-01T12:00:00Z' }).subject, /termina em 01\/12\/2026/);
  assert.match(render('chamado_resposta', { ticket: 1, subject: 'X', body: 'oi' }).text, /aba Ajuda/);
});
