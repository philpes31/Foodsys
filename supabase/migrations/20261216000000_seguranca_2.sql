-- =====================================================================
-- Balcão — teste de segurança 2: correções
--  1. Configurações internas da loja (metas, aceite automático, maquininha, lotação de reservas...) não ficam
--     visíveis para qualquer pessoa com conta: passam a ser lidas só pela equipe, por uma função.
--  2. Conta de TOTEM: papel próprio, que só faz pedidos pelo totem (não vê pedidos, clientes nem relatórios).
--  3. Avisos no celular: só aceita endereços de serviços de notificação conhecidos.
--  4. Funções internas (gatilhos e checagem de migrações) deixam de ficar expostas ao público.
-- Rode depois de 20261215000000_totem_cartao_point.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Colunas internas: fora do alcance de quem só tem conta
revoke select (auto_accept, call_names, daily_goal, monthly_goal, point_terminal_id, reservation_auto, reservation_capacity) on public.tenants from authenticated;

-- 2. Papel "totem"
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check (role in ('owner', 'staff', 'totem'));

-- equipe = dono ou atendente (a conta do totem fica de fora de tudo que usa is_member)
create or replace function public.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.my_role(p_tenant) in ('owner', 'staff'), false)
$$;
-- quem pode operar o totem: equipe ou conta de totem
create or replace function public.is_kiosk(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.my_role(p_tenant) is not null
$$;
grant execute on function public.is_kiosk(uuid) to authenticated;

create or replace function public.tenant_settings(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when is_member(p_tenant) then jsonb_build_object('auto_accept', t.auto_accept, 'call_names', t.call_names, 'daily_goal', t.daily_goal,
      'monthly_goal', t.monthly_goal, 'point_terminal_id', t.point_terminal_id, 'reservation_auto', t.reservation_auto, 'reservation_capacity', t.reservation_capacity)
    when is_kiosk(p_tenant) then jsonb_build_object('point_terminal_id', t.point_terminal_id) end
  from tenants t where t.id = p_tenant
$$;
revoke execute on function public.tenant_settings(uuid) from public, anon;
grant execute on function public.tenant_settings(uuid) to authenticated;

-- dono adiciona atendente ou conta de totem
create or replace function public.add_member(p_tenant uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if p_role not in ('staff', 'totem') then raise exception 'Papel inválido'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'Essa pessoa ainda não tem conta. Peça para ela criar uma em /entrar e tente de novo.'; end if;
  if exists (select 1 from memberships where tenant_id = p_tenant and user_id = v_user and role = 'owner') then raise exception 'Essa conta é do dono'; end if;
  insert into memberships (tenant_id, user_id, role) values (p_tenant, v_user, p_role)
    on conflict (tenant_id, user_id) do update set role = excluded.role;
end $$;
revoke execute on function public.add_member(uuid, text, text) from public, anon;
grant execute on function public.add_member(uuid, text, text) to authenticated;

create or replace function public.remove_staff(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  delete from memberships where tenant_id = p_tenant and user_id = p_user and role in ('staff', 'totem');
end $$;

-- funções do totem aceitam a conta de totem
CREATE OR REPLACE FUNCTION public.kiosk_place_order(p_tenant uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t tenants; o orders; v_pay text := coalesce(p->>'payment', '');
begin
  if not is_kiosk(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if not billing_ok(t) then raise exception 'Loja temporariamente indisponível'; end if;
  if not store_open_at(t, now()) then raise exception 'A loja está fechada agora'; end if;
  if coalesce(p->>'fulfillment', '') <> 'pickup' then raise exception 'No totem, o pedido é para retirar no balcão'; end if;
  if v_pay not in ('Pagar no caixa', 'Pix online', 'Cartão no totem') then raise exception 'No totem, pague com Pix, cartão ou no caixa'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;
  if v_pay = 'Cartão no totem' and (t.point_terminal_id is null or not exists (select 1 from tenant_pix where tenant_id = t.id and mp_access_token is not null)) then
    raise exception 'Nenhuma maquininha configurada para o totem';
  end if;
  p := p - 'scheduledFor' - 'useCashback' - 'coupon';
  o := _create_order(t, p, false, case when v_pay = 'Pagar no caixa' then 'novo' else 'pagamento' end, 'totem');
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'status', (select status from orders where id = o.id), 'payment', o.payment);
end $function$;

CREATE OR REPLACE FUNCTION public.kiosk_pay_at_counter(p_tenant uuid, p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o orders;
begin
  if not is_kiosk(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into o from orders where tenant_id = p_tenant and public_code = p_code for update;
  if o.id is null or o.channel <> 'totem' then raise exception 'Pedido não encontrado'; end if;
  if o.payment_status = 'paid' then return 'paid'; end if;   -- o Pix caiu antes: nada a fazer
  if o.status <> 'pagamento' then return o.status; end if;
  update orders set payment = 'Pagar no caixa', payment_status = 'na', status = 'novo', updated_at = now() where id = o.id;
  insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'novo');
  return 'novo';
end $function$;

CREATE OR REPLACE FUNCTION public.kiosk_cancel(p_tenant uuid, p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o orders;
begin
  if not is_kiosk(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into o from orders where tenant_id = p_tenant and public_code = p_code for update;
  if o.id is null or o.channel <> 'totem' then raise exception 'Pedido não encontrado'; end if;
  if o.payment_status = 'paid' or o.status <> 'pagamento' then return o.status; end if;
  update orders set status = 'cancelado', payment_status = 'expired', updated_at = now() where id = o.id;
  return 'cancelado';
end $function$;

-- o totem confere a situação do pedido que acabou de fazer (sem ler a tabela de pedidos)
create or replace function public.kiosk_status(p_tenant uuid, p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', status, 'payment_status', payment_status) from orders
  where tenant_id = p_tenant and public_code = p_code and channel = 'totem' and is_kiosk(p_tenant)
$$;
revoke execute on function public.kiosk_status(uuid, text) from public, anon;
grant execute on function public.kiosk_status(uuid, text) to authenticated;

-- 3. Avisos no celular: endereço só de serviço de notificação conhecido
CREATE OR REPLACE FUNCTION public.push_subscribe(p_code text, p_sub jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o orders;
begin
  perform _rate_limit('push:' || coalesce(_client_ip(), '-'), 20, interval '10 minutes', 'Muitas tentativas. Aguarde alguns minutos.');
  select * into o from orders where public_code = p_code;
  -- só serviços de notificação conhecidos (evita usar o servidor para chamar endereços internos)
  if coalesce(p_sub->>'endpoint', '') !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/' then
    raise exception 'Inscrição inválida';
  end if;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status in ('entregue', 'cancelado') or o.created_at < now() - interval '1 day' then return false; end if;
  if (select count(*) from push_subscriptions where order_id = o.id) >= 5 then return false; end if;
  insert into push_subscriptions (tenant_id, order_id, endpoint, p256dh, auth)
    values (o.tenant_id, o.id, p_sub->>'endpoint', p_sub->'keys'->>'p256dh', p_sub->'keys'->>'auth')
    on conflict (order_id, endpoint) do nothing;
  return true;
exception when check_violation then raise exception 'Inscrição inválida';
end $function$;
delete from public.push_subscriptions where endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/';

-- 4. Funções internas fora do alcance do público
revoke execute on function public._audit(), public._cashback_on_status(), public._ingredients_on_item(), public._ingredients_on_status() from public, anon, authenticated;
revoke execute on function public.schema_status() from public, anon;
grant execute on function public.schema_status() to authenticated;

-- Checagem das migrações
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
    (34, '20261216000000_seguranca_2.sql',                to_regprocedure('public.tenant_settings(uuid)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
