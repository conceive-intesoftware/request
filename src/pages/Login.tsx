import { useState, type FormEvent } from "react";
import { client, logLogin, myContext } from "../lib/api";
import { TURNSTILE_SITE_KEY } from "../lib/supabase";
import { errMsg } from "../lib/format";
import { navigate } from "../lib/router";
import { PublicShell } from "../components/PublicShell";
import { Banner, Field } from "../components/ui";
import { Turnstile } from "../components/Turnstile";

type Step = "credentials" | "enroll" | "verify";

export default function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish() {
    const ctx = await myContext();
    if (!ctx.role) {
      await client().auth.signOut();
      setStep("credentials");
      setError("Sua conta ainda não foi cadastrada na equipe. Peça a um administrador para liberar seu acesso.");
      return;
    }
    await logLogin().catch(() => undefined);
    // Atualiza o estado global ANTES de navegar; senão o painel enxerga a sessão antiga e volta para o login.
    await onDone();
    navigate("/admin");
  }

  async function onCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (TURNSTILE_SITE_KEY && !captcha) return setError("Confirme a verificação anti-robô.");
    setBusy(true);
    try {
      const c = client();
      const { error: err } = await c.auth.signInWithPassword({
        email: email.trim(),
        password,
        options: TURNSTILE_SITE_KEY ? { captchaToken: captcha } : undefined,
      });
      if (err) throw new Error("E-mail, senha ou verificação inválidos.");

      const { data: aal } = await c.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === "aal2") return await finish();

      const { data: f } = await c.auth.mfa.listFactors();
      const verified = f?.totp?.find((x) => x.status === "verified");
      if (verified) {
        setFactorId(verified.id);
        setStep("verify");
        return;
      }
      // 1º acesso: cadastrar o autenticador. Limpa tentativas abandonadas antes.
      for (const x of f?.all ?? []) {
        if (x.factor_type === "totp" && x.status === "unverified") await c.auth.mfa.unenroll({ factorId: x.id });
      }
      const { data: en, error: enErr } = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: "Conceive" });
      if (enErr || !en) throw new Error("Não foi possível iniciar o cadastro do autenticador.");
      setFactorId(en.id);
      setQr(en.totp.qr_code);
      setSecret(en.totp.secret);
      setStep("enroll");
    } catch (e2) {
      setError(errMsg(e2));
    } finally {
      setBusy(false);
    }
  }

  async function onCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) return setError("Digite os 6 dígitos do aplicativo autenticador.");
    setBusy(true);
    try {
      const { error: err } = await client().auth.mfa.challengeAndVerify({ factorId, code });
      if (err) throw new Error("Código inválido ou expirado. Tente o próximo código.");
      await finish();
    } catch (e2) {
      setError(errMsg(e2));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell title="Acesso da equipe" subtitle="Painel interno de gestão das solicitações. Acesso restrito, com autenticação em dois fatores.">
    <main className="page tiny">
      <div className="card login-card">
      <h2>Entrar no painel</h2>
      {error && <Banner>{error}</Banner>}

      {step === "credentials" && (
        <form onSubmit={onCredentials} className="form">
          <Field label="E-mail" htmlFor="email">
            <input id="email" type="email" className="input" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Senha" htmlFor="pw">
            <input id="pw" type="password" className="input" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {TURNSTILE_SITE_KEY && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptcha} onProblem={setError} />}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
      )}

      {step === "enroll" && (
        <form onSubmit={onCode} className="form">
          <p><strong>Primeiro acesso:</strong> escaneie o QR code com Google Authenticator, Authy ou 1Password e digite o código gerado.</p>
          {qr && <img className="qr" src={qr} alt="QR code para cadastrar o autenticador" width={200} height={200} />}
          <p className="hint">Sem câmera? Digite este código no aplicativo: <code>{secret}</code></p>
          <Field label="Código de 6 dígitos" htmlFor="code">
            <input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <button className="btn btn-primary btn-block" disabled={busy}>Confirmar e entrar</button>
        </form>
      )}

      {step === "verify" && (
        <form onSubmit={onCode} className="form">
          <Field label="Código do aplicativo autenticador" htmlFor="code2">
            <input id="code2" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <button className="btn btn-primary btn-block" disabled={busy}>Entrar</button>
        </form>
      )}

      </div>
    </main>
    </PublicShell>
  );
}
