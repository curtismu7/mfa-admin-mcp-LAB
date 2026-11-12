import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App.jsx";
import { conn, fakeApi, LIVE_REFUSED, TOOLS } from "./test-helpers.js";

beforeEach(() => { window.location.hash = ""; try { localStorage.clear(); } catch { /* none */ } delete document.documentElement.dataset.present; });
const pressLive = async (user) => { await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false)); await user.selectOptions(screen.getByTestId("mode-select"), "real"); };
const live = () => { try { localStorage.setItem("p1mcp.mode", "live"); } catch { /* none */ } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const go = (h) => { window.location.hash = h; window.dispatchEvent(new HashChangeEvent("hashchange")); };

test("skip link, nav, banner states: Live names the real server, writes enabled is a red alert", async () => {
  fakeApi({ conns: [conn({ offline: false, label: "Prod tenant", allowWrites: true })] });
  render(<App />);
  await pressLive(userEvent.setup());
  expect(screen.getByText("Skip to content")).toHaveAttribute("href", "#main");
  const banner = await screen.findByTestId("banner");
  await waitFor(() => expect(within(banner).getByText(/^LIVE mode, owner-run/)).toBeInTheDocument());
  expect(banner).toHaveTextContent(/In use: Prod tenant/);
  expect(within(banner).getByRole("alert")).toHaveTextContent(/WRITES ARE ENABLED/);
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
});

test("Mock is the default: the banner and the mode chip say Mock, and the banner says what is simulated", async () => {
  fakeApi();
  render(<App />);
  const banner = await screen.findByTestId("banner");
  expect(banner).toHaveTextContent(/^MOCK mode, simulated/);
  expect(banner).toHaveTextContent(/not a recording/);
  expect(banner).toHaveTextContent(/Nothing leaves this machine/);
  expect(banner).toHaveTextContent(/Writes are off/);
  expect(within(banner).queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
  expect(screen.getByTestId("mode-select")).toHaveValue("mock");
  expect(screen.getByTestId("mode-select")).toHaveValue("mock");
  expect(banner.querySelector(".banner")).toHaveAttribute("data-state", "mock");
});

test("the Mock / Live toggle is in the header of every page, and the banner and chip follow it", async () => {
  fakeApi({ conns: [conn(), conn({ id: "c9", offline: false, label: "A real server", kind: "custom", url: "http://127.0.0.1:9/mcp" })] });
  const user = userEvent.setup();
  render(<App />);
  for (const page of ["connections", "tools", "raw", "audit", "mcp-first", "stories", "diagram"]) {
    go(`#/${page}`);
    expect(await screen.findByTestId("mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(screen.getByTestId("banner")).toHaveTextContent(/^MOCK mode/);
  }
  go("#/connections");
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false));
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
  expect(screen.getByTestId("banner")).toHaveTextContent(/^LIVE mode/);
  expect(screen.getByTestId("banner").querySelector(".banner")).toHaveAttribute("data-state", "live");
  for (const page of ["tools", "raw", "audit", "diagram"]) {
    go(`#/${page}`);
    await screen.findByTestId("mode-select");
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
  }
  expect(localStorage.getItem("p1mcp.mode")).toBeNull(); // the mode is never stored
});

test("the page always opens in Mock: after pressing Live, a reload is in Mock again, and a stale stored 'live' is ignored while Live is allowed", async () => {
  fakeApi({ conns: [conn()] });
  const user = userEvent.setup();
  const first = render(<App />);
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false));
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
  first.unmount();
  live(); // what an older build left behind in the browser
  fakeApi({ conns: [conn()] });
  render(<App />);
  await screen.findByTestId("banner");
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false)); // /api/info has answered: Live is allowed
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
  expect(screen.getByTestId("banner")).toHaveTextContent(/^MOCK mode/);
});

