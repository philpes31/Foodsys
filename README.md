# Mesa Viva — Next.js + PostgreSQL (Supabase)

Gestão multi-tenant para restaurantes e pizzarias. Publicação: veja `DEPLOY.md`.

## Estrutura
```
db/migrations/0001_init.sql     # esquema completo + RLS + funções + planos
scripts/migrate.mjs             # aplica as migrações (npm run migrate)
.github/workflows/migrate.yml   # aplica migrações novas ao dar push na main
src/
  middleware.ts                 # exige cookie de sessão
  lib/{db,auth,tenant,mail,format}.ts
  app/(auth)/                   # login, cadastro, recuperar e redefinir senha
  app/(app)/{painel,pedidos,cardapio}/
  app/m/[slug]/                 # cardápio público (link por loja)
```

## Como funciona o isolamento entre lojas
- Toda tabela operacional tem `tenant_id` e **RLS**. A aplicação conecta como dono do banco, mas executa cada requisição dentro de uma transação com `set local role app_auth` e `app.user_id = <usuário>` (`src/lib/db.ts`). Sem isso, o dono do banco ignoraria a RLS.
- `is_member`, `has_role` e `has_perm` leem `memberships`. Conta **bloqueada** perde acesso a tudo.
- Visitantes do cardápio rodam como `app_anon`: só chamam `public_menu` e `public_create_order`, que recalculam preço, taxa e total no banco.
- As tabelas `users`, `sessions`, `password_resets` e `login_attempts` não são acessíveis a `app_auth` nem `app_anon`.

## Teste obrigatório de isolamento
Crie duas lojas (duas contas) e rode no banco:
```sql
begin;
set local role app_auth;
select set_config('app.user_id', '<ID-DO-USUARIO-DA-LOJA-A>', true);
select count(*) from orders where tenant_id = '<ID-DA-LOJA-B>';   -- deve ser 0
rollback;
```
(O id do usuário está em `users`; o da loja, em `memberships`/`tenants`.)

## Pendências conhecidas
- Pagamento online: criar `src/app/api/webhooks/[gateway]/route.ts` que valide a assinatura do gateway e chame `select confirm_payment(...)` pela conexão privilegiada (`admin`). A função é idempotente.
- Limitar pedidos do cardápio público (rate limit por IP, ex.: Vercel Firewall ou Upstash).
- Imagens de produtos: o Supabase Storage saiu; use Cloudflare R2, S3 ou Vercel Blob.
- Confirmação de e-mail no cadastro.
- Módulos ainda sem tela: clientes, entregas, financeiro, estoque, relatórios, usuários/permissões e painel do super administrador (o banco já tem as tabelas e regras).
- Impressão por setor: agente local que consulta `orders` e imprime por `printers.sector`.

## Módulos prontos (atualização)
Painel, Pedidos (Kanban + entregador), Cardápio, Clientes, Entregas (zonas, entregadores, histórico),
Estoque (insumos, movimentações, receitas com baixa automática) e Financeiro (caixa, sangria,
suprimento, contas a pagar/receber, lucro estimado). O menu lateral mostra só o que o perfil pode usar;
a proteção real continua sendo a RLS do banco.

## Módulos adicionados nesta etapa
- **Painel SaaS** (`/saas`, só super administrador): MRR, lojas por situação, troca de plano/status, +7 dias de teste,
  limites por plano, mensalidades (gerar, marcar paga/atrasada), crescimento e chamados de suporte.
- **Usuários e permissões** (`/usuarios`, proprietário/administrador): equipe, perfis, senha, ativar/desativar e
  matriz de permissões por perfil. O limite de usuários do plano é aplicado ao cadastrar.
- **Relatórios** (`/relatorios`): filtro por período, comparativo com o período anterior, vendas por produto,
  categoria, pagamento, horário, clientes, entregadores e margem; exportação CSV (abre no Excel) e impressão/PDF.
- **Configurações** (`/configuracoes`): nome, cor da marca, momento da baixa de estoque e QR Code do cardápio.

Rode também `db/migrations/0003_saas_users.sql` (funções do painel SaaS e da equipe).

## Pix online (Mercado Pago) e segurança do cardápio público
- Cada loja cola o **Access Token** da própria conta em *Configurações*. Ele é guardado criptografado (AES-256-GCM) com a
  chave `APP_ENCRYPTION_KEY`, definida só na Vercel.
- No cardápio digital aparece **Pix online**: o servidor cria a cobrança, mostra o QR Code e aguarda a confirmação.
- O webhook (`/api/webhooks/mercadopago`) **nunca confia no corpo da requisição**: consulta o pagamento na API do Mercado Pago
  com o token da loja, confere valor e referência e chama `confirm_payment` (idempotente: o mesmo evento não confirma duas vezes).
- `MP_WEBHOOK_SECRET` (opcional) liga a validação de assinatura. Teste com um Pix real de valor baixo antes de ativar.
- Limites de requisição (tabela `rate_limits`): 6 pedidos / 10 min por IP, 300 pedidos / hora por loja e 5 cadastros / hora por IP.
- Ainda **não** tratado: estorno/chargeback pelo webhook, cartão online, Asaas e PagBank.

Rode também `db/migrations/0004_payments_ratelimit.sql`.

## Impressão por setor (comandas)
Cada produto tem um **setor de preparo** (Cozinha, Bar ou Balcão). No Kanban, cada pedido tem os botões
🖨 Cozinha / Bar / Balcão (só os itens do setor, em letra grande, com observações) e Comprovante (com valores).
A impressora é escolhida na janela de impressão do navegador (papel térmico de 80 mm). Impressão automática,
sem clicar, exige um agente local e ainda não existe.

Rode também `db/migrations/0005_print_sector.sql` (coluna de setor e correção do pedido público).

## Combos e promoções
- **Combos:** preço fechado para um conjunto de produtos; aparecem no cardápio digital e no pedido manual. A composição vai no nome
  do item (a cozinha vê) e o estoque baixa a receita de cada produto do combo.
- **Promoção:** percentual (1–90%) por produto, aplicado ao preço de cada tamanho. No meio a meio vale a promoção do primeiro sabor.
- **Estoque no meio a meio:** cada sabor baixa a sua receita na proporção (1/2 cada).
- Comandas de setor mostram um combo inteiro na cozinha; o bar não vê as bebidas de um combo.

Rode também `db/migrations/0006_combos_promos.sql`.
