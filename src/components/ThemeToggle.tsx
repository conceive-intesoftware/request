import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { THEME_LABEL, getTheme, nextTheme, setTheme, type Theme } from "../lib/theme";

/** Alterna Automático → Claro → Escuro. A escolha fica salva neste navegador. */
const ICON: Record<Theme, IconName> = { system: "monitor", light: "sun", dark: "moon" };

export function ThemeToggle() {
  const [t, setT] = useState<Theme>(getTheme());
  return (
    <button
      type="button"
      className="btn btn-ghost theme-toggle"
      title={`Tema: ${THEME_LABEL[t]} (clique para alternar)`}
      aria-label={`Tema: ${THEME_LABEL[t]}. Clique para alternar.`}
      onClick={() => {
        const n = nextTheme(t);
        setTheme(n);
        setT(n);
      }}
    >
      <Icon name={ICON[t]} size={16} /> <span className="theme-label">{THEME_LABEL[t]}</span>
    </button>
  );
}
