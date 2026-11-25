-- 36. Ajuda: chamados de suporte
-- A equipe da loja (dono ou atendente) abre um chamado, com print da tela e um diagnóstico
-- automático (página, navegador e últimos erros). A administração da plataforma responde
-- em /plataforma/chamados. Tudo passa por funções; as tabelas só são lidas por quem participa.
-- Pode rodar mais de uma vez.

create table if not exists public.support_tickets (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  opened_by uuid,
  subject text not null check (length(subject) between 3 and 120),
  category text not null default 'erro' check (category in ('erro', 'duvida', 'financeiro', 'sugestao')),
  status text not null default 'aberto' check (status in ('aberto', 'respondido', 'resolvido')),
  diagnostics jsonb,
  last_from text not null default 'loja' check (last_from in ('loja', 'suporte')),
  store_seen_at timestamptz not null default now(),
  admin_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_tenant on public.support_tickets (tenant_id, updated_at desc);
create index if not exists support_tickets_status on public.support_tickets (status, updated_at desc);

create table if not exists public.support_messages (
  id bigserial primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  author uuid,
  from_support boolean not null default false,
  body text not null check (length(body) between 1 and 4000),
  attachment text,
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket on public.support_messages (ticket_id, id);

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
revoke all on public.support_tickets, public.support_messages from anon, authenticated;
drop policy if exists "chamados: equipe e suporte leem" on public.support_tickets;
create policy "chamados: equipe e suporte leem" on public.support_tickets for select to authenticated
  using (public.is_member(tenant_id) or public.is_platform_admin());
drop policy if exists "mensagens: equipe e suporte leem" on public.support_messages;
create policy "mensagens: equipe e suporte leem" on public.support_messages for select to authenticated
  using (public.is_member(tenant_id) or public.is_platform_admin());
grant select on public.support_tickets, public.support_messages to authenticated;

-- Prints: bucket privado. A loja envia na pasta dela; o suporte, na pasta "suporte".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-files', 'support-files', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_support_file(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when split_part(coalesce(p_name, ''), '/', 1) = 'suporte' then is_platform_admin()
    when split_part(coalesce(p_name, ''), '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then is_member(split_part(p_name, '/', 1)::uuid) or (not p_write and is_platform_admin())
    else false end
$$;
revoke execute on function public.can_support_file(text, boolean) from public, anon;
grant execute on function public.can_support_file(text, boolean) to authenticated;

drop policy if exists "chamados: envia print" on storage.objects;
create policy "chamados: envia print" on storage.objects for insert to authenticated
  with check (bucket_id = 'support-files' and public.can_support_file(name, true));
drop policy if exists "chamados: vê print" on storage.objects;
create policy "chamados: vê print" on storage.objects for select to authenticated
  using (bucket_id = 'support-files' and public.can_support_file(name, false));

-- Anexo só vale se estiver na pasta de quem envia
create or replace function public._support_attachment(p_tenant uuid, p_path text, p_support boolean) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if nullif(p_path, '') is null then return null; end if;
  if p_path !~ ('^' || case when p_support then 'suporte' else p_tenant::text end || '/[A-Za-z0-9._-]{1,80}$') then
    raise exception 'Anexo inválido';
  end if;
  return p_path;
end $$;

-- Diagnóstico enviado pelo navegador: só um objeto, até 12 KB
create or replace function public._support_diag(p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  if length(p::text) > 12000 then return jsonb_build_object('truncated', true, 'page', left(p->>'page', 300), 'agent', left(p->>'agent', 300)); end if;
  return p;
end $$;

create or replace function public.support_open(p_tenant uuid, p_subject text, p_category text, p_body text, p_attachment text, p_diag jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint; v_subject text := btrim(coalesce(p_subject, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if length(v_subject) < 3 then raise exception 'Escreva um assunto'; end if;
  if length(v_subject) > 120 then raise exception 'Assunto muito longo (até 120 letras)'; end if;
  if length(v_body) < 5 then raise exception 'Conte o que aconteceu'; end if;
  if length(v_body) > 4000 then raise exception 'Mensagem muito longa (até 4000 letras)'; end if;
  if coalesce(p_category, 'erro') not in ('erro', 'duvida', 'financeiro', 'sugestao') then raise exception 'Tipo de chamado inválido'; end if;
  perform _rate_limit('support-open:' || auth.uid(), 10, interval '1 hour', 'Muitos chamados em pouco tempo. Aguarde um pouco.');
  insert into support_tickets (tenant_id, opened_by, subject, category, diagnostics)
    values (p_tenant, auth.uid(), v_subject, coalesce(p_category, 'erro'), _support_diag(p_diag)) returning id into v_id;
  insert into support_messages (ticket_id, tenant_id, author, body, attachment)
    values (v_id, p_tenant, auth.uid(), v_body, _support_attachment(p_tenant, p_attachment, false));
  return v_id;
end $$;

create or replace function public.support_reply(p_ticket bigint, p_body text, p_attachment text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t support_tickets; v_support boolean; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'Chamado não encontrado'; end if;
  -- quem é da loja responde como loja, mesmo que também administre a plataforma
  v_support := not is_member(t.tenant_id) and is_platform_admin();
  if not (v_support or is_member(t.tenant_id)) then raise exception 'Chamado não encontrado'; end if;
  if length(v_body) < 1 and nullif(p_attachment, '') is null then raise exception 'Escreva uma mensagem'; end if;
  if length(v_body) > 4000 then raise exception 'Mensagem muito longa (até 4000 letras)'; end if;
  perform _rate_limit('support-msg:' || auth.uid(), 60, interval '1 hour', 'Muitas mensagens em pouco tempo. Aguarde um pouco.');
  insert into support_messages (ticket_id, tenant_id, author, from_support, body, attachment)
    values (t.id, t.tenant_id, auth.uid(), v_support, coalesce(nullif(v_body, ''), '(print anexado)'), _support_attachment(t.tenant_id, p_attachment, v_support));
  update support_tickets set
    status = case when v_support then 'respondido' else 'aberto' end,
    last_from = case when v_support then 'suporte' else 'loja' end,
    updated_at = now(),
    store_seen_at = case when v_support then store_seen_at else now() end,
    admin_seen_at = case when v_support then now() else admin_seen_at end
  where id = t.id;
end $$;

create or replace function public.support_set_status(p_ticket bigint, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t support_tickets;
begin
  select * into t from support_tickets where id = p_ticket;
  if not found or not (is_member(t.tenant_id) or is_platform_admin()) then raise exception 'Chamado não encontrado'; end if;
  if p_status not in ('aberto', 'respondido', 'resolvido') then raise exception 'Situação inválida'; end if;
  if p_status = 'respondido' and not is_platform_admin() then raise exception 'Sem permissão'; end if;
  update support_tickets set status = p_status, updated_at = now() where id = t.id;
end $$;

-- Lista da loja, com "resposta nova" quando o suporte escreveu depois da última visita
create or replace function public.support_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'subject', subject, 'category', category, 'status', status,
      'createdAt', created_at, 'updatedAt', updated_at,
      'unread', last_from = 'suporte' and updated_at > store_seen_at) order by updated_at desc)
    from support_tickets where tenant_id = p_tenant), '[]');
end $$;

create or replace function public.support_unread(p_tenant uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when is_member(p_tenant) then
    (select count(*)::int from support_tickets where tenant_id = p_tenant and last_from = 'suporte' and updated_at > store_seen_at)
  else 0 end
$$;

-- Conversa completa; marca como lida para quem abriu
create or replace function public.support_thread(p_ticket bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t support_tickets; v_member boolean; v_admin boolean := is_platform_admin(); r jsonb;
begin
  select * into t from support_tickets where id = p_ticket;
  if not found then raise exception 'Chamado não encontrado'; end if;
  v_member := is_member(t.tenant_id);
  if not (v_member or v_admin) then raise exception 'Chamado não encontrado'; end if;
  if v_member then update support_tickets set store_seen_at = now() where id = t.id;
  else update support_tickets set admin_seen_at = now() where id = t.id; end if;
  select jsonb_build_object('id', t.id, 'subject', t.subject, 'category', t.category, 'status', t.status, 'createdAt', t.created_at,
    'store', (select jsonb_build_object('name', name, 'slug', slug, 'phone', phone) from tenants where id = t.tenant_id),
    'diagnostics', case when v_admin and not v_member then t.diagnostics end,
    'openedBy', case when v_admin and not v_member then (select email from auth.users where id = t.opened_by) end,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'fromSupport', m.from_support, 'body', m.body,
        'attachment', m.attachment, 'at', m.created_at,
        'mine', m.author = auth.uid()) order by m.id) from support_messages m where m.ticket_id = t.id), '[]'))
  into r;
  return r;
end $$;

-- Caixa de entrada da plataforma
create or replace function public.support_admin_list(p_status text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'subject', s.subject, 'category', s.category, 'status', s.status,
      'createdAt', s.created_at, 'updatedAt', s.updated_at, 'store', t.name, 'slug', t.slug,
      'unread', s.last_from = 'loja' and (s.admin_seen_at is null or s.updated_at > s.admin_seen_at),
      'messages', (select count(*) from support_messages m where m.ticket_id = s.id)) order by s.updated_at desc)
    from support_tickets s join tenants t on t.id = s.tenant_id
    where p_status is null or s.status = p_status), '[]');
