-- =====================================================================
-- Balcão — painel consolidado das unidades e avaliação por produto
-- Rode depois de 20261210000000_entregador_ao_vivo.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Relatório de todas as unidades do dono, no período (7, 30 ou 90 dias)
create or replace function public.units_report(p_days integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_days int := least(greatest(coalesce(p_days, 30), 1), 366); v_from timestamptz;
begin
  if auth.uid() is null then raise exception 'Faça login'; end if;
  v_from := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' - make_interval(days => v_days - 1);
  return (
    with u as (select t.* from tenants t join memberships m on m.tenant_id = t.id and m.user_id = auth.uid() and m.role = 'owner'),
    o as (select o.* from orders o join u on u.id = o.tenant_id where o.created_at >= v_from and o.status <> 'pagamento'),
    ok as (select * from o where status <> 'cancelado'),
    per as (
      select u.id, u.name, u.color, u.slug,
        (select count(*) from ok where ok.tenant_id = u.id) n,
        (select coalesce(sum(total), 0) from ok where ok.tenant_id = u.id) rev,
        (select count(*) from o where o.tenant_id = u.id and o.status = 'cancelado') canc,
        (select count(*) from o where o.tenant_id = u.id) n_all,
        (select count(distinct phone_key(customer_phone)) from ok where ok.tenant_id = u.id and customer_phone <> 'removido') customers,
        (select round(avg(r.rating)::numeric, 1) from order_reviews r where r.tenant_id = u.id and r.created_at >= v_from) rating,
        (select count(*) from order_reviews r where r.tenant_id = u.id and r.created_at >= v_from) ratings,
        (select round(percentile_cont(0.5) within group (order by extract(epoch from e.at - ok.created_at) / 60)::numeric)
           from ok join lateral (select min(ev.at) at from order_events ev where ev.order_id = ok.id and ev.status = 'pronto') e on true
           where ok.tenant_id = u.id and e.at is not null) prep_min,
        (select jsonb_object_agg(channel, n) from (select channel, count(*) n from ok where ok.tenant_id = u.id group by channel) c) channels
      from u)
    select jsonb_build_object(
      'days', v_days, 'from', v_from,
      'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color, 'slug', slug, 'orders', n, 'revenue', rev,
                 'ticket', case when n > 0 then round(rev::numeric / n) end, 'cancelRate', case when n_all > 0 then round(canc * 100.0 / n_all, 1) end,
                 'customers', customers, 'rating', rating, 'ratings', ratings, 'prepMin', prep_min, 'channels', coalesce(channels, '{}')) order by rev desc) from per), '[]'),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'units', (
                   select coalesce(jsonb_object_agg(ok.tenant_id, s), '{}') from (select tenant_id, sum(total) s from ok
                   where (created_at at time zone 'America/Sao_Paulo')::date = d group by tenant_id) ok)) order by d)
                 from (select g::date d from generate_series((v_from at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date, interval '1 day') g) dd), '[]'),
      'products', coalesce((select jsonb_agg(jsonb_build_object('name', nm, 'qty', q, 'revenue', rv, 'byUnit', bu) order by rv desc) from (
                 select max(nm) nm, sum(q) q, sum(rv) rv, jsonb_object_agg(tid, q) bu from (
                   select lower(i.product_name) k, max(i.product_name) nm, i.tenant_id tid, sum(i.qty) q, sum(i.qty * i.unit_price) rv
                   from order_items i join ok on ok.id = i.order_id group by lower(i.product_name), i.tenant_id) a
                 group by k order by sum(rv) desc limit 15) p), '[]'))
  );
end $$;
revoke execute on function public.units_report(integer) from public, anon;
grant execute on function public.units_report(integer) to authenticated;

-- 2. Avaliação por produto: a nota de cada pedido vale para os produtos que estavam nele
create or replace function public.product_ratings(p_tenant uuid, p_days integer) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by (x->>'avg')::numeric, (x->>'count')::int desc), '[]') from (
    select jsonb_build_object('productId', i.product_id, 'name', max(i.product_name),
      'avg', round(avg(r.rating)::numeric, 1), 'count', count(distinct r.order_id),
      'low', count(distinct r.order_id) filter (where r.rating <= 3),
      'comments', (select coalesce(jsonb_agg(c order by (c->>'rating')::int, c->>'at' desc), '[]') from (
          select jsonb_build_object('rating', r2.rating, 'comment', r2.comment, 'at', r2.created_at) c
          from order_reviews r2 join order_items i2 on i2.order_id = r2.order_id
          where r2.tenant_id = p_tenant and i2.product_id = i.product_id and r2.comment <> '' and r2.created_at > now() - make_interval(days => least(greatest(p_days, 1), 366))
          group by r2.order_id, r2.rating, r2.comment, r2.created_at order by r2.rating, r2.created_at desc limit 3) cc)) x
    from order_reviews r join order_items i on i.order_id = r.order_id
    where r.tenant_id = p_tenant and is_member(p_tenant) and i.product_id is not null
      and r.created_at > now() - make_interval(days => least(greatest(p_days, 1), 366))
    group by i.product_id) s
$$;
revoke execute on function public.product_ratings(uuid, integer) from public, anon;
grant execute on function public.product_ratings(uuid, integer) to authenticated;

-- Na loja online: nota dos produtos com pelo menos 3 avaliações nos últimos 6 meses
create or replace function public.store_product_ratings(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(pid, jsonb_build_object('avg', a, 'count', n)), '{}') from (
    select i.product_id pid, round(avg(r.rating)::numeric, 1) a, count(distinct r.order_id) n
    from tenants t join order_reviews r on r.tenant_id = t.id join order_items i on i.order_id = r.order_id
    where t.slug = p_slug and t.active and i.product_id is not null and r.created_at > now() - interval '180 days'
    group by i.product_id having count(distinct r.order_id) >= 3) s
$$;
grant execute on function public.store_product_ratings(text) to anon, authenticated;

-- 3. Checagem das migrações
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
    (29, '20261211000000_unidades_notas_produto.sql',     to_regprocedure('public.units_report(integer)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
