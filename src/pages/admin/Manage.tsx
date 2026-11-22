import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/api";
import type { ClinicAdmin, StaffMember, StaffRole } from "../../lib/types";
import { STAFF_ROLES, labelOf } from "../../lib/labels";
import { errMsg } from "../../lib/format";
import { Banner, Select, Spinner } from "../../components/ui";

export function Clinics() {
  const [list, setList] = useState<ClinicAdmin[] | null>(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList(await api.listClinicsAdmin()); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errMsg(e)); }
  }

  return (
    <div className="stack">
      <header className="page-head"><h1>Clínicas e unidades</h1><p className="muted">O formulário público só aceita clínicas ativas desta lista.</p></header>
      {error && <Banner>{error}</Banner>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(async () => { await api.upsertClinic(null, name, true); setName(""); }); }}>
        <input className="input" placeholder="Nome da nova clínica" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} aria-label="Nome da clínica" />
        <button className="btn btn-primary" disabled={!name.trim()}>Adicionar clínica</button>
      </form>
      {!list && <Spinner />}
      {list?.map((c) => (
        <section key={c.id} className="card">
          <div className="row between">
            <h2 className={c.active ? "" : "muted"}>{c.name} {!c.active && <span className="tag">inativa</span>}</h2>
            <button className="btn" onClick={() => void act(() => api.upsertClinic(c.id, c.name, !c.active))}>{c.active ? "Desativar" : "Reativar"}</button>
          </div>
          <p>{c.clinic_units.length === 0 ? <span className="muted">Sem unidades.</span> : c.clinic_units.map((u) => <span key={u.id} className="tag outline">{u.name}</span>)}</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); const v = (unit[c.id] ?? "").trim(); if (v) void act(async () => { await api.addUnit(c.id, v); setUnit({ ...unit, [c.id]: "" }); }); }}>
            <input className="input" placeholder="Nova unidade (ex.: Unidade 2)" value={unit[c.id] ?? ""} maxLength={160} onChange={(e) => setUnit({ ...unit, [c.id]: e.target.value })} aria-label={`Nova unidade de ${c.name}`} />
            <button className="btn">Adicionar unidade</button>
          </form>
        </section>
      ))}
    </div>
  );
}

export function Team({ meId }: { meId: string | null }) {
  const [list, setList] = useState<StaffMember[] | null>(null);
  const [f, setF] = useState<{ email: string; name: string; role: StaffRole }>({ email: "", name: "", role: "SUPPORT" });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList(await api.adminListStaff()); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(email: string, name: string, role: StaffRole, active: boolean, msg: string) {
    setError(null); setOk(null);
    try { await api.adminUpsertStaff(email, name, role, active); setOk(msg); await load(); } catch (e) { setError(errMsg(e)); }
  }

  return (
    <div className="stack">
      <header className="page-head"><h1>Equipe</h1>
        <p className="muted">Primeiro crie o usuário em <strong>Supabase → Authentication → Users</strong>; depois libere o acesso aqui. Cada pessoa cadastra seu autenticador (MFA) no primeiro login.</p></header>
      {error && <Banner>{error}</Banner>}
      {ok && <Banner kind="ok">{ok}</Banner>}
      <form className="card grid3" onSubmit={(e) => { e.preventDefault(); void save(f.email, f.name, f.role, true, "Acesso liberado."); }}>
        <input className="input" type="email" required placeholder="e-mail (já existente no Supabase Auth)" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="E-mail" />
        <input className="input" required minLength={2} placeholder="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Nome" />
        <Select value={f.role} onChange={(v) => setF({ ...f, role: v as StaffRole })} options={STAFF_ROLES} ariaLabel="Papel" />
        <button className="btn btn-primary full">Liberar acesso</button>
      </form>
      {!list && <Spinner />}
      {list && (
        <div className="table-wrap">
          <table className="table static">
            <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}{m.id === meId && <span className="tag outline">você</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    <Select ariaLabel={`Papel de ${m.name}`} value={m.role} options={STAFF_ROLES} onChange={(r) => void save(m.email, m.name, r as StaffRole, m.active, `Papel de ${m.name}: ${labelOf(STAFF_ROLES, r)}.`)} />
                  </td>
                  <td>{m.active ? <span className="tag a-CREATE">ativo</span> : <span className="tag">inativo</span>}</td>
                  <td><button className="btn" onClick={() => void save(m.email, m.name, m.role, !m.active, m.active ? "Acesso desativado." : "Acesso reativado.")}>{m.active ? "Desativar" : "Reativar"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
