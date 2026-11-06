---
name: staging-db
description: "Staging Postgres runs on db-staging.example.test:5433"
metadata:
  node_type: memory
  type: reference
  originSessionId: 00000000-0000-4000-8000-000000000001
  modified: 2026-10-01T12:00:00.000Z
---

The staging database is Postgres 17 on db-staging.example.test, port 5433 (not the default 5432).
Credentials come from the team vault, never from the repo.
