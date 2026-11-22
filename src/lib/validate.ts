import { normalizeBrPhone } from "./phone";
import { MODULES, REQUESTER_ROLES, TYPES } from "./labels";

export interface RequestFormValues {
  mode: "pick" | "new";
  clinicId: string;
  pendingClinicName: string;
  unitId: string;
  requesterName: string;
  requesterRole: string;
  whatsapp: string;
  module: string;
  type: string;
  title: string;
  description: string;
}

export type FormErrors = Partial<Record<keyof RequestFormValues, string>>;

const has = (list: readonly (readonly [string, string])[], v: string) => list.some(([k]) => k === v);

/** Validação de UX (feedback imediato). O banco valida tudo de novo — esta não é a barreira de segurança. */
export function validateRequestForm(v: RequestFormValues): FormErrors {
  const e: FormErrors = {};
  if (v.mode === "pick") {
    if (!v.clinicId) e.clinicId = "Selecione sua clínica na lista ou use “Minha clínica não está na lista”.";
  } else if (v.pendingClinicName.trim().length < 3) {
    e.pendingClinicName = "Informe o nome da clínica (mín. 3 caracteres).";
  }
  const name = v.requesterName.trim();
  if (name.length < 3) e.requesterName = "Informe seu nome completo.";
  else if (name.length > 120) e.requesterName = "Nome muito longo.";
  if (!has(REQUESTER_ROLES, v.requesterRole)) e.requesterRole = "Selecione seu cargo/função.";
  if (normalizeBrPhone(v.whatsapp) === null) e.whatsapp = "WhatsApp inválido. Ex.: (84) 99999-9999";
  if (!has(MODULES, v.module)) e.module = "Selecione o módulo.";
  if (!has(TYPES, v.type)) e.type = "Selecione o tipo de demanda.";
  const title = v.title.trim();
  if (title.length < 5) e.title = "Título muito curto (mín. 5 caracteres).";
  else if (title.length > 140) e.title = "Título muito longo (máx. 140).";
  const desc = v.description.trim();
  if (desc.length < 20) e.description = "Descreva com mais detalhes (mín. 20 caracteres).";
  else if (desc.length > 8000) e.description = "Descrição muito longa (máx. 8000).";
  return e;
}
