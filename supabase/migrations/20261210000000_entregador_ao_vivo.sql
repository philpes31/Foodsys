-- =====================================================================
-- Balcão — entregador no mapa ao vivo e rota das entregas
-- O celular do entregador manda a posição enquanto a página dele está aberta e ele tem entrega em rota.
-- O cliente vê a posição só do pedido dele, só enquanto o pedido está em rota. Fora de entrega, nada é guardado.
-- Rode depois de 20261209000000_totem_indicacao.sql. Pode rodar de novo sem problema.
-- =====================================================================

alter table public.couriers add column if not exists last_lat double precision;
alter table public.couriers add column if not exists last_lng double precision;
alter table public.couriers add column if not exists last_acc double precision;
alter table public.couriers add column if not exists last_at timestamptz;

-- Portal do entregador: coordenadas dos destinos e da loja (para montar a rota)
CREATE OR REPLACE FUNCTION public.courier_portal(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'courier', jsonb_build_object('name', c.name, 'active', c.active),
    'store', jsonb_build_object('name', t.name, 'color', t.color, 'phone', t.phone, 'lat', t.lat, 'lng', t.lng, 'address', t.address, 'logo', t.logo_path),
    'deliveries', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'customerName', o.customer_name,
        'customerPhone', o.customer_phone, 'address', o.address, 'zone', o.zone_name, 'payment', o.payment, 'paid', o.payment_status = 'paid',
        'total', o.total, 'changeFor', o.change_for, 'since', o.updated_at, 'lat', o.dest_lat, 'lng', o.dest_lng,
        'items', (select coalesce(jsonb_agg(i.qty || 'x ' || i.product_name order by i.id), '[]') from order_items i where i.order_id = o.id))
        order by o.updated_at), '[]')
      from orders o where o.courier_id = c.id and o.status = 'rota'),
    'today', (select jsonb_build_object('deliveries', count(*), 'fees', coalesce(sum(o.fee), 0))
      from orders o where o.courier_id = c.id and o.status = 'entregue'
        and o.updated_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone))
  from couriers c join tenants t on t.id = c.tenant_id
  where c.access_token = p_token and length(p_token) >= 32 and t.active
$function$;

-- Posição do entregador (pelo link dele). Só grava se ele tem entrega em rota; no máximo uma vez a cada 5 s.
create or replace function public.courier_ping(p_token text, p_lat double precision, p_lng double precision, p_acc double precision) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c couriers;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'Posição inválida'; end if;
  select * into c from couriers where access_token = p_token and length(p_token) >= 32 and active;
  if c.id is null then raise exception 'Link inválido'; end if;
  if not exists (select 1 from orders where courier_id = c.id and status = 'rota') then
    if c.last_at is not null then update couriers set last_lat = null, last_lng = null, last_acc = null, last_at = null where id = c.id; end if;
    return false;
  end if;
  if c.last_at > now() - interval '5 seconds' then return true; end if;
  update couriers set last_lat = round(p_lat::numeric, 5), last_lng = round(p_lng::numeric, 5),
    last_acc = least(greatest(coalesce(p_acc, 0), 0), 100000), last_at = now() where id = c.id;
  return true;
end $$;
revoke execute on function public.courier_ping(text, double precision, double precision, double precision) from public;
grant execute on function public.courier_ping(text, double precision, double precision, double precision) to anon, authenticated;

-- Ao entregar a última, apaga a posição (não fica rastro fora de entrega)
create or replace function public._courier_forget() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'rota' and new.status <> 'rota' and old.courier_id is not null
     and not exists (select 1 from orders where courier_id = old.courier_id and status = 'rota' and id <> new.id) then
    update couriers set last_lat = null, last_lng = null, last_acc = null, last_at = null where id = old.courier_id and last_at is not null;
  end if;
  return new;
end $$;
revoke execute on function public._courier_forget() from public, anon, authenticated;
drop trigger if exists orders_courier_forget on public.orders;
create trigger orders_courier_forget after update of status on public.orders for each row execute function public._courier_forget();

-- Cliente: onde está o entregador do meu pedido (só em rota e com posição dos últimos 10 min)
create or replace function public.track_courier(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when c.last_at > now() - interval '10 minutes' then jsonb_build_object(
      'lat', c.last_lat, 'lng', c.last_lng, 'acc', c.last_acc, 'at', c.last_at,
      'dest', case when o.dest_lat is not null then jsonb_build_object('lat', o.dest_lat, 'lng', o.dest_lng) end,
      'store', case when t.lat is not null then jsonb_build_object('lat', t.lat, 'lng', t.lng) end,
      'stopsBefore', (select count(*) from orders x where x.courier_id = c.id and x.status = 'rota' and x.id <> o.id and x.updated_at < o.updated_at))
    end
  from orders o join couriers c on c.id = o.courier_id join tenants t on t.id = o.tenant_id
  where o.public_code = p_code and o.status = 'rota'
$$;
revoke execute on function public.track_courier(text) from public;
grant execute on function public.track_courier(text) to anon, authenticated;

-- Painel: entregadores com posição recente
create or replace function public.courier_positions(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'lat', c.last_lat, 'lng', c.last_lng, 'at', c.last_at,
           'orders', (select coalesce(jsonb_agg(jsonb_build_object('number', o.number, 'lat', o.dest_lat, 'lng', o.dest_lng) order by o.updated_at), '[]')
                      from orders o where o.courier_id = c.id and o.status = 'rota')) order by c.name), '[]')
  from couriers c where c.tenant_id = p_tenant and is_member(p_tenant) and c.last_at > now() - interval '30 minutes'
$$;
revoke execute on function public.courier_positions(uuid) from public, anon;
grant execute on function public.courier_positions(uuid) to authenticated;

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
    (28, '20261210000000_entregador_ao_vivo.sql',         to_regprocedure('public.courier_ping(text, double precision, double precision, double precision)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
