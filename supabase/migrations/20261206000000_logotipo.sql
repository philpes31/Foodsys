-- =====================================================================
-- Balcão — logotipo da loja (cabeçalho da loja online, painel, painel de chamada e ícone do app)
-- Rode depois de 20261205000000_aceite_reajuste.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Coluna do logotipo: arquivo no mesmo bucket das fotos, dentro da pasta da própria loja
alter table public.tenants add column if not exists logo_path text;
alter table public.tenants drop constraint if exists tenants_logo_path_format;
alter table public.tenants add constraint tenants_logo_path_format
  check (logo_path is null or (logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' and split_part(logo_path, '/', 1) = id::text));
grant select (logo_path) on public.tenants to anon, authenticated;   -- público: aparece na loja online
grant update (logo_path) on public.tenants to authenticated;           -- a política de update de tenants já restringe ao dono

-- 2. Painel de chamada mostra o logotipo
create or replace function public.call_board(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('store', jsonb_build_object('name', t.name, 'color', t.color, 'logo', t.logo_path),
    'preparing', coalesce((select jsonb_agg(jsonb_build_object('n', number, 'table', table_label) order by created_at) from orders
                  where tenant_id = t.id and fulfillment in ('pickup', 'table') and status in ('novo', 'preparo')
                    and created_at > now() - interval '12 hours' and (scheduled_for is null or scheduled_for < now() + interval '30 minutes')), '[]'),
    'ready', coalesce((select jsonb_agg(jsonb_build_object('n', number, 'table', table_label, 'at', updated_at) order by updated_at desc) from orders
                  where tenant_id = t.id and fulfillment in ('pickup', 'table') and status = 'pronto'
                    and created_at > now() - interval '12 hours'), '[]'))
  from tenants t where t.slug = p_slug and t.active
$$;
grant execute on function public.call_board(text) to anon, authenticated;

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
    (24, '20261206000000_logotipo.sql',                   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'logo_path'))
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
