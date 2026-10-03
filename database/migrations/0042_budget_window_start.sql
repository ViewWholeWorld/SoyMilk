-- A temporary bootstrap budget can end without its historical attempts blocking incremental work.
-- The attempt ledger remains intact; only the circuit breaker's counting window starts again.
ALTER TABLE budgets ADD COLUMN window_started_at timestamptz;
