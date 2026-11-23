// @ts-nocheck  (JavaScript puro; roda no Deno do Supabase e nos testes do Node)
// Edge Function "pix": cobrança Pix e cartão de crédito pelo Mercado Pago para os pedidos do Balcão.
//
// Ações (POST com JSON):
//   { action: "create", code, email } -> cria (ou reaproveita) a cobrança Pix do pedido e devolve QR Code e copia-e-cola
//   { action: "check",  code }        -> confere o pagamento direto na API do Mercado Pago (botão "Já paguei")
//   { action: "card",   code, origin } -> cria o checkout de cartão do Mercado Pago e devolve o link para pagar
//   { action: "check",  code }        -> também vale para cartão: procura um pagamento aprovado do pedido
//   ?action=webhook&t=<empresa>       -> aviso do Mercado Pago; o pagamento é SEMPRE reconferido na API antes de valer
//
// Cartão no totem (maquininha Mercado Pago Point, API de Orders). Exigem login da equipe da loja (token do usuário):
//   { action: "point_terminals", tenant }        -> (dono) lista as maquininhas da conta e o modo de cada uma
//   { action: "point_setup", tenant, terminal }  -> (dono) coloca a maquininha em modo integrado (PDV)
//   { action: "point_charge", code }             -> manda a cobrança do pedido do totem para a maquininha
//   { action: "point_check",  code }             -> confere a cobrança no Mercado Pago (o aviso também chega pelo webhook)
//   { action: "point_cancel", code }             -> tenta cancelar a cobrança que ainda não foi paga
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