end $$;

create or replace function public.support_admin_unread() returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when is_platform_admin() then
    (select count(*)::int from support_tickets where status = 'aberto' and last_from = 'loja' and (admin_seen_at is null or updated_at > admin_seen_at))
  else 0 end
$$;

revoke execute on function public._support_attachment(uuid, text, boolean), public._support_diag(jsonb) from public, anon, authenticated;
revoke execute on function public.support_open(uuid, text, text, text, text, jsonb), public.support_reply(bigint, text, text),
  public.support_set_status(bigint, text), public.support_list(uuid), public.support_unread(uuid), public.support_thread(bigint),
  public.support_admin_list(text), public.support_admin_unread() from public, anon;
grant execute on function public.support_open(uuid, text, text, text, text, jsonb), public.support_reply(bigint, text, text),
  public.support_set_status(bigint, text), public.support_list(uuid), public.support_unread(uuid), public.support_thread(bigint),
  public.support_admin_list(text), public.support_admin_unread() to authenticated;

create or replace function public.schema_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  select jsonb_agg(jsonb_build_object('n', n, 'file', file, 'ok', ok) order by n) into r
  from (values
    (1,  '20261113000000_balcao.sql',                     to_regclass('public.tenants') is not null),
    (2,  '20261114000000_horarios_fotos.sql',             exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'hours')),
    (3,  '20261115000000_pix_online.sql',                 exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'   and column_name = 'payment_status')),
    (4,  '20261116000000_assinaturas.sql',                exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'billing_status')),
    (5,  '20261117000000_entregador_clientes_lgpd.sql',   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'couriers' and column_name = 'access_token')),
    (6,  '20261118000000_distancia_fidelidade.sql',       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'delivery_mode')),
    (7,  '20261119000000_balcao_mesa_caixa.sql',          to_regprocedure('public.cash_report(uuid, date)') is not null),
    (8,  '20261120000000_cupons_avaliacoes_estoque.sql',  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'coupons'  and column_name = 'min_subtotal')),
    (9,  '20261121000000_agendamento_vitrine.sql',        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'   and column_name = 'scheduled_for')),
    (10, '20261122000000_promocoes.sql',                  to_regclass('public.promotions') is not null),
    (11, '20261123000000_checagem.sql',                   true),
    (12, '20261124000000_saude_plataforma.sql',           to_regprocedure('public.platform_health(integer)') is not null),
    (13, '20261125000000_cartao_dominio_unidades.sql',    to_regprocedure('public.create_unit(uuid, text, text)') is not null),
    (14, '20261126000000_seguranca.sql',                  to_regclass('public.rate_hits') is not null),
    (15, '20261127000000_mesa_servico_pedidos_antigos.sql', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'service_fee')),
    (16, '20261128000000_vitrine_previsao_mesas.sql',     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'settled_at')),
    (17, '20261129000000_pausa_feriados_estacoes.sql',    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'stations')),
    (18, '20261130000000_caixa_acerto_bloqueio.sql',      to_regclass('public.cash_sessions') is not null),
    (19, '20261201000000_insumos_financeiro.sql',         to_regclass('public.ingredients') is not null),
    (20, '20261202000000_adicionais_importacao.sql',      to_regclass('public.option_ingredients') is not null),
    (21, '20261203000000_cashback_atividades.sql',        to_regclass('public.cashback_ledger') is not null),
    (22, '20261204000000_metas_cardapio_chamada.sql',     to_regprocedure('public.call_board(text)') is not null),
    (23, '20261205000000_aceite_reajuste.sql',            to_regprocedure('public.bulk_reprice(uuid, text, numeric, integer, text, boolean, boolean)') is not null),
    (24, '20261206000000_logotipo.sql',                   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'logo_path')),
    (25, '20261207000000_chamada_nomes.sql',             exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'call_names')),
    (26, '20261208000000_sugestoes_garcom_avisos.sql',   to_regclass('public.push_subscriptions') is not null),
    (27, '20261209000000_totem_indicacao.sql',            to_regclass('public.referral_codes') is not null),
    (28, '20261210000000_entregador_ao_vivo.sql',         to_regprocedure('public.courier_ping(text, double precision, double precision, double precision)') is not null),
    (29, '20261211000000_unidades_notas_produto.sql',     to_regprocedure('public.units_report(integer)') is not null),
    (30, '20261212000000_acerto_entregadores.sql',        to_regclass('public.courier_payouts') is not null),
    (31, '20261213000000_vale_reservas.sql',              to_regclass('public.reservations') is not null),
    (32, '20261214000000_totem_pix.sql',                  to_regprocedure('public.kiosk_pay_at_counter(uuid, text)') is not null),
    (33, '20261215000000_totem_cartao_point.sql',         to_regprocedure('public.point_save(bigint, text)') is not null),
    (34, '20261216000000_seguranca_2.sql',                to_regprocedure('public.tenant_settings(uuid)') is not null),
    (35, '20261217000000_meio_a_meio.sql',                exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'option_groups' and column_name = 'pricing')),
    (36, '20261218000000_chamados.sql',                   to_regclass('public.support_tickets') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
