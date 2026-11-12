// Opened from Customer Agent LAB: the strip and the header Back button show; nothing is preselected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { returnLinkFor } from "../return-link/returnTargets.js";
import { fakeApi } from "../test-helpers.js";
import App from "../App.jsx";

const NOTE = { name: "Opened from Customer Agent LAB" };
beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("return link", () => {
  it("?from=ai-demo-standalone: strip named for AI Demo Standalone, Back to its fixed proxy path", () => {
    fakeApi();
    window.history.replaceState(null, "", "/pingone-mcp-inspector/?from=ai-demo-standalone&uc=UC12");
    render(<App />);
    const note = screen.getByRole("note", { name: "Opened from AI Demo Standalone" });
    expect(note.textContent).toContain("UC12");
    const buttons = screen.getAllByRole("button", { name: /Back to AI Demo Standalone/ });
    expect(buttons).toHaveLength(2);
    expect(returnLinkFor("pingone-mcp-inspector").href).toBe("/ai-demo-standalone/?returned=pingone-mcp-inspector&uc=UC12");
  });

  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link");
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });

  it("?from=customer-agent: banner first, strip right below, header Back in the tools", async () => {
    fakeApi();
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC-LEARN2&vertical=banking");
    render(<App />);
    const note = await screen.findByRole("note", NOTE);
    expect(note.textContent).toContain("UC-LEARN2");
    expect(screen.getByTestId("banner").nextElementSibling).toBe(note);
    expect(document.querySelector(".top__tools button.return-link--header")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })).toHaveLength(2);
  });

  it("no from, an unknown from or a bad id: no strip, no button", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC-LEARN2", "/?from=customer-agent&uc=%3Cb%3E", "/?from=customer-agent&uc=UC-LEARN2&vertical=a%20b"]) {
      fakeApi();
      window.history.replaceState(null, "", q);
      render(<App />);
      await screen.findByTestId("banner");
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      expect(screen.queryByRole("note", NOTE)).toBeNull();
      cleanup();
    }
  });

  it("Back goes to the proxy path behind the lab proxy, to the direct URL on the app's own port", () => {
    window.history.replaceState(null, "", "/pingone-mcp-inspector/?from=customer-agent&uc=UC-LEARN2");
    expect(returnLinkFor("pingone-mcp-inspector").href).toBe("/customer-agent/?returned=pingone-mcp-inspector&uc=UC-LEARN2");
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC-LEARN2");
    expect(returnLinkFor("pingone-mcp-inspector").href).toBe("http://127.0.0.1:5603/?returned=pingone-mcp-inspector&uc=UC-LEARN2");
  });
});
