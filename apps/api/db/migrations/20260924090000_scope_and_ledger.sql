-- migrate:up

-- Область дії ключа (connectors.md §3). Рядок — (продукт, адаптер, акаунт,
-- розмови, read|write). Продукт без рядків — ПОРОЖНЯ область, а не «усе».
-- Рядки кладе людина (README продукту, «Видати область»); API видачі немає
-- навмисно: політику не пише той, кого вона обмежує.
CREATE TABLE social_scope (
  id            bigserial   PRIMARY KEY,
  product       text        NOT NULL,
  adapter       text        NOT NULL,
  account       text        NOT NULL,
  -- ref шлюзу (<адаптер>:<акаунт>:<id>) або рівно {*} — «усе, що бачить
  -- акаунт адаптера». Змішати * з ref не можна: такий рядок читався б двояко.
  conversations text[]      NOT NULL,
  access        text        NOT NULL,
  -- Хто і чому відкрив: «власник у чаті 2026-09-24», а не порожньо.
  granted_by    text        NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_scope_access_chk CHECK (access IN ('read', 'write')),
  CONSTRAINT social_scope_conversations_chk CHECK (
    cardinality(conversations) > 0
    AND (conversations = ARRAY['*']::text[] OR NOT ('*' = ANY (conversations)))
  ),
  CONSTRAINT social_scope_one_row_uq UNIQUE (product, adapter, account, access)
);

-- Облік: рядок на виклик інструмента, і на відмову теж — з відмов видно, що
-- продукт стукає туди, куди йому не відкрито.
CREATE TABLE social_call (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  product       text        NOT NULL,
  transport     text        NOT NULL,   -- rest | mcp (stdio-міст — теж mcp)
  tool          text        NOT NULL,
  adapter       text,
  account       text,
  conversation  text,
  outcome       text        NOT NULL,   -- ok | not_found | bad_request | quota | rate_limited | expired | unavailable | error
  items         integer     NOT NULL DEFAULT 0,
  bytes         integer     NOT NULL DEFAULT 0,
  truncated     boolean     NOT NULL DEFAULT false,
  latency_ms    integer     NOT NULL,
  detail        text
);

CREATE INDEX social_call_at_idx         ON social_call (at DESC);
CREATE INDEX social_call_product_at_idx ON social_call (product, at DESC);

-- migrate:down
DROP TABLE social_call;
DROP TABLE social_scope;
