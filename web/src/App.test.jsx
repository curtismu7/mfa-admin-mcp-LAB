import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App.jsx";
import { setJsonView } from "./components/JsonPane.jsx";
import { conn, ENV, fakeApi, LIVE_REFUSED, PRESETS, TOOLS } from "./test-helpers.js";

beforeEach(() => { window.location.hash = ""; try { localStorage.clear(); } catch { /* none */ } delete document.documentElement.dataset.present; setJsonView("raw"); });
const pressLive = async (user) => { await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false)); await user.selectOptions(screen.getByTestId("mode-select"), "real"); };
const live = () => { try { localStorage.setItem("mfaadm.mode", "live"); } catch { /* none */ } };
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
  expect(localStorage.getItem("mfaadm.mode")).toBeNull(); // the mode is never stored
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
  expect(screen.getByRole("button", { name: "Add mock demo (sign in)" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false));
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  expect(await screen.findByText("A real server")).toBeInTheDocument();
  expect(screen.queryByText("Mock demo one")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add mock demo (sign in)" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save connection" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Connect to Banking MCP" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /PingOne worker/ })).toBeNull(); // no worker preset: a PingOne connection is a user sign-in
});

test("Working demos: a running server offers Connect, then Use once connected; a stopped one shows its start command; Mock asks nothing", async () => {
  const api = fakeApi({ conns: [conn({ id: "c8", offline: false, label: "Other", kind: "custom", url: "http://127.0.0.1:9/mcp" }), conn({ id: "c9", offline: false, label: "Banking MCP (local)", kind: "custom", url: "http://localhost:8081/mcp" })],
    presets: [{ ...PRESETS[0] }, { ...PRESETS[1] }, { id: "x", name: "Third MCP", folder: "x-LAB", command: "docker compose up -d", url: "http://localhost:9911/mcp", running: true }] });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  expect(api.calls.some((c) => c.url === "/api/presets")).toBe(false); // Mock: no status check
  await waitFor(() => expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(false));
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  const bank = await screen.findByTestId("preset-banking");
  expect(within(bank).getByRole("button", { name: "Use Banking MCP (connected)" })).toBeInTheDocument(); // already saved: Use, not Add
  expect(bank).toHaveTextContent("running at localhost:8081/mcp");
  const os = screen.getByTestId("preset-opensearch");
  expect(os).toHaveTextContent(/OpenSearch MCP is not running at localhost:9900\/mcp\. Start it from your AI-DEMO2 folder/);
  expect(within(os).getByTestId("preset-opensearch-cmd")).toHaveTextContent("docker compose --profile mcpgw up -d opensearch-mcp-server");
  expect(within(os).queryByRole("button", { name: /Connect|Use/ })).toBeNull();
  expect(within(os).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  expect(within(screen.getByTestId("preset-x")).getByRole("button", { name: "Connect to Third MCP" })).toBeInTheDocument();
  await user.click(within(bank).getByRole("button", { name: "Use Banking MCP (connected)" }));
  expect(await within(screen.getByTestId("preset-banking")).findByRole("button", { name: "Banking MCP in use" })).toBeDisabled();
  const before = api.calls.filter((c) => c.url === "/api/presets").length;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/presets").length).toBe(before + 1));
});

test("Live is refused when the server says a guard fails: the page stays in Mock, says why, and nothing is sent", async () => {
  const api = fakeApi({ live: LIVE_REFUSED });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/info")).toBe(true));
  expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').disabled).toBe(true); // Real is unavailable: the option is off
  expect(screen.getByTestId("mode-select").querySelector('option[value="real"]').getAttribute("title")).toMatch(/loopback-bind/); // with the how-to tooltip
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
  expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 7/);
  await user.click(screen.getByTestId("reset"));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/reset")).toBe(true));
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/));
  expect(screen.getByLabelText("Speed")).toHaveValue("1");
  await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent(/Reset: .*Saved connections kept/));
});

test("health card: count, role hint, identity and expiry countdown; no token anywhere", async () => {
  fakeApi();
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("tool-count")).toHaveTextContent("8"));
  const card = screen.getByTestId("health-card");
  expect(card).toHaveTextContent(/short list usually means missing admin roles/);
  expect(screen.getByTestId("identity")).toHaveTextContent("signed in as mock-admin-user");
  expect(screen.getByTestId("expiry")).toHaveTextContent(/\dm \d\ds/);
  expect(document.body.textContent).not.toMatch(/mock-at-|Bearer /);
});

