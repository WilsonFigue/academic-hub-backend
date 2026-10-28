// Validación de coherencia sobre los datos reales (solo conteos y booleanos; nunca nombres ni notas).
import { readConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { createAcademicRepository } from '../src/modules/academic/academic.repository.js';

const config = readConfig();
const db = createDatabase(config, config.databaseUrl!, { max: 2 });
const repo = createAcademicRepository(db);
const KNOWN_CATEGORIES = new Set(['Test.name', 'Exam.name', 'Assignment.name', 'Homework.name', 'Discussion.name', 'Journal.name']);

const users = await db.query<{ id: string }>(`SELECT DISTINCT u.id FROM users u JOIN external_accounts ea ON ea.user_id = u.id ORDER BY u.id`);
let index = 0;
for (const { id } of users.rows) {
  index += 1;
  const [courses, activities, grades, calendar, terms] = await Promise.all([
    repo.courses(id), repo.activities(id), repo.activities(id, { includeCalculated: true }),
    repo.calendar(id, new Date('2026-01-01'), new Date('2027-12-31')), repo.terms(id),
  ]);
  const activityIds = new Set(activities.map((a) => a.id as string));
  const calendarActivities = calendar.filter((item) => item.type === 'activity');
  const calendarIds = calendarActivities.map((item) => item.id as string);
  const ownEnrollmentCourses = new Set(courses.map((c) => c.id as string));
  const unknownCategories = [...new Set(grades.map((g) => g.categoryKey as string | null).filter((key): key is string => Boolean(key) && !KNOWN_CATEGORIES.has(key!)))];
  const sqlActivities = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM student_grades sg JOIN course_enrollments ce ON ce.id = sg.enrollment_id JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
      WHERE ea.user_id = $1 AND ce.status = 'active' AND NOT gc.is_calculated AND NOT gc.is_deleted_at_source AND sg.is_visible_to_student`, [id]);
  console.log(JSON.stringify({
    user: `usuario ${index}`,
    terms: terms.length,
    courses: courses.length,
    activities: activities.length,
    activitiesMatchSql: activities.length === sqlActivities.rows[0]!.n,
    calculatedExcludedFromActivities: activities.every((a) => !a.isCalculated),
    gradesIncludingCalculated: grades.length,
    calendarActivityItems: calendarActivities.length,
    calendarHasDuplicates: new Set(calendarIds).size !== calendarIds.length,
    calendarOnlyOwnActivities: calendarIds.every((cid) => activityIds.has(cid)),
    calendarEventsIndependent: calendar.filter((item) => item.type === 'event').length,
    allActivitiesFromOwnCourses: activities.every((a) => ownEnrollmentCourses.has(a.courseId as string)),
    unknownCategoryKeys: unknownCategories.length,
    materialRepeatsTitle: grades.filter((g) => g.content && (g.content as { description: string | null }).description === null).length,
    materialWithRealText: grades.filter((g) => g.content && (g.content as { description: string | null }).description !== null).length,
  }));
}
await db.close();
