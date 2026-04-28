import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = `${import.meta.env.BASE_URL || "/"}sw.js`.replace("//", "/");
    navigator.serviceWorker.register(swUrl).catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(<App />);
