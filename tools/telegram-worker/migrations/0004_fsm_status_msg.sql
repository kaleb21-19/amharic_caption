-- Migration 0004 : fsm.status_msg_id.
--
-- reviewConfirm() persists the buyer's "review your order" message id into
-- the FSM row so it survives a mid-flow worker restart. The column did not
-- exist, so the write was silently dropped. (The functional buyer status
-- edit on approval uses orders.status_msg_id; this just makes the FSM row
-- honest and durable.)

ALTER TABLE fsm ADD COLUMN status_msg_id INTEGER;