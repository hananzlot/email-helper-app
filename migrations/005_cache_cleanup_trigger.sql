-- Trigger function: when an action (trash/archive/delete) is logged to action_history,
-- automatically delete those message IDs from inbox_cache.
-- This is the most reliable approach — runs at the database level, can't be bypassed.

CREATE OR REPLACE FUNCTION cleanup_inbox_cache_on_action()
RETURNS TRIGGER AS $$
BEGIN
  -- Only clean for destructive actions
  IF NEW.action IN ('trash', 'archive', 'delete') AND NEW.undone = false THEN
    DELETE FROM "emailHelperV2_inbox_cache"
    WHERE gmail_id = ANY(NEW.message_ids);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_cleanup_cache_on_action ON "emailHelperV2_action_history";

-- Create trigger on action_history INSERT
CREATE TRIGGER trg_cleanup_cache_on_action
  AFTER INSERT ON "emailHelperV2_action_history"
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_inbox_cache_on_action();

-- Also handle undo: when undone is set to true, the cache cleanup already happened,
-- and the sync will re-cache the message on the next run. No action needed.
