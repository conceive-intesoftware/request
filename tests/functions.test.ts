// Testes das Edge Functions (notify, external-task) e do script de CSP, com fetch falso.
//   NODE_PATH=... tsx tests/functions.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle as notify } from "../supabase/functions/notify/index";
import { handle as external } from "../supabase/functions/external-task/index";
// @ts-ignore — módulo .mjs sem tipos
import { buildCsp, injectCsp, run as runCsp } from "../scripts/apply-csp.mjs";

let n = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    n++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    process.exit(1);
  }
}

interface Call { url: string; init: any }
function fakeFetch(responder: (c: Call) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: any) => {
    const c = { url, init: init ?? {} };
    calls.push(c);
    const r = await responder(c);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  return { f, calls };
}

const TOKEN = "a1".repeat(24);
const SECRET = "segredo-super-longo-123";
const KEY = "re_CHAVE_SECRETA_XYZ";
const ENV = { WEBHOOK_SECRET: SECRET, RESEND_API_KEY: KEY, MAIL_FROM: "Conceive <oi@exemplo.com.br>", SITE_URL: "https://user.github.io/conceive-requests/", TEAM_EMAILS: "po@x.com, dev@x.com" };
const post = (body: unknown, headers: Record<string, string> = { "x-webhook-secret": SECRET }) =>
  new Request("https://f.test/notify", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const created = { event: "request_created", protocol: "CON-2026-0001", title: "Pagamento antecipado", module: "FINANCEIRO", type: "MELHORIA_FLUXO", clinic_name: "Kardiomov", client_email: "sarah@clinica.com", tracking_token: TOKEN };
const sentBodies = (calls: Call[]) => calls.map((c) => JSON.parse(c.init.body));

console.log("notify");
await test("sem segredo ou com segredo errado → 401 e nada é enviado", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  assert.equal((await notify(post(created, {}), ENV, f)).status, 401);
  assert.equal((await notify(post(created, { "x-webhook-secret": "errado" }), ENV, f)).status, 401);
  assert.equal((await notify(post(created, { "x-webhook-secret": SECRET + "x" }), ENV, f)).status, 401);
  assert.equal((await notify(post(created), { ...ENV, WEBHOOK_SECRET: undefined }, f)).status, 401);
  assert.equal(calls.length, 0);
});
await test("método diferente de POST → 405", async () => {
  const { f } = fakeFetch(() => ({}));
  assert.equal((await notify(new Request("https://f.test/", { method: "GET", headers: { "x-webhook-secret": SECRET } }), ENV, f)).status, 405);
});
await test("JSON inválido e evento desconhecido → 400", async () => {
  const { f } = fakeFetch(() => ({}));
  assert.equal((await notify(post("{nao-json"), ENV, f)).status, 400);
  assert.equal((await notify(post({ event: "xpto", protocol: "CON-2026-0001", title: "t" }), ENV, f)).status, 400);
  assert.equal((await notify(post({ event: "request_created" }), ENV, f)).status, 400);
});
await test("configuração incompleta → 500 not_configured", async () => {
  const { f } = fakeFetch(() => ({}));
  const r = await notify(post(created), { ...ENV, RESEND_API_KEY: undefined }, f);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "not_configured" });
});
await test("request_created: confirmação ao cliente (com link) + aviso à equipe (sem dados pessoais)", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { id: "1" } }));
  const r = await notify(post(created), ENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sent: 2 });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const [cli, team] = sentBodies(calls);
  assert.deepEqual(cli.to, ["sarah@clinica.com"]);
  assert.equal(cli.from, ENV.MAIL_FROM);
  assert.match(cli.subject, /CON-2026-0001/);
  const link = `https://user.github.io/conceive-requests/#/acompanhar/${TOKEN}`;
  assert.ok(cli.html.includes(link) && cli.text.includes(link));
  assert.match(cli.html, /Guarde este e-mail/);
  assert.deepEqual(team.to, ["po@x.com", "dev@x.com"]);
  assert.match(team.subject, /CON-2026-0001/);
  assert.ok(team.html.includes("Financeiro") && team.html.includes("Melhoria de fluxo") && team.html.includes("Kardiomov"));
  assert.ok(!team.html.includes(TOKEN) && !team.text.includes(TOKEN), "a equipe não recebe o token do cliente");
  assert.ok(!JSON.stringify(team).includes("sarah@clinica.com"), "a equipe não recebe o e-mail do cliente");
});
await test("link de acompanhamento correto com e sem barra final em SITE_URL", async () => {
  for (const site of ["https://user.github.io/conceive-requests", "https://user.github.io/conceive-requests/", "https://user.github.io/conceive-requests//"]) {
    const { f, calls } = fakeFetch(() => ({}));
    await notify(post(created), { ...ENV, SITE_URL: site, TEAM_EMAILS: undefined }, f);
    assert.ok(sentBodies(calls)[0].text.includes(`https://user.github.io/conceive-requests/#/acompanhar/${TOKEN}`), site);
  }
});
await test("cliente sem e-mail: nada vai ao cliente (só à equipe)", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const r = await notify(post({ ...created, client_email: null }), ENV, f);
  assert.deepEqual(await r.json(), { sent: 1 });
  assert.deepEqual(sentBodies(calls)[0].to, ["po@x.com", "dev@x.com"]);
});
await test("e-mail inválido do cliente é ignorado em silêncio; sem TEAM_EMAILS → sent 0", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  for (const bad of ["isso não é email", "a@b", "x@y.com, z@w.com", 'a"b@c.com', "a@b.c"]) {
    const r = await notify(post({ ...created, client_email: bad }), { ...ENV, TEAM_EMAILS: undefined }, f);
    assert.equal(r.status, 200, bad);
    assert.deepEqual(await r.json(), { sent: 0 }, bad);
  }
  assert.equal(calls.length, 0);
});
await test("token inválido: não monta link nem envia ao cliente", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  await notify(post({ ...created, tracking_token: "../../x" }), { ...ENV, TEAM_EMAILS: undefined }, f);
  assert.equal(calls.length, 0);
});
await test("status_changed: ao cliente, com etapas em pt-BR", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const r = await notify(post({ event: "status_changed", protocol: "CON-2026-0002", title: "Marcas", status: "EM_DESENVOLVIMENTO", previous_status: "APROVADO_ROADMAP", client_email: "c@d.com", tracking_token: TOKEN }), ENV, f);
  assert.deepEqual(await r.json(), { sent: 1 });
  const m = sentBodies(calls)[0];
  assert.deepEqual(m.to, ["c@d.com"]);
  assert.match(m.subject, /CON-2026-0002/);
  assert.ok(m.html.includes("Em desenvolvimento") && m.html.includes("Aprovado para roadmap"));
});
await test("comment_public: cita a resposta; sem e-mail do cliente não envia", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const ev = { event: "comment_public", protocol: "CON-2026-0003", title: "Agenda", body: "Já está em análise.\nObrigado!", client_email: "c@d.com", tracking_token: TOKEN };
  assert.deepEqual(await (await notify(post(ev), ENV, f)).json(), { sent: 1 });
  const m = sentBodies(calls)[0];
  assert.deepEqual(m.to, ["c@d.com"]);
  assert.ok(m.html.includes("Já está em análise.") && m.text.includes("Obrigado!"));
  assert.deepEqual(await (await notify(post({ ...ev, client_email: null }), ENV, f)).json(), { sent: 0 });
});
await test("client_reply: só à equipe", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const r = await notify(post({ event: "client_reply", protocol: "CON-2026-0004", title: "Estoque", body: "Segue o print.", client_email: "c@d.com", tracking_token: TOKEN }), ENV, f);
  assert.deepEqual(await r.json(), { sent: 1 });
  const m = sentBodies(calls)[0];
  assert.deepEqual(m.to, ["po@x.com", "dev@x.com"]);
  assert.match(m.subject, /CON-2026-0004/);
  assert.ok(!JSON.stringify(m).includes("c@d.com"));
});
await test("sla_digest: resumo só à equipe, com lista, contagem e link do painel", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const items = [{ protocol: "CON-2026-0001", title: "Pedido <b>parado</b>", sla: "PARADA", days: 20 }, { protocol: "CON-2026-0002", title: "Sem retorno", sla: "SEM_RESPOSTA", days: 5 }];
  const r = await notify(post({ event: "sla_digest", protocol: "RESUMO", title: "2 solicitações precisam de atenção", count: 40, items }), ENV, f);
  assert.deepEqual(await r.json(), { sent: 1 });
  const m = sentBodies(calls)[0];
  assert.deepEqual(m.to, ["po@x.com", "dev@x.com"]);
  assert.match(m.subject, /40 solicitações precisam de atenção/);
  assert.match(m.text, /CON-2026-0001: Pedido <b>parado<\/b> \(parada, 20 dias\)/);
  assert.ok(m.html.includes("Pedido &lt;b&gt;parado&lt;/b&gt;") && !m.html.includes("<b>parado"), "HTML escapado");
  assert.ok(m.html.includes("e mais 38"), "avisa quantas não couberam");
  assert.ok(m.html.includes("https://user.github.io/conceive-requests/#/admin"));
});
await test("sla_digest sem equipe cadastrada não envia nada", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const r = await notify(post({ event: "sla_digest", protocol: "RESUMO", title: "x", count: 1, items: [] }), { ...ENV, TEAM_EMAILS: "" }, f);
  assert.deepEqual(await r.json(), { sent: 0 });
  assert.equal(calls.length, 0);
});
await test("escape de HTML: <script> do título, do corpo e do protocolo não aparece cru", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'`;
  await notify(post({ ...created, title: evil, clinic_name: evil }), ENV, f);
  await notify(post({ event: "comment_public", protocol: "CON-2026-0009", title: evil, body: evil, client_email: "c@d.com", tracking_token: TOKEN }), ENV, f);
  await notify(post({ event: "client_reply", protocol: evil, title: evil, body: evil }), ENV, f);
  assert.ok(sentBodies(calls).some((m) => m.html.includes("&lt;script&gt;")), "pelo menos um e-mail mostra o texto escapado");
  for (const m of sentBodies(calls)) {
    assert.ok(!m.html.includes("<script>") && !m.html.includes("<img src=x"), "html sem tag crua");
    assert.ok(m.html.includes("&lt;script&gt;") || !m.html.includes("alert"), "ou aparece escapado, ou nem aparece");
    assert.ok(!/[\r\n]/.test(m.subject), "assunto em uma linha só");
  }
});
await test("quebras de linha no título não injetam cabeçalhos no assunto", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  await notify(post({ ...created, title: "Linha1\r\nBcc: x@y.com" }), ENV, f);
  for (const m of sentBodies(calls)) assert.ok(!/[\r\n]/.test(m.subject));
});
await test("Resend devolve erro → 502 mail_failed sem vazar a chave", async () => {
  const { f } = fakeFetch(() => ({ status: 500, body: { message: `chave ${KEY} inválida` } }));
  const r = await notify(post(created), ENV, f);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.match(text, /mail_failed/);
  assert.ok(!text.includes(KEY));
});
await test("falha de rede no Resend também → 502", async () => {
  const f = async () => { throw new Error(`boom ${KEY}`); };
  const r = await notify(post(created), ENV, f as any);
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes(KEY));
});

