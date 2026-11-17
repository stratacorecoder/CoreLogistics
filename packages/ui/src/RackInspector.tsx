import { ZONE_META, type LocationStatus } from "@corelogistics/contracts";
import { Progress } from "./components.js";

/**
 * Stacked shelf-level cross-section for rack, staging, or sort cells.
 * Shows each level top-down so operators can inspect exact pallet/HU slots at a glance.
 */
export function RackInspector({ locs }: { locs: LocationStatus[] }) {
  const ordered = [...locs].sort((a, b) => b.level - a.level);
  const totalUsed = ordered.reduce((sum, l) => sum + l.occupied, 0);
  const totalCap = ordered.reduce((sum, l) => sum + l.capacity, 0);

  return (
    <div className="rack-stack">
      {totalCap > 0 ? (
        <div className="row-between small">
          <span className="muted">Bay utilization</span>
          <span className="mono strong">
            {totalUsed} / {totalCap} HU ({Math.round((totalUsed / totalCap) * 100)}%)
          </span>
        </div>
      ) : null}
      {ordered.map((loc) => {
        const emptySlots = Math.max(0, loc.capacity - loc.refs.length);
        const pct = loc.capacity > 0 ? (loc.occupied / loc.capacity) * 100 : 0;
        const zone = loc.zone ? ZONE_META[loc.zone] : null;
        return (
          <div
            key={loc.id}
            className="rack-shelf"
            style={zone ? { boxShadow: `inset 3px 0 0 ${zone.color}` } : undefined}
          >
            <div className="rack-shelf-head">
              <div className="row" style={{ gap: 6 }}>
                <span className="mono strong">{loc.code}</span>
                {zone ? (
                  <span className="small" style={{ color: zone.color, fontWeight: 600 }}>
                    {zone.label}
                  </span>
                ) : null}
              </div>
              <span className="mono muted">
                L{loc.level} · {loc.occupied}/{loc.capacity}
              </span>
            </div>
            <Progress value={loc.occupied} max={loc.capacity || 1} tone={pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok"} />
            <div className="rack-shelf-slots">
              {loc.refs.map((ref) => (
                <span key={ref} className="rack-hu-chip">
                  {ref}
                </span>
              ))}
              {Array.from({ length: Math.min(emptySlots, 4) }).map((_, i) => (
                <span key={`empty-${i}`} className="rack-slot-empty">
                  open
                </span>
              ))}
              {emptySlots > 4 ? <span className="rack-slot-empty">+{emptySlots - 4} open</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
