// Teste de contrato: roda src/lib/api.ts (o MESMO código do app) contra um Postgres real com a migração aplicada.
// Cobre nomes de parâmetros das RPCs, formatos de resposta, mensagens de erro e permissões por papel.
//
//   PSQL_CMD="psql -h localhost -U postgres" npm run test:contract     (usuário superuser)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, fakeClient, fakePasswords, type FakeState } from "./fake-supabase";
import * as api from "../src/lib/api";
import { EXPORT_COLUMNS, toCsv } from "../src/lib/csv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const ID = {
  admin: "a0000000-0000-0000-0000-000000000001",
  po: "a0000000-0000-0000-0000-000000000002",
  support: "a0000000-0000-0000-0000-000000000003",
  dev: "a0000000-0000-0000-0000-000000000004",
  clinicK: "c0000000-0000-0000-0000-000000000001",
  unitK: "d0000000-0000-0000-0000-000000000001",
};

let n = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    n++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    process.exit(1);
  }
}
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => re.test(e.message) || (console.error("mensagem recebida:", e.message), false));

// ───────── ambiente ─────────
const db = new Db(process.env.CONTRACT_DB ?? "conceive_contract");
db.recreate();
db.file(read("supabase/tests/mock_supabase.sql"));
db.file(read("supabase/Supabase-completo.sql"));
db.sql(`
  insert into auth.users (id, email) values
    ('${ID.admin}','admin@x.com'), ('${ID.po}','po@x.com'), ('${ID.support}','support@x.com'),
    ('${ID.dev}','dev@x.com'), ('a0000000-0000-0000-0000-000000000009','novo@x.com');
  insert into public.profiles (id, email, name, role) values
    ('${ID.admin}','admin@x.com','Ana Admin','ADMIN'), ('${ID.po}','po@x.com','Paulo PO','PO'),
    ('${ID.support}','support@x.com','Sueli Suporte','SUPPORT'), ('${ID.dev}','dev@x.com','Davi Dev','DEV_VIEWER');
  insert into public.clinics (id, name) values ('${ID.clinicK}', 'Kardiomov'), ('c0000000-0000-0000-0000-000000000002', 'Med Clínica Goianinha');
  insert into public.clinic_units (id, clinic_id, name) values ('${ID.unitK}', '${ID.clinicK}', 'Unidade 1');
`);

// linhas de auditoria geradas pelas fixtures (inseridas como superuser, sem autor/IP) — linha de base
const baseNullUser = Number(db.sql(`select count(*) from public.audit_logs where user_id is null`).trim());
const baseNullIp = Number(db.sql(`select count(*) from public.audit_logs where ip_address is null`).trim());

const state: FakeState = { identity: null, requireCaptcha: true };
api.setClient(fakeClient(db, state));
const as = (who: keyof typeof ID, aal: "aal1" | "aal2" = "aal2") => {
  state.identity = { uid: ID[who], aal, anon: false };
};
const visitor = () => {
  state.identity = null;
};

const base = {
  clinicId: ID.clinicK,
  unitId: ID.unitK,
  pendingClinicName: null,
  requesterName: "Sarah Silva",
  email: "sarah@clinica.com",
  requesterRole: "ADMINISTRADOR",
  whatsapp: "(84) 99849-3000",
  module: "FINANCEIRO",
  type: "MELHORIA_FLUXO",
  title: "Pagamento antecipado de percentual de consulta",
  description: "Definimos que iremos solicitar aos nossos pacientes um percentual antecipado.",
};

