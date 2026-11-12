import React, { useMemo, useState } from "react";
import { VERTICALS, storyForMode, verticalById } from "./stories.js";
import { fillAll } from "./fill.js";
// Adapted from hostile-mcp web/src/story/StoryPanel.jsx and the ID-JAG kit StoryPanel (same author): the talk track for a page,
// re-skinned by the chosen vertical, with the Allowed/Blocked switch. Differences: no customer context (the vertical is the
// viewer's own choice) and presenter
// mode arrives as a prop. Story text is ours; it renders as text nodes like everything else.
const KEYS = { vertical: "p1mcp.story.vertical", path: "p1mcp.story.path", open: "p1mcp.story.open" };
const read = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: not remembered */ } };

export default function StoryPanel({ mode, present = false }) {
  const raw = storyForMode(mode);
  const [verticalId, setVerticalId] = useState(() => read(KEYS.vertical, "generic"));
  const [path, setPath] = useState(() => (read(KEYS.path, "happy") === "blocked" ? "blocked" : "happy"));
  const [open, setOpen] = useState(() => read(KEYS.open, "open") !== "closed");
  const [active, setActive] = useState(null);
  const vertical = verticalById(verticalId);
  const story = useMemo(() => (raw ? fillAll(raw, vertical) : null), [raw, vertical]);
  if (!story) return null;

  const isOpen = open || present;
  const blocked = path === "blocked";
  const current = story.steps.find((s) => s.n === active) || story.steps[0];
  const text = (step) => (blocked && step.blocked ? step.blocked : step);
  const pickVertical = (id) => { setVerticalId(id); write(KEYS.vertical, id); };
  const pickPath = (p) => { setPath(p); write(KEYS.path, p); };
  const toggle = () => { setOpen(!open); write(KEYS.open, open ? "closed" : "open"); };

  return (
    <section className="story" aria-label="Talk track" data-testid="story-panel">
      <header className="story__head">
        <div>
          <p className="story__eyebrow">Story {story.id} · {vertical.displayName}</p>
          <h2 className="story__title">{story.title}</h2>
        </div>
        <button type="button" aria-expanded={isOpen} onClick={toggle} disabled={present}>{isOpen ? "Hide talk track" : "Show talk track"}</button>
      </header>
      {isOpen && (
        <>
          <div className="story__controls">
            <label className="story__field">Vertical
              <select value={vertical.id} onChange={(e) => pickVertical(e.target.value)}>
                {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
              </select>
            </label>
            <div className="seg" role="group" aria-label="Story path">
              <button type="button" aria-pressed={!blocked} onClick={() => pickPath("happy")}>Allowed</button>
              <button type="button" aria-pressed={blocked} onClick={() => pickPath("blocked")}>Blocked</button>
            </div>
          </div>
          <dl className="story__summary">
            <dt>Goal</dt><dd>{story.goal}</dd>
            <dt>Obstacle</dt><dd>{story.obstacle}</dd>
            <dt>Control</dt><dd>{story.control}</dd>
          </dl>
          <ol className="story__steps">
            {story.steps.map((s) => (
              <li key={s.n}>
                <button type="button" className="story__step" aria-current={s.n === current.n ? "step" : undefined} onClick={() => setActive(s.n)}>
                  <span className="story__n">{s.n}</span>{s.title}
                  {blocked && s.blocked && <span className="story__tag">blocked</span>}
                </button>
                {s.n === current.n && (
                  <div className="story__body">
                    <p>{text(s).tell}</p>
                    <p className="story__say"><strong>Say:</strong> “{text(s).say}”</p>
                    <p className="story__why"><strong>Why it matters:</strong> {s.why}</p>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="story__proof"><strong>Proof:</strong> {blocked ? story.proof.blocked : story.proof.happy}</p>
          <p className="story__takeaway">“{story.say}”</p>
        </>
      )}
    </section>
  );
}
