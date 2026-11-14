-- =====================================================================
-- Balcão — melhorias: horário de funcionamento automático e fotos dos produtos
-- Rode depois de 20261113000000_balcao.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Horário de funcionamento
-- hours = {"0": [["18:00","23:30"]], "5": [["11:00","14:00"], ["18:00","02:00"]], ...}
-- chave = dia da semana (0 = domingo); faixas que terminam depois da meia-noite são permitidas.
-- ---------------------------------------------------------------------
create function public.valid_hours(h jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(h) = 'object' and not exists (
    select 1 from jsonb_each(h) e
    where e.key !~ '^[0-6]$' or jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) > 3
       or exists (select 1 from jsonb_array_elements(e.value) r
                  where jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2
                     or coalesce(r->>0, '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
                     or coalesce(r->>1, '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
                     or r->>0 = r->>1))
$$;

alter table public.tenants
  add column hours jsonb not null default '{}'::jsonb check (public.valid_hours(hours)),
  add column auto_hours boolean not null default false;

-- Loja aberta num instante: precisa estar "aberta" (pausa manual) e, se o horário automático estiver ligado, dentro de uma faixa.
create function public.store_open_at(t public.tenants, p_at timestamptz default now()) returns boolean
language plpgsql stable as $$
declare v_local timestamp; v_dow int; v_time time; r jsonb; o time; c time;
begin
  if not t.is_open or not t.active then return false; end if;
  if not t.auto_hours then return true; end if;
  v_local := p_at at time zone t.timezone;
  v_dow := extract(dow from v_local)::int;
  v_time := v_local::time;
  for r in select * from jsonb_array_elements(coalesce(t.hours -> v_dow::text, '[]')) loop
    o := (r->>0)::time; c := (r->>1)::time;
    if (c > o and v_time >= o and v_time < c) or (c < o and v_time >= o) then return true; end if;
  end loop;
  -- faixas de ontem que passam da meia-noite
  for r in select * from jsonb_array_elements(coalesce(t.hours -> ((v_dow + 6) % 7)::text, '[]')) loop
    o := (r->>0)::time; c := (r->>1)::time;
    if c < o and v_time < c then return true; end if;
  end loop;
  return false;
end $$;

grant update (hours, auto_hours) on public.tenants to authenticated;

-- place_order passa a respeitar o horário de funcionamento
create or replace function public.place_order(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_limit int; o orders;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  if not store_open_at(t) then raise exception 'A loja está fechada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total);
end $$;

-- ---------------------------------------------------------------------
-- Fotos dos produtos (Supabase Storage, bucket público "product-images")
-- O arquivo fica em <tenant_id>/<nome>; só o dono da empresa grava na própria pasta.
-- ---------------------------------------------------------------------
alter table public.products
  add column image_path text check (image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$');

create or replace function public._validate_product(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  g jsonb; o jsonb; v_groups jsonb := '[]'; v_opts jsonb; v_min int; v_max int; v_name text; v_img text;
begin
  if coalesce(trim(p->>'name'), '') = '' or coalesce(trim(p->>'category'), '') = '' then
    raise exception 'Produto precisa de nome e categoria';
  end if;
  if coalesce(p->>'price', '') !~ '^\d{1,7}$' then raise exception 'Preço inválido'; end if;
  v_img := nullif(p->>'image_path', '');
  if v_img is not null and v_img !~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then raise exception 'Foto inválida'; end if;
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
    'sort', coalesce((p->>'sort')::int, 0), 'image_path', v_img, 'groups', v_groups);
end $$;

create or replace function public.save_product(p_tenant uuid, p_id bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb; v_id bigint;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  v := _validate_product(p);
  if v->>'image_path' is not null and split_part(v->>'image_path', '/', 1) <> p_tenant::text then
    raise exception 'Foto inválida';
  end if;
  if p_id is null then
    insert into products (tenant_id, category, name, description, price, icon, available, image_path, sort)
    values (p_tenant, v->>'category', v->>'name', v->>'description', (v->>'price')::int, v->>'icon', (v->>'available')::boolean, v->>'image_path',
      coalesce((select max(sort) + 1 from products where tenant_id = p_tenant), 0))
    returning id into v_id;
  else
    update products set category = v->>'category', name = v->>'name', description = v->>'description', price = (v->>'price')::int,
      icon = v->>'icon', available = (v->>'available')::boolean, image_path = v->>'image_path'
    where id = p_id and tenant_id = p_tenant returning id into v_id;
    if v_id is null then raise exception 'Produto não encontrado'; end if;
  end if;
  perform _write_groups(p_tenant, v_id, v->'groups');
  return v_id;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create function public.can_manage_image(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when split_part(coalesce(p_name, ''), '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then is_owner(split_part(p_name, '/', 1)::uuid) else false end
$$;
revoke execute on function public.can_manage_image(text), public.store_open_at(public.tenants, timestamptz), public.valid_hours(jsonb) from public, anon;
grant execute on function public.can_manage_image(text) to authenticated;
grant execute on function public.valid_hours(jsonb) to authenticated;

create policy "dono envia fotos" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.can_manage_image(name));
create policy "dono troca fotos" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.can_manage_image(name))
  with check (bucket_id = 'product-images' and public.can_manage_image(name));
create policy "dono apaga fotos" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.can_manage_image(name));
