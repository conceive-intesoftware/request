import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../../lib/api";
import type { ClinicAdmin, NotifyLogRow, NotifyStatus, StaffMember, StaffRole } from "../../lib/types";
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

const PAGE = 12;

export function Clinics() {
  const [list, setList] = useState<ClinicAdmin[] | null>(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null); // "c:<id>" ou "u:<id>"
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const norm = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const filtered = (list ?? []).filter((c) => !q.trim() || norm(c.name).includes(norm(q)) || c.clinic_units.some((u) => norm(u.name).includes(norm(q))));
  const visible = filtered.slice(0, shown);

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
      {list && list.length > 0 && (
        <div className="row clinic-bar">
          <div className="search-in">
            <Icon name="search" size={16} />
            <input className="input" type="search" placeholder="Buscar clínica ou unidade…" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} aria-label="Buscar clínica" />
          </div>
          <span className="muted small">{filtered.length} de {list.length} {list.length === 1 ? "clínica" : "clínicas"}</span>
        </div>
      )}
      <div className="clinic-grid">
        {visible.map((c) => (
          <section key={c.id} className={`card clinic-card ${c.active ? "" : "off"}`}>
            <div className="clinic-head">
              {editing === `c:${c.id}` ? (
                <EditRow onSave={() => void act(async () => { await api.upsertClinic(c.id, draft.trim(), c.active); setEditing(null); })} />
              ) : (
                <h2 className={c.active ? "" : "muted"} title={c.name}><Icon name="building" size={17} className="h-ic" /><span>{c.name}</span>{!c.active && <span className="tag">inativa</span>}</h2>
              )}
              <div className="clinic-actions">
                <button className="btn btn-ghost btn-icon" onClick={() => startEdit(`c:${c.id}`, c.name)} aria-label={`Renomear ${c.name}`} title="Renomear clínica"><Icon name="edit" size={15} /></button>
                <button className="btn btn-sm" onClick={() => void act(() => api.upsertClinic(c.id, c.name, !c.active))}>{c.active ? "Desativar" : "Reativar"}</button>
              </div>
            </div>
            <ul className="unit-list">
              {c.clinic_units.length === 0 && <li className="muted small">Sem unidades.</li>}
              {c.clinic_units.map((u) => (
                <li key={u.id}>
                  {editing === `u:${u.id}` ? (
                    <EditRow onSave={() => void act(async () => { await api.renameUnit(u.id, draft.trim()); setEditing(null); })} />
                  ) : (
                    <>
                      <span className="tag outline">{u.name}</span>
                      <button className="btn btn-ghost btn-icon" onClick={() => startEdit(`u:${u.id}`, u.name)} aria-label={`Renomear unidade ${u.name}`} title="Renomear unidade"><Icon name="edit" size={14} /></button>
                      <button className="btn btn-ghost btn-icon danger" aria-label={`Remover unidade ${u.name}`} title="Remover unidade"
                        onClick={() => { if (window.confirm(`Remover a unidade "${u.name}"? Só é possível se nenhuma solicitação a usa.`)) void act(() => api.deleteUnit(u.id)); }}><Icon name="trash" size={14} /></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <form className="row unit-add" onSubmit={(e) => { e.preventDefault(); const v = (unit[c.id] ?? "").trim(); if (v) void act(async () => { await api.addUnit(c.id, v); setUnit({ ...unit, [c.id]: "" }); }); }}>
              <input className="input" placeholder="Nova unidade" value={unit[c.id] ?? ""} maxLength={160} onChange={(e) => setUnit({ ...unit, [c.id]: e.target.value })} aria-label={`Nova unidade de ${c.name}`} />
              <button className="btn btn-sm"><Icon name="plus" size={14} />Adicionar unidade</button>
            </form>
          </section>
        ))}
      </div>
      {list && filtered.length === 0 && list.length > 0 && <p className="muted">Nenhuma clínica encontrada para “{q}”.</p>}
      {filtered.length > visible.length && (
        <div className="row center"><button className="btn" onClick={() => setShown(shown + PAGE)}>Mostrar mais {Math.min(PAGE, filtered.length - visible.length)} de {filtered.length - visible.length} restantes</button></div>
      )}
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
  const [welcome, setWelcome] = useState(true);
  const [withPass, setWithPass] = useState(true);
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
      const r = await api.createStaffUser({ ...f, email: f.email.trim(), name: f.name.trim(), send_welcome: welcome, include_password: withPass });
      const nome = f.name.trim();
      onDone(r.welcome === "sent" ? `Usuário ${nome} criado e e-mail de boas-vindas enviado para ${f.email.trim()}.`
        : r.welcome === "failed" ? `Usuário ${nome} criado, mas o e-mail de boas-vindas não pôde ser enviado (veja Equipe → E-mails automáticos). Entregue a senha temporária com segurança e peça para trocá-la no primeiro acesso.`
        : `Usuário ${nome} criado. Entregue a senha temporária com segurança e peça para trocá-la no primeiro acesso.`);
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
        <label className="check"><input type="checkbox" checked={welcome} onChange={(e) => setWelcome(e.target.checked)} /> Enviar e-mail de boas-vindas com os dados de acesso</label>
        {welcome && <label className="check"><input type="checkbox" checked={withPass} onChange={(e) => setWithPass(e.target.checked)} /> Incluir a senha temporária no e-mail (se desmarcado, entregue-a por outro meio)</label>}
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

/** Resposta do e-mail de teste: mostra o endereço do site que vai nos links dos e-mails e se ele abre. */
function siteNote(body: string | null): string {
  try {
    const j = JSON.parse(body ?? "");
    if (typeof j?.site_url !== "string") return "";
    const ok = typeof j.site_status === "number" && j.site_status >= 200 && j.site_status < 400;
    return ` Links dos e-mails partem de ${j.site_url} — ${ok ? "o site abre (ok)" : "ATENÇÃO: este endereço não abriu; corrija o Secret SITE_URL"}.`;
  } catch { return ""; }
}

const EVENT_LABEL: Record<string, string> = {
  request_created: "Nova solicitação", request_resend: "Reenvio ao cliente", staff_welcome: "Boas-vindas (novo usuário)", status_changed: "Mudança de status", comment_public: "Resposta pública", client_reply: "Resposta do cliente",
  sla_digest: "Resumo de atrasos", test: "E-mail de teste",
};

/** Transforma a resposta da função `notify` (JSON) em uma frase com o motivo e o que fazer. */
export function explainReply(status: number, body: string | null): string {
  let j: Record<string, unknown> | null = null;
  try { j = body ? JSON.parse(body) as Record<string, unknown> : null; } catch { j = null; }
  const parts: string[] = [];
  if (j && typeof j.reason === "string") parts.push(j.reason);
  if (j && Array.isArray(j.missing) && j.missing.length) parts.push(`faltam/estão errados os Secrets: ${j.missing.join(", ")}`);
  if (j && typeof j.hint === "string") parts.push(j.hint);
  if (j && typeof j.provider_message === "string" && j.provider_message) parts.push(`mensagem do provedor: “${j.provider_message}”`);
  if (j && j.error === "invalid_test_recipient") parts.push("destinatário do teste inválido");
  if (parts.length) return parts.join(" · ");
  if (status === 401 && body && /jwt|authorization|bearer/i.test(body)) return "o Supabase barrou a chamada antes da função: desligue “Enforce JWT verification” na função notify";
  if (status === 401) return "segredo diferente entre o banco e a função (WEBHOOK_SECRET), ou “Enforce JWT verification” ligado na função";
  if (status === 404) return "a função notify não existe com esse nome, ou a URL gravada no banco está errada";
  if (status >= 500) return "erro na função notify: veja os logs dela no Supabase (Edge Functions → notify → Logs)";
  return "veja os logs da função notify no Supabase";
}

function MailLog() {
  const [rows, setRows] = useState<NotifyLogRow[] | null>(null);
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, st] = await Promise.all([api.adminNotifyLog(30), api.adminNotifyStatus()]);
      setRows(r); setStatus(st);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function sendTest() {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.adminSendTestEmail();
      setInfo(`Teste enviado para ${r.to}. Aguarde alguns segundos: o resultado aparece na tabela abaixo.`);
      for (const ms of [4000, 10000, 20000]) setTimeout(() => void load(), ms);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const state = (r: NotifyLogRow) =>
    r.outcome === "ERRO" ? { t: "falhou", c: "tag", why: r.detail ?? "erro ao chamar a função" }
    : r.http_status === null ? { t: "enviado à função", c: "tag outline", why: r.http_error ?? "ainda sem retorno (ou o pg_net já descartou o histórico)" }
    : r.http_status >= 200 && r.http_status < 300 ? { t: "ok", c: "tag a-CREATE", why: r.event === "test" ? `o provedor aceitou o envio: confira a caixa de entrada e o spam.${siteNote(r.http_body)}` : "" }
    : { t: `falhou (HTTP ${r.http_status})`, c: "tag", why: explainReply(r.http_status, r.http_body) };

  const checks = status ? [
    { ok: status.pg_net, t: "Extensão pg_net ativada", fix: "Database → Extensions → ative pg_net." },
    { ok: status.url_set && status.secret_set, t: "Banco ligado à função (URL e segredo gravados)", fix: "Preencha v_notify_url e v_notify_secret na Parte B do SQL e rode o arquivo inteiro." },
  ] : [];
  const linked = !!status && status.pg_net && status.url_set && status.secret_set;

  return (
    <section className="card stack" aria-labelledby="maillog">
      <div className="row between">
        <div><h2 id="maillog">E-mails automáticos</h2>
          <p className="muted">Últimos 30 envios. Use o teste para conferir a configuração de ponta a ponta.</p></div>
        <div className="row">
          <button className="btn" disabled={busy || !linked} onClick={() => void sendTest()} title={linked ? "" : "Ligue o banco à função primeiro"}>{busy ? "Enviando…" : "Enviar e-mail de teste"}</button>
          <button className="btn" onClick={() => void load()}>Atualizar</button>
        </div>
      </div>
      {error && <Banner>{error}</Banner>}
      {info && <Banner kind="ok">{info}</Banner>}
      {status && (
        <ul className="checklist" aria-label="Situação da configuração">
          {checks.map((c) => <li key={c.t}>{c.ok ? "✓" : "✗"} {c.t}{!c.ok && <span className="muted"> — {c.fix}</span>}</li>)}
          {status.url && <li className="muted small">Endereço da função: <span className="mono">{status.url}</span></li>}
        </ul>
      )}
      {!rows && !error && <Spinner />}
      {rows && rows.length === 0 && <p className="muted">Nenhum envio registrado. {linked ? "Clique em “Enviar e-mail de teste”." : "O banco ainda não está ligado à função de e-mail (veja a lista acima)."}</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="table static">
          <thead><tr><th>Quando</th><th>Tipo</th><th>Protocolo</th><th>Resultado</th><th>Motivo / o que fazer</th></tr></thead>
          <tbody>{rows.map((r) => { const s = state(r); return (
            <tr key={r.id}><td className="nowrap">{fmtDateTime(r.created_at)}</td><td>{EVENT_LABEL[r.event] ?? r.event}</td><td className="mono small">{r.protocol ?? "—"}</td>
              <td><span className={s.c}>{s.t}</span></td><td className="small">{s.why}</td></tr>); })}</tbody>
        </table></div>
      )}
    </section>
  );
}