(async () => {
  let tracking = "";
  let reqId = "";
  let protocol = "";

  console.log("cliente final (sessão anônima)");
  await step("sem sessão, busca de clínicas é negada com mensagem amigável", async () => {
    visitor();
    await rejects(api.searchClinics("kardio"), /permissão|sessão/i);
  });
  await step("ensureSession exige o token do Turnstile quando o CAPTCHA está ativo", async () => {
    visitor();
    await rejects(api.ensureSession(undefined), /anti-robô/i);
    assert.equal(state.identity, null);
  });
  await step("ensureSession cria sessão anônima com o token", async () => {
    const uid = await api.ensureSession("turnstile-ok");
    assert.match(uid, /^[0-9a-f-]{36}$/);
    assert.equal(state.identity?.anon, true);
    assert.equal(await api.ensureSession(), uid, "reaproveita a sessão existente");
    assert.equal(await api.hasSession(), true);
  });
  await step("autocomplete de clínicas e unidades", async () => {
    assert.equal((await api.searchClinics("ka")).length, 0);
    const found = await api.searchClinics("KARDIÓ");
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Kardiomov");
    const units = await api.listUnits(found[0].id);
    assert.deepEqual(units.map((u) => u.name), ["Unidade 1"]);
  });
  await step("envio com anexo: devolve protocolo e token", async () => {
    const r = await api.submitRequest(base, [{ name: "print da tela é ótimo.png", type: "image/png", size: 2048 }]);
    assert.match(r.protocol, /^CON-\d{4}-\d{4}$/);
    assert.match(r.trackingToken, /^[0-9a-f]{48}$/);
    tracking = r.trackingToken;
    protocol = r.protocol;
  });
  await step("anexo com tipo proibido ou grande demais é recusado antes de criar a solicitação", async () => {
    await rejects(api.submitRequest(base, [{ name: "virus.exe", type: "application/x-msdownload", size: 10 }]), /anexo/i);
    await rejects(api.submitRequest(base, [{ name: "enorme.mp4", type: "video/mp4", size: 50 * 1024 * 1024 + 1 }]), /anexo/i);
    assert.equal(db.sql(`select file_size_limit from storage.buckets where id = 'attachments'`).trim(), "52428800", "bucket aceita até 50 MB");
    const total = db.sql(`select count(*) from public.requests`).trim();
    assert.equal(total, "1", "nenhuma solicitação extra criada");
  });
  await step("validações do servidor viram mensagens amigáveis", async () => {
    await rejects(api.submitRequest({ ...base, whatsapp: "123" }), /WhatsApp inválido/);
    await rejects(api.submitRequest({ ...base, title: "abc" }), /Título inválido/);
    await rejects(api.submitRequest({ ...base, clinicId: null, unitId: null }), /clínica/i);
    await rejects(api.submitRequest({ ...base, clinicId: "c0000000-0000-0000-0000-0000000000ff" }), /Clínica inválida/);
  });
  await step("modo 'minha clínica não está na lista' grava nome pendente", async () => {
    const r = await api.submitRequest({
      ...base, clinicId: null, unitId: null, pendingClinicName: "Hospital de Olhos de Parnamirim",
      requesterName: "Renata", requesterRole: "FARMACEUTICO", whatsapp: "84 987417184",
      module: "ESTOQUE_FARMACIA", type: "NOVA_FUNCIONALIDADE", title: "Adicionar Marcas",
      description: "Solicito adicionar na aba de adicionar um produto a opção de marca.",
    });
    assert.match(r.protocol, /^CON-/);
  });
  await step("rate limit: 6º envio em 10 min é bloqueado", async () => {
    // já foram 2 envios válidos nesta sessão; mais 3 passam, o próximo falha
    for (let i = 0; i < 3; i++) await api.submitRequest({ ...base, title: `Envio extra número ${i}` });
    await rejects(api.submitRequest({ ...base, title: "Envio que deve falhar" }), /Muitas solicitações/);
  });

  console.log("acompanhamento público");
  await step("tracking sem login devolve só dados não sensíveis", async () => {
    visitor();
    const t = await api.getTracking(tracking);
    assert.ok(t);
    assert.equal(t.protocol, protocol);
    assert.equal(t.status, "RECEBIDO");
    assert.deepEqual(t.comments, []);
    assert.deepEqual(Object.keys(t).sort(), ["comments", "created_at", "csat_comment", "csat_score", "has_email", "module", "protocol", "status", "title", "type", "updated_at"]);
    assert.equal(await api.getTracking("0".repeat(48)), null);
    assert.equal(await api.getTracking("lixo"), null);
  });

  console.log("equipe sem MFA");
  await step("PO em aal1 não tem acesso a nada", async () => {
    as("po", "aal1");
    const ctx = await api.myContext();
    assert.equal(ctx.role, null);
    assert.equal(ctx.aal, "aal1");
    await rejects(api.listRequests({}), /permissão/i);
  });

  console.log("PO (aal2)");
  await step("contexto, lista com filtros e paginação", async () => {
    as("po");
    const ctx = await api.myContext();
    assert.equal(ctx.role, "PO");
    assert.ok(ctx.permissions.includes("report:export") && ctx.permissions.includes("pii:view"));
    const all = await api.listRequests({});
    assert.equal(all.total, 5);
    assert.equal(all.rows.length, 5);
    const one = await api.listRequests({ q: "Pagamento antecipado", status: "RECEBIDO", module: "FINANCEIRO", clinic_id: ID.clinicK, requester_role: "ADMINISTRADOR" });
    assert.equal(one.total, 1);
    assert.equal(one.rows[0].protocol, protocol);
    assert.equal(one.rows[0].requester_name, "Sarah Silva");
    assert.equal(one.rows[0].whatsapp, "+5584998493000");
    assert.equal(one.rows[0].pii_masked, false);
    assert.equal(one.rows[0].clinic_name, "Kardiomov");
    reqId = one.rows[0].id;
    const page = await api.listRequests({}, 2, 3);
    assert.equal(page.rows.length, 2, "5 itens, página 2 de tamanho 3 => 2 linhas");
    assert.equal(page.page, 2);
    assert.equal((await api.listRequests({ q: "   ", module: "" })).total, 5, "filtros vazios são ignorados");
    assert.equal((await api.listRequests({ q: "Parnamirim" })).total, 0, "busca não olha nome pendente (só título/protocolo/solicitante)");
  });
  await step("detalhe com anexo, auditoria e VIEW_SENSITIVE", async () => {
    const d = await api.getRequestDetail(reqId);
    assert.ok(d);
    assert.equal(d.clinic_name, "Kardiomov");
    assert.equal(d.unit_name, "Unidade 1");
    assert.equal(d.attachments.length, 1);
    assert.equal(d.attachments[0].file_name, "print_da_tela_e_otimo.png");
    assert.equal(d.attachments[0].mime_type, "image/png");
    assert.equal(d.attachments[0].size_bytes, 2048);
    assert.ok(d.audit && d.audit.some((a) => a.action === "CREATE") && d.audit.some((a) => a.action === "VIEW_SENSITIVE"));
    const created = d.audit.find((a) => a.action === "CREATE")!;
    assert.equal(created.ip, "198.51.100.7");
    assert.equal(await api.getRequestDetail("00000000-0000-0000-0000-000000000000"), null);
  });
  await step("URL assinada do anexo (equipe com MFA)", async () => {
    const d = (await api.getRequestDetail(reqId))!;
    const url = await api.signedAttachmentUrl(d.attachments[0].storage_path);
    assert.match(url, /^https:\/\/signed\.example\/attachments\//);
    as("po", "aal1");
    await rejects(api.signedAttachmentUrl(d.attachments[0].storage_path), /abrir o anexo/i);
    as("po");
  });
  await step("status, RICE, tags", async () => {
    await api.setStatus(reqId, "EM_ANALISE_PRODUTO");
    const score = await api.setPriority(reqId, "ALTA", 100, 2, 0.8, 4);
    assert.equal(score, 40);
    await rejects(api.setPriority(reqId, "ALTA", 100, 5, 0.8, 4), /fora do permitido/);
    await api.setTags(reqId, ["Financeiro", " urgente "]);
    const d = (await api.getRequestDetail(reqId))!;
    assert.equal(d.status, "EM_ANALISE_PRODUTO");
    assert.equal(d.priority, "ALTA");
    assert.equal(d.rice.score, 40);
    assert.deepEqual(d.tags, ["financeiro", "urgente"]);
    const upd = d.audit!.find((a) => a.action === "UPDATE" && a.previous?.status === "RECEBIDO" && a.next?.status === "EM_ANALISE_PRODUTO");
    assert.ok(upd, "mudança de status auditada com antes/depois");
    assert.match(upd.user, /Paulo PO/);
  });
  await step("comentário público aparece no acompanhamento; interno não", async () => {
    await api.addComment(reqId, "Olá! Pedido em análise pela equipe de produto.", false);
    await api.addComment(reqId, "cliente antigo — priorizar", true);
    visitor();
    const t = (await api.getTracking(tracking))!;
    assert.equal(t.status, "EM_ANALISE_PRODUTO");
    assert.equal(t.comments.length, 1);
    assert.match(t.comments[0].body, /em análise/);
    assert.ok(!JSON.stringify(t).includes("priorizar"));
    as("po");
    await rejects(api.addComment(reqId, "   ", true), /Comentário/);
  });
  await step("mesclar, desmesclar e vincular clínica", async () => {
    const list = await api.listRequests({ q: "Envio extra" });
    const [a, b] = list.rows;
    await api.mergeRequest(b.id, a.id);
    assert.equal((await api.getRequestDetail(a.id))!.duplicates.length, 1);
    assert.equal((await api.listRequests({ q: a.title })).rows.find((r) => r.id === a.id)!.duplicates_count, 1);
    await rejects(api.mergeRequest(a.id, a.id), /mesclar/);
    await api.unmergeRequest(b.id);
    assert.equal((await api.getRequestDetail(a.id))!.duplicates.length, 0);

    const pend = (await api.listRequests({ q: "Adicionar Marcas" })).rows[0];
    assert.equal(pend.pending_clinic_name, "Hospital de Olhos de Parnamirim");
    await api.linkClinic(pend.id, "c0000000-0000-0000-0000-000000000002", null);
    const d = (await api.getRequestDetail(pend.id))!;
    assert.equal(d.clinic_name, "Med Clínica Goianinha");
    assert.equal(d.pending_clinic_name, null);
  });
  await step("referência externa (Redmine/Pipefy)", async () => {
    await api.setExternalRef(reqId, "REDMINE", "#4521");
    const d = (await api.getRequestDetail(reqId))!;
    assert.equal(d.external_system, "REDMINE");
    assert.equal(d.external_id, "#4521");
    await rejects(api.setExternalRef(reqId, "JIRA", "1"), /Sistema externo inválido/);
  });
  await step("exportação: sem dados pessoais, auditada, CSV seguro", async () => {
    const rows = await api.exportRequests({ module: "FINANCEIRO" });
    assert.ok(rows.length >= 1);
    const csv = toCsv(rows, EXPORT_COLUMNS);
    assert.ok(csv.startsWith('"Protocolo","Título","Clínica","Módulo","Tipo","Status","Prioridade","RICE","Sistema externo","ID externo","Criado em"'));
    assert.ok(rows.every((r) => EXPORT_COLUMNS.every((c) => c in r)), "o banco devolve todas as colunas esperadas");
    assert.ok(!csv.includes("Sarah") && !csv.includes("+55"));
    const audit = db.sql(`select count(*) from public.audit_logs where action = 'EXPORT'`).trim();
    assert.equal(audit, "1");
  });
  await step("arquivar: some da lista e o cliente vê ARQUIVADO", async () => {
    const victim = (await api.listRequests({ q: "Envio extra número 2" })).rows[0];
    await api.archiveRequest(victim.id);
    assert.equal((await api.listRequests({ q: "Envio extra número 2" })).total, 0);
    await rejects(api.setStatus(victim.id, "CONCLUIDO"), /não encontrado/i);
  });
  await step("log_login registra LOGIN do PO", async () => {
    await api.logLogin();
    assert.equal(db.sql(`select count(*) from public.audit_logs where action = 'LOGIN'`).trim(), "1");
  });

  console.log("Suporte (aal2)");
  await step("vê dados pessoais e comenta, mas não muda status/prioridade/exporta/arquiva/mescla", async () => {
    as("support");
    const row = (await api.listRequests({ q: "Pagamento antecipado" })).rows[0];
    assert.equal(row.requester_name, "Sarah Silva");
    await api.addComment(reqId, "Falei com a cliente pelo WhatsApp.", true);
    await rejects(api.setStatus(reqId, "CONCLUIDO"), /permissão/);
    await rejects(api.setPriority(reqId, "BAIXA", 1, 1, 1, 1), /permissão/);
    await rejects(api.exportRequests({}), /permissão/);
    await rejects(api.archiveRequest(reqId), /permissão/);
    await rejects(api.mergeRequest(reqId, row.id), /permissão|mesclar/);
    const d = (await api.getRequestDetail(reqId))!;
    assert.equal(d.audit, null, "Suporte não recebe a trilha de auditoria");
  });

  console.log("Dev (aal2)");
  await step("dados pessoais mascarados, só leitura + comentário interno", async () => {
    as("dev");
    const row = (await api.listRequests({ module: "FINANCEIRO" })).rows[0];
    assert.equal(row.requester_name, "S**** S****");
    assert.equal(row.whatsapp, "(**) *****-3000");
    assert.equal(row.pii_masked, true);
    assert.equal((await api.listRequests({ q: "Sarah" })).total, 0);
    const d = (await api.getRequestDetail(reqId))!;
    assert.equal(d.requester_name, "S**** S****");
    assert.equal(d.whatsapp, "(**) *****-3000");
    assert.equal(d.audit, null);
    await api.addComment(reqId, "Nota técnica: verificar tabela de cobrança.", true);
    await rejects(api.addComment(reqId, "resposta pública", false), /permissão/);
    await rejects(api.setStatus(reqId, "CONCLUIDO"), /permissão/);
    await rejects(api.exportRequests({}), /permissão/);
    await rejects(api.adminListStaff(), /permissão/);
  });

  console.log("Admin (aal2)");
  await step("clínicas e unidades", async () => {
    as("admin");
    const id = await api.upsertClinic(null, "Clínica Nova do Admin", true);
    assert.match(id, /^[0-9a-f-]{36}$/);
    await api.addUnit(id, "Matriz");
    await rejects(api.upsertClinic(null, "clínica nova do admin", true), /Já existe/);
    await api.upsertClinic(id, "Clínica Nova do Admin", false);
    const clinics = await api.listClinicsAdmin();
    const c = clinics.find((x) => x.id === id)!;
    assert.equal(c.active, false);
    assert.deepEqual(c.clinic_units.map((u) => u.name), ["Matriz"]);
    assert.equal(clinics.length, 3);
  });
  await step("equipe: convidar, rebaixar e proteger o último admin", async () => {
    await api.adminUpsertStaff("novo@x.com", "Novo Dev", "DEV_VIEWER", true);
    const staff = await api.adminListStaff();
    assert.equal(staff.length, 5);
    assert.ok(staff.some((s) => s.email === "novo@x.com" && s.role === "DEV_VIEWER"));
    await rejects(api.adminUpsertStaff("naoexiste@x.com", "Fulano Teste", "PO", true), /Authentication → Users/);
    await rejects(api.adminUpsertStaff("admin@x.com", "Ana Admin", "PO", true), /último administrador/);
    as("po");
    await rejects(api.adminUpsertStaff("novo@x.com", "Novo Dev", "ADMIN", true), /permissão/);
    await rejects(api.upsertClinic(null, "Clínica do PO", true), /permissão/);
  });

  console.log("v2 — e-mail, roadmap, respostas, CSAT, métricas, importação");
  let t2 = "", id2 = "";
  await step("envio com e-mail: e-mail inválido é recusado; válido é guardado e mascarado para quem não vê PII", async () => {
    visitor();
    await api.ensureSession("turnstile-ok");
    await rejects(api.submitRequest({ ...base, email: "isso-nao-e-email" }), /e-mail/i);
    const r = await api.submitRequest({ ...base, title: "Roadmap: pedido com e-mail", email: "Cliente@Clinica.com" });
    t2 = r.trackingToken;
    as("po");
    id2 = (await api.listRequests({ q: r.protocol }, 1, 5)).rows[0].id;
    assert.equal((await api.getRequestDetail(id2))!.requester_email, "cliente@clinica.com");
    as("dev");
    assert.notEqual((await api.getRequestDetail(id2))!.requester_email, "cliente@clinica.com");
  });
  await step("só quem tem permissão publica; roadmap público não traz dados pessoais", async () => {
    as("dev");
    await rejects(api.setRequestPublic(id2, true), /permissão/);
    as("po");
    await api.setRequestPublic(id2, true);
    visitor();
    const pub = await api.listPublicRequests("", "", 1);
    const row = pub.rows.find((r) => r.id === id2)!;
    assert.ok(row);
    assert.ok(!JSON.stringify(pub).includes("Sarah") && !JSON.stringify(pub).includes("99849") && !JSON.stringify(pub).includes("clinica.com"));
    assert.equal((await api.listPublicRequests("e-mail", "", 1)).rows.length, 1, "busca por texto");
    assert.equal((await api.listPublicRequests("", "AGENDA", 1)).rows.length, 0, "filtro por módulo");
  });
  await step("votos: outra pessoa apoia, remove e repete (autor bloqueado: coberto nos testes do banco)", async () => {
    state.identity = { uid: "b0000000-0000-0000-0000-000000000077", aal: "aal1", anon: true };
    assert.equal(await api.voteRequest(id2), 1);
    assert.equal(await api.voteRequest(id2), 1, "repetir não soma");
    assert.equal((await api.listPublicRequests("", "", 1)).rows.find((r) => r.id === id2)!.voted_by_me, true);
    assert.equal(await api.unvoteRequest(id2), 0);
    assert.equal(await api.voteRequest(id2), 1);
  });
  await step("resposta do cliente com anexo aparece para a equipe; texto vazio é recusado", async () => {
    visitor();
    await api.ensureSession("turnstile-ok");
    await rejects(api.addClientComment("0".repeat(48), "oi tudo bem", []), /./);
    await api.addClientComment(t2, "Mais um detalhe importante do caso.", [{ name: "foto.png", type: "image/png", size: 100 }]);
    as("po");
    const d = (await api.getRequestDetail(id2))!;
    const c = d.comments.find((x) => x.body.startsWith("Mais um detalhe"))!;
    assert.equal(c.author_kind, "CLIENT");
    assert.equal(c.is_internal, false);
    assert.ok((await api.listRequests({ q: "Roadmap" }, 1, 5)).rows[0].awaiting_reply);
  });
  await step("CSAT: só depois de concluir; nota de 1 a 5; pode alterar", async () => {
    visitor();
    await api.ensureSession("turnstile-ok");
    await rejects(api.rateRequest(t2, 5, null), /concluíd|avali/i);
    as("po");
    await api.setStatus(id2, "CONCLUIDO");
    visitor();
    await api.ensureSession("turnstile-ok");
    await rejects(api.rateRequest(t2, 9, null), /nota/i);
    await api.rateRequest(t2, 3, "Demorou");
    await api.rateRequest(t2, 5, " Ótimo ");
    const t = await api.getTracking(t2);
    assert.equal(t?.csat_score, 5);
    assert.equal(t?.csat_comment, "Ótimo");
    as("po");
    assert.equal((await api.getRequestDetail(id2))!.csat.score, 5);
  });
  await step("métricas: perfis autorizados veem; Dev não", async () => {
    as("po");
    const m = await api.getMetrics(90);
    assert.ok(m.total >= 2 && m.completed >= 1);
    assert.equal(m.csat.count, 1);
    assert.equal(m.csat.avg, 5);
    assert.ok(m.votes_total >= 1);
    assert.equal(m.weekly.length, 12);
    assert.ok(!JSON.stringify(m).includes("Sarah"));
    as("dev");
    await rejects(api.getMetrics(90), /permissão/);
  });
  await step("importação: só admin; repetir não duplica; linha ruim vira erro, não derruba o lote", async () => {
    const row = (k: string, extra = {}) => ({ key: k, created_at: "2025-03-12T14:30:00-03:00", clinic: "Kardiomov", unit: "", name: "Marta Souza", role: "RECEPCIONISTA", whatsapp: "(84) 99999-1111", module: "AGENDA", type: "NOVA_FUNCIONALIDADE", title: `Importada ${k}`, description: "Descrição importada com mais de vinte caracteres", status: "CONCLUIDO", email: "", ...extra });
    as("po");
    await rejects(api.importRequests([row("k1")]), /permissão/);
    as("admin");
    const r1 = await api.importRequests([row("k1"), row("k2", { whatsapp: "sem telefone" }), row("k3", { status: "INEXISTENTE" })]);
    assert.equal(r1.inserted, 2);
    assert.equal(r1.errors.length, 1);
    const r2 = await api.importRequests([row("k1"), row("k2")]);
    assert.equal(r2.inserted, 0);
    assert.equal(r2.skipped, 2);
    const list = await api.listRequests({ q: "Importada k2" }, 1, 5);
    assert.equal(list.rows.length, 1);
    assert.ok((await api.getRequestDetail(list.rows[0].id))!.tags.includes("telefone-invalido"));
    await rejects(api.importRequests(Array.from({ length: 201 }, (_, i) => row(`m${i}`))), /200/);
  });
  await step("registro de e-mails: só Admin lê; vazio quando não há e-mail configurado", async () => {
    as("po");
    await rejects(api.adminNotifyLog(10), /permissão/);
    as("admin");
    assert.deepEqual(await api.adminNotifyLog(10), []);
  });
  await step("usuários: Admin cria pelo painel (função admin-users), a senha vale e o e-mail repetido é recusado", async () => {
    as("po");
    await rejects(api.createStaffUser({ email: "x@x.com", name: "X Y", role: "SUPPORT", password: "senhaforte123" }), /permiss|negad|admin/i);
    as("admin");
    await rejects(api.createStaffUser({ email: "novo1@x.com", name: "Novo Um", role: "SUPPORT", password: "curta" }), /senha/i);
    const r = await api.createStaffUser({ email: "novo1@x.com", name: "Novo Um", role: "SUPPORT", password: "senhaforte123" });
    assert.ok(r.user_id);
    assert.equal(fakePasswords.get(r.user_id), "senhaforte123");
    const st = (await api.adminListStaff()).find((m) => m.email === "novo1@x.com")!;
    assert.equal(st.role, "SUPPORT");
    assert.equal(st.mfa_enrolled, false);
    await rejects(api.createStaffUser({ email: "novo1@x.com", name: "Novo Um", role: "SUPPORT", password: "senhaforte123" }), /já|existe|cadastrad/i);
    await api.setStaffPassword(r.user_id, "outrasenha456");
    assert.equal(fakePasswords.get(r.user_id), "outrasenha456");
  });
  await step("minha senha: exige sessão e 10+ caracteres", async () => {
    as("admin");
    await rejects(api.changeMyPassword("curta"), /10 caracteres/);
    await api.changeMyPassword("minhasenha123");
    assert.equal(fakePasswords.get(ID.admin), "minhasenha123");
  });
  await step("autenticador: só Admin altera; com MFA desligado o login simples já vale como equipe", async () => {
    as("po");
    await rejects(api.adminGetSecurity(), /permissão/);
    await rejects(api.adminSetMfaRequired(false), /permissão/);
    as("po", "aal1");
    assert.equal((await api.myContext()).role, null, "com MFA exigido, aal1 não é equipe");
    as("admin");
    assert.equal((await api.adminGetSecurity()).mfa_required, true);
    await api.adminSetMfaRequired(false);
    as("po", "aal1");
    const c = await api.myContext();
    assert.equal(c.role, "PO");
    assert.equal(c.mfa_required, false);
    as("admin");
    await api.adminSetMfaRequired(true);
    as("po", "aal1");
    assert.equal((await api.myContext()).role, null);
    as("admin");
    await api.adminSetUserMfa(ID.po, true);
    as("po", "aal1");
    assert.equal((await api.myContext()).role, "PO", "usuário dispensado entra só com a senha");
    as("admin");
    await api.adminSetUserMfa(ID.po, false);
    db.sql(`insert into auth.mfa_factors (user_id, status, factor_type) values ('${ID.po}','verified','totp')`);
    assert.equal((await api.adminListStaff()).find((m) => m.id === ID.po)!.mfa_enrolled, true);
    assert.equal(await api.adminResetMfa(ID.po), 1);
    assert.equal((await api.adminListStaff()).find((m) => m.id === ID.po)!.mfa_enrolled, false);
  });
  await step("edição: solicitação, nome da unidade e remoção de unidade", async () => {
    as("support");
    await rejects(api.updateRequestFields(id2, { title: "Novo título válido" }), /permissão/);
    as("po");
    await api.updateRequestFields(id2, { title: "Título corrigido pelo PO", requester_phone: "(84) 98888-7777" });
    const d = (await api.getRequestDetail(id2))!;
    assert.equal(d.title, "Título corrigido pelo PO");
    await rejects(api.updateRequestFields(id2, { title: "ab" }), /título/i);
    as("admin");
    await api.renameUnit(ID.unitK, "Unidade Central");
    await rejects(api.deleteUnit(ID.unitK), /em uso|solicita/i);
    const u = await api.addUnit(ID.clinicK, "Temporária");
    await api.deleteUnit(u);
  });
  await step("e-mail obrigatório no envio; comentário da equipe com imagem fica no comentário", async () => {
    visitor();
    await api.ensureSession("turnstile-ok");
    await rejects(api.submitRequest({ ...base, title: "Pedido sem e-mail algum", email: "" }), /Informe o seu e-mail/);
    as("po");
    const cid = await api.addComment(id2, "Segue o print do ajuste", true, [{ name: "print ajuste.png", type: "image/png", size: 2048 }]);
    assert.ok(cid);
    const d = (await api.getRequestDetail(id2))!;
    const c = d.comments.find((x) => x.id === cid)!;
    assert.equal(c.attachments.length, 1);
    assert.equal(c.attachments[0].file_name, "print_ajuste.png");
    assert.ok(!d.attachments.some((a) => a.file_name === "print_ajuste.png"), "não entra nos anexos da solicitação");
    await rejects(api.addComment(id2, "texto", true, Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.png`, type: "image/png", size: 10 }))), /5 anexos/);
  });
  await step("tarefa externa: sem funções disponíveis, a mensagem é amigável", async () => {
    as("po");
    await rejects(api.createExternalTask(id2, "REDMINE"), /indispon|integra/i);
  });

  console.log("integridade final");
  await step("trilha: toda mutação deixou rastro e nada foi apagado", async () => {
    const q = (s: string) => db.sql(s).trim();
    assert.equal(q(`select count(*) from public.requests where deleted_at is not null`), "1");
    assert.ok(Number(q(`select count(*) from public.audit_logs`)) > 30);
    assert.equal(Number(q(`select count(*) from public.audit_logs where user_id is null`)), baseNullUser, "toda ação da aplicação tem autor (inclusive a sessão anônima)");
    assert.equal(Number(q(`select count(*) from public.audit_logs where ip_address is null`)), baseNullIp, "todo evento da aplicação tem IP");
  });

  console.log(`\n${n} testes de contrato passaram`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
