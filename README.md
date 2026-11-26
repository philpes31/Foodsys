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
   6. `20261118000000_distancia_fidelidade.sql` (taxa por distância e programa de fidelidade)
   7. `20261119000000_balcao_mesa_caixa.sql` (pedido no balcão/telefone, mesa por QR Code e fechamento de caixa)
   8. `20261120000000_cupons_avaliacoes_estoque.sql` (cupons com regras, avaliações e estoque)
   9. `20261121000000_agendamento_vitrine.sql` (pedido agendado e vitrine da loja)
   10. `20261122000000_promocoes.sql` (promoções automáticas e frete grátis acima de um valor)
   11. `20261123000000_checagem.sql` (a tela Plataforma passa a mostrar quais migrações faltam no banco)
   12. `20261124000000_saude_plataforma.sql` (painel de saúde na tela Plataforma)
   13. `20261125000000_cartao_dominio_unidades.sql` (cartão de crédito online, domínio próprio por loja e várias unidades)
   14. `20261126000000_seguranca.sql` (correções do teste de segurança e de carga: limite de tentativas, privacidade e cupom sob concorrência)
   15. `20261127000000_mesa_servico_pedidos_antigos.sql` (taxa de serviço na mesa e encerramento de pedidos esquecidos)
   16. `20261128000000_vitrine_previsao_mesas.sql` (mais pedidos, previsão de entrega, categorias com horário e conta da mesa)
   17. `20261129000000_pausa_feriados_estacoes.sql` (pausa rápida, feriados, estações cozinha/bar e mapa de horários)
   18. `20261130000000_caixa_acerto_bloqueio.sql` (caixa por turno, acerto do entregador e bloqueio de clientes)
   19. `20261201000000_insumos_financeiro.sql` (estoque de insumos com ficha técnica, despesas e resultado do mês)
   20. `20261202000000_adicionais_importacao.sql` (insumos nos adicionais/tamanhos e importação de cardápio por planilha)
   21. `20261203000000_cashback_atividades.sql` (cashback, pedido mínimo por bairro e registro de atividades da equipe)
   22. `20261204000000_metas_cardapio_chamada.sql` (metas de vendas, engenharia de cardápio e painel de chamada)
   23. `20261205000000_aceite_reajuste.sql` (aceite automático de pedidos, reajuste de preços em lote e esgotar categoria)
   24. `20261206000000_logotipo.sql` (logotipo da loja no cabeçalho, painel de chamada e cardápio impresso)
   25. `20261207000000_chamada_nomes.sql` (nome do cliente no painel de chamada, opcional: "Maria S.")
   26. `20261208000000_sugestoes_garcom_avisos.sql` (sugestões escolhidas no carrinho, conta de mesa dividida, avisos no celular)
   27. `20261209000000_totem_indicacao.sql` (totem de autoatendimento e indique e ganhe)
   28. `20261210000000_entregador_ao_vivo.sql` (entregador no mapa ao vivo e rota das entregas)
   29. `20261211000000_unidades_notas_produto.sql` (painel consolidado das unidades e avaliação por produto)
   30. `20261212000000_acerto_entregadores.sql` (acerto dos entregadores: forma de pagamento, período, pago e chave Pix)
   31. `20261213000000_vale_reservas.sql` (vale-presente e reserva de mesas)
   32. `20261214000000_totem_pix.sql` (pagamento por Pix no próprio totem)
   33. `20261215000000_totem_cartao_point.sql` (cartão no totem pela maquininha Mercado Pago Point; republique a função `pix`)
   34. `20261216000000_seguranca_2.sql` (teste de segurança 2: configurações internas só para a equipe, conta de totem, avisos só para serviços conhecidos)
   35. `20261217000000_meio_a_meio.sql` (pizza meio a meio: cobrar o sabor mais caro ou a média; "1/2 Calabresa" no pedido; estoque fracionado)
   36. `20261218000000_chamados.sql` (aba Ajuda: chamados de suporte com print e diagnóstico; respostas em /plataforma/chamados)
   37. `20261219000000_avisos_loja_erros.sql` (aviso de pedido novo no aparelho da equipe; monitor de erros em /plataforma/erros)
   38. `20261220000000_fiado.sql` (fiado: contas de clientes com limite, recebimentos no caixa, estorno no cancelamento)
   39. `20261221000000_search_path.sql` (verificador de segurança do Supabase: search_path fixo nas funções auxiliares)
   40. `20261222000000_combos.sql` (combos com produtos do cardápio: estoque, ficha técnica, item esgotado some, economia na loja)
   41. `20261223000000_totem_so_paga_no_totem.sql` (totem: pagamento no próprio totem, Pix ou maquininha; "pagar no caixa" só se o dono liberar)
   42. `20261224000000_emails.sql` (e-mails automáticos pelo Resend: chamados, teste grátis acabando, assinatura vencida, resumo do dia)
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

