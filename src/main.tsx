import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initSupabase } from "./lib/supabase";
import { applyTheme, getTheme } from "./lib/theme";
import "./styles.css";

applyTheme(getTheme());

// Proteção contra clickjacking (frame-ancestors não funciona em <meta>).
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top!.location.href = window.self.location.href; } catch { /* bloqueado */ }
}

const root = createRoot(document.getElementById("root")!);
const problem = initSupabase();

if (problem) {
  root.render(
    <main className="page tiny">
      <div className="banner banner-error" role="alert">
        <strong>Configuração incompleta.</strong> {problem}
      </div>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
