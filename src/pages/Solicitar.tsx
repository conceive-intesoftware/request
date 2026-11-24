import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ensureSession, hasSession, listUnits, searchClinics, submitRequest } from "../lib/api";
import { TURNSTILE_SITE_KEY } from "../lib/supabase";
import { MODULES, REQUESTER_ROLES, TYPES } from "../lib/labels";
import { maskPhoneInput } from "../lib/phone";
import { validateRequestForm, type FormErrors, type RequestFormValues } from "../lib/validate";
import { errMsg, fmtDateTime } from "../lib/format";
import { clearDraft, loadDraft, saveDraft, type Draft } from "../lib/draft";
import { navigate } from "../lib/router";
import { Banner, Field, Select, Spinner } from "../components/ui";
import { Turnstile } from "../components/Turnstile";
import { AttachmentPicker } from "../components/AttachmentPicker";
import { PublicShell } from "../components/PublicShell";

const EMPTY: RequestFormValues = {
  mode: "pick",
  clinicId: "",
  pendingClinicName: "",
  unitId: "",
  requesterName: "",
  requesterRole: "",
  whatsapp: "",
  email: "",
  module: "",
  type: "",
  title: "",
  description: "",
};

type Phase = "checking" | "captcha" | "ready" | "failed";

export default function Solicitar() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [phaseMsg, setPhaseMsg] = useState<string | null>(null);
  const [restored] = useState<Draft | null>(() => loadDraft());
  const [draftNote, setDraftNote] = useState<Draft | null>(restored);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [v, setV] = useState<RequestFormValues>(() =>
    restored
      ? { ...EMPTY, mode: restored.mode, clinicId: restored.clinicId, unitId: restored.unitId, pendingClinicName: restored.pendingClinicName,
          requesterName: restored.requesterName, requesterRole: restored.requesterRole, whatsapp: restored.whatsapp, email: restored.email,
          module: restored.module, type: restored.type, title: restored.title, description: restored.description }
      : EMPTY,
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<{ protocol: string; token: string } | null>(null);

  // autocomplete
  const [query, setQuery] = useState("");
  const [clinicName, setClinicName] = useState(restored?.clinicName ?? "");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [searched, setSearched] = useState(false);
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);

  const set = <K extends keyof RequestFormValues>(k: K, val: RequestFormValues[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((p) => ({ ...p, [k]: undefined }));
    setServerError(null); // o aviso geral some assim que a pessoa começa a corrigir
  };

  // 1) garantir sessão anônima (protegida por Turnstile quando configurado)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (await hasSession()) return alive && setPhase("ready");
        if (!TURNSTILE_SITE_KEY) {
          await ensureSession();
          return alive && setPhase("ready");
        }
        if (alive) setPhase("captcha");
      } catch (e) {
        if (alive) {
          setPhase("failed");
          setPhaseMsg(errMsg(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onCaptcha(token: string) {
    try {
      await ensureSession(token);
      setPhaseMsg(null);
      setPhase("ready");
    } catch (e) {
      setPhaseMsg(errMsg(e));
    }
  }

  // rascunho: recarrega as unidades da clínica restaurada (se ela não existir mais, limpa a escolha)
  useEffect(() => {
    if (phase !== "ready" || !restored?.clinicId) return;
    listUnits(restored.clinicId).then(setUnits).catch(() => clearClinic());
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // rascunho: salva sozinho (neste navegador) enquanto a pessoa escreve
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => {
      const ok = saveDraft({ mode: v.mode, clinicId: v.clinicId, clinicName, unitId: v.unitId, pendingClinicName: v.pendingClinicName,
        requesterName: v.requesterName, requesterRole: v.requesterRole, whatsapp: v.whatsapp, email: v.email,
        module: v.module, type: v.type, title: v.title, description: v.description });
      setSavedAt(ok ? Date.now() : null);
    }, 700);
    return () => clearTimeout(t);
  }, [v, clinicName, done]);

  function discardDraft() {
    clearDraft();
    setDraftNote(null);
    setSavedAt(null);
    setV(EMPTY);
    setErrors({});
    setFiles([]);
    clearClinic();
  }

  // 2) busca de clínicas (debounce)
  useEffect(() => {
    if (phase !== "ready" || v.mode !== "pick" || v.clinicId) return;
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearched(false);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setResults(await searchClinics(q));
        setSearched(true);
      } catch (e) {
        setServerError(errMsg(e));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, phase, v.mode, v.clinicId]);

  async function pickClinic(c: { id: string; name: string }) {
    setV((p) => ({ ...p, clinicId: c.id, unitId: "" }));
    setErrors((p) => ({ ...p, clinicId: undefined }));
    setClinicName(c.name);
    setResults([]);
    setUnits([]);
    try {
      setUnits(await listUnits(c.id));
    } catch (e) {
      setServerError(errMsg(e));
    }
  }

  function clearClinic() {
    setV((p) => ({ ...p, clinicId: "", unitId: "" }));
    setClinicName("");
    setQuery("");
    setUnits([]);
  }

  const canSubmit = phase === "ready" && !submitting;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (honeypot) {
      // robô: finge sucesso sem enviar nada
      setDone({ protocol: "CON-0000-0000", token: "" });
      return;
    }
    const errs = validateRequestForm(v);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setServerError("Revise os campos destacados.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await submitRequest(
        {
          clinicId: v.mode === "pick" ? v.clinicId : null,
          unitId: v.mode === "pick" && v.unitId ? v.unitId : null,
          pendingClinicName: v.mode === "new" ? v.pendingClinicName.trim() : null,
          requesterName: v.requesterName.trim(),
          requesterRole: v.requesterRole,
          whatsapp: v.whatsapp,
          email: v.email.trim() || null,
          module: v.module,
          type: v.type,
          title: v.title.trim(),
          description: v.description.trim(),
        },
        files,
        (n, total) => setProgress(`Enviando anexo ${n} de ${total}…`),
      );
      clearDraft();
      setDraftNote(null);
      setDone({ protocol: r.protocol, token: r.trackingToken });
      window.scrollTo({ top: 0 });
    } catch (e2) {
      setServerError(errMsg(e2));
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const trackLink = useMemo(
    () => (done?.token ? `${window.location.origin}${window.location.pathname}#/acompanhar/${done.token}` : ""),
    [done],
  );

  // ───── sucesso ─────
  if (done) {
    return (
      <PublicShell title="Solicitação de funcionalidade" subtitle="Conte o que a sua clínica precisa. Você receberá um protocolo para acompanhar o andamento.">
      <main className="page narrow">
        <div className="card success">
          <h2>Solicitação enviada!</h2>
          <p>Seu protocolo é</p>
          <p className="protocol">{done.protocol}</p>
          {done.token ? (
            <>
              <p>
                <strong>Guarde o link abaixo.</strong> Ele é a única forma de acompanhar o andamento (não há login para clientes).
              </p>
              <div className="row">
                <button className="btn btn-primary" onClick={() => navigate(`/acompanhar/${done.token}`)}>
                  Acompanhar solicitação
                </button>
                <button className="btn" onClick={() => void navigator.clipboard.writeText(trackLink)}>
                  Copiar link
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setDone(null);
                    setV(EMPTY);
                    setFiles([]);
                    clearClinic();
                  }}
                >
                  Enviar outra
                </button>
              </div>
            </>
          ) : null}
        </div>
      </main>
      </PublicShell>
    );
  }

  return (
    <PublicShell title="Solicitação de funcionalidade" subtitle="Conte o que a sua clínica precisa. Você receberá um protocolo para acompanhar o andamento.">
    <main className="page narrow">

      {phase === "checking" && <Spinner label="Preparando o formulário…" />}
      {phase === "captcha" && (
        <div className="card">
          <p className="label">Verificação de segurança</p>
          <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={onCaptcha} onProblem={setPhaseMsg} />
          {phaseMsg && <Banner>{phaseMsg}</Banner>}
          <p className="hint">Confirme que você não é um robô para liberar o formulário.</p>
        </div>
      )}
      {phase === "failed" && <Banner>{phaseMsg ?? "Não foi possível iniciar. Recarregue a página."}</Banner>}

      <form onSubmit={onSubmit} noValidate className={phase === "ready" ? "form" : "form disabled"} aria-disabled={phase !== "ready"}>
        {/* honeypot — invisível para humanos e leitores de tela */}
        <div className="hp" aria-hidden="true">
          <label>
            Não preencha
            <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>

        {draftNote && (
          <Banner kind="info">
            Recuperamos o rascunho que você começou a escrever ({fmtDateTime(new Date(draftNote.savedAt).toISOString())}). Os anexos não são guardados e precisam ser adicionados de novo.{" "}
            <button type="button" className="link" onClick={discardDraft}>Descartar rascunho</button>
          </Banner>
        )}
        {serverError && <Banner>{serverError}</Banner>}

        <fieldset disabled={phase !== "ready"}>
          <legend>Clínica e unidade</legend>
          {v.mode === "pick" ? (
            <>
              <Field label="Buscar clínica cadastrada" htmlFor="clinic" error={errors.clinicId} hint={v.clinicId ? undefined : "Digite ao menos 3 letras."}>
                {v.clinicId ? (
                  <div className="chosen">
                    <strong>{clinicName}</strong>
                    <button type="button" className="btn btn-ghost" onClick={clearClinic}>
                      trocar
                    </button>
                  </div>
                ) : (
                  <input
                    id="clinic"
                    className="input"
                    autoComplete="off"
                    placeholder="Digite o nome da clínica"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
              </Field>
              {!v.clinicId && results.length > 0 && (
                <ul className="suggest" role="listbox">
                  {results.map((c) => (
                    <li key={c.id}>
                      <button type="button" role="option" aria-selected="false" onClick={() => void pickClinic(c)}>
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!v.clinicId && searched && results.length === 0 && <p className="hint">Nenhuma clínica encontrada com esse nome.</p>}
              {v.clinicId && units.length > 0 && (
                <Field label="Unidade" htmlFor="unit">
                  <Select id="unit" value={v.unitId} onChange={(x) => set("unitId", x)} options={units.map((u) => [u.id, u.name] as const)} placeholder="Selecione a unidade" />
                </Field>
              )}
              <button type="button" className="link" onClick={() => { clearClinic(); set("mode", "new"); }}>
                Minha clínica não está na lista
              </button>
            </>
          ) : (
            <>
              <Field label="Nome da clínica (solicitar novo vínculo)" htmlFor="pending" error={errors.pendingClinicName}>
                <input id="pending" className="input" value={v.pendingClinicName} onChange={(e) => set("pendingClinicName", e.target.value)} placeholder="Digite o nome da clínica" maxLength={160} />
              </Field>
              <button type="button" className="link" onClick={() => { set("mode", "pick"); set("pendingClinicName", ""); }}>
                Voltar para a lista
              </button>
            </>
          )}
        </fieldset>

        <div className="grid2">
          <Field label="Seu nome" htmlFor="name" error={errors.requesterName}>
            <input id="name" className="input" placeholder="Digite seu nome completo" autoComplete="name" maxLength={120} value={v.requesterName} onChange={(e) => set("requesterName", e.target.value)} />
          </Field>
          <Field label="Seu cargo / função" htmlFor="role" error={errors.requesterRole}>
            <Select id="role" value={v.requesterRole} onChange={(x) => set("requesterRole", x)} options={REQUESTER_ROLES} placeholder="Selecione" />
          </Field>
        </div>

        <Field label="WhatsApp para retorno" htmlFor="wa" error={errors.whatsapp}>
          <input id="wa" className="input" inputMode="tel" autoComplete="tel" placeholder="Digite o número com DDD" value={v.whatsapp} onChange={(e) => set("whatsapp", maskPhoneInput(e.target.value))} />
        </Field>

        <Field label="E-mail (opcional)" htmlFor="email" error={errors.email} hint="Se informar, enviaremos o link de acompanhamento e avisaremos quando houver novidades.">
          <input id="email" className="input" type="email" inputMode="email" autoComplete="email" placeholder="Digite o seu e-mail" maxLength={160} value={v.email} onChange={(e) => set("email", e.target.value)} />
        </Field>

        <div className="grid2">
          <Field label="Módulo do sistema" htmlFor="module" error={errors.module}>
            <Select id="module" value={v.module} onChange={(x) => set("module", x)} options={MODULES} placeholder="Selecione" />
          </Field>
          <Field label="Tipo de demanda" htmlFor="type" error={errors.type}>
            <Select id="type" value={v.type} onChange={(x) => set("type", x)} options={TYPES} placeholder="Selecione" />
          </Field>
        </div>

        <Field label="Título da solicitação" htmlFor="title" error={errors.title}>
          <input id="title" className="input" placeholder="Digite um título resumido" maxLength={140} value={v.title} onChange={(e) => set("title", e.target.value)} />
        </Field>

        <Field
          label="Descrição detalhada"
          htmlFor="desc"
          error={errors.description}
          hint="Por conformidade com a LGPD, não inclua dados pessoais de pacientes (nome, CPF, prontuário)."
        >
          <textarea id="desc" className="input" rows={8} maxLength={8000} placeholder="Escreva a sua solicitação aqui…" value={v.description} onChange={(e) => set("description", e.target.value)} />
          <p className="counter">{v.description.length}/8000</p>
        </Field>

        <Field label="Anexos (opcional)" htmlFor="files">
          <AttachmentPicker files={files} onChange={setFiles} disabled={phase !== "ready" || submitting} />
        </Field>

        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
          {submitting ? (progress ?? "Enviando…") : "Enviar solicitação"}
        </button>
        <p className="hint">
          Ao enviar, você autoriza a Conceive a usar seu nome, WhatsApp e e-mail apenas para dar retorno sobre esta solicitação (LGPD).
        </p>
        <p className="hint draft-note" role="status">
          {savedAt ? `Rascunho salvo automaticamente neste navegador às ${new Intl.DateTimeFormat("pt-BR", { timeStyle: "short", timeZone: "America/Fortaleza" }).format(savedAt)}. ` : "O rascunho é salvo automaticamente neste navegador. "}
          {(savedAt || draftNote) && <button type="button" className="link" onClick={discardDraft}>Descartar</button>}
        </p>
      </form>

    </main>
    </PublicShell>
  );
}