**Cartão de crédito online:** usa a mesma função e o mesmo Access Token. Em **Configurações → Pix e cartão online**, a loja marca "Oferecer Cartão de crédito agora". O cliente é levado ao checkout do Mercado Pago (até 12x), volta para a página do pedido e o pedido entra na fila quando o pagamento é aprovado. Cartão recusado não cancela o pedido: o cliente pode tentar outro cartão até o prazo de 45 minutos. Com token de teste, o checkout abre no ambiente de testes do Mercado Pago, onde dá para pagar com os [cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/your-integrations/test/cards).

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

### 8a. Avisos no celular do cliente (opcional)

O cliente toca em **Me avise no celular** na página do pedido e recebe uma notificação quando o pedido é aceito, fica pronto, sai para entrega, é entregue ou cancelado. Funciona no Android e no computador; no iPhone, só com a loja adicionada à Tela de Início (iOS 16.4+). Não tem custo.

1. Em **/plataforma → Avisos no celular do cliente**, clique em **Gerar chaves e ativar**. As chaves são geradas no seu navegador e o banco já fica configurado.
2. Copie os três valores que aparecem para **Edge Functions → Secrets**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `PUSH_SECRET`. A chave privada não fica salva em lugar nenhum: se perder, gere de novo.
3. Publique a Edge Function `push` (conteúdo de `supabase/functions/push/index.ts`) com **Enforce JWT verification desligado**. Pela CLI: `supabase functions deploy push --no-verify-jwt`.
4. Em **Database → Extensions**, ative **pg_net** (é ela que deixa o banco chamar a função quando o status muda).

### 8b. Domínio próprio de uma loja (opcional)

1. A loja informa o domínio em **Configurações → Domínio próprio** (por exemplo `pedidos.minhapizzaria.com.br`) e cria no DNS um **CNAME** apontando para `cname.vercel-dns.com`.
2. Você vê a lista em **Plataforma → Domínios próprios** e adiciona cada domínio na Vercel: projeto → **Settings → Domains → Add**. A Vercel confere o DNS e cria o certificado https.
3. Quem abre o domínio cai direto na loja. Links de campanha, QR Codes das mesas e o link copiado no painel passam a usar o domínio.
4. Se a própria plataforma tiver um domínio (ex.: `balcao.com.br`), coloque em `PLATFORM.domains` no `public/config.js`, para ele abrir a página inicial e não ser tratado como loja.

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

**Pizza meio a meio:** crie o produto (ex.: "Pizza grande 2 sabores") com preço base 0 e um grupo "Sabores" com mínimo 1 e máximo 2 (ou 3, 4). Cadastre cada sabor com o preço da pizza inteira e, em "Como cobrar este grupo", escolha **cobrar o sabor mais caro** (o mais comum) ou **a média dos sabores**. Bordas e adicionais ficam em outro grupo, somando normalmente. O pedido sai como "1/2 Calabresa, 1/2 Mussarela", e a ficha técnica de cada sabor baixa só a sua parte do estoque.

**Ajuda (chamados):** dono e atendentes abrem chamados na aba **Ajuda** do painel, com print da tela (anexar ou colar com Ctrl+V) e, se deixarem marcado, um diagnóstico automático (página, navegador e os últimos erros da aba). A administração responde em **Plataforma → Chamados**; o número ao lado da aba avisa quando há resposta nova. Os prints ficam num bucket privado (`support-files`), visível só para a loja e para a plataforma.

**Aviso de pedido novo no celular:** na tela de Pedidos, toque em **🔔 Avisar neste aparelho** (dono ou atendente). Quando entrar pedido pela loja online, totem ou mesa, o aparelho recebe uma notificação mesmo com o painel fechado; Pix online avisa quando o pagamento é confirmado. Pedidos lançados pela equipe não avisam. Precisa dos avisos no celular configurados na Plataforma. No iPhone, abra o painel pela Tela de Início.

**Monitor de erros:** erros inesperados no navegador (painel, loja online, acompanhamento) são registrados sozinhos e aparecem em **Plataforma → Erros**, agrupados por mensagem, com quantas vezes e em quais lojas. "Marcar resolvido" tira da lista até acontecer de novo. Avisos de validação ("Escreva um assunto") e falta de internet não entram.

