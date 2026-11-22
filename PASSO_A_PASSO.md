# Passo a passo: Supabase + GitHub Pages

Tempo estimado: 30 a 40 minutos. Você vai precisar de contas gratuitas no **GitHub**, no **Supabase** e (recomendado) na **Cloudflare**.

Ordem: primeiro o Supabase (banco), depois o GitHub (site). Não pule a Parte 1, o site depende dela.

---

## Parte 1 — Supabase (banco de dados, login e anexos)

### 1.1 Criar o projeto
1. Acesse <https://supabase.com> → **New project**.
2. Nome: `conceive-requests`. Região: **South America (São Paulo)**.
3. Defina uma senha forte para o banco e **guarde-a** (você quase não vai usá-la, mas não dá para recuperar).
4. Aguarde ~2 minutos até o projeto ficar pronto.

### 1.2 Criar as tabelas, regras de segurança e auditoria
1. No menu lateral: **SQL Editor** → **New query**.
2. Abra o arquivo `supabase/migrations/20261121000000_init.sql` deste projeto, copie **tudo** e cole no editor.
3. Clique em **Run**.
4. O Supabase pode perguntar sobre "destructive operations" (o script contém `drop trigger/policy if exists` e `revoke`). É esperado: confirme com **Run this query**.
5. Resultado esperado: `Success. No rows returned`.

> **Já rodou a versão anterior?** Rode este arquivo **inteiro de novo**: ele atualiza o limite de anexos para 50 MB sem apagar nenhum dado.
>
> **Anexos de 50 MB:** o limite do bucket já está em 50 MB. O Supabase também tem um limite global (menu **Storage → Settings → Upload file size limit**). Se um vídeo grande for recusado mesmo assim, confira esse valor (o plano gratuito costuma permitir no máximo 50 MB). Não consegui testar o envio de arquivos grandes contra o Supabase real.

> O script é seguro para rodar de novo. Se algum dia der erro de “function not found” no site, rode `notify pgrst, 'reload schema';` no SQL Editor.

### 1.3 (Opcional) Cadastrar as clínicas iniciais
Abra `supabase/seed_clinics.sql`, edite a lista (já traz Kardiomov, Med Clínica Goianinha, Hospital de Olhos de Parnamirim e Clínica de Olhos Santa Beatriz, tirados da sua planilha) e rode no SQL Editor. Depois você gerencia tudo pela tela **Clínicas** do painel.

### 1.4 Ligar o login anônimo (é o que permite o cliente enviar sem cadastro)
1. **Authentication** → **Sign In / Providers**.
2. Ative **Allow anonymous sign-ins**.
3. Deixe **Allow new users to sign up** como está (ligado). Uma conta criada por esse caminho **não tem nenhuma permissão**: o acesso de equipe depende de estar cadastrada na tela Equipe **e** ter MFA.

### 1.5 Criar o seu usuário e torná-lo administrador
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Informe seu e-mail e uma senha forte. Marque a opção de **confirmar o e-mail automaticamente** (Auto Confirm User), se aparecer.
3. Volte ao **SQL Editor**, abra `supabase/bootstrap_admin.sql`, troque `voce@suaempresa.com.br` pelo seu e-mail e `Seu Nome Aqui` pelo seu nome, e clique em **Run**.
4. A consulta final deve mostrar 1 linha com `role = ADMIN`.

### 1.6 Copiar a URL e a chave pública
1. **Project Settings** → **API Keys**.
2. Copie a **Project URL** (algo como `https://abcdxyz.supabase.co`) e a **Publishable key** (começa com `sb_publishable_`). Se o seu projeto ainda mostrar só a chave antiga `anon` (começa com `eyJ`), ela também funciona.
3. **Nunca** use a *secret key* / *service_role* neste projeto. Ela ignora todas as regras de segurança.

A chave publishable/anon é pública por natureza (vai no JavaScript do site). Quem protege os dados são as regras do banco que você instalou no passo 1.2.

### 1.7 Proteção anti-robô com Cloudflare Turnstile (recomendado)
Sem isso, qualquer pessoa pode criar milhares de sessões anônimas. O Supabase limita em 30 por hora por IP, mas o CAPTCHA é a defesa de verdade.

1. Em <https://dash.cloudflare.com> → **Turnstile** → **Add widget**.
   - **Hostnames:** `SEUUSUARIO.github.io` (o endereço do GitHub Pages; só o domínio, sem `/nome-do-repo`). Para testar no seu computador, adicione também `localhost`.
   - Modo: **Managed**.
2. Copie a **Site key** (pública) e a **Secret key** (privada).
3. No Supabase: **Authentication** → **Settings** → **Bot and Abuse Protection** → ative **Enable CAPTCHA protection** → provedor **Cloudflare Turnstile** → cole a **Secret key** → **Save**.
4. A **Site key** você usa na Parte 2 (variável `VITE_TURNSTILE_SITE_KEY`).

