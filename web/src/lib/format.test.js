import { expect, test } from "vitest";
import { classWhy, countdown, groupOf, groupTools, redactForDisplay, redirectUriFor, warnArgs } from "./format.js";

const T = (name, area, cls = "read", src = "name") => ({ name, area, class: cls, classSource: src, description: `desc of ${name}` });

test("tools group into the six areas, DaVinci by name", () => {
  expect(groupOf(T("listApplications", "application"))).toBe("Applications");
  expect(groupOf(T("listPopulations", "population"))).toBe("Populations");
  expect(groupOf(T("getUser", "user"))).toBe("Users");
  expect(groupOf(T("listDaVinciFlows", "da"))).toBe("DaVinci");
  expect(groupOf(T("describeEnvironment", "environment"))).toBe("Environment");
  expect(groupOf(T("syncTenantWidgets", "tenant"))).toBe("Other");
});
test("search and class filters", () => {
  const tools = [T("listUsers", "user"), T("deleteUser", "user", "destructive"), T("listApplications", "application")];
  expect(groupTools(tools, "app").Applications).toHaveLength(1);
  expect(groupTools(tools, "", "destructive").Users.map((t) => t.name)).toEqual(["deleteUser"]);
  expect(groupTools(tools, "zzz").Users).toHaveLength(0);
});
test("the why of a class names its source", () => {
  expect(classWhy({ classSource: "annotation" })).toMatch(/annotation/);
  expect(classWhy({ classSource: "unknown" })).toMatch(/treated as a write/);
});
test("snake_case, unknown and missing parameters warn", () => {
  const schema = { properties: { environmentId: {}, userId: {} }, required: ["environmentId"] };
  const w = warnArgs(schema, { environment_id: "x", bogus: 1 });
  expect(w.map((x) => x.kind).sort()).toEqual(["missing", "snake_case", "unknown"]);
  expect(w.find((x) => x.kind === "snake_case").message).toMatch(/environmentId/);
  expect(warnArgs(schema, { environmentId: "e" })).toEqual([]);
});
test("display redaction masks secret-looking argument names, deeply", () => {
  expect(redactForDisplay({ a: 1, clientSecret: "x", n: { password: "y", keep: "z" } })).toEqual({ a: 1, clientSecret: "[redacted]", n: { password: "[redacted]", keep: "z" } });
});
test("countdown and redirect URI", () => {
  expect(countdown(1000 + 125_000, 1000)).toBe("2m 05s");
  expect(countdown(1000, 5000)).toBe("expired");
  expect(redirectUriFor({ port: "5201" })).toBe("http://localhost:5201/api/oauth/callback");
});
