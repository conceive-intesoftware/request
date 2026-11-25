import type { ReactNode } from "react";
import { Link, useRoute } from "../lib/router";
import { ThemeToggle } from "./ThemeToggle";
import { Icon, PulseLine, type IconName } from "./Icon";

const TABS: { to: string; label: string; icon: IconName; on: (r: string) => boolean; staff?: boolean }[] = [
  { to: "/solicitar", label: "Solicitação de funcionalidade", icon: "file-plus", on: (r: string) => r === "/solicitar" || r === "/" },
  { to: "/acompanhar", label: "Acompanhar sua solicitação", icon: "compass", on: (r: string) => r.startsWith("/acompanhar") },
  { to: "/comunidade", label: "Roadmap e votação", icon: "megaphone", on: (r: string) => r === "/comunidade" },
  { to: "/login", label: "Acesso da equipe", icon: "lock", on: (r: string) => r === "/login", staff: true },
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
      <a className="skip-link" href="#conteudo" onClick={(e) => { e.preventDefault(); document.getElementById("conteudo")?.focus(); }}>Pular para o conteúdo</a>
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
                <Icon name={t.icon} size={16} />{t.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <section className="hero">
        <PulseLine className="hero-pulse" />
        <div className="hero-in">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </section>

      <div id="conteudo" tabIndex={-1} className="content-anchor">{children}</div>

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} Conceive · Central de Solicitações</span>
        <span>Seus dados são tratados conforme a LGPD.</span>
      </footer>
    </div>
  );
}
