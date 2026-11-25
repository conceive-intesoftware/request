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
2. Abra o arquivo **`supabase/Supabase-completo.sql`** deste projeto (é o único arquivo de banco de que você precisa), copie **tudo** e cole no editor. A Parte B dele tem chaves opcionais (primeiro admin, clínicas iniciais, e-mails, agendamentos): deixe como está agora e use-as quando chegar nos passos 1.3, 1.5 e Parte 5.
3. Clique em **Run**.
4. O Supabase pode perguntar sobre "destructive operations" (o script contém `drop trigger/policy if exists` e `revoke`). É esperado: confirme com **Run this query**.
5. Resultado esperado: `Success. No rows returned`.

> **Já rodou a versão anterior?** Rode este arquivo **inteiro de novo**: ele atualiza o limite de anexos para 50 MB sem apagar nenhum dado.
>
> **Anexos de 50 MB:** o limite do bucket já está em 50 MB. O Supabase também tem um limite global (menu **Storage → Settings → Upload file size limit**). Se um vídeo grande for recusado mesmo assim, confira esse valor (o plano gratuito costuma permitir no máximo 50 MB). Não consegui testar o envio de arquivos grandes contra o Supabase real.

> **Parte B do Supabase-completo.sql:** para usar uma opção, troque o valor na seção `CONFIGURAÇÃO` (ex.: `v_admin_email := 'voce@empresa.com.br'`, `v_clinicas := true`) e rode o arquivo inteiro de novo.

> O script é seguro para rodar de novo. Se algum dia der erro de “function not found” no site, rode `notify pgrst, 'reload schema';` no SQL Editor.

### 1.3 (Opcional) Cadastrar as clínicas iniciais
No `supabase/Supabase-completo.sql`, Parte B, troque `v_clinicas := false` por `true` e rode o arquivo de novo (traz Kardiomov, Med Clínica Goianinha, Hospital de Olhos de Parnamirim e Clínica de Olhos Santa Beatriz, tirados da sua planilha). Depois você gerencia tudo pela tela **Clínicas** do painel.

### 1.4 Ligar o login anônimo (é o que permite o cliente enviar sem cadastro)
1. **Authentication** → **Sign In / Providers**.
2. Ative **Allow anonymous sign-ins**.
3. Deixe **Allow new users to sign up** como está (ligado). Uma conta criada por esse caminho **não tem nenhuma permissão**: o acesso de equipe depende de estar cadastrada na tela Equipe **e** ter MFA.

### 1.5 Criar o seu usuário e torná-lo administrador
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Informe seu e-mail e uma senha forte. Marque a opção de **confirmar o e-mail automaticamente** (Auto Confirm User), se aparecer.
3. Volte ao **SQL Editor**, abra o `supabase/Supabase-completo.sql`, na Parte B troque `v_admin_email := null` pelo seu e-mail entre aspas (e `v_admin_nome` pelo seu nome) e clique em **Run**.
4. A mensagem `ADMIN: … liberado como administrador` aparece em *Messages*. Confira em **Table Editor → profiles**: 1 linha com `role = ADMIN`.

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
Com a função `admin-users` publicada (Parte 6), tudo é feito no painel:
1. **Equipe → Novo usuário**: e-mail, nome, papel e senha temporária (o botão de recarregar gera uma senha forte).
2. Entregue a senha à pessoa com segurança. Ela entra e pode trocá-la em **Alterar minha senha** (menu lateral).
3. Sem a função publicada, o caminho antigo continua valendo: crie o usuário em *Authentication → Users* e libere o acesso por e-mail na tela Equipe.

| Papel | O que pode |
|---|---|
| Admin | tudo, inclusive equipe, clínicas e auditoria |
| Product Owner | triagem, status, RICE, mesclar, arquivar, exportar, auditoria da solicitação |
| Suporte / CS | ver (com dados pessoais), vincular clínica, comentar (interno e público) |
| Dev (visualizador) | só leitura com nome/telefone **mascarados** e comentário técnico interno |

**Para desligar alguém, use “Desativar” na tela Equipe. Não apague o usuário no Supabase:** o banco impede, de propósito, apagar quem já comentou em solicitações, para não perder o histórico.

---

## Parte 5 — Recursos opcionais da versão 2

> **Se você já tinha a versão 1 no ar:** rode de novo o arquivo `supabase/Supabase-completo.sql` inteiro no SQL Editor (ele é seguro para repetir e não apaga dados) e publique o site novamente.

