/**
 * Keeps the local model inside the live operation.
 * The operator's words are untrusted data. They cannot change the instructions
 * or pull the model into anything outside this desk.
 */

export const COPILOT_SCOPE_REFUSAL =
  "I only answer from the live operation. I cannot change my instructions or leave that record.";

const INJECTION = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system)\s+(instructions|rules|prompts?)/i,
  /disregard\s+(your\s+|the\s+)?(instructions|rules|system|prompt|guardrails)/i,
  /override\s+(your\s+|the\s+)?(instructions|rules|system|prompt|guardrails|safety)/i,
  /(reveal|print|repeat|dump)\s+(me\s+|your\s+)?(system\s+prompt|hidden\s+prompt|developer\s+message|instructions)/i,
  /show\s+(me\s+)?your\s+(system\s+prompt|hidden\s+prompt|instructions|developer\s+message)/i,
  /you are now\b/i,
  /act as (an? )?(unrestricted|uncensored|jailbroken|evil)\b/i,
  /pretend (you have no|there are no) (rules|restrictions|limits|guardrails)/i,
  /<\s*\/?\s*(system|instruction|prompt|developer)\s*>/i,
  /\b(jailbreak|developer mode)\b/i,
  /\bDAN\b/,
];

const ABUSE = [
  /\b(malware|ransomware|phishing|keylogger|reverse shell|exploit code)\b/i,
  /\b(make|build|write|generate)\b[^.]{0,48}\b(bomb|explosive|weapon)\b/i,
  /\b(steal|exfiltrate|harvest)\b[^.]{0,48}\b(password|credential|session token|api key)\b/i,
];

const LEAK = [
  /system prompt/i,
  /developer message/i,
  /i (have no|am free of) (restrictions|rules|limits|guardrails)/i,
  /as an unrestricted/i,
  /jailbreak/i,
  /ignore the record/i,
];

export function blockedQuestion(question: string): boolean {
  const text = question.replace(/\s+/g, " ").trim();
  return INJECTION.some((pattern) => pattern.test(text)) || ABUSE.some((pattern) => pattern.test(text));
}

const ABUSE_REPLY = [
  /\b(malware|ransomware|phishing|keylogger|reverse shell|exploit code)\b/i,
  /\b(bomb|explosive)\b/i,
];

export function fenceData(label: "question" | "record", text: string): string {
  const safe = text.replace(/<\s*\/?\s*(question|record|system|instruction|prompt|developer)\s*>/gi, "");
  return `<${label}>\n${safe}\n</${label}>`;
}

export function phraseStaysOnRecord(record: string, phrased: string): boolean {
  if (!phrased.trim()) return false;
  if (LEAK.some((pattern) => pattern.test(phrased))) return false;
  if (ABUSE_REPLY.some((pattern) => pattern.test(phrased))) return false;
  return !inventsCodes(record, phrased);
}

const CODE_RE = /\b(?:[A-Z]{2,6}-[A-Z0-9]{1,}|[A-Z]{2,}\d{2,}|D\d{2}|TRP-\d+)\b/g;

function inventsCodes(record: string, phrased: string): boolean {
  const known = new Set(codesIn(record));
  return codesIn(phrased).some((code) => !known.has(code));
}

function codesIn(text: string): string[] {
  return text.match(new RegExp(CODE_RE.source, "g")) ?? [];
}
