import { NavLink } from "react-router-dom";
import { swatchFor } from "../colors";
import { Home, LayoutGrid, Power, scriptIcon, Settings } from "../icons";
import { useStore } from "../store";

function groupByFolder<T extends { folder: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const bucket = map.get(item.folder) ?? [];
    bucket.push(item);
    map.set(item.folder, bucket);
  }
  return map;
}

function prettyFolder(name: string): string {
  return name.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const scripts = useStore((s) => s.scripts);
  const runs = useStore((s) => s.runs);
  const showQuit = useStore((s) => s.packaged && s.mode === "browser");
  const quitApp = useStore((s) => s.quitApp);
  const groups = groupByFolder(scripts);
  const activeCount = Object.values(runs).filter(
    (r) => r.status === "running" || r.status === "awaiting_input",
  ).length;

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? "text-[var(--accent)]" : "hover:bg-[var(--bg-inset)]"
    }`;

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col border-r px-3 py-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
    >
      <div className="mb-5 flex items-center gap-2 px-2">
        <img src="/logo.svg" alt="" className="h-9 w-9 shrink-0" draggable={false} />
        <div>
          <p className="text-sm font-semibold leading-tight">AUGA-Builder</p>
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            local automation hub
          </p>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5" onClick={onNavigate}>
        <NavLink to="/" end className={navClass} style={({ isActive }) => ({ background: isActive ? "var(--bg-inset)" : undefined })}>
          <Home size={17} />
          Dashboard
          {activeCount > 0 && (
            <span
              className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
              style={{ background: "var(--accent)", color: "var(--accent-text)" }}
            >
              {activeCount}
            </span>
          )}
        </NavLink>
        <NavLink to="/settings" className={navClass} style={({ isActive }) => ({ background: isActive ? "var(--bg-inset)" : undefined })}>
          <Settings size={17} />
          Settings
        </NavLink>
      </nav>

      <div className="mt-5 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        <LayoutGrid size={12} />
        Scripts
      </div>

      <div className="mt-1 flex-1 overflow-y-auto pr-1" onClick={onNavigate}>
        {scripts.length === 0 && (
          <p className="px-3 py-4 text-xs" style={{ color: "var(--text-faint)" }}>
            No scripts registered yet. Add one from Settings.
          </p>
        )}
        {[...groups.entries()].map(([folder, items]) => (
          <div key={folder} className="mb-3">
            <p className="px-3 pb-1 text-[10.5px] font-medium" style={{ color: "var(--text-faint)" }}>
              {prettyFolder(folder)}
            </p>
            {items.map((script) => {
              const Icon = scriptIcon(script.icon);
              const swatch = swatchFor(script.color);
              const runningHere = Object.values(runs).some(
                (r) => r.script_id === script.id && (r.status === "running" || r.status === "awaiting_input"),
              );
              return (
                <NavLink
                  key={script.id}
                  to={`/scripts/${script.id}`}
                  className={navClass}
                  style={({ isActive }) => ({ background: isActive ? "var(--bg-inset)" : undefined })}
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-md"
                    style={{ background: swatch.soft }}
                  >
                    <Icon size={13} color={swatch.text} />
                  </span>
                  <span className="truncate">{script.name}</span>
                  {runningHere && (
                    <span
                      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full animate-pulse-soft"
                      style={{ background: swatch.solid }}
                    />
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </div>

      {showQuit && (
        <button
          onClick={() => {
            const msg = activeCount
              ? `Quit AUGA-Builder? ${activeCount} running script${activeCount === 1 ? "" : "s"} will be stopped.`
              : "Quit AUGA-Builder?";
            if (confirm(msg)) quitApp();
          }}
          className="mt-2 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--bg-inset)]"
          style={{ color: "var(--text-muted)" }}
        >
          <Power size={17} />
          Quit AUGA-Builder
        </button>
      )}
    </aside>
  );
}