test("the toggle decides which connections are shown: the mock demo in Mock, the real servers in Live", async () => {
  fakeApi({ conns: [conn({ label: "Mock demo one" }), conn({ id: "c9", offline: false, label: "A real server", kind: "custom", url: "http://127.0.0.1:9/mcp" })] });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByText("Mock demo one")).toBeInTheDocument();
  expect(screen.queryByText("A real server")).toBeNull();
  expect(screen.getByRole("button", { name: /Add mock demo \(worker/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false));
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  expect(await screen.findByText("A real server")).toBeInTheDocument();
  expect(screen.queryByText("Mock demo one")).toBeNull();
  expect(screen.queryByRole("button", { name: /Add mock demo \(worker/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Save connection" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add banking MCP" })).toBeInTheDocument();
});

test("Live is refused when the server says a guard fails: the page stays in Mock, says why, and nothing is sent", async () => {
  const api = fakeApi({ live: LIVE_REFUSED });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/info")).toBe(true));
  expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(true); // Real is unavailable: the option is off
  expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').getAttribute("title")).toMatch(/owner-opt-in/); // with the how-to tooltip
  expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
  expect(screen.getByTestId("banner")).toHaveTextContent(/^MOCK mode/);
  expect(api.calls.filter((c) => c.method === "POST" && !/\/test$/.test(c.url))).toEqual([]); // only the mock demo's own test, no Live call
  expect(screen.queryByTestId("refusal")).toBeNull();
});

test("Reset calls the server, clears the page state and keeps the saved connections", async () => {
  const api = fakeApi();
  const user = userEvent.setup();
  go("#/diagram");
  render(<App />);
  await user.selectOptions(await screen.findByLabelText("Speed"), "4");
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 5/);
  await user.click(screen.getByTestId("reset"));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/reset")).toBe(true));
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/));
  expect(screen.getByLabelText("Speed")).toHaveValue("1");
  await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent(/Reset: .*Saved connections kept/));
});

test("health card: count, role hint, identity and expiry countdown; no token anywhere", async () => {
  fakeApi();
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("tool-count")).toHaveTextContent("6"));
  const card = screen.getByTestId("health-card");
  expect(card).toHaveTextContent(/short list usually means missing admin roles/);
  expect(screen.getByTestId("identity")).toHaveTextContent("worker token set");
  expect(screen.getByTestId("expiry")).toHaveTextContent(/\dm \d\ds/);
  expect(document.body.textContent).not.toMatch(/mock-at-|Bearer /);
});

test("wizard: secret is write-only, cleared after saving, and the card shows set", async () => {
  const api = fakeApi({ conns: [] });
  render(<App />);
  const user = userEvent.setup();
  await pressLive(user);
  await user.type(await screen.findByLabelText(/Environment id/), "11111111-2222-4333-8444-555555555555");
  await user.type(screen.getByLabelText("Client id"), "my-worker");
  const secret = screen.getByLabelText(/Client secret/);
  expect(secret).toHaveAttribute("type", "password");
  await user.type(secret, "super-secret-value");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/connections" && c.body.clientSecret === "super-secret-value")).toBe(true));
  await waitFor(() => expect(screen.getByLabelText(/Client secret/)).toHaveValue(""));
  expect(document.body.innerHTML).not.toContain("super-secret-value");
  expect(await screen.findByText(/secret: set/)).toBeInTheDocument();
});

test("interactive wizard shows the exact redirect URI with a working Copy button", async () => {
  fakeApi({ conns: [] });
  const writeText = vi.fn(() => Promise.resolve());
  render(<App />);
  const user = userEvent.setup();
  await pressLive(user);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await user.click(await screen.findByLabelText(/Interactive admin sign-in/));
  const uri = screen.getByTestId("redirect-uri").textContent;
  expect(uri).toMatch(/^http:\/\/localhost:\d*\/api\/oauth\/callback$|^http:\/\/localhost:80\/api\/oauth\/callback$/);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(uri);
  expect(screen.getByTestId("redirect-box")).toHaveTextContent(/UNVERIFIED/);
  expect(screen.queryByLabelText(/Client secret/)).toBeNull();
});

