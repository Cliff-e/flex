import React, { useState } from "react";

export default function AiBots() {
  const [signal, setSignal] = useState("WAIT");

  return (
    <div style={{ padding: 20 }}>
      <h2>AI Powered Bots</h2>

      <div style={{ marginTop: 20 }}>
        <p>Status: <b>{signal}</b></p>

        <button onClick={() => setSignal("BUY")}>
          Simulate BUY Signal
        </button>

        <button onClick={() => setSignal("SELL")}>
          Simulate SELL Signal
        </button>
      </div>
    </div>
  );
}