export function makeHandler({ supabaseUrl, serviceKey, anonKey, fetchImpl = fetch, now = () => new Date(), log = console }) {
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

  // Confere quem está chamando: a equipe (ou o dono) da loja, com o token de login do próprio usuário
  async function userCan(req, fn, tenant) {
    const auth = req.headers.get('authorization') || '';
    if (!/^Bearer .{20,}$/.test(auth) || !anonKey) throw new HttpError(401, 'Faça login no painel da loja');
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: auth }, body: JSON.stringify({ p_tenant: tenant }) });
    const ok = r.ok && (await r.json().catch(() => false)) === true;
    if (!ok) throw new HttpError(403, 'Sem permissão');
  }

  const apply = (tenantId, orderId, pay) => rpc('pix_apply', {
    p_tenant: tenantId, p_order: orderId, p_ref: String(pay.id), p_mp_status: pay.status, p_amount: Math.round(Number(pay.transaction_amount) * 100)
  });

  async function loadOrder(code, kinds = ['Pix online']) {
    if (!code || !/^[A-Za-z0-9]{6,20}$/.test(String(code))) throw new HttpError(400, 'Código do pedido inválido');
    const o = await rpc('pix_order', { p_code: String(code) });
    if (!o) throw new HttpError(404, 'Pedido não encontrado');
    if (!kinds.includes(o.payment)) throw new HttpError(400, kinds.length === 1 && kinds[0] === 'Cartão online' ? 'Este pedido não é cartão online' : 'Este pedido não é Pix online');
    return o;
  }

  // Endereço para onde o Mercado Pago devolve o cliente depois de pagar: só https (ou localhost em testes).
  const safeOrigin = o => { const v = String(o || ''); return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v) || /^http:\/\/localhost(:\d+)?$/.test(v) ? v : null; };

  async function card(body) {
    rpc('pix_expire_overdue', {}).catch(() => {});
    const o = await loadOrder(body.code, ['Cartão online']);
    if (o.status !== 'pagamento') return { status: o.status, paid: o.paymentStatus === 'paid' };
    if (!o.cardOnline || !o.token) throw new HttpError(400, 'A loja desativou o cartão online');
    const origin = safeOrigin(body.origin);
    if (!origin) throw new HttpError(400, 'Endereço de retorno inválido');
    const back = `${origin}/pedido/${o.code}`;
    const pref = await mp(o.token, '/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ id: String(o.id), title: `Pedido #${o.number} - ${o.storeName}`.slice(0, 120), quantity: 1, unit_price: o.total / 100, currency_id: 'BRL' }],
        payer: { name: String(o.customerName || '').split(' ')[0] || 'Cliente' },
        external_reference: String(o.id),
        notification_url: `${supabaseUrl}/functions/v1/pix?action=webhook&t=${o.tenantId}`,
        back_urls: { success: back, pending: back, failure: back },
        auto_return: 'approved',
        statement_descriptor: String(o.storeName || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 13) || undefined,
        // só cartão: boleto e Pix ficam de fora (o Pix tem a opção própria)
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }, { id: 'atm' }], installments: 12 },
        expires: true,
        expiration_date_to: new Date(now().getTime() + 40 * 60000).toISOString().replace('Z', '+00:00')
      })
    });
    const url = o.token.startsWith('TEST-') ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
    if (!url) throw new HttpError(502, 'O Mercado Pago não devolveu o link de pagamento');
    return { status: o.status, url };
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
    const o = await loadOrder(body.code, ['Pix online', 'Cartão online']);
    if (o.payment === 'Cartão online') {
      if (o.paymentStatus === 'paid' || !o.token) return { status: o.status, paid: o.paymentStatus === 'paid' };
      // no cartão o pedido pode ter várias tentativas: procura uma aprovada
      const found = await mp(o.token, `/v1/payments/search?external_reference=${encodeURIComponent(String(o.id))}&sort=date_created&criteria=desc`);
      const pay = (found?.results || []).find(p => p.status === 'approved' && String(p.external_reference) === String(o.id));
      if (!pay) return { status: o.status, paid: false, mpStatus: found?.results?.[0]?.status || null };
      const status = await apply(o.tenantId, o.id, pay);
      return { status, paid: true, mpStatus: 'approved' };
    }
    if (o.paymentStatus === 'paid' || !o.pixRef || !o.token) return { status: o.status, paid: o.paymentStatus === 'paid' };
    const pay = await mp(o.token, `/v1/payments/${encodeURIComponent(o.pixRef)}`);
    const status = await apply(o.tenantId, o.id, pay);
    return { status, paid: pay.status === 'approved', mpStatus: pay.status };
  }

  // ---- Maquininha Point (API de Orders) ----
  const UUID = /^[0-9a-f-]{36}$/;
  async function pointTerminals(req, body) {
    if (!UUID.test(String(body.tenant || ''))) throw new HttpError(400, 'Loja inválida');
    await userCan(req, 'is_owner', body.tenant);
    const token = await rpc('pix_token', { p_tenant: body.tenant });
    if (!token) throw new HttpError(400, 'Cadastre o Access Token do Mercado Pago da loja primeiro');
    const r = await mp(token, '/terminals/v1/list?limit=50&offset=0');
    return { terminals: (r?.data?.terminals || []).map(t => ({ id: t.id, mode: t.operating_mode, posId: t.pos_id, storeId: t.store_id })) };
  }
  async function pointSetup(req, body) {
    if (!UUID.test(String(body.tenant || '')) || !/^[A-Za-z0-9_-]{4,80}$/.test(String(body.terminal || ''))) throw new HttpError(400, 'Dados inválidos');
    await userCan(req, 'is_owner', body.tenant);
    const token = await rpc('pix_token', { p_tenant: body.tenant });
    if (!token) throw new HttpError(400, 'Cadastre o Access Token do Mercado Pago da loja primeiro');
    await mp(token, '/terminals/v1/setup', { method: 'PATCH', body: JSON.stringify({ terminals: [{ id: body.terminal, operating_mode: 'PDV' }] }) });
    return { ok: true };
  }
  async function pointOrder(req, code) {
    const o = await loadOrder(code, ['Cartão no totem']);
    await userCan(req, 'is_kiosk', o.tenantId);   // equipe ou conta de totem da loja
    return o;
  }
  // Status da order no Mercado Pago -> pago? (processed = aprovado)
  const pointPaid = mo => mo?.status === 'processed' || (mo?.transactions?.payments || []).some(p => p.status === 'processed');
  const pointAmount = mo => Math.round(Number(mo?.total_amount ?? mo?.transactions?.payments?.[0]?.amount ?? 0) * 100);
  async function pointApply(o, mo) {
    return rpc('pix_apply', { p_tenant: o.tenantId, p_order: o.id, p_ref: String(mo.id), p_mp_status: pointPaid(mo) ? 'approved' : String(mo.status || ''), p_amount: pointAmount(mo) });
  }
  async function pointCharge(req, body) {
    const o = await pointOrder(req, body.code);
    if (o.paymentStatus === 'paid' || o.status !== 'pagamento') return { status: o.status, paid: o.paymentStatus === 'paid' };
    if (!o.token) throw new HttpError(400, 'A loja não tem o Mercado Pago configurado');
    if (!o.pointTerminal) throw new HttpError(400, 'Nenhuma maquininha configurada para o totem');
    const mo = await mp(o.token, '/v1/orders', {
      method: 'POST',
      // cada nova tentativa é uma cobrança nova (o cliente pode tentar outro cartão)
      headers: { 'X-Idempotency-Key': `${o.code}-point-${now().getTime()}` },
      body: JSON.stringify({
        type: 'point',
        external_reference: String(o.id),
        description: `Pedido #${o.number} - ${o.storeName}`.slice(0, 120),
        expiration_time: 'PT3M',
        transactions: { payments: [{ amount: (o.total / 100).toFixed(2) }] },
        config: { point: { terminal_id: o.pointTerminal, print_on_terminal: 'no_ticket' } }
      })
    });
    if (!mo?.id) throw new HttpError(502, 'O Mercado Pago não criou a cobrança na maquininha');
    await rpc('point_save', { p_order: o.id, p_ref: String(mo.id) });
    return { status: o.status, paid: false, mpStatus: mo.status || 'created' };
  }
  async function pointCheck(req, body) {
    const o = await pointOrder(req, body.code);
    if (o.paymentStatus === 'paid' || !o.pixRef || !o.token) return { status: o.status, paid: o.paymentStatus === 'paid' };
    const mo = await mp(o.token, `/v1/orders/${encodeURIComponent(o.pixRef)}`);
    if (String(mo.external_reference) !== String(o.id)) throw new HttpError(400, 'Cobrança não corresponde ao pedido');
    const status = pointPaid(mo) ? await pointApply(o, mo) : o.status;
    return { status, paid: pointPaid(mo), mpStatus: mo.status };
  }
  async function pointCancel(req, body) {
    const o = await pointOrder(req, body.code);
    if (o.paymentStatus === 'paid' || !o.pixRef || !o.token) return { ok: true };
    // só dá para cancelar pela API antes de o cliente começar a pagar; depois, cancela-se na própria maquininha
    try { await mp(o.token, `/v1/orders/${encodeURIComponent(o.pixRef)}/cancel`, { method: 'POST', headers: { 'X-Idempotency-Key': `${o.pixRef}-cancel` } }); } catch (e) { log.error('point_cancel', e?.message); }
    return { ok: true };
  }

  async function webhook(url, body) {
    const tenant = url.searchParams.get('t') || '';
    const type = body?.type || url.searchParams.get('type') || url.searchParams.get('topic');
    const payId = body?.data?.id || url.searchParams.get('data.id') || (type === 'payment' ? url.searchParams.get('id') : null);
    if (type === 'order' && payId && UUID.test(tenant)) {
      // maquininha Point: busca a order no Mercado Pago e aplica se o pedido for do totem desta loja
      const token = await rpc('pix_token', { p_tenant: tenant });
      if (!token) return { ignored: true };
      const mo = await mp(token, `/v1/orders/${encodeURIComponent(String(payId))}`);
      const orderId = Number(mo.external_reference);
      if (!Number.isInteger(orderId) || !pointPaid(mo)) return { ok: true, paid: false };
      const status = await rpc('pix_apply', { p_tenant: tenant, p_order: orderId, p_ref: String(mo.id), p_mp_status: 'approved', p_amount: pointAmount(mo) });
      return { ok: true, status };
    }
    if (type !== 'payment' || !payId || !/^[0-9a-f-]{36}$/.test(tenant)) return { ignored: true };
    const token = await rpc('pix_token', { p_tenant: tenant });
    if (!token) return { ignored: true };
    // Nunca confiar no corpo do aviso: o pagamento é buscado direto no Mercado Pago com o token da loja.
    const pay = await mp(token, `/v1/payments/${encodeURIComponent(String(payId))}`);
    const orderId = Number(pay.external_reference);
    // Pix ou cartão: o banco confere se a forma de pagamento e o valor batem com o pedido
    if (!Number.isInteger(orderId)) return { ignored: true };
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
      if (action === 'card') return json(await card(body));
      if (action === 'point_terminals') return json(await pointTerminals(req, body));
      if (action === 'point_setup') return json(await pointSetup(req, body));
      if (action === 'point_charge') return json(await pointCharge(req, body));
      if (action === 'point_check') return json(await pointCheck(req, body));
      if (action === 'point_cancel') return json(await pointCancel(req, body));
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
    serviceKey: Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('ANON_KEY')
  }));
}
