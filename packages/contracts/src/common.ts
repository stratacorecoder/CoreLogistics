import { z } from "zod";

export const IdSchema = z.string().min(1);
/** ISO-8601 timestamp, always UTC (`2026-10-27T08:00:00.000Z`). */
export const IsoDateSchema = z.string().datetime({ offset: true });

export const ErrorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });

export const IdParamsSchema = z.object({ id: IdSchema });

export const EVENT_SOURCES = ["manual", "camera", "rfid", "gps", "system"] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const ZONES = ["A", "B", "C", "H"] as const;
export const ZoneSchema = z.enum(ZONES);
export type Zone = z.infer<typeof ZoneSchema>;

export const ZONE_META: Record<Zone, { label: string; color: string; description: string }> = {
  A: { label: "Ambient", color: "#4f8cff", description: "General dry goods" },
  B: { label: "Bulky", color: "#d7a04a", description: "Oversized and heavy pallets" },
  C: { label: "Cold chain", color: "#3fc1c9", description: "Temperature controlled" },
  H: { label: "Hazmat", color: "#e5534b", description: "Dangerous goods, segregated" },
};
