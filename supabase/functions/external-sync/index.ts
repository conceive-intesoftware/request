// Edge Function "external-sync" — traz de volta ao Conceive o andamento das tarefas criadas no Redmine ou no Pipefy.
// Chamada SOMENTE pelo banco (pg_net, a cada 10 minutos pelo agendamento, ou pelo botão "Sincronizar status agora" do painel),
// com o cabeçalho x-webhook-secret (o MESMO WEBHOOK_SECRET da função notify). Cole este arquivo inteiro no editor de
// Edge Functions do Supabase (nome da função: external-sync) e DESLIGUE "Enforce JWT verification" nela.
//
// Como funciona: pergunta ao banco quais solicitações têm tarefa externa ainda aberta, lê o status de cada tarefa no Redmine
// (status da tarefa) ou no Pipefy (fase do card) e entrega o nome ao banco, que decide: só muda a etapa da solicitação se o
// status externo MUDOU desde a última leitura e existir uma linha para ele em private.external_status_map. A mudança passa
// pelos gatilhos normais (auditoria e e-mail ao cliente).
//
// Segredos (Edge Functions → Secrets). O Supabase já injeta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (nunca coloque a
// chave de serviço no site ou no GitHub):
//   WEBHOOK_SECRET                          o mesmo da função notify
//   Redmine: REDMINE_URL, REDMINE_API_KEY   (os mesmos da função external-task)
//   Pipefy:  PIPEFY_TOKEN                   (o mesmo da função external-task)
//
// Resposta (JSON): { checked, updated, baseline, unchanged, unmapped: [...], errors, skipped }

declare const Deno: any;

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any> }>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const base = (u: string) => u.replace(/\/+$/, "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Nome do status da tarefa no Redmine, ou null se não deu para ler. */
async function redmineStatus(env: Env, f: FetchFn, id: string): Promise<string | null> {
  const r = await f(`${base(env.REDMINE_URL!)}/issues/${encodeURIComponent(id)}.json`, {
    headers: { "x-redmine-api-key": env.REDMINE_API_KEY, accept: "application/json" },
  });
  if (!r.ok) return null;
  const name = (await r.json?.().catch(() => null))?.issue?.status?.name;
  return typeof name === "string" && name.trim() ? name : null;
}

/** Nome da fase atual do card no Pipefy, ou null se não deu para ler. */
async function pipefyPhase(env: Env, f: FetchFn, id: string): Promise<string | null> {
  const r = await f("https://api.pipefy.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.PIPEFY_TOKEN}` },
    body: JSON.stringify({ query: "query Fase($id: ID!) { card(id: $id) { current_phase { name } } }", variables: { id } }),
  });
  if (!r.ok) return null;
  const body = await r.json?.().catch(() => null);
  if (Array.isArray(body?.errors) && body.errors.length) return null;
  const name = body?.data?.card?.current_phase?.name;
  return typeof name === "string" && name.trim() ? name : null;
}

export async function handle(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const given = req.headers.get("x-webhook-secret") ?? "";
  if (!env.WEBHOOK_SECRET) return json(401, { error: "unauthorized", reason: "o Secret WEBHOOK_SECRET não está cadastrado na função" });
  if (!given || !safeEqual(given, env.WEBHOOK_SECRET)) return json(401, { error: "unauthorized", reason: "o segredo do banco (notify_secret) é diferente do WEBHOOK_SECRET da função" });

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "not_configured", missing: ["SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (o Supabase injeta sozinho)"] });
  const redmineOk = !!(env.REDMINE_URL && env.REDMINE_API_KEY);
  const pipefyOk = !!env.PIPEFY_TOKEN;
  if (!redmineOk && !pipefyOk) return json(501, { error: "not_configured", missing: ["REDMINE_URL e REDMINE_API_KEY, ou PIPEFY_TOKEN"] });

  const sb = base(env.SUPABASE_URL);
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };
  const rpc = async (name: string, body: unknown) => {
    const r = await fetchFn(`${sb}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`rpc_${name}_${r.status}`);
    return r.json?.();
  };

  let pending: any[];
  try {
    const p = await rpc("external_sync_pending", {});
    pending = Array.isArray(p) ? p : [];
  } catch (e) {
    return json(502, { error: "pending_failed", detail: (e as Error).message });
  }

  const out = { checked: 0, updated: 0, baseline: 0, unchanged: 0, errors: 0, skipped: 0, unmapped: [] as string[] };
  for (const item of pending.slice(0, 50)) {
    const system = item?.system, id = item?.external_id, rid = item?.id;
    if (typeof rid !== "string" || !UUID_RE.test(rid) || typeof id !== "string" || !ID_RE.test(id)) { out.skipped++; continue; }
    if ((system === "REDMINE" && !redmineOk) || (system === "PIPEFY" && !pipefyOk) || (system !== "REDMINE" && system !== "PIPEFY")) { out.skipped++; continue; }
    out.checked++;
    try {
      const name = system === "REDMINE" ? await redmineStatus(env, fetchFn, id) : await pipefyPhase(env, fetchFn, id);
      if (!name) { out.errors++; continue; }
      const res = await rpc("external_apply_status", { p_id: rid, p_external_status: name });
      switch (res?.result) {
        case "updated": out.updated++; break;
        case "baseline": out.baseline++; break;
        case "unchanged": case "same": out.unchanged++; break;
        case "unmapped": {
          const label = `${system}: ${String(res.external_status ?? name).slice(0, 60)}`;
          if (!out.unmapped.includes(label) && out.unmapped.length < 20) out.unmapped.push(label);
          break;
        }
        default: break;
      }
    } catch {
      out.errors++;
    }
  }
  return json(200, out);
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch as unknown as FetchFn));
}
