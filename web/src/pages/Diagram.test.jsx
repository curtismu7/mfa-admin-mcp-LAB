import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeApi } from "../test-helpers.js";
import Diagram, { flowEdges, slots } from "./Diagram.jsx";
import { PresentProvider } from "../present/Present.jsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// A made-up diagram-studio/1 document: nothing in Diagram.jsx knows these boxes, so anything on screen came from the fetched data.
const doc = (id, title, x2) => ({
  schema: "diagram-studio/1", id, title, groups: { g: { label: "G", color: "dark" } },
  nodes: [{ id: "alpha", label: "Alpha box", group: "g", sub: ["first small line", "second small line"], x: 10, y: 20 }, { id: "beta", label: "Beta box", group: "g", x: x2, y: 20 }, { id: "gamma", label: "Gamma box", group: "g", x: 600, y: 20 }],
  edges: [{ source: "alpha", target: "beta", label: "alpha to beta" }, { source: "beta", target: "alpha", label: "beta back", dashed: true, handles: ["l2", "r2"] }],
  steps: [{ title: "One", what: `First step of ${id}`, edges: [0] }, { title: "Two", what: `Second step of ${id}`, edges: [1] }],
});
const serve = (docs) => ({
  "GET /api/diagrams": (_b, _s, json) => json(200, { diagrams: Object.values(docs).map((d) => ({ name: d.id, title: d.title })) }),
  ...Object.fromEntries(Object.values(docs).map((d) => [`GET /api/diagrams/${d.id}`, (_b, _s, json) => json(200, d)])),
});
const mount = () => render(<PresentProvider><Diagram theme="light" /></PresentProvider>);

