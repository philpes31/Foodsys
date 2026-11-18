-- =====================================================================
-- Balcão — estoque de insumos (ficha técnica) e financeiro do mês (despesas e resultado)
-- Rode depois de 20261130000000_caixa_acerto_bloqueio.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Insumos --------------------------------------------------------------
create table if not exists public.ingredients (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  unit text not null default 'un' check (unit in ('un', 'g', 'kg', 'ml', 'l')),
  stock numeric(14, 3) not null default 0,
  min_stock numeric(14, 3) not null default 0 check (min_stock >= 0),
  unit_cost numeric(14, 4) not null default 0 check (unit_cost >= 0),   -- centavos por unidade de medida
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists ingredients_tenant on public.ingredients (tenant_id);

-- Ficha técnica: quanto de cada insumo vai em 1 unidade do produto
create table if not exists public.product_ingredients (
  product_id bigint not null references public.products(id) on delete cascade,
  ingredient_id bigint not null references public.ingredients(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  qty numeric(14, 3) not null check (qty > 0),
  primary key (product_id, ingredient_id)
);
create index if not exists product_ingredients_ing on public.product_ingredients (ingredient_id);

-- Movimentos: baixa por venda, devolução por cancelamento, entrada (compra) e ajuste (contagem)
create table if not exists public.ingredient_moves (
  id bigint generated always as identity primary key,
  ingredient_id bigint not null references public.ingredients(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  delta numeric(14, 3) not null,
  reason text not null check (reason in ('pedido', 'cancelamento', 'entrada', 'ajuste')),
  cost_cents integer not null default 0,                   -- custo do movimento (para o custo dos insumos vendidos)
  order_id bigint references public.orders(id) on delete set null,
  note text check (char_length(note) <= 120),
  by_user uuid references auth.users(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists ingredient_moves_tenant_at on public.ingredient_moves (tenant_id, at desc);
create index if not exists ingredient_moves_ing on public.ingredient_moves (ingredient_id, at desc);

alter table public.ingredients enable row level security;
alter table public.product_ingredients enable row level security;
alter table public.ingredient_moves enable row level security;
drop policy if exists "equipe vê insumos" on public.ingredients;
create policy "equipe vê insumos" on public.ingredients for select to authenticated using (is_member(tenant_id));
drop policy if exists "dono cria insumo" on public.ingredients;
create policy "dono cria insumo" on public.ingredients for insert to authenticated with check (is_owner(tenant_id));
drop policy if exists "dono edita insumo" on public.ingredients;
create policy "dono edita insumo" on public.ingredients for update to authenticated using (is_owner(tenant_id)) with check (is_owner(tenant_id));
drop policy if exists "dono apaga insumo" on public.ingredients;
create policy "dono apaga insumo" on public.ingredients for delete to authenticated using (is_owner(tenant_id));
drop policy if exists "equipe vê ficha" on public.product_ingredients;
create policy "equipe vê ficha" on public.product_ingredients for select to authenticated using (is_member(tenant_id));
drop policy if exists "equipe vê movimentos de insumo" on public.ingredient_moves;
create policy "equipe vê movimentos de insumo" on public.ingredient_moves for select to authenticated using (is_member(tenant_id));
revoke all on public.ingredients, public.product_ingredients, public.ingredient_moves from anon, authenticated;
grant select on public.ingredients, public.product_ingredients, public.ingredient_moves to authenticated;
grant insert (tenant_id, name, unit, min_stock, unit_cost), update (name, unit, min_stock, unit_cost), delete on public.ingredients to authenticated;

-- Baixa automática: cada item vendido consome os insumos da ficha técnica
create or replace function public._ingredients_on_item() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  with c as (
    select pi.ingredient_id, pi.qty * new.qty as q, i.unit_cost
    from product_ingredients pi join ingredients i on i.id = pi.ingredient_id where pi.product_id = new.product_id),
  u as (update ingredients i set stock = i.stock - c.q from c where i.id = c.ingredient_id returning i.id)
  insert into ingredient_moves (ingredient_id, tenant_id, delta, reason, cost_cents, order_id)
    select c.ingredient_id, new.tenant_id, -c.q, 'pedido', -round(c.q * c.unit_cost), new.order_id from c;
  return new;
end $$;
drop trigger if exists order_items_ingredients on public.order_items;
create trigger order_items_ingredients after insert on public.order_items for each row execute function public._ingredients_on_item();

-- Cancelou: devolve o que o pedido tinha baixado (e baixa de novo se um cancelado voltar)
create or replace function public._ingredients_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
-- custo e quantidade seguem o sinal do movimento: consumo negativo, devolução positiva
begin
  if new.status = old.status then return new; end if;
  if new.status = 'cancelado' then
    -- devolve o que está consumido hoje (baixas menos devoluções anteriores)
    with net as (select ingredient_id, -sum(delta) q, -sum(cost_cents) cc from ingredient_moves
                 where order_id = new.id and reason in ('pedido', 'cancelamento') group by ingredient_id having -sum(delta) > 0),
    u as (update ingredients i set stock = i.stock + n.q from net n where i.id = n.ingredient_id returning i.id)
    insert into ingredient_moves (ingredient_id, tenant_id, delta, reason, cost_cents, order_id)
      select ingredient_id, new.tenant_id, q, 'cancelamento', cc, new.id from net;
  elsif old.status = 'cancelado' then
    -- voltou (ex.: Pix pago depois do prazo): baixa de novo o consumo original do pedido
    with orig as (select ingredient_id, -sum(delta) q, -sum(cost_cents) cc from ingredient_moves m
                  where m.order_id = new.id and m.reason = 'pedido'
                    and m.at = (select min(at) from ingredient_moves x where x.order_id = new.id and x.reason = 'pedido')
                  group by ingredient_id),
    u as (update ingredients i set stock = i.stock - o.q from orig o where i.id = o.ingredient_id returning i.id)
    insert into ingredient_moves (ingredient_id, tenant_id, delta, reason, cost_cents, order_id)
      select ingredient_id, new.tenant_id, -q, 'pedido', -cc, new.id from orig;
  end if;
  return new;
end $$;
drop trigger if exists orders_ingredients_on_status on public.orders;
create trigger orders_ingredients_on_status after update of status on public.orders for each row execute function public._ingredients_on_status();

-- Ficha técnica de um produto (substitui a lista inteira): [{"ingredientId": 1, "qty": 0.25}]
create or replace function public.set_recipe(p_product bigint, p_items jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid; n int;
begin
  select tenant_id into v_t from products where id = p_product;
  if v_t is null or not is_owner(v_t) then raise exception 'Sem permissão'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]')) x
             where not exists (select 1 from ingredients i where i.id = (x->>'ingredientId')::bigint and i.tenant_id = v_t)
                or coalesce((x->>'qty')::numeric, 0) <= 0) then
    raise exception 'Insumo ou quantidade inválida';
  end if;
  delete from product_ingredients where product_id = p_product;
  insert into product_ingredients (product_id, ingredient_id, tenant_id, qty)
    select p_product, (x->>'ingredientId')::bigint, v_t, sum((x->>'qty')::numeric) from jsonb_array_elements(coalesce(p_items, '[]')) x group by 1, 2, 3;
  get diagnostics n = row_count;
  return n;
end $$;

-- Entrada (compra) ou ajuste (contagem) de um insumo. Na entrada, um custo total informado atualiza o custo médio.
create or replace function public.ingredient_move(p_ingredient bigint, p_kind text, p_qty numeric, p_total_cost int default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i ingredients; v_delta numeric; v_cost numeric;
begin
  select * into i from ingredients where id = p_ingredient for update;
  if not found or not is_member(i.tenant_id) then raise exception 'Sem permissão'; end if;
  if p_kind = 'entrada' then
    if coalesce(p_qty, 0) <= 0 then raise exception 'Informe a quantidade comprada'; end if;
    v_delta := p_qty;
    if p_total_cost is not null and p_total_cost >= 0 then
      -- custo médio ponderado (estoque negativo conta como zero)
      v_cost := (greatest(i.stock, 0) * i.unit_cost + p_total_cost) / (greatest(i.stock, 0) + p_qty);
      update ingredients set unit_cost = round(v_cost, 4) where id = i.id;
    end if;
  elsif p_kind = 'ajuste' then
    if p_qty is null or p_qty < 0 then raise exception 'Informe a quantidade contada'; end if;
    v_delta := p_qty - i.stock;   -- p_qty = quanto há de fato
  else raise exception 'Use entrada ou ajuste'; end if;
  update ingredients set stock = stock + v_delta where id = i.id returning * into i;
  insert into ingredient_moves (ingredient_id, tenant_id, delta, reason, cost_cents, note, by_user)
    values (i.id, i.tenant_id, v_delta, p_kind, coalesce(case when p_kind = 'entrada' then p_total_cost end, 0), nullif(left(trim(coalesce(p_note, '')), 120), ''), auth.uid());
  return to_jsonb(i);
end $$;

-- 2. Despesas ---------------------------------------------------------------
create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,
  category text not null check (char_length(category) between 1 and 40),
  description text check (char_length(description) <= 120),
  amount integer not null check (amount > 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists expenses_tenant_day on public.expenses (tenant_id, day desc);
alter table public.expenses enable row level security;
drop policy if exists "dono vê despesas" on public.expenses;
create policy "dono vê despesas" on public.expenses for select to authenticated using (is_owner(tenant_id));
drop policy if exists "dono lança despesa" on public.expenses;
create policy "dono lança despesa" on public.expenses for insert to authenticated with check (is_owner(tenant_id));
drop policy if exists "dono edita despesa" on public.expenses;
create policy "dono edita despesa" on public.expenses for update to authenticated using (is_owner(tenant_id)) with check (is_owner(tenant_id));
drop policy if exists "dono apaga despesa" on public.expenses;
create policy "dono apaga despesa" on public.expenses for delete to authenticated using (is_owner(tenant_id));
revoke all on public.expenses from anon, authenticated;
grant select, delete on public.expenses to authenticated;
grant insert (tenant_id, day, category, description, amount), update (day, category, description, amount) on public.expenses to authenticated;

-- 3. Resultado do mês: faturamento − custo dos insumos vendidos − despesas
create or replace function public.profit_report(p_tenant uuid, p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; m0 date; m1 date; v_rev int; v_fees int; v_cmv int; v_exp int; v_orders int;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select timezone into tz from tenants where id = p_tenant;
  m0 := date_trunc('month', coalesce(p_month, (now() at time zone tz)::date))::date; m1 := (m0 + interval '1 month')::date;
  select count(*), coalesce(sum(total), 0), coalesce(sum(fee), 0) into v_orders, v_rev, v_fees from orders
    where tenant_id = p_tenant and status not in ('cancelado', 'pagamento')
      and created_at >= m0::timestamp at time zone tz and created_at < m1::timestamp at time zone tz;
  select coalesce(-sum(cost_cents), 0) into v_cmv from ingredient_moves
    where tenant_id = p_tenant and reason in ('pedido', 'cancelamento') and at >= m0::timestamp at time zone tz and at < m1::timestamp at time zone tz;
  select coalesce(sum(amount), 0) into v_exp from expenses where tenant_id = p_tenant and day >= m0 and day < m1;
  return jsonb_build_object('month', m0, 'orders', v_orders, 'revenue', v_rev, 'deliveryFees', v_fees, 'ingredients', v_cmv, 'expenses', v_exp,
    'result', v_rev - v_cmv - v_exp,
    'byCategory', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', s) order by s desc), '[]')
                   from (select category, sum(amount) s from expenses where tenant_id = p_tenant and day >= m0 and day < m1 group by category) x),
    'lowStock', (select count(*) from ingredients where tenant_id = p_tenant and stock <= min_stock and min_stock > 0));
end $$;

revoke execute on function public.set_recipe(bigint, jsonb), public.ingredient_move(bigint, text, numeric, int, text), public.profit_report(uuid, date) from public, anon;
grant execute on function public.set_recipe(bigint, jsonb), public.ingredient_move(bigint, text, numeric, int, text), public.profit_report(uuid, date) to authenticated;

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
    (19, '20261201000000_insumos_financeiro.sql',         to_regclass('public.ingredients') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
