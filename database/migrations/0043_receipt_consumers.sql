-- A logical paid request can serve several articles without buying the same answer again.
CREATE TABLE receipt_consumers (
  receipt_id bigint NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  subject text NOT NULL,
  PRIMARY KEY (receipt_id, subject)
);

INSERT INTO receipt_consumers(receipt_id,subject)
SELECT id,subject FROM receipts WHERE subject IS NOT NULL ON CONFLICT DO NOTHING;

-- Recover previously omitted consumers only where the article recorded the exact unknown receipt.
INSERT INTO receipt_consumers(receipt_id,subject)
SELECT r.id, 'article:' || a.id || '@' || a.revision
FROM receipts r JOIN articles a ON a.processing_error = 'receipt ' || r.id || ' outcome unknown'
WHERE a.processing_state = 'failed'
ON CONFLICT DO NOTHING;
