// Edge Function "external-task" — cria a tarefa de uma solicitação no Redmine ou no Pipefy.
// Chamada pelo painel (supabase.functions.invoke) com o login da pessoa da equipe. Cole este arquivo inteiro
// no editor de Edge Functions do Supabase (nome da função: external-task). Pode deixar "Verify JWT" ligado.
//
// Quem pode usar? Quem tem a permissão do banco (request:export_dev): a função repassa o token da própria
// pessoa ao PostgREST, então as regras (papel + MFA) continuam sendo as do banco. Nenhuma chave de serviço é usada.
//
// Segredos (Edge Functions → Secrets). O Supabase já injeta SUPABASE_URL e SUPABASE_ANON_KEY.
//   Redmine: REDMINE_URL, REDMINE_API_KEY, REDMINE_PROJECT_ID, (opcional) REDMINE_TRACKER_ID
//   Pipefy:  PIPEFY_TOKEN (token de Service Account), PIPEFY_PIPE_ID,
//            (opcional) PIPEFY_TITLE_FIELD_ID e PIPEFY_DESC_FIELD_ID = ids dos campos do formulário inicial do pipe
//
// Dados pessoais do solicitante (nome, telefone) NUNCA são enviados ao sistema externo.

declare const Deno: any;

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any> }>;

const MODULES: Record<string, string> = {
  FINANCEIRO: "Financeiro", AGENDA: "Agenda", PRONTUARIO: "Prontuário", ESTOQUE_FARMACIA: "Estoque/Farmácia",
  FATURAMENTO_TISS: "Faturamento TISS", OUTRO: "Outro",
};
const TYPES: Record<string, string> = {
  NOVA_FUNCIONALIDADE: "Nova funcionalidade", MELHORIA_FLUXO: "Melhoria de fluxo", SUGESTAO_TECNICA: "Sugestão técnica",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (u: string) => u.replace(/\/+$/, "");

function describe(d: any): { subject: string; description: string } {
  const clinic = d.clinic_name || d.pending_clinic_name || "—";
  const description = [
    String(d.description ?? ""),
    "",
    `Módulo: ${MODULES[d.module] ?? d.module ?? "—"}`,
    `Tipo: ${TYPES[d.type] ?? d.type ?? "—"}`,
    `Clínica: ${clinic}`,
    "Origem: Conceive Requests",
  ].join("\n");
  return { subject: `[${d.protocol}] ${String(d.title ?? "").replace(/\s+/g, " ").trim()}`, description };
}

async function createRedmine(env: Env, f: FetchFn, subject: string, description: string) {
  const url = base(env.REDMINE_URL!);
  const issue: Record<string, unknown> = { project_id: env.REDMINE_PROJECT_ID, subject, description };
  if (env.REDMINE_TRACKER_ID) issue.tracker_id = Number(env.REDMINE_TRACKER_ID);
  const r = await f(`${url}/issues.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-redmine-api-key": env.REDMINE_API_KEY },
    body: JSON.stringify({ issue }),
  });
  const body = await r.json?.().catch(() => null);
  const id = body?.issue?.id;
  if (!r.ok || id === undefined || id === null) throw new Error("redmine_failed");
  return { id: String(id), url: `${url}/issues/${id}` };
}

async function createPipefy(env: Env, f: FetchFn, subject: string, description: string) {
  const fields: { field_id: string; field_value: string }[] = [];
  if (env.PIPEFY_TITLE_FIELD_ID) fields.push({ field_id: env.PIPEFY_TITLE_FIELD_ID, field_value: subject });
  if (env.PIPEFY_DESC_FIELD_ID) fields.push({ field_id: env.PIPEFY_DESC_FIELD_ID, field_value: description });
  const input: Record<string, unknown> = { pipe_id: env.PIPEFY_PIPE_ID };
  if (fields.length) input.fields_attributes = fields;
  const r = await f("https://api.pipefy.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.PIPEFY_TOKEN}` },
    body: JSON.stringify({
      query: "mutation CriarCard($input: CreateCardInput!) { createCard(input: $input) { card { id } } }",
      variables: { input },
    }),
  });
  const body = await r.json?.().catch(() => null);
  const id = body?.data?.createCard?.card?.id;
  if (!r.ok || (Array.isArray(body?.errors) && body.errors.length) || !id) throw new Error("pipefy_failed");
  return { id: String(id), url: `https://app.pipefy.com/open-cards/${id}` };
}

export async function handle(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return json(401, { error: "unauthorized" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  const requestId = body?.request_id, system = body?.system;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId) || (system !== "REDMINE" && system !== "PIPEFY")) {
    return json(400, { error: "invalid_input" });
  }

  const configured = system === "REDMINE"
    ? !!(env.REDMINE_URL && env.REDMINE_API_KEY && env.REDMINE_PROJECT_ID)
    : !!(env.PIPEFY_TOKEN && env.PIPEFY_PIPE_ID);
  if (!configured) return json(501, { error: "not_configured" });
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json(500, { error: "not_configured" });

  const sb = base(env.SUPABASE_URL);
  const sbHeaders = { apikey: env.SUPABASE_ANON_KEY, authorization: auth, "content-type": "application/json" };

  // 1) lê a solicitação COM as permissões da pessoa (o banco decide se pode)
  let detail: any;
  try {
    const r = await fetchFn(`${sb}/rest/v1/rpc/get_request_detail`, { method: "POST", headers: sbHeaders, body: JSON.stringify({ p_id: requestId }) });
    if (!r.ok) return json(403, { error: "forbidden" });
    detail = await r.json?.();
  } catch { return json(403, { error: "forbidden" }); }
  if (!detail) return json(404, { error: "not_found" });
  if (detail.external_id) return json(409, { error: "already_linked" });

  // 2) cria a tarefa (sem dados pessoais)
  const { subject, description } = describe(detail);
  let created: { id: string; url: string };
  try {
    created = system === "REDMINE" ? await createRedmine(env, fetchFn, subject, description) : await createPipefy(env, fetchFn, subject, description);
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }

  // 3) grava o vínculo (mesmo token da pessoa)
  try {
    const r = await fetchFn(`${sb}/rest/v1/rpc/set_external_ref`, {
      method: "POST", headers: sbHeaders,
      body: JSON.stringify({ p_id: requestId, p_system: system, p_external_id: created.id }),
    });
    if (!r.ok) return json(500, { error: "link_failed", system, id: created.id, url: created.url });
  } catch {
    return json(500, { error: "link_failed", system, id: created.id, url: created.url });
  }
  return json(200, { system, id: created.id, url: created.url });
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch as unknown as FetchFn));
}
