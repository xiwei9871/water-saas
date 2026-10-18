-- report_query_template shipped without RLS (stage-3 follow-up): enforce the
-- same tenant_isolation policy + ownership as every other tenant table.
ALTER TABLE "report_query_template" OWNER TO ws_owner;
ALTER TABLE "report_query_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_query_template" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_query_template"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