### 5.1 E-mails automáticos (Resend + função `notify`)
1. Crie conta em resend.com, **verifique o seu domínio** (Domains) e crie uma **API key**.
2. No Supabase: **Edge Functions → Deploy a new function → Via Editor**, nome `notify`, cole o conteúdo de `supabase/functions/notify/index.ts`. **Desligue "Enforce JWT verification"** (o banco chama a função sem login; quem protege é o segredo).
3. Em **Edge Functions → Secrets**, cadastre: `WEBHOOK_SECRET` (frase longa e aleatória), `RESEND_API_KEY`, `MAIL_FROM` (ex.: `Conceive <contato@seudominio.com.br>`), `TEAM_EMAILS` (e-mails da equipe, separados por vírgula) e `SITE_URL` (endereço do site no GitHub Pages).
4. Em **Database → Extensions**, confirme que `pg_net` está ligada.
5. No `supabase/Supabase-completo.sql`, Parte B, preencha `v_notify_url` e `v_notify_secret` (o mesmo segredo do passo 3) e rode o arquivo de novo.
6. Teste: envie uma solicitação com e-mail. O cliente recebe o link; a equipe recebe o aviso.

### 5.2 Criar tarefa no Redmine/Pipefy (função `external-task`)
1. Publique a função `external-task` (conteúdo de `supabase/functions/external-task/index.ts`) com **"Enforce JWT verification" LIGADO**.
2. Secrets do Redmine: `REDMINE_URL`, `REDMINE_API_KEY`, `REDMINE_PROJECT_ID` (e opcional `REDMINE_TRACKER_ID`).
3. Secrets do Pipefy: `PIPEFY_TOKEN`, `PIPEFY_PIPE_ID` (opcionais: `PIPEFY_TITLE_FIELD_ID`, `PIPEFY_DESC_FIELD_ID`).
4. No detalhe da solicitação aparecem os botões **Criar tarefa no Redmine/Pipefy** (perfis que podem exportar para Dev).

**Conferindo se os e-mails saem:** no painel, **Equipe → E-mails automáticos** mostra os últimos 30 envios, se deram certo e o motivo provável quando falham (por exemplo, HTTP 401 = segredo diferente entre o banco e a função).

### 5.2b Alerta de solicitações paradas (SLA)
Não precisa configurar nada: o painel já marca em vermelho **sem resposta** (Recebido há mais de 3 dias sem resposta da equipe, ou cliente respondeu e a equipe não voltou) e **parada** (Em análise ou Em desenvolvimento sem movimentação há mais de 15 dias). Use o filtro **Atraso** na lista; a tela **Métricas** mostra o total. Pedidos concluídos, arquivados, mesclados ou importados da planilha antiga não entram na conta.
- **Resumo diário por e-mail (opcional):** troque `v_cron_sla := true` na Parte B do `Supabase-completo.sql` (precisa de `pg_cron` e dos e-mails já configurados). Para mudar os prazos, veja o comentário no topo do arquivo.
- Os prazos contam dias corridos, não dias úteis.

### 5.3 Roadmap público e votos
No detalhe de uma solicitação, marque **Mostrar no roadmap público** (Admin e PO). Só o título e a descrição ficam visíveis, sem nome nem contato. **Confira se não há dados de pacientes antes de publicar.**

### 5.4 Importar a planilha antiga
Entre como Admin → **Importar** → envie o CSV exportado do Google Planilhas (*Arquivo → Fazer download → .csv*). Confira as colunas, veja a prévia e importe. Os registros importados não geram e-mails.

---

## Parte 6 — Criar e editar usuários dentro do painel (versão 3)

1. No Supabase: **Edge Functions → Deploy a new function → Via Editor**, nome `admin-users`, cole `supabase/functions/admin-users/index.ts`. Deixe **"Enforce JWT verification" LIGADO**. A chave `SUPABASE_SERVICE_ROLE_KEY` já é fornecida automaticamente pelo Supabase; não a coloque no site nem no GitHub.
2. A função só age se quem chama for Admin (ela confere no banco antes de usar a chave de serviço).
3. Senha: de 10 a 72 caracteres, com letras e números.
4. Em **Equipe → Editar**: trocar nome, papel, ativar/desativar, redefinir a senha e controlar o autenticador.

### Entrada com autenticador (MFA) controlada pelo Admin
- **Equipe → Entrada com autenticador**: chave geral. Ligada (padrão), todos usam senha + código do aplicativo. Desligada, quem tem a senha entra direto. **Desligar reduz a segurança**; use só em emergência ou em testes.
- **Dispensar por usuário**: em *Editar*, marque "Dispensar o autenticador".
- **Redefinir autenticador**: remove o aplicativo cadastrado (celular perdido); a pessoa cadastra outro no próximo acesso.
- Tudo isso fica na auditoria.

