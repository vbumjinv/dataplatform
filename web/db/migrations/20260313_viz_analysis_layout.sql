CREATE TABLE IF NOT EXISTS dp.viz_analysis_layout (
  chart_id bigint PRIMARY KEY REFERENCES dp.viz_chart(chart_id) ON DELETE CASCADE,
  layout_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION dp.viz_analysis_layout_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS viz_analysis_layout_updated_at_trigger ON dp.viz_analysis_layout;
CREATE TRIGGER viz_analysis_layout_updated_at_trigger
  BEFORE UPDATE ON dp.viz_analysis_layout
  FOR EACH ROW
  EXECUTE PROCEDURE dp.viz_analysis_layout_updated_at();
