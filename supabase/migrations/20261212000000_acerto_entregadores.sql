-- =====================================================================
-- Balcão — acerto dos entregadores: forma de pagamento, chave Pix, acerto por período e registro do pagamento
-- Rode depois de 20261211000000_unidades_notas_produto.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Como cada entregador ganha
--    taxa        = fica com a taxa de entrega que o cliente pagou (padrão, como era antes)
--    fixo        = valor fixo por entrega
--    diaria      = valor fixo por dia trabalhado (dia com pelo menos 1 entrega)
--    diaria_fixo = diária + valor por entrega
alter table public.couriers add column if not exists pay_mode text not null default 'taxa';
alter table public.couriers drop constraint if exists couriers_pay_mode_check;
alter table public.couriers add constraint couriers_pay_mode_check check (pay_mode in ('taxa', 'fixo', 'diaria', 'diaria_fixo'));
alter table public.couriers add column if not exists pay_per_delivery integer not null default 0 check (pay_per_delivery between 0 and 100000);
alter table public.couriers add column if not exists pay_daily integer not null default 0 check (pay_daily between 0 and 1000000);
alter table public.couriers add column if not exists pix_key text check (pix_key is null or char_length(pix_key) <= 140);
grant select (pay_mode, pay_per_delivery, pay_daily, pix_key) on public.couriers to authenticated;

create or replace function public.set_courier_pay(p_courier bigint, p_mode text, p_per integer, p_daily integer, p_pix text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from couriers where id = p_courier;
  if v_tenant is null or not is_owner(v_tenant) then raise exception 'Sem permissão'; end if;
  if p_mode not in ('taxa', 'fixo', 'diaria', 'diaria_fixo') then raise exception 'Forma de pagamento inválida'; end if;
  if p_mode in ('fixo', 'diaria_fixo') and coalesce(p_per, 0) <= 0 then raise exception 'Informe o valor por entrega'; end if;
  if p_mode in ('diaria', 'diaria_fixo') and coalesce(p_daily, 0) <= 0 then raise exception 'Informe o valor da diária'; end if;
  update couriers set pay_mode = p_mode, pay_per_delivery = greatest(coalesce(p_per, 0), 0), pay_daily = greatest(coalesce(p_daily, 0), 0),
    pix_key = nullif(left(trim(coalesce(p_pix, '')), 140), '') where id = p_courier;
end $$;
revoke execute on function public.set_courier_pay(bigint, text, integer, integer, text) from public, anon;
grant execute on function public.set_courier_pay(bigint, text, integer, integer, text) to authenticated;

-- 2. Cálculo do período (datas no fuso da loja; vale a data em que o pedido foi feito)
create or replace function public._courier_calc(p_courier bigint, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with c as (select c.*, t.timezone tz from couriers c join tenants t on t.id = c.tenant_id where c.id = p_courier),
  o as (select o.*, (o.created_at at time zone c.tz)::date d from orders o, c
        where o.courier_id = c.id and o.tenant_id = c.tenant_id and o.status in ('rota', 'entregue')
          and o.created_at >= (p_from::timestamp at time zone c.tz) and o.created_at < ((p_to + 1)::timestamp at time zone c.tz)),
  s as (select count(*) filter (where status = 'entregue') n, count(*) filter (where status = 'rota') on_route,
          count(distinct d) filter (where status = 'entregue') days,
          coalesce(sum(fee) filter (where status = 'entregue'), 0) fees,
          coalesce(sum(total) filter (where status = 'entregue' and payment = 'Dinheiro'), 0) cash,
          coalesce(sum(total) filter (where status = 'entregue' and payment = 'Cartão na entrega'), 0) card,
          coalesce(sum(total) filter (where status = 'entregue' and payment = 'Pix'), 0) pix from o)
  select jsonb_build_object('mode', c.pay_mode, 'per', c.pay_per_delivery, 'daily', c.pay_daily,
    'deliveries', s.n, 'onRoute', s.on_route, 'days', s.days, 'fees', s.fees, 'cash', s.cash, 'card', s.card, 'pixOnDelivery', s.pix,
    'earnings', case c.pay_mode when 'taxa' then s.fees when 'fixo' then s.n * c.pay_per_delivery
                  when 'diaria' then s.days * c.pay_daily else s.days * c.pay_daily + s.n * c.pay_per_delivery end,
    'byDay', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n, 'fees', f, 'cash', k) order by d), '[]') from (
               select d, count(*) n, sum(fee) f, coalesce(sum(total) filter (where payment = 'Dinheiro'), 0) k from o where status = 'entregue' group by d) x))
  from c, s
