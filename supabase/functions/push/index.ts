// @ts-nocheck  (JavaScript puro; roda no Deno do Supabase e nos testes do Node)
// Edge Function "push": envia os avisos de pedido para o celular do cliente (Web Push, padrão dos navegadores).
//
// Quem chama é o próprio banco (gatilho de mudança de status, pela extensão pg_net), com o cabeçalho
// x-push-secret igual ao segredo PUSH_SECRET. Corpo: { "id": <id do aviso na fila> }.
// A função busca o aviso e as inscrições do pedido, criptografa a mensagem para cada aparelho
// (RFC 8291, aes128gcm) e assina com a chave VAPID (RFC 8292). Inscrições vencidas (404/410) são apagadas.
//
// Segredos da função: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SECRET (gerados na tela Plataforma).
// Publicar sem verificação de JWT (o banco não manda token de usuário):  supabase functions deploy push --no-verify-jwt

const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/'); const pad = s + '='.repeat((4 - s.length % 4) % 4);
    const bin = atob(pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
};
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Chave privada VAPID (32 bytes, base64url) + pública (65 bytes, base64url) -> CryptoKey de assinatura
async function vapidKey(publicKey, privateKey) {
  const pub = b64u.decode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY inválida');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: privateKey, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// JWT ES256 para o cabeçalho Authorization: vapid t=..., k=...
export async function vapidAuth(endpoint, { publicKey, privateKey, subject }, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await vapidKey(publicKey, privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${publicKey}`;
}

// Criptografia da mensagem para um aparelho (RFC 8291 + RFC 8188, um registro só)
export async function encryptPayload(payload, p256dh, authSecret, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys } = {}) {
  let uaPublic, auth;
  try { uaPublic = b64u.decode(p256dh); auth = b64u.decode(authSecret); } catch { throw new Error('Chaves da inscrição inválidas'); }
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('Chaves da inscrição inválidas');
  const as = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));   // 0x02 = último registro
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]);   // tamanho do registro: 4096
  return concat(salt, rs, new Uint8Array([65]), asPublic, cipher);
}

export function makeHandler({ supabaseUrl, serviceKey, vapid, secret, fetchImpl = fetch, log = console }) {
  if (!supabaseUrl || !serviceKey) throw new Error('Faltam SUPABASE_URL e a chave de serviço');
  const dbHeaders = { 'Content-Type': 'application/json', apikey: serviceKey, ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}) };
  const rpc = async (fn, args) => {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: dbHeaders, body: JSON.stringify(args) });
    const t = await r.text(); if (!r.ok) throw new Error(`Erro no banco (${fn}): ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  // Compara o segredo sem vazar o tempo de comparação
  const sameSecret = (a, b) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

  return async req => {
    try {
      if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
      if (!secret || !vapid?.publicKey || !vapid?.privateKey) return json({ error: 'Função sem configuração (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SECRET)' }, 500);
      if (!sameSecret(req.headers.get('x-push-secret') || '', secret)) return json({ error: 'Não autorizado' }, 401);
      const body = await req.json().catch(() => ({}));
      const id = Number(body?.id); if (!Number.isInteger(id) || id <= 0) return json({ error: 'id inválido' }, 400);
      const item = await rpc('push_take', { p_id: id });
      if (!item) return json({ sent: 0, skipped: true });
      const payload = JSON.stringify({ title: item.title, body: item.body, url: item.url });
      let sent = 0, dropped = 0, failed = 0;
      for (const s of item.subs || []) {
        try {
          const bodyBytes = await encryptPayload(payload, s.p256dh, s.auth);
          const r = await fetchImpl(s.endpoint, { method: 'POST', body: bodyBytes, headers: {
            'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high',
            Authorization: await vapidAuth(s.endpoint, vapid) } });
          if (r.status === 404 || r.status === 410) { await rpc('push_drop', { p_sub: s.id }); dropped++; }
          else if (r.ok) sent++;
          else { failed++; log.error(`push ${r.status}: ${(await r.text()).slice(0, 200)}`); }
        } catch (e) { failed++; log.error(e); }
      }
      return json({ sent, dropped, failed });
    } catch (e) {
      log.error(e);
      return json({ error: 'Erro interno' }, 500);
    }
  };
}

// Execução no Supabase (Deno). Em testes locais o arquivo é só importado.
if (typeof Deno !== 'undefined') {
  Deno.serve(makeHandler({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    serviceKey: Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    secret: Deno.env.get('PUSH_SECRET'),
    vapid: { publicKey: Deno.env.get('VAPID_PUBLIC_KEY'), privateKey: Deno.env.get('VAPID_PRIVATE_KEY'), subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:avisos@balcao.app' }
  }));
}
