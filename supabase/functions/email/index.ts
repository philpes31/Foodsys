// @ts-nocheck  (JavaScript puro; roda no Deno do Supabase e nos testes do Node)
// Edge Function "email": envia os e-mails automáticos pelo Resend (https://resend.com).
//
// Quem chama é o banco (pg_net), com o cabeçalho x-email-secret igual ao segredo EMAIL_SECRET.
// Corpo: { "id": <id do e-mail na fila> }. A função pega o item (email_take), monta o texto e envia.
// Se o Resend recusar, o erro fica gravado na fila (aparece na tela Plataforma).
//
// Segredos da função: RESEND_API_KEY, EMAIL_SECRET (gerado na tela Plataforma), EMAIL_FROM (opcional,
// ex.: "Balcão <avisos@seudominio.com.br>"; sem domínio próprio no Resend, use "onboarding@resend.dev",
// que só entrega para o e-mail da própria conta do Resend) e SITE_URL (opcional, ex.: https://meusite.com.br).
// Publicar sem verificação de JWT (o banco não manda token de usuário).

const BRL = c => 'R$ ' + (Math.round(c || 0) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nl = s => esc(s).replace(/\n/g, '<br>');
const dateBR = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
const CAT = { erro: 'Erro no sistema', duvida: 'Dúvida', financeiro: 'Assinatura e pagamento', sugestao: 'Sugestão' };

function layout(title, body, button) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f1ec;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1716">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
  <tr><td style="background:#1d1716;color:#fff;padding:16px 24px;font-weight:800;font-size:18px">Balcão</td></tr>
  <tr><td style="padding:24px">
    <h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
    <div style="font-size:15px;line-height:1.55">${body}</div>
    ${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${esc(button.label)}</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:14px 24px;color:#8a817c;font-size:12px;border-top:1px solid #eee">E-mail automático do sistema Balcão. Não é preciso responder.</td></tr>
  </table></td></tr></table></body></html>`;
}

// Monta assunto, HTML e texto simples de cada tipo de e-mail
export function render(kind, d, site = '') {
  const link = p => site ? site.replace(/\/$/, '') + p : '';
  const btn = (label, p) => site ? { label, url: link(p) } : null;
  switch (kind) {
    case 'chamado_novo':
    case 'chamado_mensagem': {
      const novo = kind === 'chamado_novo';
      const subject = `${novo ? 'Chamado novo' : 'Nova mensagem'} #${d.ticket} · ${d.store}: ${d.subject}`;
      const body = `<p><b>${esc(d.store)}</b>${d.from ? ` (${esc(d.from)})` : ''} ${novo ? 'abriu um chamado' : 'respondeu o chamado'}${novo && d.category ? ` de <b>${esc(CAT[d.category] || d.category)}</b>` : ''}:</p>
        <p style="margin:0 0 6px"><b>${esc(d.subject)}</b></p><blockquote style="margin:0;padding:10px 14px;background:#f6f3ef;border-radius:10px">${nl(d.body)}</blockquote>`;
      return { subject, html: layout(novo ? 'Chamado novo' : 'Nova mensagem no chamado', body, btn('Abrir os chamados', '/plataforma/chamados')),
        text: `${subject}\n\n${d.body}\n\n${link('/plataforma/chamados')}` };
    }
    case 'chamado_resposta': {
      const subject = `Resposta do suporte · chamado #${d.ticket}: ${d.subject}`;
      const body = `<p>O suporte respondeu o seu chamado <b>${esc(d.subject)}</b>:</p>
        <blockquote style="margin:0;padding:10px 14px;background:#f6f3ef;border-radius:10px">${nl(d.body)}</blockquote>
        <p>Para responder, abra a aba <b>Ajuda</b> no painel da loja.</p>`;
      return { subject, html: layout('O suporte respondeu', body, btn('Abrir a aba Ajuda', '/painel/ajuda')), text: `${subject}\n\n${d.body}\n\nResponda pela aba Ajuda do painel. ${link('/painel/ajuda')}` };
    }
    case 'teste_acabando': {
      const subject = `Seu teste grátis do Balcão termina em ${dateBR(d.endsAt)}`;
      const body = `<p>O período de teste da <b>${esc(d.store)}</b> termina em <b>${esc(dateBR(d.endsAt))}</b>.</p>
        <p>Para a loja continuar recebendo pedidos sem interrupção, escolha um plano no painel, em <b>Configurações → Assinatura</b>.</p>`;
      return { subject, html: layout('Seu teste está acabando', body, btn('Escolher um plano', '/painel/config')), text: `${subject}\n\nEscolha um plano em Configurações → Assinatura. ${link('/painel/config')}` };
    }
    case 'assinatura_vencida': {
      const subject = `Pagamento da assinatura pendente · ${d.store}`;
      const body = `<p>Não identificamos o pagamento da assinatura da <b>${esc(d.store)}</b>${d.paidUntil ? ` (vencida em ${esc(dateBR(d.paidUntil))})` : ''}.</p>
        <p>Regularize em <b>Configurações → Assinatura</b> para a loja não ser pausada. Se já pagou, desconsidere este aviso.</p>`;
      return { subject, html: layout('Assinatura pendente', body, btn('Ver a assinatura', '/painel/config')), text: `${subject}\n\nRegularize em Configurações → Assinatura. ${link('/painel/config')}` };
    }
    case 'resumo_dia': {
      const ticket = d.orders ? Math.round(d.total / d.orders) : 0;
      const subject = `Resumo de ${d.date} · ${d.store}: ${d.orders} pedido(s), ${BRL(d.total)}`;
      const rows = (d.byPayment || []).map(p => `<tr><td style="padding:4px 0">${esc(p.payment)}</td><td align="right">${p.count}</td><td align="right" style="padding-left:12px">${BRL(p.total)}</td></tr>`).join('');
      const top = (d.top || []).map(p => `<li>${esc(p.name)} <span style="color:#8a817c">(${p.qty})</span></li>`).join('');
      const body = d.orders ? `<table role="presentation" width="100%" style="margin:0 0 14px"><tr>
          <td style="background:#f6f3ef;border-radius:10px;padding:12px"><div style="color:#8a817c;font-size:12px">Vendas</div><b style="font-size:20px">${BRL(d.total)}</b></td><td width="8"></td>
          <td style="background:#f6f3ef;border-radius:10px;padding:12px"><div style="color:#8a817c;font-size:12px">Pedidos</div><b style="font-size:20px">${d.orders}</b></td><td width="8"></td>
          <td style="background:#f6f3ef;border-radius:10px;padding:12px"><div style="color:#8a817c;font-size:12px">Ticket médio</div><b style="font-size:20px">${BRL(ticket)}</b></td></tr></table>
        ${rows ? `<p style="margin:0 0 4px"><b>Por forma de pagamento</b></p><table role="presentation" width="100%" style="font-size:14px">${rows}</table>` : ''}
        ${top ? `<p style="margin:14px 0 4px"><b>Mais vendidos</b></p><ol style="margin:0;padding-left:20px">${top}</ol>` : ''}
        ${d.canceled ? `<p style="color:#8a817c">${d.canceled} pedido(s) cancelado(s).</p>` : ''}`
        : '<p>Nenhum pedido neste dia.</p>';
      return { subject, html: layout(`Resumo de ${d.date}`, body, btn('Ver relatórios', '/painel/relatorios')),
        text: `${subject}\nTicket médio: ${BRL(ticket)}\n${(d.top || []).map(p => `- ${p.name} (${p.qty})`).join('\n')}` };
    }
    case 'teste':
      return { subject: 'Teste de e-mail do Balcão', html: layout('Tudo certo!', '<p>Os e-mails automáticos do Balcão estão funcionando.</p>'), text: 'Os e-mails automáticos do Balcão estão funcionando.' };
    default:
      throw new Error(`Tipo de e-mail desconhecido: ${kind}`);
  }
}

