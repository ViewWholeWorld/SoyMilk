-- Global time filters do not constrain provider_key. An ordered partial index avoids scanning
-- every provider's index entries and sorting them just to read the newest model attempts.
CREATE INDEX receipt_attempts_model_live_time_idx ON receipt_attempts (started_at DESC, id DESC)
  WHERE origin = 'live' AND (billing_kind IS NOT NULL OR model IS NOT NULL);
