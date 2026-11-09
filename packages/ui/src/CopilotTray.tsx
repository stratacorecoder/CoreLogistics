import {
  COPILOT_ASK_HINT,
  COPILOT_ASK_SUGGESTIONS,
  type CopilotAnswer,
  type CopilotConfig,
  type CopilotLink,
  type CopilotJob,
  type CopilotMonitoring,
  type CopilotRecommendation,
  type CopilotSeverity,
} from "@corelogistics/contracts";
import { Bot, ChevronRight, RefreshCw, Send, Sparkles, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, qs } from "./api.js";
import { Empty, Pill } from "./components.js";
import { fmtDateTime, fromNow } from "./format.js";
import { actorLabel, autoEligibility, disconnectedDetail, NO_PENDING_RECOMMENDATIONS, surfaceOf, watchedSentence } from "./copilotSurface.js";
import { useAction, useApi, useNow, useStreamPhase } from "./live.js";

const SEVERITY_TONE: Record<CopilotSeverity, string> = {
  critical: "danger",
  high: "warn",
  medium: "accent",
  low: "info",
};

const HISTORY_STATUS = "applied,auto_applied,dismissed,resolved";

const ASK_LABELS: Record<string, string> = {
  "What needs me right now?": "What needs me",
  "Which trips are late?": "Late trips",
  "Which docks are free?": "Free docks",
  "What can Auto-Pilot do?": "Auto-Pilot",
  "Which jobs failed?": "Failed jobs",
};

function pendingQuery(siteId?: string | null) {
  return `/copilot/recommendations${qs({ siteId: siteId || undefined, status: "pending" })}`;
}

