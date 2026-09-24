import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Menu, Moon, Sun } from "./icons";
import { Dashboard } from "./pages/Dashboard";
import { RunPage } from "./pages/RunPage";
import { ScriptPage } from "./pages/ScriptPage";
import { Settings } from "./pages/Settings";
import { useStore } from "./store";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  return [theme, setTheme];
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  return (
    <button
      onClick={() => setTheme(next[theme])}
      className="flex h-8 w-8 items-center justify-center rounded-lg border hover:bg-[var(--bg-inset)]"
      style={{ borderColor: "var(--border)" }}
      title={`Theme: ${theme}`}
    >
      {theme === "dark" ? <Moon size={15} /> : theme === "light" ? <Sun size={15} /> : <Sun size={15} style={{ opacity: 0.5 }} />}
    </button>
  );
}

export default function App() {
  const loadScripts = useStore((s) => s.loadScripts);
  const loadRuns = useStore((s) => s.loadRuns);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    loadScripts();
    loadRuns();
    const id = setInterval(loadRuns, 6000);
    return () => clearInterval(id);
  }, [loadScripts, loadRuns]);

  return (
    <div className="flex h-screen" style={{ background: "var(--bg)" }}>
      <div className="hidden md:block">
        <Sidebar />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 flex md:hidden">
          <div className="w-64">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex items-center justify-between border-b px-4 py-2.5 md:justify-end"
          style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-inset)] md:hidden"
          >
            <Menu size={18} />
          </button>
          <ThemeToggle />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/scripts/:scriptId" element={<ScriptPage />} />
            <Route path="/runs/:runId" element={<RunPage />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
