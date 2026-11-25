// Edge Function "admin-users" — o Admin cria usuários da equipe e redefine senhas dentro do painel.
// Cole este arquivo inteiro no editor de Edge Functions do Supabase (nome: admin-users) e deixe "Verify JWT" LIGADO.
//
// Segurança: antes de usar a chave de serviço, a função confirma COM O TOKEN DA PRÓPRIA PESSOA que ela é Admin
// (a RPC admin_get_security exige a permissão user:manage e o MFA, se exigido). A chave de serviço só existe aqui,
// dentro do Supabase (SUPABASE_SERVICE_ROLE_KEY é injetada automaticamente); nunca vai para o navegador.
// Senhas nunca são gravadas em log nem devolvidas na resposta.
//
// Ações (JSON):  { action: "create", email, name, role, password }  e  { action: "set_password", user_id, password }

declare const Deno: any;

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any> }>;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const ROLES = ["ADMIN", "PO", "SUPPORT", "DEV_VIEWER"];
const base = (u: string) => u.replace(/\/+$/, "");

/** Mínimo de 10 caracteres, com letra e número. (O Supabase aplica a própria regra por cima.) */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string" || p.length < 10) return "weak_password";
  if (p.length > 72 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) return "weak_password";
  return null;
}

export async function handle(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return json(401, { error: "unauthorized" });
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "not_configured" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  const action = body?.action;
  if (action !== "create" && action !== "set_password") return json(400, { error: "invalid_input" });

  const sb = base(env.SUPABASE_URL);
  const asCaller = { apikey: env.SUPABASE_ANON_KEY, authorization: auth, "content-type": "application/json" };
  const asService = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };

  // 1) quem chama precisa ser Admin (decidido pelo banco, com o token da pessoa)
  try {
    const r = await fetchFn(`${sb}/rest/v1/rpc/admin_get_security`, { method: "POST", headers: asCaller, body: "{}" });
    if (!r.ok) return json(403, { error: "forbidden" });
  } catch { return json(403, { error: "forbidden" }); }

  if (action === "create") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "invalid_email" });
    if (name.length < 2 || name.length > 120) return json(400, { error: "invalid_name" });
    if (!ROLES.includes(body.role)) return json(400, { error: "invalid_role" });
    if (passwordProblem(body.password)) return json(400, { error: "weak_password" });

    let userId = "";
    try {
      const r = await fetchFn(`${sb}/auth/v1/admin/users`, {
        method: "POST", headers: asService,
        body: JSON.stringify({ email, password: body.password, email_confirm: true }),
      });
      const j = await r.json?.();
      if (!r.ok) {
        const msg = String(j?.msg ?? j?.message ?? j?.error_code ?? "");
        if (r.status === 422 && /already|registered|exists/i.test(msg)) return json(409, { error: "email_exists" });
        if (/password|weak/i.test(msg)) return json(400, { error: "weak_password" });
        return json(502, { error: "auth_failed" });
      }
      userId = String(j?.id ?? "");
    } catch { return json(502, { error: "auth_failed" }); }
    if (!UUID_RE.test(userId)) return json(502, { error: "auth_failed" });

    try {
      const r = await fetchFn(`${sb}/rest/v1/rpc/admin_upsert_staff`, {
        method: "POST", headers: asCaller,
        body: JSON.stringify({ p_email: email, p_name: name, p_role: body.role, p_active: true }),
      });
      if (!r.ok) return json(500, { error: "staff_failed", user_id: userId });
    } catch { return json(500, { error: "staff_failed", user_id: userId }); }
    return json(200, { user_id: userId, email });
  }

  // set_password: só para quem já é da equipe (a chave de serviço nunca mexe em contas de fora)
  const target = String(body.user_id ?? "");
  if (!UUID_RE.test(target)) return json(400, { error: "invalid_input" });
  if (passwordProblem(body.password)) return json(400, { error: "weak_password" });
  try {
    const r = await fetchFn(`${sb}/rest/v1/rpc/admin_list_staff`, { method: "POST", headers: asCaller, body: "{}" });
    if (!r.ok) return json(403, { error: "forbidden" });
    const staff = (await r.json?.()) ?? [];
    if (!Array.isArray(staff) || !staff.some((s: any) => s?.id === target)) return json(404, { error: "not_found" });
  } catch { return json(403, { error: "forbidden" }); }
  try {
    const r = await fetchFn(`${sb}/auth/v1/admin/users/${target}`, { method: "PUT", headers: asService, body: JSON.stringify({ password: body.password }) });
    if (!r.ok) {
      const j = await r.json?.().catch?.(() => null);
      return json(/password|weak/i.test(String(j?.msg ?? j?.message ?? "")) ? 400 : 502, { error: /password|weak/i.test(String(j?.msg ?? j?.message ?? "")) ? "weak_password" : "auth_failed" });
    }
  } catch { return json(502, { error: "auth_failed" }); }
  return json(200, { user_id: target });
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch as unknown as FetchFn));
}
