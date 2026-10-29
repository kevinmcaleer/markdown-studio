import { StrictMode } from "react";
import { configureLanguageApi } from "@markdown-studio/markdown-editor";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { startPwa } from "./pwa";
import { SessionProvider } from "./session";
import "./styles.css";

startPwa();
// Look Up, grammar and translation in the editor go to this server.
configureLanguageApi(api);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
