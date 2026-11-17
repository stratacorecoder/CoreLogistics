import {
  COPILOT_ASK_SUGGESTIONS,
  ON_TIME_TOLERANCE_MINUTES,
  type CopilotAnswer,
  type CopilotCitation,
  type CopilotLink,
  type CopilotRecommendation,
} from "@corelogistics/contracts";
import { many, one, scalar } from "../../db.js";
import { getAppointment, listAppointments } from "../gate/service.js";
import { listDrivers, listVehicles } from "../fleet/service.js";
import { getTrip, listTrips } from "../trips/service.js";
import { getAutoPilotConfig, getRecommendation, listRecommendations } from "./service.js";
import { blockedQuestion, COPILOT_SCOPE_REFUSAL } from "./guard.js";
import { COPILOT_MONITORED_EVENTS, getCopilotMonitoring, listCopilotJobs } from "./worker.js";

/**
 * Read-only answers for the control tower. This module selects rows and
 * composes text. It does not apply, dismiss, retry, or change Auto-Pilot.
 */

const EVENT_LABELS: Record<string, string> = {
  "trip.issue": "trip issues",
  "trip.updated": "trip updates",
  "trip.dispatched": "dispatch",
  "trip.departed": "departure",
  "trip.arrived": "arrival",
  "trip.stop_arrived": "stop arrival",
  "trip.stop_departed": "stop departure",
  "trip.completed": "completion",
  "trip.cancelled": "cancellation",
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

type SiteScope = { id: string; code: string; name: string };

type HitKind =
  | "trip"
  | "appointment"
  | "vehicle"
  | "driver"
  | "order"
  | "shipment"
  | "receipt"
  | "handling_unit"
  | "location"
  | "sku"
  | "recommendation";

type Hit = { kind: HitKind; id: string };

type Intent =
  | "help"
  | "attention"
  | "autopilot"
  | "worker"
  | "docks"
  | "appointments"
  | "trips"
  | "fleet"
  | "warehouse"
  | "issues"
  | "overview";

const TOKEN_RE =
  /\b(?:[A-Za-z]{2,6}-\d{2,}|[A-Za-z]{1,4}\d{2,}(?:-\d+)?|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,4}|cop_[a-z0-9]+)\b/gi;

export function answerCopilot(input: { question: string; siteId?: string | null; now?: number }): CopilotAnswer {
  const question = input.question.trim();
  const now = input.now ?? Date.now();
  const citations: CopilotCitation[] = [];

  if (blockedQuestion(question)) {
    return finish(question, COPILOT_SCOPE_REFUSAL, citations, false, false);
  }

  if (/\b(passwords?|api[- ]?keys?|secrets?|session tokens?|password hashes?|device keys?)\b/i.test(question)) {
    return finish(
      question,
      "I do not read passwords, session tokens, or device keys.",
      citations,
      false,
      false,
    );
  }

  const requested = loadSite(input.siteId);
  if (requested.missing) {
    return finish(question, "That site is not in the record, so I cannot answer for it.", citations, false, false);
  }
  const named = siteMentioned(question);
  const site = named ?? requested.site;
  const q = question.toLowerCase();
  const intents = detectIntents(q);
  const { hits, unmatched } = resolveHits(question);
  const sections: string[] = [];
  const broad = /\b(which|list|all|any|how many|what needs|overview|status|brief)\b/.test(q);

  if (named && requested.site && named.id !== requested.site.id) {
    sections.push(`You named ${named.name} (${named.code}). This answer uses that site.`);
  }
  if (unmatched.length) {
    sections.push(`${unmatched.join(", ")} ${unmatched.length === 1 ? "is" : "are"} not in the live record.`);
  }

  for (const hit of hits.slice(0, 3)) {
    sections.push(describeHit(hit, citations, now));
  }

  const skipBroad = hits.length > 0 && !broad;
  for (const intent of intents) {
    if (intent === "autopilot" && intents.includes("help")) continue;
    if (skipBroad && (intent === "trips" || intent === "fleet" || intent === "docks" || intent === "appointments" || intent === "warehouse")) {
      continue;
    }
    const section = sectionFor(intent, q, site, citations, now);
    if (section) sections.push(section);
  }

  if (!sections.length) {
    sections.push(guideText());
    citations.push({ kind: "guide", id: "copilot-rules", label: "Copilot rules" });
  }

  return finish(question, sections.join("\n\n"), citations, getCopilotMonitoring().failedJobs > 0, true);
}

function finish(
  question: string,
  answer: string,
  citations: CopilotCitation[],
  failedJobs: boolean,
  allowLinks: boolean,
): CopilotAnswer {
  const text = answer.trim().slice(0, 4000);
  const suggestions = failedJobs
    ? ["Which jobs failed?", ...COPILOT_ASK_SUGGESTIONS].slice(0, 4)
    : [...COPILOT_ASK_SUGGESTIONS];
  const kept = dedupe(citations).slice(0, 8);
  return {
    answer: text || guideText(),
    citations: kept,
    suggestions,
    links: allowLinks ? placeLinks(question, kept) : [],
  };
}

