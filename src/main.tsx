import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initSupabase } from "./lib/supabase";
import "./styles.css";

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
