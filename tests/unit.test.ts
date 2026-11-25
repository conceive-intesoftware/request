// Testes unitários e checagens cruzadas front ↔ migração SQL.  Rodar: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DDD_VALIDOS, formatPhoneBR, maskPhoneInput, normalizeBrPhone, whatsappLink } from "../src/lib/phone";
import { toCsv } from "../src/lib/csv";
import { validateRequestForm, type RequestFormValues } from "../src/lib/validate";
import { addFiles, filesFromClipboard, pastedName } from "../src/lib/attachments";
import { MODULES, PRIORITIES, REQUESTER_ROLES, STATUSES, STAFF_ROLES, TYPES, MAX_FILE_MB, labelOf } from "../src/lib/labels";
import { friendlyMessage } from "../src/lib/api";
import { DRAFT_KEY, DRAFT_TTL_MS, clearDraft, isEmptyDraft, loadDraft, saveDraft, type Draft } from "../src/lib/draft";
import { FIELDS, REQUIRED, buildRows, detectColumns, mapModule, mapRole, mapStatus, mapType, norm, parseCsv, parseDate } from "../src/lib/importer";
import { nextTheme } from "../src/lib/theme";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(resolve(root, "supabase/Supabase-completo.sql"), "utf8");

let n = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    n++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    process.exit(1);
  }
}

console.log("telefone");
test("normaliza formatos reais da planilha", () => {
  assert.equal(normalizeBrPhone("84998493000"), "+5584998493000");
  assert.equal(normalizeBrPhone("84 987417184"), "+5584987417184");
  assert.equal(normalizeBrPhone("(84) 99849-3000"), "+5584998493000");
  assert.equal(normalizeBrPhone("+55 (84) 99849-3000"), "+5584998493000");
  assert.equal(normalizeBrPhone("5584998493000"), "+5584998493000");
  assert.equal(normalizeBrPhone("(84) 3211-4455"), "+558432114455");
});
test("rejeita inválidos", () => {
  for (const bad of ["", "123", "(10) 99999-9999", "(84) 89999-9999", "abc", "84 9984930001"]) {
    assert.equal(normalizeBrPhone(bad), null, bad);
  }
});
test("DDD 55 (RS) com 11 dígitos não é confundido com DDI", () => {
  assert.equal(normalizeBrPhone("55999999999"), "+5555999999999");
});
test("máscara progressiva", () => {
  assert.equal(maskPhoneInput(""), "");
  assert.equal(maskPhoneInput("8"), "(8");
  assert.equal(maskPhoneInput("84"), "(84");
  assert.equal(maskPhoneInput("849"), "(84) 9");
  assert.equal(maskPhoneInput("84998"), "(84) 998");
  assert.equal(maskPhoneInput("8499849"), "(84) 9984-9");
  assert.equal(maskPhoneInput("84998493000"), "(84) 99849-3000");
  assert.equal(maskPhoneInput("(84) 99849-3000999"), "(84) 99849-3000");
});
test("formatPhoneBR e whatsappLink", () => {
  assert.equal(formatPhoneBR("+5584998493000"), "(84) 99849-3000");
  assert.equal(whatsappLink("+5584998493000"), "https://wa.me/5584998493000");
  assert.equal(whatsappLink("+5584998493000", "Olá & tudo"), "https://wa.me/5584998493000?text=Ol%C3%A1%20%26%20tudo");
});

console.log("validação do formulário");
const ok: RequestFormValues = {
  mode: "pick",
  clinicId: "c1",
  pendingClinicName: "",
  unitId: "",
  requesterName: "Sarah Silva",
  requesterRole: "ADMINISTRADOR",
  whatsapp: "(84) 99849-3000",
  email: "",
  module: "FINANCEIRO",
  type: "MELHORIA_FLUXO",
  title: "Pagamento antecipado",
  description: "Descrição detalhada o bastante para passar.",
};
test("formulário válido não tem erros", () => assert.deepEqual(validateRequestForm(ok), {}));
test("detecta cada campo inválido", () => {
  const e = validateRequestForm({
    ...ok, clinicId: "", requesterName: "Al", requesterRole: "X", whatsapp: "1", module: "", type: "", title: "abc", description: "curta",
  });
  assert.deepEqual(Object.keys(e).sort(), ["clinicId", "description", "module", "requesterName", "requesterRole", "title", "type", "whatsapp"]);
});
test("modo 'clínica nova' exige nome", () => {
  assert.ok(validateRequestForm({ ...ok, mode: "new", clinicId: "", pendingClinicName: "ab" }).pendingClinicName);
  assert.deepEqual(validateRequestForm({ ...ok, mode: "new", clinicId: "", pendingClinicName: "Clínica Nova" }), {});
});

