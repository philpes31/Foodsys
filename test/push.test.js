// Testes da Edge Function "push": criptografia Web Push (RFC 8291), assinatura VAPID (RFC 8292) e envio com banco simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, encryptPayload, vapidAuth, b64u } from '../supabase/functions/push/index.ts';

const subtle = crypto.subtle, enc = new TextEncoder();
const hmac = async (key, data) => new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

async function vapidKeys() {
  const k = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', k.publicKey)), jwk = await subtle.exportKey('jwk', k.privateKey);
  return { publicKey: b64u.encode(raw), privateKey: jwk.d, subject: 'mailto:teste@balcao.app', verifyKey: k.publicKey };
}
// Aparelho do cliente: par de chaves ECDH + segredo de autenticação, como o navegador gera
async function device() {
  const k = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { keys: k, p256dh: b64u.encode(new Uint8Array(await subtle.exportKey('raw', k.publicKey))), auth: b64u.encode(auth) };
}
// Descriptografa do jeito que o navegador faz (lado do aparelho)
async function decrypt(body, dev) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
  const uaPublic = b64u.decode(dev.p256dh), auth = b64u.decode(dev.auth);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, dev.keys.privateKey, 256));
  const ikm = await hmac(await hmac(auth, ecdh), cat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  assert.equal(plain.at(-1), 2, 'delimitador do último registro');
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('push: mensagem criptografada só abre no aparelho inscrito', async () => {
  const dev = await device(), other = await device();
  const msg = JSON.stringify({ title: 'Forno da Vila', body: 'Pedido #12 pronto! Pode retirar no balcão.', url: '/pedido/ABC' });
  const body = await encryptPayload(msg, dev.p256dh, dev.auth);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(await decrypt(body, dev), msg);
  await assert.rejects(decrypt(body, { ...other, p256dh: dev.p256dh, auth: dev.auth }));   // chave privada errada
  await assert.rejects(decrypt(body, { ...dev, auth: other.auth }));                        // segredo errado
  await assert.rejects(encryptPayload(msg, 'curta', dev.auth), /inválidas/);
});

test('push: assinatura VAPID válida, para a origem do serviço de push', async () => {
  const v = await vapidKeys(), now = 1_800_000_000;
  const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/xyz', v, now);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [hd, cl, sig] = jwt.split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64u.decode(cl)));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: 'mailto:teste@balcao.app' });
  assert.equal(JSON.parse(new TextDecoder().decode(b64u.decode(hd))).alg, 'ES256');
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.verifyKey, b64u.decode(sig), enc.encode(`${hd}.${cl}`)));
});

test('push: envia para cada aparelho, apaga inscrição vencida, exige o segredo', async () => {
  const v = await vapidKeys(), d1 = await device(), d2 = await device();
  const calls = [], got = [];
  const item = { title: 'Forno', body: 'Pedido #7 saiu para entrega.', url: '/pedido/X', subs: [
    { id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: d1.p256dh, auth: d1.auth },
    { id: 2, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/b', p256dh: d2.p256dh, auth: d2.auth },
    { id: 3, endpoint: 'https://169.254.169.254/latest/meta-data', p256dh: d2.p256dh, auth: d2.auth }] };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/rpc/push_take')) return new Response(JSON.parse(init.body).p_id === 5 ? JSON.stringify(item) : 'null');
    if (url.endsWith('/rpc/push_drop')) return new Response('');
    if (url === 'https://fcm.googleapis.com/fcm/send/a') { got.push(await decrypt(init.body, d1)); return new Response('', { status: 201 }); }
    if (url === 'https://updates.push.services.mozilla.com/wpush/v2/b') return new Response('', { status: 410 });
    throw new Error('url inesperada ' + url);
  };
  const h = makeHandler({ supabaseUrl: 'https://proj.supabase.co', serviceKey: 'sb_secret_x', vapid: v, secret: 's'.repeat(40), fetchImpl, log: { error() {} } });
  const req = (body, secret = 's'.repeat(40)) => new Request('https://f/push', { method: 'POST', headers: { 'x-push-secret': secret }, body: JSON.stringify(body) });

  assert.equal((await h(req({ id: 5 }, 'errado'))).status, 401);
  assert.equal(calls.length, 0, 'sem segredo não toca no banco');
  const r = await (await h(req({ id: 5 }))).json();
  assert.deepEqual(r, { sent: 1, dropped: 2, failed: 0 });
  assert.ok(!calls.some(c => c.url.includes('169.254')), 'endereço interno nunca é chamado');
  assert.deepEqual(JSON.parse(got[0]), { title: 'Forno', body: 'Pedido #7 saiu para entrega.', url: '/pedido/X' });
  const sendA = calls.find(c => c.url === 'https://fcm.googleapis.com/fcm/send/a');
  assert.equal(sendA.init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(sendA.init.headers.Authorization, /^vapid t=.+, k=/);
  assert.deepEqual(calls.filter(c => c.url.endsWith('/rpc/push_drop')).map(c => JSON.parse(c.init.body).p_sub).sort(), [2, 3]);
  assert.equal(calls.find(c => c.url.endsWith('/rpc/push_take')).init.headers.apikey, 'sb_secret_x');
  assert.deepEqual(await (await h(req({ id: 6 }))).json(), { sent: 0, skipped: true });   // já enviado
  assert.equal((await h(req({ id: 'x' }))).status, 400);
  const nocfg = makeHandler({ supabaseUrl: 'https://p', serviceKey: 'k', vapid: {}, secret: '', fetchImpl });
  assert.equal((await nocfg(req({ id: 5 }))).status, 500);
});
