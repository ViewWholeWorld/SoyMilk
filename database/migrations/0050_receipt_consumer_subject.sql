-- 合并路径恢复按文章修订查共享消费者，避免每次分析扫描全部付费回执。
CREATE INDEX receipt_consumers_subject_idx ON receipt_consumers (subject, receipt_id);
