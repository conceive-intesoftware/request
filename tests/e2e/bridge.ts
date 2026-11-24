// Servidor de testes E2E: serve o site compilado e traduz as chamadas do cliente falso do navegador
// em SQL real, usando as mesmas identidades (papel + claims JWT) que o Supabase usaria.
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { Db, fakeClient, type FakeState } from "../fake-supabase";

export const PASSWORD = "Senha#12345";
export const MFA_CODE = "123456";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export function startBridge(db: Db, siteDir: string, port: number): Promise<Server> {
  const sessions = new Map<string, { state: FakeState; client: ReturnType<typeof fakeClient>; verified: Set<string> }>();
  const sess = (sid: string) => {
    let s = sessions.get(sid);
    if (!s) {
      const state: FakeState = { identity: null, requireCaptcha: false };
      s = { state, client: fakeClient(db, state), verified: new Set() };
      sessions.set(sid, s);
    }
    return s;
  };
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

  async function handle(path: string, sid: string, body: any): Promise<unknown> {
    const s = sess(sid);
    const { state, client } = s;
    switch (path) {
      case "rpc": {
        const out: any = await client.rpc(body.fn, body.args ?? {});
        if (process.env.E2E_DEBUG && out?.error) console.error("[rpc erro]", body.fn, out.error.message);
        return out;
      }
      case "auth/getSession":
        return client.auth.getSession();
      case "auth/anon":
        return client.auth.signInAnonymously(body);
      case "auth/password": {
        const email = String(body.email ?? "").toLowerCase();
        const uid = db.sql(`select id from auth.users where lower(email) = ${lit(email)}`).trim();
        if (!uid || body.password !== PASSWORD) return { data: null, error: { message: "Invalid login credentials" } };
        state.identity = { uid, aal: "aal1", anon: false };
        return { data: { user: { id: uid } }, error: null };
      }
      case "auth/signout":
        state.identity = null;
        return { error: null };
      case "auth/mfa/aal":
        return { data: { currentLevel: state.identity?.aal ?? null } };
      case "auth/mfa/list": {
        const ok = state.identity && s.verified.has(state.identity.uid);
        return { data: { totp: ok ? [{ id: "f1", status: "verified" }] : [], all: ok ? [{ id: "f1", factor_type: "totp", status: "verified" }] : [] } };
      }
      case "auth/mfa/unenroll":
        return { error: null };
      case "auth/mfa/enroll":
        return { data: { id: "f1", totp: { qr_code: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>", secret: "JBSWY3DPEHPK3PXP" } }, error: null };
      case "auth/mfa/verify":
        if (!state.identity || body.code !== MFA_CODE) return { error: { message: "Invalid TOTP code" } };
        state.identity.aal = "aal2";
        s.verified.add(state.identity.uid);
        return { error: null };
      case "storage/upload":
        return client.storage.from(body.bucket).upload(body.path, { type: body.type, size: body.size });
      case "storage/signed":
        return client.storage.from(body.bucket).createSignedUrl(body.path, 60);
      case "functions/external-task": {
        // Simula a Edge Function: cria um ID falso e grava o vínculo com a identidade de quem chamou.
        const id = body.system === "REDMINE" ? "4321" : "pf-987";
        const r = await client.rpc("set_external_ref", { p_id: body.request_id, p_system: body.system, p_external_id: id });
        if (r.error) return { data: null, error: { message: r.error.message } };
        return { data: { system: body.system, id }, error: null };
      }
      case "clinics":
        return client.from("clinics").select("*").order("name");
      default:
        return { data: null, error: { message: `rota desconhecida: ${path}` } };
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        try {
          const out = await handle(url.pathname.slice(5), String(req.headers["x-sid"] ?? "anon"), raw ? JSON.parse(raw) : {});
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: null, error: { message: (e as Error).message } }));
        }
      });
      return;
    }
    const file = join(siteDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (existsSync(file)) {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } else {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
