-- Private requests, their conversation, and the audit log.
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  requester   TEXT NOT NULL,
  form        TEXT NOT NULL,            -- JSON: what they asked for
  state       TEXT NOT NULL,            -- checking | ready | on-hold | needs-changes | rejected | approving | live | cancelled
  manual_hold INTEGER NOT NULL DEFAULT 0,
  review      TEXT,                     -- JSON: the bot's last review { verdict, findings, entry, plan }
  result      TEXT,                     -- JSON: what happened when it went live { pr, guide }
  decided_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_by_state ON requests (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS requests_by_requester ON requests (requester, updated_at DESC);
CREATE INDEX IF NOT EXISTS requests_by_name ON requests (name);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  internal    INTEGER NOT NULL DEFAULT 0, -- 1 = maintainers only
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_by_request ON notes (request_id, created_at);

CREATE TABLE IF NOT EXISTS audit (
  id          TEXT PRIMARY KEY,           -- job id
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  state       TEXT NOT NULL,              -- queued | done | error
  result      TEXT,
  link        TEXT,
  request_id  TEXT
);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit (at DESC);
CREATE INDEX IF NOT EXISTS audit_by_actor ON audit (actor, at DESC);
