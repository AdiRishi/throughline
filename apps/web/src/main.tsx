import React from "react";
import ReactDOM from "react-dom/client";

import "./index.css";

import { AppRoot } from "./AppRoot.tsx";
import { isElectron } from "./env.ts";
import { syncDocumentWindowControlsOverlayClass } from "./windowControlsOverlay.ts";

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element is missing from index.html");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
