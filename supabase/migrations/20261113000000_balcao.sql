-- =====================================================================
-- Balcão — SaaS de delivery multiempresa sobre Supabase
-- Tabelas, segurança por linha (RLS), funções (RPC) e tempo real.
-- Valores em dinheiro são inteiros em centavos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Catálogo da plataforma: planos e modelos por segmento
-- ---------------------------------------------------------------------
create table public.plans (
  name text primary key,
  price integer not null,
  monthly_orders integer,            -- null = ilimitado
  features text not null,
  sort integer not null default 0
);
insert into public.plans (name, price, monthly_orders, features, sort) values
  ('Básico', 7900, 300, 'Loja online, painel de preparo, até 300 pedidos/mês', 0),
  ('Pro', 14900, null, 'Pedidos ilimitados, entregadores, cupons, relatórios', 1),
  ('Rede', 34900, null, 'Várias unidades, API, domínio próprio, suporte prioritário', 2);

create table public.segment_templates (
  segment text primary key,
  name text not null,
  color text not null,
  prep text not null,      -- nome da tela de preparo (Cozinha, Chapa, Separação...)
  icon text not null,
  sort integer not null default 0,
  products jsonb not null  -- [{category,name,description,price,icon,groups:[{name,min_sel,max_sel,options:[{name,price}]}]}]
);

-- ---------------------------------------------------------------------
-- Empresas e acesso
-- ---------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null check (length(name) between 1 and 80),
  segment text not null references public.segment_templates(segment),
  color text not null default '#d62828' check (color ~ '^#[0-9a-fA-F]{6}$'),
  plan text not null default 'Pro' references public.plans(name),
  min_order integer not null default 0 check (min_order >= 0),
  is_open boolean not null default true,
  allow_pickup boolean not null default true,
  eta_text text not null default '30 a 50 min' check (length(eta_text) <= 40),
  phone text not null default '' check (length(phone) <= 30),
  timezone text not null default 'America/Sao_Paulo',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index on public.memberships (user_id);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Cardápio
-- ---------------------------------------------------------------------
create table public.products (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category text not null check (length(category) between 1 and 40),
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 200),
  price integer not null check (price >= 0),
  icon text not null default 'box',
  available boolean not null default true,
  sort integer not null default 0
);
create index on public.products (tenant_id, sort);

create table public.option_groups (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  min_sel integer not null default 0 check (min_sel >= 0),
  max_sel integer not null default 1 check (max_sel >= 1 and max_sel >= min_sel),
  sort integer not null default 0
);
create index on public.option_groups (product_id);