$$;
revoke execute on function public._courier_calc(bigint, date, date) from public, anon, authenticated;

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
    'today', (select jsonb_build_object('deliveries', x->'deliveries', 'fees', x->'earnings', 'mode', x->'mode')
              from (select _courier_calc(c.id, (now() at time zone t.timezone)::date, (now() at time zone t.timezone)::date) x) z))
  from couriers c join tenants t on t.id = c.tenant_id
  where c.access_token = p_token and length(p_token) >= 32 and t.active
$function$;

-- 3. Pagamentos feitos aos entregadores
create table if not exists public.courier_payouts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  courier_id bigint not null references public.couriers(id) on delete cascade,
  period_from date not null, period_to date not null check (period_to >= period_from),
  deliveries integer not null, earnings integer not null, cash integer not null,
  amount integer not null,            -- positivo: a loja pagou ao entregador; negativo: o entregador devolveu à loja
  method text not null check (method in ('Pix', 'Dinheiro', 'Transferência')),
  note text check (char_length(note) <= 200),
  expense_id bigint references public.expenses(id) on delete set null,
  cash_move_id bigint references public.cash_moves(id) on delete set null,
  paid_at timestamptz not null default now(),
  by_user uuid
);
create index if not exists courier_payouts_courier on public.courier_payouts (courier_id, period_from);
alter table public.courier_payouts enable row level security;
drop policy if exists "dono vê pagamentos de entregadores" on public.courier_payouts;
create policy "dono vê pagamentos de entregadores" on public.courier_payouts for select using (is_owner(tenant_id));
revoke all on public.courier_payouts from anon, authenticated;
grant select on public.courier_payouts to authenticated;

-- Acerto de todos os entregadores no período, com o que já foi pago
create or replace function public.courier_statement(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Período inválido (até 93 dias)'; end if;
  return (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
    select _courier_calc(c.id, p_from, p_to) || jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'pixKey', c.pix_key, 'active', c.active,
      'payouts', case when is_owner(p_tenant) then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'from', p.period_from, 'to', p.period_to, 'amount', p.amount,
                   'earnings', p.earnings, 'method', p.method, 'at', p.paid_at) order by p.period_from), '[]')
                 from courier_payouts p where p.courier_id = c.id and daterange(p.period_from, p.period_to, '[]') && daterange(p_from, p_to, '[]')) else '[]' end) x
    from couriers c where c.tenant_id = p_tenant
      and (c.active or exists (select 1 from orders o where o.courier_id = c.id and o.created_at >= p_from - 1))) s);
end $$;
revoke execute on function public.courier_statement(uuid, date, date) from public, anon;
grant execute on function public.courier_statement(uuid, date, date) to authenticated;

