// Label matchers, as Alertmanager writes them: name="value", name!="value", name=~"regex", name!~"regex". A regex is
// anchored at both ends, so severity=~"critical|high" matches those two and nothing longer.
import { createHash } from "node:crypto";

export type Labels = Record<string, string>;
export type Op = "=" | "!=" | "=~" | "!~";

export interface Matcher {
  label: string;
  op: Op;
  value: string;
}

const OPS: readonly Op[] = ["=", "!=", "=~", "!~"];
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** The matchers in a body, checked; the message names the first wrong one. */
export function parseMatchers(raw: unknown, field = "matchers"): Matcher[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be a list of { label, op, value }.`);
  if (raw.length > 20) throw new Error(`${field} has at most 20 matchers.`);
  return raw.map((m, i) => {
    const x = m as Partial<Matcher> | null;
    if (!x || typeof x.label !== "string" || !LABEL.test(x.label)) throw new Error(`${field}[${i}].label must be a label name, such as severity.`);
    const op = x.op ?? "=";
    if (!OPS.includes(op)) throw new Error(`${field}[${i}].op is one of ${OPS.join(" ")}.`);
    if (typeof x.value !== "string" || x.value.length > 500) throw new Error(`${field}[${i}].value must be text of at most 500 characters.`);
    if (op === "=~" || op === "!~") {
      try {
        new RegExp(`^(?:${x.value})$`);
      } catch {
        throw new Error(`${field}[${i}].value is not a regular expression.`);
      }
    }
    return { label: x.label, op, value: x.value };
  });
}

/** Whether every matcher holds. A missing label is the empty string, as in Alertmanager. */
export function matches(matchers: Matcher[], labels: Labels): boolean {
  return matchers.every((m) => {
    const v = labels[m.label] ?? "";
    if (m.op === "=") return v === m.value;
    if (m.op === "!=") return v !== m.value;
    const re = new RegExp(`^(?:${m.value})$`);
    return m.op === "=~" ? re.test(v) : !re.test(v);
  });
}

export const formatMatchers = (ms: Matcher[]) => `{${ms.map((m) => `${m.label}${m.op}"${m.value}"`).join(", ")}}`;

/** The same labels always give the same fingerprint, whatever their order. */
export function fingerprint(labels: Labels): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => [k, labels[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}