test("wizard: a PingOne connection is a user sign-in with no secret field (the documented mcp-host endpoint by default); a custom server's header value is write-only, cleared after saving, and the card shows set", async () => {
  const api = fakeApi({ conns: [] });
  render(<App />);
  const user = userEvent.setup();
  await pressLive(user);
  const wiz = (await screen.findAllByLabelText(/Client id/))[0].closest("form");
  expect(within(wiz).queryByLabelText(/Client secret/)).toBeNull();
  expect(within(wiz).queryByLabelText(/Worker application/)).toBeNull();
  expect(within(wiz).getByTestId("auth-note")).toHaveTextContent(/takes a user sign-in/);
  await user.type(within(wiz).getByLabelText(/Environment id/), "11111111-2222-4333-8444-555555555555");
  await user.type(within(wiz).getByLabelText("Client id"), "my-native-app");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/connections")).toBe(true));
  const saved = api.calls.find((c) => c.method === "POST" && c.url === "/api/connections").body;
  expect(saved).toMatchObject({ kind: "pingone", clientId: "my-native-app", endpointStyle: "mcp-host" });
  expect(saved.clientSecret).toBeUndefined(); expect(saved.auth).toBeUndefined();
  await user.selectOptions(within(wiz).getByLabelText("Type"), "custom");
  await user.type(within(wiz).getByLabelText("Server URL"), "https://mcp.example/mcp");
  const secret = within(wiz).getByLabelText(/Header value/);
  expect(secret).toHaveAttribute("type", "password");
  await user.type(secret, "super-secret-value");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/connections" && c.body.token === "super-secret-value")).toBe(true));
  await waitFor(() => expect(within(wiz).getByLabelText(/Header value/)).toHaveValue(""));
  expect(within(wiz).queryByText("super-secret-value")).toBeNull();
  expect(await screen.findByText(/credential: set/)).toBeInTheDocument();
});

test("interactive wizard says to use a public native app and shows the placeholder redirect URI with a working Copy button", async () => {
  const REDIRECT = "http://localhost/mfa-admin-mcp-lab/pi-flow";
  fakeApi({ conns: [], defaults: { envId: null, region: null, piFlowRedirectUri: REDIRECT } });
  const writeText = vi.fn(() => Promise.resolve());
  render(<App />);
  const user = userEvent.setup();
  await pressLive(user);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await waitFor(() => expect(screen.getByTestId("redirect-uri")).toHaveTextContent(REDIRECT)); // always shown: every PingOne connection signs in
  expect(screen.getByLabelText(/MCP endpoint shape/)).toHaveValue("mcp-host");
  expect(within(screen.getByLabelText(/MCP endpoint shape/)).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringMatching(/^mcp\.pingone.*documented by Ping, default/), expect.stringMatching(/^api\.pingone.*UNVERIFIED/)]);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(REDIRECT);
  const box = screen.getByTestId("redirect-box");
  expect(box).toHaveTextContent(/public native application/);
  expect(box).toHaveTextContent(/pi\.flow/);
  expect(box).toHaveTextContent(/UNVERIFIED/);
  expect(box).not.toHaveTextContent(/api\/oauth\/callback/);
  expect(screen.queryByLabelText(/Client secret/)).toBeNull();
});

