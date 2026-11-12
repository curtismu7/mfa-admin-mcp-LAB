import React from "react";
import StoryPanel from "../story/StoryPanel.jsx";
import { usePresent } from "../present/Present.jsx";

export default function Stories() {
  const { present } = usePresent();
  return (
    <>
      <h1>Stories</h1>
      <p className="lede">Two talk tracks. Pick a vertical to re-skin the wording. Both run in the mock demo: <a href="#/connections">add it on Connections</a>.</p>
      <StoryPanel mode="tool-list" present={present} />
      <StoryPanel mode="gate" present={present} />
    </>
  );
}
