import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ClientProvider } from "./api/ClientProvider";
import { createConsoleClient } from "./api/client";
import "./theme/tokens.css";
import "./theme/base.css";
import "./screens.css";

const container = document.getElementById("console-root");
if (container === null) {
  throw new Error("The console root element is missing from index.html.");
}

const client = createConsoleClient();

createRoot(container).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
);
