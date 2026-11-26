# Conceive Requests

Sistema de solicitações de funcionalidades e melhorias (substitui Google Forms + Sheets).
**Site estático** (GitHub Pages) + **Supabase** (Postgres, Auth, Storage). Sem servidor próprio.

👉 **Para publicar: leia [`PASSO_A_PASSO.md`](./PASSO_A_PASSO.md).**

## Como funciona

```
Cliente (sem cadastro)                         Equipe (e-mail + senha + MFA)
        │                                                │
        ▼                                                ▼
┌─────────────────────────────── GitHub Pages ───────────────────────────────┐
│  React (Vite)  ·  #/solicitar  #/acompanhar  #/comunidade  #/login  #/admin │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ supabase-js (chave pública) — só chama funções RPC
                ▼
┌──────────────────────────────── Supabase ──────────────────────────────────┐
│ Auth: sessão anônima (cliente) + senha/MFA TOTP (equipe)  · Turnstile      │
│ Postgres: RPCs SECURITY DEFINER ──► checam permissão ──► mascaram PII ──►  │
│           gravam auditoria; RLS; triggers; audit_logs imutável             │
│ Storage: bucket privado "attachments" (50 MB, só tipos permitidos)         │
│ Edge Functions: notify (e-mail via Brevo/Resend) · external-task + external-sync (Redmine/Pipefy)│
└────────────────────────────────────────────────────────────────────────────┘
```

**Por que foi refeito em relação à versão Next.js:** o GitHub Pages só serve arquivos estáticos. Não existem Server Actions, middleware, rotas de API nem Prisma lá. Toda a regra de negócio e segurança (RBAC, auditoria, mascaramento, rate limit, protocolo) agora vive **dentro do Postgres**, onde não dá para burlar pelo navegador.

## Recursos da versão 2
- **Rascunho automático** da solicitação (neste navegador, 7 dias; anexos não são guardados).
- **E-mail obrigatório** do cliente: recebe a confirmação formal com o link de acompanhamento e avisos de andamento; a equipe recebe aviso de nova solicitação e de resposta do cliente.
- **Comentários com imagens** (Ctrl + V ou arquivo): ficam dentro do comentário, não na solicitação.
- **Roadmap público** (`#/comunidade`) com votação "Também preciso disso" — só entra o que o PO/Admin publicar; sem dados pessoais.
- **Respostas do cliente** na página de acompanhamento (com anexos) e **pesquisa de satisfação** (1 a 5 estrelas) ao concluir.
- **Métricas** (volume, tempos, satisfação, apoios) e **importação** da planilha antiga em CSV (admin).
- **Criar tarefa no Redmine/Pipefy** direto do detalhe da solicitação.
- **Status do Redmine/Pipefy de volta ao Conceive** (função `external-sync`, a cada 10 min ou pelo botão "Sincronizar status agora"), com mapeamento editável.
- **Pedidos parecidos** sugeridos no formulário (só do roadmap público), para reduzir duplicidade.
- **Tema** automático/claro/escuro, link "Pular para o conteúdo", **CSP** e proteção contra iframe.

## Segurança em camadas
1. **Nenhuma tabela é acessível diretamente** por `anon`/`authenticated` (exceto leitura de clínicas/auditoria para a equipe via RLS). Tudo passa por RPCs.
2. **MFA obrigatório**: sem o claim `aal2` no JWT, ninguém tem papel de equipe, nem o Admin.
3. **RBAC no banco** (`role_permissions`): `private.require('permissão')` em cada função.
4. **LGPD**: nome/telefone mascarados sem `pii:view`; ver dado sensível gera `VIEW_SENSITIVE`; exportação não inclui dados pessoais e gera `EXPORT`.
5. **Auditoria imutável**: triggers gravam antes/depois, autor, IP e user-agent; `UPDATE/DELETE/TRUNCATE` em `audit_logs` são bloqueados; solicitações nunca são apagadas (soft delete).
6. **Acompanhamento sem login**: token aleatório de 192 bits (o protocolo `CON-2026-0088` é sequencial e adivinhável, por isso não é usado no link). A página pública só devolve status, título, módulo e respostas públicas.
7. **Anti-abuso**: Turnstile, limite de 5 envios/10 min e 30/dia por sessão, honeypot, limite de 50 anexos por sessão, bucket restrito por tipo e tamanho.

## Estrutura

```
supabase/Supabase-completo.sql   TODO o banco em um arquivo único (+ opcionais na Parte B)   ← rodar no SQL Editor
supabase/functions/              notify (Brevo/Resend), external-task e external-sync (Redmine/Pipefy) e admin-users (criar usuários)
scripts/apply-csp.mjs            Insere a Content-Security-Policy no build
supabase/tests/                  Mock do Supabase + suíte de testes do banco
src/lib/                         api.ts (RPCs), validação, telefone, CSV, auth, roteador
src/components/                  PublicShell (cabeçalho com abas), AttachmentPicker (Ctrl+V, arrastar, escolher)
src/pages/                       Solicitar, Acompanhar, Login, admin/ (Dashboard, Kanban, Detalhe, Auditoria, Clínicas, Equipe)
tests/                           unit · contract · e2e (Chromium)
.github/workflows/               deploy.yml (Pages) · tests.yml (CI com Postgres)
```

## Desenvolvimento local
```bash
cp .env.example .env.local     # preencha URL e chave do Supabase
npm install
npm run dev
```

## Testes
```bash
npm run typecheck
npm run test:unit
npm run test:functions
# Os de banco/contrato precisam de um Postgres LOCAL descartável com usuário superuser
# (NUNCA aponte para o seu projeto Supabase):
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:contract
# E2E em navegador real (npx playwright install chromium):
PSQL_CMD="psql -h localhost -U postgres" npm run test:e2e
```
No GitHub, o fluxo **Testes** roda tipos + unitários + banco + contrato a cada envio.
