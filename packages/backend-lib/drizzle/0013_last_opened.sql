-- Keep incompatible customer definitions and assignments intact, including on failure.
DO $$
DECLARE conflicting_workspace uuid;
BEGIN
  -- Serialize the check and insert against concurrent property changes.
  LOCK TABLE "UserProperty" IN SHARE ROW EXCLUSIVE MODE;
  SELECT "workspaceId" INTO conflicting_workspace
  FROM "UserProperty"
  WHERE name = 'last_opened'
    AND definition IS DISTINCT FROM '{"type":"Performed","event":"DFEmailOpened","valueSource":"EventTime"}'::jsonb
  LIMIT 1;
  IF conflicting_workspace IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot provision last_opened in workspace %: incompatible existing property. Export and rename it administratively before retrying; no definition or assignments have been replaced.', conflicting_workspace;
  END IF;

  INSERT INTO "UserProperty" (id, "workspaceId", name, definition, status, "updatedAt")
  SELECT gen_random_uuid(), id, 'last_opened',
    '{"type":"Performed","event":"DFEmailOpened","valueSource":"EventTime"}'::jsonb,
    'Running', now()
  FROM "Workspace"
  ON CONFLICT ("workspaceId", name) DO NOTHING;

  UPDATE "UserProperty" SET status = 'Running', "updatedAt" = now()
  WHERE name = 'last_opened'
    AND definition = '{"type":"Performed","event":"DFEmailOpened","valueSource":"EventTime"}'::jsonb
    AND status <> 'Running';
END $$;
