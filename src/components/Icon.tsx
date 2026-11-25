// Ícones em SVG embutido (sem rede, sem biblioteca). Traço de 1,8 px, herdam a cor do texto (currentColor).
// Sempre decorativos (aria-hidden): o texto ao lado, ou o aria-label do botão, é quem descreve a ação.
type Shape = string | { c: [number, number, number] } | { r: [number, number, number, number, number] };

const ICONS = {
  list: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
  chart: ["M3 3v18h18", "M7 16v-5M12 16V6M17 16v-3"],
  building: ["M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", { c: [9, 7, 4] }, "M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
  user: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", { c: [12, 7, 4] }],
  "user-plus": ["M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", { c: [8.5, 7, 4] }, "M20 8v6M23 11h-6"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"],
  plus: ["M12 5v14M5 12h14"],
  edit: ["M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"],
  trash: ["M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"],
  search: [{ c: [11, 11, 8] }, "M21 21l-4.3-4.3"],
  x: ["M18 6 6 18M6 6l12 12"],
  check: ["M20 6 9 17l-5-5"],
  "check-circle": ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4 12 14.01l-3-3"],
  alert: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"],
  info: [{ c: [12, 12, 10] }, "M12 16v-4M12 8h.01"],
  lock: [{ r: [3, 11, 18, 11, 2] }, "M7 11V7a5 5 0 0 1 10 0v4"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "M9 12l2 2 4-4"],
  key: ["M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"],
  mail: [{ r: [2, 4, 20, 16, 2] }, "m22 7-10 5L2 7"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  paperclip: ["m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"],
  star: ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"],
  "arrow-up": ["M12 19V5M5 12l7-7 7 7"],
  sun: [{ c: [12, 12, 4] }, "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"],
  moon: ["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"],
  monitor: [{ r: [2, 3, 20, 14, 2] }, "M8 21h8M12 17v4"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"],
  menu: ["M3 12h18M3 6h18M3 18h18"],
  refresh: ["M23 4v6h-6M1 20v-6h6", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"],
  clock: [{ c: [12, 12, 10] }, "M12 6v6l4 2"],
  columns: [{ r: [3, 3, 18, 18, 2] }, "M9 3v18M15 3v18"],
  "file-plus": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6M12 18v-6M9 15h6"],
  compass: [{ c: [12, 12, 10] }, "m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"],
  megaphone: ["m3 11 18-5v12L3 14v-3z", "M11.6 16.8a3 3 0 1 1-5.8-1.6"],
  clipboard: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"],
  image: [{ r: [3, 3, 18, 18, 2] }, { c: [8.5, 8.5, 1.5] }, "m21 15-5-5L5 21"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  eye: ["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", { c: [12, 12, 3] }],
  filter: ["M22 3H2l8 9.46V19l4 2v-8.54z"],
  tag: ["M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z", "M7 7h.01"],
  pulse: ["M2 12h4l2.5-7 4 14 2.5-7h7"],
  merge: [{ c: [18, 18, 3] }, { c: [6, 6, 3] }, "M6 21V9a9 9 0 0 0 9 9"],
  archive: [{ r: [2, 3, 20, 5, 1] }, "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"],
  external: ["M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"],
  copy: [{ r: [9, 9, 13, 13, 2] }, "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  globe: [{ c: [12, 12, 10] }, "M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  sliders: ["M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"],
  history: ["M3 3v5h5", "M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2"],
  phone: [{ r: [5, 2, 14, 20, 2] }, "M12 18h.01"],
  save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z", "M17 21v-8H7v8M7 3v5h8"],
  "arrow-left": ["M19 12H5M12 19l-7-7 7-7"],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`ic${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {(ICONS[name] as readonly Shape[]).map((s, i) =>
        typeof s === "string" ? <path key={i} d={s} /> : "c" in s ? <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} /> : <rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />,
      )}
    </svg>
  );
}

/** Linha de pulso (ECG): assinatura visual do Conceive, usada na faixa das páginas e na barra lateral. */
export function PulseLine({ className }: { className?: string }) {
  return (
    <svg className={`pulse-line${className ? ` ${className}` : ""}`} viewBox="0 0 600 60" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
      <path pathLength={1} d="M0 34h150l14-6 12 6h40l10-4 10 4h30l12-26 14 50 14-36 10 12h46l12-6 10 6h86l12-4 12 4h138" />
    </svg>
  );
}
