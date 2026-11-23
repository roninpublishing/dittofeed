-- Never replace a user-defined property or its assignments to claim this name.
DO $$
DECLARE conflicting_workspace uuid;
BEGIN
  SELECT "workspaceId" INTO conflicting_workspace
  FROM "UserProperty"
  WHERE name = 'last_clicked'
    AND definition <> '{"type":"Performed","event":"DFEmailClicked","valueSource":"EventTime"}'::jsonb
  LIMIT 1;
  IF conflicting_workspace IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot provision last_clicked in workspace %: incompatible existing property. Export and rename it administratively before retrying; no definition or assignments have been replaced.', conflicting_workspace;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "UserProperty" (id, "workspaceId", name, definition, status, "updatedAt")
SELECT gen_random_uuid(), id, 'last_clicked',
  '{"type":"Performed","event":"DFEmailClicked","valueSource":"EventTime"}'::jsonb,
  'Running', now()
FROM "Workspace"
ON CONFLICT ("workspaceId", name) DO NOTHING;
--> statement-breakpoint
UPDATE "UserProperty" SET status = 'Running', "updatedAt" = now()
WHERE name = 'last_clicked'
  AND definition = '{"type":"Performed","event":"DFEmailClicked","valueSource":"EventTime"}'::jsonb
  AND status <> 'Running';