### Outras edições
- Solicitações: botão **Editar dados da solicitação** (Admin e PO).
- Clínicas: **Renomear** clínica e unidade; **remover unidade** (só se nenhuma solicitação a usa).

---

## Parte 4 — Manutenção

- **Limpeza mensal:** automática com `v_cron_limpeza := true` na Parte B (precisa ligar a extensão `pg_cron`). Sem isso, use `v_limpar_agora := true` uma vez por mês. Cada cliente que envia um pedido vira um usuário anônimo e o Supabase não limpa isso sozinho. Os links de acompanhamento **continuam funcionando**.
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

- **358 verificações no banco** (mais a Parte B ligada: admin, clínicas, e-mails e limpeza de anônimos): permissões de cada papel, RLS, mascaramento LGPD, auditoria (antes/depois, IP, autor), imutabilidade da trilha, bloqueio de DELETE, protocolo sequencial, rate limit, limites de anexos, mesclagem, RICE, exportação, MFA obrigatório (aal2) e idempotência da migração; e na versão 2: votos, roadmap público, respostas do cliente, CSAT, métricas, importação e o envio do webhook de e-mail (com um `pg_net` simulado).
- **39 testes de contrato**: o `src/lib/api.ts` do site rodando contra esse banco, em cada papel.
- **40 testes das Edge Functions** (e-mail, tarefas Redmine/Pipefy e criação de usuários) com um `fetch` simulado.
- **31 testes unitários**: rascunho, importação de CSV, tema, telefone, validação, CSV seguro, anexos (limite de 50 MB exato, nome do print colado) e comparação automática dos enums e DDDs do site com os do SQL.
- **59 verificações de ponta a ponta em navegador real (Chromium)**: abas do site, colar print (Ctrl + V), arrastar arquivo, recusa acima de 50 MB, cliente envia e acompanha, PO/Dev/Admin entram com MFA, lista, filtros, modal, comentários, Kanban com arrastar, mesclagem, CSV, arquivar e gestão de clínicas/equipe; mais rascunho após recarregar, roadmap e votos, resposta do cliente, tarefa externa, avaliação, métricas, importação de CSV, tema e CSP sem violações.

**Não foi possível testar aqui** (exige internet e as suas contas):
- O `npm install` + `vite build` reais (o ambiente não tinha rede): validei a compilação com esbuild e os tipos com declarações simplificadas. O primeiro *build* no GitHub é o teste final; se acusar algum erro de tipo, ele aparece no log da aba Actions.
- **A função `admin-users` contra o Auth real do Supabase**: testada com um Auth simulado. Se a criação falhar, veja os logs da função.
- **Resend, Redmine e Pipefy reais**: as Edge Functions foram testadas só com respostas simuladas. A API do Pipefy (GraphQL) muda com frequência; se der erro, o log da função mostra a resposta.
- **A CSP contra o Turnstile real.** Se o formulário travar depois de publicar, crie a variável `CSP_DESATIVADA` = `true` no GitHub (Settings → Variables) e publique de novo.
- A comunicação com o Supabase de verdade (substituída por um banco local equivalente), o widget do Turnstile e o envio real de arquivos ao Storage (inclusive o de 50 MB). O Ctrl + V foi testado com o evento de colar simulado, não com a área de transferência real do Windows.
- A tela do GitHub Pages e do painel do Supabase: os nomes dos menus acima seguem a documentação oficial, mas podem mudar de lugar.

## Limites conhecidos
- O IP na auditoria vem dos cabeçalhos da requisição (`cf-connecting-ip` / `x-forwarded-for`) e é **informativo**, não prova forense.
- Redmine/Pipefy: a tarefa é criada pelo painel e o ID é guardado, mas o status **não volta** automaticamente para o Conceive.
- Sem e-mail configurado (Parte 5), o recurso simplesmente não envia nada; o resto funciona igual.
- A CSP é aplicada por `<meta>` (o GitHub Pages não permite cabeçalhos HTTP); `frame-ancestors` não funciona assim, por isso há também um bloqueio por script contra iframe.
- O aviso ao cliente é um link `wa.me` (abre o WhatsApp com a mensagem pronta); não é a API oficial.
- Kanban mostra até 200 cartões por vez (use os filtros).
- A planilha antiga é importada por você, em **Importar** (CSV). Repetir o mesmo arquivo não duplica.

Fontes: [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [API keys](https://supabase.com/docs/guides/api/api-keys), [MFA TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [GitHub Pages com Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
