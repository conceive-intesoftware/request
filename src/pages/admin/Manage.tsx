import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../../lib/api";
import type { ClinicAdmin, NotifyLogRow, StaffMember, StaffRole } from "../../lib/types";
import { STAFF_ROLES, labelOf } from "../../lib/labels";
import { errMsg, fmtDateTime } from "../../lib/format";
import { Banner, EmptyState, Field, Modal, Select, Spinner } from "../../components/ui";
import { Icon } from "../../components/Icon";

/** Senha temporária forte: 14 caracteres sem símbolos ambíguos, sempre com letra e número. */
export function generatePassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [pick(letters), pick(digits), ...Array.from({ length: 12 }, () => pick(all))];
  for (let k = chars.length - 1; k > 0; k--) {
    const r = crypto.getRandomValues(new Uint32Array(1))[0] % (k + 1);
    [chars[k], chars[r]] = [chars[r], chars[k]];
  }
  return chars.join("");
}
export const passwordOk = (v: string) => v.length >= 10 && v.length <= 72 && /[A-Za-z]/.test(v) && /\d/.test(v);
const PASS_HINT = "Mínimo de 10 caracteres, com letras e números.";

export function Clinics() {
  const [list, setList] = useState<ClinicAdmin[] | null>(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null); // "c:<id>" ou "u:<id>"
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList(await api.listClinicsAdmin()); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errMsg(e)); }
  }
  const startEdit = (key: string, current: string) => { setEditing(key); setDraft(current); };
  const EditRow = ({ onSave }: { onSave: () => void }) => (
    <form className="row inline-edit" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onSave(); }}>
      <input className="input" value={draft} maxLength={160} autoFocus onChange={(e) => setDraft(e.target.value)} aria-label="Novo nome" />
      <button className="btn btn-primary btn-sm" disabled={!draft.trim()}><Icon name="save" size={15} />Salvar</button>
      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
    </form>
  );

  return (
    <div className="stack">
      <header className="page-head"><h1>Clínicas e unidades</h1><p className="muted">O formulário público só aceita clínicas ativas desta lista.</p></header>
      {error && <Banner>{error}</Banner>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(async () => { await api.upsertClinic(null, name, true); setName(""); }); }}>
        <input className="input" placeholder="Digite o nome da nova clínica" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} aria-label="Nome da clínica" />
        <button className="btn btn-primary" disabled={!name.trim()}><Icon name="plus" size={16} />Adicionar clínica</button>
      </form>
      {!list && <Spinner />}
      {list && list.length === 0 && <EmptyState icon="building" title="Nenhuma clínica cadastrada">Adicione a primeira clínica acima para liberar o formulário público.</EmptyState>}
      {list?.map((c) => (
        <section key={c.id} className="card clinic-card">
          <div className="row between">
            {editing === `c:${c.id}` ? (
              <EditRow onSave={() => void act(async () => { await api.upsertClinic(c.id, draft.trim(), c.active); setEditing(null); })} />
            ) : (
              <h2 className={c.active ? "" : "muted"}><Icon name="building" size={20} className="h-ic" />{c.name} {!c.active && <span className="tag">inativa</span>}</h2>
            )}
            <div className="row">
              <button className="btn btn-sm" onClick={() => startEdit(`c:${c.id}`, c.name)} aria-label={`Renomear ${c.name}`}><Icon name="edit" size={15} />Renomear</button>
              <button className="btn btn-sm" onClick={() => void act(() => api.upsertClinic(c.id, c.name, !c.active))}>{c.active ? "Desativar" : "Reativar"}</button>
            </div>
          </div>
          {c.clinic_units.length === 0 ? <p className="muted">Sem unidades.</p> : (
            <ul className="unit-list">
              {c.clinic_units.map((u) => (
                <li key={u.id}>
                  {editing === `u:${u.id}` ? (
                    <EditRow onSave={() => void act(async () => { await api.renameUnit(u.id, draft.trim()); setEditing(null); })} />
                  ) : (
                    <>
                      <span className="tag outline">{u.name}</span>
                      <button className="btn btn-ghost btn-icon" onClick={() => startEdit(`u:${u.id}`, u.name)} aria-label={`Renomear unidade ${u.name}`} title="Renomear unidade"><Icon name="edit" size={15} /></button>
                      <button className="btn btn-ghost btn-icon danger" aria-label={`Remover unidade ${u.name}`} title="Remover unidade"
                        onClick={() => { if (window.confirm(`Remover a unidade "${u.name}"? Só é possível se nenhuma solicitação a usa.`)) void act(() => api.deleteUnit(u.id)); }}><Icon name="trash" size={15} /></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form className="row" onSubmit={(e) => { e.preventDefault(); const v = (unit[c.id] ?? "").trim(); if (v) void act(async () => { await api.addUnit(c.id, v); setUnit({ ...unit, [c.id]: "" }); }); }}>
            <input className="input" placeholder="Digite o nome da nova unidade" value={unit[c.id] ?? ""} maxLength={160} onChange={(e) => setUnit({ ...unit, [c.id]: e.target.value })} aria-label={`Nova unidade de ${c.name}`} />
            <button className="btn"><Icon name="plus" size={16} />Adicionar unidade</button>
          </form>
        </section>
      ))}
    </div>
  );
}

export function Team({ meId }: { meId: string | null }) {
  const [list, setList] = useState<StaffMember[] | null>(null);
  const [mfaRequired, setMfaRequired] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, sec] = await Promise.all([api.adminListStaff(), api.adminGetSecurity()]);
      setList(l); setMfaRequired(sec.mfa_required);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(msg: string, fn: () => Promise<unknown>) {
    setError(null); setOk(null);
    try { await fn(); setOk(msg); await load(); } catch (e) { setError(errMsg(e)); }
  }
  const save = (m: StaffMember, patch: Partial<Pick<StaffMember, "name" | "role" | "active">>, msg: string) =>
    run(msg, () => api.adminUpsertStaff(m.email, patch.name ?? m.name, (patch.role ?? m.role) as StaffRole, patch.active ?? m.active));

  function toggleGlobal(next: boolean) {
    if (!next && !window.confirm("Desligar o autenticador para toda a equipe? Qualquer pessoa com a senha passará a entrar sem o código do aplicativo.")) return;
    void run(next ? "Autenticador exigido para toda a equipe." : "Autenticador desligado para toda a equipe.", () => api.adminSetMfaRequired(next));
  }

  return (
    <div className="stack">
      <header className="page-head row between">
        <div><h1>Equipe</h1><p className="muted">Crie usuários, defina papéis e controle como cada pessoa entra no painel.</p></div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="user-plus" size={16} />Novo usuário</button>
      </header>
      {error && <Banner>{error}</Banner>}
      {ok && <Banner kind="ok">{ok}</Banner>}

      <section className="card security-card" aria-labelledby="sec-h">
        <div className="sec-ic"><Icon name="shield" size={22} /></div>
        <div className="sec-body">
          <h2 id="sec-h">Entrada com autenticador (MFA)</h2>
          <p className="muted">Com o autenticador exigido, além da senha a pessoa digita o código de 6 dígitos do aplicativo. Você pode dispensar usuários específicos na lista abaixo.</p>
          {mfaRequired === false && <Banner kind="info">O autenticador está desligado: quem tem a senha entra no painel. Ligue de novo assim que possível.</Banner>}
        </div>
        <label className="switch">
          <input type="checkbox" role="switch" checked={mfaRequired ?? true} disabled={mfaRequired === null} onChange={(e) => toggleGlobal(e.target.checked)} aria-label="Exigir autenticador (MFA) para toda a equipe" />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">{mfaRequired === false ? "Desligado" : "Exigido"}</span>
        </label>
      </section>

      {!list && <Spinner />}
      {list && (
        <div className="table-wrap">
          <table className="table static">
            <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Autenticador</th><th>Último acesso</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}{m.id === meId && <span className="tag outline">você</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    <Select ariaLabel={`Papel de ${m.name}`} value={m.role} options={STAFF_ROLES} onChange={(r) => void save(m, { role: r as StaffRole }, `Papel de ${m.name}: ${labelOf(STAFF_ROLES, r)}.`)} />
                  </td>
                  <td>
                    {m.mfa_exempt || mfaRequired === false
                      ? <span className="tag">dispensado</span>
                      : m.mfa_enrolled ? <span className="tag a-CREATE">configurado</span> : <span className="tag warn-tag">pendente</span>}
                  </td>
                  <td className="nowrap small">{m.last_sign_in_at ? fmtDateTime(m.last_sign_in_at) : "Nunca entrou"}</td>
                  <td>{m.active ? <span className="tag a-CREATE">ativo</span> : <span className="tag">inativo</span>}</td>
                  <td className="nowrap">
                    <button className="btn btn-sm" onClick={() => setEditing(m)} aria-label={`Editar ${m.name}`}><Icon name="edit" size={15} />Editar</button>{" "}
                    <button className="btn btn-sm" onClick={() => void save(m, { active: !m.active }, m.active ? "Acesso desativado." : "Acesso reativado.")}>{m.active ? "Desativar" : "Reativar"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateUser onClose={() => setCreating(false)} onDone={(m) => { setCreating(false); setError(null); setOk(m); void load(); }} />}
      {editing && (
        <EditUser m={editing} isMe={editing.id === meId} globalOff={mfaRequired === false} onClose={() => setEditing(null)}
          onChanged={(m) => { setOk(m); void load(); }} onError={(m) => setError(m)} />
      )}
      <MailLog />
    </div>
  );
}

function CreateUser({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [f, setF] = useState<{ email: string; name: string; role: StaffRole; password: string }>({ email: "", name: "", role: "SUPPORT", password: generatePassword() });
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!passwordOk(f.password)) { setError(PASS_HINT); return; }
    setBusy(true);
    try {
      await api.createStaffUser({ ...f, email: f.email.trim(), name: f.name.trim() });
      onDone(`Usuário ${f.name.trim()} criado. Entregue a senha temporária com segurança e peça para trocá-la no primeiro acesso.`);
    } catch (err) { setError(errMsg(err)); setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(f.password); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setShow(true); }
  }

  return (
    <Modal title="Novo usuário" subtitle="A pessoa já poderá entrar com o e-mail e a senha temporária abaixo." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Banner>{error}</Banner>}
        <Field label="E-mail" htmlFor="nu-email"><input id="nu-email" className="input" type="email" required autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Nome" htmlFor="nu-name"><input id="nu-name" className="input" required minLength={2} maxLength={120} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Papel" htmlFor="nu-role"><Select id="nu-role" value={f.role} onChange={(v) => setF({ ...f, role: v as StaffRole })} options={STAFF_ROLES} /></Field>
        <Field label="Senha temporária" htmlFor="nu-pass" hint={PASS_HINT}>
          <div className="row pass-row">
            <input id="nu-pass" className="input mono" type={show ? "text" : "password"} required autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <button type="button" className="btn btn-icon" onClick={() => setShow(!show)} aria-label={show ? "Ocultar senha" : "Mostrar senha"}><Icon name="eye" size={16} /></button>
            <button type="button" className="btn btn-icon" onClick={() => setF({ ...f, password: generatePassword() })} aria-label="Gerar outra senha"><Icon name="refresh" size={16} /></button>
            <button type="button" className="btn btn-icon" onClick={() => void copy()} aria-label="Copiar senha"><Icon name={copied ? "check" : "copy"} size={16} /></button>
          </div>
        </Field>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy}><Icon name="user-plus" size={16} />{busy ? "Criando…" : "Criar usuário"}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditUser({ m, isMe, globalOff, onClose, onChanged, onError }: {
  m: StaffMember; isMe: boolean; globalOff: boolean; onClose: () => void; onChanged: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [name, setName] = useState(m.name);
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function run(msg: string, fn: () => Promise<unknown>, close = false) {
    setError(null);
    try { await fn(); onChanged(msg); if (close) onClose(); } catch (e) { setError(errMsg(e)); onError(errMsg(e)); }
  }

  return (
    <Modal title={`Editar ${m.name}`} subtitle={m.email} onClose={onClose}>
      <div className="stack">
        {error && <Banner>{error}</Banner>}
        <form className="row name-row" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) void run("Nome atualizado.", () => api.adminUpsertStaff(m.email, name.trim(), m.role as StaffRole, m.active), true); }}>
          <Field label="Nome" htmlFor="eu-name"><input id="eu-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={name.trim().length < 2 || name.trim() === m.name}><Icon name="save" size={16} />Salvar nome</button>
        </form>

        <section className="subcard stack">
          <h3><Icon name="shield" size={17} className="h-ic" />Autenticador</h3>
          <p className="muted small">{m.mfa_enrolled ? "Esta pessoa já cadastrou o aplicativo autenticador." : "Esta pessoa ainda não cadastrou o aplicativo autenticador."}</p>
          <label className="check">
            <input type="checkbox" checked={m.mfa_exempt} disabled={globalOff}
              onChange={(e) => void run(e.target.checked ? "Autenticador dispensado para este usuário." : "Autenticador exigido deste usuário.", () => api.adminSetUserMfa(m.id, e.target.checked), true)} />
            <span>Dispensar o autenticador (entra só com a senha){globalOff ? " — já desligado para todos" : ""}</span>
          </label>
          <div className="row">
            <button className="btn" disabled={!m.mfa_enrolled}
              onClick={() => { if (window.confirm(`Redefinir o autenticador de ${m.name}? Na próxima entrada será preciso cadastrar o aplicativo de novo.`)) void run("Autenticador redefinido. A pessoa cadastrará um novo no próximo acesso.", () => api.adminResetMfa(m.id), true); }}>
              <Icon name="refresh" size={16} />Redefinir autenticador</button>
          </div>
        </section>

        <section className="subcard stack">
          <h3><Icon name="key" size={17} className="h-ic" />Senha</h3>
          {isMe ? <p className="muted small">Para trocar a sua própria senha use “Alterar minha senha” no menu lateral.</p> : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!passwordOk(pass)) { setError(PASS_HINT); return; } void run("Senha redefinida. Entregue a nova senha com segurança.", () => api.setStaffPassword(m.id, pass), true); }}>
              <Field label="Nova senha temporária" htmlFor="eu-pass" hint={PASS_HINT}>
                <div className="row pass-row">
                  <input id="eu-pass" className="input mono" type="text" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
                  <button type="button" className="btn btn-icon" onClick={() => setPass(generatePassword())} aria-label="Gerar senha"><Icon name="refresh" size={16} /></button>
                </div>
              </Field>
              <div><button className="btn" disabled={!pass}><Icon name="key" size={16} />Redefinir senha</button></div>
            </form>
          )}
        </section>
      </div>
    </Modal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  request_created: "Nova solicitação", status_changed: "Mudança de status", comment_public: "Resposta pública", client_reply: "Resposta do cliente",
};

