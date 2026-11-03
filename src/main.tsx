import React from "react";
import ReactDOM from "react-dom/client";
import NightBoxApp from "../app/page";
import "../app/globals.css";

const root = document.getElementById("root") as HTMLElement;
root.dataset.build = "2026-11-03-mobile-layout";

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <NightBoxApp />
  </React.StrictMode>,
);
