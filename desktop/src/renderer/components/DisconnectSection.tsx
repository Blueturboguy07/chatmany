import { useState } from "react";
import { BusyLabel, Status, bridge, useConfirmStep } from "../ui";

/**
 * "Disconnect and delete my data": publik deletes this creator's tenant on
 * the hosted service: the Instagram connection, every automation, its
 * numbers and the people list. Two clicks in the page, the second confirms.
 */
export function DisconnectSection({ username, onDisconnected }: { username: string | null; onDisconnected: () => void }) {
  const step = useConfirmStep();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const who = username ? `@${username}` : "this Instagram account";

  async function disconnect() {
    setWorking(true);
    setError("");
    const res = await bridge().workspace.disconnect();
    setWorking(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    step.reset();
    onDisconnected();
  }

  return (
    <section className="danger-zone" aria-labelledby="disconnect-title" data-disconnect>
      <h2 id="disconnect-title" className="bold">
        Disconnect
      </h2>
      <p className="mt-2 small muted prose">
        Disconnects {who} from publik and deletes everything publik holds for it here: the connection, your automations, their numbers and the people list. This cannot be undone.
      </p>
      {step.armed ? (
        <div className="row mt-4" onKeyDown={step.onKeyDown}>
          <button type="button" ref={step.confirmRef} onClick={() => void disconnect()} disabled={working} aria-busy={working} className="btn btn-danger" data-disconnect-confirm>
            <BusyLabel busy={working}>Yes, disconnect and delete</BusyLabel>
          </button>
          <button type="button" onClick={step.cancel} disabled={working} className="btn btn-quiet">
            Keep it connected
          </button>
        </div>
      ) : (
        <button type="button" ref={step.triggerRef} onClick={step.arm} className="btn btn-danger mt-4" data-disconnect-button>
          Disconnect and delete my data
        </button>
      )}
      <Status assertive className="mt-3 small danger-text">
        {error}
      </Status>
    </section>
  );
}