console.log("external-task");
const REQ_ID = "11111111-1111-4111-8111-111111111111";
const SB = "https://abcd.supabase.co";
const EENV = {
  SUPABASE_URL: SB, SUPABASE_ANON_KEY: "sb_publishable_x",
  REDMINE_URL: "https://redmine.exemplo.com/", REDMINE_API_KEY: "rm-key", REDMINE_PROJECT_ID: "conceive", REDMINE_TRACKER_ID: "2",
  PIPEFY_TOKEN: "pf-token", PIPEFY_PIPE_ID: "302", PIPEFY_TITLE_FIELD_ID: "titulo", PIPEFY_DESC_FIELD_ID: "descricao",
};
const DETAIL = {
  id: REQ_ID, protocol: "CON-2026-0042", title: "Pagamento  antecipado\n de consulta", description: "Queremos cobrar um percentual antecipado.",
  module: "FINANCEIRO", type: "MELHORIA_FLUXO", clinic_name: "Kardiomov", pending_clinic_name: null, external_id: null,
  requester_name: "Sarah Silva", whatsapp: "+5584998493000",
};
const call = (body: unknown, headers: Record<string, string> = { authorization: "Bearer jwt-da-pessoa" }, method = "POST") =>
  new Request("https://f.test/external-task", { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });

