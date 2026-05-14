import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StudyCompanion from "../study-companion.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <StudyCompanion />
  </StrictMode>
);
