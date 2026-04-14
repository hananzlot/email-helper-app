-- Add resume_page_token to inbox_sync so sync can resume where it left off
-- Without this column, every sync PUT restarts from page 1 and relies on
-- fast-forward to skip cached messages, which fails near the end of large inboxes
ALTER TABLE "emailHelperV2_inbox_sync"
  ADD COLUMN IF NOT EXISTS resume_page_token TEXT DEFAULT NULL;