/** Últimos envios de e-mail e se deram certo. Ajuda a achar falhas de configuração do Resend/notify. */
function MailLog() {
  const [rows, setRows] = useState<NotifyLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setRows(await api.adminNotifyLog(30)); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const state = (r: NotifyLogRow) =>
    r.outcome === "ERRO" ? { t: "falhou", c: "tag", why: r.detail ?? "erro ao chamar a função" }
    : r.http_status === null ? { t: "enviado à função", c: "tag outline", why: "ainda sem retorno (ou o pg_net já descartou o histórico)" }
    : r.http_status >= 200 && r.http_status < 300 ? { t: "ok", c: "tag a-CREATE", why: "" }
    : { t: `falhou (HTTP ${r.http_status})`, c: "tag", why: r.http_status === 401 ? "segredo diferente entre o banco e a função (WEBHOOK_SECRET)" : r.http_status === 500 ? "faltam segredos na função (RESEND_API_KEY, MAIL_FROM ou SITE_URL) ou o Resend recusou" : "veja os logs da função notify no Supabase" };
  return (
    <section className="card stack" aria-labelledby="maillog">
      <div className="row between">
        <div><h2 id="maillog">E-mails automáticos</h2>
          <p className="muted">Últimos 30 envios. Se estiver vazio, os e-mails não estão configurados (veja a Parte 5 do guia).</p></div>
        <button className="btn" onClick={() => void load()}>Atualizar</button>
      </div>
      {error && <Banner>{error}</Banner>}
      {!rows && !error && <Spinner />}
      {rows && rows.length === 0 && <p className="muted">Nenhum envio registrado.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="table static">
          <thead><tr><th>Quando</th><th>Tipo</th><th>Protocolo</th><th>Resultado</th><th>Motivo provável</th></tr></thead>
          <tbody>{rows.map((r) => { const s = state(r); return (
            <tr key={r.id}><td className="nowrap">{fmtDateTime(r.created_at)}</td><td>{EVENT_LABEL[r.event] ?? r.event}</td><td className="mono small">{r.protocol ?? "—"}</td>
              <td><span className={s.c}>{s.t}</span></td><td className="small">{s.why}</td></tr>); })}</tbody>
        </table></div>
      )}
    </section>
  );
}
