import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectCard } from "../src/renderer/Home";
import { Gate, SIGN_IN_BODY } from "../src/renderer/Gate";
import { OFFLINE_TEXT, UNREACHABLE_TEXT } from "../src/shared/messages";

describe("the gate's screens", () => {
  it("Sign in with publik: one screen, one button, the waiting note", () => {
    const html = renderToStaticMarkup(<Gate view={{ screen: "sign_in", note: "Waiting for you to sign in in your browser.", waiting: true }} />);
    expect(html).toContain('data-screen="sign_in"');
    expect(html).toContain("Sign in with publik");
    expect(html).toContain(SIGN_IN_BODY);
    expect(html).toContain("data-gate-signin");
    expect(html).toContain("Waiting for you to sign in in your browser.");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("not reachable and offline: the words and Retry", () => {
    const down = renderToStaticMarkup(<Gate view={{ screen: "unreachable", offline: false, message: UNREACHABLE_TEXT }} />);
    expect(down).toContain("publik is not reachable. Check your connection.");
    expect(down).toContain("data-gate-retry");
    const offline = renderToStaticMarkup(<Gate view={{ screen: "unreachable", offline: true, message: UNREACHABLE_TEXT }} />);
    expect(offline).toContain(OFFLINE_TEXT);
  });

  it("Connect Instagram after sign-in", () => {
    const html = renderToStaticMarkup(<ConnectCard busy={false} onConnect={() => undefined} />);
    expect(html).toContain("Connect your Instagram account");
    expect(html).toContain("Connect Instagram");
    expect(html).toContain("Professional account (Creator or Business)");
  });
});