export function makeHandler({ supabaseUrl, serviceKey, resendKey, secret, from = 'Balcão <onboarding@resend.dev>', site = '', fetchImpl = fetch, log = console }) {
  if (!supabaseUrl || !serviceKey) throw new Error('Faltam SUPABASE_URL e a chave de serviço');
  const dbHeaders = { 'Content-Type': 'application/json', apikey: serviceKey, ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}) };
  const rpc = async (fn, args) => {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: dbHeaders, body: JSON.stringify(args) });
    const t = await r.text(); if (!r.ok) throw new Error(`Erro no banco (${fn}): ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const sameSecret = (a, b) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

  return async req => {
    try {
      if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
      if (!secret || !resendKey) return json({ error: 'Função sem configuração (RESEND_API_KEY, EMAIL_SECRET)' }, 500);
      if (!sameSecret(req.headers.get('x-email-secret') || '', secret)) return json({ error: 'Não autorizado' }, 401);
      const body = await req.json().catch(() => ({}));
      const id = Number(body?.id); if (!Number.isInteger(id) || id <= 0) return json({ error: 'id inválido' }, 400);
      const item = await rpc('email_take', { p_id: id });
      if (!item) return json({ sent: false, skipped: true });
      let msg;
      try { msg = render(item.kind, item.data || {}, site); }
      catch (e) { await rpc('email_result', { p_id: id, p_error: e.message }); return json({ sent: false, error: e.message }); }
      const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `balcao-email-${id}` },
        body: JSON.stringify({ from, to: item.to, subject: msg.subject, html: msg.html, text: msg.text }) });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 300);
        await rpc('email_result', { p_id: id, p_error: `Resend ${r.status}: ${t}` });
        return json({ sent: false, status: r.status });
      }
      return json({ sent: true });
    } catch (e) {
      log.error(e);
      return json({ error: 'Erro interno' }, 500);
    }
  };
}

if (typeof Deno !== 'undefined') {
  Deno.serve(makeHandler({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    serviceKey: Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    resendKey: Deno.env.get('RESEND_API_KEY'),
    secret: Deno.env.get('EMAIL_SECRET'),
    from: Deno.env.get('EMAIL_FROM') || 'Balcão <onboarding@resend.dev>',
    site: Deno.env.get('SITE_URL') || ''
  }));
}