> ⚠ Ative **os dois lados juntos**: se ligar o CAPTCHA no Supabase e esquecer a variável `VITE_TURNSTILE_SITE_KEY` no GitHub, o formulário deixa de funcionar. Se não quiser CAPTCHA agora, deixe os dois desligados.

### 1.8 Limite de sessões anônimas por IP
**Authentication** → **Rate Limits**. O padrão é 30 sessões anônimas por hora por IP. Se uma clínica tem muitos funcionários na mesma internet e todos enviarem pedidos na mesma hora, aumente esse valor.

---

## Parte 2 — GitHub Pages (o site)

### 2.1 Criar o repositório
1. <https://github.com/new> → nome, por exemplo, `conceive-requests`.
2. Escolha **Public**. O GitHub Pages em repositório **privado** exige plano pago. O código não contém segredos, então público é seguro.

### 2.2 Cadastrar as variáveis (ANTES de enviar o código)
No repositório: **Settings** → **Secrets and variables** → **Actions** → aba **Variables** → **New repository variable**. Crie:

| Nome | Valor |
|---|---|
| `VITE_SUPABASE_URL` | a Project URL do passo 1.6 |
| `VITE_SUPABASE_ANON_KEY` | a Publishable key (ou `anon`) do passo 1.6. O nome é histórico, serve para os dois tipos |
| `VITE_TURNSTILE_SITE_KEY` | a Site key do passo 1.7 (deixe vazio se não usar CAPTCHA) |

Use **Variables**, não *Secrets*: esses valores precisam estar no site compilado e são públicos.

### 2.3 Ativar o GitHub Pages
**Settings** → **Pages** → em **Build and deployment**, campo **Source**, escolha **GitHub Actions**.

### 2.4 Enviar o código
No terminal, dentro da pasta do projeto:

```bash
git init -b main
git add .
git commit -m "Conceive Requests"
git remote add origin https://github.com/SEUUSUARIO/conceive-requests.git
git push -u origin main
```

(Sem terminal: no GitHub, **Add file → Upload files** e arraste todo o conteúdo da pasta, inclusive a pasta oculta `.github`.)

### 2.5 Publicar
1. Aba **Actions** → o fluxo **Publicar no GitHub Pages** roda sozinho a cada envio para `main`. Se não rodou, clique em **Run workflow**.
2. Espere os dois blocos (`build` e `deploy`) ficarem verdes (~1 a 2 minutos).
3. O endereço do site aparece no bloco `deploy` e é:
   `https://SEUUSUARIO.github.io/conceive-requests/`

Se o fluxo falhar com “Falta a variável VITE_SUPABASE_URL”, volte ao passo 2.2 e rode de novo (**Re-run all jobs**).

---

## Parte 3 — Primeiro acesso e teste

1. **Site:** `https://SEUUSUARIO.github.io/conceive-requests/`. Tem três abas no topo: **Solicitação de funcionalidade** (abre direto, é o link que você passa para as clínicas), **Acompanhar sua solicitação** e **Acesso da equipe**.
2. Envie uma solicitação de teste. Nos anexos dá para **escolher arquivos, arrastar, ou colar um print com Ctrl + V** (por exemplo, depois de `Win + Shift + S`); cada arquivo pode ter até 50 MB: o protocolo `CON-AAAA-0001` aparece com o link de acompanhamento.
3. **Painel da equipe:** clique na aba **Acesso da equipe** (ou adicione `#/login` ao endereço).
   - Entre com o e-mail e a senha do passo 1.5.
   - No **primeiro acesso** aparece um QR code: leia com Google Authenticator, Authy ou 1Password e digite o código de 6 dígitos. Nos próximos acessos basta o código.
4. Você deve ver a solicitação de teste na lista. Teste: abrir, mudar status, comentar com “Resposta pública” e conferir no link de acompanhamento.

### Adicionar a equipe
1. No Supabase: **Authentication → Users → Add user** (e-mail + senha + confirmar automaticamente). Passe a senha à pessoa.
2. No painel: **Equipe** → informe o mesmo e-mail, o nome e o papel → **Liberar acesso**.
3. A pessoa entra e cadastra o próprio autenticador no primeiro login.

| Papel | O que pode |
|---|---|
| Admin | tudo, inclusive equipe, clínicas e auditoria |
| Product Owner | triagem, status, RICE, mesclar, arquivar, exportar, auditoria da solicitação |
| Suporte / CS | ver (com dados pessoais), vincular clínica, comentar (interno e público) |
| Dev (visualizador) | só leitura com nome/telefone **mascarados** e comentário técnico interno |

**Para desligar alguém, use “Desativar” na tela Equipe. Não apague o usuário no Supabase:** o banco impede, de propósito, apagar quem já comentou em solicitações, para não perder o histórico.

---

## Parte 4 — Manutenção

