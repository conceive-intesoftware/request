// Rascunho da solicitação: salvo automaticamente neste navegador (localStorage). Anexos NÃO são salvos.
export const DRAFT_KEY = "conceive:draft:v1";
export const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

export interface Draft {
  mode: "pick" | "new";
  clinicId: string;
  clinicName: string;
  unitId: string;
  pendingClinicName: string;
  requesterName: string;
  requesterRole: string;
  whatsapp: string;
  email: string;
  module: string;
  type: string;
  title: string;
  description: string;
  savedAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // modo privado / bloqueado
  }
};

/** Só vale a pena guardar se a pessoa realmente escreveu algo. */
export function isEmptyDraft(d: Omit<Draft, "savedAt">): boolean {
  return ![d.clinicId, d.pendingClinicName, d.requesterName, d.requesterRole, d.whatsapp, d.email, d.module, d.type, d.title, d.description].some((x) => x.trim() !== "");
}

export function saveDraft(d: Omit<Draft, "savedAt">, store: Store | null = defaultStore(), now = Date.now()): boolean {
  if (!store) return false;
  try {
    if (isEmptyDraft(d)) {
      store.removeItem(DRAFT_KEY);
      return false;
    }
    store.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(store: Store | null = defaultStore(), now = Date.now()): Draft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.savedAt !== "number" || now - d.savedAt > DRAFT_TTL_MS) {
      store.removeItem(DRAFT_KEY);
      return null;
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const out: Draft = {
      mode: d.mode === "new" ? "new" : "pick",
      clinicId: str(d.clinicId), clinicName: str(d.clinicName), unitId: str(d.unitId),
      pendingClinicName: str(d.pendingClinicName), requesterName: str(d.requesterName), requesterRole: str(d.requesterRole),
      whatsapp: str(d.whatsapp), email: str(d.email), module: str(d.module), type: str(d.type),
      title: str(d.title), description: str(d.description), savedAt: d.savedAt,
    };
    return isEmptyDraft(out) ? null : out;
  } catch {
    return null;
  }
}

export function clearDraft(store: Store | null = defaultStore()) {
  try {
    store?.removeItem(DRAFT_KEY);
  } catch {
    /* ignora */
  }
}
