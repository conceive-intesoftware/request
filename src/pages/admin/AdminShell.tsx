import { useEffect } from "react";
import type { AuthState } from "../../lib/useAuth";
import { Link, navigate, useRoute } from "../../lib/router";
import { Banner, Spinner } from "../../components/ui";
import { Logo } from "../../components/PublicShell";
import Dashboard from "./Dashboard";
import Metrics from "./Metrics";
import ImportPage from "./Import";
import { ThemeToggle } from "../../components/ThemeToggle";
import { Clinics, Team } from "./Manage";

export default function AdminShell({ auth }: { auth: AuthState }) {
  const route = useRoute();
  const { ctx, loading } = auth;

  useEffect(() => {
    if (!loading && !ctx?.uid) navigate("/login");
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

  return (
    <div className="shell">
      <a className="skip-link" href="#conteudo" onClick={(e) => { e.preventDefault(); document.getElementById("conteudo")?.focus(); }}>Pular para o conteúdo</a>
      <header className="topbar">
        <span className="admin-brand"><Logo size={28} /><span><strong>Conceive</strong><small>Painel da equipe</small></span></span>
        <nav>
          <Link to="/admin" className={route === "/admin" ? "on" : ""}>Solicitações</Link>
          {can("metrics:read") && <Link to="/admin/metricas" className={route === "/admin/metricas" ? "on" : ""}>Métricas</Link>}
          {can("clinic:manage") && <Link to="/admin/clinicas" className={route === "/admin/clinicas" ? "on" : ""}>Clínicas</Link>}
          {can("user:manage") && <Link to="/admin/equipe" className={route === "/admin/equipe" ? "on" : ""}>Equipe</Link>}
          {can("import:run") && <Link to="/admin/importar" className={route === "/admin/importar" ? "on" : ""}>Importar</Link>}
        </nav>
        <span className="push muted small">{ctx.name}</span>
        <ThemeToggle />
        <button className="btn btn-ghost" onClick={() => void auth.signOut().then(() => navigate("/login"))}>Sair</button>
      </header>
      <main className="page" id="conteudo" tabIndex={-1}>{page}</main>
    </div>
  );
}
