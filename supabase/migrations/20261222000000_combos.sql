-- 40. Combos montados com produtos do cardápio
-- Uma opção de um grupo pode apontar para um produto de verdade (ex.: no combo "Pizza + refri", a opção
-- "Coca-Cola 2L" aponta para o produto Coca-Cola 2L). Assim o combo:
--   * baixa o estoque e a ficha técnica dos produtos escolhidos (e devolve se o pedido for cancelado);
--   * não deixa escolher um item que está esgotado ou desligado;
--   * mostra na loja quanto o cliente economiza em relação aos itens avulsos.
-- As alterações nas funções existentes são feitas por troca de trecho conferida (funciona em qualquer cópia do banco).
-- Pode rodar mais de uma vez.

alter table public.options add column if not exists product_id bigint references public.products(id) on delete set null;
create index if not exists options_product on public.options (product_id) where product_id is not null;
alter table public.order_items add column if not exists combo_products bigint[];

do $patch$
declare d text; n text;
  -- troca um trecho exato; se não achar (e não estiver já trocado), para tudo
  procedure_dummy int;
begin
  ------------------------------------------------------------------ _validate_product: guarda o produto ligado
  d := replace(pg_get_functiondef('public._validate_product'::regproc), E'\r\n', E'\n');
  if position('productId' in d) = 0 then
    n := replace(d, $a$      v_opts := v_opts || jsonb_build_object('name', left(trim(o->>'name'), 60), 'price', (o->>'price')::int);$a$,
$b$      if nullif(o->>'productId', '') is not null and o->>'productId' !~ '^\d{1,18}$' then raise exception 'Opção inválida no grupo "%"', v_name; end if;
      v_opts := v_opts || (jsonb_build_object('name', left(trim(o->>'name'), 60), 'price', (o->>'price')::int)
        || case when nullif(o->>'productId', '') is not null then jsonb_build_object('productId', (o->>'productId')::bigint) else '{}'::jsonb end);$b$);
    if n = d then raise exception 'combos: _validate_product não encontrou o trecho'; end if;
    execute n;
  end if;

  ------------------------------------------------------------------ _write_groups: grava o produto ligado (da mesma loja)
  d := replace(pg_get_functiondef('public._write_groups'::regproc), E'\r\n', E'\n');
  if position('productId' in d) = 0 then
    n := replace(d, $a$      insert into options (group_id, tenant_id, name, price, sort) values (v_gid, p_tenant, o->>'name', (o->>'price')::int, oi);$a$,
$b$      if nullif(o->>'productId', '') is not null and not exists (select 1 from products where id = (o->>'productId')::bigint and tenant_id = p_tenant and id <> p_product) then
        raise exception 'O item "%" do combo não é um produto desta loja', o->>'name';
      end if;
      insert into options (group_id, tenant_id, name, price, sort, product_id)
        values (v_gid, p_tenant, o->>'name', (o->>'price')::int, oi, nullif(o->>'productId', '')::bigint);$b$);
    if n = d then raise exception 'combos: _write_groups não encontrou o trecho'; end if;
    execute n;
  end if;

  ------------------------------------------------------------------ _create_order: confere e baixa os produtos do combo
  d := replace(pg_get_functiondef('public._create_order'::regproc), E'\r\n', E'\n');
  if position('v_linked' in d) = 0 then
    n := replace(d, $a$v_labels text[]; v_txt text[];$a$, $b$v_labels text[]; v_txt text[]; v_linked bigint[]; v_lp record;$b$);
    if n = d then raise exception 'combos: _create_order (declare) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$    v_unit := pr.price; v_labels := '{}'; v_txt := '{}';$a$, $b$    v_unit := pr.price; v_labels := '{}'; v_txt := '{}'; v_linked := '{}';$b$);
    if n = d then raise exception 'combos: _create_order (início do item) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$                              from options where group_id = g.id and id = any(v_chosen) order by sort, id);
    end loop;$a$, $b$                              from options where group_id = g.id and id = any(v_chosen) order by sort, id);
      v_linked := v_linked || array(select product_id from options where group_id = g.id and id = any(v_chosen) and product_id is not null order by sort, id);
    end loop;
    -- combo: cada produto escolhido precisa estar disponível e ter estoque
    for v_lp in select x.pid, count(*)::int c from unnest(v_linked) x(pid) group by x.pid loop
      select * into v_cp from products where id = v_lp.pid and tenant_id = t.id;
      if v_cp.id is null or not v_cp.available then raise exception '"%" está esgotado no momento. Escolha outro item no combo.', coalesce(v_cp.name, 'Um item do combo'); end if;
      if v_cp.stock is not null then
        update products set stock = stock - v_qty * v_lp.c where id = v_cp.id and stock >= v_qty * v_lp.c;
        if not found then raise exception 'Só restam % unidade(s) de % (no combo)', greatest(v_cp.stock, 0), v_cp.name; end if;
      end if;
    end loop;$b$);
    if n = d then raise exception 'combos: _create_order (opções) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$'option_names', to_jsonb(v_labels),$a$, $b$'option_names', to_jsonb(v_labels), 'combo_products', to_jsonb(v_linked),$b$);
    if n = d then raise exception 'combos: _create_order (item) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes, option_names)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes',
      array(select jsonb_array_elements_text(coalesce(x->'option_names', '[]')))$a$,
