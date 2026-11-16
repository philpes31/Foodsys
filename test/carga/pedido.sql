\set n random(1, :np)
\set ph random(10000000, 99999999)
begin;
set local role anon;
select place_order(b.slug, jsonb_build_object('customer', jsonb_build_object('name', 'Cliente Carga', 'phone', '119' || :ph), 'fulfillment', 'pickup', 'payment', 'Dinheiro', 'items', jsonb_build_array(jsonb_build_object('productId', b.product_id, 'qty', 2)))) from bench_products b where b.n = :n;
commit;
