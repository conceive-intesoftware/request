import type { ReactNode } from "react";
import { Link, useRoute } from "../lib/router";

const TABS = [
  { to: "/solicitar", label: "Solicitação de funcionalidade", on: (r: string) => r === "/solicitar" || r === "/" },
  { to: "/acompanhar", label: "Acompanhar sua solicitação", on: (r: string) => r.startsWith("/acompanhar") },
  { to: "/login", label: "Acesso da equipe", on: (r: string) => r === "/login", staff: true },
];

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#4c1d95" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#cg)" />
      <path d="M26 14.5a8 8 0 1 0 0 11" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="28.5" cy="20" r="2.2" fill="#fff" />
    </svg>
  );
}

/** Moldura das páginas públicas: cabeçalho com marca e abas, faixa de título e rodapé. */
export function PublicShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const route = useRoute();
  return (
    <div className="public">
      <header className="site-header">
        <div className="site-header-in">
          <Link to="/solicitar" className="site-brand" aria-label="Conceive — início">
            <Logo />
            <span>
              <strong>Conceive</strong>
              <small>Central de Solicitações</small>
            </span>
          </Link>
          <nav className="site-tabs" aria-label="Seções">
            {TABS.map((t) => (
              <Link key={t.to} to={t.to} className={`site-tab${t.on(route) ? " on" : ""}${t.staff ? " staff" : ""}`} aria-current={t.on(route) ? "page" : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <section className="hero">
        <div className="hero-in">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </section>

      {children}

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} Conceive · Central de Solicitações</span>
        <span>Seus dados são tratados conforme a LGPD.</span>
      </footer>
    </div>
  );
}
