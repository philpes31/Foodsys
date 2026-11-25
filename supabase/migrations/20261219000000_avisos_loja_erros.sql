-- 37. Aviso de pedido novo no celular da equipe + monitor de erros
-- (1) O dono ou atendente toca em "Avisar neste aparelho" no painel. Quando entra um pedido pela loja online,
--     totem ou mesa, o aparelho recebe uma notificação, mesmo com o painel fechado. Usa a mesma função "push".
-- (2) Os erros inesperados que aparecem no navegador (loja, painel, acompanhamento) são registrados sozinhos,
--     agrupados por mensagem, e aparecem em /plataforma/erros.
-- Pode rodar mais de uma vez.

-- ============ 1. Avisos para a equipe ============
create table if not exists public.staff_push_subs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,40}$'),
  created_at timestamptz not null default now(),
  unique (tenant_id, endpoint)
);
alter table public.staff_push_subs enable row level security;
revoke all on public.staff_push_subs from anon, authenticated;

alter table public.push_queue add column if not exists audience text not null default 'cliente';
do $$ begin
  alter table public.push_queue add constraint push_queue_audience_check check (audience in ('cliente', 'loja'));
exception when duplicate_object then null; end $$;

create or replace function public.staff_push_subscribe(p_tenant uuid, p_sub jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ep text := p_sub->>'endpoint';
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if v_ep is null or v_ep !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/' then
    raise exception 'Serviço de avisos não suportado neste navegador';
  end if;
  perform _rate_limit('staff-push:' || auth.uid(), 20, interval '10 minutes', 'Muitas tentativas. Aguarde alguns minutos.');
  if (select count(*) from staff_push_subs where tenant_id = p_tenant) >= 30 and not exists (select 1 from staff_push_subs where tenant_id = p_tenant and endpoint = v_ep) then
    raise exception 'Limite de 30 aparelhos por loja. Desligue os avisos de algum aparelho antigo.';
  end if;
  insert into staff_push_subs (tenant_id, user_id, endpoint, p256dh, auth)
    values (p_tenant, auth.uid(), v_ep, p_sub->'keys'->>'p256dh', p_sub->'keys'->>'auth')
    on conflict (tenant_id, endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  return true;
exception when check_violation then raise exception 'Inscrição inválida';
end $$;

create or replace function public.staff_push_unsubscribe(p_tenant uuid, p_endpoint text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  delete from staff_push_subs where tenant_id = p_tenant and endpoint = p_endpoint;
end $$;

-- Este aparelho está inscrito? E quantos aparelhos da loja recebem avisos
create or replace function public.staff_push_state(p_tenant uuid, p_endpoint text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  return jsonb_build_object('on', exists (select 1 from staff_push_subs where tenant_id = p_tenant and endpoint = p_endpoint),
    'devices', (select count(*) from staff_push_subs where tenant_id = p_tenant));
end $$;

revoke execute on function public.staff_push_subscribe(uuid, jsonb), public.staff_push_unsubscribe(uuid, text), public.staff_push_state(uuid, text) from public, anon;
grant execute on function public.staff_push_subscribe(uuid, jsonb), public.staff_push_unsubscribe(uuid, text), public.staff_push_state(uuid, text) to authenticated;

-- A Edge Function pega o aviso: cliente -> inscrições do pedido; loja -> aparelhos da equipe que ainda faz parte da loja.
-- Aparelhos da equipe vão com id negativo, para push_drop saber de qual tabela apagar.
create or replace function public.push_take(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare qrow push_queue;
begin
  update push_queue set sent_at = now() where id = p_id and sent_at is null returning * into qrow;
  if qrow.id is null then return null; end if;
  return jsonb_build_object('title', qrow.title, 'body', qrow.body, 'url', qrow.url,
    'subs', case when qrow.audience = 'loja' then
        (select coalesce(jsonb_agg(jsonb_build_object('id', -s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]')
           from staff_push_subs s where s.tenant_id = qrow.tenant_id
            and exists (select 1 from memberships m where m.tenant_id = s.tenant_id and m.user_id = s.user_id and m.role in ('owner', 'staff')))
      else
        (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth)), '[]')
           from push_subscriptions where order_id = qrow.order_id)
      end);
end $$;
create or replace function public.push_drop(p_sub bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_sub < 0 then delete from staff_push_subs where id = -p_sub;
  else delete from push_subscriptions where id = p_sub; end if;
end $$;
revoke execute on function public.push_take(bigint), public.push_drop(bigint) from public, anon, authenticated;
grant execute on function public.push_take(bigint), public.push_drop(bigint) to service_role;

-- Chama a Edge Function para um aviso da fila (nunca atrapalha quem chamou)
create or replace function public._push_send(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_secret text;
begin
  select value into v_url from platform_settings where key = 'push_url';
  select value into v_secret from platform_settings where key = 'push_secret';
  if v_url is null or v_secret is null or to_regnamespace('net') is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using v_url, jsonb_build_object('id', p_id), jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret);
exception when others then null;
end $$;
revoke execute on function public._push_send(bigint) from public, anon, authenticated;

-- Pedido novo que a equipe não lançou (loja online, totem, mesa): avisa os aparelhos da loja.
-- Pix online avisa quando o pagamento é confirmado (sai de "pagamento").
create or replace function public._push_new_order() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint; v_body text;
begin
  if new.channel not in ('online', 'totem', 'mesa') or new.status not in ('novo', 'preparo') then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'pagamento' then return new; end if;
  if not exists (select 1 from staff_push_subs where tenant_id = new.tenant_id) then return new; end if;
  v_body := concat_ws(' · ', _short_name(new.customer_name),
    case new.fulfillment when 'delivery' then 'Entrega' when 'pickup' then 'Retirada' when 'table' then coalesce('Mesa ' || new.table_label, 'Mesa') end,
    new.payment,
    case when new.scheduled_for is not null and new.scheduled_for > now() + interval '30 minutes'
      then 'agendado para ' || to_char(new.scheduled_for at time zone coalesce((select timezone from tenants where id = new.tenant_id), 'America/Sao_Paulo'), 'DD/MM HH24:MI') end);
  insert into push_queue (tenant_id, order_id, audience, title, body, url)
    values (new.tenant_id, new.id, 'loja',
      'Novo pedido #' || new.number || ' · R$ ' || replace(to_char(new.total / 100.0, 'FM999999990.00'), '.', ','),
      coalesce(nullif(v_body, ''), 'Abra o painel para ver o pedido'), '/painel/pedidos')
    returning id into v_id;
  perform _push_send(v_id);
  return new;
exception when others then return new;   -- aviso nunca atrapalha o pedido
end $$;
revoke execute on function public._push_new_order() from public, anon, authenticated;
drop trigger if exists orders_push_new_order on public.orders;
create trigger orders_push_new_order after insert or update of status on public.orders for each row execute function public._push_new_order();

-- push_status conta também os aparelhos das lojas
create or replace function public.push_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  return jsonb_build_object(
    'configured', exists (select 1 from platform_settings where key = 'push_secret'),
    'publicKey', (select value from platform_settings where key = 'vapid_public'),
    'url', (select value from platform_settings where key = 'push_url'),
    'pgNet', to_regnamespace('net') is not null,
    'subscriptions', (select count(*) from push_subscriptions),
    'staffDevices', (select count(*) from staff_push_subs),
    'sent7d', (select count(*) from push_queue where sent_at > now() - interval '7 days'),
    'pending', (select count(*) from push_queue where sent_at is null and created_at > now() - interval '1 day' and created_at < now() - interval '2 minutes'));
end $$;

-- ============ 2. Monitor de erros ============
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  fingerprint text not null,
  tenant_id uuid references public.tenants(id) on delete cascade,
  msg text not null,
  src text,
  last_page text,
  last_agent text,
  area text,
  count int not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists client_errors_fp_tenant on public.client_errors (fingerprint, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists client_errors_last on public.client_errors (last_at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

-- Navegador registra um erro inesperado. Sem login também (loja online e acompanhamento), com limite por IP.
create or replace function public.log_client_error(p_tenant uuid, p_msg text, p_src text, p_page text, p_agent text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text := left(btrim(coalesce(p_msg, '')), 300); v_src text := left(coalesce(p_src, ''), 120);
  v_page text := left(coalesce(p_page, ''), 200); v_tenant uuid; v_fp text; v_area text;
begin
  if length(v_msg) < 2 then return; end if;
  perform _rate_limit('err:' || coalesce(_client_ip(), auth.uid()::text, '-'), 30, interval '10 minutes', 'Muitos registros de erro.');
  if p_tenant is not null and exists (select 1 from tenants where id = p_tenant) then v_tenant := p_tenant; end if;
  v_area := case split_part(ltrim(v_page, '/'), '/', 1) when 'painel' then 'painel' when 'plataforma' then 'plataforma'
    when 'loja' then 'loja' when 'pedido' then 'acompanhamento' when 'entregador' then 'entregador' else 'outros' end;
  -- mesma mensagem com números diferentes (ids, valores) conta como o mesmo erro
  v_fp := md5(regexp_replace(v_msg, '[0-9]+', '#', 'g') || '|' || regexp_replace(v_src, ':[0-9]+$', ''));
  insert into client_errors (fingerprint, tenant_id, msg, src, last_page, last_agent, area)
    values (v_fp, v_tenant, v_msg, v_src, v_page, left(coalesce(p_agent, ''), 300), v_area)
  on conflict (fingerprint, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update
    set count = client_errors.count + 1, last_at = now(), last_page = excluded.last_page, last_agent = excluded.last_agent, msg = excluded.msg;
  if random() < 0.01 then delete from client_errors where last_at < now() - interval '60 days'; end if;
end $$;
revoke execute on function public.log_client_error(uuid, text, text, text, text) from public;
grant execute on function public.log_client_error(uuid, text, text, text, text) to anon, authenticated;

-- Painel da plataforma: erros agrupados, mais frequentes primeiro. "Resolvido" some até acontecer de novo.
create or replace function public.platform_errors(p_days int, p_open boolean) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'open')::boolean desc, (x->>'count')::int desc, x->>'lastAt' desc) from (
    select jsonb_build_object('fingerprint', e.fingerprint,
      'msg', (array_agg(e.msg order by e.last_at desc))[1],
      'src', (array_agg(e.src order by e.last_at desc))[1],
      'page', (array_agg(e.last_page order by e.last_at desc))[1],
      'agent', (array_agg(e.last_agent order by e.last_at desc))[1],
      'areas', (select jsonb_agg(distinct a) from unnest(array_agg(e.area)) a),
      'count', sum(e.count), 'stores', count(distinct e.tenant_id),
      'storeNames', (select jsonb_agg(t.name order by t.name) from (select distinct tenant_id from client_errors c where c.fingerprint = e.fingerprint and c.tenant_id is not null limit 5) d join tenants t on t.id = d.tenant_id),
      'firstAt', min(e.first_at), 'lastAt', max(e.last_at),
      'open', max(e.last_at) > coalesce(max(e.resolved_at), '-infinity'::timestamptz)) x
    from client_errors e
    where e.last_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 60)))
    group by e.fingerprint) g
    where not coalesce(p_open, false) or (x->>'open')::boolean), '[]');
end $$;

create or replace function public.platform_errors_open() returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when is_platform_admin() then
    (select count(*)::int from (select fingerprint from client_errors where last_at > now() - interval '24 hours'
      group by fingerprint having max(last_at) > coalesce(max(resolved_at), '-infinity'::timestamptz)) z)
  else 0 end
$$;

create or replace function public.platform_error_resolve(p_fingerprint text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  update client_errors set resolved_at = now() where fingerprint = p_fingerprint;
end $$;
revoke execute on function public.platform_errors(int, boolean), public.platform_errors_open(), public.platform_error_resolve(text) from public, anon;
grant execute on function public.platform_errors(int, boolean), public.platform_errors_open(), public.platform_error_resolve(text) to authenticated;

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
    (36, '20261218000000_chamados.sql',                   to_regclass('public.support_tickets') is not null),
    (37, '20261219000000_avisos_loja_erros.sql',          to_regclass('public.client_errors') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