test("the mock demo button creates an offline user sign-in (no secret), is not tested before anyone signs in, names both mock accounts and offers P1 login", async () => {
  const api = fakeApi({ conns: [] });
  render(<App />);
  expect(await screen.findByTestId("demo-accounts")).toHaveTextContent(/mock\.admin.*every tool.*mock\.viewer.*read tools/);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Add mock demo (sign in)" }));
  await waitFor(() => expect(api.calls.find((c) => c.method === "POST" && c.url === "/api/connections").body).toMatchObject({ offline: true, auth: "interactive", endpointStyle: "mcp-host" }));
  expect(api.calls.find((c) => c.method === "POST" && c.url === "/api/connections").body.clientSecret).toBeUndefined();
  expect(await screen.findByRole("button", { name: "P1 login" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent(/sign in as mock\.admin .* or mock\.viewer/));
  expect(api.calls.some((c) => c.url.endsWith("/test"))).toBe(false); // nobody is signed in yet, so nothing is tested into an error
  expect(screen.getByTestId("identity")).toHaveTextContent("not signed in");
});

test("first load tests a signed-in mock demo on its own, but not one that is not signed in", async () => {
  const signed = fakeApi();
  const first = render(<App />);
  await waitFor(() => expect(signed.calls.some((c) => c.method === "POST" && c.url === "/api/connections/c1/test")).toBe(true));
  first.unmount();
  const unsigned = fakeApi({ conns: [conn({ auth_status: { signedIn: false } })] });
  render(<App />);
  expect(await screen.findByRole("button", { name: "P1 login" })).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  expect(unsigned.calls.some((c) => c.url.endsWith("/test"))).toBe(false);
});

test("a worker connection saved by an older build says it cannot be used and offers no sign-in or role switch", async () => {
  fakeApi({ conns: [conn({ auth: "worker", legacyWorker: true, auth_status: { signedIn: false } })] });
  render(<App />);
  expect(await screen.findByTestId("legacy-worker")).toHaveTextContent(/older build.*user sign-in/);
  expect(screen.queryByRole("button", { name: "P1 login" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Demo role" })).toBeNull();
  expect(screen.getByTestId("identity")).toHaveTextContent(/cannot call/);
});

test("tools explorer: groups, search, badges with the why, writes-off state; server text is inert", async () => {
  fakeApi();
  go("#/tools");
  render(<App />);
  expect(await screen.findByRole("heading", { name: /^MFA Settings/ })).toBeInTheDocument();
  for (const g of ["MFA Settings", "Policies", "Tokens", "Delivery", "Other"]) expect(screen.getByRole("heading", { name: new RegExp(`^${g}`) })).toBeInTheDocument();
  expect(screen.getByTestId("writes-off")).toBeInTheDocument();
  expect(screen.getAllByText("blocked: writes off").length).toBe(3);
  expect(screen.getAllByTestId("class-badge").find((b) => b.textContent === "destructive")).toHaveAttribute("title", expect.stringMatching(/annotation/));
  expect(screen.getByText(/unknown verb in the name, so treated as a write/)).toBeInTheDocument();
  // inert: markup in a description is text, not an element
  expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  await userEvent.setup().type(screen.getByLabelText("Search"), "fido");
  expect(screen.queryByRole("heading", { name: /^Users/ })).toBeNull();
  expect(screen.getByRole("heading", { name: /^Policies/ })).toBeInTheDocument();
});

test("the call view shows the request and the response through the shared JsonPane: Form first, the JSON text on demand, hostile text stays text", async () => {
  fakeApi({ handlers: { "POST /api/connections/:id/call": (b, s, json) => json(200, { class: "read", warnings: [], result: { isError: false, content: [{ type: "text", text: "<b>sms on</b>" }] } }) } });
  setJsonView("form");
  go("#/tool/getMfaSettings");
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Call" }));
  const view = await screen.findByTestId("call-view");
  const req = within(view).getByTestId("call-request");
  const res = within(view).getByTestId("call-response");
  expect(req.tagName).toBe("DIV"); // the Form view: a label and a value per field, not JSON text
  expect(req).toHaveTextContent("method");
  expect(req).not.toHaveTextContent('"method"');
  expect(req.querySelector('[data-hot="true"]')).not.toBeNull(); // method / name / environmentId stand out
  expect(res.querySelector('[data-hot="true"]')).not.toBeNull(); // isError stands out
  expect(res).toHaveTextContent("<b>sms on</b>");
  expect(view.querySelector("b")).toBeNull();
  expect(within(view).getAllByRole("button", { name: "JSON" })).toHaveLength(2); // one toggle per pane
  await user.click(within(view).getAllByRole("button", { name: "JSON" })[0]);
  expect(within(view).getByTestId("call-request").tagName).toBe("PRE"); // one choice for the page: both panes switch
  expect(within(view).getByTestId("call-response").tagName).toBe("PRE");
  expect(within(view).getByTestId("call-request")).toHaveTextContent(/"method": "tools\/call"/);
  expect(within(view).getByTestId("call-response")).toHaveTextContent(/"isError": false/);
});

test("tool page: environmentId prefilled, JSON/Form toggle, snake_case warning, read runs directly", async () => {
  const api = fakeApi({ handlers: { "POST /api/connections/:id/call": (b, s, json) => json(200, { class: "read", warnings: [], result: { content: [{ type: "text", text: "<b>two users</b>" }] } }) } });
  go("#/tool/getEmailDeliverySettings");
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

test("the talk track starts closed on a working page and open on the Stories page; opening it is remembered", async () => {
  fakeApi();
  go("#/tools");
  render(<App />);
  const user = userEvent.setup();
  const panel = await screen.findByTestId("story-panel");
  expect(within(panel).getByRole("button", { name: "Show talk track" })).toHaveAttribute("aria-expanded", "false");
  expect(within(panel).queryByText("Goal")).toBeNull();
  await user.click(within(panel).getByRole("button", { name: "Show talk track" }));
  expect(within(panel).getByText("Goal")).toBeInTheDocument();
  expect(localStorage.getItem("mfaadm.story.open")).toBe("open");
  cleanup(); localStorage.clear();
  go("#/stories");
  render(<App />);
  await screen.findByText("Why do I only see a short tool list?");
  for (const p of screen.getAllByTestId("story-panel")) expect(within(p).getByRole("button", { name: "Hide talk track" })).toHaveAttribute("aria-expanded", "true");
});

test("a blocked write shows why and sends exactly one call", async () => {
  const api = fakeApi({ handlers: { "POST /api/connections/:id/call": (b, s, json) => json(403, { error: "writes_disabled", message: '"createUser" is a write tool. Turn on "allow writes".', class: "write", warnings: [] }) } });
  go("#/tool/createFidoPolicy");
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
  go("#/tool/createFidoPolicy");
  render(<App />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^name/), "pat");
  await user.click(screen.getByRole("button", { name: "Call" }));
  const dlg = await screen.findByRole("dialog");
  expect(within(dlg).getByTestId("confirm-args")).toHaveTextContent(`"name": "pat"`);
  expect(within(dlg).getByTestId("confirm-hash")).toHaveTextContent("abc123hash");
  await user.click(within(dlg).getByRole("button", { name: /Confirm and send/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const second = api.calls.filter((c) => c.url.endsWith("/call"))[1].body;
  expect(second).toMatchObject({ confirm: true, argsHash: "abc123hash", tool: "createFidoPolicy" });
  expect(await screen.findByTestId("call-view")).toHaveTextContent(/"ok": true/);
});

test("a destructive confirm needs the tool name typed; Cancel and Escape send nothing", async () => {
  const api = fakeApi({ conns: [conn({ allowWrites: true })], handlers: { "POST /api/connections/:id/call": (b, s, json) => (!b.confirm
    ? json(409, { error: "confirm_required", argsHash: "h1", arguments: b.arguments, requiresTypedName: true })
    : json(200, { class: "destructive", warnings: [], result: { deleted: "u1" } })) } });
  go("#/tool/deleteFidoPolicy");
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Call" }));
  let dlg = await screen.findByRole("dialog");
  const go2 = within(dlg).getByRole("button", { name: /Delete: confirm/ });
  expect(go2).toBeDisabled();
  await user.type(within(dlg).getByLabelText(/Type/), "deleteFidoPolic");
  expect(go2).toBeDisabled();
  await user.type(within(dlg).getByLabelText(/Type/), "y");
  expect(go2).toBeEnabled();
  fireEvent.keyDown(dlg, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Call" }));
  dlg = await screen.findByRole("dialog");
  await user.type(within(dlg).getByLabelText(/Type/), "deleteFidoPolicy");
  await user.click(within(dlg).getByRole("button", { name: /Delete: confirm/ }));
  await waitFor(() => expect(api.calls.filter((c) => c.url.endsWith("/call"))).toHaveLength(3));
  expect(api.calls.filter((c) => c.url.endsWith("/call"))[2].body).toMatchObject({ confirm: true, argsHash: "h1", typedName: "deleteFidoPolicy" });
});

test("a tool the identity does not see is explained, not a blank page", async () => {
  fakeApi();
  go("#/tool/nopeTool");
  render(<App />);
  expect(await screen.findByText(/does not see a tool called/)).toBeInTheDocument();
});

test("audit page lists every call, arguments exactly as recorded, as text", async () => {
  fakeApi({ audit: [{ at: "2026-01-01T00:00:00Z", connection: "Mock demo", tool: "createUser", class: "write", outcome: "blocked:writes_disabled", argsHash: "deadbeefdeadbeef", args: { username: "<script>x</script>", clientSecret: "shown-as-sent" } }] });
  go("#/audit");
  render(<App />);
  const row = await screen.findByTestId("audit-row");
  expect(row).toHaveTextContent("blocked:writes_disabled");
  expect(row).toHaveTextContent("shown-as-sent");
  expect(screen.getByRole("columnheader", { name: "Arguments" })).toBeInTheDocument();
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

test("raw console: every method shows a sample in Params; resources/read and prompts/get are filled from the server's lists", async () => {
  fakeApi({ conns: [conn()], handlers: { "POST /api/connections/:id/rpc": (b, _s, json) => json(200, { result: b.method === "prompts/list" ? { prompts: [{ name: "summarize", arguments: [{ name: "topic", required: true }, { name: "tone" }] }] } : b.method === "resources/list" ? { resources: [] } : {} }) } });
  go("#/raw");
  render(<App />);
  const params = await screen.findByLabelText(/Params/);
  const pick = (m) => fireEvent.change(screen.getByLabelText(/^Method/), { target: { value: m } });
  expect(params).toHaveValue("{}");
  expect(screen.getByTestId("raw-note")).toHaveTextContent(/tools\/list takes no required params.*cursor/);
  pick("initialize");
  expect(JSON.parse(params.value)).toMatchObject({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mfa-admin-mcp" } });
  pick("prompts/get");
  await waitFor(() => expect(JSON.parse(params.value)).toEqual({ name: "summarize", arguments: { topic: "" } }));
  expect(screen.getByTestId("raw-note")).toHaveTextContent(/first prompt the server listed \(1 prompts\).*required arguments/);
  pick("resources/read");
  await waitFor(() => expect(JSON.parse(params.value)).toEqual({ uri: "file:///example.txt" }));
  expect(screen.getByTestId("raw-note")).toHaveTextContent(/lists no resources.*shape only/);
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
  expect(await screen.findByText("Why do I only see a short tool list?")).toBeInTheDocument();
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
  expect(within(screen.getByLabelText("Sign-in model")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Interactive admin sign-in (pi.flow + PKCE)"]); // the one model: a user sign-in
  await user.selectOptions(screen.getByLabelText("Speed"), "4");
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 7: .*resource \(RFC 8707\)/);
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Step 7 of 7/), { timeout: 6000 });
  expect(screen.getByTestId("caption")).toHaveTextContent(/that admin's permissions/);
  const diagMain = screen.getByRole("main");
  await user.click(within(diagMain).getByRole("button", { name: "Reset" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
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


test("Test connection shows its result in a modal: verdict and tool count", async () => {
  fakeApi({ conns: [conn({ offline: false, label: "Prod tenant" })] });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  console.log("DEBUG live pressed");
  const btns = await screen.findAllByRole("button", { name: "Test connection" });
  console.log("DEBUG buttons:", btns.length);
  console.log("DEBUG buttons:", btns.length);
  await user.click(btns[0]);
  await new Promise((r) => setTimeout(r, 300));
  console.log("DEBUG modal in DOM:", Boolean(document.querySelector('[data-testid="test-result"]')));
  const dlg = await screen.findByTestId("test-result");
  await waitFor(() => expect(within(dlg).getByTestId("test-verdict")).toHaveTextContent(/Connected/));
  expect(within(dlg).getByTestId("test-count")).toHaveTextContent(String(TOOLS.length));
  await user.click(within(dlg).getByTestId("test-close"));
  expect(screen.queryByTestId("test-result")).toBeNull();
});

test("a failed test shows the error class and message in the modal", async () => {
  fakeApi({ conns: [conn({ offline: false, label: "Prod tenant" })], handlers: { "POST /api/connections/:id/test": (body, state, json) => json(424, { error: "mcp_unreachable", message: "MCP HTTP request unreachable (ECONNREFUSED)" }) } });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  await user.click(await screen.findByTestId("test-conn"));
  const dlg2 = await screen.findByTestId("test-result");
  await waitFor(() => expect(within(dlg2).getByTestId("test-verdict")).toHaveTextContent(/did not work/));
  expect(within(dlg2).getByTestId("test-error")).toHaveTextContent("mcp_unreachable");
  expect(within(dlg2).getByTestId("test-message")).toHaveTextContent("ECONNREFUSED");
});

test("a failed test's server message is shown as the text it is, not re-quoted as a JSON string", async () => {
  const message = 'MCP HTTP 401: {"message":"User is not authorized to access this resource"}';
  fakeApi({ conns: [conn({ offline: false, label: "Prod tenant" })], handlers: { "POST /api/connections/:id/test": (body, state, json) => json(424, { error: "mcp_http_error", message }) } });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  await user.click(await screen.findByTestId("test-conn"));
  const dlg = await screen.findByTestId("test-result");
  await waitFor(() => expect(within(dlg).getByTestId("test-message")).toHaveTextContent(message));
  expect(within(dlg).getByTestId("test-message").textContent).not.toContain('\\"'); // no escaped quotes
});

test("the default environment from worker.env is pre-filled in Setup and Add connection (typed values stay)", async () => {
  fakeApi({ conns: [], defaults: { envId: ENV, region: "eu" } });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  const fields = await screen.findAllByLabelText(/^Environment id/);
  expect(fields).toHaveLength(2); // Setup, then Add connection
  await waitFor(() => fields.forEach((f) => expect(f).toHaveValue(ENV)));
  expect(within(screen.getByTestId("setup")).getByLabelText("Region")).toHaveValue("eu");
  await user.clear(fields[0]); await user.type(fields[0], "typed");
  expect(fields[0]).toHaveValue("typed");
});

test("tool page: the environment argument is always filled, from the connection or else the default, under either spelling", async () => {
  const tool = { name: "listThings", description: "List things", inputSchema: { type: "object", properties: { environment_id: { type: "string" } } }, class: "read", classSource: "name", area: "tenant" };
  fakeApi({ conns: [conn({ kind: "custom", offline: false, envId: undefined, url: "http://127.0.0.1:9/mcp" })], tools: [tool], defaults: { envId: ENV, region: "com" } });
  render(<App />);
  await pressLive(userEvent.setup()); // a custom server is a Live connection
  go("#/tool/listThings");
  expect(await screen.findByLabelText(/environment_id/)).toHaveValue(ENV);
});

test("a connection's login hint pre-fills the sign-in dialog's username and can be saved from the card", async () => {
  const api = fakeApi({ conns: [conn({ id: "c1", label: "Hinted", auth: "interactive", clientSecret: undefined, loginHint: "admin.user", auth_status: { signedIn: false } })], handlers: {
    "POST /api/connections/:id/login/start": (_b, _s, json) => json(200, { ok: true, loginId: "login-1", step: "password", usernameHint: "admin.user" }),
    "POST /api/connections/:id/settings": (b, st, json) => { st.conns[0].loginHint = b.loginHint || undefined; return json(200, st.conns[0]); },
  } });
  const user = userEvent.setup();
  render(<App />);
  const card = await screen.findByTestId("conn-card");
  expect(within(card).getByTestId("card-login-hint")).toHaveValue("admin.user");
  expect(within(card).getByTestId("card-login-hint-save")).toBeDisabled(); // nothing changed
  await user.click(within(card).getByRole("button", { name: "P1 login" }));
  const dlg = await screen.findByTestId("login-dialog");
  expect(within(dlg).getByTestId("login-username")).toHaveValue("admin.user");
  expect(within(dlg).queryByTestId("login-mock")).toBeNull();
  await user.click(within(dlg).getByTestId("login-cancel"));
  const input = within(screen.getByTestId("conn-card")).getByTestId("card-login-hint");
  await user.clear(input); await user.type(input, "someone.else");
  await user.click(within(screen.getByTestId("conn-card")).getByTestId("card-login-hint-save"));
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/connections/c1/settings" && c.body.loginHint === "someone.else")).toBe(true));
});

test("the Add connection form offers the optional login hint and sends it", async () => {
  const api = fakeApi({ conns: [] });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  await user.type(await screen.findByTestId("wiz-login-hint"), "admin.user");
  const wiz = screen.getByRole("form", { name: "Add a connection" });
  await user.type(within(wiz).getByLabelText(/^Client id/), "app-1");
  await user.type(within(wiz).getByLabelText(/Environment id/), "11111111-2222-4333-8444-555555555555");
  await user.click(within(wiz).getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/connections" && c.body.loginHint === "admin.user")).toBe(true));
});

test("PingOne sign-in only: a card offers P1 login and no PF login, and Add connection has no authorization-server choice", async () => {
  const inter = { auth: "interactive", clientSecret: undefined, auth_status: { signedIn: false } };
  fakeApi({ conns: [conn({ id: "c2", label: "Live PingOne", offline: false, ...inter })] });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  const card = await screen.findByTestId("conn-card");
  expect(within(card).getByRole("button", { name: "P1 login" })).toBeEnabled();
  expect(within(card).queryByRole("button", { name: /PF login/ })).toBeNull();
  expect(screen.queryByText(/PingFederate/)).toBeNull();
  expect(screen.queryByRole("group", { name: "Authorization server" })).toBeNull();
});

test("a sign-in that the server refuses says why next to the buttons, not only in the hidden live region", async () => {
  const message = "the authorization server did not open a sign-in flow (HTTP 400: invalid_request: redirect_uri mismatch).";
  fakeApi({ conns: [conn({ id: "c1", label: "Mock sign-in", auth: "interactive", clientSecret: undefined, auth_status: { signedIn: false } })],
    handlers: { "POST /api/connections/:id/login/start": (_b, _s, json) => json(424, { error: "pi_flow_unavailable", message }) } });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "P1 login" }));
  expect(await screen.findByTestId("login-err")).toHaveTextContent(message);
  expect(within(screen.getByTestId("conn-card")).getByTestId("login-err")).toBeInTheDocument(); // in the card, not the visually-hidden live region
  expect(screen.queryByTestId("login-dialog")).toBeNull();
});

// A sign-in as the page sees it: login/start answers the first step, login/step answers the rest. The fake keeps the card's status in sync.
function signInApi(over = {}) {
  const mockLogin = { username: "mock.admin", password: "mock-password", otp: "123456", viewer: "mock.viewer" };
  const steps = [];
  const api = fakeApi({ conns: [conn({ id: "c1", label: "Mock sign-in", auth: "interactive", clientSecret: undefined, auth_status: { signedIn: false } })], handlers: {
    "POST /api/connections/:id/login/start": (_b, _s, json) => json(200, { ok: true, loginId: "login-1", step: "password", mockLogin }),
    "POST /api/connections/:id/login/step": (b, st, json) => {
      steps.push(b);
      if (over.step) return over.step(b, st, json);
      if (b.action === "password") return b.password === mockLogin.password ? json(200, { ok: true, step: "otp", devices: [{ id: "d1", type: "SMS", nickname: null, target: "+1 *** 0142" }], selectedDeviceId: "d1" }) : json(401, { error: "invalid_credentials", message: "Username or password is incorrect." });
      st.conns[0].auth_status = { signedIn: true, as: "mock-admin-user", expiresAt: Date.now() + 3_600_000 };
      return json(200, { ok: true, step: "done", as: "mock-admin-user" });
    },
  } });
  return { api, steps, mockLogin };
}

test("P1 login opens a dialog (no redirect): password, then the one-time code, then the card shows signed in", async () => {
  const { api, steps } = signInApi();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "P1 login" }));
  const dlg = await screen.findByTestId("login-dialog");
  expect(within(dlg).getByTestId("login-mock")).toHaveTextContent(/mock\.admin.*mock-password.*123456/);
  expect(within(dlg).getByTestId("login-mock")).toHaveTextContent(/mock\.viewer \(a viewer: read tools only\)/); // the presenter knows the second account exists
  expect(within(dlg).getByTestId("login-username")).toHaveValue("mock.admin"); // the mock account is filled in
  const pw = within(dlg).getByTestId("login-password");
  await user.clear(pw); await user.type(pw, "wrong-password");
  await user.click(within(dlg).getByTestId("login-submit"));
  expect(await within(dlg).findByTestId("login-error")).toHaveTextContent(/incorrect/);
  expect(within(dlg).getByTestId("login-password")).toHaveValue(""); // cleared as soon as it was sent
  expect(dlg).not.toHaveTextContent("wrong-password");
  await user.type(within(dlg).getByTestId("login-password"), "mock-password");
  await user.click(within(dlg).getByTestId("login-submit"));
  expect(await within(dlg).findByTestId("login-otp-where")).toHaveTextContent(/text message/);
  await user.click(within(dlg).getByTestId("login-submit"));
  await waitFor(() => expect(screen.queryByTestId("login-dialog")).toBeNull());
  expect(steps.map((x) => x.action)).toEqual(["password", "password", "otp"]);
  expect(steps.every((x) => x.loginId === "login-1")).toBe(true);
  expect(steps[2]).toEqual({ loginId: "login-1", action: "otp", otp: "123456" });
  expect(await screen.findByRole("button", { name: /Sign out \(mock-admin-user\)/ })).toBeInTheDocument();
  expect(api.calls.every((c) => c.url.startsWith("/api/"))).toBe(true); // the page only ever talked to this app's own server
});

test("signing in on a connection that is not in use makes it the one in use, so the Tools page uses the signed-in connection", async () => {
  fakeApi({ conns: [
    conn({ id: "c0", label: "Other PingOne", auth: "interactive", clientSecret: undefined, auth_status: { signedIn: false } }),
    conn({ id: "c1", label: "Signed PingOne", auth: "interactive", clientSecret: undefined, auth_status: { signedIn: false } }),
  ], handlers: {
    "POST /api/connections/:id/login/start": (_b, _s, json) => json(200, { ok: true, loginId: "login-1", step: "otp", devices: [{ id: "d1", type: "SMS", target: "+1 *** 0142" }], selectedDeviceId: "d1" }),
    "POST /api/connections/:id/login/step": (_b, st, json) => { st.conns[1].auth_status = { signedIn: true, as: "admin-user", expiresAt: Date.now() + 3_600_000 }; return json(200, { ok: true, step: "done", as: "admin-user" }); },
  } });
  const user = userEvent.setup();
  render(<App />);
  const cards = await screen.findAllByTestId("conn-card");
  expect(within(cards[0]).getByRole("button", { name: "In use" })).toBeInTheDocument();
  await user.click(within(cards[1]).getByRole("button", { name: "P1 login" }));
  const dlg = await screen.findByTestId("login-dialog");
  await user.type(within(dlg).getByTestId("login-otp"), "123456");
  await user.click(within(dlg).getByTestId("login-submit"));
  await waitFor(() => expect(screen.queryByTestId("login-dialog")).toBeNull());
  await waitFor(() => expect(within(screen.getAllByTestId("conn-card")[1]).getByRole("button", { name: "In use" })).toBeInTheDocument());
  expect(within(screen.getAllByTestId("conn-card")[0]).getByRole("button", { name: "Use this connection" })).toBeInTheDocument();
});

test("sign-in with two devices asks which one; a step the lab cannot show ends the sign-in with the reason and offers no redirect", async () => {
  const devices = [{ id: "d-sms", type: "SMS", target: "+1 *** 0142" }, { id: "d-mail", type: "EMAIL", target: "a@example.invalid" }];
  const { steps } = signInApi({ step: (b, st, json) => (b.action === "password" ? json(200, { ok: true, step: "device", devices })
    : b.action === "device" ? json(409, { error: "login_unsupported", message: "the sign-on policy asked for a step this lab cannot show (ASSERTION_REQUIRED). Passkeys and external sign-in are not supported here; there is no redirect fallback." }) : json(400, {})) });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "P1 login" }));
  const dlg = await screen.findByTestId("login-dialog");
  await user.click(within(dlg).getByTestId("login-submit"));
  expect(await within(dlg).findByTestId("login-device-1")).toBeInTheDocument();
  await user.click(within(dlg).getByTestId("login-device-1"));
  await user.click(within(dlg).getByTestId("login-submit"));
  expect(await within(dlg).findByTestId("login-error")).toHaveTextContent(/no redirect fallback/);
  expect(dlg).toHaveTextContent(/sign-in is over/);
  expect(within(dlg).queryByTestId("login-submit")).toBeNull();
  expect(steps[1]).toEqual({ loginId: "login-1", action: "device", deviceId: "d-mail" });
  await user.click(within(dlg).getByTestId("login-cancel"));
  expect(screen.queryByTestId("login-dialog")).toBeNull();
});

test("the Test connection dialog lists the actual tools grouped by safety class, with the totals", async () => {
  const tools = [
    { name: "listUsers", class: "read", classSource: "name" },
    { name: "getMfaSettings", class: "read", classSource: "name" },
    { name: "createFidoPolicy", class: "write", classSource: "name" },
    { name: "<b>hostile</b>", class: "destructive", classSource: "unknown" },
  ];
  fakeApi({ conns: [conn({ offline: false, label: "Prod tenant" })], handlers: { "POST /api/connections/:id/test": (b, st, json) => json(200, { ok: true, toolCount: 4, byClass: { read: 2, write: 1, destructive: 1 }, tools }) } });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  await user.click(await screen.findByTestId("test-conn"));
  const dlg = await screen.findByTestId("test-result");
  const totals = await within(dlg).findByTestId("test-totals");
  expect(totals).toHaveTextContent("Total 4: 2 read, 1 write, 1 destructive");
  const read = within(dlg).getByTestId("test-tools-read");
  expect(within(read).getByRole("heading")).toHaveTextContent("read (2)");
  expect(within(read).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["listUsers read", "getMfaSettings read"]); // the order the server sent (sorted there)
  expect(within(within(dlg).getByTestId("test-tools-write")).getByRole("heading")).toHaveTextContent("write (1)");
  const destructive = within(dlg).getByTestId("test-tools-destructive");
  expect(destructive).toHaveTextContent("<b>hostile</b>"); // shown as text
  expect(destructive.querySelector("b")).toBeNull();
});

test("a Live connection records its tool list for the mock demo; the result says how many were kept and skipped", async () => {
  const st = fakeApi({ conns: [conn({ offline: false, kind: "custom", label: "Banking", url: "http://127.0.0.1:9/mcp" })], handlers: { "POST /api/connections/:id/record-tools": (b, s, json) => json(201, { ok: true, kept: 4, skipped: 1, total: 4 }) } });
  const user = userEvent.setup();
  render(<App />);
  await pressLive(user);
  go("#/tools");
  await user.click(await screen.findByTestId("record-tools"));
  expect(await screen.findByText(/Recorded 4 tools \(1 skipped: bad name or oversized schema\)\. The mock demo now lists them\./)).toBeInTheDocument();
  expect(st.calls.filter((c) => c.method === "POST" && c.url.endsWith("/record-tools"))).toHaveLength(1);
});

test("the mock demo says recorded tools are listed with synthetic replies, and Forget removes them and reloads the list", async () => {
  let count = 2;
  const st = fakeApi({ handlers: {
    "GET /api/recorded-tools": (b, s, json) => json(200, { count, tools: [] }),
    "DELETE /api/recorded-tools": (b, s, json) => { count = 0; return json(200, { ok: true, removed: 2 }); },
  } });
  const user = userEvent.setup();
  go("#/tools");
  render(<App />);
  const card = await screen.findByTestId("recorded-tools");
  await waitFor(() => expect(card).toHaveTextContent(/2 tools recorded from Live servers are listed here/));
  expect(card).toHaveTextContent(/synthetic: true/);
  expect(screen.queryByTestId("record-tools")).toBeNull(); // nothing to record from the mock itself
  const listsBefore = st.calls.filter((c) => c.method === "GET" && c.url.endsWith("/tools")).length;
  await user.click(screen.getByTestId("forget-recorded-tools"));
  expect(await screen.findByText("Forgot 2 recorded tools.")).toBeInTheDocument();
  await waitFor(() => expect(st.calls.filter((c) => c.method === "GET" && c.url.endsWith("/tools")).length).toBeGreaterThan(listsBefore));
});

test("the mock demo shows no recorded-tools card when nothing is recorded", async () => {
  fakeApi({ handlers: { "GET /api/recorded-tools": (b, s, json) => json(200, { count: 0, tools: [] }) } });
  go("#/tools");
  render(<App />);
  await screen.findByRole("heading", { name: /^MFA Settings/ });
  expect(screen.queryByTestId("recorded-tools")).toBeNull();
});