/** Screens for a locate-style question. Codes come from citations, not from free text. */
function placeLinks(question: string, citations: CopilotCitation[]): CopilotLink[] {
  const links: CopilotLink[] = [];
  const seen = new Set<string>();
  const add = (link: CopilotLink) => {
    const key = `${link.view}:${link.focus ?? ""}`;
    if (seen.has(key) || links.length >= 4) return;
    seen.add(key);
    links.push(link);
  };
  for (const cite of citations) {
    const code = cite.label.split(" ")[0] ?? cite.label;
    if (!code) continue;
    if (cite.kind === "trip") add({ label: clipLink(`Open ${code} in Dispatch`), view: "dispatch", focus: code.slice(0, 80) });
    else if (cite.kind === "location") add({ label: clipLink(`Show ${code} on the live site`), view: "live", focus: code.slice(0, 80) });
    else if (cite.kind === "visit") add({ label: clipLink(`Show ${cite.label} on the live site`), view: "live", focus: cite.label.slice(0, 80) });
    else if (cite.kind === "vehicle" || cite.kind === "driver") add({ label: clipLink(`Open ${cite.label} in Fleet`), view: "fleet", focus: cite.label.slice(0, 80) });
    else if (cite.kind === "appointment") add({ label: clipLink(`Open ${code} in Dispatch`), view: "dispatch" });
  }
  const q = question.toLowerCase();
  const askingPlace = /\b(where|find|show me|take me|go to|locate|open)\b/.test(q);
  if (askingPlace && links.length === 0) {
    if (/\bmaintenance\b/.test(q)) add({ label: "Open Fleet maintenance", view: "fleet", focus: "maintenance" });
    else if (/\b(devices?|automation)\b/.test(q)) add({ label: "Open Fleet devices", view: "fleet", focus: "devices" });
    else if (/\b(dispatch|trips?)\b/.test(q)) add({ label: "Open Dispatch", view: "dispatch" });
    else if (/\b(fleet|drivers?|trucks?|vehicles?|plates?)\b/.test(q)) add({ label: "Open Fleet", view: "fleet" });
    else if (/\b(designer|layout)\b/.test(q)) add({ label: "Open Site designer", view: "designer" });
    else if (/\banalytics\b/.test(q)) add({ label: "Open Analytics", view: "analytics" });
    else if (/\b(live site|yard|map|docks?|gates?)\b/.test(q)) add({ label: "Open the live site", view: "live" });
  }
  return links;
}

function clipLink(label: string): string {
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}

