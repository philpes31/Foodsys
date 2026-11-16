\set n random(1, 30)
begin;
set local role anon;
select json_build_object('id', id, 'name', name, 'color', color, 'hours', hours, 'min_order', min_order) from tenants t where slug = 'loja-' || :n;
select json_agg(p) from (select p.*, (select json_agg(g) from (select g.*, (select json_agg(o) from options o where o.group_id = g.id) options from option_groups g where g.product_id = p.id) g) groups from products p where p.tenant_id = (select id from tenants where slug = 'loja-' || :n)) p;
select json_agg(z) from zones z where z.tenant_id = (select id from tenants where slug = 'loja-' || :n);
commit;