test("the diagram is drawn from the fetched data: boxes, small print, arrow labels, step text and the box positions all come from the document", async () => {
  const docs = { one: doc("one", "Model one", 300), two: doc("two", "Model two", 500) };
  const state = fakeApi({ handlers: serve(docs) });
  const user = userEvent.setup();
  mount();
  expect(await screen.findByText("Alpha box")).toBeInTheDocument();
  expect(screen.getByText("Beta box")).toBeInTheDocument();
  expect(screen.getByText("first small line")).toBeInTheDocument();
  expect(screen.getByText("second small line")).toBeInTheDocument();
  expect(screen.queryByText("Your browser")).toBeNull(); // nothing is hard-coded in the component
  expect(state.calls.map((c) => c.url)).toEqual(["/api/diagrams", "/api/diagrams/one"]); // the list, then the first diagram by name
  expect(within(screen.getByLabelText("Sign-in model")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Model one", "Model two"]);
  const at = (label) => screen.getByText(label).closest(".react-flow__node").style.transform.replace(/\s/g, "");
  expect(at("Alpha box")).toContain("translate(10px,20px)");
  expect(at("Beta box")).toContain("translate(300px,20px)");
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent("Step 1 of 2: First step of one");
  expect([...document.querySelectorAll(".fbox")].map((b) => b.dataset.state)).toEqual(["on", "on", "dim"]); // the arrow's two boxes light up, the other dims
  // the second diagram is fetched by its name when chosen
  await user.selectOptions(screen.getByLabelText("Sign-in model"), "two");
  await waitFor(() => expect(state.calls.map((c) => c.url)).toContain("/api/diagrams/two"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  expect(at("Beta box")).toContain("translate(300px,20px)"); // both models share one layout: a box stays where it is when the model changes
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent("Step 1 of 2: First step of two");
});

test("a box moves (keyboard drag), stays put when the model changes, and Reset puts it back at the position in the data and clears the walkthrough", async () => {
  fakeApi({ handlers: serve({ one: doc("one", "Model one", 300), two: doc("two", "Model two", 300) }) });
  const user = userEvent.setup();
  mount();
  const at = async () => (await screen.findByText("Alpha box")).closest(".react-flow__node").style.transform.replace(/\s/g, "");
  expect(await at()).toBe("translate(10px,20px)");
  (await screen.findByText("Alpha box")).closest(".react-flow__node").focus();
  await user.keyboard("{Enter}"); await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await waitFor(async () => expect(await at()).toBe("translate(30px,20px)")); // moved by 20
  await user.selectOptions(screen.getByLabelText("Sign-in model"), "two");
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  expect(await at()).toBe("translate(30px,20px)"); // the other model keeps the moved box where it is
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
  await waitFor(async () => expect(await at()).toBe("translate(10px,20px)")); // back where the data puts it
});

test("a diagram that does not load shows an alert and no boxes; a missing list does too", async () => {
  fakeApi({ handlers: { "GET /api/diagrams": (_b, _s, json) => json(200, { diagrams: [{ name: "one", title: "Model one" }] }), "GET /api/diagrams/one": (_b, _s, json) => json(404, { error: "unknown_diagram" }) } });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load the diagram/);
  expect(document.querySelector(".react-flow__node")).toBeNull();
  expect(screen.getByRole("button", { name: "Simulate" })).toBeDisabled();
  cleanup();
  fakeApi({ handlers: { "GET /api/diagrams": (_b, _s, json) => json(500, { error: "internal_error" }) } });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(/diagram list did not load/);
});

test("edges come from the data: one per edge, labels, dashed only where the data says, the hint or facing slots, and the current step's arrow highlighted", () => {
  const d = doc("one", "Model one", 300);
  const e = flowEdges(d, new Set(["e1"]), true);
  expect(e.map((x) => [x.id, x.source, x.target, x.label, x.sourceHandle, x.targetHandle])).toEqual([["e0", "alpha", "beta", "alpha to beta", "r1", "l1"], ["e1", "beta", "alpha", "beta back", "l2", "r2"]]);
  expect(e.map((x) => x.className)).toEqual(["", "flow__edge--on flow__edge--dashed"]);
  expect(e.map((x) => x.animated)).toEqual([false, true]);
  expect(flowEdges(d, new Set(["e1"]), false).map((x) => x.animated)).toEqual([false, false]); // reduced motion
});

test("slots: a handles hint in the data wins, a malformed hint is ignored, and with no hint the arrow leaves by the side that faces its target", () => {
  const at = { a: { x: 0, y: 0 }, b: { x: 300, y: 10 }, c: { x: 0, y: -200 } };
  expect(slots({ source: "a", target: "b", handles: ["t1", "l2"] }, at)).toEqual(["t1", "l2"]);
  expect(slots({ source: "a", target: "b", handles: ["x9", "l2"] }, at)).toEqual(["r1", "l1"]);
  expect(slots({ source: "a", target: "b" }, at)).toEqual(["r1", "l1"]);
  expect(slots({ source: "b", target: "a" }, at)).toEqual(["l1", "r1"]);
  expect(slots({ source: "a", target: "c" }, at)).toEqual(["t1", "b1"]);
  expect(slots({ source: "c", target: "a" }, at)).toEqual(["b1", "t1"]);
});

test("a late answer for a diagram the visitor has already left is dropped", async () => {
  const docs = { one: doc("one", "Model one", 300), two: doc("two", "Model two", 300) };
  let release;
  const slow = new Promise((r) => { release = r; });
  fakeApi({ handlers: { ...serve(docs), "GET /api/diagrams/two": async (_b, _s, json) => { await slow; return json(200, docs.two); } } });
  const user = userEvent.setup();
  mount();
  await screen.findByText("Alpha box");
  await user.selectOptions(screen.getByLabelText("Sign-in model"), "two");
  await user.selectOptions(screen.getByLabelText("Sign-in model"), "one");
  release();
  await new Promise((r) => setTimeout(r, 50));
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Simulate" }));
  expect(screen.getByTestId("caption")).toHaveTextContent("First step of one"); // not "two", which arrived last
});
