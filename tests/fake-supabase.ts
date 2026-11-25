// Cliente Supabase FALSO para testes: cada chamada vira SQL real num Postgres local,
// executado com o papel (anon/authenticated) e os claims JWT (sub, aal, is_anonymous) da identidade atual.
// Assim o src/lib/api.ts é testado contra o banco de verdade (nomes de parâmetros, formatos, RLS, erros).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface Identity {
  uid: string;
  aal: "aal1" | "aal2";
  anon: boolean;
}
export interface FakeState {
  identity: Identity | null;
  requireCaptcha: boolean;
}

export class DbError extends Error {}

export class Db {
  private psql: string[];
  constructor(public name: string, psqlCmd = process.env.PSQL_CMD ?? "psql") {
    this.psql = psqlCmd.split(" ").filter(Boolean);
  }
  private exec(db: string, args: string[], input?: string) {
    const r = spawnSync(this.psql[0], [...this.psql.slice(1), "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], {
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
      throw new DbError(m ? m[1] : r.stderr.trim() || "psql falhou");
    }
    return r.stdout;
  }
  /** SQL como superuser (fixtures). */
  sql(q: string): string {
    return this.exec(this.name, ["-c", q]);
  }
  file(contents: string) {
    this.exec(this.name, ["-f", "-"], contents);
  }
  recreate() {
    this.exec("postgres", ["-c", `drop database if exists ${this.name}`]);
    this.exec("postgres", ["-c", `create database ${this.name}`]);
  }
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.some((e) => e !== null && typeof e === "object")) return `'${JSON.stringify(v).replace(/'/g, "''")}'`; // jsonb (array de objetos)
  if (Array.isArray(v)) {
    if (v.length === 0) return "'{}'";
    const els = v.map((e) => `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",");
    return `'{${els.replace(/'/g, "''")}}'`;
  }
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** Senhas definidas pelas funções de administração falsas (id do usuário → senha). O E2E usa para validar o login. */
export const fakePasswords = new Map<string, string>();

