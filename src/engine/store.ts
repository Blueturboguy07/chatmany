// The storage surface the engine needs. TenantDb implements it structurally, so the SAME engine
// runs for a hosted tenant and for the self-host owner — there is no second funnel implementation
// to keep in sync, and the hosted path cannot reach a query that is not tenant-scoped.

import type { Campaign, EventType, State } from "../types";
import type { ConversationRow } from "../tenant/db";

export interface EngineStore {
  getActiveCampaigns(): Promise<Campaign[]>;
  getCampaign(campaignId: string): Promise<Campaign | null>;

  isCommentProcessed(commentId: string): Promise<boolean>;
  markCommentProcessed(commentId: string, igsid: string, campaignId: string): Promise<void>;

  claimSend(key: string): Promise<boolean>;
  releaseSend(key: string): Promise<void>;
  claimCommentAction(commentId: string, action: string): Promise<boolean>;

  getConversation(igsid: string, campaignId: string): Promise<ConversationRow | null>;
  getOpenConversations(igsid: string): Promise<ConversationRow[]>;
  createConversation(igsid: string, campaignId: string, username: string | null, state: State): Promise<void>;
  updateConversation(
    igsid: string,
    campaignId: string,
    patch: Partial<Pick<ConversationRow, "state" | "email" | "followed" | "follow_retries">>,
  ): Promise<void>;

  logEvent(campaignId: string, type: EventType, igsid: string | null): Promise<void>;
  logEvents(entries: Array<{ campaignId: string; type: EventType; igsid: string | null }>): Promise<void>;

  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
}
