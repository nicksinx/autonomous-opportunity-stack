CREATE OR REPLACE VIEW v_score_factor_breakdown AS
SELECT
  os.opportunity_id,
  os.score_id,
  osf.factor_name,
  osf.raw_value,
  osf.weight,
  osf.factor_value,
  osf.factor_reason
FROM opportunity_score os
JOIN opportunity_score_factor osf ON osf.score_id = os.score_id;
