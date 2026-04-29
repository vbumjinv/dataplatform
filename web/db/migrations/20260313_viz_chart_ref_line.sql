CREATE TABLE IF NOT EXISTS dp.viz_chart_ref_line (
  ref_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chart_id bigint NOT NULL REFERENCES dp.viz_chart(chart_id) ON DELETE CASCADE,
  line_type text NOT NULL,
  line_label text,
  line_value numeric(20, 6),
  line_date date,
  line_color text,
  line_width numeric(4, 2) NOT NULL DEFAULT 1.2,
  line_dash text NOT NULL DEFAULT '6 4',
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT viz_chart_ref_line_type_check CHECK (line_type IN ('horizontal', 'vertical')),
  CONSTRAINT viz_chart_ref_line_value_check CHECK (
    (line_type = 'horizontal' AND line_value IS NOT NULL)
    OR (line_type = 'vertical' AND line_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS viz_chart_ref_line_chart_idx
  ON dp.viz_chart_ref_line(chart_id, display_order, ref_line_id);