test("mock demo button creates a worker connection with the viewer role", async () => {
  const api = fakeApi({ conns: [] });
  render(<App />);
  await userEvent.setup().click(await screen.findByRole("button", { name: /Add mock demo \(worker/ }));
  await waitFor(() => expect(api.calls.find((c) => c.method === "POST" && c.url === "/api/connections").body).toMatchObject({ offline: true, clientId: "viewer-demo", auth: "worker" }));
});

test("tools explorer: groups, search, badges with the why, writes-off state; server text is inert", async () => {
  fakeApi();
  go("#/tools");
  render(<App />);
  expect(await screen.findByRole("heading", { name: /^Users/ })).toBeInTheDocument();
  for (const g of ["Applications", "DaVinci", "Other"]) expect(screen.getByRole("heading", { name: new RegExp(`^${g}`) })).toBeInTheDocument();
  expect(screen.getByTestId("writes-off")).toBeInTheDocument();
  expect(screen.getAllByText("blocked: writes off").length).toBe(3);
  expect(screen.getAllByTestId("class-badge").find((b) => b.textContent === "destructive")).toHaveAttribute("title", expect.stringMatching(/annotation/));
  expect(screen.getByText(/unknown verb in the name, so treated as a write/)).toBeInTheDocument();
  // inert: markup in a description is text, not an element
  expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  await userEvent.setup().type(screen.getByLabelText("Search"), "flows");
  expect(screen.queryByRole("heading", { name: /^Users/ })).toBeNull();
  expect(screen.getByRole("heading", { name: /^DaVinci/ })).toBeInTheDocument();
});

test("tool page: environmentId prefilled, JSON/Form toggle, snake_case warning, read runs directly", async () => {
  const api = fakeApi({ handlers: { "POST /api/connections/:id/call": (b, s, json) => json(200, { class: "read", warnings: [], result: { content: [{ type: "text", text: "<b>two users</b>" }] } }) } });
  go("#/tool/listUsers");
  render(<App />);
  const user = userEvent.setup();
  const env = await screen.findByLabelText(/environmentId/);
  expect(env).toHaveValue("11111111-2222-4333-8444-555555555555");
  await user.click(screen.getByRole("button", { name: "JSON" }));
  const ta = screen.getByLabelText(/Arguments \(JSON object\)/);
  expect(ta.value).toContain("environmentId");
  fireEvent.change(ta, { target: { value: '{"environment_id":"x"}' } });
  expect(screen.getByTestId("warnings")).toHaveTextContent(/snake_case.*environmentId/);
  fireEvent.change(ta, { target: { value: "{bad" } });
  await user.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/Fix the JSON/);
  fireEvent.change(ta, { target: { value: '{"environmentId":"e1","filter":"a"}' } });
  await user.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByLabelText(/^filter/)).toHaveValue("a");
  await user.click(screen.getByRole("button", { name: "Call" }));
  const view = await screen.findByTestId("call-view");
  expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(1);
  expect(view).toHaveTextContent(/"method": "tools\/call"/);
  expect(view).toHaveTextContent("<b>two users</b>"); // shown as text
  expect(view.querySelector("b")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a blocked write shows why and sends exactly one call", async () => {
  const api = fakeApi({ handlers: { "POST /api/connections/:id/call": (b, s, json) => json(403, { error: "writes_disabled", message: '"createUser" is a write tool. Turn on "allow writes".', class: "write", warnings: [] }) } });
  go("#/tool/createUser");
  render(<App />);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Call" }));
  expect(await screen.findByRole("heading", { name: /Blocked: writes are off/ })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(1);
});

test("an enabled write opens the confirm dialog with exact arguments and hash, then resends with confirm", async () => {
  let n = 0;
  const api = fakeApi({ conns: [conn({ allowWrites: true })], handlers: { "POST /api/connections/:id/call": (b, s, json) => (++n === 1
    ? json(409, { error: "confirm_required", argsHash: "abc123hash", arguments: b.arguments, requiresTypedName: false })
    : json(200, { class: "write", warnings: [], result: { ok: true } })) } });
  go("#/tool/createUser");
  render(<App />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^username/), "pat");
  await user.click(screen.getByRole("button", { name: "Call" }));
  const dlg = await screen.findByRole("dialog");
  expect(within(dlg).getByTestId("confirm-args")).toHaveTextContent('"username": "pat"');
  expect(within(dlg).getByTestId("confirm-hash")).toHaveTextContent("abc123hash");
  await user.click(within(dlg).getByRole("button", { name: /Confirm and send/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const second = api.calls.filter((c) => c.url.endsWith("/call"))[1].body;
  expect(second).toMatchObject({ confirm: true, argsHash: "abc123hash", tool: "createUser" });
  expect(await screen.findByTestId("call-view")).toHaveTextContent(/"ok": true/);
});

test("a destructive confirm needs the tool name typed; Cancel and Escape send nothing", async () => {
  const api = fakeApi({ conns: [conn({ allowWrites: true })], handlers: { "POST /api/connections/:id/call": (b, s, json) => (!b.confirm
    ? json(409, { error: "confirm_required", argsHash: "h1", arguments: b.arguments, requiresTypedName: true })
    : json(200, { class: "destructive", warnings: [], result: { deleted: "u1" } })) } });
  go("#/tool/deleteUser");
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Call" }));
  let dlg = await screen.findByRole("dialog");
  const go2 = within(dlg).getByRole("button", { name: /Delete: confirm/ });
  expect(go2).toBeDisabled();
  await user.type(within(dlg).getByLabelText(/Type/), "deleteUse");
  expect(go2).toBeDisabled();
  await user.type(within(dlg).getByLabelText(/Type/), "r");
  expect(go2).toBeEnabled();
  fireEvent.keyDown(dlg, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Call" }));
  dlg = await screen.findByRole("dialog");
  await user.type(within(dlg).getByLabelText(/Type/), "deleteUser");
  await user.click(within(dlg).getByRole("button", { name: /Delete: confirm/ }));
  await waitFor(() => expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(3));
  expect(api.calls.filter((c) => c.url.endsWith("/call"))[2].body).toMatchObject({ confirm: true, argsHash: "h1", typedName: "deleteUser" });
});

test("a tool the identity does not see is explained, not a blank page", async () => {
  fakeApi();
  go("#/tool/nopeTool");
  render(<App />);
  expect(await screen.findByText(/does not see a tool called/)).toBeInTheDocument();
});

test("audit page lists every call, redacted, as text", async () => {
  fakeApi({ audit: [{ at: "2026-01-01T00:00:00Z", connection: "Mock demo", tool: "createUser", class: "write", outcome: "blocked:writes_disabled", argsHash: "deadbeefdeadbeef", args: { username: "<script>x</script>", clientSecret: "[redacted]" } }] });
  go("#/audit");
  render(<App />);
  const row = await screen.findByTestId("audit-row");
  expect(row).toHaveTextContent("blocked:writes_disabled");
  expect(row).toHaveTextContent("[redacted]");
  expect(row).toHaveTextContent("<script>x</script>");
  expect(document.querySelector("script:not([src])")).toBeNull();
});

test("raw console: a free method runs; tools/call goes through the confirm gate", async () => {
  let rpc = 0;
  const api = fakeApi({ conns: [conn({ allowWrites: true })], handlers: { "POST /api/connections/:id/rpc": (b, s, json) => (b.method === "tools/list" ? json(200, { result: { tools: [] } }) : ++rpc === 1 ? json(409, { error: "confirm_required", argsHash: "rh", arguments: { x: 1 }, requiresTypedName: false }) : json(200, { class: "write", result: { ok: 1 } })) } });
  go("#/raw");
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Send" }));
  expect(await screen.findByTestId("call-view")).toHaveTextContent('"tools"');
  fireEvent.change(screen.getByLabelText(/^Method/), { target: { value: "tools/call" } });
  fireEvent.change(screen.getByLabelText(/Params/), { target: { value: '{"name":"createUser","arguments":{"x":1}}' } });
  await user.click(screen.getByRole("button", { name: "Send" }));
  const dlg = await screen.findByRole("dialog");
  await user.click(within(dlg).getByRole("button", { name: /Confirm and send/ }));
  await waitFor(() => expect(api.calls.filter((c) => c.url.endsWith("/rpc")).at(-1).body).toMatchObject({ method: "tools/call", confirm: true, argsHash: "rh" }));
});

test("MCP-first card says its source and that it is UNVERIFIED, and names the fallbacks", async () => {
  fakeApi();
  go("#/mcp-first");
  render(<App />);
  expect(await screen.findByText(/UNVERIFIED externally/)).toBeInTheDocument();
  for (const t of [/createEnvironment/, /Resource servers and scopes/, /Application grants/, /fall back to the direct Management API/]) expect(screen.getByText(t)).toBeInTheDocument();
});

test("stories page: both talk tracks, vertical switch re-skins, Blocked path shows", async () => {
  fakeApi();
  go("#/stories");
  render(<App />);
  expect(await screen.findByText("Why do I only see twelve tools?")).toBeInTheDocument();
  expect(screen.getByText("A write needs a second look")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.selectOptions(screen.getAllByLabelText("Vertical")[0], "banking");
  expect(screen.getAllByText(/the bank/).length).toBeGreaterThan(0);
  await user.click(screen.getAllByRole("button", { name: "Blocked" })[1]);
  expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
});

test("diagram: Simulate walks steps with a live caption, Reset restores; speed control and presenter toggle exist", async () => {
  fakeApi();
  go("#/diagram");
  render(<App />);
  const user = userEvent.setup();
  expect(await screen.findByTestId("caption")).toHaveTextContent(/Press Simulate/);
  expect(screen.getByTestId("caption")).toHaveAttribute("aria-live", "polite");
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled()); // the diagram is fetched by name first
  expect(await screen.findByText("Hosted PingOne MCP server")).toBeInTheDocument(); // a box drawn from the fetched data
  await user.selectOptions(screen.getByLabelText("Speed"), "4");
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 5/);
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Step 5 of 5/), { timeout: 4000 });
  expect(screen.getByTestId("caption")).toHaveTextContent(/UNVERIFIED that the hosted server accepts a worker token/);
  const diagMain = screen.getByRole("main");
  await user.click(within(diagMain).getByRole("button", { name: "Reset" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
  await waitFor(() => expect(screen.getByRole("option", { name: "Interactive admin sign-in (code + PKCE)" })).toBeInTheDocument());
  await user.selectOptions(screen.getByLabelText("Sign-in model"), "interactive");
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 7/);
  await user.click(screen.getByTestId("presenter"));
  expect(document.documentElement.dataset.present).toBe("1");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.documentElement.dataset.present).toBeUndefined();
});

test("theme select forces a theme", async () => {
  fakeApi();
  render(<App />);
  await userEvent.setup().selectOptions(await screen.findByLabelText("Theme"), "dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});
