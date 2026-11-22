import { useEffect, type ReactNode } from "react";

export function Spinner({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="dot" /> {label}
    </div>
  );
}

export function Banner({ kind = "error", children }: { kind?: "error" | "ok" | "info"; children: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && !error && <p className="hint">{hint}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted mono">{subtitle}</p>}
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  id,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly (readonly [string, string])[];
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      className="input"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(([k, l]) => (
        <option key={k} value={k}>
          {l}
        </option>
      ))}
    </select>
  );
}
