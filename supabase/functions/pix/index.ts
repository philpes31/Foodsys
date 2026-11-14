// @ts-nocheck  (JavaScript puro; roda no Deno do Supabase e nos testes do Node)
// Edge Function "pix": cobrança Pix pelo Mercado Pago para os pedidos do Balcão.
//
// Ações (POST com JSON):
//   { action: "create", code, email } -> cria (ou reaproveita) a cobrança Pix do pedido e devolve QR Code e copia-e-cola
//   { action: "check",  code }        -> confere o pagamento direto na API do Mercado Pago (botão "Já paguei")
//   ?action=webhook&t=<empresa>       -> aviso do Mercado Pago; o pagamento é SEMPRE reconferido na API antes de valer
//
// O dinheiro cai direto na conta do Mercado Pago de cada loja (Access Token cadastrado no painel).
// Publicar sem verificação de JWT (o Mercado Pago não manda token):  supabase functions deploy pix --no-verify-jwt

const MP_API = 'https://api.mercadopago.com';
const PIX_MINUTES = 30;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function makeHandler({ supabaseUrl, serviceKey, fetchImpl = fetch, now = () => new Date(), log = console }) {
  if (!supabaseUrl || !serviceKey) throw new Error('Faltam SUPABASE_URL e a chave de serviço');
  // Chaves novas (sb_secret_...) vão só no cabeçalho apikey; as antigas (JWT) também no Authorization.
  const dbHeaders = { 'Content-Type': 'application/json', apikey: serviceKey, ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}) };

  async function rpc(fn, args) {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: dbHeaders, body: JSON.stringify(args) });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new HttpError(400, data?.message || `Erro no banco (${fn})`);
    return data;
  }

  async function mp(token, path, init = {}) {
    const r = await fetchImpl(`${MP_API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new HttpError(502, 'O Access Token do Mercado Pago da loja é inválido ou expirou');
    if (!r.ok) throw new HttpError(502, `Mercado Pago: ${data?.message || r.status}`);
    return data;
  }

  const apply = (tenantId, orderId, pay) => rpc('pix_apply', {
    p_tenant: tenantId, p_order: orderId, p_ref: String(pay.id), p_mp_status: pay.status, p_amount: Math.round(Number(pay.transaction_amount) * 100)
  });

  async function loadOrder(code) {
    if (!code || !/^[A-Za-z0-9]{6,20}$/.test(String(code))) throw new HttpError(400, 'Código do pedido inválido');
    const o = await rpc('pix_order', { p_code: String(code) });
    if (!o) throw new HttpError(404, 'Pedido não encontrado');
    if (o.payment !== 'Pix online') throw new HttpError(400, 'Este pedido não é Pix online');
    return o;
  }

  async function create(body) {
    rpc('pix_expire_overdue', {}).catch(() => {});
    const o = await loadOrder(body.code);
    if (o.status !== 'pagamento') return { status: o.status, paid: o.paymentStatus === 'paid' };
    if (!o.pixOnline || !o.token) throw new HttpError(400, 'A loja desativou o Pix online');
    if (o.pixQr && o.pixExpiresAt && new Date(o.pixExpiresAt) > now()) {
      return { status: o.status, qr: o.pixQr, qrBase64: o.pixQrBase64, expiresAt: o.pixExpiresAt };
    }
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido para gerar o Pix');
    const expires = new Date(now().getTime() + PIX_MINUTES * 60000);
    const pay = await mp(o.token, '/v1/payments', {
      method: 'POST',
      // evita cobrança duplicada em cliques repetidos (mesmo pedido, mesmo minuto)
      headers: { 'X-Idempotency-Key': `${o.code}-${now().toISOString().slice(0, 16)}` },
      body: JSON.stringify({
        transaction_amount: o.total / 100,
        description: `Pedido #${o.number} - ${o.storeName}`.slice(0, 120),
        payment_method_id: 'pix',
        payer: { email, first_name: String(o.customerName || '').split(' ')[0] || 'Cliente' },
        external_reference: String(o.id),
        notification_url: `${supabaseUrl}/functions/v1/pix?action=webhook&t=${o.tenantId}`,
        date_of_expiration: expires.toISOString().replace('Z', '+00:00')
      })
    });
    const td = pay?.point_of_interaction?.transaction_data;
    if (!pay?.id || !td?.qr_code) throw new HttpError(502, 'O Mercado Pago não devolveu o QR Code');
    await rpc('pix_save', { p_order: o.id, p_ref: String(pay.id), p_qr: td.qr_code, p_qr_base64: td.qr_code_base64 || null, p_expires: expires.toISOString() });
    return { status: o.status, qr: td.qr_code, qrBase64: td.qr_code_base64 || null, expiresAt: expires.toISOString() };
  }

  async function check(body) {
    const o = await loadOrder(body.code);
    if (o.paymentStatus === 'paid' || !o.pixRef || !o.token) return { status: o.status, paid: o.paymentStatus === 'paid' };
    const pay = await mp(o.token, `/v1/payments/${encodeURIComponent(o.pixRef)}`);
    const status = await apply(o.tenantId, o.id, pay);
    return { status, paid: pay.status === 'approved', mpStatus: pay.status };
  }

  async function webhook(url, body) {
    const tenant = url.searchParams.get('t') || '';
    const type = body?.type || url.searchParams.get('type') || url.searchParams.get('topic');
    const payId = body?.data?.id || url.searchParams.get('data.id') || (type === 'payment' ? url.searchParams.get('id') : null);
    if (type !== 'payment' || !payId || !/^[0-9a-f-]{36}$/.test(tenant)) return { ignored: true };
    const token = await rpc('pix_token', { p_tenant: tenant });
    if (!token) return { ignored: true };
    // Nunca confiar no corpo do aviso: o pagamento é buscado direto no Mercado Pago com o token da loja.
    const pay = await mp(token, `/v1/payments/${encodeURIComponent(String(payId))}`);
    const orderId = Number(pay.external_reference);
    if (pay.payment_method_id !== 'pix' || !Number.isInteger(orderId)) return { ignored: true };
    const status = await apply(tenant, orderId, pay);
    return { ok: true, status };
  }

  return async function handler(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
    const url = new URL(req.url);
    let body = {};
    try { body = await req.json(); } catch { /* corpo vazio */ }
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      const action = url.searchParams.get('action') || body.action;
      if (action === 'webhook') {
        try { return json(await webhook(url, body)); }
        // sempre 200 para o Mercado Pago não ficar reenviando um aviso que nunca vai valer
        catch (e) { log.error('webhook', e?.message); return json({ ok: false, error: e?.message }); }
      }
      if (action === 'create') return json(await create(body));
      if (action === 'check') return json(await check(body));
      throw new HttpError(400, 'Ação inválida');
    } catch (e) {
      if (!(e instanceof HttpError)) log.error(e);
      return json({ error: e instanceof HttpError ? e.message : 'Erro interno' }, e.status || 500);
    }
  };
}

// Execução no Supabase (Deno). Em testes locais o arquivo é só importado.
if (typeof Deno !== 'undefined') {
  Deno.serve(makeHandler({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    serviceKey: Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  }));
}
