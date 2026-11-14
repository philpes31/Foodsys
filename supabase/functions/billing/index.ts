// @ts-nocheck  (JavaScript puro; roda no Deno do Supabase e nos testes do Node)
// Edge Function "billing": assinatura mensal das lojas no Mercado Pago (conta do DONO DA PLATAFORMA).
//
// Ações do dono da loja (POST JSON, com o login dele — o site envia automaticamente):
//   { action: "subscribe", tenant }      -> cria a assinatura e devolve o link de pagamento do Mercado Pago
//   { action: "sync", tenant }           -> confere a assinatura na API e atualiza o status
//   { action: "update_amount", tenant }  -> depois de trocar de plano, ajusta o valor da mensalidade
//   { action: "cancel", tenant }         -> cancela a assinatura
// Aviso do Mercado Pago: ?action=webhook (configurar no painel de desenvolvedor do Mercado Pago, eventos de assinaturas)
//
// Segredos necessários (Edge Functions → Secrets): MP_PLATFORM_TOKEN e SITE_URL.
// Publicar sem verificação de JWT:  supabase functions deploy billing --no-verify-jwt

const MP_API = 'https://api.mercadopago.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function makeHandler({ supabaseUrl, serviceKey, mpToken, siteUrl, fetchImpl = fetch, now = () => new Date(), log = console }) {
  if (!supabaseUrl || !serviceKey) throw new Error('Faltam SUPABASE_URL e a chave de serviço');
  const keyHeaders = { apikey: serviceKey, ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}) };

  async function rpc(fn, args) {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHeaders }, body: JSON.stringify(args) });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new HttpError(400, data?.message || `Erro no banco (${fn})`);
    return data;
  }

  async function mp(path, init = {}) {
    if (!mpToken) throw new HttpError(500, 'A plataforma ainda não configurou o Mercado Pago (segredo MP_PLATFORM_TOKEN)');
    const r = await fetchImpl(`${MP_API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mpToken}`, ...(init.headers || {}) } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, `Mercado Pago: ${data?.message || r.status}`);
    return data;
  }

  // Quem está chamando? (token de login do Supabase enviado pelo site) — precisa ser dono da loja.
  async function requireOwner(req, tenantId) {
    if (!UUID.test(String(tenantId || ''))) throw new HttpError(400, 'Empresa inválida');
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !token.startsWith('eyJ')) throw new HttpError(401, 'Faça login novamente');
    const r = await fetchImpl(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new HttpError(401, 'Faça login novamente');
    const user = await r.json();
    const t = await rpc('billing_tenant', { p_tenant: tenantId });
    if (!t) throw new HttpError(404, 'Empresa não encontrada');
    if (!t.owners.some(o => o.userId === user.id)) throw new HttpError(403, 'Só o dono da loja pode mexer na assinatura');
    return { t, user };
  }

  const apply = (tenantId, pre) => rpc('billing_apply', {
    p_tenant: tenantId, p_preapproval: String(pre.id), p_mp_status: pre.status, p_next_payment: pre.next_payment_date || null
  });

  async function subscribe(req, body) {
    const { t, user } = await requireOwner(req, body.tenant);
    if (t.status === 'free') throw new HttpError(400, 'Sua loja já está liberada pela plataforma, não precisa assinar');
    if (!siteUrl) throw new HttpError(500, 'A plataforma ainda não configurou o endereço do site (segredo SITE_URL)');
    const trialEnd = new Date(t.trialEndsAt);
    // assinando durante o teste grátis, a 1ª cobrança só acontece quando o teste acaba
    const start = t.status === 'trial' && trialEnd > now() ? trialEnd : new Date(now().getTime() + 60000);
    const pre = await mp('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `Balcão - plano ${t.plan} - ${t.name}`.slice(0, 120),
        external_reference: t.id,
        payer_email: user.email,
        back_url: `${siteUrl.replace(/\/$/, '')}/painel/config?assinatura=retorno`,
        status: 'pending',
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: t.price / 100, currency_id: 'BRL', start_date: start.toISOString() }
      })
    });
    if (!pre?.id || !pre?.init_point) throw new HttpError(502, 'O Mercado Pago não devolveu o link de pagamento');
    await rpc('billing_set_preapproval', { p_tenant: t.id, p_preapproval: String(pre.id) });
    return { url: pre.init_point };
  }

  async function sync(req, body) {
    const { t } = await requireOwner(req, body.tenant);
    if (!t.preapprovalId) return { status: t.status };
    const pre = await mp(`/preapproval/${encodeURIComponent(t.preapprovalId)}`);
    return { status: await apply(t.id, pre), mpStatus: pre.status };
  }

  async function updateAmount(req, body) {
    const { t } = await requireOwner(req, body.tenant);
    if (!t.preapprovalId) return { updated: false };
    const pre = await mp(`/preapproval/${encodeURIComponent(t.preapprovalId)}`);
    if (pre.status !== 'authorized') return { updated: false };
    await mp(`/preapproval/${encodeURIComponent(t.preapprovalId)}`, { method: 'PUT', body: JSON.stringify({ auto_recurring: { transaction_amount: t.price / 100, currency_id: 'BRL' } }) });
    return { updated: true };
  }

  async function cancel(req, body) {
    const { t } = await requireOwner(req, body.tenant);
    if (!t.preapprovalId) throw new HttpError(400, 'Não há assinatura para cancelar');
    const pre = await mp(`/preapproval/${encodeURIComponent(t.preapprovalId)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
    return { status: await apply(t.id, { ...pre, id: pre.id || t.preapprovalId, status: 'cancelled' }) };
  }

  async function webhook(url, body) {
    const type = body?.type || url.searchParams.get('type') || url.searchParams.get('topic') || '';
    const id = body?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
    if (!id) return { ignored: true };
    let preId = null;
    if (/preapproval/.test(type)) preId = id;
    else if (type === 'subscription_authorized_payment' || type === 'authorized_payment') {
      const ap = await mp(`/authorized_payments/${encodeURIComponent(String(id))}`);
      preId = ap?.preapproval_id;
    } else return { ignored: true };
    if (!preId) return { ignored: true };
    // nunca confiar no corpo do aviso: a assinatura é buscada na API com o token da plataforma
    const pre = await mp(`/preapproval/${encodeURIComponent(String(preId))}`);
    if (!UUID.test(String(pre.external_reference || ''))) return { ignored: true };
    return { ok: true, status: await apply(pre.external_reference, pre) };
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
        catch (e) { log.error('webhook', e?.message); return json({ ok: false, error: e?.message }); }
      }
      if (action === 'subscribe') return json(await subscribe(req, body));
      if (action === 'sync') return json(await sync(req, body));
      if (action === 'update_amount') return json(await updateAmount(req, body));
      if (action === 'cancel') return json(await cancel(req, body));
      throw new HttpError(400, 'Ação inválida');
    } catch (e) {
      if (!(e instanceof HttpError)) log.error(e);
      return json({ error: e instanceof HttpError ? e.message : 'Erro interno' }, e.status || 500);
    }
  };
}

if (typeof Deno !== 'undefined') {
  Deno.serve(makeHandler({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    serviceKey: Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    mpToken: Deno.env.get('MP_PLATFORM_TOKEN'),
    siteUrl: Deno.env.get('SITE_URL')
  }));
}
