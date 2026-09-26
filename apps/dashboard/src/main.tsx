import React from "react";
import ReactDOM from "react-dom/client";
import Root from "./Root";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
