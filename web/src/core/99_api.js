// ---------------------------------------------------------------- the core's public surface
const CORE = {
  PRODUCT_NAME, FORMAT, VERSION, SchedError, ACT_TYPES, REL_TYPES, CSTR_TYPES, PCT_TYPES, RSRC_TYPES, SETTINGS, INT_SETTINGS, LIMITS, DAY,
  days_from_civil, civil_from_days, weekday, parse_dt, fmt_dt, fmt_day, parse_day, fmt_hm, fmt_fixed, round_div, norm_intervals, compile_calendar, full_day_calendar, standard_week,
  validate_project, new_project, clean_text,
  schedule, topo_order, status_of, pct_complete, wbs_rollup, tree_rows, Ctx, forward_one,
  propose_update, apply_update, take_baseline, variance,
  histogram, leveling_suggestions, apply_leveling,
  check, apply_fix, open_ends,
  decode_bytes, encode_cp1252, parse_xml, xml_escape,
  parse_tables, parse_clndr_data, read_xer, write_xer,
  parse_duration, read_mspdi, write_mspdi,
  detect, parse_json, open_file, compare_stored, export_csv, open_and_schedule,
  render_pdf,
};
