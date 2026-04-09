import React from "react";
import ReactDOM from "react-dom/client";
import OnTrendsGame from "./OnTrendsGame.jsx";
import "./index.css";
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";

try {
  if (outputs && typeof outputs === "object") {
    Amplify.configure(outputs);
  }
} catch (err) {
  console.warn("Amplify configure skipped; running in local frontend mode.", err);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OnTrendsGame />
  </React.StrictMode>
);
