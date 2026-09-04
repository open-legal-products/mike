-- Migration date: 2026-09-02
-- Idempotent provisioning for the built-in Legal Data Hunter feature.
-- Duplicate rows and OAuth tokens are preserved; only one canonical connector
-- is enabled when the user turns the feature on.

CREATE OR REPLACE FUNCTION public.ensure_legal_data_hunter_connector(
  p_user_id uuid
)
RETURNS SETOF public.user_mcp_connectors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected public.user_mcp_connectors%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mike:legal-data-hunter:' || p_user_id::text, 0)
  );

  SELECT connector.*
  INTO selected
  FROM public.user_mcp_connectors AS connector
  WHERE connector.user_id = p_user_id
    AND regexp_replace(
      split_part(split_part(connector.server_url, '?', 1), '#', 1),
      '^https://legaldatahunter[.]com[.]?(:0*443)?',
      '',
      'i'
    ) ~ '^/+(m|%6[dD])(c|%63)(p|%70)/*$'
  ORDER BY
    EXISTS (
      SELECT 1
      FROM public.user_mcp_oauth_tokens AS token
      WHERE token.connector_id = connector.id
        AND (
          token.encrypted_access_token IS NOT NULL
          OR token.encrypted_refresh_token IS NOT NULL
        )
    ) DESC,
    connector.enabled DESC,
    connector.updated_at DESC,
    connector.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF selected.id IS NULL THEN
    INSERT INTO public.user_mcp_connectors (
      user_id,
      name,
      transport,
      server_url,
      auth_type,
      enabled,
      tool_policy
    )
    VALUES (
      p_user_id,
      'Legal Data Hunter',
      'streamable_http',
      'https://legaldatahunter.com/mcp',
      'none',
      false,
      '{}'::jsonb
    )
    RETURNING * INTO selected;
  ELSE
    UPDATE public.user_mcp_connectors
    SET name = 'Legal Data Hunter',
        server_url = 'https://legaldatahunter.com/mcp',
        enabled = EXISTS (
          SELECT 1
          FROM public.user_mcp_oauth_tokens AS token
          WHERE token.connector_id = selected.id
            AND (
              token.encrypted_access_token IS NOT NULL
              OR token.encrypted_refresh_token IS NOT NULL
            )
        ),
        updated_at = now()
    WHERE id = selected.id
    RETURNING * INTO selected;
  END IF;

  UPDATE public.user_mcp_connectors
  SET enabled = false,
      updated_at = now()
  WHERE user_id = p_user_id
    AND regexp_replace(
      split_part(split_part(server_url, '?', 1), '#', 1),
      '^https://legaldatahunter[.]com[.]?(:0*443)?',
      '',
      'i'
    ) ~ '^/+(m|%6[dD])(c|%63)(p|%70)/*$'
    AND id <> selected.id
    AND enabled = true;

  RETURN NEXT selected;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_legal_data_hunter_connector(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_legal_data_hunter_connector(uuid)
  TO service_role;