export function CopilotBadge({ siteId, onOpen }: { siteId?: string | null; onOpen: () => void }) {
  const recs = useApi<CopilotRecommendation[]>(pendingQuery(siteId), { intervalMs: 8000 });
  const monitoring = useApi<CopilotMonitoring>("/copilot/monitoring", { intervalMs: 8000 });
  const { data: config } = useApi<CopilotConfig>("/copilot/config", { intervalMs: 15000 });
  const phase = useStreamPhase();
  const state = surfaceOf({
    recsLoading: recs.loading,
    recs: recs.data,
    recsError: recs.error,
    phase,
    monitoring: monitoring.data,
    monLoading: monitoring.loading,
    monError: monitoring.error,
  });
  const count = recs.data?.length ?? 0;
  const label =
    state === "loading"
      ? "Loading"
      : state === "disconnected"
        ? "Offline"
        : state === "processing-failed"
          ? `Failed ${monitoring.data?.failedJobs ?? 0}`
          : state === "pending-review"
            ? `Review ${count}`
            : state === "empty"
              ? config?.autoPilot
                ? "Auto"
                : ""
              : "";

  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={onOpen}
      aria-label={`Copilot ${state.replace("-", " ")}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 20,
        background: state === "processing-failed" || state === "pending" ? "rgba(239, 68, 68, 0.15)" : state === "pending-review" || state === "disconnected" ? "rgba(255, 149, 0, 0.15)" : "var(--panel-2)",
        border: state === "processing-failed" || state === "pending" ? "1px solid rgba(239, 68, 68, 0.4)" : state === "pending-review" || state === "disconnected" ? "1px solid rgba(255, 149, 0, 0.45)" : "1px solid var(--border)",
        color: state === "processing-failed" || state === "pending" ? "var(--danger, #ff3b30)" : state === "pending-review" || state === "disconnected" ? "var(--warn, #b45309)" : "currentColor",
        fontWeight: 600,
        fontSize: 12,
        cursor: "pointer",
      }}
      title={watchedSentence(monitoring.data?.monitoredEvents)}
    >
      {config?.autoPilot && state === "empty" ? <Zap size={14} /> : <Bot size={14} />}
      <span>Copilot</span>
      {state === "pending" && count > 0 ? (
        <span style={{ background: "var(--danger, #ff3b30)", color: "#ffffff", borderRadius: 999, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>{count}</span>
      ) : label ? (
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      ) : null}
    </button>
  );
}

export function CopilotDrawer({
  siteId,
  onClose,
  onOpen,
}: {
  siteId?: string | null;
  onClose: () => void;
  onOpen: (link: CopilotLink) => void;
}) {
  const now = useNow(15_000);
  const phase = useStreamPhase();
  const recs = useApi<CopilotRecommendation[]>(pendingQuery(siteId));
  const history = useApi<CopilotRecommendation[]>(`/copilot/recommendations${qs({ siteId: siteId || undefined, status: HISTORY_STATUS, limit: 20 })}`);
  const monitoring = useApi<CopilotMonitoring>("/copilot/monitoring", { intervalMs: 8000 });
  const { data: config, reload: reloadConfig } = useApi<CopilotConfig>("/copilot/config");
  const jobs = useApi<CopilotJob[]>((monitoring.data?.failedJobs ?? 0) > 0 ? "/copilot/jobs?status=failed" : null);
  const { busy, run } = useAction();
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<Record<string, string>>({});
  const state = surfaceOf({
    recsLoading: recs.loading,
    recs: recs.data,
    recsError: recs.error,
    phase,
    monitoring: monitoring.data,
    monLoading: monitoring.loading,
    monError: monitoring.error,
  });

  const toggleAutoPilot = async () => {
    if (!config) return;
    await run(() => api.post("/copilot/config", { autoPilot: !config.autoPilot }));
    reloadConfig();
  };

  const handleApply = async (rec: CopilotRecommendation) => {
    setApplyingId(rec.id);
    await run(async () => {
      try {
        const result = await api.post<CopilotRecommendation>(`/copilot/recommendations/${rec.id}/apply`, { revision: rec.revision });
        setCardError((prev) => {
          const next = { ...prev };
          delete next[rec.id];
          return next;
        });
        return result;
      } catch (err) {
        setCardError((prev) => ({ ...prev, [rec.id]: err instanceof Error ? err.message : "Apply failed" }));
        recs.reload();
        throw err;
      }
    });
    setApplyingId(null);
    recs.reload();
    history.reload();
  };

  const handleDismiss = async (rec: CopilotRecommendation) => {
    await run(() => api.post(`/copilot/recommendations/${rec.id}/dismiss`, { revision: rec.revision }));
    recs.reload();
    history.reload();
  };

  const retryJob = async (job: CopilotJob) => {
    await run(() => api.post(`/copilot/jobs/${job.id}/retry`));
    jobs.reload();
    monitoring.reload();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="copilot-title"
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
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)", background: "var(--panel-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg, #0066cc, #5856d6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#ffffff" }}>
            <Bot size={18} />
          </div>
          <div>
            <h3 id="copilot-title" style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Agentic Copilot</h3>
            <p className="small muted" style={{ margin: 0, fontSize: 11 }}>{watchedSentence(monitoring.data?.monitoredEvents)}</p>
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close copilot" style={{ padding: 6, borderRadius: 8 }}>
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: "12px 20px", background: config?.autoPilot ? "rgba(52, 199, 89, 0.08)" : "var(--panel-3)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={16} color={config?.autoPilot ? "#34c759" : "var(--muted)"} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 12 }}>Auto-Pilot Execution</div>
            <div className="small muted" style={{ fontSize: 10 }}>Low and medium appointment reschedules only. Dock swaps and high or critical disruptions stay for Tower.</div>
          </div>
        </div>
        <button type="button" className={`btn btn-sm ${config?.autoPilot ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "4px 12px", background: config?.autoPilot ? "#34c759" : undefined, borderColor: config?.autoPilot ? "#34c759" : undefined }} onClick={() => void toggleAutoPilot()} disabled={busy || !config}>
          {config?.autoPilot ? "Auto: ON" : "Auto: OFF"}
        </button>
      </div>

      <div className="copilot-scroll">
        {monitoring.data ? (
          <p className="small muted" style={{ margin: 0 }}>
            Heartbeat {monitoring.data.heartbeatAt ? fromNow(monitoring.data.heartbeatAt, now) : "not yet"}. Backlog {monitoring.data.backlog}. Failed jobs {monitoring.data.failedJobs}.
          </p>
        ) : null}
        {state === "loading" ? <Empty>Loading recommendations.</Empty> : null}
        {state === "disconnected" ? (
          <div className="error-note" role="alert">
            <strong>Disconnected.</strong>{" "}
            {disconnectedDetail({
              recsError: recs.error,
              monError: monitoring.error,
              workerStopped: Boolean(monitoring.data && !monitoring.data.running),
              hasList: recs.data !== undefined,
            })}
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => { recs.reload(); monitoring.reload(); }}>Retry</button>
          </div>
        ) : null}
        {state === "processing-failed" ? (
          <div className="error-note" role="alert">
            <strong>Processing failed.</strong> {monitoring.data?.failedJobs ?? 0} disruption job{(monitoring.data?.failedJobs ?? 0) === 1 ? "" : "s"} did not finish.
          </div>
        ) : null}
        {state === "empty" ? <Empty>{NO_PENDING_RECOMMENDATIONS}</Empty> : null}
        {recs.data?.map((rec) => (
          <RecommendationCard
            key={rec.id}
            rec={rec}
            now={now}
            autoOn={Boolean(config?.autoPilot)}
            busy={busy}
            applying={applyingId === rec.id}
            notice={cardError[rec.id] ?? null}
            onApply={() => void handleApply(rec)}
            onDismiss={() => void handleDismiss(rec)}
          />
        ))}
        {jobs.data?.length ? (
          <section>
            <h4 className="field-label">Failed jobs</h4>
            {jobs.data.map((job) => (
              <div key={job.id} className="error-note" style={{ marginBottom: 8 }}>
                <div>Job {job.id} · event {job.eventId} · {job.attempts} attempts</div>
                <div>{job.processingError ?? "No error text was stored."}</div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void retryJob(job)}>Retry job</button>
              </div>
            ))}
          </section>
        ) : null}
        <section>
          <h4 className="field-label">History</h4>
          {history.loading && history.data === undefined ? <p className="small muted">Loading history.</p> : null}
          {history.error ? <p className="error-note">History could not be loaded. {history.error}</p> : null}
          {history.data && history.data.length === 0 ? <p className="small muted">No applied, dismissed, or resolved recommendations yet.</p> : null}
          {history.data?.map((rec) => (
            <div key={rec.id} style={{ background: "var(--panel-2)", borderRadius: 12, border: "1px solid var(--border)", padding: 12, marginBottom: 8, fontSize: 12 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                <Pill value={rec.status} />
                <span className="muted">Revision {rec.revision}</span>
              </div>
              <div style={{ fontWeight: 700 }}>{rec.title}</div>
              <div>Actor: {actorLabel(rec)}{rec.appliedAt ? ` · ${fromNow(rec.appliedAt, now)}` : ""}</div>
              {rec.resolution ? <div>Resolution: {rec.resolution}</div> : null}
              {rec.executionError ? <div>Failure: {rec.executionError}</div> : null}
              <RevisionList rec={rec} />
            </div>
          ))}
        </section>
      </div>
      <CopilotChat siteId={siteId} onOpen={onOpen} />
    </div>
  );
}

