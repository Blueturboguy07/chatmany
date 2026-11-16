import { useEffect, useState } from "react";
import type { GateView } from "../shared/bridge";
import { Gate } from "./Gate";
import { Home } from "./Home";
import { bridge } from "./ui";

/**
 * The whole app: the sign-in gate until the main process says the install
 * is signed in, then the chatmany workspace. The screen follows the main
 * process's gate state only; an address or a stored flag cannot change it.
 */
export function App() {
  const [gate, setGate] = useState<GateView>({ screen: "starting" });

  useEffect(() => {
    const off = bridge().gate.onChange(setGate);
    void bridge()
      .gate.get()
      .then(setGate)
      .catch(() => undefined);
    return off;
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand">chatmany</span>
        {gate.screen === "signed_in" ? (
          <span className="who" translate="no">
            {gate.handle ? `@${gate.handle} on publik` : "Signed in to publik"}
          </span>
        ) : null}
      </header>
      {gate.screen === "signed_in" ? <Home /> : <Gate view={gate} />}
    </>
  );
}
