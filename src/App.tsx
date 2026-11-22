import { useEffect } from "react";
import { match, navigate, useRoute } from "./lib/router";
import { useAuth } from "./lib/useAuth";
import Solicitar from "./pages/Solicitar";
import Acompanhar from "./pages/Acompanhar";
import Login from "./pages/Login";
import AdminShell from "./pages/admin/AdminShell";

export default function App() {
  const route = useRoute();
  const auth = useAuth();

  useEffect(() => {
    if (route === "/") navigate("/solicitar");
  }, [route]);

  const track = match(route, "/acompanhar/:token");
  if (track) return <Acompanhar token={track.token} />;
  if (route === "/login") return <Login onDone={auth.reload} />;
  if (route === "/admin" || route.startsWith("/admin/")) return <AdminShell auth={auth} />;
  return <Solicitar />;
}
