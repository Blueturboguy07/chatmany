import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectCard, Connecting } from "../src/renderer/Home";
import { Workspace } from "../src/renderer/components/Workspace";
import type { ConnectedStatus } from "../src/shared/types";
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

const CONNECTED: ConnectedStatus = {
  connected: true,
  username: "ada.makes",
  account_type: "MEDIA_CREATOR",
  profile_picture_url: null,
  ig_user_id: "1789",
  expires_at: 1_770_000_000,
  expires_in_days: 55,
  token_expired: false,
};

describe("the workspace's billing parts", () => {
  const usage = { hosting_share: 0.12, used_share: 0.4, resets_at: "2026-12-01T00:00:00Z", prepaid_left_share: null, headline: "chatmany used 12% of your plan’s monthly limit.", detail: "All your apps used 40%. The limit resets on Dec 1.", cost: "Hosting is charged at what it costs publik, plus 10%. While it costs publik nothing, it costs you nothing." };
  const render = (billing: Parameters<typeof Workspace>[0]["billing"]) =>
    renderToStaticMarkup(<Workspace status={CONNECTED} billing={billing} onReconnect={() => undefined} reconnecting={false} onDisconnected={() => undefined} />);

  it("an empty balance: the paused notice, the usage box and the bar, in percent only", () => {
    const html = render({ can_pay: false, notice: { title: "Replies are paused. Your publik balance is empty.", body: "chatmany sends no DMs and no public replies while your balance is empty." }, usage });
    expect(html).toContain("data-chatmany-no-balance");
    expect(html).toContain("Replies are paused. Your publik balance is empty.");
    expect(html).toContain("What chatmany uses");
    expect(html).toContain("chatmany used 12% of your plan’s monthly limit.");
    expect(html).toContain("All your apps used 40%. The limit resets on Dec 1.");
    expect(html).toContain("data-usage-bar");
    expect(html).toContain('width="12"');
    expect(html).toContain("Open your wallet");
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain("style=");
  });

  it("a balance that can pay: no notice, the box stays", () => {
    const html = render({ can_pay: true, notice: null, usage: { ...usage, hosting_share: null, used_share: null, resets_at: null, prepaid_left_share: 0.35, headline: "You have no plan, so chatmany uses your prepaid balance. 35% of it is left.", detail: null } });
    expect(html).not.toContain("data-chatmany-no-balance");
    expect(html).toContain("35% of it is left.");
    expect(html).not.toContain("data-usage-bar");
  });

  it("no billing read: neither", () => {
    const html = render(null);
    expect(html).not.toContain("data-chatmany-no-balance");
    expect(html).not.toContain("What chatmany uses");
  });
});

describe("waiting for Instagram", () => {
  it("offers I cancelled, start again, so a Cancel that never reached publik does not leave the person waiting", () => {
    const html = renderToStaticMarkup(<Connecting connectId="abcdefgh12345678" until={Date.now() + 600_000} onCancel={() => undefined} onRestart={() => undefined} onDone={() => undefined} />);
    expect(html).toContain("data-connect-restart");
    expect(html).toContain("I cancelled, start again");
    expect(html).toContain("Open Instagram again");
    expect(html).toContain("Stop waiting");
  });
});
