export type Theme = "system" | "light" | "dark";
const KEY = "conceive:theme";

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
}

export function setTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* sem armazenamento: vale só nesta visita */
  }
  applyTheme(t);
}

export const nextTheme = (t: Theme): Theme => (t === "system" ? "light" : t === "light" ? "dark" : "system");
export const THEME_LABEL: Record<Theme, string> = { system: "Automático", light: "Claro", dark: "Escuro" };
