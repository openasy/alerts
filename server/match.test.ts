import { describe, expect, it } from "vitest";
import { fingerprint, formatMatchers, matches, parseMatchers } from "./match.ts";

describe("matchers", () => {
  const labels = { alertname: "DiskFull", severity: "critical", team: "db" };

  it("match as Alertmanager's do, with anchored regular expressions", () => {
    expect(matches([{ label: "team", op: "=", value: "db" }], labels)).toBe(true);
    expect(matches([{ label: "team", op: "!=", value: "db" }], labels)).toBe(false);
    expect(matches([{ label: "severity", op: "=~", value: "critical|high" }], labels)).toBe(true);
    expect(matches([{ label: "severity", op: "=~", value: "crit" }], labels)).toBe(false);
    expect(matches([{ label: "env", op: "=", value: "" }], labels)).toBe(true);
    expect(matches([{ label: "env", op: "!~", value: "prod.*" }], labels)).toBe(true);
    expect(matches([], labels)).toBe(true);
  });

  it("are checked", () => {
    expect(parseMatchers([{ label: "team", value: "db" }])).toEqual([{ label: "team", op: "=", value: "db" }]);
    expect(() => parseMatchers("team=db")).toThrow(/list/);
    expect(() => parseMatchers([{ label: "a-b", value: "x" }])).toThrow(/label name/);
    expect(() => parseMatchers([{ label: "a", op: "~", value: "x" }])).toThrow(/op is one of/);
    expect(() => parseMatchers([{ label: "a", op: "=~", value: "(" }])).toThrow(/regular expression/);
    expect(formatMatchers([{ label: "team", op: "=~", value: "db|ops" }])).toBe('{team=~"db|ops"}');
  });

  it("give the same fingerprint whatever the order of the labels", () => {
    expect(fingerprint({ a: "1", b: "2" })).toBe(fingerprint({ b: "2", a: "1" }));
    expect(fingerprint({ a: "1" })).not.toBe(fingerprint({ a: "2" }));
  });
});
