import { expect, test } from "vitest";
import { STORIES, VERTICALS, storyForMode } from "./stories.js";
import { fillAll, tokensIn } from "./fill.js";
import { validateStory, validateVertical } from "./storySchema.js";

test("both stories and the generic, airlines and banking packs are valid", () => {
  expect(STORIES.map((s) => s.id)).toEqual(["S01", "S02"]);
  expect(VERTICALS.map((v) => v.id).sort()).toEqual(["airlines", "banking", "generic"]);
  for (const s of STORIES) expect(validateStory(s, { modes: ["tool-list", "gate"], stepRange: [1, 6] })).toEqual([]);
  for (const v of VERTICALS) expect(validateVertical(v)).toEqual([]);
});
test("every token resolves in every vertical and the banking pack changes the wording", () => {
  for (const s of STORIES) for (const v of VERTICALS) {
    expect(JSON.stringify(fillAll(s, v)), `${s.id} in ${v.id}`).not.toContain("missing:");
    for (const t of tokensIn(s)) expect(t.startsWith("vocab.") ? v.vocab[t.slice(6)] : v.cast[t]).toBeTruthy();
  }
  expect(JSON.stringify(fillAll(STORIES[0], VERTICALS.find((v) => v.id === "banking")))).toContain("the bank");
  expect(JSON.stringify(fillAll(STORIES[0], VERTICALS.find((v) => v.id === "airlines")))).toContain("the airline");
});
test("stories sit on their modes", () => { expect(storyForMode("tool-list").id).toBe("S01"); expect(storyForMode("gate").id).toBe("S02"); expect(storyForMode("none")).toBeNull(); });