console.log("CSV");
test("escapa aspas e protege contra fórmulas", () => {
  const csv = toCsv([{ a: 'diz "oi"', b: "=HYPERLINK(\"x\")", c: "+1", d: "-2", e: "@x", f: null, g: 5 }]);
  const [h, row] = csv.split("\r\n");
  assert.equal(h, '"a","b","c","d","e","f","g"');
  assert.equal(row, `"diz ""oi""","'=HYPERLINK(""x"")","'+1","'-2","'@x","","5"`);
});
test("lista vazia => string vazia", () => assert.equal(toCsv([]), ""));
test("respeita a ordem de colunas informada", () => {
  assert.equal(toCsv([{ b: 1, a: 2, z: 3 }], ["a", "b"]), `"a","b"\r\n"2","1"`);
});

console.log("mensagens de erro");
test("traduz erros do banco", () => {
  assert.match(friendlyMessage("rate_limited"), /Muitas/);
  assert.match(friendlyMessage("forbidden: request:update_status"), /permissão/);
  assert.match(friendlyMessage("user_not_found"), /Authentication/);
  assert.match(friendlyMessage('duplicate key value violates unique constraint "clinics_name_uq"'), /Já existe/);
  assert.match(friendlyMessage("algo inesperado xyz"), /Não foi possível/);
});

