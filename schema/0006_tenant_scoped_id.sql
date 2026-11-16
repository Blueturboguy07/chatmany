-- 0006: the Instagram-scoped id Meta uses for this creator in its data-deletion callback.
--
-- `tenants.ig_user_id` holds the professional account id (`/me` user_id). Meta's data-deletion
-- and deauthorize callbacks name the person by the id the token exchange returned (the
-- Instagram-scoped user id), which can differ. Keeping both lets publik's deletion callback find
-- the tenant to erase (GET /hosted/tenants?ig_user_id=). Additive: one nullable column and an
-- index. A tenant connected before this migration gets the value on its next connect, and is
-- still found by ig_user_id until then.

ALTER TABLE tenants ADD COLUMN ig_scoped_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tenants_ig_scoped ON tenants (ig_scoped_user_id);
