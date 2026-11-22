// Mesmas regras de private.normalize_br_phone() no banco (o banco é quem decide de verdade).

export const DDD_VALIDOS = [
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
];
const DDD = new Set(DDD_VALIDOS);

/** "(84) 99849-3000", "84998493000", "+55 84 99849-3000", "84 987417184" -> "+5584998493000" ou null */
export function normalizeBrPhone(input: string): string | null {
  let d = (input ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (!DDD.has(Number(d.slice(0, 2)))) return null;
  if (d.length === 11 && d[2] !== "9") return null;
  return `+55${d}`;
}

/** Máscara progressiva do campo: (XX) 9XXXX-XXXX */
export function maskPhoneInput(value: string): string {
  const d = value.replace(/\D/g, "").replace(/^55(?=\d{11})/, "").slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function formatPhoneBR(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return e164;
}

export function whatsappLink(e164: string, text?: string): string {
  const n = e164.replace(/\D/g, "");
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