**Fiado:** o dono liga em **Caixa → Fiado** e cadastra a conta de cada cliente de confiança (nome, telefone e limite opcional). No **Novo pedido**, com o telefone do cliente, a forma de pagamento **Fiado** mostra quanto ele deve e quanto ainda cabe no limite. O cliente nunca escolhe fiado pela loja online. Recebimentos (dinheiro, Pix ou cartão) abatem a dívida; em dinheiro entram na gaveta do caixa. Pedido cancelado estorna sozinho. Extrato imprimível e ajuste com motivo (só o dono).

**Central de ajuda:** a aba **Ajuda** traz perguntas frequentes com busca; ao escrever um chamado, as respostas que combinam aparecem antes de enviar.

**Combos:** em **Cardápio → Montar combo**, dê nome e preço e monte as etapas (ex.: "Pizza" e "Bebida") escolhendo produtos do cardápio; dá para cobrar um valor a mais por item (ex.: +R$ 2 para trocar a bebida). O combo baixa o estoque e a ficha técnica dos produtos escolhidos (e devolve no cancelamento), item esgotado some da escolha, e a loja e o totem mostram "Economize R$ X" em relação aos itens avulsos.

**Comprovante do totem:** em **Configurações → Totem**, cada aparelho escolhe como imprimir a senha (número, nome, itens, total e forma de pagamento) depois do pagamento: **computador ou iPad** pela impressora do sistema (no computador, o Chrome aberto com `--kiosk --kiosk-printing` imprime sem janela; no iPad sempre aparece a janela do AirPrint) ou **Android com impressora térmica** pelo app RawBT. Papel de 58 ou 80 mm e botão de "Imprimir teste".

**E-mails automáticos:** em **Plataforma → E-mails automáticos**, toque em "Ativar e-mails" e siga os passos: conta grátis no Resend (com o domínio do site verificado), segredos `EMAIL_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` e `SITE_URL` no Supabase e a função `email` publicada sem Verify JWT. Você recebe os chamados novos e as mensagens das lojas; a loja recebe a resposta do suporte, o aviso de teste grátis acabando (3 dias antes) e de assinatura vencida. O dono pode ligar o **resumo do dia** em Configurações (chega às 7h). Os e-mails diários usam a extensão pg_cron.

- **Impressão da comanda:** na tela de preparo, o botão **Imprimir** abre a impressão do navegador já no formato 80 mm. Escolha a impressora térmica e, nas configurações de impressão, desmarque "Cabeçalhos e rodapés". Marque **Imprimir comanda ao aceitar** para imprimir automaticamente ao aceitar o pedido. No Chrome, dá para pular a janela de impressão abrindo o navegador com `--kiosk-printing`.
- **Entregador:** em **Configurações → Entregadores → Enviar link**, cada entregador recebe pelo WhatsApp um link próprio. Ele abre no celular, sem senha, e mostra as entregas dele com endereço, valor a cobrar ou "já pago", e os botões de mapa, WhatsApp, ligar e **Entreguei**. **Novo link** desativa o anterior (use quando um entregador sair).
- **Clientes:** a aba **Clientes** lista quem já pediu, com número de pedidos, total gasto e último pedido. Clientes que não pedem há mais de 30 dias aparecem como "sumido", e um botão de WhatsApp manda uma mensagem pronta para chamar de volta. Dá para baixar a lista em planilha (CSV).
- **Taxa por distância:** em **Configurações → Taxa de entrega**, escolha **Por distância**, marque a localização da loja e defina faixas como "até 2 km R$ 5, até 5 km R$ 8, até 8 km R$ 12".
  - Para a localização, digite o CEP e o número e clique em **Localizar**, ou cole as coordenadas do Google Maps (botão direito no local).
  - No checkout, o cliente digita o CEP e o número, o endereço é localizado no mapa (BrasilAPI e OpenStreetMap) e a taxa aparece antes de enviar. Fora da última faixa, o pedido não é aceito.
  - A distância é **em linha reta**, então deixe uma folga nas faixas.
  - O banco recalcula a taxa a partir das coordenadas do endereço. O link do mapa para o entregador já usa o ponto exato.
- **Fidelidade:** em **Configurações → Programa de fidelidade**, defina, por exemplo, "a cada 10 pedidos entregues, 10% de desconto".
  - O cliente é reconhecido pelo telefone e o desconto entra sozinho no pedido seguinte. Não soma com cupom: vale o maior.
  - Se o pedido premiado for cancelado, o prêmio volta.
  - O cliente vê o cartão de selos na página do pedido, e a loja vê os selos de cada cliente na aba **Clientes**.
