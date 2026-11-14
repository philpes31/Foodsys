# Balcão — SaaS de delivery para qualquer negócio (Supabase)

Plataforma multiempresa de pedidos online e delivery para pizzaria, hamburgueria, açaiteria, mercado, farmácia ou qualquer negócio que venda por entrega.

- **Supabase** guarda tudo: banco Postgres, login (Supabase Auth), tempo real (Realtime) e regras de segurança (RLS).
- **O site** são só arquivos estáticos em `public/` (HTML, CSS e JS puro, sem build). Hospede de graça na Vercel, na Netlify ou no Cloudflare Pages.
- **Não há servidor próprio para manter.** Toda regra que importa (preço do pedido, permissões, fluxo de status) roda dentro do banco.

## Colocar no ar (cerca de 10 minutos)

### 1. Criar o banco no Supabase
1. Crie um projeto em [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query** e rode, **nesta ordem**, cada arquivo de `supabase/migrations/` (cole o conteúdo inteiro e clique em **Run**):
   1. `20261113000000_balcao.sql` (tabelas, segurança e funções)
   2. `20261114000000_horarios_fotos.sql` (horário automático e fotos dos produtos)
   3. `20261115000000_pix_online.sql` (Pix online pelo Mercado Pago)
   4. `20261116000000_assinaturas.sql` (assinatura mensal das lojas)
   5. `20261117000000_entregador_clientes_lgpd.sql` (página do entregador, clientes e LGPD)
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
| Cliente final | `/loja/<endereço>` | Vê se a loja está aberta (e quando abre), preenche o endereço pelo CEP, monta o pedido com opções (tamanho, meio a meio, adicionais, complementos), escolhe entrega por bairro ou retirada, usa cupom, escolhe Pix, cartão ou dinheiro com troco e acompanha o pedido em `/pedido/<código>`. Não precisa de conta. |
| Dono da empresa | `/entrar/cadastro` e depois `/comecar` | Cria a conta e a loja escolhendo o segmento. O sistema já cria cardápio de exemplo, bairros e cupons, e há um botão para gerar pedidos de exemplo. |
| Dono da empresa | `/painel` | Fila de preparo em tempo real com aviso sonoro e impressão de comanda (impressora térmica 80 mm), entregas com mensagem pronta no WhatsApp para cliente e entregador (com link do mapa), cardápio com fotos e grupos de opções, horário de funcionamento automático, relatórios, equipe e plano. |
| Atendente | `/painel` | Opera pedidos e entregas e marca itens esgotados. O dono adiciona o atendente pelo e-mail, depois que ele cria uma conta. |
| Dono da plataforma | `/plataforma` | Vê a receita recorrente (MRR), o volume vendido e os pedidos de todas as empresas. Muda planos e suspende ou reativa empresas. |

## Segurança (no banco, não no navegador)

- **RLS em todas as tabelas.** Cada empresa só vê os próprios pedidos, cupons, entregadores e equipe. O público só lê o cardápio, os bairros e o nome das lojas ativas.
- **O pedido é criado pela função `place_order`.** Ela recalcula preço, opções, taxa e desconto a partir do cardápio, valida o mínimo e o máximo de cada grupo de opções, o pedido mínimo, se a loja está aberta e o limite do plano. O navegador não consegue gravar direto na tabela de pedidos.
- **Mudança de status só pela função `change_order_status`,** que segue o fluxo recebido → em preparo → pronto → saiu para entrega → entregue e exige um entregador ativo para despachar.
- **Plano e suspensão** só mudam pelas funções próprias. O dono não consegue alterar essas colunas direto na tabela.
- **Empresa suspensa** some da vitrine, para de receber pedidos e a equipe perde o acesso aos dados.

### 7. Ligar o Pix online (opcional, por loja)

O Pix online usa uma **Edge Function** do Supabase, a `supabase/functions/pix/index.ts`. Ela cria a cobrança no Mercado Pago e recebe a confirmação do pagamento.

1. **Publique a função.** Use um dos dois jeitos:
   - **Pelo painel:** abra **Edge Functions → Deploy a new function → Via Editor**, dê o nome `pix`, apague o código de exemplo, cole o conteúdo de `supabase/functions/pix/index.ts` e clique em **Deploy function**.
   - **Pela CLI:** `supabase functions deploy pix --no-verify-jwt`
2. **Desligue a verificação de JWT.** Na função `pix`, abra **Details / Settings** e desligue **Enforce JWT verification** ("Verify JWT"). É necessário porque o aviso do Mercado Pago chega sem login. A função confere cada pagamento direto na API do Mercado Pago, então isso não abre brecha.
3. **Confira as chaves (geralmente não precisa fazer nada).** `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já vêm prontas. Se os logs da função reclamarem da chave, crie em **Edge Functions → Secrets** um segredo chamado `SERVICE_ROLE_KEY` com a sua **Secret key** (`sb_secret_...`).
4. **Cada loja liga a própria conta.** No painel da loja, em **Configurações → Pix online**, a loja cola o **Access Token** do Mercado Pago dela e marca "Oferecer Pix agora". O guia de onde pegar o token aparece na própria tela.

**Como funciona:**
- O cliente escolhe **"Pix agora"**, informa o e-mail e recebe o QR Code com o copia e cola, válido por 30 minutos.
- O pedido fica **aguardando pagamento**: não aparece no preparo e não conta nos relatórios.
- Quando o Mercado Pago confirma, o pedido entra na fila com aviso sonoro e o selo **PAGO ONLINE**. Na mensagem do entregador sai "JÁ PAGO · não cobrar".
- Se não for pago em 45 minutos, o pedido é cancelado sozinho. Se o pagamento cair depois do prazo, o pedido volta para a fila.
- O valor cobrado vem sempre do banco, e a confirmação só vale se o valor pago for igual ao total do pedido.

**Para testar:** as credenciais de teste (`TEST-`) do Mercado Pago geram QR Codes, mas o Pix de teste não pode ser pago de verdade. O jeito mais simples é usar o token de produção com um produto de R$ 1,00 e depois devolver o valor pelo app do Mercado Pago.

### 8. Cobrar a assinatura das lojas (sua receita)

Toda loja nova ganha **14 dias grátis**. Depois disso, a loja paga a mensalidade do plano no cartão, pelo Mercado Pago, e o dinheiro cai na **sua** conta de dono da plataforma.
- Sem pagamento em dia (há **3 dias de carência**), a loja para de receber pedidos. O painel continua acessível para ela regularizar.
- Lojas que já existiam ganham 14 dias contados a partir da migração.

1. **Publique a Edge Function `billing`** do mesmo jeito que a `pix`:
   - copie o conteúdo de `supabase/functions/billing/index.ts`;
   - desligue **Enforce JWT verification**.
2. **Cadastre dois segredos** em **Edge Functions → Secrets**:
   - `MP_PLATFORM_TOKEN`: o **Access Token de produção** da **sua** conta do Mercado Pago, a que vai receber as mensalidades;
   - `SITE_URL`: o endereço do site, por exemplo `https://foodsys-cdm2.vercel.app`.
3. **Ligue os avisos do Mercado Pago:**
   - Em mercadopago.com.br/developers → **Suas integrações** → sua aplicação → **Webhooks**, cadastre a URL `https://SEU-PROJETO.supabase.co/functions/v1/billing?action=webhook`.
   - Marque os eventos de **Planos e assinaturas**.
   - Sem os avisos o sistema continua funcionando, porque confere a assinatura quando o dono volta do Mercado Pago e no botão "Atualizar status". Mas com os avisos, as cobranças mensais e os cartões recusados são registrados sozinhos.

**Como funciona:**
- **Para o dono da loja:** o painel mostra um aviso com os dias de teste restantes. Em **Configurações → Assinatura do Balcão**, ele clica em **Assinar com cartão** e paga no Mercado Pago. Se assinar durante o teste, a 1ª cobrança só acontece quando o teste termina. Trocar de plano ajusta o valor da mensalidade sozinho.
- **Para você, em `/plataforma`:** aparecem quantas lojas estão pagando e quantas estão em teste, a receita mensal real e a potencial, e o status de cada loja. Os botões **+30 dias**, **+7 dias teste** e **Grátis** servem para quem paga por fora (Pix, boleto) ou para parceiros.
- O cliente da loja bloqueada vê "Temporariamente indisponível", e o banco recusa pedidos novos.

### 9. Termos de Uso, privacidade e LGPD

As páginas `/termos` e `/privacidade` são **modelos**. Antes de vender:
1. Preencha os dados da sua empresa em `public/config.js`, no bloco `PLATFORM`: razão social, CNPJ, e-mail e cidade do foro.
2. Peça para um advogado revisar os textos, que ficam em `public/legal.js`.

O que já está pronto:
- **No cadastro:** a conta só é criada com o aceite dos termos. A versão aceita e a data ficam registradas no usuário.
- **No checkout:** aparece um aviso com o link para a política de privacidade.
- **Pedido de exclusão de dados (LGPD):** em **Clientes → Excluir dados**, a loja apaga nome, telefone e endereço de um cliente em todos os pedidos. Os valores continuam nos relatórios.
- **Retenção:** a função `anonymize_old_orders(24)` anonimiza pedidos com mais de 24 meses. Para rodar todo mês, ative a extensão **pg_cron** (Database → Extensions) e rode no SQL Editor:
  ```sql
  select cron.schedule('anonimizar-pedidos', '0 4 1 * *', $$select public.anonymize_old_orders(24)$$);
  ```
- **Exclusão da loja:** em **Configurações → Excluir loja**, o dono apaga tudo, depois de cancelar a assinatura.

## Dicas de uso

- **Impressão da comanda:** na tela de preparo, o botão **Imprimir** abre a impressão do navegador já no formato 80 mm. Escolha a impressora térmica e, nas configurações de impressão, desmarque "Cabeçalhos e rodapés". Marque **Imprimir comanda ao aceitar** para imprimir automaticamente ao aceitar o pedido. No Chrome, dá para pular a janela de impressão abrindo o navegador com `--kiosk-printing`.
- **Entregador:** em **Configurações → Entregadores → Enviar link**, cada entregador recebe pelo WhatsApp um link próprio. Ele abre no celular, sem senha, e mostra as entregas dele com endereço, valor a cobrar ou "já pago", e os botões de mapa, WhatsApp, ligar e **Entreguei**. **Novo link** desativa o anterior (use quando um entregador sair).
- **Clientes:** a aba **Clientes** lista quem já pediu, com número de pedidos, total gasto e último pedido. Clientes que não pedem há mais de 30 dias aparecem como "sumido", e um botão de WhatsApp manda uma mensagem pronta para chamar de volta. Dá para baixar a lista em planilha (CSV).
- **WhatsApp:** os botões abrem o WhatsApp Web ou o app com a mensagem pronta (aceito, pronto, saiu para entrega...) e o link de acompanhamento. Basta tocar em enviar.
- **Horário:** com "Abrir e fechar sozinha" ligado, a loja só aceita pedidos dentro dos horários. O banco confere isso, não só a tela. O checkbox "Receber pedidos" pausa a loja na hora, mesmo dentro do horário.

## Testes

`test/db.test.js` aplica a migração num Postgres 16 comum, com uma simulação mínima do `auth` do Supabase (`test/supabase-shim.sql`). Os 39 testes (banco e Edge Functions com Mercado Pago simulado) cobrem:
- isolamento entre empresas;
- permissões de dono, atendente e anônimo;
- cálculo de preço com opções e cupom;
- fluxo de status, limites do plano, editor de produto e relatórios;
- horário automático (inclusive passando da meia-noite) e permissões das fotos no Storage;
- Pix online: token protegido, valor conferido, webhook reconferido na API, expiração e pagamento atrasado;
- assinatura: teste grátis, carência, bloqueio de pedidos, só o dono assina, avisos reconferidos na API;
- link do entregador, lista de clientes, exclusão de dados (LGPD), retenção e exclusão da loja.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres npm test
```

## Estrutura

```
supabase/migrations/   esquema, RLS, funções e modelos por segmento (rodar em ordem)
supabase/functions/pix      Edge Function do Pix dos pedidos (conta de cada loja)
supabase/functions/billing  Edge Function da assinatura das lojas (sua conta)
public/                site estático: index.html, style.css, app.js, config.js
scripts/serve.js       servidor local de desenvolvimento
test/                  testes do banco e simulação do auth do Supabase
vercel.json, netlify.toml   rotas para hospedagem estática
```

Valores em dinheiro são inteiros em **centavos**.

## Próximos passos sugeridos

- **Cartão de crédito online** (Checkout do Mercado Pago) usando a mesma função de pagamentos.
- **WhatsApp a cada mudança de status:** um Database Webhook ou uma Edge Function chamando a API do WhatsApp.
- **Taxa de entrega por distância** (raio em km a partir da loja).
- **Programa de fidelidade** sobre a aba Clientes (ex.: a cada 10 pedidos, um cupom).
