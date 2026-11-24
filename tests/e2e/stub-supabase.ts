// SOMENTE PARA TESTES E2E: substitui @supabase/supabase-js no navegador por um cliente que fala com
// tests/e2e/bridge.ts, que por sua vez executa tudo num Postgres real (com RLS, RPCs e triggers).
const SID = (() => {
  let s = localStorage.getItem("e2e-sid");
  if (!s) {
    s = crypto.randomUUID();
    localStorage.setItem("e2e-sid", s);
  }
  return s;
})();

async function call(path: string, body: unknown = {}): Promise<any> {
  const r = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sid": SID },
    body: JSON.stringify(body),
  });
  return r.json();
}

const listeners = new Set<(e: string, s: unknown) => void>();
const emit = (ev: string) => setTimeout(() => listeners.forEach((cb) => cb(ev, null)), 40);

export function createClient() {
  return {
    rpc: (fn: string, args: unknown) => call("rpc", { fn, args }),
    auth: {
      getSession: () => call("auth/getSession"),
      signInAnonymously: async (o: unknown) => {
        const r = await call("auth/anon", o);
        emit("SIGNED_IN");
        return r;
      },
      signInWithPassword: async (o: unknown) => {
        const r = await call("auth/password", o);
        emit("SIGNED_IN");
        return r;
      },
      signOut: async () => {
        const r = await call("auth/signout");
        emit("SIGNED_OUT");
        return r;
      },
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: () => call("auth/mfa/aal"),
        listFactors: () => call("auth/mfa/list"),
        unenroll: (o: unknown) => call("auth/mfa/unenroll", o),
        enroll: (o: unknown) => call("auth/mfa/enroll", o),
        challengeAndVerify: async (o: unknown) => {
          const r = await call("auth/mfa/verify", o);
          emit("MFA_CHALLENGE_VERIFIED");
          return r;
        },
      },
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, file: File) => call("storage/upload", { bucket, path, type: file.type, size: file.size }),
        createSignedUrl: (path: string) => call("storage/signed", { bucket, path }),
      }),
    },
    functions: {
      invoke: async (name: string, o: { body?: unknown }) => {
        const r = await call(`functions/${name}`, o?.body ?? {});
        return r.error ? { data: null, error: { message: r.error.message, context: { json: async () => r.error } } } : r;
      },
    },
    from: (table: string) => ({ select: () => ({ order: () => call("clinics", { table }) }) }),
  };
}
