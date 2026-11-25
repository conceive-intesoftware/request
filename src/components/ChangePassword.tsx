import { useState, type FormEvent } from "react";
import * as api from "../lib/api";
import { errMsg } from "../lib/format";
import { Banner, Field, Modal } from "./ui";
import { Icon } from "./Icon";

/** Troca da própria senha de quem está logado (Supabase Auth). */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return setError("A senha precisa ter ao menos 10 caracteres, com letras e números.");
    if (pw !== again) return setError("As senhas digitadas não são iguais.");
    setBusy(true);
    try { await api.changeMyPassword(pw); setDone(true); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Alterar minha senha" onClose={onClose}>
      {done ? (
        <div className="stack">
          <Banner kind="ok">Senha alterada. Use a nova senha no próximo acesso.</Banner>
          <div className="row end"><button className="btn btn-primary" onClick={onClose}>Fechar</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {error && <Banner>{error}</Banner>}
          <Field label="Nova senha" htmlFor="cp-new" hint="Mínimo de 10 caracteres, com letras e números.">
            <input id="cp-new" className="input" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Repita a nova senha" htmlFor="cp-again">
            <input id="cp-again" className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <div className="row end">
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary" disabled={busy}><Icon name="key" size={16} />{busy ? "Salvando…" : "Salvar senha"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
