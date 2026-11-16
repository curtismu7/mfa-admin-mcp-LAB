// The header shows this lab's own Verified / In progress mark, read from GET /api/shelf (through the lab-proxy that call reaches the shelf,
// whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { fakeApi } from "../test-helpers.js";
import App from "../App.jsx";

beforeEach(() => { window.location.hash = ""; try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
const shelfCalls = () => globalThis.fetch.mock.calls.filter(([url]) => url === "/api/shelf").length;
// fakeApi answers everything else; layer /api/shelf on top of its fetch.
function appWithShelf(payload) {
  fakeApi();
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init) => (url === "/api/shelf" ? Promise.resolve(new Response(JSON.stringify(payload))) : base(url, init)));
  render(<App />);
}

describe("verification mark in the header", () => {
  it("shows this lab's own mark in the top menu, and no other lab's", async () => {
    appWithShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "mfa-admin-mcp", verification: mark("verified", "Verified", { note: "Every tool called on the mock" }) }] });
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every tool called on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "mfa-admin-mcp", verification: null }] }]) {
      appWithShelf(payload);
      await screen.findByTestId("top-menu");
      await waitFor(() => expect(shelfCalls()).toBe(1)); // the shelf answered, and still no badge
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector(".verify")).toBeNull();
      cleanup();
      vi.restoreAllMocks();
    }
  });
});