type ChatTurn = {
  id: number;
  question: string;
  answer?: CopilotAnswer;
  error?: string;
};

type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
};

const CHAT_STORE = "corelogistics.copilot.chats.v1";
const CHAT_LIMIT = 20;

function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(CHAT_STORE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatThread[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.turns) && thread.turns.length > 0)
      .slice(0, CHAT_LIMIT);
  } catch {
    return [];
  }
}

function rememberThread(prev: ChatThread[], id: string, turns: ChatTurn[]): ChatThread[] {
  const title = (turns.find((turn) => turn.question)?.question ?? "Chat").trim().slice(0, 72);
  const next: ChatThread = { id, title, updatedAt: Date.now(), turns: turns.slice(-30) };
  return [next, ...prev.filter((thread) => thread.id !== id)].slice(0, CHAT_LIMIT);
}

function CopilotChat({ siteId, onOpen }: { siteId?: string | null; onOpen: (link: CopilotLink) => void }) {
  const [question, setQuestion] = useState("");
  const [threads, setThreads] = useState<ChatThread[]>(loadThreads);
  const [activeId, setActiveId] = useState(() => loadThreads()[0]?.id ?? `chat_${Date.now()}`);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const turns = threads.find((thread) => thread.id === activeId)?.turns ?? [];

  useEffect(() => {
    localStorage.setItem(CHAT_STORE, JSON.stringify(threads));
  }, [threads]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [turns, busy, browsing]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const threadId = activeId;
    const id = Date.now();
    const prior = turns.flatMap((turn) => turn.answer ? [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.answer.answer },
    ] : []).slice(-8);
    setQuestion("");
    setBrowsing(false);
    setBusy(true);
    setThreads((prev) => rememberThread(prev, threadId, [...(prev.find((thread) => thread.id === threadId)?.turns ?? []), { id, question: trimmed }]));
    try {
      const answer = await api.post<CopilotAnswer>("/copilot/ask", {
        question: trimmed,
        siteId: siteId || undefined,
        history: prior,
      });
      setThreads((prev) => rememberThread(
        prev,
        threadId,
        (prev.find((thread) => thread.id === threadId)?.turns ?? []).map((turn) => (turn.id === id ? { ...turn, answer } : turn)),
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : "The question could not be answered.";
      setQuestion(trimmed);
      setThreads((prev) => rememberThread(
        prev,
        threadId,
        (prev.find((thread) => thread.id === threadId)?.turns ?? []).map((turn) => (turn.id === id ? { ...turn, error: message } : turn)),
      ));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(question);
  };

  const suggestions = turns.at(-1)?.answer?.suggestions ?? [...COPILOT_ASK_SUGGESTIONS];
  const suggestionButtons = (
    <div className="copilot-ask-suggestions">
      {suggestions.map((suggestion) => (
        <button key={suggestion} type="button" className="btn copilot-suggest" disabled={busy} onClick={() => void ask(suggestion)}>
          {ASK_LABELS[suggestion] ?? suggestion}
        </button>
      ))}
    </div>
  );

  const startNew = () => {
    if (busy) return;
    setActiveId(`chat_${Date.now()}`);
    setBrowsing(false);
    setQuestion("");
    inputRef.current?.focus();
  };

  return (
    <form className="copilot-ask" onSubmit={submit}>
      <div className="copilot-ask-stage">
        <div className="copilot-chat-bar">
          <button type="button" className="btn btn-ghost btn-sm" onClick={startNew} disabled={busy || turns.length === 0}>New chat</button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={browsing}
            disabled={threads.length === 0}
            onClick={() => setBrowsing((open) => !open)}
          >
            {browsing ? "Back" : `Chats${threads.length ? ` ${threads.length}` : ""}`}
          </button>
        </div>
        {browsing ? (
          <div className="copilot-chat-list" role="list" aria-label="Saved chats">
            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`copilot-chat-item${thread.id === activeId ? " is-current" : ""}`}
                onClick={() => { setActiveId(thread.id); setBrowsing(false); }}
              >
                <span>{thread.title}</span>
                <span className="small muted">{fromNow(new Date(thread.updatedAt).toISOString())}</span>
              </button>
            ))}
          </div>
        ) : turns.length === 0 ? (
          <div className="copilot-ask-empty">
            <div>
              <label htmlFor="copilot-ask" className="field-label">Ask the operation</label>
              <p className="field-hint">{COPILOT_ASK_HINT}</p>
            </div>
            {suggestionButtons}
          </div>
        ) : (
          <>
            <div ref={threadRef} className="copilot-ask-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Copilot answers">
              {turns.map((turn) => (
                <div key={turn.id} className="copilot-ask-turn">
                  <div className="copilot-ask-user">{turn.question}</div>
                  {turn.answer ? (
                    <div className="copilot-ask-reply">
                      {turn.answer.answer}
                      {turn.answer.links.length ? (
                        <div className="copilot-links">
                          {turn.answer.links.map((link) => (
                            <button
                              key={`${link.view}:${link.focus ?? link.label}`}
                              type="button"
                              className="copilot-link"
                              onClick={() => onOpen(link)}
                            >
                              {link.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {turn.answer.citations.length ? (
                        <div className="small muted" style={{ marginTop: 6 }}>From {turn.answer.citations.map((item) => item.label).join(", ")}</div>
                      ) : null}
                    </div>
                  ) : null}
                  {turn.error ? <div className="error-note" role="alert">{turn.error}</div> : null}
                  {!turn.answer && !turn.error ? <p className="field-hint">Thinking.</p> : null}
                </div>
              ))}
            </div>
            {suggestionButtons}
          </>
        )}
      </div>
      <div className="copilot-ask-row">
        <input
          ref={inputRef}
          id="copilot-ask"
          className="input"
          aria-label="Ask the operation"
          name="copilot-question"
          autoComplete="off"
          placeholder="Ask about the yard, or how to set this up"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={busy}
          maxLength={500}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !question.trim()}>
          {busy ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}
          <span>{busy ? "Asking" : "Ask"}</span>
        </button>
      </div>
    </form>
  );
}

function RecommendationCard({
  rec,
  now,
  autoOn,
  busy,
  applying,
  notice,
  onApply,
  onDismiss,
}: {
  rec: CopilotRecommendation;
  now: number;
  autoOn: boolean;
  busy: boolean;
  applying: boolean;
  notice: string | null;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const executable = rec.prescribedActions.length > 0;
  return (
    <div style={{ background: "var(--panel-2)", borderRadius: 14, border: `1px solid ${rec.severity === "critical" ? "rgba(239, 68, 68, 0.4)" : "var(--border)"}`, boxShadow: "0 4px 12px rgba(0, 0, 0, 0.04)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
          <Pill tone={SEVERITY_TONE[rec.severity]}>{rec.severity.toUpperCase()}</Pill>
          {rec.lifecycle === "human_review" ? <Pill tone="warn">REVIEW</Pill> : null}
          <span className="small muted" style={{ fontSize: 11 }}>Revision {rec.revision} · {fromNow(rec.createdAt, now)}</span>
        </div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{rec.title}</div>
      </div>
      <div style={{ background: "var(--panel-3)", borderRadius: 8, padding: "8px 10px", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <div><span style={{ fontWeight: 600 }}>Cause: </span>{rec.rootCause}</div>
        <div><span style={{ fontWeight: 600 }}>Impact: </span>{rec.impactSummary}</div>
        {rec.preconditions.manualReviewReason ? <div><span style={{ fontWeight: 600 }}>Reason: </span>{rec.preconditions.manualReviewReason}</div> : null}
        {rec.preconditions.proposedWindow ? (
          <div>
            <span style={{ fontWeight: 600 }}>Proposed window: </span>
            {fmtDateTime(rec.preconditions.proposedWindow.windowStart)} – {fmtDateTime(rec.preconditions.proposedWindow.windowEnd)}
          </div>
        ) : null}
        <div>{autoEligibility(rec, autoOn)}</div>
        {rec.executionError ? <div><span style={{ fontWeight: 600 }}>Last failure: </span>{rec.executionError}</div> : null}
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-soft)", marginBottom: 6 }}>
          Proposed effects ({rec.prescribedActions.length})
        </div>
        {executable ? rec.prescribedActions.map((action) => (
          <div key={`${action.type}-${action.targetId}`} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <ChevronRight size={14} color="var(--accent, #0066cc)" />
            <span>{action.description}</span>
          </div>
        )) : <p className="small muted" style={{ margin: 0 }}>No executable action. Apply stays off until a safe action exists.</p>}
      </div>
      <RevisionList rec={rec} />
      {notice ? <div className="error-note" role="alert"><strong>Stale state.</strong> {notice}</div> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss} disabled={busy} style={{ fontSize: 12, padding: "5px 10px" }}>Dismiss</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onApply} disabled={busy || applying || !executable} style={{ fontSize: 12, padding: "5px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {applying ? <RefreshCw size={13} className="spin" /> : <Sparkles size={13} />}
          <span>{executable ? "1-Click Apply" : "No action to apply"}</span>
        </button>
      </div>
    </div>
  );
}

function RevisionList({ rec }: { rec: CopilotRecommendation }) {
  const superseded = rec.priorRevisions.filter((rev) => rev.lifecycle === "superseded");
  if (!superseded.length) return null;
  return (
    <div className="small muted">
      {superseded.map((rev) => (
        <div key={rev.revision}>Revision {rev.revision} superseded · {rev.severity} · {rev.rootCause}</div>
      ))}
    </div>
  );
}