function router(over: Partial<Record<string, any>> = {}) {
  return fakeFetch((c) => {
    if (c.url.endsWith("/rpc/get_request_detail")) return over.detail ?? { body: DETAIL };
    if (c.url.endsWith("/rpc/set_external_ref")) return over.ref ?? { status: 204, body: null };
    if (c.url.endsWith("/issues.json")) return over.redmine ?? { status: 201, body: { issue: { id: 4521 } } };
    if (c.url === "https://api.pipefy.com/graphql") return over.pipefy ?? { body: { data: { createCard: { card: { id: "987" } } } } };
    return { status: 500 };
  });
}

await test("OPTIONS responde 204 com CORS; todas as respostas trazem CORS", async () => {
  const { f } = router();
  const o = await external(call(null, {}, "OPTIONS"), EENV, f);
  assert.equal(o.status, 204);
  assert.equal(o.headers.get("access-control-allow-origin"), "*");
  assert.match(o.headers.get("access-control-allow-headers") ?? "", /authorization, x-client-info, apikey, content-type/);
  const bad = await external(call({ request_id: "x", system: "REDMINE" }), EENV, f);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("access-control-allow-origin"), "*");
  assert.equal((await external(call({ request_id: REQ_ID, system: "REDMINE" }, {}), EENV, f)).status, 401);
  assert.equal((await external(call({ request_id: REQ_ID, system: "JIRA" }), EENV, f)).status, 400);
});
await test("a RPC nega (sem permissão/MFA) → 403 e nada é criado", async () => {
  const { f, calls } = router({ detail: { status: 403, body: { message: "forbidden" } } });
  const r = await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer jwt-da-pessoa");
  assert.equal(calls[0].init.headers.apikey, "sb_publishable_x");
  assert.equal(calls[0].url, `${SB}/rest/v1/rpc/get_request_detail`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_id: REQ_ID });
});
await test("solicitação inexistente → 404; já vinculada → 409", async () => {
  let { f, calls } = router({ detail: { body: null } });
  assert.equal((await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f)).status, 404);
  ({ f, calls } = router({ detail: { body: { ...DETAIL, external_id: "77" } } }));
  const r = await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "already_linked" });
  assert.equal(calls.length, 1);
});
await test("Redmine: URL, cabeçalho, corpo sem nome/telefone, vínculo gravado com o token da pessoa", async () => {
  const { f, calls } = router();
  const r = await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { system: "REDMINE", id: "4521", url: "https://redmine.exemplo.com/issues/4521" });
  const rm = calls.find((c) => c.url.endsWith("/issues.json"))!;
  assert.equal(rm.url, "https://redmine.exemplo.com/issues.json");
  assert.equal(rm.init.method, "POST");
  assert.equal(rm.init.headers["x-redmine-api-key"], "rm-key");
  const body = JSON.parse(rm.init.body);
  assert.equal(body.issue.project_id, "conceive");
  assert.equal(body.issue.tracker_id, 2);
  assert.equal(body.issue.subject, "[CON-2026-0042] Pagamento antecipado de consulta");
  assert.ok(body.issue.description.includes("Queremos cobrar") && body.issue.description.includes("Módulo: Financeiro")
    && body.issue.description.includes("Tipo: Melhoria de fluxo") && body.issue.description.includes("Clínica: Kardiomov")
    && body.issue.description.includes("Origem: Conceive Requests"));
  assert.ok(!rm.init.body.includes("Sarah") && !rm.init.body.includes("5584998493000"), "sem dados pessoais");
  const ref = calls.find((c) => c.url.endsWith("/rpc/set_external_ref"))!;
  assert.equal(ref.init.headers.authorization, "Bearer jwt-da-pessoa");
  assert.deepEqual(JSON.parse(ref.init.body), { p_id: REQ_ID, p_system: "REDMINE", p_external_id: "4521" });
});
await test("Redmine sem tracker usa só o essencial; clínica pendente aparece na descrição", async () => {
  const { f, calls } = router({ detail: { body: { ...DETAIL, clinic_name: null, pending_clinic_name: "Clínica Nova" } } });
  await external(call({ request_id: REQ_ID, system: "REDMINE" }), { ...EENV, REDMINE_TRACKER_ID: undefined }, f);
  const body = JSON.parse(calls.find((c) => c.url.endsWith("/issues.json"))!.init.body);
  assert.ok(!("tracker_id" in body.issue));
  assert.ok(body.issue.description.includes("Clínica: Clínica Nova"));
});
await test("Redmine recusa → 502 e nenhum vínculo é gravado", async () => {
  const { f, calls } = router({ redmine: { status: 422, body: { errors: ["Projeto inválido"] } } });
  const r = await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f);
  assert.equal(r.status, 502);
  assert.ok(!calls.some((c) => c.url.endsWith("/rpc/set_external_ref")));
});
await test("Pipefy: mutation e variáveis (pipe, campos), sem dados pessoais, vínculo gravado", async () => {
  const { f, calls } = router();
  const r = await external(call({ request_id: REQ_ID, system: "PIPEFY" }), EENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { system: "PIPEFY", id: "987", url: "https://app.pipefy.com/open-cards/987" });
  const pf = calls.find((c) => c.url === "https://api.pipefy.com/graphql")!;
  assert.equal(pf.init.headers.authorization, "Bearer pf-token");
  const body = JSON.parse(pf.init.body);
  assert.match(body.query, /createCard\(input: \$input\)/);
  assert.match(body.query, /card \{ id \}/);
  assert.equal(body.variables.input.pipe_id, "302");
  assert.deepEqual(body.variables.input.fields_attributes.map((x: any) => x.field_id), ["titulo", "descricao"]);
  assert.equal(body.variables.input.fields_attributes[0].field_value, "[CON-2026-0042] Pagamento antecipado de consulta");
  assert.ok(body.variables.input.fields_attributes[1].field_value.includes("Origem: Conceive Requests"));
  assert.ok(!pf.init.body.includes("Sarah") && !pf.init.body.includes("5584998493000"));
  const ref = calls.find((c) => c.url.endsWith("/rpc/set_external_ref"))!;
  assert.deepEqual(JSON.parse(ref.init.body), { p_id: REQ_ID, p_system: "PIPEFY", p_external_id: "987" });
});
await test("Pipefy sem ids de campos omite fields_attributes", async () => {
  const { f, calls } = router();
  await external(call({ request_id: REQ_ID, system: "PIPEFY" }), { ...EENV, PIPEFY_TITLE_FIELD_ID: undefined, PIPEFY_DESC_FIELD_ID: undefined }, f);
  const body = JSON.parse(calls.find((c) => c.url === "https://api.pipefy.com/graphql")!.init.body);
  assert.deepEqual(body.variables.input, { pipe_id: "302" });
});
await test("erro GraphQL do Pipefy → 502 e nenhum vínculo", async () => {
  const { f, calls } = router({ pipefy: { body: { data: { createCard: null }, errors: [{ message: "Permissão negada", code: 30006 }] } } });
  const r = await external(call({ request_id: REQ_ID, system: "PIPEFY" }), EENV, f);
  assert.equal(r.status, 502);
  assert.ok(!calls.some((c) => c.url.endsWith("/rpc/set_external_ref")));
});
await test("sistema sem configuração → 501 not_configured (antes de qualquer chamada)", async () => {
  const { f, calls } = router();
  const r = await external(call({ request_id: REQ_ID, system: "PIPEFY" }), { ...EENV, PIPEFY_TOKEN: undefined }, f);
  assert.equal(r.status, 501);
  assert.deepEqual(await r.json(), { error: "not_configured" });
  assert.equal((await external(call({ request_id: REQ_ID, system: "REDMINE" }), { ...EENV, REDMINE_URL: undefined }, f)).status, 501);
  assert.equal(calls.length, 0);
});
await test("falha ao gravar o vínculo → 500 mas devolve o id criado (não se perde a tarefa)", async () => {
  const { f } = router({ ref: { status: 403, body: { message: "forbidden" } } });
  const r = await external(call({ request_id: REQ_ID, system: "REDMINE" }), EENV, f);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "link_failed", system: "REDMINE", id: "4521", url: "https://redmine.exemplo.com/issues/4521" });
});