-- Registra o pagamento: vira despesa "Entregadores" no financeiro e, se o caixa estiver aberto, acerta a gaveta
create or replace function public.courier_pay(p_courier bigint, p_from date, p_to date, p_method text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c couriers; x jsonb; v_amount int; v_exp bigint; v_move bigint; v_sess bigint; v_out int; v_id bigint;
begin
  select * into c from couriers where id = p_courier for update;
  if c.id is null or not is_owner(c.tenant_id) then raise exception 'Sem permissão'; end if;
  if p_method not in ('Pix', 'Dinheiro', 'Transferência') then raise exception 'Forma de pagamento inválida'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Período inválido (até 93 dias)'; end if;
  if p_to > (now() at time zone (select timezone from tenants where id = c.tenant_id))::date then raise exception 'O período não pode terminar no futuro'; end if;
  if exists (select 1 from courier_payouts where courier_id = c.id and daterange(period_from, period_to, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'Já existe um acerto pago que cobre parte desse período';
  end if;
  x := _courier_calc(c.id, p_from, p_to);
  if (x->>'deliveries')::int = 0 then raise exception 'Nenhuma entrega concluída nesse período'; end if;
  v_amount := (x->>'earnings')::int - (x->>'cash')::int;
  if (x->>'earnings')::int > 0 then
    insert into expenses (tenant_id, day, description, category, amount, created_by)
      values (c.tenant_id, p_to, left('Entregador ' || c.name || ' — ' || to_char(p_from, 'DD/MM') || case when p_to <> p_from then ' a ' || to_char(p_to, 'DD/MM') else '' end, 120),
              'Entregadores', (x->>'earnings')::int, auth.uid())
      returning id into v_exp;
  end if;
  -- Gaveta: o dinheiro dos clientes que o entregador recebeu já conta como venda em dinheiro no caixa.
  -- Pago em dinheiro: sai da gaveta o que ele ganhou. Pago por Pix/transferência: o dinheiro que ficou com ele nunca entrou na gaveta.
  v_out := case when p_method = 'Dinheiro' then (x->>'earnings')::int else (x->>'cash')::int end;
  select id into v_sess from cash_sessions where tenant_id = c.tenant_id and closed_at is null order by opened_at desc limit 1;
  if v_sess is not null and v_out > 0 then
    insert into cash_moves (tenant_id, session_id, kind, amount, note, by_user)
      values (c.tenant_id, v_sess, 'sangria', v_out, left('Acerto entregador ' || c.name, 120), auth.uid()) returning id into v_move;
  end if;
  insert into courier_payouts (tenant_id, courier_id, period_from, period_to, deliveries, earnings, cash, amount, method, note, expense_id, cash_move_id, by_user)
    values (c.tenant_id, c.id, p_from, p_to, (x->>'deliveries')::int, (x->>'earnings')::int, (x->>'cash')::int, v_amount, p_method,
            nullif(left(trim(coalesce(p_note, '')), 200), ''), v_exp, v_move, auth.uid())
    returning id into v_id;
  perform _log(c.tenant_id, 'Acerto de entregador', c.name || ' · ' || to_char(p_from, 'DD/MM') || '–' || to_char(p_to, 'DD/MM') || ' · '
    || case when v_amount >= 0 then 'pago ' || _money(v_amount) else 'devolveu ' || _money(-v_amount) end || ' (' || p_method || ')');
  return jsonb_build_object('id', v_id, 'amount', v_amount, 'earnings', (x->>'earnings')::int, 'cash', (x->>'cash')::int, 'cashMove', v_move is not null);
end $$;
revoke execute on function public.courier_pay(bigint, date, date, text, text) from public, anon;
grant execute on function public.courier_pay(bigint, date, date, text, text) to authenticated;

-- Desfazer um acerto lançado por engano (apaga a despesa e a sangria junto)
create or replace function public.courier_pay_undo(p_payout bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p courier_payouts;
begin
  select * into p from courier_payouts where id = p_payout;
  if p.id is null or not is_owner(p.tenant_id) then raise exception 'Sem permissão'; end if;
  delete from courier_payouts where id = p.id;
  if p.expense_id is not null then delete from expenses where id = p.expense_id; end if;
  if p.cash_move_id is not null then delete from cash_moves where id = p.cash_move_id and session_id in (select id from cash_sessions where closed_at is null); end if;
  perform _log(p.tenant_id, 'Acerto desfeito', 'Entregador #' || p.courier_id || ' · ' || to_char(p.period_from, 'DD/MM') || '–' || to_char(p.period_to, 'DD/MM'));
end $$;
revoke execute on function public.courier_pay_undo(bigint) from public, anon;
grant execute on function public.courier_pay_undo(bigint) to authenticated;

-- 4. Checagem das migrações
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
    (30, '20261212000000_acerto_entregadores.sql',        to_regclass('public.courier_payouts') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
