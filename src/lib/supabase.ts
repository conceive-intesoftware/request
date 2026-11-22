import { createClient } from "@supabase/supabase-js";
import { setClient } from "./api";

/** Devolve uma mensagem de erro de configuração, ou null se estiver tudo certo. */
export function initSupabase(): string | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) {
    return "Faltam as variáveis VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (veja o PASSO_A_PASSO).";
  }
  setClient(
    createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }),
  );
  return null;
}

export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";
