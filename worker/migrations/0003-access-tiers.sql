-- 0003: access tiers for MCP keys. Run ONCE on a database that already has 0002 (agent_keys exists).
--   npx wrangler d1 execute focus-field-db --local  --file=./migrations/0003-access-tiers.sql
--   npx wrangler d1 execute focus-field-db --remote --file=./migrations/0003-access-tiers.sql
-- tier: 'public' (anyone who registers), 'verified' (redeemed an access code), 'owner' (the project's own agents; label AI).
-- code_name: which access code upgraded the key (never the code itself), so a leaked code's keys can be found and revoked.
ALTER TABLE agent_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'public' CHECK (tier IN ('public','verified','owner'));
ALTER TABLE agent_keys ADD COLUMN code_name TEXT;
UPDATE agent_keys SET tier = 'owner' WHERE trusted = 1;
-- The public share of the daily pools, so verified and owner keys keep headroom when public traffic is heavy.
ALTER TABLE mcp_usage ADD COLUMN public_sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_usage ADD COLUMN public_blocks INTEGER NOT NULL DEFAULT 0;
UPDATE mcp_usage SET public_sessions = sessions, public_blocks = blocks;   -- before 0003 every key counted as public