$b$  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes, option_names, combo_products)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes',
      array(select jsonb_array_elements_text(coalesce(x->'option_names', '[]'))),
      nullif(array(select jsonb_array_elements_text(coalesce(x->'combo_products', '[]'))::bigint), '{}')$b$);
    if n = d then raise exception 'combos: _create_order (gravação) não encontrou o trecho'; end if; d := n;
    -- variável v_cp (produto do combo)
    if position(' v_cp products;' in d) = 0 then
      n := regexp_replace(d, '\ndeclare\n', E'\ndeclare\n  v_cp products;\n');
      if n = d then raise exception 'combos: _create_order (declare v_cp) não encontrou o trecho'; end if; d := n;
    end if;
    execute d;
  end if;

  ------------------------------------------------------------------ _stock_on_status: devolve também os produtos do combo
  d := replace(pg_get_functiondef('public._stock_on_status'::regproc), E'\r\n', E'\n');
  if position('combo_products' in d) = 0 then
    n := replace(d, $a$  from (select product_id, sum(qty) q from order_items where order_id = new.id group by product_id) x$a$,
$b$  from (select product_id, sum(q) q from (
          select product_id, qty q from order_items where order_id = new.id
          union all   -- produtos escolhidos dentro de combos
          select c.pid, oi.qty from order_items oi cross join unnest(oi.combo_products) c(pid) where oi.order_id = new.id) s
        group by product_id) x$b$);
    if n = d then raise exception 'combos: _stock_on_status não encontrou o trecho'; end if;
    execute n;
  end if;

  ------------------------------------------------------------------ _ingredients_on_item: ficha técnica dos produtos do combo
  d := replace(pg_get_functiondef('public._ingredients_on_item'::regproc), E'\r\n', E'\n');
  if position('combo_products' in d) = 0 then
    n := replace(d, $a$      select pi.ingredient_id, pi.qty * new.qty q from product_ingredients pi where pi.product_id = new.product_id
      union all$a$, $b$      select pi.ingredient_id, pi.qty * new.qty q from product_ingredients pi where pi.product_id = new.product_id
      union all
      -- combo: a receita de cada produto escolhido
      select pi.ingredient_id, pi.qty * new.qty from unnest(coalesce(new.combo_products, '{}')) c(pid) join product_ingredients pi on pi.product_id = c.pid
      union all$b$);
    if n = d then raise exception 'combos: _ingredients_on_item não encontrou o trecho'; end if;
    execute n;
  end if;

  ------------------------------------------------------------------ create_unit: a cópia aponta para os produtos copiados
  d := replace(pg_get_functiondef('public.create_unit'::regproc), E'\r\n', E'\n');
  if position('product_id = (v_map' in d) = 0 then
    n := replace(d, $a$      insert into options (group_id, tenant_id, name, price, sort) select v_gid, t.id, name, price, sort from options where group_id = g.id order by sort, id;$a$,
$b$      insert into options (group_id, tenant_id, name, price, sort, product_id) select v_gid, t.id, name, price, sort, product_id from options where group_id = g.id order by sort, id;$b$);
    if n = d then raise exception 'combos: create_unit (cópia) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$  delete from zones where tenant_id = t.id;$a$, $b$  update options set product_id = (v_map->>product_id::text)::bigint where tenant_id = t.id and product_id is not null;
  delete from zones where tenant_id = t.id;$b$);
    if n = d then raise exception 'combos: create_unit (ligações) não encontrou o trecho'; end if;
    execute n;
  end if;

  ------------------------------------------------------------------ schema_status: linha 40
  d := replace(pg_get_functiondef('public.schema_status'::regproc), E'\r\n', E'\n');
  if position('20261222000000_combos.sql' in d) = 0 then
    n := regexp_replace(d, $a$(\(39, '20261221000000_search_path\.sql',.*?d\.deptype = 'e'\)\)\))$a$,
      E'\\1,\n    (40, ''20261222000000_combos.sql'',                     exists (select 1 from information_schema.columns where table_schema = ''public'' and table_name = ''options'' and column_name = ''product_id''))', 's');
    if n = d then raise exception 'combos: schema_status não encontrou o trecho'; end if;
    execute n;
  end if;
end $patch$;

notify pgrst, 'reload schema';
