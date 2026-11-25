import { Icon } from "./Icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { addFiles, filesFromClipboard, pastedName } from "../lib/attachments";
import { ALLOWED_MIME, MAX_FILES, MAX_FILE_MB } from "../lib/labels";
import { fmtBytes } from "../lib/format";

const isTextTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

/** Anexos: escolher arquivos, arrastar e soltar, ou colar um print com Ctrl+V (em qualquer ponto da página). */
export function AttachmentPicker({ files, onChange, disabled, inputId = "files" }: { files: File[]; onChange: (f: File[]) => void; disabled?: boolean; inputId?: string }) {
  const [msgs, setMsgs] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  function add(incoming: File[], origin?: string) {
    if (incoming.length === 0) return;
    const r = addFiles(filesRef.current, incoming);
    setMsgs(r.messages);
    setInfo(origin && r.files.length > filesRef.current.length ? origin : null);
    if (r.files.length !== filesRef.current.length) onChange(r.files);
  }

  // Ctrl+V: qualquer lugar da página. Não atrapalha colar TEXTO em campos (ex.: copiar células do Excel traz texto + imagem).
  useEffect(() => {
    if (disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const pasted = filesFromClipboard(e.clipboardData);
      if (pasted.length === 0) return;
      const hasText = !!e.clipboardData?.getData("text/plain");
      if (isTextTarget(e.target) && hasText) return;
      e.preventDefault();
      add(pasted, pasted.length > 1 ? `${pasted.length} imagens coladas.` : "Imagem colada.");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Botão "Colar imagem": para celular/Safari, onde Ctrl+V não existe. Depende de permissão do navegador.
  async function pasteButton() {
    setInfo(null);
    try {
      const items = await navigator.clipboard.read();
      const got: File[] = [];
      for (const it of items) {
        const type = it.types.find((t) => ALLOWED_MIME.includes(t));
        if (!type) continue;
        const blob = await it.getType(type);
        got.push(new File([blob], pastedName(new File([], "image.png", { type }), got.length), { type }));
      }
      if (got.length === 0) return setMsgs(["Nenhuma imagem encontrada na área de transferência. Copie um print primeiro (Win+Shift+S) e tente de novo."]);
      add(got, "Imagem colada.");
    } catch {
      setMsgs(["O navegador não liberou o acesso à área de transferência. Clique na página e use Ctrl + V."]);
    }
  }

  const previews = useMemo(() => files.map((f) => (f.type.startsWith("image/") ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  const full = files.length >= MAX_FILES;
  return (
    <div className="attach">
      <div
        className={`dropzone${over ? " over" : ""}${disabled ? " off" : ""}`}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) add(Array.from(e.dataTransfer.files), undefined);
        }}
      >
        <p className="dz-title">Arraste arquivos até aqui ou <strong>cole um print com Ctrl + V</strong></p>
        <p className="hint">PNG, JPG, WEBP, PDF, MP4 ou WEBM · até {MAX_FILE_MB} MB cada · máx. {MAX_FILES} arquivos</p>
        <div className="row dz-actions">
          <button type="button" className="btn" disabled={disabled || full} onClick={() => input.current?.click()}><Icon name="paperclip" size={16} /> Escolher arquivos</button>
          {typeof navigator !== "undefined" && "clipboard" in navigator && "read" in navigator.clipboard && (
            <button type="button" className="btn" disabled={disabled || full} onClick={() => void pasteButton()}><Icon name="image" size={16} /> Colar imagem</button>
          )}
        </div>
        <input
          id={inputId}
          ref={input}
          type="file"
          multiple
          hidden
          accept={ALLOWED_MIME.join(",")}
          onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        />
      </div>

      {info && <p className="attach-ok" role="status">✓ {info}</p>}
      {msgs.map((m) => <p key={m} className="error" role="alert">{m}</p>)}

      {files.length > 0 && (
        <ul className="files">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`}>
              {previews[i] ? <img className="thumb" src={previews[i]!} alt="" /> : <span className="thumb doc">{f.type.startsWith("video/") ? "▶" : "PDF"}</span>}
              <span className="fname">{f.name} <small className="muted">({fmtBytes(f.size)})</small></span>
              <button type="button" className="link danger" onClick={() => { setInfo(null); onChange(files.filter((_, j) => j !== i)); }}>remover</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