/** Roda a Edge Function admin-users DE VERDADE, trocando só a rede: PostgREST vira SQL com a identidade de quem chamou, e o Auth vira auth.users. */
async function invokeAdminUsers(db: Db, client: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }> }, body: unknown) {
  const { handle } = await import("../supabase/functions/admin-users/index");
  const fetchFn = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const rpcM = /\/rest\/v1\/rpc\/(\w+)$/.exec(path);
    if (rpcM) {
      const r = await client.rpc(rpcM[1], JSON.parse(init.body || "{}"));
      return { ok: !r.error, status: r.error ? 400 : 200, json: async () => (r.error ? { message: r.error.message } : r.data) };
    }
    if (path === "/auth/v1/admin/users" && init.method === "POST") {
      const b = JSON.parse(init.body);
      if (db.sql(`select count(*) from auth.users where lower(email) = ${lit(b.email)}`).trim() !== "0") {
        return { ok: false, status: 422, json: async () => ({ msg: "A user with this email address has already been registered" }) };
      }
      const id = db.sql(`insert into auth.users (email) values (${lit(b.email)}) returning id`).trim().split("\n")[0];
      fakePasswords.set(id, b.password);
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    const put = /\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
    if (put && init.method === "PUT") {
      fakePasswords.set(put[1], JSON.parse(init.body).password);
      return { ok: true, status: 200, json: async () => ({ id: put[1] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const req = new Request("https://f.test/admin-users", { method: "POST", headers: { authorization: "Bearer jwt-falso", "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await handle(req, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" }, fetchFn);
  const j = await res.json();
  return res.ok ? { data: j, error: null } : { data: null, error: { message: `FunctionsHttpError ${res.status}`, context: { json: async () => j } } };
}

export function fakeClient(db: Db, state: FakeState) {
  const metaCache = new Map<string, { ret: string; set: boolean }>();

  const prefix = () => {
    const id = state.identity;
    const role = id ? "authenticated" : "anon";
    const claims = id ? JSON.stringify({ sub: id.uid, role: "authenticated", aal: id.aal, is_anonymous: id.anon }) : "";
    const headers = JSON.stringify({ "x-forwarded-for": "198.51.100.7, 10.0.0.1", "user-agent": "contract-test/1.0" });
    return `begin; set local role ${role}; select set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(headers)}, true);`;
  };
  const lastLine = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  /** Executa como a identidade atual, sem ler resultado (INSERT, void...). */
  const asIdentity = (query: string) => db.sql(`${prefix()} ${query}; commit;`);
  /** Executa uma expressão escalar e devolve seu texto ("" se NULL). O marcador @@ evita confundir com a linha do set_config. */
  const scalar = (expr: string): string => {
    const out = db.sql(`${prefix()} select '@@' || coalesce((${expr})::text, ''); commit;`);
    const line = out.split("\n").find((l) => l.startsWith("@@"));
    if (line === undefined) throw new DbError("resposta vazia do banco");
    return line.slice(2);
  };

  const meta = (fn: string) => {
    let m = metaCache.get(fn);
    if (!m) {
      const out = lastLine(db.sql(`select prorettype::regtype::text || '|' || proretset::text from pg_proc where proname = ${lit(fn)} and pronamespace = 'public'::regnamespace`));
      if (!out) throw new DbError(`function public.${fn} does not exist`);
      const [ret, set] = out.split("|");
      m = { ret, set: set === "true" };
      metaCache.set(fn, m);
    }
    return m;
  };

  const self = {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      try {
        const m = meta(fn);
        const call = `public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ")})`;
        let out: string;
        if (m.ret === "void") {
          asIdentity(`select ${call}`);
          return { data: null, error: null };
        } else if (m.set) {
          out = scalar(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from ${call} t`);
        } else {
          out = scalar(`select to_jsonb(${call})`);
        }
        return { data: out === "" ? null : JSON.parse(out), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },

    functions: {
      async invoke(name: string, opts?: { body?: unknown }) {
        if (name !== "admin-users") return { data: null, error: { message: `função desconhecida: ${name}` } };
        return invokeAdminUsers(db, self as never, opts?.body);
      },
    },

    auth: {
      async updateUser(o: { password?: string }) {
        if (!state.identity) return { data: null, error: { message: "Auth session missing!" } };
        if ((o.password ?? "").length < 10) return { data: null, error: { message: "Password should be at least 10 characters" } };
        fakePasswords.set(state.identity.uid, o.password!);
        return { data: { user: { id: state.identity.uid } }, error: null };
      },
      async getSession() {
        const id = state.identity;
        return { data: { session: id ? { user: { id: id.uid } } : null }, error: null };
      },
      async signInAnonymously(opts?: { options?: { captchaToken?: string } }) {
        if (state.requireCaptcha && !opts?.options?.captchaToken) {
          return { data: { user: null }, error: { message: "captcha verification process failed" } };
        }
        const uid = randomUUID();
        db.sql(`insert into auth.users (id, email, is_anonymous) values ('${uid}', null, true)`);
        state.identity = { uid, aal: "aal1", anon: true };
        return { data: { user: { id: uid } }, error: null };
      },
    },

    storage: {
      from(bucket: string) {
        return {
          // Imita o serviço de Storage: valida tipo/tamanho do bucket e depois aplica a RLS de INSERT.
          async upload(path: string, file: { type: string; size: number }, _opts?: unknown) {
            try {
              const b = lastLine(db.sql(`select coalesce(file_size_limit::text,'') || '|' || coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets where id = ${lit(bucket)}`));
              const [limit, mimes] = b.split("|");
              if (mimes && !mimes.split(",").includes(file.type)) throw new DbError("mime type not supported");
              if (limit && file.size > Number(limit)) throw new DbError("The object exceeded the maximum allowed size");
              const uid = state.identity?.uid ?? "";
              asIdentity(`insert into storage.objects (bucket_id, name, owner, metadata) values (${lit(bucket)}, ${lit(path)}, ${lit(uid)}::uuid, ${lit({ mimetype: file.type, size: file.size })}::jsonb)`);
              return { data: { path }, error: null };
            } catch (e) {
              return { data: null, error: { message: (e as Error).message } };
            }
          },
          async createSignedUrl(path: string, _secs: number) {
            try {
              const n = Number(scalar(`select count(*) from storage.objects where bucket_id = ${lit(bucket)} and name = ${lit(path)}`));
              if (!n) return { data: null, error: { message: "Object not found" } };
              return { data: { signedUrl: `https://signed.example/${bucket}/${path}?token=x` }, error: null };
            } catch (e) {
              return { data: null, error: { message: (e as Error).message } };
            }
          },
        };
      },
    },

    // Só o que o api.ts usa: from("clinics").select(...).order("name")
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            async order(_col: string) {
              if (table !== "clinics") return { data: null, error: { message: "tabela não suportada no fake" } };
              try {
                const out = scalar(`select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'active', c.active,
                  'clinic_units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name)), '[]'::jsonb) from public.clinic_units u where u.clinic_id = c.id)) order by c.name), '[]'::jsonb) from public.clinics c`);
                return { data: JSON.parse(out || "[]"), error: null };
              } catch (e) {
                return { data: null, error: { message: (e as Error).message } };
              }
            },
          };
        },
      };
    },
  };
  return self;
}
