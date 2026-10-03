-- Waits preserve the failure count; unknown outcomes resume only after their original receipt releases.
ALTER TABLE translation_attempts DROP CONSTRAINT translation_attempts_outcome_check;
ALTER TABLE translation_attempts ADD CONSTRAINT translation_attempts_outcome_check
  CHECK (outcome IN ('translated', 'partial', 'skipped', 'failed', 'waiting'));
ALTER TABLE translation_attempts ADD COLUMN retry_at timestamptz;
ALTER TABLE translation_attempts ADD COLUMN wait_receipt_id bigint REFERENCES receipts(id) ON DELETE SET NULL;

-- Pin the original Jina day before a budget wait can cross midnight without creating a receipt.
ALTER TABLE articles ADD COLUMN body_fallback_request jsonb;

-- The old loop counted the last explicit unknown as a failure. Undo only that proven increment;
-- earlier failures are not distinguishable from waits, so do not reset the whole counter.
UPDATE translation_attempts t SET outcome='waiting', attempts=greatest(t.attempts-1,0),
  wait_receipt_id=CASE WHEN r.status='unknown' THEN r.id ELSE NULL END,
  retry_at=CASE WHEN r.status='failed' THEN now() ELSE NULL END
FROM receipts r, articles a, publications p
WHERE a.id=t.article_id AND a.revision=t.revision AND p.article_id=a.id
  AND p.selected AND p.visibility='public' AND p.body_mode='full'
  AND t.outcome='failed' AND r.purpose='translate_body'
  AND t.reason='Receipt ' || r.id || ' has an unknown outcome; it is released once automatically, then from the admin'
  AND EXISTS(SELECT 1 FROM receipt_consumers c WHERE c.receipt_id=r.id
    AND c.subject LIKE 'article:' || a.id || '@' || a.revision || '#%')
  AND (r.status='unknown' OR (r.status='failed' AND EXISTS(SELECT 1 FROM audit_log l
    WHERE l.action='receipt.release' AND l.subject='receipt:' || r.id)));
