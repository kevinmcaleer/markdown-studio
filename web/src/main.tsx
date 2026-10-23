import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startPwa } from "./pwa";
import { SessionProvider } from "./session";
import "./styles.css";

startPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
