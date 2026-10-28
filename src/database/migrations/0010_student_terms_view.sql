-- 0010 · Períodos del estudiante como vista (no se materializa student_academic_terms).
-- Se derivan de inscripciones → materias → períodos; nunca de los períodos institucionales sueltos.
-- Puede haber varios candidatos a "actual": la vista los marca a todos y expone la preferencia personal.

CREATE VIEW student_terms AS
SELECT
  ea.id                        AS external_account_id,
  ea.user_id,
  t.id                         AS term_id,
  t.institution_id,
  t.external_id                AS term_external_id,
  t.name,
  t.start_at,
  t.end_at,
  t.is_available,
  count(*)::integer            AS course_count,
  (t.start_at IS NOT NULL AND t.end_at IS NOT NULL AND now() BETWEEN t.start_at AND t.end_at) AS is_current_by_date,
  (ea.preferred_current_term_id = t.id) IS TRUE AS is_preferred_current
FROM external_accounts ea
JOIN course_enrollments ce ON ce.external_account_id = ea.id AND ce.status = 'active'
JOIN courses c             ON c.id = ce.course_id
JOIN academic_terms t      ON t.id = c.term_id
WHERE ea.link_status <> 'revoked'
GROUP BY ea.id, ea.user_id, ea.preferred_current_term_id, t.id;