- **Pedido no balcão ou por telefone:** na tela de preparo, use **+ Novo pedido**. Escolha Balcão, Telefone ou Mesa, toque nos produtos (as opções abrem como na loja), informe o pagamento e lance.
  - O pedido entra direto em **preparo**, sem depender do horário do site, e imprime a comanda se a impressão automática estiver ligada.
  - No balcão, nome e telefone são opcionais.
  - Cupom e fidelidade são aplicados sozinhos quando há telefone.
- **Mesa por QR Code:** em **Configurações → Pedidos na mesa**, ligue a opção, informe a quantidade de mesas e clique em **Imprimir QR Codes das mesas**. Sai uma folha A4 com um cartão por mesa.
  - O cliente escaneia, pede pelo celular e paga no caixa (ou por Pix online, se ativo).
  - O pedido chega na cozinha com **MESA 7** em destaque.
  - Quando ficar pronto, o botão **Servido** finaliza o pedido.
  - O pedido mínimo e a taxa de entrega não valem para a mesa.
  - Os QR Codes são gerados pelo serviço público api.qrserver.com, que só recebe o link da mesa.
- **Fechamento de caixa:** a aba **Caixa** (dono e atendentes) mostra o total do dia, os valores por forma de pagamento (para conferir com a maquininha e a gaveta), por canal e por tipo, além de cancelados, valor recebido online e troco devolvido.
  - **Imprimir fechamento** sai na impressora de 80 mm, com linha de "Conferido por".
- **Cupons com regras:** ao criar um cupom em **Configurações → Cupons**, abra "Regras opcionais" para definir:
  - pedido mínimo e data de validade;
  - limite total de usos e de usos por cliente (pelo telefone);
  - uso só na primeira compra.

  A lista mostra quantas vezes cada cupom já foi usado. Todas as regras são conferidas pelo banco no momento do pedido.
- **Avaliações:** depois que o pedido é entregue, a página de acompanhamento pede uma nota de 1 a 5 estrelas e um comentário, por até 7 dias.
  - A nota média aparece no topo da loja ("★ 4,7 (23 avaliações)") e abre os comentários.
  - Em **Relatórios → Avaliações dos clientes**, o dono lê e responde. A resposta aparece para todos na loja.
  - Na loja só aparece o primeiro nome do cliente.
- **Estoque:** na aba **Cardápio**, a coluna Estoque aceita um número. Em branco, o produto não tem controle de estoque.
  - Com número, cada pedido dá baixa e o cancelamento devolve, inclusive o Pix não pago.
  - Com 5 ou menos unidades, a loja mostra "Últimas N unidades".
  - Ao chegar a zero, o produto aparece como **Esgotado** e o banco recusa pedidos acima do saldo.
- **Pedido agendado:** em **Configurações → Pedidos agendados**, ligue a opção e defina até quantos dias, a antecedência mínima e o intervalo dos horários.
  - No checkout aparece **"Quando?"**: "o quanto antes" ou um dia e horário. Os horários seguem o funcionamento da loja.
  - Com a loja fechada, o cliente ainda pode agendar para quando ela abrir. Já a pausa manual ("Receber pedidos" desmarcado) bloqueia tudo.
  - No preparo, os agendados ficam numa faixa **"Agendados para mais tarde"** e entram nas colunas 1 hora antes, com ⏰ e o horário.
  - A comanda, a mensagem do entregador e a página do cliente mostram o horário agendado.
  - O banco confere antecedência, limite de dias e horário de funcionamento.
- **Vitrine da loja:** em **Configurações → Vitrine da loja**, envie um **banner** (foto larga, reduzida automaticamente) e preencha descrição, endereço e Instagram.
  - Tudo aparece no topo da loja, junto com a nota das avaliações, o link do WhatsApp, o endereço no mapa e o quadro de horários.
- **App instalável (PWA):** o site funciona como aplicativo.
  - No Android/Chrome, aparece o botão **"Instalar app no celular"** no rodapé.
  - No iPhone: Compartilhar → "Adicionar à Tela de Início".
  - Instalado a partir da página de uma loja, o app abre direto nela, com o nome da loja. Instalado a partir do painel, abre no painel.
  - O app abre mesmo com internet instável (as telas ficam guardadas), mas pedidos e dados sempre vêm do servidor.
