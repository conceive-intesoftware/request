import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";

// Roteador mínimo por hash (#/rota). Não depende de biblioteca e funciona em qualquer subcaminho do GitHub Pages.
const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const snapshot = () => window.location.hash.replace(/^#/, "") || "/";

/** Caminho atual sem query string. */
export function useRoute(): string {
  const full = useSyncExternalStore(subscribe, snapshot, () => "/");
  return full.split("?")[0] || "/";
}

export function navigate(to: string) {
  window.location.hash = to;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}

/** match("/acompanhar/abc", "/acompanhar/:token") => { token: "abc" } */
export function match(route: string, pattern: string): Record<string, string> | null {
  const r = route.split("/").filter(Boolean);
  const p = pattern.split("/").filter(Boolean);
  if (r.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(r[i]);
    else if (p[i] !== r[i]) return null;
  }
  return params;
}
