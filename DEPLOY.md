# Publicar: GitHub → Vercel (site) + Supabase (banco)

```
GitHub (main) ──► Vercel: build e deploy do site a cada push
      └────────► GitHub Actions: aplica db/migrations/*.sql no Postgres do Supabase
```

Aqui o Supabase é usado como **banco PostgreSQL**. O login e a sessão são do próprio sistema
(tabelas `users` e `sessions`), então você não precisa configurar nada em *Authentication*.

## 1. Criar o projeto no Supabase
1. supabase.com → **New project**. Guarde a **senha do banco**.
2. **Região:** escolha **South America (São Paulo)**. Na Vercel, use a região `gru1` (São Paulo) nas funções.
3. Clique em **Connect** (topo do painel) e copie duas strings, trocando `[YOUR-PASSWORD]` pela senha
   (se tiver `@`, `#`, `/` etc., converta em URL-encode):
   - **Transaction pooler** (porta **6543**) → será o `DATABASE_URL` da **Vercel**;
   - **Session pooler** (porta **5432**) → usada para **migrações** (computador e GitHub Actions).
   Evite a "Direct connection": ela só funciona em IPv6 e falha na Vercel e no GitHub Actions.

## 2. Criar as tabelas (uma vez, no seu computador)
```bash
unzip mesa-viva.zip && cd mesa-viva
npm install
DATABASE_URL="COLE_A_SESSION_POOLER_AQUI" npm run migrate
```
Deve aparecer uma linha `aplicando ...` para cada arquivo de `db/migrations` (0001 a 0005) e depois `banco atualizado`.
Sem terminal: cole `supabase-banco-completo.sql` (projeto novo) ou `supabase-atualizacao.sql` (quem já rodou 0001 e 0002) no SQL Editor.

Depois, no painel do Supabase: **Project Settings → Data API** e desative a Data API
(o sistema não a usa; a migração 0002 já tirou o acesso dos papéis `anon` e `authenticated`).

## 3. Testar localmente
```bash
cp env.example .env.local     # DATABASE_URL = Transaction pooler
npm run dev                    # http://localhost:3000
```
Clique em **Criar conta**, cadastre um produto e faça um pedido.

## 4. GitHub
```bash
git init && git add . && git commit -m "Mesa Viva"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/mesa-viva.git
git push -u origin main
```
Repositório **privado**. Em *Settings → Secrets and variables → Actions* crie o secret `DATABASE_URL`
com a **Session pooler**. Migrações novas em `db/migrations/` serão aplicadas sozinhas ao entrar na `main`.

## 5. Vercel
Add New → Project → escolha o repositório → **Environment Variables**:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | **Transaction pooler** do Supabase (porta 6543) |
| `NEXT_PUBLIC_SITE_URL` | URL final (ex.: `https://mesaviva.vercel.app`) |
| `RESEND_API_KEY` e `MAIL_FROM` | recuperação de senha por e-mail (resend.com) |

Em *Settings → Functions → Function Region*, escolha **São Paulo (gru1)**. Depois clique em **Deploy**.

## 6. Primeiro acesso
1. Abra o site → **Criar conta** (cria o estabelecimento com 14 dias de teste e o proprietário).
2. Para virar super administrador, rode no **SQL Editor** do Supabase:
   ```sql
   update profiles set is_super_admin = true
   where user_id = (select id from users where lower(email) = 'seu@email.com');
   ```

## Atenção para produção
- **Plano gratuito do Supabase:** projetos ficam pausados após uma semana sem uso e não têm backup
  automático. Para clientes reais, use o plano **Pro** (backups diários) ou agende um `pg_dump`.
- **Plano gratuito da Vercel (Hobby):** não permite uso comercial; para vender o SaaS, use o **Pro**.
- Rode o **teste de isolamento** do `README.md` com duas contas antes de abrir para clientes.
- Nunca coloque a senha do banco em código ou em variável `NEXT_PUBLIC_*`.

## Arquivos opcionais (ficaram em `docs/` para não depender de arquivos ocultos)
- `docs/migrate-workflow.yml`: automação de migrações. Para ativar, crie no GitHub o arquivo `.github/workflows/migrate.yml` com este conteúdo.
- `docs/gitignore.txt`: conteúdo do `.gitignore`. Só é necessário se você usar `git` no computador.
