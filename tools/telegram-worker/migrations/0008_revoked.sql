-- License revocation kill-switch: /revoke ORDERID (admin) marks the customer
-- row so /api/validate returns {valid:false, reason:'revoked'} and the panel
-- can show a clear "contact seller" message. /unrevoke ORDERID reverses it.
ALTER TABLE customers ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;