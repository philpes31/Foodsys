-- =====================================================================
-- Balcão — página do entregador, clientes da loja e LGPD
-- Rode depois de 20261116000000_assinaturas.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Página do entregador: cada entregador tem um link secreto (sem senha), que a loja pode trocar a qualquer momento
-- ---------------------------------------------------------------------
create function public.new_secret() returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

alter table public.couriers add column access_token text not null default public.new_secret();
create unique index on public.couriers (access_token);
-- o token não é lido pela API comum: a equipe pega o link pela função courier_link
revoke select on public.couriers from authenticated;
grant select (id, tenant_id, name, phone, active) on public.couriers to authenticated;

create function public.courier_link(p_courier bigint, p_rotate boolean default false) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare c couriers;
begin
  select * into c from couriers where id = p_courier;
  if not found or not is_owner(c.tenant_id) then raise exception 'Sem permissão'; end if;
  if p_rotate then update couriers set access_token = new_secret() where id = c.id returning * into c; end if;
  return c.access_token;
end $$;

create function public.courier_portal(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'courier', jsonb_build_object('name', c.name, 'active', c.active),
    'store', jsonb_build_object('name', t.name, 'color', t.color, 'phone', t.phone),
    'deliveries', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'customerName', o.customer_name,
        'customerPhone', o.customer_phone, 'address', o.address, 'zone', o.zone_name, 'payment', o.payment, 'paid', o.payment_status = 'paid',
        'total', o.total, 'changeFor', o.change_for, 'since', o.updated_at,
        'items', (select coalesce(jsonb_agg(i.qty || 'x ' || i.product_name order by i.id), '[]') from order_items i where i.order_id = o.id))
        order by o.updated_at), '[]')
      from orders o where o.courier_id = c.id and o.status = 'rota'),
    'today', (select jsonb_build_object('deliveries', count(*), 'fees', coalesce(sum(o.fee), 0))
      from orders o where o.courier_id = c.id and o.status = 'entregue'
        and o.updated_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone))
  from couriers c join tenants t on t.id = c.tenant_id
  where c.access_token = p_token and length(p_token) >= 32 and t.active
$$;

create function public.courier_deliver(p_token text, p_order bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c couriers; o orders;
begin
  select * into c from couriers where access_token = p_token and length(p_token) >= 32;
  if not found then raise exception 'Link inválido. Peça um novo para a loja.'; end if;
  select * into o from orders where id = p_order and courier_id = c.id and status = 'rota' for update;
  if not found then raise exception 'Entrega não encontrada'; end if;
  update orders set status = 'entregue', updated_at = now() where id = o.id;
  insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'entregue');
end $$;

-- ---------------------------------------------------------------------
-- Clientes da loja (montado a partir dos pedidos, agrupado pelo telefone)
-- ---------------------------------------------------------------------
create function public.phone_key(p text) returns text language sql immutable as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 11)
$$;

create function public.store_customers(p_tenant uuid, p_search text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb; v_s text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  with c as (
    select phone_key(customer_phone) k,
      (array_agg(customer_name order by created_at desc))[1] name,
      (array_agg(customer_phone order by created_at desc))[1] phone,
      (array_agg(address order by created_at desc) filter (where address <> ''))[1] address,
      count(*) filter (where status not in ('cancelado', 'pagamento')) orders,
      coalesce(sum(total) filter (where status not in ('cancelado', 'pagamento')), 0) spent,
      max(created_at) last_order, min(created_at) first_order
    from orders where tenant_id = p_tenant and customer_phone <> 'removido'
    group by phone_key(customer_phone))
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'name', name, 'phone', phone, 'address', address, 'orders', orders,
      'spent', spent, 'lastOrder', last_order, 'firstOrder', first_order) order by last_order desc), '[]') into r
  from (select * from c
        where v_s is null or name ilike '%' || v_s || '%' or k like '%' || regexp_replace(v_s, '\D', '', 'g') || '%' and regexp_replace(v_s, '\D', '', 'g') <> ''
        order by last_order desc limit least(greatest(p_limit, 1), 1000)) x;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- LGPD
-- ---------------------------------------------------------------------
-- Pedido de exclusão de dados de um cliente: apaga nome, telefone e endereço; o pedido continua nos relatórios sem identificar ninguém.
create function public.anonymize_customer(p_tenant uuid, p_phone text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_k text := phone_key(p_phone);
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if length(v_k) < 8 then raise exception 'Telefone inválido'; end if;
  update orders set customer_name = 'Cliente removido', customer_phone = 'removido', address = case when address <> '' then 'removido' else '' end
  where tenant_id = p_tenant and phone_key(customer_phone) = v_k;
  get diagnostics n = row_count;
  return n;
end $$;

-- Retenção: anonimiza pedidos antigos de todas as lojas (agende com pg_cron, ex.: todo mês, 24 meses)
create function public.anonymize_old_orders(p_months int default 24) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  -- liberado para o dono da plataforma, a chave de serviço e o próprio banco (SQL Editor / pg_cron)
  if not (is_platform_admin() or coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated')) then raise exception 'Sem permissão'; end if;
  update orders set customer_name = 'Cliente removido', customer_phone = 'removido', address = case when address <> '' then 'removido' else '' end
  where created_at < now() - make_interval(months => greatest(p_months, 6)) and customer_phone <> 'removido';
  get diagnostics n = row_count;
  return n;
end $$;

-- Encerrar a conta da loja: apaga a empresa e tudo dela (pedidos, cardápio, equipe...). Não tem volta.
create function public.delete_my_tenant(p_tenant uuid, p_confirm_slug text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if t.slug <> trim(coalesce(p_confirm_slug, '')) then raise exception 'Digite o endereço da loja (%) para confirmar', t.slug; end if;
  if t.billing_status = 'active' then raise exception 'Cancele a assinatura antes de excluir a loja'; end if;
  delete from tenants where id = p_tenant;
end $$;

revoke execute on function public.new_secret(), public.phone_key(text) from public, anon;
revoke execute on function public.courier_link(bigint, boolean), public.store_customers(uuid, text, int), public.anonymize_customer(uuid, text),
  public.anonymize_old_orders(int), public.delete_my_tenant(uuid, text) from public, anon;
grant execute on function public.courier_link(bigint, boolean), public.store_customers(uuid, text, int), public.anonymize_customer(uuid, text),
  public.anonymize_old_orders(int), public.delete_my_tenant(uuid, text) to authenticated;
grant execute on function public.anonymize_old_orders(int) to service_role;
grant execute on function public.courier_portal(text), public.courier_deliver(text, bigint) to anon, authenticated;