console.log("front ↔ migração SQL");
function sqlEnum(name: string): string[] {
  const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([^)]*)\\)`));
  assert.ok(m, `enum ${name} não encontrado no SQL`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const vals = (l: readonly (readonly [string, string])[]) => l.map(([k]) => k);
test("enums do front == enums do banco", () => {
  assert.deepEqual(vals(REQUESTER_ROLES), sqlEnum("requester_role"));
  assert.deepEqual(vals(MODULES), sqlEnum("system_module"));
  assert.deepEqual(vals(TYPES), sqlEnum("request_type"));
  assert.deepEqual(vals(STATUSES), sqlEnum("request_status"));
  assert.deepEqual(vals(PRIORITIES), sqlEnum("priority_level"));
  assert.deepEqual(vals(STAFF_ROLES), sqlEnum("app_role"));
});
test("DDDs do front == DDDs do banco", () => {
  const m = sql.match(/= any \(array\[([\s\S]*?)\]\)\) then/);
  assert.ok(m, "lista de DDD não encontrada no SQL");
  const sqlDdd = m![1].split(",").map((s) => Number(s.trim())).filter(Boolean);
  assert.deepEqual([...DDD_VALIDOS].sort((a, b) => a - b), [...sqlDdd].sort((a, b) => a - b));
});
test("labelOf", () => {
  assert.equal(labelOf(STATUSES, "EM_ANALISE_PRODUTO"), "Em análise de produto");
  assert.equal(labelOf(STATUSES, "XYZ"), "XYZ");
  assert.equal(labelOf(STATUSES, null), "—");
});
test("anexos: limites do front == limites do bucket", () => {
  assert.match(sql, /52428800/); // 50 MB
  assert.equal(MAX_FILE_MB * 1024 * 1024, 52428800); // front == bucket
  for (const mime of ["image/png", "image/jpeg", "image/webp", "application/pdf", "video/mp4", "video/webm"]) {
    assert.ok(sql.includes(`'${mime}'`), mime);
  }
});

const mb = 1024 * 1024;
const fake = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });
test("anexos: aceita até 50 MB exatos e recusa 50 MB + 1 byte", () => {
  const ok = addFiles([], [fake("a.mp4", "video/mp4", 50 * mb)]);
  assert.equal(ok.files.length, 1);
  assert.deepEqual(ok.messages, []);
  const big = addFiles([], [fake("b.mp4", "video/mp4", 50 * mb + 1)]);
  assert.equal(big.files.length, 0);
  assert.match(big.messages[0], /passa de 50 MB/);
});
test("anexos: recusa tipo proibido e arquivo vazio; limita a 5 arquivos", () => {
  const r = addFiles([], [fake("x.exe", "application/x-msdownload", 10), fake("v.png", "image/png", 0)]);
  assert.equal(r.files.length, 0);
  assert.equal(r.messages.length, 2);
  const six = Array.from({ length: 6 }, (_, i) => fake(`${i}.png`, "image/png", 10));
  const r2 = addFiles([], six);
  assert.equal(r2.files.length, 5);
  assert.match(r2.messages[0], /No máximo 5/);
});
test("anexos: addFiles não altera a lista original", () => {
  const cur = [fake("a.png", "image/png", 5)];
  addFiles(cur, [fake("b.png", "image/png", 5)]);
  assert.equal(cur.length, 1);
});
test("print colado: nome genérico vira print-AAAAMMDD-HHMMSS; nome real é preservado", () => {
  const d = new Date(2026, 10, 22, 14, 30, 5);
  assert.equal(pastedName(fake("image.png", "image/png", 5), 0, d), "print-20261122-143005.png");
  assert.equal(pastedName(fake("image.png", "image/png", 5), 1, d), "print-20261122-143005-2.png");
  assert.equal(pastedName(fake("", "image/jpeg", 5), 0, d), "print-20261122-143005.jpg");
  assert.equal(pastedName(fake("relatorio.png", "image/png", 5), 0, d), "relatorio.png");
});
test("filesFromClipboard: lê imagens da área de transferência e ignora texto puro", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const got = filesFromClipboard({ files: [fake("image.png", "image/png", 5)], items: [] } as unknown as DataTransfer, d);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "print-20260102-030405.png");
  assert.equal(got[0].type, "image/png");
  assert.equal(filesFromClipboard({ files: [], items: [{ kind: "string" }] } as unknown as DataTransfer).length, 0);
  assert.equal(filesFromClipboard(null).length, 0);
});


test("e-mail é opcional, mas se vier precisa ser válido", () => {
  assert.equal(validateRequestForm({ ...ok, email: "" }).email, undefined);
  assert.equal(validateRequestForm({ ...ok, email: "ana@clinica.com.br" }).email, undefined);
  for (const bad of ["ana", "ana@", "ana@clinica", "a b@c.com"]) assert.ok(validateRequestForm({ ...ok, email: bad }).email, bad);
});

console.log("rascunho");
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
const blank: Omit<Draft, "savedAt"> = { mode: "pick", clinicId: "", clinicName: "", unitId: "", pendingClinicName: "", requesterName: "", requesterRole: "", whatsapp: "", email: "", module: "", type: "", title: "", description: "" };
test("rascunho vazio não é guardado (e apaga o anterior)", () => {
  const st = mem();
  assert.equal(isEmptyDraft(blank), true);
  assert.equal(saveDraft({ ...blank, title: "Oi" }, st, 1000), true);
  assert.equal(st.m.size, 1);
  assert.equal(saveDraft(blank, st, 2000), false);
  assert.equal(st.m.size, 0);
});
test("salva e recupera; expira em 7 dias; JSON quebrado é ignorado", () => {
  const st = mem();
  saveDraft({ ...blank, requesterName: "Ana", description: "x" }, st, 1000);
  assert.equal(loadDraft(st, 2000)?.requesterName, "Ana");
  assert.equal(loadDraft(st, 1000 + DRAFT_TTL_MS + 1), null);
  assert.equal(st.m.size, 0, "expirado é apagado");
  st.setItem(DRAFT_KEY, "{quebrado");
  assert.equal(loadDraft(st), null);
  st.setItem(DRAFT_KEY, JSON.stringify({ savedAt: 5, title: 42, description: "ok" }));
  assert.equal(loadDraft(st, 6)?.title, "", "campos com tipo errado viram vazio");
});
test("sem armazenamento (modo privado) nada quebra; clearDraft apaga", () => {
  assert.equal(saveDraft({ ...blank, title: "x" }, null), false);
  assert.equal(loadDraft(null), null);
  const throwing = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
  assert.equal(saveDraft({ ...blank, title: "x" }, throwing), false);
  assert.equal(loadDraft(throwing), null);
  clearDraft(throwing);
  const st = mem(); saveDraft({ ...blank, title: "x" }, st); clearDraft(st); assert.equal(st.m.size, 0);
});

console.log("tema");
test("alternância Automático → Claro → Escuro → Automático", () => {
  assert.equal(nextTheme("system"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "system");
});

console.log("importação da planilha");
test("CSV: aspas, vírgula e quebra de linha dentro do campo, BOM e ponto e vírgula", () => {
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"x, y","linha1\nlinha2"\r\n'), [["a", "b"], ["x, y", "linha1\nlinha2"]]);
  assert.deepEqual(parseCsv('a;b;c\n1;"2;3";4'), [["a", "b", "c"], ["1", "2;3", "4"]]);
  assert.deepEqual(parseCsv('"diz ""oi""",b'), [['diz "oi"', "b"]]);
  assert.deepEqual(parseCsv("a,b\n\n,\n1,2"), [["a", "b"], ["1", "2"]], "linhas vazias são ignoradas");
});
test("detecta colunas do Google Forms (acentos, caixa, títulos longos)", () => {
  const m = detectColumns(["Carimbo de data/hora", "Clínica", "Seu nome", "Seu cargo/função", "WhatsApp para retorno", "Módulo do sistema", "Descreva sua solicitação", "Título"]);
  assert.equal(m.created_at, 0); assert.equal(m.clinic, 1); assert.equal(m.name, 2); assert.equal(m.role, 3);
  assert.equal(m.whatsapp, 4); assert.equal(m.module, 5); assert.equal(m.description, 6); assert.equal(m.title, 7);
  assert.equal(m.email, -1);
  assert.deepEqual(REQUIRED.filter((f) => m[f] < 0), []);
  assert.equal(FIELDS.length, Object.keys(m).length);
  assert.equal(norm("Clínica  Médica!"), "clinica medica");
});
test("mapeadores de cargo, módulo, tipo e status", () => {
  assert.equal(mapRole("Sócio-proprietário"), "DONO_SOCIO");
  assert.equal(mapRole("Recepcionista"), "RECEPCIONISTA");
  assert.equal(mapRole("Dra. médica"), "MEDICO");
  assert.equal(mapRole("???"), "OUTRO");
  assert.equal(mapModule("Agenda médica"), "AGENDA");
  assert.equal(mapModule("Faturamento TISS"), "FATURAMENTO_TISS");
  assert.equal(mapModule("xyz"), "OUTRO");
  assert.equal(mapType("Melhoria de fluxo"), "MELHORIA_FLUXO");
  assert.equal(mapType(""), "NOVA_FUNCIONALIDADE");
  assert.equal(mapStatus("Concluído"), "CONCLUIDO");
  assert.equal(mapStatus("Em desenvolvimento"), "EM_DESENVOLVIMENTO");
  assert.equal(mapStatus("Novo"), "RECEBIDO");
});
test("datas: dd/mm/aaaa com e sem hora, ano de 2 dígitos, ISO, inválidas", () => {
  assert.equal(parseDate("22/11/2026 14:30:05"), "2026-11-22T14:30:05-03:00");
  assert.equal(parseDate("05/03/2025"), "2025-03-05T00:00:00-03:00");
  assert.equal(parseDate("5/3/25 9:07")?.slice(0, 16), "2025-03-05T09:07");
  assert.equal(parseDate("2026-11-22 14:30")?.slice(0, 16), "2026-11-22T14:30");
  assert.equal(parseDate("31/02/2026"), null, "dia inexistente");
  assert.equal(parseDate("lixo"), null);
  assert.equal(parseDate(""), null);
});
await (async () => {try {
  const t = [
    ["Data", "Clínica", "Nome", "Título", "Descrição"],
    ["01/02/2025 10:00", "Kardiomov", "Marta Souza", "Bloquear horários", "Preciso bloquear horários em lote na agenda"],
    ["01/02/2025 10:00", "Kardiomov", "Marta Souza", "Bloquear horários", "Preciso bloquear horários em lote na agenda"],
    ["01/02/2025 10:00", "", "Sem Clínica", "Título válido", "Descrição longa o bastante para passar"],
    ["99/99/2025", "Kardiomov", "Marta Souza", "Outro título", "Descrição longa o bastante para passar"],
    ["", "Kardiomov", "Zé", "Curto", "pouco"],
  ];
  const r = await buildRows(t, detectColumns(t[0]));
  assert.equal(r.rows.length, 1);
  assert.equal(r.duplicatesInFile, 1);
  assert.equal(r.issues.length, 3);
  assert.deepEqual(r.issues.map((i) => i.line), [4, 5, 6]);
  assert.match(r.rows[0].key, /^[0-9a-f]{40}$/);
  assert.equal(r.rows[0].status, "RECEBIDO");
  assert.equal(r.rows[0].module, "OUTRO");
  const again = await buildRows(t, detectColumns(t[0]));
  assert.equal(again.rows[0].key, r.rows[0].key, "chave estável entre execuções");
  n++; console.log("  ✓ buildRows: valida, separa problemas e remove repetidas do arquivo");
} catch (e) { console.error(e); process.exit(1); } })();

{
  assert.ok(/v_admin_email\s+text\s+:= null/.test(sql) && /v_cron_sla\s+boolean := false/.test(sql), "Parte B do Supabase-completo.sql vem desligada por padrão");
  n++; console.log("  ✓ Supabase-completo.sql: Parte B desligada por padrão");
}

console.log(`\n${n} testes unitários passaram`);
