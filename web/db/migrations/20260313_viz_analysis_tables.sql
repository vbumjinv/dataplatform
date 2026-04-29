CREATE TABLE IF NOT EXISTS dp.viz_analysis (
  analysis_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_name text NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dp.viz_analysis_series (
  analysis_id bigint NOT NULL REFERENCES dp.viz_analysis(analysis_id) ON DELETE CASCADE,
  series_id varchar(120) NOT NULL REFERENCES dp.viz_series(series_id) ON DELETE CASCADE,
  display_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (analysis_id, series_id)
);

CREATE TABLE IF NOT EXISTS dp.viz_analysis_widget_layout (
  analysis_id bigint PRIMARY KEY REFERENCES dp.viz_analysis(analysis_id) ON DELETE CASCADE,
  layout_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION dp.viz_analysis_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS viz_analysis_updated_at_trigger ON dp.viz_analysis;
CREATE TRIGGER viz_analysis_updated_at_trigger
  BEFORE UPDATE ON dp.viz_analysis
  FOR EACH ROW
  EXECUTE PROCEDURE dp.viz_analysis_updated_at();

CREATE OR REPLACE FUNCTION dp.viz_analysis_widget_layout_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS viz_analysis_widget_layout_updated_at_trigger ON dp.viz_analysis_widget_layout;
CREATE TRIGGER viz_analysis_widget_layout_updated_at_trigger
  BEFORE UPDATE ON dp.viz_analysis_widget_layout
  FOR EACH ROW
  EXECUTE PROCEDURE dp.viz_analysis_widget_layout_updated_at();
