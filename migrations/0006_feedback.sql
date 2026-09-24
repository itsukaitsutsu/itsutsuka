-- User feedback from the "Report a problem" button in the footer.
-- Written by POST /api/feedback (worker/index.ts), read by GET /api/feedback (admin token).
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  nickname TEXT,
  ip TEXT,
  category TEXT NOT NULL DEFAULT 'bug' CHECK(category IN ('bug','wrong_answer','typo','other')),
  page TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_created ON feedback (created_at);
SELECT 1;