create table public.options (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.option_groups(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  price integer not null default 0 check (price >= 0),
  sort integer not null default 0
);
create index on public.options (group_id);

-- ---------------------------------------------------------------------
-- Entrega, cupons, entregadores
-- ---------------------------------------------------------------------
create table public.zones (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  fee integer not null default 0 check (fee >= 0)
);

create table public.coupons (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{2,20}$'),
  percent integer not null default 0 check (percent between 0 and 90),
  free_shipping boolean not null default false,
  active boolean not null default true,
  unique (tenant_id, code)
);

create table public.couriers (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  phone text not null default '',
  active boolean not null default true
);

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
create table public.orders (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number integer not null,
  public_code text not null unique,
  customer_name text not null,
  customer_phone text not null,
  fulfillment text not null check (fulfillment in ('delivery', 'pickup')),
  address text not null default '',
  zone_name text not null default '',
  payment text not null check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro')),
  change_for integer,
  subtotal integer not null,
  fee integer not null,
  discount integer not null,
  total integer not null,
  coupon_code text,
  status text not null default 'novo' check (status in ('novo', 'preparo', 'pronto', 'rota', 'entregue', 'cancelado')),
  courier_id bigint references public.couriers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index on public.orders (tenant_id, status);
create index on public.orders (tenant_id, created_at);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id bigint,
  product_name text not null,
  options_text text not null default '',
  qty integer not null check (qty > 0),
  unit_price integer not null,
  notes text not null default ''
);
create index on public.order_items (order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null,
  at timestamptz not null default now()
);
create index on public.order_events (order_id);

-- ---------------------------------------------------------------------
-- Funções auxiliares usadas nas políticas de segurança
-- ---------------------------------------------------------------------
create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create function public.my_role(p_tenant uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from memberships m join tenants t on t.id = m.tenant_id
  where m.tenant_id = p_tenant and m.user_id = auth.uid() and t.active
$$;

create function public.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.my_role(p_tenant) is not null
$$;

create function public.is_owner(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.my_role(p_tenant) = 'owner', false)
$$;

create function public.tenant_is_public(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from tenants where id = p_tenant and active)
$$;

create function public.slugify(p text) returns text
language sql immutable as $$
  select left(trim(both '-' from regexp_replace(
    translate(lower(coalesce(p, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'),
    '[^a-z0-9]+', '-', 'g')), 40)
$$;

-- Modelos de catálogo por segmento (preços em centavos)
insert into public.segment_templates (segment, name, color, prep, icon, sort, products) values
  ('pizzaria', 'Pizzaria', '#d62828', 'Cozinha', 'pizza', 0, '[{"category":"Pizzas","name":"Margherita","description":"Tomate, muçarela, manjericão","price":4200,"icon":"pizza","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"Pequena (4 fatias)","price":0},{"name":"Média (6 fatias)","price":1200},{"name":"Grande (8 fatias)","price":2200}]},{"name":"Meio a meio","min_sel":0,"max_sel":1,"options":[{"name":"½ Calabresa","price":0},{"name":"½ Quatro Queijos","price":600},{"name":"½ Frango c/ Catupiry","price":500},{"name":"½ Portuguesa","price":400}]},{"name":"Borda recheada","min_sel":0,"max_sel":1,"options":[{"name":"Catupiry","price":900},{"name":"Cheddar","price":900},{"name":"Chocolate","price":1200}]}]},{"category":"Pizzas","name":"Calabresa","description":"Calabresa, cebola roxa, orégano","price":4400,"icon":"pizza","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"Pequena (4 fatias)","price":0},{"name":"Média (6 fatias)","price":1200},{"name":"Grande (8 fatias)","price":2200}]},{"name":"Meio a meio","min_sel":0,"max_sel":1,"options":[{"name":"½ Calabresa","price":0},{"name":"½ Quatro Queijos","price":600},{"name":"½ Frango c/ Catupiry","price":500},{"name":"½ Portuguesa","price":400}]},{"name":"Borda recheada","min_sel":0,"max_sel":1,"options":[{"name":"Catupiry","price":900},{"name":"Cheddar","price":900},{"name":"Chocolate","price":1200}]}]},{"category":"Pizzas","name":"Quatro Queijos","description":"Muçarela, provolone, parmesão, gorgonzola","price":4800,"icon":"pizza","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"Pequena (4 fatias)","price":0},{"name":"Média (6 fatias)","price":1200},{"name":"Grande (8 fatias)","price":2200}]},{"name":"Meio a meio","min_sel":0,"max_sel":1,"options":[{"name":"½ Calabresa","price":0},{"name":"½ Quatro Queijos","price":600},{"name":"½ Frango c/ Catupiry","price":500},{"name":"½ Portuguesa","price":400}]},{"name":"Borda recheada","min_sel":0,"max_sel":1,"options":[{"name":"Catupiry","price":900},{"name":"Cheddar","price":900},{"name":"Chocolate","price":1200}]}]},{"category":"Pizzas","name":"Pepperoni","description":"Pepperoni artesanal e muçarela","price":5000,"icon":"pizza","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"Pequena (4 fatias)","price":0},{"name":"Média (6 fatias)","price":1200},{"name":"Grande (8 fatias)","price":2200}]},{"name":"Meio a meio","min_sel":0,"max_sel":1,"options":[{"name":"½ Calabresa","price":0},{"name":"½ Quatro Queijos","price":600},{"name":"½ Frango c/ Catupiry","price":500},{"name":"½ Portuguesa","price":400}]},{"name":"Borda recheada","min_sel":0,"max_sel":1,"options":[{"name":"Catupiry","price":900},{"name":"Cheddar","price":900},{"name":"Chocolate","price":1200}]}]},{"category":"Doces","name":"Chocolate com Morango","description":"Chocolate ao leite e morangos","price":4600,"icon":"pizza","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"Pequena (4 fatias)","price":0},{"name":"Média (6 fatias)","price":1200},{"name":"Grande (8 fatias)","price":2200}]}]},{"category":"Bebidas","name":"Refrigerante 2L","description":"Escolha o sabor","price":1400,"icon":"bottle","groups":[{"name":"Sabor","min_sel":1,"max_sel":1,"options":[{"name":"Coca-Cola","price":0},{"name":"Guaraná","price":0},{"name":"Fanta Laranja","price":0}]}]},{"category":"Bebidas","name":"Água sem gás","description":"500 ml","price":500,"icon":"bottle","groups":[]}]'::jsonb),
  ('hamburgueria', 'Hamburgueria', '#e85d04', 'Chapa', 'burger', 1, '[{"category":"Burgers","name":"Clássico","description":"Blend 160g, queijo, alface, tomate, molho da casa","price":2900,"icon":"burger","groups":[{"name":"Ponto da carne","min_sel":1,"max_sel":1,"options":[{"name":"Mal passado","price":0},{"name":"Ao ponto","price":0},{"name":"Bem passado","price":0}]},{"name":"Adicionais","min_sel":0,"max_sel":5,"options":[{"name":"Bacon","price":600},{"name":"Cheddar extra","price":400},{"name":"Ovo","price":300},{"name":"Cebola caramelizada","price":400},{"name":"Hambúrguer extra","price":1200}]},{"name":"Transformar em combo","min_sel":0,"max_sel":1,"options":[{"name":"Batata média + refri lata","price":1600},{"name":"Batata grande + refri 600ml","price":2200}]}]},{"category":"Burgers","name":"Bacon Duplo","description":"2 blends 120g, cheddar, bacon crocante","price":3900,"icon":"burger","groups":[{"name":"Ponto da carne","min_sel":1,"max_sel":1,"options":[{"name":"Mal passado","price":0},{"name":"Ao ponto","price":0},{"name":"Bem passado","price":0}]},{"name":"Adicionais","min_sel":0,"max_sel":5,"options":[{"name":"Bacon","price":600},{"name":"Cheddar extra","price":400},{"name":"Ovo","price":300},{"name":"Cebola caramelizada","price":400},{"name":"Hambúrguer extra","price":1200}]},{"name":"Transformar em combo","min_sel":0,"max_sel":1,"options":[{"name":"Batata média + refri lata","price":1600},{"name":"Batata grande + refri 600ml","price":2200}]}]},{"category":"Burgers","name":"Smash Salad","description":"Smash 90g, queijo prato, salada","price":2400,"icon":"burger","groups":[{"name":"Adicionais","min_sel":0,"max_sel":5,"options":[{"name":"Bacon","price":600},{"name":"Cheddar extra","price":400},{"name":"Ovo","price":300},{"name":"Cebola caramelizada","price":400},{"name":"Hambúrguer extra","price":1200}]},{"name":"Transformar em combo","min_sel":0,"max_sel":1,"options":[{"name":"Batata média + refri lata","price":1600},{"name":"Batata grande + refri 600ml","price":2200}]}]},{"category":"Burgers","name":"Veggie","description":"Burger de grão-de-bico, rúcula, tomate seco","price":3100,"icon":"burger","groups":[{"name":"Adicionais","min_sel":0,"max_sel":5,"options":[{"name":"Bacon","price":600},{"name":"Cheddar extra","price":400},{"name":"Ovo","price":300},{"name":"Cebola caramelizada","price":400},{"name":"Hambúrguer extra","price":1200}]},{"name":"Transformar em combo","min_sel":0,"max_sel":1,"options":[{"name":"Batata média + refri lata","price":1600},{"name":"Batata grande + refri 600ml","price":2200}]}]},{"category":"Porções","name":"Batata rústica","description":"400 g com alecrim e páprica","price":2200,"icon":"box","groups":[]},{"category":"Bebidas","name":"Refri lata","description":"350 ml","price":700,"icon":"bottle","groups":[{"name":"Sabor","min_sel":1,"max_sel":1,"options":[{"name":"Coca-Cola","price":0},{"name":"Guaraná","price":0},{"name":"Fanta Laranja","price":0}]}]},{"category":"Bebidas","name":"Milkshake","description":"Ovomaltine, 400 ml","price":1900,"icon":"cup","groups":[]}]'::jsonb),
  ('acai', 'Açaiteria', '#6a2c91', 'Montagem', 'cup', 2, '[{"category":"Açaí","name":"Açaí tradicional","description":"Açaí puro batido na hora","price":1600,"icon":"cup","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"300 ml","price":0},{"name":"500 ml","price":700},{"name":"700 ml","price":1300}]},{"name":"Complementos","min_sel":0,"max_sel":5,"options":[{"name":"Granola","price":0},{"name":"Leite ninho","price":300},{"name":"Paçoca","price":200},{"name":"Banana","price":200},{"name":"Morango","price":400},{"name":"Nutella","price":600},{"name":"Leite condensado","price":200}]}]},{"category":"Açaí","name":"Açaí com cupuaçu","description":"Metade açaí, metade creme de cupuaçu","price":1800,"icon":"cup","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"300 ml","price":0},{"name":"500 ml","price":700},{"name":"700 ml","price":1300}]},{"name":"Complementos","min_sel":0,"max_sel":5,"options":[{"name":"Granola","price":0},{"name":"Leite ninho","price":300},{"name":"Paçoca","price":200},{"name":"Banana","price":200},{"name":"Morango","price":400},{"name":"Nutella","price":600},{"name":"Leite condensado","price":200}]}]},{"category":"Açaí","name":"Açaí zero açúcar","description":"Adoçado com xilitol","price":1900,"icon":"cup","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"300 ml","price":0},{"name":"500 ml","price":700},{"name":"700 ml","price":1300}]},{"name":"Complementos","min_sel":0,"max_sel":5,"options":[{"name":"Granola","price":0},{"name":"Leite ninho","price":300},{"name":"Paçoca","price":200},{"name":"Banana","price":200},{"name":"Morango","price":400},{"name":"Nutella","price":600},{"name":"Leite condensado","price":200}]}]},{"category":"Cremes","name":"Creme de ninho","description":"Cremoso de leite ninho","price":1700,"icon":"cup","groups":[{"name":"Tamanho","min_sel":1,"max_sel":1,"options":[{"name":"300 ml","price":0},{"name":"500 ml","price":700},{"name":"700 ml","price":1300}]},{"name":"Complementos","min_sel":0,"max_sel":5,"options":[{"name":"Granola","price":0},{"name":"Leite ninho","price":300},{"name":"Paçoca","price":200},{"name":"Banana","price":200},{"name":"Morango","price":400},{"name":"Nutella","price":600},{"name":"Leite condensado","price":200}]}]},{"category":"Bebidas","name":"Água de coco","description":"300 ml","price":800,"icon":"bottle","groups":[]}]'::jsonb),
  ('mercado', 'Mercado', '#2f8f46', 'Separação', 'box', 3, '[{"category":"Mercearia","name":"Arroz tipo 1 — 5 kg","description":"Pacote","price":2790,"icon":"box","groups":[]},{"category":"Mercearia","name":"Feijão carioca — 1 kg","description":"Pacote","price":849,"icon":"box","groups":[]},{"category":"Mercearia","name":"Café torrado — 500 g","description":"Moagem tradicional","price":1890,"icon":"box","groups":[]},{"category":"Hortifrúti","name":"Banana prata","description":"Preço por kg","price":699,"icon":"leaf","groups":[]},{"category":"Hortifrúti","name":"Tomate","description":"Preço por kg","price":899,"icon":"leaf","groups":[]},{"category":"Limpeza","name":"Detergente 500 ml","description":"Neutro","price":279,"icon":"bottle","groups":[]},{"category":"Bebidas","name":"Cerveja lata 350 ml","description":"Pack com 12","price":4290,"icon":"bottle","groups":[]}]'::jsonb),
  ('farmacia', 'Farmácia', '#0b7285', 'Separação', 'pill', 4, '[{"category":"Medicamentos","name":"Dipirona 500 mg","description":"10 comprimidos · isento de prescrição","price":690,"icon":"pill","groups":[]},{"category":"Medicamentos","name":"Paracetamol 750 mg","description":"20 comprimidos · isento de prescrição","price":1250,"icon":"pill","groups":[]},{"category":"Higiene","name":"Creme dental 90 g","description":"Proteção anticáries","price":549,"icon":"box","groups":[]},{"category":"Higiene","name":"Protetor solar FPS 50","description":"200 ml","price":4990,"icon":"bottle","groups":[]},{"category":"Bem-estar","name":"Vitamina C 1 g","description":"10 comprimidos efervescentes","price":1990,"icon":"pill","groups":[]}]'::jsonb),
  ('outro', 'Outro negócio', '#3d5a80', 'Preparo', 'box', 5, '[{"category":"Produtos","name":"Produto exemplo","description":"Edite em Cardápio","price":2000,"icon":"box","groups":[]}]'::jsonb)
on conflict (segment) do update set name = excluded.name, color = excluded.color, prep = excluded.prep, icon = excluded.icon, sort = excluded.sort, products = excluded.products;

-- ---------------------------------------------------------------------
-- Cardápio: validação e gravação de produtos com grupos de opções
-- ---------------------------------------------------------------------
create function public._validate_product(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  g jsonb; o jsonb; v_groups jsonb := '[]'; v_opts jsonb; v_min int; v_max int; v_name text; v_price int;
begin
  if coalesce(trim(p->>'name'), '') = '' or coalesce(trim(p->>'category'), '') = '' then
    raise exception 'Produto precisa de nome e categoria';
  end if;
  if coalesce(p->>'price', '') !~ '^\d{1,7}$' then raise exception 'Preço inválido'; end if;
  if jsonb_typeof(coalesce(p->'groups', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'groups', '[]')) > 10 then
    raise exception 'Grupos de opções inválidos';
  end if;
  for g in select * from jsonb_array_elements(coalesce(p->'groups', '[]')) loop
    v_name := left(trim(coalesce(g->>'name', '')), 60);
    if v_name = '' then raise exception 'Todo grupo de opções precisa de nome'; end if;
    if jsonb_typeof(g->'options') <> 'array' or jsonb_array_length(g->'options') not between 1 and 40 then
      raise exception 'O grupo "%" precisa de 1 a 40 opções', v_name;
    end if;
    v_opts := '[]';
    for o in select * from jsonb_array_elements(g->'options') loop
      if coalesce(trim(o->>'name'), '') = '' or coalesce(o->>'price', '') !~ '^\d{1,7}$' then
        raise exception 'Opção inválida no grupo "%"', v_name;
      end if;
      v_opts := v_opts || jsonb_build_object('name', left(trim(o->>'name'), 60), 'price', (o->>'price')::int);
    end loop;
    if coalesce(g->>'min_sel', '') !~ '^\d{1,2}$' or coalesce(g->>'max_sel', '') !~ '^\d{1,2}$' then
      raise exception 'Mínimo/máximo inválidos no grupo "%"', v_name;
    end if;
    v_min := (g->>'min_sel')::int; v_max := (g->>'max_sel')::int;
    if v_max < 1 or v_min > v_max or v_min > jsonb_array_length(v_opts) then
      raise exception 'Mínimo/máximo inválidos no grupo "%"', v_name;
    end if;
    v_groups := v_groups || jsonb_build_object('name', v_name, 'min_sel', v_min,
      'max_sel', least(v_max, jsonb_array_length(v_opts)), 'options', v_opts);
  end loop;
  return jsonb_build_object(
    'category', left(trim(p->>'category'), 40), 'name', left(trim(p->>'name'), 80),
    'description', left(trim(coalesce(p->>'description', '')), 200), 'price', (p->>'price')::int,
    'icon', coalesce(nullif(p->>'icon', ''), 'box'), 'available', coalesce((p->>'available')::boolean, true),
    'sort', coalesce((p->>'sort')::int, 0), 'groups', v_groups);
end $$;

create function public._write_groups(p_tenant uuid, p_product bigint, p_groups jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g jsonb; o jsonb; v_gid bigint; gi int := 0; oi int;
begin
  delete from option_groups where product_id = p_product;
  for g in select * from jsonb_array_elements(p_groups) loop
    insert into option_groups (product_id, tenant_id, name, min_sel, max_sel, sort)
      values (p_product, p_tenant, g->>'name', (g->>'min_sel')::int, (g->>'max_sel')::int, gi) returning id into v_gid;
    oi := 0;
    for o in select * from jsonb_array_elements(g->'options') loop
      insert into options (group_id, tenant_id, name, price, sort) values (v_gid, p_tenant, o->>'name', (o->>'price')::int, oi);
      oi := oi + 1;
    end loop;
    gi := gi + 1;
  end loop;
end $$;

create function public.save_product(p_tenant uuid, p_id bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb; v_id bigint;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  v := _validate_product(p);
  if p_id is null then
    insert into products (tenant_id, category, name, description, price, icon, available, sort)
    values (p_tenant, v->>'category', v->>'name', v->>'description', (v->>'price')::int, v->>'icon', (v->>'available')::boolean,
      coalesce((select max(sort) + 1 from products where tenant_id = p_tenant), 0))
    returning id into v_id;
  else
    update products set category = v->>'category', name = v->>'name', description = v->>'description', price = (v->>'price')::int,
      icon = v->>'icon', available = (v->>'available')::boolean
    where id = p_id and tenant_id = p_tenant returning id into v_id;
    if v_id is null then raise exception 'Produto não encontrado'; end if;
  end if;
  perform _write_groups(p_tenant, v_id, v->'groups');
  return v_id;
end $$;

create function public.set_product_availability(p_product bigint, p_available boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from products where id = p_product;
  if v_tenant is null or not is_member(v_tenant) then raise exception 'Sem permissão'; end if;
  update products set available = p_available where id = p_product;
end $$;

-- ---------------------------------------------------------------------
-- Cadastro de empresa (self-service): quem está logado cria a própria loja
-- ---------------------------------------------------------------------
create function public._apply_template(p_tenant uuid, p_segment text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr jsonb; v jsonb; v_id bigint; i int := 0;
begin
  for pr in select * from jsonb_array_elements((select products from segment_templates where segment = p_segment)) loop
    v := _validate_product(pr);
    insert into products (tenant_id, category, name, description, price, icon, available, sort)
      values (p_tenant, v->>'category', v->>'name', v->>'description', (v->>'price')::int, v->>'icon', true, i) returning id into v_id;
    perform _write_groups(p_tenant, v_id, v->'groups');
    i := i + 1;
  end loop;
  insert into zones (tenant_id, name, fee) values (p_tenant, 'Centro', 500), (p_tenant, 'Jardim América', 700), (p_tenant, 'Vila Nova', 800), (p_tenant, 'Boa Vista', 1000);
  insert into coupons (tenant_id, code, percent) values (p_tenant, 'PRIMEIRA10', 10);
  insert into coupons (tenant_id, code, free_shipping) values (p_tenant, 'FRETEGRATIS', true);
end $$;

create function public.create_my_tenant(p_name text, p_segment text, p_slug text default null, p_color text default null)
returns public.tenants
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_slug text; t tenants; v_seg segment_templates;
begin
  if auth.uid() is null then raise exception 'Faça login para criar sua loja'; end if;
  if (select count(*) from memberships where user_id = auth.uid() and role = 'owner') >= 10 then raise exception 'Limite de empresas por conta atingido'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Informe o nome da empresa'; end if;
  select * into v_seg from segment_templates where segment = p_segment;
  if not found then raise exception 'Segmento inválido'; end if;
  v_slug := slugify(coalesce(nullif(trim(p_slug), ''), p_name));
  if length(v_slug) < 2 then v_slug := 'loja-' || v_slug; end if;
  if exists (select 1 from tenants where slug = v_slug) then
    if nullif(trim(p_slug), '') is not null then raise exception 'Esse endereço de loja já está em uso'; end if;
    v_slug := left(v_slug, 34) || '-' || lower(left(replace(gen_random_uuid()::text, '-', ''), 5));
  end if;
  insert into tenants (slug, name, segment, color, min_order)
    values (v_slug, left(trim(p_name), 80), p_segment, coalesce(nullif(p_color, ''), v_seg.color), case when p_segment = 'mercado' then 3000 else 0 end)
    returning * into t;
  insert into memberships (tenant_id, user_id, role) values (t.id, auth.uid(), 'owner');
  perform _apply_template(t.id, p_segment);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- Pedidos: o preço é sempre calculado aqui, a partir do cardápio
-- ---------------------------------------------------------------------
create function public._create_order(t public.tenants, p jsonb, p_check_min boolean default true) returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case when p->>'fulfillment' = 'pickup' then 'pickup' else 'delivery' end;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := '';
  z zones; c coupons; pr products; g option_groups;
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_chosen bigint[]; v_cnt int; v_add int;
  v_sub int := 0; v_disc int := 0; v_total int; v_change int; v_num int; o orders;
begin
  if v_name = '' or length(regexp_replace(v_phone, '\D', '', 'g')) < 8 then raise exception 'Informe nome e telefone válidos'; end if;
  if v_ful = 'pickup' and not t.allow_pickup then raise exception 'Esta loja não aceita retirada'; end if;
  if v_ful = 'delivery' then
    select * into z from zones where tenant_id = t.id and id::text = coalesce(p->>'zoneId', '');
    if not found then raise exception 'Escolha um bairro atendido'; end if;
    v_addr := left(trim(coalesce(p->>'address', '')), 200);
    if length(v_addr) < 5 then raise exception 'Informe o endereço de entrega'; end if;
    v_fee := z.fee; v_zone := z.name;
  end if;
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro') then raise exception 'Forma de pagamento inválida'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') not between 1 and 50 then raise exception 'Carrinho vazio'; end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where tenant_id = t.id and id::text = coalesce(it->>'productId', '') and available;
    if not found then raise exception 'Um dos produtos não está mais disponível'; end if;
    if coalesce(it->>'qty', '') !~ '^\d{1,2}$' or (it->>'qty')::int < 1 then raise exception 'Quantidade inválida'; end if;
    v_qty := (it->>'qty')::int;
    if it->'optionIds' is not null and jsonb_typeof(it->'optionIds') <> 'array' then raise exception 'Opções inválidas'; end if;
    select coalesce(array_agg(distinct x::bigint), '{}') into v_chosen
      from jsonb_array_elements_text(coalesce(it->'optionIds', '[]')) x where x ~ '^\d{1,18}$';
    if cardinality(v_chosen) <> jsonb_array_length(coalesce(it->'optionIds', '[]')) then raise exception 'Opções inválidas'; end if;
    if exists (select 1 from unnest(v_chosen) x where x not in
        (select op.id from options op join option_groups og on og.id = op.group_id where og.product_id = pr.id)) then
      raise exception 'Opção inválida para o produto %', pr.name;
    end if;
    v_unit := pr.price; v_labels := '{}';
    for g in select * from option_groups where product_id = pr.id order by sort, id loop
      select count(*), coalesce(sum(price), 0) into v_cnt, v_add from options where group_id = g.id and id = any(v_chosen);
      if v_cnt < g.min_sel or v_cnt > g.max_sel then
        raise exception 'Escolha entre % e % em "%" (%)', g.min_sel, g.max_sel, g.name, pr.name;
      end if;
      v_unit := v_unit + v_add;
      v_labels := v_labels || array(select name from options where group_id = g.id and id = any(v_chosen) order by sort, id);
    end loop;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'product_name', pr.name, 'options_text', array_to_string(v_labels, ', '),
      'qty', v_qty, 'unit_price', v_unit, 'notes', left(coalesce(it->>'notes', ''), 140));
    v_sub := v_sub + v_qty * v_unit;
  end loop;

  if p_check_min and v_sub < t.min_order then raise exception 'Pedido abaixo do valor mínimo da loja'; end if;
  if coalesce(trim(p->>'coupon'), '') <> '' then
    select * into c from coupons where tenant_id = t.id and code = upper(trim(p->>'coupon')) and active;
    if not found then raise exception 'Cupom inválido'; end if;
    v_disc := round(v_sub * c.percent / 100.0);
    if c.free_shipping then v_fee := 0; end if;
  end if;
  v_total := v_sub + v_fee - v_disc;
  if v_pay = 'Dinheiro' and coalesce(p->>'changeFor', '') ~ '^\d{1,8}$' and (p->>'changeFor')::int > v_total then
    v_change := (p->>'changeFor')::int;
  end if;

  perform pg_advisory_xact_lock(hashtext(t.id::text));
  select coalesce(max(number), 100) + 1 into v_num from orders where tenant_id = t.id;
  insert into orders (tenant_id, number, public_code, customer_name, customer_phone, fulfillment, address, zone_name, payment, change_for,
                      subtotal, fee, discount, total, coupon_code)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, c.code)
  returning * into o;
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes'
    from jsonb_array_elements(v_items) x;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, 'novo', o.created_at);
  return o;
end $$;

create function public.place_order(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_limit int; o orders;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  if not t.is_open then raise exception 'A loja está fechada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total);
end $$;

create function public.check_coupon(p_slug text, p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('code', c.code, 'percent', c.percent, 'freeShipping', c.free_shipping)
  from coupons c join tenants t on t.id = c.tenant_id
  where t.slug = p_slug and t.active and c.active and c.code = upper(trim(p_code))
$$;

create function public.track_order(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', t.slug, 'name', t.name, 'color', t.color, 'phone', t.phone),
    'order', jsonb_build_object('number', o.number, 'status', o.status, 'fulfillment', o.fulfillment,
      'customerName', split_part(o.customer_name, ' ', 1), 'address', o.address, 'zone', o.zone_name, 'payment', o.payment,
      'subtotal', o.subtotal, 'fee', o.fee, 'discount', o.discount, 'total', o.total, 'coupon', o.coupon_code,
      'courier', case when o.status = 'rota' then cr.name end,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('product_name', i.product_name, 'options_text', i.options_text, 'qty', i.qty,
                 'unit_price', i.unit_price, 'notes', i.notes) order by i.id), '[]') from order_items i where i.order_id = o.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'at', e.at) order by e.id), '[]') from order_events e where e.order_id = o.id)))
  from orders o join tenants t on t.id = o.tenant_id left join couriers cr on cr.id = o.courier_id
  where o.public_code = upper(trim(p_code))
$$;

create function public.change_order_status(p_order bigint, p_status text, p_courier bigint default null) returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_allowed text[];
begin
  select * into o from orders where id = p_order for update;
  if not found or not is_member(o.tenant_id) then raise exception 'Pedido não encontrado'; end if;
  v_allowed := case o.status
    when 'novo' then array['preparo', 'cancelado']
    when 'preparo' then array['pronto', 'cancelado']
    when 'pronto' then array['rota', 'entregue', 'cancelado']
    when 'rota' then array['entregue']
    else '{}'::text[] end;
  if not p_status = any(v_allowed) then raise exception 'Não é possível ir de "%" para "%"', o.status, p_status; end if;
  if p_status = 'rota' then
    if o.fulfillment <> 'delivery' then raise exception 'Pedido de retirada não sai para entrega'; end if;
    if not exists (select 1 from couriers where id = p_courier and tenant_id = o.tenant_id and active) then
      raise exception 'Escolha um entregador ativo';
    end if;
  end if;
  if p_status = 'entregue' and o.status = 'pronto' and o.fulfillment = 'delivery' then
    raise exception 'Despache o pedido antes de confirmar a entrega';
  end if;
  update orders set status = p_status, updated_at = now(),
    courier_id = case when p_status = 'rota' then p_courier else courier_id end
  where id = p_order returning * into o;
  insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, p_status);
  return o;
end $$;

-- ---------------------------------------------------------------------
-- Relatórios da empresa
-- ---------------------------------------------------------------------
create function public.store_report(p_tenant uuid, p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_from timestamptz; v_tz text; r jsonb;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select timezone into v_tz from tenants where id = p_tenant;
  v_from := case when p_days <= 1 then date_trunc('day', now() at time zone v_tz) at time zone v_tz
                 else now() - make_interval(days => least(greatest(p_days, 1), 366)) end;
  with o as (select * from orders where tenant_id = p_tenant and created_at >= v_from),
       ok as (select * from o where status <> 'cancelado')
  select jsonb_build_object(
    'days', p_days,
    'orders', (select count(*) from ok),
    'revenue', (select coalesce(sum(total), 0) from ok),
    'avgTicket', (select coalesce(round(avg(total)), 0) from ok),
    'cancelled', (select count(*) from o where status = 'cancelado'),
    'avgDeliveryMin', (select round(extract(epoch from avg(e.at - ok.created_at)) / 60) from ok join order_events e on e.order_id = ok.id and e.status = 'entregue'),
    'byHour', (select coalesce(jsonb_agg(x order by x->>'h'), '[]') from (select jsonb_build_object('h', extract(hour from created_at at time zone v_tz)::int,
                 'orders', count(*), 'revenue', sum(total)) x from ok group by extract(hour from created_at at time zone v_tz)) s),
    'byDay', (select coalesce(jsonb_agg(x order by x->>'d'), '[]') from (select jsonb_build_object('d', to_char(created_at at time zone v_tz, 'YYYY-MM-DD'),
                 'orders', count(*), 'revenue', sum(total)) x from ok group by to_char(created_at at time zone v_tz, 'YYYY-MM-DD')) s),
    'top', (select coalesce(jsonb_agg(x order by (x->>'qty')::int desc), '[]') from (select jsonb_build_object('name', i.product_name, 'qty', sum(i.qty),
                 'revenue', sum(i.qty * i.unit_price)) x from order_items i join ok on ok.id = i.order_id group by i.product_name order by sum(i.qty) desc limit 8) s),
    'payments', (select coalesce(jsonb_agg(x order by (x->>'revenue')::int desc), '[]') from (select jsonb_build_object('payment', payment, 'orders', count(*),
                 'revenue', sum(total)) x from ok group by payment) s),
    'couriers', (select coalesce(jsonb_agg(x order by (x->>'deliveries')::int desc), '[]') from (select jsonb_build_object('name', c.name,
                 'deliveries', count(ok.id), 'fees', coalesce(sum(ok.fee), 0)) x from couriers c left join ok on ok.courier_id = c.id and ok.status = 'entregue'
                 where c.tenant_id = p_tenant group by c.id, c.name) s)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Equipe e assinatura (dono da empresa)
-- ---------------------------------------------------------------------
create function public.list_team(p_tenant uuid) returns table (user_id uuid, email text, role text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  return query select m.user_id, u.email::text, m.role from memberships m join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant order by m.created_at;
end $$;

create function public.add_staff(p_tenant uuid, p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'Essa pessoa ainda não tem conta. Peça para ela criar uma em /entrar e tente de novo.'; end if;
  insert into memberships (tenant_id, user_id, role) values (p_tenant, v_user, 'staff') on conflict do nothing;
end $$;

create function public.remove_staff(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  delete from memberships where tenant_id = p_tenant and user_id = p_user and role = 'staff';
end $$;

create function public.change_plan(p_tenant uuid, p_plan text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if not exists (select 1 from plans where name = p_plan) then raise exception 'Plano inválido'; end if;
  update tenants set plan = p_plan where id = p_tenant;
end $$;

-- ---------------------------------------------------------------------
-- Plataforma (dono do SaaS)
-- ---------------------------------------------------------------------
create function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  with t as (
    select t.*, s.name segment_name,
      (select count(*) from orders o where o.tenant_id = t.id) n_orders,
      (select coalesce(sum(total), 0) from orders o where o.tenant_id = t.id and o.status <> 'cancelado') revenue,
      (select u.email from memberships m join auth.users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1) owner_email
    from tenants t join segment_templates s on s.segment = t.segment)
  select jsonb_build_object(
    'mrr', (select coalesce(sum(p.price), 0) from t join plans p on p.name = t.plan where t.active),
    'gmv', (select coalesce(sum(revenue), 0) from t),
    'orders', (select coalesce(sum(n_orders), 0) from t),
    'tenants', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'segment', segment, 'segmentName', segment_name,
                 'color', color, 'plan', plan, 'active', active, 'orders', n_orders, 'revenue', revenue, 'ownerEmail', owner_email, 'createdAt', created_at)
                 order by created_at), '[]') from t)) into r;
  return r;
end $$;

create function public.platform_update_tenant(p_tenant uuid, p_plan text default null, p_active boolean default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  if p_plan is not null and not exists (select 1 from plans where name = p_plan) then raise exception 'Plano inválido'; end if;
  update tenants set plan = coalesce(p_plan, plan), active = coalesce(p_active, active) where id = p_tenant;
end $$;

-- ---------------------------------------------------------------------
-- Pedidos de exemplo (para testar a loja recém-criada)
-- ---------------------------------------------------------------------
create function public.generate_demo_orders(p_tenant uuid, p_count int default 12) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tenants; o orders; v_prods bigint[]; v_zones bigint[]; v_cour bigint[]; v_items jsonb; v_pid bigint; v_opts jsonb;
  v_final text; v_at timestamptz; v_st text; v_pickup boolean; v_n int := least(greatest(p_count, 1), 40); i int; k int;
  v_names text[] := array['Ana Souza','Bruno Lima','Camila Reis','Diego Alves','Elisa Prado','Fábio Nunes','Gabi Torres','Hugo Melo','Iara Costa','João Pires','Karen Dias','Lucas Rocha'];
  v_flow text[] := array['entregue','entregue','entregue','entregue','entregue','entregue','entregue','cancelado','rota','pronto','preparo','novo'];
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if not exists (select 1 from couriers where tenant_id = p_tenant) then
    insert into couriers (tenant_id, name, phone) values (p_tenant, 'Carlos', '(11) 98888-1001'), (p_tenant, 'Juliana', '(11) 98888-1002');
  end if;
  select array_agg(id order by sort, id) into v_prods from products where tenant_id = p_tenant and available;
  select array_agg(id order by id) into v_zones from zones where tenant_id = p_tenant;
  select array_agg(id order by id) into v_cour from couriers where tenant_id = p_tenant and active;
  if v_prods is null or v_zones is null or v_cour is null then raise exception 'Cadastre produtos, bairros e um entregador ativo antes'; end if;
  for i in 0 .. v_n - 1 loop
    v_items := '[]';
    for k in 0 .. (i % 2) + case when t.segment = 'mercado' then 2 else 0 end loop
      v_pid := v_prods[1 + ((i + k * 3) % cardinality(v_prods))];
      select coalesce(jsonb_agg(op.id), '[]') into v_opts from option_groups g
        cross join lateral (select id from options where group_id = g.id order by sort, id offset (i % (select count(*) from options where group_id = g.id)) limit g.min_sel) op
        where g.product_id = v_pid and g.min_sel > 0;
      v_items := v_items || jsonb_build_object('productId', v_pid, 'qty', 1 + (i % 4 / 3), 'optionIds', v_opts);
    end loop;
    v_pickup := t.allow_pickup and i % 5 = 4;
    o := _create_order(t, jsonb_build_object('customer', jsonb_build_object('name', v_names[1 + i % 12], 'phone', '(11) 9' || (8100 + i * 37) || '-' || (1000 + i * 91)),
      'fulfillment', case when v_pickup then 'pickup' else 'delivery' end, 'zoneId', v_zones[1 + i % cardinality(v_zones)],
      'address', 'Rua das Flores, ' || (100 + i * 13), 'payment', (array['Pix','Cartão na entrega','Dinheiro'])[1 + i % 3], 'items', v_items), false);
    v_at := now() - make_interval(mins => (v_n - i) * 23 + 5);
    update orders set created_at = v_at, updated_at = v_at where id = o.id;
    update order_events set at = v_at where order_id = o.id;
    v_final := coalesce(v_flow[12 - v_n + i + 1], 'entregue');
    if v_pickup and v_final = 'rota' then v_final := 'pronto'; end if;
    v_st := 'novo';
    while v_st <> v_final loop
      v_st := case when v_final = 'cancelado' then 'cancelado'
                   when v_st = 'novo' then 'preparo' when v_st = 'preparo' then 'pronto'
                   when v_st = 'pronto' then case when v_pickup then 'entregue' else 'rota' end else 'entregue' end;
      v_at := least(now(), v_at + make_interval(mins => case v_st when 'pronto' then 14 when 'entregue' then 16 else 4 end));
      update orders set status = v_st, updated_at = v_at, courier_id = case when v_st = 'rota' then v_cour[1 + i % cardinality(v_cour)] else courier_id end where id = o.id;
      insert into order_events (order_id, tenant_id, status, at) values (o.id, p_tenant, v_st, v_at);
    end loop;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Segurança: RLS + privilégios mínimos
-- ---------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.segment_templates enable row level security;
alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.platform_admins enable row level security;
alter table public.products enable row level security;
alter table public.option_groups enable row level security;
alter table public.options enable row level security;
alter table public.zones enable row level security;
alter table public.coupons enable row level security;
alter table public.couriers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;

-- Tira tudo e concede só o necessário (o Supabase dá acesso amplo por padrão)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select on public.plans, public.segment_templates, public.tenants, public.products, public.option_groups, public.options, public.zones to anon, authenticated;
grant select on public.memberships, public.platform_admins, public.coupons, public.couriers, public.orders, public.order_items, public.order_events to authenticated;
grant update (name, color, min_order, is_open, allow_pickup, eta_text, phone) on public.tenants to authenticated;
grant insert, delete on public.zones, public.coupons, public.couriers to authenticated;
grant update (name, fee) on public.zones to authenticated;
grant update (code, percent, free_shipping, active) on public.coupons to authenticated;
grant update (name, phone, active) on public.couriers to authenticated;
grant delete on public.products to authenticated;

grant execute on function public.is_platform_admin(), public.my_role(uuid), public.is_member(uuid), public.is_owner(uuid), public.tenant_is_public(uuid) to anon, authenticated;
grant execute on function public.place_order(text, jsonb), public.check_coupon(text, text), public.track_order(text) to anon, authenticated;
grant execute on function public.create_my_tenant(text, text, text, text), public.save_product(uuid, bigint, jsonb), public.set_product_availability(bigint, boolean),
  public.change_order_status(bigint, text, bigint), public.store_report(uuid, int), public.list_team(uuid), public.add_staff(uuid, text),
  public.remove_staff(uuid, uuid), public.change_plan(uuid, text), public.platform_overview(), public.platform_update_tenant(uuid, text, boolean),
  public.generate_demo_orders(uuid, int) to authenticated;

create policy "catálogo público" on public.plans for select using (true);
create policy "modelos públicos" on public.segment_templates for select using (true);

create policy "ler empresa" on public.tenants for select using (active or is_member(id) or is_platform_admin());
create policy "dono edita empresa" on public.tenants for update using (is_owner(id)) with check (is_owner(id));

create policy "ver vínculos" on public.memberships for select using (user_id = auth.uid() or is_owner(tenant_id) or is_platform_admin());
create policy "ver próprio admin" on public.platform_admins for select using (user_id = auth.uid());

create policy "ler cardápio" on public.products for select using (tenant_is_public(tenant_id) or is_member(tenant_id));
create policy "dono apaga produto" on public.products for delete using (is_owner(tenant_id));
create policy "ler grupos" on public.option_groups for select using (tenant_is_public(tenant_id) or is_member(tenant_id));
create policy "ler opções" on public.options for select using (tenant_is_public(tenant_id) or is_member(tenant_id));

create policy "ler bairros" on public.zones for select using (tenant_is_public(tenant_id) or is_member(tenant_id));
create policy "dono cria bairro" on public.zones for insert with check (is_owner(tenant_id));
create policy "dono edita bairro" on public.zones for update using (is_owner(tenant_id)) with check (is_owner(tenant_id));
create policy "dono apaga bairro" on public.zones for delete using (is_owner(tenant_id));

create policy "equipe vê cupons" on public.coupons for select using (is_member(tenant_id));
create policy "dono cria cupom" on public.coupons for insert with check (is_owner(tenant_id));
create policy "dono edita cupom" on public.coupons for update using (is_owner(tenant_id)) with check (is_owner(tenant_id));
create policy "dono apaga cupom" on public.coupons for delete using (is_owner(tenant_id));

create policy "equipe vê entregadores" on public.couriers for select using (is_member(tenant_id));
create policy "dono cria entregador" on public.couriers for insert with check (is_owner(tenant_id));
create policy "equipe edita entregador" on public.couriers for update using (is_member(tenant_id)) with check (is_member(tenant_id));
create policy "dono apaga entregador" on public.couriers for delete using (is_owner(tenant_id));

create policy "equipe vê pedidos" on public.orders for select using (is_member(tenant_id));
create policy "equipe vê itens" on public.order_items for select using (is_member(tenant_id));
create policy "equipe vê eventos" on public.order_events for select using (is_member(tenant_id));

-- ---------------------------------------------------------------------
-- Tempo real: o painel recebe pedidos novos e mudanças de status na hora
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.orders;
