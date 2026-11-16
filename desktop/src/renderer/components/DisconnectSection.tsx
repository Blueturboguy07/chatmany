import { Unplug } from "lucide-react";
import { useState } from "react";
import { BusyLabel, bridge } from "../ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "./ui/card";

/**
 * "Disconnect and delete my data": publik deletes this creator's tenant on
 * the hosted service: the Instagram connection, every automation, its
 * numbers and the people list. It asks first, in a dialog in the page.
 */
export function DisconnectSection({ username, onDisconnected }: { username: string | null; onDisconnected: () => void }) {
  const [open, setOpen] = useState(false);
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
    setOpen(false);
    onDisconnected();
  }

  return (
    <Card className="border-destructive/30" role="region" aria-labelledby="disconnect-title" data-disconnect>
      <CardHeader>
        <h2 id="disconnect-title" className="font-semibold">
          Disconnect
        </h2>
        <CardDescription>Disconnects {who} from publik and deletes everything publik holds for it here: the connection, your automations, their numbers and the people list. This cannot be undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            if (working) return;
            setOpen(next);
            if (next) setError("");
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive" data-disconnect-button>
              <Unplug aria-hidden />
              Disconnect and delete my data
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {who} and delete its data?</AlertDialogTitle>
              <AlertDialogDescription>publik deletes the connection, your automations, their numbers and the people list. This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={working} data-disconnect-keep>
                Keep it connected
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={working}
                aria-busy={working}
                onClick={(event) => {
                  event.preventDefault();
                  void disconnect();
                }}
                data-disconnect-confirm
              >
                <BusyLabel busy={working}>Yes, disconnect and delete</BusyLabel>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