function detectIntents(q: string): Intent[] {
  const intents: Intent[] = [];
  const add = (intent: Intent, on: boolean) => {
    if (on) intents.push(intent);
  };
  add("help", /^(help\b|what can you|what do you know|who are you)/.test(q) || /\b(how do i|how to|help me|set (this|it) up|walk me through|how does this work)\b/.test(q) || /\b(dismiss|revision|1-click)\b/.test(q));
  add("overview", /^(status|brief|briefing|overview|summary)\b/.test(q) || /what(?:'s| is) going on/.test(q) || /\bhow are we\b/.test(q));
  add("attention", /\b(pending|recommendations?|needs me|need me|should i|attention|human review|waiting on me)\b/.test(q) || /what(?:'s| is) waiting/.test(q));
  add("autopilot", /\bauto[-\s]?pilot\b/.test(q));
  add("worker", /\b(heartbeat|backlog|failed jobs?|worker|monitoring|watching|offline|disconnected)\b/.test(q));
  add("docks", /\b(docks?|yard|gates?|check-?ins?|slots?)\b/.test(q));
  add("appointments", /\b(appointments?|bookings?)\b/.test(q) || /\bwindows?\b/.test(q));
  add("trips", /\b(trips?|late|delays?|delayed|etas?|dispatched|in transit|arrivals?)\b/.test(q));
  add("fleet", /\b(drivers?|vehicles?|trucks?|trailers?|maintenance|fleet|plates?|licen[cs]es?)\b/.test(q));
  add("warehouse", /\b(orders?|picks?|putaways?|warehouse|receipts?|shipments?|pallets?|stock|skus?|inventory|expir|fefo|shelf)\b/.test(q));
  add("issues", /\b(issues?|breakdowns?|accidents?|seal|disruptions?|cargo)\b/.test(q));
  if (intents.includes("overview")) {
    for (const extra of ["attention", "worker", "trips", "docks"] as const) {
      if (!intents.includes(extra)) intents.push(extra);
    }
  }
  if (/\b(apply|dismiss|revision)\b/.test(q) && !intents.includes("help")) intents.push("help");
  return intents;
}

function sectionFor(intent: Intent, q: string, site: SiteScope | null, citations: CopilotCitation[], now: number): string {
  switch (intent) {
    case "help":
      citations.push({ kind: "guide", id: "copilot-rules", label: "Copilot rules" });
      return guideText();
    case "attention":
      return attentionSection(site, citations);
    case "autopilot":
      return autoPilotSection();
    case "worker":
      return workerSection(q, citations, now);
    case "docks":
      return dockSection(site, citations);
    case "appointments":
      return appointmentSection(site, citations);
    case "trips":
      return tripSection(site, q, citations);
    case "fleet":
      return fleetSection(site, citations, now);
    case "warehouse":
      return warehouseSection(site, q, citations);
    case "issues":
      return issueSection(site, citations);
    default:
      return "";
  }
}

function guideText(): string {
  const watched = COPILOT_MONITORED_EVENTS.map((event) => EVENT_LABELS[event] ?? event).join(", ");
  return [
    "I read the live operation for this control tower. I do not apply a recommendation, dismiss one, retry a job, or change Auto-Pilot.",
    "One open recommendation is kept per trip. A new event after apply, dismiss, or resolve opens another row. Cancelling or completing the trip resolves the open row.",
    "Apply and dismiss send the revision on the card. If that revision is stale, the server rejects it and the card stays so you can read the new one.",
    autoPilotSection(),
    `The worker watches ${watched}.`,
  ].join("\n");
}

function autoPilotSection(): string {
  const on = getAutoPilotConfig();
  return `Auto-Pilot is ${on ? "on" : "off"}. When it is on, it applies only a low or medium recommendation whose every action is an appointment reschedule. Dock swaps, high severity, and critical severity stay on the card for Tower.`;
}

function attentionSection(site: SiteScope | null, citations: CopilotCitation[]): string {
  const pending = listRecommendations({ siteId: site?.id, status: "pending", limit: 20 }).sort((a, b) => {
    const review = Number(b.lifecycle === "human_review") - Number(a.lifecycle === "human_review");
    if (review) return review;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
  const where = scopePhrase(site);
  if (!pending.length) {
    const failed = getCopilotMonitoring().failedJobs;
    const extra = failed ? ` ${failed} disruption job${failed === 1 ? "" : "s"} failed and can be retried from the failed-job row.` : "";
    return `No pending recommendations ${where}.${extra}`;
  }
  const review = pending.filter((rec) => rec.lifecycle === "human_review").length;
  const lines = pending.slice(0, 5).map((rec) => recommendationLine(rec, citations));
  const more = pending.length > 5 ? `\n${pending.length - 5} more are also pending.` : "";
  const reviewNote = review ? ` ${review} need${review === 1 ? "s" : ""} your review before there is a safe action.` : "";
  return `${pending.length} recommendation${pending.length === 1 ? " is" : "s are"} waiting ${where}.${reviewNote}\n${lines.join("\n")}${more}`;
}

function recommendationLine(rec: CopilotRecommendation, citations: CopilotCitation[]): string {
  citations.push({ kind: "recommendation", id: rec.id, label: rec.title });
  const action = rec.prescribedActions[0]?.description;
  const review = rec.lifecycle === "human_review" ? " Needs your review." : "";
  const proposed = action ? ` Proposed: ${action}.` : " No executable action, so Apply stays off.";
  const reason = rec.preconditions.manualReviewReason ? ` ${rec.preconditions.manualReviewReason}.` : "";
  const failure = rec.executionError ? ` Last failure: ${rec.executionError}.` : "";
  return `- ${rec.severity.toUpperCase()} ${rec.title}.${review}${proposed}${reason}${failure}`;
}

function workerSection(q: string, citations: CopilotCitation[], now: number): string {
  const monitoring = getCopilotMonitoring();
  const heartbeat = monitoring.heartbeatAt ? `${age(monitoring.heartbeatAt, now)} (${fmt(monitoring.heartbeatAt)})` : "not yet";
  const state = monitoring.running ? "running" : "not running";
  const watched = monitoring.monitoredEvents.map((event) => EVENT_LABELS[event] ?? event).join(", ");
  let text = `The disruption worker is ${state}. Heartbeat ${heartbeat}. Backlog ${monitoring.backlog}. Failed jobs ${monitoring.failedJobs}. It watches ${watched}.`;
  if (/\bfailed\b/.test(q) || monitoring.failedJobs > 0) {
    const jobs = listCopilotJobs("failed").slice(0, 5);
    if (jobs.length) {
      const lines = jobs.map((job) => {
        citations.push({ kind: "job", id: job.id, label: `Job ${job.id}` });
        return `- Job ${job.id} for event ${job.eventId}, ${job.attempts} attempts. ${job.processingError ?? "No error text was stored."}`;
      });
      text += `\n${lines.join("\n")}\nRetry stays on the failed-job row. Chat cannot retry a job.`;
    }
  }
  return text;
}

function tripSection(site: SiteScope | null, q: string, citations: CopilotCitation[]): string {
  const trips = listTrips({ siteId: site?.id, active: "true", limit: 40 });
  const lateOnly = /\b(late|delays?|delayed)\b/.test(q);
  const late = trips.filter((trip) => trip.delayed);
  const shown = (lateOnly ? late : [...late, ...trips.filter((trip) => !trip.delayed)]).slice(0, 6);
  const where = scopePhrase(site);
  if (!trips.length) return `No active trips ${where}.`;
  if (lateOnly && !late.length) {
    return `No active trip ${where} is past the ${ON_TIME_TOLERANCE_MINUTES}-minute on-time tolerance. ${trips.length} active trip${trips.length === 1 ? " is" : "s are"} still on time.`;
  }
  const lines = shown.map((trip) => {
    citations.push({ kind: "trip", id: trip.id, label: trip.code });
    const timing = trip.delayed ? `${trip.delayMinutes} minutes late` : "on time";
    return `- ${trip.code} ${trip.kind} ${trip.status.replaceAll("_", " ")}, ${timing}. ${place(trip.originSiteId)} to ${place(trip.destinationSiteId)}.`;
  });
  const lead = lateOnly
    ? `${late.length} active trip${late.length === 1 ? " is" : "s are"} late ${where}.`
    : `${trips.length} active trip${trips.length === 1 ? "" : "s"} ${where}. ${late.length} late.`;
  const more = (lateOnly ? late.length : trips.length) > shown.length ? `\n${(lateOnly ? late.length : trips.length) - shown.length} more are not listed.` : "";
  return `${lead}\n${lines.join("\n")}${more}`;
}

function dockSection(site: SiteScope | null, citations: CopilotCitation[]): string {
  const params = site ? [site.id] : [];
  const doors = many<{
    id: string;
    code: string;
    site_code: string;
    site_name: string;
    plate: string | null;
    purpose: string | null;
    visit_id: string | null;
  }>(
    `SELECT l.id, l.code, s.code AS site_code, s.name AS site_name, gv.plate, da.purpose, gv.id AS visit_id
     FROM locations l
     JOIN sites s ON s.id = l.site_id
     LEFT JOIN dock_assignments da ON da.location_id = l.id AND da.released_at IS NULL
     LEFT JOIN gate_visits gv ON gv.id = da.visit_id AND gv.check_out_at IS NULL
     WHERE l.kind = 'dock_door' AND l.active = 1 ${site ? "AND l.site_id = ?" : ""}
     ORDER BY s.code, l.code`,
    params,
  );
  if (!doors.length) return `No active dock doors ${scopePhrase(site)}.`;
  const free = doors.filter((door) => !door.visit_id);
  const busy = doors.filter((door) => door.visit_id);
  const lines = [...free, ...busy].slice(0, 8).map((door) => {
    citations.push({ kind: "location", id: door.id, label: `${door.code} ${door.site_code}` });
    if (!door.visit_id) return `- ${door.code} at ${door.site_code} is free.`;
    if (door.visit_id) citations.push({ kind: "visit", id: door.visit_id, label: door.plate ?? door.code });
    return `- ${door.code} at ${door.site_code} is ${door.purpose ?? "occupied"} for ${door.plate ?? "a truck"}.`;
  });
  const yard = many<{ id: string; plate: string; code: string | null; site_code: string }>(
    `SELECT gv.id, gv.plate, l.code, s.code AS site_code
     FROM gate_visits gv
     JOIN sites s ON s.id = gv.site_id
     LEFT JOIN locations l ON l.id = gv.yard_location_id
     WHERE gv.check_out_at IS NULL AND gv.status = 'in_yard' ${site ? "AND gv.site_id = ?" : ""}
     ORDER BY gv.check_in_at
     LIMIT 6`,
    params,
  );
  const yardLine = yard.length
    ? `\n${yard.length === 6 ? "At least " : ""}${yard.length} truck${yard.length === 1 ? " is" : "s are"} in the yard: ${yard
        .map((visit) => {
          citations.push({ kind: "visit", id: visit.id, label: visit.plate });
          return `${visit.plate}${visit.code ? ` at ${visit.code}` : ""} (${visit.site_code})`;
        })
        .join(", ")}.`
    : "\nNo truck is waiting in the yard.";
  return `${doors.length} dock door${doors.length === 1 ? "" : "s"} ${scopePhrase(site)}. ${free.length} free, ${busy.length} in use.\n${lines.join("\n")}${yardLine}`;
}

function appointmentSection(site: SiteScope | null, citations: CopilotCitation[]): string {
  const open = [...listAppointments(site?.id, "scheduled"), ...listAppointments(site?.id, "checked_in")].sort((a, b) =>
    a.windowStart.localeCompare(b.windowStart),
  );
  if (!open.length) return `No scheduled or checked-in appointments ${scopePhrase(site)}.`;
  const lines = open.slice(0, 6).map((appt) => {
    citations.push({ kind: "appointment", id: appt.id, label: appt.code });
    const dock = appt.locationCode ? ` dock ${appt.locationCode}` : " no dock yet";
    return `- ${appt.code} ${appt.status.replaceAll("_", " ")} ${appt.purpose} ${appt.plate}${dock}, ${fmt(appt.windowStart)} to ${fmt(appt.windowEnd)}.`;
  });
  const more = open.length > 6 ? `\n${open.length - 6} more are still open.` : "";
  return `${open.length} appointment${open.length === 1 ? " is" : "s are"} scheduled or checked in ${scopePhrase(site)}.\n${lines.join("\n")}${more}`;
}

function fleetSection(site: SiteScope | null, citations: CopilotCitation[], now: number): string {
  const active = listTrips({ siteId: site?.id, active: "true", limit: 40 });
  const tripVehicleIds = new Set(active.flatMap((trip) => [trip.vehicleId, trip.trailerId].filter((id): id is string => Boolean(id))));
  const tripDriverIds = new Set(active.map((trip) => trip.driverId).filter((id): id is string => Boolean(id)));
  const vehicles = listVehicles().filter(
    (vehicle) => !site || vehicle.homeSiteId === site.id || vehicle.currentSiteId === site.id || tripVehicleIds.has(vehicle.id),
  );
  const drivers = listDrivers().filter((driver) => !site || driver.homeSiteId === site.id || tripDriverIds.has(driver.id));
  const byStatus = new Map<string, number>();
  for (const vehicle of vehicles) byStatus.set(vehicle.status, (byStatus.get(vehicle.status) ?? 0) + 1);
  const statusText = [...byStatus.entries()].map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(", ");
  const maintenance = many<{ id: string; code: string; plate: string; kind: string; description: string }>(
    `SELECT v.id, v.code, v.plate, m.kind, m.description
     FROM maintenance_records m
     JOIN vehicles v ON v.id = m.vehicle_id
     WHERE m.closed_at IS NULL ${site ? "AND (v.home_site_id = ? OR v.current_site_id = ?)" : ""}
     ORDER BY m.opened_at
     LIMIT 4`,
    site ? [site.id, site.id] : [],
  );
  const maintLines = maintenance.map((row) => {
    citations.push({ kind: "vehicle", id: row.id, label: row.code });
    return `- ${row.code} (${row.plate}) ${row.kind}: ${row.description}`;
  });
  const expiring = drivers.filter((driver) => {
    const days = (Date.parse(driver.licenseExpiry) - now) / 86_400_000;
    return Number.isFinite(days) && days <= 30;
  });
  const licenseLine = expiring.length
    ? `\nLicense inside 30 days: ${expiring.map((driver) => `${driver.name} (${driver.licenseExpiry.slice(0, 10)})`).join(", ")}.`
    : "";
  const body = vehicles.length
    ? `${vehicles.length} vehicle${vehicles.length === 1 ? "" : "s"} ${scopePhrase(site)}: ${statusText || "no status"}. ${drivers.length} driver${drivers.length === 1 ? "" : "s"}.`
    : `No vehicles ${scopePhrase(site)}.`;
  const maint = maintLines.length ? `\nOpen maintenance:\n${maintLines.join("\n")}` : "\nNo open maintenance.";
  return `${body}${maint}${licenseLine}`;
}

function warehouseSection(site: SiteScope | null, q: string, citations: CopilotCitation[]): string {
  const clause = site ? "site_id = ?" : "1 = 1";
  const params = site ? [site.id] : [];
  const orders = count(`SELECT COUNT(*) FROM orders WHERE ${clause} AND status IN ('open','picking','picked','staged','loaded')`, params);
  const picks = count(`SELECT COUNT(*) FROM pick_tasks WHERE ${clause} AND status = 'open'`, params);
  const putaways = count(`SELECT COUNT(*) FROM putaway_tasks WHERE ${clause} AND status = 'open'`, params);
  const receipts = count(`SELECT COUNT(*) FROM inbound_receipts WHERE ${clause} AND status = 'open'`, params);
  const shipments = count(`SELECT COUNT(*) FROM shipments WHERE ${clause} AND status IN ('planning','loading','loaded')`, params);
  const openOrders = many<{ id: string; code: string; status: string; due_at: string }>(
    `SELECT id, code, status, due_at FROM orders WHERE ${clause} AND status IN ('open','picking','picked','staged','loaded') ORDER BY due_at LIMIT 4`,
    params,
  );
  const lines = openOrders.map((order) => {
    citations.push({ kind: "order", id: order.id, label: order.code });
    return `- ${order.code} ${order.status}, due ${fmt(order.due_at)}.`;
  });
  let text = `${scopeLead(site)} ${orders} orders still in the building, ${picks} open picks, ${putaways} open putaways, ${receipts} open receipts, ${shipments} shipments not departed.`;
  if (lines.length) text += `\n${lines.join("\n")}`;
  if (/\b(expir|fefo|shelf)\b/.test(q)) text += `\n${expiryLines(site, citations)}`;
  const namesSku = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,4}\b/.test(q);
  if ((/\b(stock|inventory)\b/.test(q) || /\bon hand\b/.test(q)) && !namesSku) text += `\n${stockLeaders(site, citations)}`;
  return text;
}

function issueSection(site: SiteScope | null, citations: CopilotCitation[]): string {
  const rows = many<{ id: number; message: string; occurred_at: string; code: string | null; trip_id: string | null }>(
    `SELECT e.id, e.message, e.occurred_at, t.code, e.trip_id
     FROM events e
     LEFT JOIN trips t ON t.id = e.trip_id
     WHERE e.type = 'trip.issue'
       AND (? IS NULL OR e.site_id = ? OR t.origin_site_id = ? OR t.destination_site_id = ?)
     ORDER BY e.id DESC
     LIMIT 6`,
    site ? [site.id, site.id, site.id, site.id] : [null, null, null, null],
  );
  if (!rows.length) return `No trip issues are recorded ${scopePhrase(site)}.`;
  const lines = rows.map((row) => {
    if (row.trip_id) citations.push({ kind: "trip", id: row.trip_id, label: row.code ?? row.trip_id });
    return `- ${row.code ?? "Trip"} at ${fmt(row.occurred_at)}: ${row.message}`;
  });
  return `Latest trip issues ${scopePhrase(site)}:\n${lines.join("\n")}`;
}

function describeHit(hit: Hit, citations: CopilotCitation[], now: number): string {
  switch (hit.kind) {
    case "trip":
      return describeTrip(hit.id, citations);
    case "appointment":
      return describeAppointment(hit.id, citations);
    case "vehicle":
      return describeVehicle(hit.id, citations);
    case "driver":
      return describeDriver(hit.id, citations, now);
    case "order":
      return describeOrder(hit.id, citations);
    case "shipment":
      return describeShipment(hit.id, citations);
    case "receipt":
      return describeReceipt(hit.id, citations);
    case "handling_unit":
      return describeUnit(hit.id, citations);
    case "location":
      return describeLocation(hit.id, citations);
    case "sku":
      return describeSku(hit.id, citations);
    case "recommendation":
      return recommendationLine(getRecommendation(hit.id), citations);
    default:
      return "";
  }
}

function describeTrip(id: string, citations: CopilotCitation[]): string {
  const trip = getTrip(id);
  citations.push({ kind: "trip", id: trip.id, label: trip.code });
  const driver = trip.driverId ? driverLabel(trip.driverId) : "no driver";
  const vehicle = trip.vehicleId ? vehicleLabel(trip.vehicleId) : "no vehicle";
  const timing = trip.delayed ? `${trip.delayMinutes} minutes late` : "on time";
  const eta = trip.etaAt ? `ETA ${fmt(trip.etaAt)}` : "no ETA";
  const rec = one<{ id: string }>(
    "SELECT id FROM copilot_recommendations WHERE trip_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [trip.id],
  );
  const issue = one<{ message: string; occurred_at: string }>(
    "SELECT message, occurred_at FROM events WHERE trip_id = ? AND type = 'trip.issue' ORDER BY id DESC LIMIT 1",
    [trip.id],
  );
  const recText = rec ? `\n${recommendationLine(getRecommendation(rec.id), citations)}` : "\nNo pending recommendation for this trip.";
  const issueText = issue ? `\nLatest issue at ${fmt(issue.occurred_at)}: ${issue.message}` : "";
  return `${trip.code} is ${trip.kind} and ${trip.status.replaceAll("_", " ")}, ${timing}, ${eta}. ${place(trip.originSiteId)} to ${place(trip.destinationSiteId)}. ${driver}. ${vehicle}.${recText}${issueText}`;
}

function describeAppointment(id: string, citations: CopilotCitation[]): string {
  const appt = getAppointment(id);
  citations.push({ kind: "appointment", id: appt.id, label: appt.code });
  const trip = appt.tripId ? tripCode(appt.tripId) : "no trip";
  const dock = appt.locationCode ? `dock ${appt.locationCode}` : "no dock";
  return `${appt.code} is ${appt.status.replaceAll("_", " ")} for ${appt.purpose}. Plate ${appt.plate}, ${dock}, ${fmt(appt.windowStart)} to ${fmt(appt.windowEnd)}. ${trip}. ${appt.carrier ? `Carrier ${appt.carrier}.` : ""}`.trim();
}

function describeVehicle(id: string, citations: CopilotCitation[]): string {
  const vehicle = listVehicles().find((item) => item.id === id);
  if (!vehicle) return "That vehicle is not in the record.";
  citations.push({ kind: "vehicle", id: vehicle.id, label: vehicle.code });
  const trip = one<{ id: string; code: string; status: string }>(
    `SELECT id, code, status FROM trips
     WHERE (vehicle_id = ? OR trailer_id = ?) AND status IN ('planned','dispatched','in_transit','arrived')
     ORDER BY planned_departure LIMIT 1`,
    [vehicle.id, vehicle.id],
  );
  const visit = one<{ id: string; status: string; plate: string }>(
    "SELECT id, status, plate FROM gate_visits WHERE vehicle_id = ? AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1",
    [vehicle.id],
  );
  const maint = one<{ description: string }>(
    "SELECT description FROM maintenance_records WHERE vehicle_id = ? AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
    [vehicle.id],
  );
  if (trip) citations.push({ kind: "trip", id: trip.id, label: trip.code });
  if (visit) citations.push({ kind: "visit", id: visit.id, label: visit.plate });
  const tripText = trip ? `On ${trip.code} (${trip.status.replaceAll("_", " ")}).` : "Not on an active trip.";
  const visitText = visit ? ` Gate visit is ${visit.status.replaceAll("_", " ")}.` : "";
  const maintText = maint ? ` Open maintenance: ${maint.description}.` : "";
  return `${vehicle.code} plate ${vehicle.plate} is a ${vehicle.kind}, status ${vehicle.status.replaceAll("_", " ")}. ${tripText}${visitText}${maintText}`;
}

function describeDriver(id: string, citations: CopilotCitation[], now: number): string {
  const driver = listDrivers().find((item) => item.id === id);
  if (!driver) return "That driver is not in the record.";
  citations.push({ kind: "driver", id: driver.id, label: driver.name });
  const trip = one<{ id: string; code: string; status: string }>(
    `SELECT id, code, status FROM trips
     WHERE driver_id = ? AND status IN ('planned','dispatched','in_transit','arrived')
     ORDER BY planned_departure LIMIT 1`,
    [driver.id],
  );
  if (trip) citations.push({ kind: "trip", id: trip.id, label: trip.code });
  const days = Math.round((Date.parse(driver.licenseExpiry) - now) / 86_400_000);
  const license = !Number.isFinite(days)
    ? `License ${driver.licenseExpiry}`
    : days < 0
      ? `License expired ${driver.licenseExpiry.slice(0, 10)}`
      : `License class ${driver.licenseClass} is valid through ${driver.licenseExpiry.slice(0, 10)}`;
  const tripText = trip ? `On ${trip.code}, ${trip.status.replaceAll("_", " ")}.` : "Not assigned to an active trip.";
  const phone = driver.phone ? ` Phone ${driver.phone}.` : "";
  return `${driver.name} (${driver.code}) is ${driver.status.replaceAll("_", " ")}. ${license}. ${tripText}${phone}`;
}

function describeOrder(id: string, citations: CopilotCitation[]): string {
  const order = one<{ id: string; code: string; status: string; due_at: string; customer: string; remaining: number | null }>(
    `SELECT o.id, o.code, o.status, o.due_at, c.name AS customer,
            (SELECT SUM(qty - picked_qty) FROM order_lines WHERE order_id = o.id) AS remaining
     FROM orders o JOIN sites c ON c.id = o.customer_site_id WHERE o.id = ?`,
    [id],
  );
  if (!order) return "That order is not in the record.";
  citations.push({ kind: "order", id: order.id, label: order.code });
  const picks = count("SELECT COUNT(*) FROM pick_tasks WHERE order_id = ? AND status = 'open'", [order.id]);
  return `${order.code} is ${order.status} for ${order.customer}, due ${fmt(order.due_at)}. ${order.remaining ?? 0} units still to pick. ${picks} open pick task${picks === 1 ? "" : "s"}.`;
}

function describeShipment(id: string, citations: CopilotCitation[]): string {
  const row = one<{ id: string; code: string; status: string; trip_code: string | null; dock: string | null }>(
    `SELECT sh.id, sh.code, sh.status, t.code AS trip_code, l.code AS dock
     FROM shipments sh
     LEFT JOIN trips t ON t.id = sh.trip_id
     LEFT JOIN locations l ON l.id = sh.dock_location_id
     WHERE sh.id = ?`,
    [id],
  );
  if (!row) return "That shipment is not in the record.";
  citations.push({ kind: "shipment", id: row.id, label: row.code });
  return `${row.code} is ${row.status}. ${row.trip_code ? `Trip ${row.trip_code}.` : "No trip."} ${row.dock ? `Dock ${row.dock}.` : "No dock."}`;
}

function describeReceipt(id: string, citations: CopilotCitation[]): string {
  const row = one<{ id: string; code: string; status: string; supplier: string; trip_code: string | null }>(
    `SELECT r.id, r.code, r.status, r.supplier, t.code AS trip_code
     FROM inbound_receipts r LEFT JOIN trips t ON t.id = r.trip_id WHERE r.id = ?`,
    [id],
  );
  if (!row) return "That receipt is not in the record.";
  citations.push({ kind: "receipt", id: row.id, label: row.code });
  return `${row.code} is ${row.status}${row.supplier ? ` from ${row.supplier}` : ""}. ${row.trip_code ? `Trip ${row.trip_code}.` : "No trip."}`;
}

function describeUnit(id: string, citations: CopilotCitation[]): string {
  const row = one<{ id: string; code: string; status: string; qty: number; sku: string; loc: string | null; expiry: string | null; lot: string | null }>(
    `SELECT hu.id, hu.code, hu.status, hu.qty, s.code AS sku, l.code AS loc, hu.expiry_date AS expiry, hu.lot_number AS lot
     FROM handling_units hu
     JOIN skus s ON s.id = hu.sku_id
     LEFT JOIN locations l ON l.id = hu.location_id
     WHERE hu.id = ?`,
    [id],
  );
  if (!row) return "That handling unit is not in the record.";
  citations.push({ kind: "handling_unit", id: row.id, label: row.code });
  const where = row.loc ? `at ${row.loc}` : "with no location";
  const lot = row.lot ? ` Lot ${row.lot}.` : "";
  const expiry = row.expiry ? ` Expires ${row.expiry.slice(0, 10)}.` : "";
  return `${row.code} is ${row.status}, ${row.qty} of ${row.sku}, ${where}.${lot}${expiry}`;
}

function describeLocation(id: string, citations: CopilotCitation[]): string {
  const loc = one<{ id: string; code: string; kind: string; active: number; site_code: string; site_name: string }>(
    `SELECT l.id, l.code, l.kind, l.active, s.code AS site_code, s.name AS site_name
     FROM locations l JOIN sites s ON s.id = l.site_id WHERE l.id = ?`,
    [id],
  );
  if (!loc) return "That location is not in the record.";
  citations.push({ kind: "location", id: loc.id, label: `${loc.code} ${loc.site_code}` });
  const visit = one<{ id: string; plate: string; purpose: string }>(
    `SELECT gv.id, gv.plate, da.purpose
     FROM dock_assignments da
     JOIN gate_visits gv ON gv.id = da.visit_id
     WHERE da.location_id = ? AND da.released_at IS NULL AND gv.check_out_at IS NULL
     LIMIT 1`,
    [loc.id],
  );
  const parked = one<{ id: string; plate: string }>(
    "SELECT id, plate FROM gate_visits WHERE yard_location_id = ? AND check_out_at IS NULL LIMIT 1",
    [loc.id],
  );
  const stock = count("SELECT COALESCE(SUM(qty), 0) FROM inventory WHERE location_id = ?", [loc.id]);
  const next = one<{ code: string; window_start: string; plate: string }>(
    `SELECT code, window_start, plate FROM dock_appointments
     WHERE location_id = ? AND status IN ('scheduled','checked_in') AND window_end > ?
     ORDER BY window_start LIMIT 1`,
    [loc.id, new Date().toISOString()],
  );
  const bits = [`${loc.code} is a ${loc.kind.replaceAll("_", " ")} at ${loc.site_name} (${loc.site_code})${loc.active ? "" : ", inactive"}.`];
  if (visit) {
    citations.push({ kind: "visit", id: visit.id, label: visit.plate });
    bits.push(`Occupied for ${visit.purpose} by ${visit.plate}.`);
  } else if (loc.kind === "dock_door") bits.push("No truck is assigned.");
  if (parked) {
    citations.push({ kind: "visit", id: parked.id, label: parked.plate });
    bits.push(`${parked.plate} is parked here.`);
  }
  if (stock) bits.push(`${stock} units on hand.`);
  if (next) bits.push(`Next appointment ${next.code} for ${next.plate} at ${fmt(next.window_start)}.`);
  return bits.join(" ");
}

function describeSku(id: string, citations: CopilotCitation[]): string {
  const sku = one<{ id: string; code: string; name: string; category: string }>("SELECT id, code, name, category FROM skus WHERE id = ?", [id]);
  if (!sku) return "That SKU is not in the record.";
  citations.push({ kind: "sku", id: sku.id, label: sku.code });
  const rows = many<{ code: string; site_code: string; qty: number }>(
    `SELECT l.code, s.code AS site_code, SUM(i.qty) AS qty
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     JOIN sites s ON s.id = i.site_id
     WHERE i.sku_id = ?
     GROUP BY l.id
     ORDER BY qty DESC
     LIMIT 5`,
    [sku.id],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.qty), 0);
  if (!rows.length) return `${sku.code} ${sku.name} (${sku.category}) has no on-hand quantity.`;
  const places = rows.map((row) => `${row.qty} at ${row.code} (${row.site_code})`).join(", ");
  return `${sku.code} ${sku.name} (${sku.category}): ${total} on hand. ${places}.`;
}

function expiryLines(site: SiteScope | null, citations: CopilotCitation[]): string {
  const rows = many<{ id: string; code: string; expiry: string; sku: string; loc: string | null }>(
    `SELECT hu.id, hu.code, hu.expiry_date AS expiry, s.code AS sku, l.code AS loc
     FROM handling_units hu
     JOIN skus s ON s.id = hu.sku_id
     LEFT JOIN locations l ON l.id = hu.location_id
     WHERE hu.expiry_date IS NOT NULL AND hu.status IN ('received','sorted','stored')
       ${site ? "AND hu.site_id = ?" : ""}
     ORDER BY hu.expiry_date
     LIMIT 5`,
    site ? [site.id] : [],
  );
  if (!rows.length) return "No stored handling unit has an expiry date.";
  return rows
    .map((row) => {
      citations.push({ kind: "handling_unit", id: row.id, label: row.code });
      return `- ${row.code} ${row.sku} expires ${row.expiry.slice(0, 10)}${row.loc ? ` at ${row.loc}` : ""}.`;
    })
    .join("\n");
}

function stockLeaders(site: SiteScope | null, citations: CopilotCitation[]): string {
  const rows = many<{ id: string; code: string; qty: number }>(
    `SELECT s.id, s.code, SUM(i.qty) AS qty
     FROM inventory i JOIN skus s ON s.id = i.sku_id
     ${site ? "WHERE i.site_id = ?" : ""}
     GROUP BY s.id
     ORDER BY qty DESC
     LIMIT 5`,
    site ? [site.id] : [],
  );
  if (!rows.length) return "No inventory is on hand.";
  return `Largest on-hand quantities: ${rows
    .map((row) => {
      citations.push({ kind: "sku", id: row.id, label: row.code });
      return `${row.code} ${row.qty}`;
    })
    .join(", ")}.`;
}

function resolveHits(question: string): { hits: Hit[]; unmatched: string[] } {
  const hits: Hit[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  const push = (hit: Hit) => {
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };
  const tokens = [...question.matchAll(new RegExp(TOKEN_RE.source, "gi"))].map((match) => match[0]);
  for (const token of tokens) {
    const before = hits.length;
    pushHitsForToken(token, push);
    if (hits.length === before && /\d/.test(token)) unmatched.push(token);
  }
  for (const driver of many<{ id: string; name: string }>("SELECT id, name FROM drivers")) {
    if (question.toLowerCase().includes(driver.name.toLowerCase())) push({ kind: "driver", id: driver.id });
  }
  const compactQ = question.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compactQ.length >= 6) {
    for (const vehicle of many<{ id: string; plate: string }>("SELECT id, plate FROM vehicles")) {
      const plate = vehicle.plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (plate.length >= 6 && compactQ.includes(plate)) push({ kind: "vehicle", id: vehicle.id });
    }
  }
  return { hits, unmatched };
}

function pushHitsForToken(token: string, push: (hit: Hit) => void) {
  const exact = (sql: string, kind: HitKind) => {
    for (const row of many<{ id: string }>(sql, [token])) push({ kind, id: row.id });
  };
  exact("SELECT id FROM trips WHERE upper(code) = upper(?)", "trip");
  exact("SELECT id FROM dock_appointments WHERE upper(code) = upper(?)", "appointment");
  exact("SELECT id FROM vehicles WHERE upper(code) = upper(?)", "vehicle");
  exact("SELECT id FROM drivers WHERE upper(code) = upper(?)", "driver");
  exact("SELECT id FROM orders WHERE upper(code) = upper(?)", "order");
  exact("SELECT id FROM shipments WHERE upper(code) = upper(?)", "shipment");
  exact("SELECT id FROM inbound_receipts WHERE upper(code) = upper(?)", "receipt");
  exact("SELECT id FROM handling_units WHERE upper(code) = upper(?)", "handling_unit");
  exact("SELECT id FROM locations WHERE upper(code) = upper(?)", "location");
  exact("SELECT id FROM skus WHERE upper(code) = upper(?)", "sku");
  exact("SELECT id FROM copilot_recommendations WHERE id = ?", "recommendation");
}

function loadSite(id: string | null | undefined): { site: SiteScope | null; missing: boolean } {
  if (!id) return { site: null, missing: false };
  const site = one<SiteScope>("SELECT id, code, name FROM sites WHERE id = ? OR upper(code) = upper(?)", [id, id]);
  return site ? { site, missing: false } : { site: null, missing: true };
}

function siteMentioned(question: string): SiteScope | null {
  const sites = many<SiteScope>("SELECT id, code, name FROM sites");
  return sites.find((site) => new RegExp(`\\b${site.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question)) ?? null;
}

function scopePhrase(site: SiteScope | null): string {
  return site ? `at ${site.name} (${site.code})` : "across sites";
}

function scopeLead(site: SiteScope | null): string {
  return site ? `${site.name} (${site.code}):` : "Across sites:";
}

function place(siteId: string): string {
  const site = one<{ code: string }>("SELECT code FROM sites WHERE id = ?", [siteId]);
  return site?.code ?? siteId;
}

function driverLabel(id: string): string {
  const driver = one<{ name: string; code: string }>("SELECT name, code FROM drivers WHERE id = ?", [id]);
  return driver ? `${driver.name} (${driver.code})` : "driver not recorded";
}

function vehicleLabel(id: string): string {
  const vehicle = one<{ code: string; plate: string }>("SELECT code, plate FROM vehicles WHERE id = ?", [id]);
  return vehicle ? `${vehicle.code} plate ${vehicle.plate}` : "vehicle not recorded";
}

function tripCode(id: string): string {
  const trip = one<{ code: string }>("SELECT code FROM trips WHERE id = ?", [id]);
  return trip ? `Trip ${trip.code}` : "Trip not recorded";
}

function count(sql: string, params: unknown[]): number {
  return Number(scalar<number>(sql, params) ?? 0);
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "not set";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function age(iso: string, now: number): string {
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return fmt(iso);
  if (Math.abs(mins) < 1) return "just now";
  return mins > 0 ? `${mins} minutes ago` : `in ${-mins} minutes`;
}

function dedupe(citations: CopilotCitation[]): CopilotCitation[] {
  const seen = new Set<string>();
  const unique: CopilotCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}
