# Balcão — SaaS de delivery para qualquer negócio (Supabase)

Plataforma multiempresa de pedidos online e delivery para pizzaria, hamburgueria, açaiteria, mercado, farmácia ou qualquer negócio que venda por entrega.

- **Supabase** guarda tudo: banco Postgres, login (Supabase Auth), tempo real (Realtime) e regras de segurança (RLS).
- **O site** são só arquivos estáticos em `public/` (HTML, CSS e JS puro, sem build). Hospede de graça na Vercel, na Netlify ou no Cloudflare Pages.
- **Não há servidor próprio para manter.** Toda regra que importa (preço do pedido, permissões, fluxo de status) roda dentro do banco.

## Colocar no ar (cerca de 10 minutos)

### 1. Criar o banco no Supabase
1. Crie um projeto em [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/migrations/20261113000000_balcao.sql` e clique em **Run**.
   - Se você usa a Supabase CLI: `supabase link` e depois `supabase db push`.

### 2. Configurar o login
Em **Authentication → URL Configuration**:
- **Site URL:** o endereço onde o site vai ficar, por exemplo `https://seu-app.vercel.app`.
- **Redirect URLs:** adicione `https://seu-app.vercel.app/**` e, para testar no seu computador, `http://localhost:3000/**`.

A confirmação de e-mail vem ligada por padrão, e assim é mais seguro. Para testar mais rápido, dá para desligar em **Authentication → Sign In / Providers → Email → Confirm email**.

### 3. Ligar o site ao seu projeto
Em **Project Settings → API**, copie a **Project URL** e a chave **anon public** para `public/config.js`:

```js
export const SUPABASE_URL = 'https://xxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
```

A chave anon pode ficar no site, porque ela é pública por natureza. **Nunca** use a chave `service_role` no site.

### 4. Testar no computador
```bash
npm run dev      # http://localhost:3000  (precisa só do Node 20+)
```

### 5. Publicar
- **Vercel:** importe o repositório, deixe o framework como "Other" e publique. O `vercel.json` já configura as rotas.
- **Netlify:** importe o repositório e publique. O `netlify.toml` já configura as rotas.

Depois de publicar, volte ao passo 2 e confira se o endereço final está na Site URL.

### 6. Virar administrador da plataforma
Crie sua conta pelo site em `/entrar/cadastro`. Depois rode este comando no SQL Editor, com o seu e-mail:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'seu-email@exemplo.com';
```

A partir daí, o endereço `/plataforma` mostra todas as empresas.

## Como funciona para cada perfil

| Perfil | Onde | O que faz |
|---|---|---|
| Cliente final | `/loja/<endereço>` | Monta o pedido com opções (tamanho, meio a meio, adicionais, complementos), escolhe entrega por bairro ou retirada, usa cupom, escolhe Pix, cartão ou dinheiro com troco e acompanha o pedido em `/pedido/<código>`. Não precisa de conta. |
| Dono da empresa | `/entrar/cadastro` e depois `/comecar` | Cria a conta e a loja escolhendo o segmento. O sistema já cria cardápio de exemplo, bairros e cupons, e há um botão para gerar pedidos de exemplo. |
| Dono da empresa | `/painel` | Fila de preparo em tempo real com aviso sonoro, entregas e entregadores, cardápio com editor de grupos de opções, relatórios, configurações, equipe e plano. |
| Atendente | `/painel` | Opera pedidos e entregas e marca itens esgotados. O dono adiciona o atendente pelo e-mail, depois que ele cria uma conta. |
| Dono da plataforma | `/plataforma` | Vê a receita recorrente (MRR), o volume vendido e os pedidos de todas as empresas. Muda planos e suspende ou reativa empresas. |

## Segurança (no banco, não no navegador)

- **RLS em todas as tabelas.** Cada empresa só vê os próprios pedidos, cupons, entregadores e equipe. O público só lê o cardápio, os bairros e o nome das lojas ativas.
- **O pedido é criado pela função `place_order`.** Ela recalcula preço, opções, taxa e desconto a partir do cardápio, valida o mínimo e o máximo de cada grupo de opções, o pedido mínimo, se a loja está aberta e o limite do plano. O navegador não consegue gravar direto na tabela de pedidos.
- **Mudança de status só pela função `change_order_status`,** que segue o fluxo recebido → em preparo → pronto → saiu para entrega → entregue e exige um entregador ativo para despachar.
- **Plano e suspensão** só mudam pelas funções próprias. O dono não consegue alterar essas colunas direto na tabela.
- **Empresa suspensa** some da vitrine, para de receber pedidos e a equipe perde o acesso aos dados.

## Testes

`test/db.test.js` aplica a migração num Postgres 16 comum, com uma simulação mínima do `auth` do Supabase (`test/supabase-shim.sql`). Os 12 testes cobrem:
- isolamento entre empresas;
- permissões de dono, atendente e anônimo;
- cálculo de preço com opções e cupom;
- fluxo de status, limites do plano, editor de produto e relatórios.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres npm test
```

## Estrutura

```
supabase/migrations/   esquema, RLS, funções e modelos por segmento (um arquivo SQL)
public/                site estático: index.html, style.css, app.js, config.js
scripts/serve.js       servidor local de desenvolvimento
test/                  testes do banco e simulação do auth do Supabase
vercel.json, netlify.toml   rotas para hospedagem estática
```

Valores em dinheiro são inteiros em **centavos**.

## Próximos passos sugeridos

- **Pagamento online:** Pix e cartão via Mercado Pago, Asaas ou Stripe. Uma Edge Function do Supabase recebe o webhook e só então libera o pedido para o preparo.
- **Cobrança automática da assinatura** das empresas no mesmo gateway.
- **WhatsApp a cada mudança de status:** um Database Webhook ou uma Edge Function chamando a API do WhatsApp.
- **Fotos dos produtos** com Supabase Storage.
- **Horários de funcionamento automáticos** e taxa de entrega por distância.