- **Tela da cozinha (KDS):** no preparo, clique em **Tela da cozinha**. É o modo para TV ou tablet: fundo escuro, letras grandes, cronômetro e cores por atraso (verde, amarelo a partir de 10 min e vermelho a partir de 20 min).
  - Um toque avança o pedido (Começar → Pronto → Servido/Retirado).
  - Tem aviso sonoro, botão de tela cheia e mantém a tela acesa nos aparelhos que permitem.
- **Promoções automáticas:** em **Configurações → Promoções automáticas**, crie "leve X, pague Y" ou "% de desconto" para a loja toda, uma categoria ou um produto.
  - Pode limitar a dias da semana e a um horário (happy hour, inclusive passando da meia-noite).
  - A loja mostra as promoções no topo e o selo "Em promoção" nos produtos. O carrinho já calcula o desconto.
  - O banco recalcula tudo no pedido. Promoções somam com cupom e fidelidade.
- **Frete grátis acima de um valor:** em **Configurações → Taxa de entrega**. O carrinho mostra "Faltam R$ X para o frete grátis".
- **WhatsApp:** os botões abrem o WhatsApp Web ou o app com a mensagem pronta (aceito, pronto, saiu para entrega...) e o link de acompanhamento. Basta tocar em enviar.
- **Horário:** com "Abrir e fechar sozinha" ligado, a loja só aceita pedidos dentro dos horários. O banco confere isso, não só a tela. O checkbox "Receber pedidos" pausa a loja na hora, mesmo dentro do horário.

## Testes

`test/db.test.js` aplica a migração num Postgres 16 comum, com uma simulação mínima do `auth` do Supabase (`test/supabase-shim.sql`). Os 143 testes (banco e Edge Functions com Mercado Pago simulado) cobrem:
- isolamento entre empresas;
- permissões de dono, atendente e anônimo;
- cálculo de preço com opções e cupom;
- fluxo de status, limites do plano, editor de produto e relatórios;
- horário automático (inclusive passando da meia-noite) e permissões das fotos no Storage;
- Pix online: token protegido, valor conferido, webhook reconferido na API, expiração e pagamento atrasado;
- assinatura: teste grátis, carência, bloqueio de pedidos, só o dono assina, avisos reconferidos na API;
- link do entregador, lista de clientes, exclusão de dados (LGPD), retenção e exclusão da loja;
- taxa por distância (faixas, fora da área, coordenadas inválidas) e fidelidade (selos, resgate, cancelamento, cupom maior);
- pedido na mesa, pedido lançado pela equipe (permissões, canal, telefone opcional) e fechamento de caixa;
- regras de cupom, estoque (baixa, saldo insuficiente, devolução) e avaliações (prazo, uma por pedido, resposta);
- pedido agendado (antecedência, limite de dias, horário de funcionamento, loja fechada e pausada) e campos da vitrine;
- promoções (leve X pague Y, % por categoria, dia e horário), frete grátis acima de valor e permissões;
- cartão online (recusa não cancela, várias tentativas, valor conferido), domínio próprio (validação e unicidade) e criação de unidades com cópia do cardápio.

- **segurança** (`test/security.test.js`): ataques como visitante, outra loja e funcionário; manipulação de preço e status; injeção de SQL; pasta de fotos; privacidade de telefone e cobrança; enxurrada de pedidos; chute de cupom; cupom com 20 pedidos simultâneos.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres npm test
```

**Teste de carga do banco** (Postgres local, 30 lojas, pgbench): `PGHOST=... PGUSER=postgres bash test/carga/rodar.sh 50 30`

**Teste de carga contra o seu Supabase** (só leitura, não cria pedidos): `node scripts/carga.mjs <slug-da-loja> 20 30`

## Estrutura

```
supabase/migrations/   esquema, RLS, funções e modelos por segmento (rodar em ordem)
supabase/functions/pix      Edge Function do Pix dos pedidos (conta de cada loja)
supabase/functions/billing  Edge Function da assinatura das lojas (sua conta)
supabase/functions/push     Edge Function dos avisos no celular (Web Push com VAPID)
public/                site estático: index.html, style.css, app.js, config.js
scripts/serve.js       servidor local de desenvolvimento
test/                  testes do banco e simulação do auth do Supabase
vercel.json, netlify.toml   rotas para hospedagem estática
```

Valores em dinheiro são inteiros em **centavos**.

## Próximos passos sugeridos

- **WhatsApp a cada mudança de status:** um Database Webhook ou uma Edge Function chamando a API do WhatsApp.
- **Distância pela rua** (rota de carro) com um serviço de mapas pago, no lugar da linha reta.
