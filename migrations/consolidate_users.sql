-- Consolidate all Chanan's duplicate users into primary user 94ba80ae-0767-4034-83eb-40c9ea339c08
-- Duplicate users: 9a7cca8c, 2b38e637, 643cc426
-- Gina (80283bc6) is untouched

DO $$
DECLARE
  target_uid UUID := '94ba80ae-0767-4034-83eb-40c9ea339c08';
  dup_uids UUID[] := ARRAY['9a7cca8c-13a9-4c10-9dc8-0c59108d715d'::UUID, '2b38e637-1a7f-49b6-8a05-d47f4bb8478e'::UUID, '643cc426-d8b4-454e-8c20-7a78a606884c'::UUID];
  uid UUID;
BEGIN
  FOREACH uid IN ARRAY dup_uids LOOP

    -- 1. Gmail accounts: add urc1.com (only one not already under target)
    --    For accounts that already exist under target, just delete the duplicate
    DELETE FROM "emailHelperV2_gmail_accounts"
    WHERE user_id = uid
      AND email IN (SELECT email FROM "emailHelperV2_gmail_accounts" WHERE user_id = target_uid);

    UPDATE "emailHelperV2_gmail_accounts"
    SET user_id = target_uid, is_primary = false
    WHERE user_id = uid;

    -- 2. Sender priorities: merge — keep higher reply_count, keep better tier
    --    For duplicates, update target if the dup has more data, then delete dup
    UPDATE "emailHelperV2_sender_priorities" AS target
    SET
      reply_count = GREATEST(target.reply_count, dup.reply_count),
      tier = CASE
        WHEN (CASE target.tier WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) >=
             (CASE dup.tier WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END)
        THEN target.tier ELSE dup.tier
      END,
      updated_at = NOW()
    FROM "emailHelperV2_sender_priorities" AS dup
    WHERE target.user_id = target_uid
      AND dup.user_id = uid
      AND target.sender_email = dup.sender_email;

    -- Delete sender priorities that were merged (exist in both)
    DELETE FROM "emailHelperV2_sender_priorities"
    WHERE user_id = uid
      AND sender_email IN (SELECT sender_email FROM "emailHelperV2_sender_priorities" WHERE user_id = target_uid);

    -- Move remaining sender priorities (only in dup, not in target)
    UPDATE "emailHelperV2_sender_priorities"
    SET user_id = target_uid
    WHERE user_id = uid;

    -- 3. Reply queue: move non-duplicate items, delete conflicts
    DELETE FROM "emailHelperV2_reply_queue"
    WHERE user_id = uid
      AND message_id IN (SELECT message_id FROM "emailHelperV2_reply_queue" WHERE user_id = target_uid);

    UPDATE "emailHelperV2_reply_queue"
    SET user_id = target_uid
    WHERE user_id = uid;

    -- 4. Triage results: keep target's, delete dup's
    DELETE FROM "emailHelperV2_triage_results"
    WHERE user_id = uid;

    -- 5. Follow-up cache: keep target's, delete dup's (will be refreshed by cron)
    DELETE FROM "emailHelperV2_follow_up_cache"
    WHERE user_id = uid;

    -- 6. Action history: move all
    UPDATE "emailHelperV2_action_history"
    SET user_id = target_uid::TEXT
    WHERE user_id = uid::TEXT;

    -- 7. User profiles: delete duplicate
    DELETE FROM "emailHelperV2_user_profiles"
    WHERE id = uid;

  END LOOP;
END $$;
