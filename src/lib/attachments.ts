import { ALLOWED_MIME, MAX_FILES, MAX_FILE_MB } from "./labels";

export interface AddResult {
  files: File[];
  messages: string[];
}

/** Valida e acrescenta arquivos à lista atual (tipo, tamanho, quantidade). Nunca altera a lista recebida. */
export function addFiles(current: File[], incoming: File[]): AddResult {
  const files = [...current];
  const messages: string[] = [];
  for (const f of incoming) {
    if (files.length >= MAX_FILES) {
      messages.push(`No máximo ${MAX_FILES} anexos por solicitação.`);
      break;
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      messages.push(`“${f.name}”: tipo não permitido (use PNG, JPG, WEBP, PDF, MP4 ou WEBM).`);
      continue;
    }
    if (f.size === 0) {
      messages.push(`“${f.name}” está vazio.`);
      continue;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      messages.push(`“${f.name}” passa de ${MAX_FILE_MB} MB.`);
      continue;
    }
    files.push(f);
  }
  return { files, messages };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const GENERIC = /^(image|imagem|captura|screenshot|blob)?\.?(png|jpe?g|webp)?$/i;
const pad = (n: number) => String(n).padStart(2, "0");

/** Nome legível para prints colados: print-20261122-143005.png (o navegador entrega todos como "image.png"). */
export function pastedName(f: File, index: number, now = new Date()): string {
  if (f.name && !GENERIC.test(f.name)) return f.name;
  const ext = EXT[f.type] ?? "png";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `print-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`;
}

/** Arquivos (imagens, normalmente) que vieram da área de transferência. */
export function filesFromClipboard(dt: DataTransfer | null | undefined, now = new Date()): File[] {
  if (!dt) return [];
  let raw: File[] = Array.from(dt.files ?? []);
  if (raw.length === 0 && dt.items) {
    raw = Array.from(dt.items)
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
  }
  return raw.map((f, i) => {
    const name = pastedName(f, i, now);
    return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}
