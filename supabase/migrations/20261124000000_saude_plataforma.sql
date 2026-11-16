-- =====================================================================
-- Balcão — painel de saúde da plataforma
-- Pedidos e cadastros por dia, lojas paradas, cobranças com problema e testes acabando.
-- Rode depois de 20261123000000_checagem.sql. Pode rodar de novo sem problema.
-- =====================================================================

create or replace function public.platform_health(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb; v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  with days as (
    select d::date d from generate_series((now() at time zone 'America/Sao_Paulo')::date - (v_days - 1), (now() at time zone 'America/Sao_Paulo')::date, interval '1 day') d),
  o as (
    select (created_at at time zone 'America/Sao_Paulo')::date d, count(*) n, coalesce(sum(total), 0) gmv, count(distinct tenant_id) stores
    from orders where status not in ('cancelado', 'pagamento') and created_at >= now() - make_interval(days => v_days + 1) group by 1),
  t as (
    select (created_at at time zone 'America/Sao_Paulo')::date d, count(*) n from tenants where created_at >= now() - make_interval(days => v_days + 1) group by 1),
  last as (
    select t.id, t.name, t.slug, t.created_at, t.billing_status, t.trial_ends_at, t.paid_until,
      (select max(created_at) from orders x where x.tenant_id = t.id and x.status not in ('cancelado', 'pagamento')) last_order,
      (select u.email from memberships m join auth.users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1) owner_email
    from tenants t where t.active)
  select jsonb_build_object(
    'days', (select jsonb_agg(jsonb_build_object('d', days.d, 'orders', coalesce(o.n, 0), 'gmv', coalesce(o.gmv, 0), 'stores', coalesce(o.stores, 0), 'signups', coalesce(t.n, 0)) order by days.d)
             from days left join o on o.d = days.d left join t on t.d = days.d),
    'activeStores7d', (select count(distinct tenant_id) from orders where status not in ('cancelado', 'pagamento') and created_at >= now() - interval '7 days'),
    'idle', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug, 'ownerEmail', owner_email, 'lastOrder', last_order, 'createdAt', created_at)
               order by last_order nulls first, created_at), '[]')
             from last where coalesce(last_order, created_at) < now() - interval '7 days'),
    'pastDue', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug, 'ownerEmail', owner_email, 'status', billing_status, 'paidUntil', paid_until)
               order by paid_until nulls first), '[]')
             from last where billing_status in ('past_due', 'canceled')),
    'trialsEnding', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug, 'ownerEmail', owner_email, 'trialEndsAt', trial_ends_at, 'lastOrder', last_order)
               order by trial_ends_at), '[]')
             from last where billing_status = 'trial' and trial_ends_at between now() - interval '3 days' and now() + interval '5 days')
  ) into r;
  return r;
end $$;

revoke execute on function public.platform_health(int) from public, anon;
grant execute on function public.platform_health(int) to authenticated;

-- Checagem das migrações: inclui esta.
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
    (12, '20261124000000_saude_plataforma.sql',           to_regprocedure('public.platform_health(integer)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
