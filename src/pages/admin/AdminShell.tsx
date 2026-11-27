import { useEffect, useState } from "react";
import type { AuthState } from "../../lib/useAuth";
import { Link, navigate, useRoute } from "../../lib/router";
import { Banner, Spinner } from "../../components/ui";
import { Logo } from "../../components/PublicShell";
import { Icon, PulseLine, type IconName } from "../../components/Icon";
import { STAFF_ROLES, labelOf } from "../../lib/labels";
import Dashboard from "./Dashboard";
import Metrics from "./Metrics";
import ImportPage from "./Import";
import { ThemeToggle } from "../../components/ThemeToggle";
import { Clinics, Team } from "./Manage";
import { ChangePassword } from "../../components/ChangePassword";

export default function AdminShell({ auth }: { auth: AuthState }) {
  const route = useRoute();
  const [pwOpen, setPwOpen] = useState(false);
  const { ctx, loading } = auth;

  useEffect(() => {
    if (!loading && !ctx?.uid) {
      // Guarda o destino (ex.: link do e-mail da equipe) para voltar a ele depois do login.
      try { if (window.location.hash.includes("abrir=")) sessionStorage.setItem("conceive:next", window.location.hash); } catch { /* sem armazenamento */ }
      navigate("/login");
    }
  }, [loading, ctx]);

  if (loading) return <main className="page"><Spinner /></main>;
  if (!ctx?.uid) return null;

  // Logado, mas sem papel: não é da equipe ou não concluiu o MFA (aal2).
  if (!ctx.role) {
    return (
      <main className="page tiny">
        <Banner>
          {ctx.is_anonymous
            ? "Esta sessão é de cliente, não de equipe."
            : ctx.aal !== "aal2"
              ? "Autenticação em dois fatores pendente. Entre novamente."
              : "Seu acesso ainda não foi liberado. Peça a um administrador."}
        </Banner>
        <button className="btn" onClick={() => void auth.signOut().then(() => navigate("/login"))}>Sair</button>
      </main>
    );
  }

  const can = (p: string) => ctx.permissions.includes(p);
  const page =
    route === "/admin/clinicas" && can("clinic:manage") ? <Clinics /> :
    route === "/admin/equipe" && can("user:manage") ? <Team meId={ctx.uid} /> :
    route === "/admin/metricas" && can("metrics:read") ? <Metrics /> :
    route === "/admin/importar" && can("import:run") ? <ImportPage /> :
    <Dashboard ctx={ctx} />;

  const items: { to: string; label: string; icon: IconName; show: boolean }[] = [
    { to: "/admin", label: "Solicitações", icon: "list", show: true },
    { to: "/admin/metricas", label: "Métricas", icon: "chart", show: can("metrics:read") },
    { to: "/admin/clinicas", label: "Clínicas", icon: "building", show: can("clinic:manage") },
    { to: "/admin/equipe", label: "Equipe", icon: "users", show: can("user:manage") },
    { to: "/admin/importar", label: "Importar", icon: "upload", show: can("import:run") },
  ];
  // Atalhos para o site do cliente. Abrem em NOVA ABA: o painel (e o login da equipe) continuam abertos aqui.
  const publicLinks: { to: string; label: string; hint: string; icon: IconName }[] = [
    { to: "/solicitar", label: "Nova solicitação", hint: "Formulário do cliente", icon: "plus" },
    { to: "/comunidade", label: "Roadmap e votos", hint: "Evolução e votação", icon: "compass" },
    { to: "/acompanhar", label: "Acompanhamento", hint: "Consulta pelo link", icon: "search" },
  ];
  const initials = (ctx.name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

  return (
    <div className="app">
      <a className="skip-link" href="#conteudo" onClick={(e) => { e.preventDefault(); document.getElementById("conteudo")?.focus(); }}>Pular para o conteúdo</a>
      <aside className="sidebar">
        <a className="side-brand" href="#/solicitar" target="_blank" rel="noopener noreferrer"
           aria-label="Abrir o site público da Conceive em uma nova aba" title="Abrir o site público (nova aba)">
          <Logo size={34} />
          <span><strong>Conceive</strong><small>Painel da equipe</small></span>
          <Icon name="external" size={14} className="brand-ext" />
        </a>
        <PulseLine className="side-pulse" />
        <nav className="side-nav" aria-label="Painel">
          {items.filter((i) => i.show).map((i) => (
            <Link key={i.to} to={i.to} className={route === i.to ? "on" : ""} aria-current={route === i.to ? "page" : undefined}>
              <Icon name={i.icon} size={18} /><span>{i.label}</span>
            </Link>
          ))}
        </nav>
        <section className="side-public" aria-labelledby="side-public-title">
          <p className="sp-label" id="side-public-title"><span className="sp-dot" aria-hidden="true" />Site público</p>
          <ul>
            {publicLinks.map((l) => (
              <li key={l.to}>
                <a href={`#${l.to}`} target="_blank" rel="noopener noreferrer" aria-label={`${l.label} (abre em nova aba)`} title={`${l.label} (nova aba)`}>
                  <span className="sp-ico" aria-hidden="true"><Icon name={l.icon} size={16} /></span>
                  <span className="sp-txt"><strong>{l.label}</strong><small>{l.hint}</small></span>
                  <Icon name="external" size={14} className="sp-arrow" />
                </a>
              </li>
            ))}
          </ul>
        </section>
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{initials}</span>
          <span className="who"><strong>{ctx.name}</strong><small>{labelOf(STAFF_ROLES, ctx.role)}</small></span>
        </div>
        <button className="side-link" onClick={() => setPwOpen(true)}><Icon name="key" size={16} /><span>Alterar minha senha</span></button>
      </aside>
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
      <div className="app-main">
        <header className="app-top">
          <span className="app-crumb">{items.find((i) => i.to === route)?.label ?? "Solicitações"}</span>
          <span className="push" />
          <ThemeToggle />
          <button className="btn btn-ghost" onClick={() => void auth.signOut().then(() => navigate("/login"))}><Icon name="logout" size={16} /> Sair</button>
        </header>
        <main className="page" id="conteudo" tabIndex={-1}>{page}</main>
      </div>
    </div>
  );
}
