-- 统计也包含仅 requested_model 非空的请求，查询条件必须蕴含时间部分索引的条件。
-- 迁移事务内替换原索引，继续覆盖旧版 model／billing_kind 查询，避免重复维护两个索引。
DROP INDEX receipt_attempts_model_live_time_idx;
CREATE INDEX receipt_attempts_model_live_time_idx ON receipt_attempts (started_at DESC, id DESC)
  WHERE origin = 'live' AND (billing_kind IS NOT NULL OR model IS NOT NULL OR requested_model IS NOT NULL);
