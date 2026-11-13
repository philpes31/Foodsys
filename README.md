# Balcão — SaaS de delivery para qualquer negócio

Plataforma multiempresa de pedidos online e delivery: pizzaria, hamburgueria, açaiteria, mercado, farmácia ou qualquer outro negócio que venda por entrega. Cada empresa tem sua loja online com a própria marca, fila de preparo em tempo real, despacho de entregadores, cardápio com grupos de opções e relatórios. O dono da plataforma gerencia as empresas assinantes e os planos.

**Sem dependências externas:** só Node.js 22.5 ou mais novo (usa o SQLite embutido do Node). Não precisa de `npm install`.

## Começar em 1 minuto

```bash
cp .env.example .env      # ajuste SECRET e PLATFORM_PASSWORD
npm start                 # http://localhost:3000
npm test                  # 10 testes de ponta a ponta da API
```

No primeiro start o servidor cria o banco em `data/balcao.db`, a conta do dono da plataforma e, com `SEED_DEMO=1`, quatro empresas de demonstração com pedidos simulados.

| Acesso | E-mail | Senha |
|---|---|---|
| Plataforma (dono do SaaS) | `PLATFORM_EMAIL` do `.env` | `PLATFORM_PASSWORD` do `.env` |
| Pizzaria | dono@fornodavila.demo | demo1234 |
| Hamburgueria | dono@brasaburger.demo | demo1234 |
| Açaiteria | dono@acaidapraia.demo | demo1234 |
| Mercado | dono@bompreco.demo | demo1234 |

Lojas públicas: `/loja/forno-da-vila`, `/loja/brasa-burger`, `/loja/acai-da-praia`, `/loja/mercadinho-bom-preco`.

## O que cada perfil faz

**Cliente final** (sem login), em `/loja/<endereço>`:
- monta o pedido com grupos de opções (tamanho, meio a meio, adicionais, complementos, combos);
- escolhe entrega por bairro ou retirada, aplica cupom e paga com Pix, cartão na entrega ou dinheiro com troco;
- acompanha o pedido em `/pedido/<código>`, que se atualiza sozinha.

**Dono da empresa**, em `/painel`:
- **Preparo:** fila em 3 colunas que recebe os pedidos na hora (SSE) com aviso sonoro. O nome da aba muda conforme o segmento: Cozinha, Chapa, Montagem ou Separação.
- **Entregas:** despacho para um entregador e confirmação da entrega ou da retirada.
- **Cardápio:** produtos e editor de grupos de opções (mínimo e máximo de escolhas, preço adicional por opção), além de marcar itens esgotados.
- **Relatórios:** faturamento, ticket médio, tempo médio até a entrega, vendas por dia e por horário, mais vendidos, formas de pagamento e taxas a repassar aos entregadores.
- **Configurações:** dados da loja, cor da marca, pedido mínimo, aberta ou fechada, bairros e taxas, cupons, entregadores, equipe e plano.

**Atendente** (cadastrado pelo dono): opera preparo e entregas e marca itens esgotados. Não vê relatórios nem configurações.

**Dono da plataforma**, em `/plataforma`: vê a receita recorrente (MRR), o volume vendido e os pedidos de todas as empresas. Cadastra empresas a partir de modelos por segmento, muda o plano e suspende ou reativa empresas. Empresa suspensa tem a loja fora do ar e o login bloqueado.

## Estrutura

```
src/
  server.js     servidor HTTP, rotas da API, SSE, arquivos estáticos, inicialização
  service.js    regras de negócio: empresas, cardápio, pedidos, status, relatórios
  db.js         esquema SQLite (valores em centavos)
  auth.js       senhas com scrypt e tokens assinados com HMAC
  templates.js  modelos de catálogo por segmento e planos
  seed.js       dados de demonstração
public/         frontend (HTML, CSS e JS puro, sem etapa de build)
test/           testes da API com node:test
```

## Regras importantes já implementadas

- **Preço calculado no servidor:** o navegador envia só produto, quantidade e opções. Total, taxa e desconto são recalculados a partir do cardápio.
- **Validação das opções:** cada grupo de opções exige o mínimo e respeita o máximo de escolhas, e uma opção só vale para o próprio produto.
- **Isolamento entre empresas:** toda consulta da área logada filtra por empresa, e há teste cobrindo isso.
- **Fluxo de status controlado:** recebido → em preparo → pronto → saiu para entrega → entregue, com cancelamento até ficar pronto. Pedido de retirada não passa por "saiu para entrega", e o despacho exige um entregador ativo.
- **Limite de pedidos por mês no plano Básico**, pedido mínimo por loja e limite de tentativas de login.

## API (resumo)

Público: `GET /api/meta`, `POST /api/auth/login`, `GET /api/public/stores/:slug`, `POST /api/public/stores/:slug/coupon`, `POST /api/public/stores/:slug/orders`, `GET /api/public/orders/:code`.

Empresa (Bearer token): `GET|PUT /api/store`, `PUT /api/store/plan`, `GET|POST /api/products`, `PUT|DELETE /api/products/:id`, `PATCH /api/products/:id/availability`, CRUD em `/api/zones`, `/api/coupons`, `/api/couriers` e `/api/team`, `GET /api/orders?status=`, `POST /api/orders/:id/status`, `GET /api/reports?days=`, `GET /api/events` (SSE).

Plataforma: `GET /api/platform/overview`, `POST /api/platform/tenants`, `PATCH /api/platform/tenants/:id`.

Valores em dinheiro trafegam em **centavos** (inteiros).

## Colocar no ar

1. Use um servidor ou contêiner com Node 22.5 ou mais novo (Railway, Render, Fly.io, uma VPS etc.).
2. Defina `SECRET` (um valor longo e aleatório), `PLATFORM_EMAIL`, `PLATFORM_PASSWORD` e `SEED_DEMO=0`.
3. Guarde `data/` num volume persistente e faça backup do `balcao.db`.
4. Coloque HTTPS na frente (Caddy, Nginx ou o próprio provedor).

## Próximos passos sugeridos

- **Pagamento online:** Pix com QR Code e cartão via Mercado Pago, Asaas ou Stripe, com confirmação por webhook antes de mandar o pedido para o preparo.
- **Cobrança da assinatura** das empresas (recorrência no mesmo gateway) e período de teste.
- **Notificações por WhatsApp** de mudança de status (API oficial ou um provedor).
- **App ou página do entregador**, com aceite e localização.
- **Taxa por distância** (raio em km) como alternativa às taxas por bairro, e horários de funcionamento automáticos.
- **Upload de fotos** dos produtos (S3 ou R2) e domínio próprio por loja (plano Rede).
- **Postgres** quando o volume crescer: o esquema em `db.js` é SQL padrão e migra com poucas mudanças.
