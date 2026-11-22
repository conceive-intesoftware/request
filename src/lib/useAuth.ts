import { useCallback, useEffect, useState } from "react";
import { client, myContext } from "./api";
import type { Ctx } from "./types";

export interface AuthState {
  loading: boolean;
  ctx: Ctx | null; // ctx.role === null => sem acesso de equipe (ou sem MFA)
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<{ loading: boolean; ctx: Ctx | null }>({ loading: true, ctx: null });

  const reload = useCallback(async () => {
    try {
      const { data } = await client().auth.getSession();
      if (!data.session) {
        setState({ loading: false, ctx: null });
        return;
      }
      setState({ loading: false, ctx: await myContext() });
    } catch {
      setState({ loading: false, ctx: null });
    }
  }, []);

  useEffect(() => {
    void reload();
    const { data } = client().auth.onAuthStateChange(() => {
      // setTimeout evita chamar o Supabase de dentro do callback (risco de deadlock documentado)
      setTimeout(() => void reload(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [reload]);

  const signOut = useCallback(async () => {
    await client().auth.signOut();
    setState({ loading: false, ctx: null });
  }, []);

  return { ...state, reload, signOut };
}
