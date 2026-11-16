// Teste de carga SÓ DE LEITURA contra o seu Supabase de verdade (não cria pedidos nem altera nada).
// Simula clientes abrindo a loja: dados da loja, cardápio com opções e bairros, como o site faz.
//
// Uso:  node scripts/carga.mjs <slug-da-loja> [clientes=20] [segundos=30]
// Ex.:  node scripts/carga.mjs pizzaria-philpes 30 60
//
// Lê SUPABASE_URL e a Publishable key de public/config.js. Rode fora do horário de pico da loja.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../public/config.js';

const [slug, clients = '20', seconds = '30'] = process.argv.slice(2);
if (!slug) { console.log('Uso: node scripts/carga.mjs <slug-da-loja> [clientes] [segundos]'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
const api = p => fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }).then(async r => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); });

const store = (await api(`tenants?select=id,name&slug=eq.${encodeURIComponent(slug)}`))[0];
if (!store) { console.log('Loja não encontrada:', slug); process.exit(1); }
const visit = () => Promise.all([
  api(`tenants?select=id,name,color,hours,min_order,is_open&slug=eq.${encodeURIComponent(slug)}`),
  api(`products?select=id,name,price,option_groups(id,name,options(id,name,price))&tenant_id=eq.${store.id}`),
  api(`zones?select=id,name,fee&tenant_id=eq.${store.id}`)
]);

const lat = [], errors = {}; let done = 0;
const end = Date.now() + Number(seconds) * 1000;
console.log(`Loja "${store.name}": ${clients} clientes simultâneos por ${seconds}s...`);
await Promise.all(Array.from({ length: Number(clients) }, async () => {
  while (Date.now() < end) {
    const t = performance.now();
    try { await visit(); lat.push(performance.now() - t); done++; }
    catch (e) { const k = String(e.message).slice(0, 60); errors[k] = (errors[k] || 0) + 1; }
  }
}));
lat.sort((a, b) => a - b);
const pct = p => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]) : '-';
console.log(`Visitas completas: ${done} (${(done / Number(seconds)).toFixed(1)} por segundo)`);
console.log(`Tempo de resposta: mediana ${pct(0.5)} ms · 95% ${pct(0.95)} ms · 99% ${pct(0.99)} ms · pior ${pct(1)} ms`);
console.log(Object.keys(errors).length ? 'Erros:' : 'Erros: nenhum', Object.keys(errors).length ? errors : '');
