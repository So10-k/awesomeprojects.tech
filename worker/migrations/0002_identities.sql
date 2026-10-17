-- Managed (Enterprise Managed Users) accounts we created, linked to the person's GitHub identity.
CREATE TABLE IF NOT EXISTS identities (
  personal_id    INTEGER PRIMARY KEY,   -- the person's GitHub user id (from sign-in)
  personal_login TEXT NOT NULL,
  user_name      TEXT NOT NULL UNIQUE,  -- SCIM userName = SAML NameID
  managed_login  TEXT,                  -- <userName>_<shortcode> on GitHub
  scim_id        TEXT,
  status         TEXT NOT NULL,         -- pending | active | suspended | error
  note           TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS identities_by_login ON identities (lower(personal_login));