- **Limpeza mensal (1 minuto):** rode `supabase/cleanup_anonymous_users.sql` no SQL Editor. Cada cliente que envia um pedido vira um usuário anônimo e o Supabase não limpa isso sozinho. Os links de acompanhamento **continuam funcionando**.
- **Backup:** no plano gratuito do Supabase não há restauração pontual. Periodicamente use o botão de exportar do **Table Editor** ou o botão **Exportar CSV** do painel. Para uso sério, considere o plano pago.
- **Projeto pausado:** projetos gratuitos do Supabase podem ser pausados após um período sem uso. Com acesso regular isso não acontece; se acontecer, basta clicar em **Restore project** no painel do Supabase.
- **Atualizar o site:** qualquer alteração enviada para a branch `main` publica de novo automaticamente.
- **Perdeu o celular do MFA?** Outro admin não consegue resetar pela tela. Avançado: no SQL Editor, `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'pessoa@empresa.com');`. Confira o nome da tabela no seu projeto antes de rodar. Na próxima entrada, a pessoa cadastra o autenticador de novo.

---

## Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| Página mostra **“Configuração incompleta”** | Faltam as variáveis do passo 2.2. Cadastre e rode o fluxo de novo. |
| Formulário não libera / “não foi possível validar a verificação anti-robô” | (a) *Anonymous sign-ins* desligado (1.4); (b) CAPTCHA ligado no Supabase mas `VITE_TURNSTILE_SITE_KEY` vazia (ou o contrário); (c) o hostname `SEUUSUARIO.github.io` não está no widget da Cloudflare. |
| “Muitas solicitações em pouco tempo” | Limite de 5 envios em 10 min (30 por dia) por sessão. Aguarde. |
| Login: “Sua conta ainda não foi cadastrada na equipe” | Falta o passo 1.5 (item 3) ou a liberação na tela Equipe. |
| Login: “Código inválido” | Hora do celular errada (ative hora automática) ou código expirado: use o próximo. |
| Painel diz “Autenticação em dois fatores pendente” | Saia e entre de novo, concluindo o código do autenticador. |
| Vídeo/imagem grande recusado | O limite é 50 MB por arquivo e 5 por solicitação. Se ainda falhar com menos de 50 MB, veja o limite global em Storage → Settings. |
| Ctrl + V não cola o print | Clique em qualquer área da página (fora de uma caixa de texto) e tente de novo, ou use o botão **Colar imagem**. Só imagens PNG/JPG/WEBP são aceitas. |
| Erro “Could not find the function …” | Rode `notify pgrst, 'reload schema';` no SQL Editor. |
| Tela em branco em endereço antigo | Abra a raiz do site; o site usa endereços com `#/` e funciona em qualquer subcaminho. |

---

## O que foi testado (e o que não foi)

Testado neste ambiente, **contra um PostgreSQL 16 real**, simulando o Supabase (papéis `anon`/`authenticated`, claims do JWT e schemas `auth`/`storage`):

- **191 verificações no banco**: permissões de cada papel, RLS, mascaramento LGPD, auditoria (antes/depois, IP, autor), imutabilidade da trilha, bloqueio de DELETE, protocolo sequencial, rate limit, limites de anexos, mesclagem, RICE, exportação, MFA obrigatório (aal2) e idempotência da migração.
- **9 verificações** nos scripts auxiliares (admin, clínicas, limpeza).
- **26 testes de contrato**: o `src/lib/api.ts` do site rodando contra esse banco, em cada papel.
- **21 testes unitários**: telefone, validação, CSV seguro, anexos (limite de 50 MB exato, nome do print colado) e comparação automática dos enums e DDDs do site com os do SQL.
- **36 verificações de ponta a ponta em navegador real (Chromium)**: abas do site, colar print (Ctrl + V), arrastar arquivo, recusa acima de 50 MB, cliente envia e acompanha, PO/Dev/Admin entram com MFA, lista, filtros, modal, comentários, Kanban com arrastar, mesclagem, CSV, arquivar e gestão de clínicas/equipe.

**Não foi possível testar aqui** (exige internet e as suas contas):
- O `npm install` + `vite build` reais (o ambiente não tinha rede): validei a compilação com esbuild e os tipos com declarações simplificadas. O primeiro *build* no GitHub é o teste final; se acusar algum erro de tipo, ele aparece no log da aba Actions.
- A comunicação com o Supabase de verdade (substituída por um banco local equivalente), o widget do Turnstile e o envio real de arquivos ao Storage (inclusive o de 50 MB). O Ctrl + V foi testado com o evento de colar simulado, não com a área de transferência real do Windows.
- A tela do GitHub Pages e do painel do Supabase: os nomes dos menus acima seguem a documentação oficial, mas podem mudar de lugar.

## Limites conhecidos
- O IP na auditoria vem dos cabeçalhos da requisição (`cf-connecting-ip` / `x-forwarded-for`) e é **informativo**, não prova forense.
- Redmine/Pipefy: hoje só guarda o ID da tarefa (campos manuais); a integração automática é um próximo passo.
- O aviso ao cliente é um link `wa.me` (abre o WhatsApp com a mensagem pronta); não é a API oficial.
- Kanban mostra até 200 cartões por vez (use os filtros).
- A planilha antiga não foi importada.

Fontes: [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [API keys](https://supabase.com/docs/guides/api/api-keys), [MFA TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [GitHub Pages com Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
