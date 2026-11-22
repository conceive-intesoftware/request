import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("Não foi possível carregar a verificação anti-robô."));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/** Widget Cloudflare Turnstile. O token é consumido pelo Supabase Auth (CAPTCHA protection). */
export function Turnstile({
  siteKey,
  onToken,
  onProblem,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onProblem?: (msg: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cbs = useRef({ onToken, onProblem });
  cbs.current = { onToken, onProblem };

  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: siteKey,
          language: "pt-br",
          callback: (t: string) => cbs.current.onToken(t),
          "expired-callback": () => cbs.current.onProblem?.("A verificação expirou. Marque novamente."),
          "error-callback": () => cbs.current.onProblem?.("Falha na verificação anti-robô. Recarregue a página."),
        });
      })
      .catch((e: Error) => cbs.current.onProblem?.(e.message));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey]);

  return <div ref={box} />;
}
