// Testes das Edge Functions (notify, external-task, external-sync) e do script de CSP, com fetch falso.
//   NODE_PATH=... tsx tests/functions.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle as notify } from "../supabase/functions/notify/index";
import { handle as external } from "../supabase/functions/external-task/index";
import { handle as extSync } from "../supabase/functions/external-sync/index";
import { handle as adminUsers, passwordProblem } from "../supabase/functions/admin-users/index";
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
const created = { event: "request_created", protocol: "CON-2026-0001", title: "Pagamento antecipado", module: "FINANCEIRO", type: "MELHORIA_FLUXO", clinic_name: "Kardiomov", client_email: "sarah@clinica.com", tracking_token: TOKEN, requester_name: "Sarah Silva", created_at: "2026-11-25T03:25:00Z" };
const sentBodies = (calls: Call[]) => calls.filter((c) => c.init?.body).map((c) => JSON.parse(c.init.body));

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
  assert.deepEqual(await r.json(), { error: "not_configured", missing: ["RESEND_API_KEY"] });
});
await test("erros explicam o motivo: segredo ausente/diferente, o que falta na configuração", async () => {
  const { f } = fakeFetch(() => ({}));
  const a = await notify(post(created, { "x-webhook-secret": "errado" }), ENV, f);
  assert.equal(a.status, 401);
  assert.match((await a.json()).reason, /diferente/);
  const b = await notify(post(created), { ...ENV, WEBHOOK_SECRET: undefined }, f);
  assert.match((await b.json()).reason, /WEBHOOK_SECRET não está cadastrado/);
  const c = await notify(post(created), { ...ENV, MAIL_PROVIDER: "brevo", MAIL_FROM: "lixo", SITE_URL: undefined }, f);
  assert.deepEqual((await c.json()).missing, ["BREVO_API_KEY", "MAIL_FROM (formato: Nome <email@dominio.com>)", "SITE_URL"]);
});
await test("falha do provedor devolve status, mensagem e dica (sem vazar a chave)", async () => {
  const brevo = { ...ENV, MAIL_PROVIDER: "brevo", BREVO_API_KEY: "xkeysib-SEGREDO", MAIL_FROM: "Conceive <a@hotmail.com>" };
  const ip = fakeFetch(() => ({ status: 401, body: { code: "unauthorized", message: "We have detected you are using an unrecognised IP address 1.2.3.4. xkeysib-SEGREDO" } }));
  const r1 = await notify(post(created), brevo, ip.f);
  const b1 = await r1.json();
  assert.equal(r1.status, 502);
  assert.equal(b1.provider, "brevo"); assert.equal(b1.provider_status, 401);
  assert.match(b1.hint, /bloqueou o IP/);
  assert.ok(!JSON.stringify(b1).includes("xkeysib-SEGREDO"), "chave redigida");
  const snd = fakeFetch(() => ({ status: 400, body: { message: "Sender is invalid / not validated" } }));
  assert.match((await (await notify(post(created), brevo, snd.f)).json()).hint, /remetente/);
  const rs = fakeFetch(() => ({ status: 403, body: { message: "The domain is not verified" } }));
  const b3 = await (await notify(post(created), ENV, rs.f)).json();
  assert.equal(b3.provider, "resend"); assert.match(b3.hint, /Resend/);
  const net = await (await notify(post(created), ENV, (async () => { throw new Error("rede"); }) as any)).json();
  assert.equal(net.provider_status, 0);
});
await test("evento test: envia ao endereço informado; sem destinatário válido → 400", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const ev = { event: "test", protocol: "TESTE", title: "Teste de e-mail do Conceive", test_to: "eu@exemplo.com" };
  const r = await notify(post(ev), ENV, f);
  const tj: any = await r.json();
  assert.equal(tj.sent, 1);
  assert.equal(tj.provider, "resend");
  assert.match(tj.sample_link, /#\/acompanhar\//);
  assert.ok(tj.site_url.endsWith("/") && "site_status" in tj);
  const m = sentBodies(calls)[0];
  assert.deepEqual(m.to, ["eu@exemplo.com"]);
  assert.match(m.subject, /Teste de e-mail/);
  assert.ok(m.html.includes("funcionando") && m.html.includes("resend"));
  const bad = await notify(post({ ...ev, test_to: "xx" }), ENV, f);
  assert.equal(bad.status, 400);
  assert.equal(sentBodies(calls).length, 1);
});
await test("SITE_URL malformado é normalizado (corta #/… e espaços) e inválido é recusado", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { id: "1" } }));
  const env1 = { ...ENV, SITE_URL: "  https://x.github.io/app/#/admin " };
  const r = await notify(post(created), env1, f);
  assert.equal(r.status, 200);
  const cli = sentBodies(calls)[0];
  assert.ok(cli.html.includes("https://x.github.io/app/#/acompanhar/"), "link do cliente");
  assert.ok(!cli.html.includes("#/admin#"));
  const r2 = await notify(post(created), { ...ENV, SITE_URL: "meusite.com" }, f);
  assert.equal(r2.status, 500);
});
await test("request_resend: reenvia ao cliente com link, dados e etapa atual; sem e-mail → nada enviado", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { id: "1" } }));
  const r = await notify(post({ ...created, event: "request_resend", status: "EM_ANALISE" }), ENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sent: 1 });
  const [m] = sentBodies(calls);
  assert.deepEqual(m.to, ["sarah@clinica.com"]);
  assert.match(m.subject, /Reenvio/);
  assert.match(m.html, /#\/acompanhar\/[0-9a-f]{48}/);
  assert.match(m.text, /#\/acompanhar\//);
  const r2 = await notify(post({ ...created, event: "request_resend", client_email: null }), ENV, f);
  assert.deepEqual(await r2.json(), { sent: 0 });
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
  assert.match(cli.subject, /Confirmação de recebimento/);
  assert.match(cli.html, /Prezado\(a\) Sarah Silva,/);
  assert.match(cli.html, /Atenciosamente,/);
  assert.ok(cli.html.includes("25/11/2026 às 00:25"), "data no fuso de Fortaleza");
  assert.ok(cli.html.includes("Pagamento antecipado") && cli.html.includes("Kardiomov") && cli.html.includes("Recebido"));
  assert.match(cli.text, /Prezado\(a\) Sarah Silva,[\s\S]*Atenciosamente,\nEquipe Conceive/);
  assert.deepEqual(team.to, ["po@x.com", "dev@x.com"]);
  assert.match(team.subject, /CON-2026-0001/);
  assert.ok(team.html.includes("Financeiro") && team.html.includes("Melhoria de fluxo") && team.html.includes("Kardiomov"));
  assert.ok(!team.html.includes(TOKEN) && !team.text.includes(TOKEN), "a equipe não recebe o token do cliente");
  assert.ok(!JSON.stringify(team).includes("sarah@clinica.com"), "a equipe não recebe o e-mail do cliente");
  assert.ok(!JSON.stringify(team).includes("Sarah Silva"), "o aviso da equipe não traz o nome do cliente");
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
const RID = "123e4567-e89b-42d3-a456-426614174000";
await test("e-mails da equipe trazem link direto para abrir a solicitação no painel", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  await notify(post({ ...created, request_id: RID }), ENV, f);
  await notify(post({ event: "client_reply", protocol: "CON-2026-0004", title: "Estoque", body: "x", request_id: RID }), ENV, f);
  await notify(post({ event: "client_reply", protocol: "CON-2026-0005", title: "Sem id", body: "x", request_id: "../x" }), ENV, f);
  const b = sentBodies(calls);
  const url = `https://user.github.io/conceive-requests/#/admin?abrir=${RID}`;
  assert.ok(b[1].html.includes(url) && b[1].text.includes(url), "aviso de nova solicitação");
  assert.ok(b[2].html.includes(url) && b[2].text.includes(url), "resposta do cliente");
  assert.ok(b[3].text.includes("#/admin\n") && !b[3].text.includes("abrir="), "id inválido cai no painel geral");
  assert.ok(!b[0].html.includes("abrir="), "o cliente nunca recebe link do painel");
});
await test("status CONCLUIDO pede a avaliação; outras etapas seguem o e-mail comum", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const ev = { event: "status_changed", protocol: "CON-2026-0006", title: "Relatório", previous_status: "EM_DESENVOLVIMENTO", client_email: "c@d.com", tracking_token: TOKEN };
  await notify(post({ ...ev, status: "CONCLUIDO" }), ENV, f);
  await notify(post({ ...ev, status: "EM_ANALISE_PRODUTO" }), ENV, f);
  const [done, other] = sentBodies(calls);
  assert.match(done.subject, /conclu[ií]da/i);
  assert.ok(done.html.includes("Avaliar o atendimento") && done.text.includes(`#/acompanhar/${TOKEN}`));
  assert.match(other.subject, /mudou de etapa/);
});
await test("Reply-To só quando REPLY_TO é válido; rodapé muda junto", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  await notify(post(created), { ...ENV, REPLY_TO: "suporte@exemplo.com.br" }, f);
  await notify(post(created), { ...ENV, REPLY_TO: "inválido" }, f);
  await notify(post(created), ENV, f);
  const b = sentBodies(calls);
  assert.equal(b[0].reply_to, "suporte@exemplo.com.br");
  assert.ok(b[0].html.includes("Basta responder este e-mail"));
  assert.ok(!("reply_to" in b[2]) && b[2].html.includes("não é necessário respondê-la"));
  assert.ok(!("reply_to" in b[4]));
});
await test("Idempotency-Key estável por evento e por e-mail; ausente sem event_id", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  await notify(post({ ...created, event_id: "9b2d6f1e-1111-4222-8333-444455556666" }), ENV, f);
  await notify(post({ ...created, event_id: "9b2d6f1e-1111-4222-8333-444455556666" }), ENV, f);
  await notify(post({ ...created, event_id: "não vale; \r\n" }), ENV, f);
  const h = calls.map((c) => c.init.headers["idempotency-key"]);
  assert.equal(h[0], "conceive-9b2d6f1e-1111-4222-8333-444455556666-0");
  assert.equal(h[1], "conceive-9b2d6f1e-1111-4222-8333-444455556666-1");
  assert.deepEqual(h.slice(0, 2), h.slice(2, 4), "repetição do mesmo evento usa as mesmas chaves");
  assert.equal(h[4], undefined);
});
await test("Brevo: chamada à API v3, chave no cabeçalho api-key, remetente separado, Reply-To", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  const env = { ...ENV, MAIL_PROVIDER: "brevo", BREVO_API_KEY: "xkeysib-SEGREDO", RESEND_API_KEY: undefined, MAIL_FROM: "Conceive <fulano@hotmail.com>", REPLY_TO: "fulano@hotmail.com" };
  const r = await notify(post(created), env, f);
  assert.deepEqual(await r.json(), { sent: 2 });
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].init.headers["api-key"], "xkeysib-SEGREDO");
  assert.ok(!("authorization" in calls[0].init.headers));
  const b = JSON.parse(calls[0].init.body);
  assert.deepEqual(b.sender, { name: "Conceive", email: "fulano@hotmail.com" });
  assert.deepEqual(b.to, [{ email: "sarah@clinica.com" }]);
  assert.deepEqual(b.replyTo, { email: "fulano@hotmail.com" });
  assert.ok(b.htmlContent.includes("CON-2026-0001") && b.textContent.includes("CON-2026-0001") && b.subject.includes("CON-2026-0001"));
  assert.deepEqual(JSON.parse(calls[1].init.body).to, [{ email: "po@x.com" }, { email: "dev@x.com" }]);
});
await test("Brevo: remetente simples (sem nome), sem chave → 500, erro → 502 sem vazar a chave", async () => {
  const base = { ...ENV, MAIL_PROVIDER: "brevo", BREVO_API_KEY: "xkeysib-SEGREDO", RESEND_API_KEY: undefined };
  const a = fakeFetch(() => ({}));
  await notify(post(created), { ...base, MAIL_FROM: "fulano@hotmail.com" }, a.f);
  assert.deepEqual(JSON.parse(a.calls[0].init.body).sender, { email: "fulano@hotmail.com" });
  const c = fakeFetch(() => ({}));
  assert.equal((await notify(post(created), { ...base, BREVO_API_KEY: undefined }, c.f)).status, 500);
  assert.equal((await notify(post(created), { ...base, MAIL_FROM: "lixo" }, c.f)).status, 500);
  assert.equal((await notify(post(created), { ...ENV, MAIL_PROVIDER: "outro" }, c.f)).status, 500);
  assert.equal(c.calls.length, 0);
  const e = fakeFetch(() => ({ status: 401, body: { message: "Key not found" } }));
  const r = await notify(post(created), base, e.f);
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("xkeysib-SEGREDO"));
});
const GAS = "https://script.google.com/macros/s/AKfycbxEXEMPLO_123-abc/exec";
const GENV = { ...ENV, MAIL_PROVIDER: "apps_script", APPS_SCRIPT_URL: GAS, APPS_SCRIPT_SECRET: "senha-do-script-SEGREDO", RESEND_API_KEY: undefined, MAIL_FROM: "Conceive <id.conceive@gmail.com>", REPLY_TO: "suporte@x.com" };
await test("apps_script (Gmail): POST no URL /exec com o segredo no corpo, destinatários, nome e Reply-To", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { ok: true, remaining: 90 } }));
  const r = await notify(post(created), GENV, f);
  assert.deepEqual(await r.json(), { sent: 2 });
  assert.equal(calls[0].url, GAS);
  assert.equal(calls[0].init.method, "POST");
  const b = JSON.parse(calls[0].init.body);
  assert.equal(b.secret, "senha-do-script-SEGREDO");
  assert.deepEqual(b.to, ["sarah@clinica.com"]);
  assert.equal(b.name, "Conceive"); assert.equal(b.replyTo, "suporte@x.com");
  assert.ok(b.subject.includes("CON-2026-0001") && b.html.includes("CON-2026-0001") && b.text.includes("CON-2026-0001"));
  assert.deepEqual(JSON.parse(calls[1].init.body).to, ["po@x.com", "dev@x.com"]);
  assert.ok(!("authorization" in calls[0].init.headers));
});
await test("apps_script: MAIL_FROM é opcional; configuração incompleta lista o que falta (URL fora do padrão é recusada)", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { ok: true } }));
  assert.equal((await notify(post(created), { ...GENV, MAIL_FROM: undefined }, f)).status, 200);
  assert.equal(JSON.parse(calls[0].init.body).name, "Conceive");
  const bad = await notify(post(created), { ...GENV, APPS_SCRIPT_URL: "https://evil.example.com/exec", APPS_SCRIPT_SECRET: undefined }, f);
  assert.equal(bad.status, 500);
  assert.deepEqual((await bad.json()).missing, ["APPS_SCRIPT_URL (deve ser https://script.google.com/macros/s/.../exec)", "APPS_SCRIPT_SECRET"]);
  assert.equal(calls.length, 2, "nenhuma chamada ao endereço inválido");
});
await test("apps_script: erro do script (segredo, cota) e resposta HTML de login viram 502 com dica", async () => {
  const un = fakeFetch(() => ({ body: { ok: false, error: "unauthorized" } }));
  const a = await (await notify(post(created), GENV, un.f)).json();
  assert.equal(a.provider, "apps_script"); assert.match(a.hint, /APPS_SCRIPT_SECRET/);
  assert.ok(!JSON.stringify(a).includes("senha-do-script-SEGREDO"));
  const q = fakeFetch(() => ({ body: { ok: false, error: "Service invoked too many times for one day: email." } }));
  assert.match((await (await notify(post(created), GENV, q.f)).json()).hint, /limite diário/);
  const html = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } })) as any;
  const h = await (await notify(post(created), GENV, html)).json();
  assert.match(h.hint, /Qualquer pessoa/);
});
await test("apps_script: o e-mail de teste do painel também funciona", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const r = await notify(post({ event: "test", protocol: "TESTE", title: "Teste de e-mail do Conceive", test_to: "eu@exemplo.com" }), GENV, f);
  assert.equal(((await r.json()) as any).sent, 1);
  const mb = sentBodies(calls)[0];
  assert.deepEqual(mb.to, ["eu@exemplo.com"]);
  assert.ok(mb.html.includes("apps_script"));
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

console.log("external-sync");
const SYNC_SB = "https://abc.supabase.co", SKEY = "service-key-SEGREDO";
const SENV = { WEBHOOK_SECRET: SECRET, SUPABASE_URL: SYNC_SB, SUPABASE_SERVICE_ROLE_KEY: SKEY, REDMINE_URL: "https://redmine.x.com/", REDMINE_API_KEY: "rk", PIPEFY_TOKEN: "pt" };
const sCall = (headers: Record<string, string> = { "x-webhook-secret": SECRET }) => new Request("https://f.test/sync", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
const R1 = "11111111-1111-4111-8111-111111111111", R2 = "22222222-2222-4222-8222-222222222222", R3 = "33333333-3333-4333-8333-333333333333";
function syncRouter(pending: unknown[], statuses: Record<string, any>, results: Record<string, unknown>) {
  return fakeFetch((c) => {
    if (c.url.endsWith("/rpc/external_sync_pending")) return { body: pending };
    if (c.url.endsWith("/rpc/external_apply_status")) return { body: results[JSON.parse(c.init.body).p_id] ?? { result: "unchanged" } };
    if (c.url.includes("/issues/")) { const id = c.url.split("/issues/")[1].replace(".json", ""); return statuses[`R${id}`] ?? { status: 404, body: {} }; }
    if (c.url.includes("pipefy")) return statuses[`P${JSON.parse(c.init.body).variables.id}`] ?? { status: 200, body: { data: { card: null } } };
    return { status: 500, body: {} };
  });
}
await test("external-sync: sem segredo/segredo errado → 401 com o motivo; GET → 405", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  assert.equal((await extSync(sCall({}), SENV, f)).status, 401);
  const w = await extSync(sCall({ "x-webhook-secret": "errado" }), SENV, f);
  assert.equal(w.status, 401); assert.match((await w.json()).reason, /diferente/);
  assert.equal((await extSync(sCall(), { ...SENV, WEBHOOK_SECRET: undefined }, f)).status, 401);
  assert.equal((await extSync(new Request("https://f.test/", { method: "GET" }), SENV, f)).status, 405);
  assert.equal(calls.length, 0);
});
await test("external-sync: sem chave de serviço → 500; sem Redmine nem Pipefy → 501 (antes de ler o banco)", async () => {
  const { f, calls } = fakeFetch(() => ({}));
  assert.equal((await extSync(sCall(), { ...SENV, SUPABASE_SERVICE_ROLE_KEY: undefined }, f)).status, 500);
  const r = await extSync(sCall(), { ...SENV, REDMINE_URL: undefined, PIPEFY_TOKEN: undefined }, f);
  assert.equal(r.status, 501);
  assert.equal(calls.length, 0);
});
await test("external-sync: lê Redmine e Pipefy, aplica no banco com a chave de serviço e resume", async () => {
  const { f, calls } = syncRouter(
    [{ id: R1, system: "REDMINE", external_id: "77" }, { id: R2, system: "PIPEFY", external_id: "card_9" }, { id: R3, system: "REDMINE", external_id: "88" }],
    { R77: { body: { issue: { status: { name: "In Progress" } } } }, Pcard_9: { body: { data: { card: { current_phase: { name: "Em revisão" } } } } }, R88: { status: 404, body: {} } },
    { [R1]: { result: "updated", from: "APROVADO_ROADMAP", to: "EM_DESENVOLVIMENTO" }, [R2]: { result: "unmapped", external_status: "Em revisão", system: "PIPEFY" } });
  const r = await extSync(sCall(), SENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { checked: 3, updated: 1, baseline: 0, unchanged: 0, errors: 1, skipped: 0, unmapped: ["PIPEFY: Em revisão"] });
  const red = calls.find((c) => c.url.includes("/issues/77.json"))!;
  assert.equal(red.url, "https://redmine.x.com/issues/77.json");
  assert.equal(red.init.headers["x-redmine-api-key"], "rk");
  const apply = calls.filter((c) => c.url.endsWith("/rpc/external_apply_status"));
  assert.equal(apply.length, 2);
  assert.deepEqual(JSON.parse(apply[0].init.body), { p_id: R1, p_external_status: "In Progress" });
  assert.equal(apply[0].init.headers.authorization, `Bearer ${SKEY}`);
  assert.equal(apply[0].init.headers.apikey, SKEY);
});
await test("external-sync: sistema não configurado e ids estranhos são pulados, sem chamar ninguém", async () => {
  const { f, calls } = syncRouter(
    [{ id: R1, system: "PIPEFY", external_id: "c1" }, { id: "x", system: "REDMINE", external_id: "1" }, { id: R2, system: "REDMINE", external_id: "../etc" }, { id: R3, system: "OUTRO", external_id: "1" }], {}, {});
  const r = await extSync(sCall(), { ...SENV, PIPEFY_TOKEN: undefined }, f);
  assert.deepEqual(await r.json(), { checked: 0, updated: 0, baseline: 0, unchanged: 0, errors: 0, skipped: 4, unmapped: [] });
  assert.equal(calls.filter((c) => !c.url.endsWith("/rpc/external_sync_pending")).length, 0);
});
await test("external-sync: falha ao listar → 502; erro de rede em uma tarefa não derruba as outras", async () => {
  const bad = fakeFetch(() => ({ status: 500, body: {} }));
  const a = await extSync(sCall(), SENV, bad.f);
  assert.equal(a.status, 502);
  let k = 0;
  const f = (async (url: string, init?: any) => {
    if (url.endsWith("/rpc/external_sync_pending")) return { ok: true, status: 200, json: async () => [{ id: R1, system: "REDMINE", external_id: "1" }, { id: R2, system: "REDMINE", external_id: "2" }] };
    if (url.includes("/issues/1.json")) { k++; throw new Error("rede"); }
    if (url.includes("/issues/2.json")) return { ok: true, status: 200, json: async () => ({ issue: { status: { name: "Closed" } } }) };
    return { ok: true, status: 200, json: async () => ({ result: "updated" }) };
  }) as any;
  const b = await (await extSync(sCall(), SENV, f)).json();
  assert.equal(k, 1); assert.equal(b.errors, 1); assert.equal(b.updated, 1);
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


console.log("admin-users");
const AENV = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_SERVICO" };
const U_ID = "22222222-2222-4222-8222-222222222222";
const acall = (body: unknown, headers: Record<string, string> = { authorization: "Bearer jwt-do-admin" }, method = "POST") =>
  new Request("https://f.test/admin-users", { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
function arouter(over: Partial<Record<string, any>> = {}) {
  return fakeFetch((c) => {
    if (c.url.endsWith("/rpc/admin_get_security")) return over.security ?? { body: { mfa_required: true } };
    if (c.url.endsWith("/auth/v1/admin/users") && c.init.method === "POST") return over.create ?? { status: 200, body: { id: U_ID } };
    if (c.url.endsWith("/rpc/admin_upsert_staff")) return over.staff ?? { body: U_ID };
    if (c.url.endsWith("/rpc/admin_list_staff")) return over.list ?? { body: [{ id: U_ID, email: "a@b.com" }] };
    if (c.url.includes("/auth/v1/admin/users/") && c.init.method === "PUT") return over.put ?? { status: 200, body: { id: U_ID } };
    return { status: 500 };
  });
}
const CREATE = { action: "create", email: " Nova.Pessoa@Clinica.COM ", name: "Nova Pessoa", role: "PO", password: "SenhaForte123" };

await test("política de senha: 10+ caracteres com letra e número", () => {
  for (const ok of ["SenhaForte123", "abcdefghi1", "1234567890a"]) assert.equal(passwordProblem(ok), null, ok);
  for (const bad of ["curta1", "somenteletrasaqui", "12345678901234", "", null, undefined, 42, "a1".repeat(40)]) assert.equal(passwordProblem(bad), "weak_password", String(bad));
});
await test("OPTIONS, método, sem token e ação inválida", async () => {
  const { f } = arouter();
  const o = await adminUsers(acall(null, {}, "OPTIONS"), AENV, f);
  assert.equal(o.status, 204);
  assert.equal(o.headers.get("access-control-allow-origin"), "*");
  assert.equal((await adminUsers(acall(null, {}, "GET"), AENV, f)).status, 405);
  assert.equal((await adminUsers(acall(CREATE, {}), AENV, f)).status, 401);
  assert.equal((await adminUsers(acall({ action: "apagar" }), AENV, f)).status, 400);
  assert.equal((await adminUsers(acall(CREATE), { ...AENV, SUPABASE_SERVICE_ROLE_KEY: undefined }, f)).status, 500);
});
await test("quem não é Admin (o banco nega) recebe 403 e a chave de serviço NÃO é usada", async () => {
  const { f, calls } = arouter({ security: { status: 403, body: { message: "forbidden: user:manage" } } });
  const r = await adminUsers(acall(CREATE), AENV, f);
  assert.equal(r.status, 403);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer jwt-do-admin");
  assert.ok(!JSON.stringify(calls).includes("sb_secret_SERVICO"), "chave de serviço não foi enviada");
});
await test("create: valida, cria no Auth (e-mail confirmado), libera na equipe com o token do Admin", async () => {
  const { f, calls } = arouter();
  const r = await adminUsers(acall(CREATE), AENV, f);
  assert.equal(r.status, 200);
  const out = await r.text();
  assert.deepEqual(JSON.parse(out), { user_id: U_ID, email: "nova.pessoa@clinica.com" });
  assert.ok(!out.includes("SenhaForte123"), "senha nunca volta na resposta");
  const au = calls.find((c) => c.url.endsWith("/auth/v1/admin/users"))!;
  assert.equal(au.init.headers.authorization, "Bearer sb_secret_SERVICO");
  assert.deepEqual(JSON.parse(au.init.body), { email: "nova.pessoa@clinica.com", password: "SenhaForte123", email_confirm: true });
  const st = calls.find((c) => c.url.endsWith("/rpc/admin_upsert_staff"))!;
  assert.equal(st.init.headers.authorization, "Bearer jwt-do-admin", "a liberação usa o token do Admin (auditoria e regras do banco)");
  assert.deepEqual(JSON.parse(st.init.body), { p_email: "nova.pessoa@clinica.com", p_name: "Nova Pessoa", p_role: "PO", p_active: true });
});
await test("create: entradas inválidas são recusadas antes de qualquer chamada ao Auth", async () => {
  for (const [patch, err] of [[{ email: "sem-arroba" }, "invalid_email"], [{ name: "A" }, "invalid_name"], [{ role: "ROOT" }, "invalid_role"], [{ password: "curta" }, "weak_password"]] as const) {
    const { f, calls } = arouter();
    const r = await adminUsers(acall({ ...CREATE, ...patch }), AENV, f);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: err });
    assert.ok(!calls.some((c) => c.url.includes("/auth/v1/")), `${err}: Auth não chamado`);
  }
});
await test("create: e-mail já existente → 409; senha fraca para o Supabase → 400; falha do Auth → 502", async () => {
  let { f } = arouter({ create: { status: 422, body: { msg: "A user with this email address has already been registered" } } });
  let r = await adminUsers(acall(CREATE), AENV, f);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "email_exists" });
  ({ f } = arouter({ create: { status: 422, body: { msg: "Password should be at least 12 characters" } } }));
  assert.equal((await adminUsers(acall(CREATE), AENV, f)).status, 400);
  ({ f } = arouter({ create: { status: 500, body: {} } }));
  assert.equal((await adminUsers(acall(CREATE), AENV, f)).status, 502);
  ({ f } = arouter({ create: { status: 200, body: { id: "nao-e-uuid" } } }));
  assert.equal((await adminUsers(acall(CREATE), AENV, f)).status, 502);
});
await test("create: se a liberação na equipe falhar, devolve o id criado para tentar de novo", async () => {
  const { f } = arouter({ staff: { status: 400, body: { message: "x" } } });
  const r = await adminUsers(acall(CREATE), AENV, f);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "staff_failed", user_id: U_ID });
});
await test("set_password: só para quem é da equipe; senha fraca recusada; sucesso troca a senha", async () => {
  let { f, calls } = arouter();
  let r = await adminUsers(acall({ action: "set_password", user_id: U_ID, password: "NovaSenha2026" }), AENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { user_id: U_ID });
  const put = calls.find((c) => c.init.method === "PUT")!;
  assert.equal(put.url, `${SB}/auth/v1/admin/users/${U_ID}`);
  assert.deepEqual(JSON.parse(put.init.body), { password: "NovaSenha2026" });
  ({ f, calls } = arouter({ list: { body: [{ id: "33333333-3333-4333-8333-333333333333" }] } }));
  r = await adminUsers(acall({ action: "set_password", user_id: U_ID, password: "NovaSenha2026" }), AENV, f);
  assert.equal(r.status, 404);
  assert.ok(!calls.some((c) => c.init.method === "PUT"), "usuário fora da equipe não é tocado");
  ({ f } = arouter());
  assert.equal((await adminUsers(acall({ action: "set_password", user_id: U_ID, password: "curta" }), AENV, f)).status, 400);
  assert.equal((await adminUsers(acall({ action: "set_password", user_id: "x", password: "NovaSenha2026" }), AENV, f)).status, 400);
  ({ f } = arouter({ put: { status: 500, body: {} } }));
  assert.equal((await adminUsers(acall({ action: "set_password", user_id: U_ID, password: "NovaSenha2026" }), AENV, f)).status, 502);
});

console.log(`\n${n} testes de funções passaram`);
