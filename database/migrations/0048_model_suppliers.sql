-- 服务供应商独立于连接和参考价目录；旧请求不按当前连接推断归属。
CREATE TABLE model_suppliers (
  id text PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE
);

INSERT INTO model_suppliers (id, name, normalized_name) VALUES
  ('openai', 'OpenAI', 'openai'),
  ('deepseek', 'DeepSeek', 'deepseek'),
  ('alibaba', '阿里云', '阿里云'),
  ('zhipuai', '智谱', '智谱'),
  ('xiaomi', '小米 MiMo', '小米 mimo');

ALTER TABLE receipt_attempts ADD COLUMN supplier_id text REFERENCES model_suppliers(id);
