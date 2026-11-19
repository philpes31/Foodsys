-- =====================================================================
-- Balcão — metas de vendas, engenharia de cardápio e painel de chamada (TV do balcão)
-- Rode depois de 20261203000000_cashback_atividades.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Metas de vendas (centavos; 0 = sem meta)
alter table public.tenants add column if not exists daily_goal integer not null default 0 check (daily_goal between 0 and 100000000);
alter table public.tenants add column if not exists monthly_goal integer not null default 0 check (monthly_goal between 0 and 1000000000);
grant select (daily_goal, monthly_goal) on public.tenants to authenticated;
grant update (daily_goal, monthly_goal) on public.tenants to authenticated;

-- 2. Engenharia de cardápio: por produto, quantidade vendida, receita e custo (ficha técnica atual, base + opções escolhidas)
create or replace function public.menu_engineering(p_tenant uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  return (select coalesce(jsonb_agg(x order by (x->>'revenue')::int desc), '[]') from (
    select jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category, 'price', p.price, 'available', p.available,
      'qty', coalesce(s.qty, 0), 'revenue', coalesce(s.revenue, 0), 'cost', coalesce(s.cost, 0),
      'hasRecipe', exists (select 1 from product_ingredients pi where pi.product_id = p.id)) x
    from products p
    left join lateral (
      select sum(i.qty) qty, sum(i.qty * i.unit_price) revenue,
        round(sum(i.qty * (
          coalesce((select sum(pi.qty * g.unit_cost) from product_ingredients pi join ingredients g on g.id = pi.ingredient_id where pi.product_id = p.id), 0)
          + coalesce((select sum(oi.qty * g.unit_cost) from option_ingredients oi join ingredients g on g.id = oi.ingredient_id
                      where oi.product_id = p.id and oi.option_name = any(i.option_names)), 0)))) cost
      from order_items i join orders o on o.id = i.order_id
      where i.product_id = p.id and o.status not in ('cancelado', 'pagamento')
        and o.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 7), 365))
    ) s on true
    where p.tenant_id = p_tenant) t);
end $$;
revoke execute on function public.menu_engineering(uuid, int) from public, anon;
grant execute on function public.menu_engineering(uuid, int) to authenticated;

-- 3. Painel de chamada (público, para a TV do balcão): só números de pedidos de retirada e mesa de hoje.
--    Não mostra nome, telefone nem valores.
create or replace function public.call_board(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('store', jsonb_build_object('name', t.name, 'color', t.color),
    'preparing', coalesce((select jsonb_agg(jsonb_build_object('n', number, 'table', table_label) order by created_at) from orders
                  where tenant_id = t.id and fulfillment in ('pickup', 'table') and status in ('novo', 'preparo')
                    and created_at > now() - interval '12 hours' and (scheduled_for is null or scheduled_for < now() + interval '30 minutes')), '[]'),
    'ready', coalesce((select jsonb_agg(jsonb_build_object('n', number, 'table', table_label, 'at', updated_at) order by updated_at desc) from orders
                  where tenant_id = t.id and fulfillment in ('pickup', 'table') and status = 'pronto'
                    and created_at > now() - interval '12 hours'), '[]'))
  from tenants t where t.slug = p_slug and t.active
$$;
grant execute on function public.call_board(text) to anon, authenticated;

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
    (22, '20261204000000_metas_cardapio_chamada.sql',     to_regprocedure('public.call_board(text)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
