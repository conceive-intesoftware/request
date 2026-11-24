import { useCallback, useRef, useState, type ReactNode } from "react";
import { ensureSession, hasSession } from "../lib/api";
import { TURNSTILE_SITE_KEY } from "../lib/supabase";
import { errMsg } from "../lib/format";
import { Banner } from "./ui";
import { Turnstile } from "./Turnstile";

/** Garante a sessão anônima só quando a pessoa realmente precisa dela (votar, responder). Mostra o CAPTCHA se houver. */
export function useEnsureSession(): { ensure: () => Promise<boolean>; captcha: ReactNode } {
  const [needCaptcha, setNeed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const waiter = useRef<((ok: boolean) => void) | null>(null);

  const ensure = useCallback(async (): Promise<boolean> => {
    try {
      if (await hasSession()) return true;
      if (!TURNSTILE_SITE_KEY) {
        await ensureSession();
        return true;
      }
    } catch (e) {
      setMsg(errMsg(e));
      return false;
    }
    setNeed(true);
    return new Promise<boolean>((res) => {
      waiter.current = res;
    });
  }, []);

  const onToken = useCallback(async (token: string) => {
    try {
      await ensureSession(token);
      setNeed(false);
      setMsg(null);
      waiter.current?.(true);
      waiter.current = null;
    } catch (e) {
      setMsg(errMsg(e));
    }
  }, []);

  const captcha = (
    <>
      {needCaptcha && (
        <div className="card">
          <p className="label">Verificação de segurança</p>
          <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={onToken} onProblem={setMsg} />
          <p className="hint">Confirme que você não é um robô para continuar.</p>
        </div>
      )}
      {msg && <Banner>{msg}</Banner>}
    </>
  );
  return { ensure, captcha };
}
