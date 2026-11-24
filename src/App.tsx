import { useEffect } from "react";
import { match, navigate, useRoute } from "./lib/router";
import { useAuth } from "./lib/useAuth";
import Solicitar from "./pages/Solicitar";
import Acompanhar from "./pages/Acompanhar";
import Comunidade from "./pages/Comunidade";
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
  if (route === "/acompanhar") return <Acompanhar />;
  if (route === "/comunidade") return <Comunidade />;
  if (route === "/login") return <Login onDone={auth.reload} />;
  if (route === "/admin" || route.startsWith("/admin/")) return <AdminShell auth={auth} />;
  return <Solicitar />;
}
