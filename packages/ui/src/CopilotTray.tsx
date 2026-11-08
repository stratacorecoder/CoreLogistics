import {
  type CopilotConfig,
  type CopilotRecommendation,
  type CopilotSeverity,
} from "@corelogistics/contracts";
import { Bot, CheckCircle2, ChevronRight, RefreshCw, Sparkles, X, Zap } from "lucide-react";
import { useState } from "react";
import { api } from "./api.js";
import { Empty, Pill } from "./components.js";
import { fromNow } from "./format.js";
import { useAction, useApi, useNow } from "./live.js";

const SEVERITY_TONE: Record<CopilotSeverity, string> = {
  critical: "danger",
  high: "warn",
  medium: "accent",
  low: "info",
};

export function CopilotBadge({ siteId, onOpen }: { siteId?: string | null; onOpen: () => void }) {
  const q = siteId ? `?siteId=${siteId}&status=pending` : "?status=pending";
  const { data: recs } = useApi<CopilotRecommendation[]>(`/copilot/recommendations${q}`, { intervalMs: 8000 });
  const { data: config } = useApi<CopilotConfig>("/copilot/config", { intervalMs: 15000 });
  const count = recs?.length ?? 0;

  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={onOpen}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 20,
        background: count > 0 ? "rgba(239, 68, 68, 0.15)" : config?.autoPilot ? "rgba(52, 199, 89, 0.15)" : "var(--panel-2)",
        border: count > 0 ? "1px solid rgba(239, 68, 68, 0.4)" : config?.autoPilot ? "1px solid rgba(52, 199, 89, 0.4)" : "1px solid var(--border)",
        color: count > 0 ? "var(--danger, #ff3b30)" : config?.autoPilot ? "var(--ok, #34c759)" : "currentColor",
        fontWeight: 600,
        fontSize: 12,
        cursor: "pointer",
      }}
      title="Open Agentic Copilot Disruption Engine"
    >
      {config?.autoPilot ? <Zap size={14} color="#34c759" /> : <Bot size={14} />}
      <span>Copilot</span>
      {count > 0 ? (
        <span
          style={{
            background: "var(--danger, #ff3b30)",
            color: "#ffffff",
            borderRadius: 999,
            padding: "1px 7px",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      ) : config?.autoPilot ? (
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#34c759" }}>Auto</span>
      ) : null}
    </button>
  );
}

export function CopilotDrawer({
  siteId,
  onClose,
}: {
  siteId?: string | null;
  onClose: () => void;
}) {
  const now = useNow(15_000);
  const q = siteId ? `?siteId=${siteId}&status=pending` : "?status=pending";
  const { data: recs, reload: reloadRecs } = useApi<CopilotRecommendation[]>(`/copilot/recommendations${q}`);
  const { data: config, reload: reloadConfig } = useApi<CopilotConfig>("/copilot/config");
  const { busy, run } = useAction();
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const toggleAutoPilot = async () => {
    if (!config) return;
    const next = !config.autoPilot;
    await run(() => api.post("/copilot/config", { autoPilot: next }));
    reloadConfig();
  };

  const handleApply = async (id: string) => {
    setApplyingId(id);
    await run(() => api.post(`/copilot/recommendations/${id}/apply`));
    setApplyingId(null);
    reloadRecs();
  };

  const handleDismiss = async (id: string) => {
    await run(() => api.post(`/copilot/recommendations/${id}/dismiss`));
    reloadRecs();
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        maxWidth: 460,
        zIndex: 9000,
        background: "var(--panel-strong, rgba(255, 255, 255, 0.95))",
        backdropFilter: "blur(20px)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "-12px 0 36px rgba(0, 0, 0, 0.2)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "linear-gradient(135deg, #0066cc, #5856d6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
            }}
          >
            <Bot size={18} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>
              Agentic Copilot
            </h3>
            <p className="small muted" style={{ margin: 0, fontSize: 11 }}>
              Autonomous Exception Resolution
            </p>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClose}
          style={{ padding: 6, borderRadius: 8 }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Auto-Pilot Control Bar */}
      <div
        style={{
          padding: "12px 20px",
          background: config?.autoPilot ? "rgba(52, 199, 89, 0.08)" : "var(--panel-3)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={16} color={config?.autoPilot ? "#34c759" : "var(--muted)"} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 12 }}>Auto-Pilot Execution</div>
            <div className="small muted" style={{ fontSize: 10 }}>
              {config?.autoPilot ? "Resolutions apply automatically" : "Human approval required"}
            </div>
          </div>
        </div>

        <button
          type="button"
          className={`btn btn-sm ${config?.autoPilot ? "btn-primary" : "btn-ghost"}`}
          style={{
            fontSize: 12,
            padding: "4px 12px",
            background: config?.autoPilot ? "#34c759" : undefined,
            borderColor: config?.autoPilot ? "#34c759" : undefined,
          }}
          onClick={toggleAutoPilot}
          disabled={busy}
        >
          {config?.autoPilot ? "Auto: ON" : "Auto: OFF"}
        </button>
      </div>

      {/* Recommendations Feed */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {!recs || recs.length === 0 ? (
          <Empty>
            <CheckCircle2 size={32} color="#34c759" style={{ marginBottom: 8 }} />
            <div style={{ fontWeight: 600, color: "var(--ink)" }}>All Systems Nominal</div>
            <div className="small muted" style={{ marginTop: 4 }}>
              Copilot is actively monitoring live trip telematics, gate check-ins, and dock doors.
            </div>
          </Empty>
        ) : (
          recs.map((rec) => (
            <div
              key={rec.id}
              style={{
                background: "var(--panel-2)",
                borderRadius: 14,
                border: `1px solid ${rec.severity === "critical" ? "rgba(239, 68, 68, 0.4)" : "var(--border)"}`,
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.04)",
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {/* Card Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <Pill tone={SEVERITY_TONE[rec.severity]}>{rec.severity.toUpperCase()}</Pill>
                    <span className="small muted" style={{ fontSize: 11 }}>
                      {fromNow(rec.createdAt, now)}
                    </span>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{rec.title}</div>
                </div>
              </div>

              {/* Root Cause & Impact */}
              <div
                style={{
                  background: "var(--panel-3)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div>
                  <span style={{ fontWeight: 600, color: "var(--ink-soft)" }}>Cause: </span>
                  <span style={{ color: "var(--ink)" }}>{rec.rootCause}</span>
                </div>
                <div>
                  <span style={{ fontWeight: 600, color: "var(--ink-soft)" }}>Impact: </span>
                  <span style={{ color: "var(--ink)" }}>{rec.impactSummary}</span>
                </div>
              </div>

              {/* Prescribed Actions */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-soft)", marginBottom: 6 }}>
                  Prescribed Actions ({rec.prescribedActions.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {rec.prescribedActions.map((action, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        color: "var(--ink)",
                      }}
                    >
                      <ChevronRight size={14} color="var(--accent, #0066cc)" />
                      <span>{action.description}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions Footer */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleDismiss(rec.id)}
                  disabled={busy}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleApply(rec.id)}
                  disabled={busy || applyingId === rec.id}
                  style={{
                    fontSize: 12,
                    padding: "5px 12px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {applyingId === rec.id ? <RefreshCw size={13} className="spin" /> : <Sparkles size={13} />}
                  <span>1-Click Apply</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
