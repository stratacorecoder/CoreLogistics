import { humanize, type EventRecord, type Site } from "@corelogistics/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { getActor } from "./api.js";
import { SignIn2 } from "./components/ui/clean-minimal-sign-in.js";
import { fmtDateTime } from "./format.js";
import { useStreamStatus, useToasts } from "./live.js";

const TONE: Record<string, string> = {
  available: "ok",
  completed: "ok",
  done: "ok",
  stored: "ok",
  shipped: "ok",
  departed: "muted",
  closed: "muted",
  cancelled: "muted",
  consumed: "muted",
  inactive: "muted",
  off_duty: "muted",
  planned: "info",
  open: "info",
  planning: "info",
  received: "info",
  dispatched: "accent",
  picking: "accent",
  loading: "accent",
  sorted: "accent",
  in_transit: "accent",
  on_trip: "accent",
  in_yard: "warn",
  arrived: "warn",
  picked: "warn",
  staged: "warn",
  at_dock: "violet",
  loaded: "violet",
  maintenance: "danger",
  delayed: "danger",
};

export function Pill({ value, tone, children }: { value?: string | null; tone?: string; children?: ReactNode }) {
  return <span className={`pill tone-${tone ?? TONE[value ?? ""] ?? "muted"}`}>{children ?? humanize(value)}</span>;
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className={`kpi${tone ? ` tone-${tone}` : ""}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {hint ? <p className="kpi-hint">{hint}</p> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
  scroll = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <section className={`panel ${scroll ? "panel-scroll" : ""} ${className}`}>
      {title || actions ? (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  return error ? <p className="error-note">{error}</p> : null;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: ReactNode; badge?: number }>;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="tabs">
      {options.map((o) => (
        <button key={o.id} type="button" className={o.id === value ? "is-on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
          {o.badge ? <span className="tab-badge">{o.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function SitePicker({
  sites,
  value,
  onChange,
  kinds = ["depot", "warehouse"],
}: {
  sites: Site[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
  kinds?: Site["kind"][];
}) {
  const list = (sites ?? [])
    .filter((s) => kinds.includes(s.kind))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  useEffect(() => {
    if (list.length && (!value || !list.some((s) => s.id === value))) onChange(list[0]!.id);
  }, [list, value, onChange]);
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {list.map((s) => (
        <option key={s.id} value={s.id}>
          {s.code} · {s.name}
        </option>
      ))}
    </select>
  );
}

export function ActorBadge({ placeholder = "Your name" }: { placeholder?: string }) {
  const [name, setName] = useState(getActor() || placeholder);
  useEffect(() => {
    const sync = () => setName(getActor() || placeholder);
    window.addEventListener("corelogistics:actor", sync);
    return () => window.removeEventListener("corelogistics:actor", sync);
  }, [placeholder]);
  if (!name) return null;
  return (
    <span className="actor-name" title="Recorded on every action you take">
      {name}
    </span>
  );
}

export function LiveDot() {
  const online = useStreamStatus();
  return (
    <span className={`live-dot ${online ? "is-on" : ""}`} title={online ? "Live updates connected" : "Reconnecting…"}>
      {online ? "Live" : "Offline"}
    </span>
  );
}

export function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock">{now.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>;
}

export function Shell({
  mark,
  title,
  role,
  center,
  right,
  nav,
  navValue,
  onNav,
  onSwitchRole,
  tone = "office",
  children,
}: {
  mark: string;
  title: string;
  role: string;
  center?: ReactNode;
  right?: ReactNode;
  nav?: Array<{ id: string; label: string }>;
  navValue?: string;
  onNav?: (id: string) => void;
  onSwitchRole?: () => void;
  tone?: "office" | "floor";
  children: ReactNode;
}) {
  const brand = (
    <div className={nav ? "brand side-brand" : "brand"}>
      <span className="brand-mark">{mark}</span>
      <div>
        <p className="brand-name">{title}</p>
        <p className="brand-role">{role}</p>
      </div>
    </div>
  );
  return (
    <div className={`${tone === "floor" ? "shell theme-floor" : "shell"}${nav ? " has-nav" : ""}`}>
      {nav ? (
        <aside className="side-nav">
          {brand}
          <nav>
            {nav.map((item) => (
              <button key={item.id} type="button" className={`nav-item${item.id === navValue ? " is-on" : ""}`} onClick={() => onNav?.(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="nav-spacer" />
          {onSwitchRole ? (
            <button className="btn btn-ghost btn-sm" type="button" onClick={onSwitchRole}>
              Sign out
            </button>
          ) : null}
        </aside>
      ) : null}
      <header className="topbar">
        {nav ? null : brand}
        <div className="topbar-center">{nav ? null : center}</div>
        <div className="topbar-right">
          {right}
          {!nav && onSwitchRole ? (
            <button className="btn btn-ghost btn-sm" type="button" onClick={onSwitchRole}>
              Sign out
            </button>
          ) : null}
          <LiveDot />
          <Clock />
        </div>
      </header>
      <main className="shell-main">{children}</main>
      <Toasts />
    </div>
  );
}

export const APP_ROLES = [
  { id: "tower", port: 5180, mark: "CT", title: "Control Tower", detail: "Dispatch, fleet, and the live site map" },
  { id: "gate", port: 5181, mark: "GT", title: "Gate & Yard", detail: "Check trucks in, assign a yard slot and a dock" },
  { id: "warehouse", port: 5182, mark: "WH", title: "Warehouse floor", detail: "Receive, sort, pick, and load" },
  { id: "driver", port: 5183, mark: "DR", title: "Driver", detail: "Your trip, stops, and arrival" },
] as const;

export type AppRoleId = (typeof APP_ROLES)[number]["id"];

export function LoginPage({ onSubmit }: { onSubmit: (username: string, password: string) => Promise<void> }) {
  return <SignIn2 onSubmit={onSubmit} />;
}

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { manual: "Manual", camera: "Camera", rfid: "RFID", gps: "GPS", system: "System" };

export function EventFeed({ events, empty = "No events yet" }: { events: EventRecord[] | undefined; empty?: string }) {
  if (!events?.length) return <Empty>{empty}</Empty>;
  return (
    <ol className="event-feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="event-time">{fmtDateTime(e.occurredAt)}</span>
          <span className="event-src" title={e.source}>
            <span className="event-src">{SOURCE_LABEL[e.source] ?? e.source}</span>
          </span>
          <span className="event-msg">
            {e.message}
            {e.actor ? <span className="event-actor"> · {e.actor}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`progress${tone ? ` tone-${tone}` : ""}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