console.log("apply-csp");
const HTML = `<!doctype html>\n<html lang="pt-BR">\n  <head>\n    <meta charset="UTF-8" />\n    <title>x</title>\n  </head>\n  <body></body>\n</html>`;
await test("política contém o Supabase (https e wss) e o Turnstile", () => {
  const csp = buildCsp({ supabaseUrl: "https://abcd.supabase.co/" });
  assert.match(csp, /connect-src 'self' https:\/\/abcd\.supabase\.co wss:\/\/abcd\.supabase\.co https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /img-src 'self' data: blob: https:\/\/abcd\.supabase\.co/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.ok(!/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(buildCsp({ supabaseUrl: "https://abcd.supabase.co", extraConnect: ["https://x.test"] }), /connect-src [^;]*https:\/\/x\.test/);
  assert.throws(() => buildCsp({ supabaseUrl: "isso-nao-e-url" }));
  assert.throws(() => buildCsp({ supabaseUrl: "http://abcd.supabase.co" }));
});
await test("injeção logo após <meta charset> e idempotente", () => {
  const csp = buildCsp({ supabaseUrl: "https://abcd.supabase.co" });
  const once = injectCsp(HTML, csp);
  assert.ok(once.indexOf("Content-Security-Policy") > once.indexOf("<meta charset"));
  assert.ok(once.indexOf("Content-Security-Policy") < once.indexOf("<title>"));
  assert.equal(injectCsp(once, csp), once);
  assert.equal((injectCsp(injectCsp(once, csp), csp).match(/Content-Security-Policy/g) ?? []).length, 1);
  const other = injectCsp(once, buildCsp({ supabaseUrl: "https://outro.supabase.co" }));
  assert.equal((other.match(/Content-Security-Policy/g) ?? []).length, 1);
  assert.ok(other.includes("outro.supabase.co") && !other.includes("abcd.supabase.co"));
  assert.ok(injectCsp("<html><head><title>x</title></head></html>", csp).includes("Content-Security-Policy"));
  assert.throws(() => injectCsp("<p>sem head</p>", csp));
});
const silent = { log() {}, warn() {}, error() {} };
await test("CLI: aplica, respeita CSP_DESATIVADA e falha sem VITE_SUPABASE_URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "csp-"));
  const file = join(dir, "index.html");
  writeFileSync(file, HTML);
  assert.equal(runCsp(file, {}, silent), 1);
  assert.equal(readFileSync(file, "utf8"), HTML, "sem variável: arquivo intocado");
  assert.equal(runCsp(file, { VITE_SUPABASE_URL: "https://abcd.supabase.co", CSP_DESATIVADA: "true" }, silent), 0);
  assert.equal(readFileSync(file, "utf8"), HTML, "desativada: arquivo intocado");
  assert.equal(runCsp(file, { VITE_SUPABASE_URL: "https://abcd.supabase.co" }, silent), 0);
  const after = readFileSync(file, "utf8");
  assert.ok(after.includes("wss://abcd.supabase.co"));
  assert.equal(runCsp(file, { VITE_SUPABASE_URL: "https://abcd.supabase.co" }, silent), 0);
  assert.equal(readFileSync(file, "utf8"), after, "segunda execução não muda nada");
  assert.equal(runCsp(undefined, {}, silent), 1);
});

console.log(`\n${n} testes de funções passaram`);
