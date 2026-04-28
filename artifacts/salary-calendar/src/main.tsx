import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setRoutingProfile } from "@/lib/routing";

(() => {
  try {
    const stored = localStorage.getItem("salary-calendar:theme:v1");
    const theme = stored === "light" ? "light" : "dark";
    if (theme === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  } catch {
    document.documentElement.classList.add("dark");
  }
})();

// Restore the user's last routing profile choice (bike / car) BEFORE the
// first useRoute / useDistanceMatrix fires, so the very first request goes
// to the correct OSRM endpoint. Legacy "foot" values are silently mapped to
// "bike" for migration.
(() => {
  try {
    const raw = localStorage.getItem("salary-calendar:routing-profile:v1");
    if (raw === "bike" || raw === "car") {
      setRoutingProfile(raw);
    } else if (raw === "foot") {
      setRoutingProfile("bike");
      localStorage.setItem("salary-calendar:routing-profile:v1", "bike");
    }
  } catch {}
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = `${import.meta.env.BASE_URL || "/"}sw.js`.replace("//", "/");
    navigator.serviceWorker.register(swUrl).catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(<App />);
