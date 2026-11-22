const TZ = "America/Fortaleza";

export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(new Date(iso));

export const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: TZ }).format(new Date(iso));

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : "Erro inesperado.");

export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Extrai o token (48 hex) de um link colado ou do próprio token. */
export function extractToken(input: string): string | null {
  const m = input.toLowerCase().match(/[0-9a-f]{48}/);
  return m ? m[0] : null;
}
