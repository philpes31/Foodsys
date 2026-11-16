\set n random(1, 30)
begin;
select set_config('request.jwt.claim.sub', user_id::text, true) from bench_owners where n = :n;
set local role authenticated;
select json_agg(o) from (select o.*, (select json_agg(i) from order_items i where i.order_id = o.id) items from orders o where o.tenant_id = (select tenant_id from bench_owners where n = :n) and o.status in ('novo', 'preparo', 'pronto') order by created_at) o;
commit;
