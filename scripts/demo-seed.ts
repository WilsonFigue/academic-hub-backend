// Entorno de DEMOSTRACIÓN para capturas y pruebas visuales. Datos 100 % ficticios, en un esquema aparte.
// Uso: DB_SCHEMA=academic_hub_demo npx tsx scripts/demo-seed.ts
// Nunca escribe en el esquema de trabajo "academic_hub".
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { migrate } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createBlackboardGateway, type BlackboardTransport } from '../src/modules/blackboard/gateway.js';
import { importStudent } from '../src/modules/import/import.service.js';

const config = readConfig();
if (config.dbSchema === 'academic_hub' || !config.dbSchema.endsWith('_demo')) {
  console.error('Usa DB_SCHEMA=academic_hub_demo: este script nunca escribe en el esquema de trabajo.');
  process.exit(1);
}
const DEMO_PASSWORD = 'Demo-academic-hub-2026';
const DAY = 86_400_000;
const at = (days: number, hour = 23, minute = 59) => {
  // Hora de El Salvador (UTC-6) → UTC.
  const date = new Date(Date.now() + days * DAY);
  date.setUTCHours(hour + 6, minute, 0, 0);
  return date.toISOString();
};
const page = (results: unknown[]) => ({ results, paging: { nextPage: '' } });
const SELF = '_9000_1';

const COURSES = [
  { id: '_c1', name: 'CÁLCULO II 01 02-2026', code: 'CAL2-01' },
  { id: '_c2', name: 'BASES DE DATOS I 02 02-2026', code: 'BD1-02' },
  { id: '_c3', name: 'ÉTICA Y SOCIEDAD 01 02-2026', code: 'ETS-01' },
];

type Column = { id: string; name: string; due: number | null; possible: number; category: string; handler?: string; score?: number | null; status?: string; submission?: string; calculated?: boolean };
const COLUMNS: Record<string, Column[]> = {
  _c1: [
    { id: '_c1g1', name: 'Laboratorio 1: Integrales', due: -20, possible: 10, category: 'Assignment.name', score: 9, status: 'GRADED', submission: 'GRADED' },
    { id: '_c1g2', name: 'Parcial 1', due: -12, possible: 100, category: 'Exam.name', score: 82, status: 'GRADED', submission: 'GRADED' },
    { id: '_c1g3', name: 'Tarea: series de potencias', due: 2, possible: 10, category: 'Homework.name' },
    { id: '_c1g4', name: 'Quiz semana 9', due: 5, possible: 20, category: 'Test.name' },
    { id: '_c1g5', name: 'Parcial 2', due: 16, possible: 100, category: 'Exam.name' },
    { id: '_c1g6', name: 'Promedio ciclo 1', due: null, possible: 100, category: '', calculated: true },
  ],
  _c2: [
    { id: '_c2g1', name: 'Modelo entidad-relación', due: -9, possible: 25, category: 'Assignment.name', score: 23, status: 'GRADED', submission: 'GRADED' },
    { id: '_c2g2', name: 'Práctica SQL: consultas', due: -3, possible: 25, category: 'Assignment.name', status: 'NEEDS_GRADING', submission: 'SUBMITTED' },
    { id: '_c2g3', name: 'Foro: normalización', due: -6, possible: 10, category: 'Discussion.name', score: 0, status: 'GRADED', submission: 'PAST_DUE_AUTO_ZERO', handler: 'resource/x-bb-forumlink' },
    { id: '_c2g4', name: 'Proyecto: diseño de base de datos', due: 9, possible: 40, category: 'Assignment.name' },
    { id: '_c2g5', name: 'Examen corto de índices', due: 1, possible: 15, category: 'Test.name' },
  ],
  _c3: [
    { id: '_c3g1', name: 'Ensayo: ética profesional', due: -15, possible: 20, category: 'Assignment.name', score: 18.5, status: 'GRADED', submission: 'GRADED' },
    { id: '_c3g2', name: 'Diario reflexivo', due: 4, possible: 10, category: 'Journal.name', handler: 'resource/x-bb-forumlink' },
    { id: '_c3g3', name: 'Participación en clase', due: null, possible: 10, category: 'Test.name' },
  ],
};

function transport(stage: 'base' | 'changes'): BlackboardTransport {
  const routes: Record<string, unknown> = {
    '/learn/api/v1/users/me': { id: SELF, userName: 'demo.estudiante', givenName: 'Camila', familyName: 'Rivas', emailAddress: 'camila.demo@example.invalid' },
    '/learn/api/v1/users/me/memberships': {
      results: COURSES.map((course, index) => ({
        id: `_m${index}`, userId: SELF, courseId: course.id, role: 'Student', isAvailable: true,
        course: { id: course.id, name: course.name, courseId: course.code, termId: '_t1', isAvailable: true, isOrganization: false,
          term: { id: '_t1', name: 'Ciclo 02-2026', startDate: at(-90, 0, 0), endDate: at(60, 23, 59), isAvailable: true } },
      })),
      paging: { count: COURSES.length },
    },
    '/learn/api/v1/calendars/todo/studentItems': { overdueItems: [], dueTodayItems: [], futureDueItems: [] },
  };
  for (const course of COURSES) {
    const base = `/learn/api/v1/courses/${course.id}`;
    const columns = COLUMNS[course.id]!.map((column) => ({ ...column }));
    if (stage === 'changes' && course.id === '_c1') {
      columns.find((column) => column.id === '_c1g4')!.due = 7;                 // cambio de fecha
      columns.push({ id: '_c1g7', name: 'Tarea extra: aplicaciones', due: 11, possible: 10, category: 'Homework.name' });
    }
    if (stage === 'changes' && course.id === '_c2') {
      const sql = columns.find((column) => column.id === '_c2g2')!;
      Object.assign(sql, { score: 22, status: 'GRADED', submission: 'GRADED' }); // nota publicada
    }
    routes[`${base}/contents/ROOT/children`] = page([
      { id: `${course.id}f1`, parentId: 'ROOT', title: 'Unidad 1: Fundamentos', contentHandler: 'resource/x-bb-folder', position: 0, contentDetail: { 'resource/x-bb-folder': { isFolder: true } } },
      { id: `${course.id}f2`, parentId: 'ROOT', title: 'Unidad 2: Aplicaciones', contentHandler: 'resource/x-bb-folder', position: 1, contentDetail: { 'resource/x-bb-folder': { isFolder: true } } },
      { id: `${course.id}l1`, parentId: 'ROOT', title: 'Programa de la materia', contentHandler: 'resource/x-bb-externallink', position: 2, contentDetail: { 'resource/x-bb-externallink': { url: 'https://example.invalid/programa' } } },
    ]);
    routes[`${base}/contents/${course.id}f1/children`] = page([
      { id: `${course.id}d1`, parentId: `${course.id}f1`, title: 'Presentación de la unidad', contentHandler: 'resource/x-bb-document', position: 0 },
      { id: `${course.id}a1`, parentId: `${course.id}f1`, title: COLUMNS[course.id]![0]!.name, contentHandler: 'resource/x-bb-asmt-test-link', position: 1,
        description: 'Resuelve los ejercicios 1 a 10 y sube tu procedimiento en PDF.' },
      { id: `${course.id}fl`, parentId: `${course.id}f1`, title: 'Guía de estudio', contentHandler: 'resource/x-bb-file', position: 2 },
    ]);
    routes[`${base}/contents/${course.id}f2/children`] = page([
      { id: `${course.id}d2`, parentId: `${course.id}f2`, title: 'Lectura complementaria', contentHandler: 'resource/x-bb-document', position: 0 },
    ]);
    routes[`${base}/gradebook/columns`] = page(columns.map((column, index) => ({
      id: column.id, columnName: column.name, possible: column.possible, position: index,
      dueDate: column.due === null ? undefined : at(column.due),
      contentId: index === 0 ? `${course.id}a1` : undefined,
      scoreProviderHandle: column.calculated ? undefined : column.handler ?? 'resource/x-bb-assessment',
      gradebookCategory: column.category ? { id: `cat-${column.category}`, title: column.category, localizableTitle: { languageKey: column.category } } : undefined,
      calculatedFormula: column.calculated ? { formula: 'A+B', aliases: { A: COLUMNS[course.id]![0]!.id, B: COLUMNS[course.id]![1]!.id } } : undefined,
      isAttemptBased: !column.calculated,
    })));
    routes[`${base}/gradebook/grades`] = page(columns.filter((column) => column.status || column.calculated).map((column) => ({
      id: column.calculated ? null : `${column.id}-grade`, userId: SELF, columnId: column.id, status: column.status,
      effectiveScore: column.score ?? undefined, pointsPossible: column.possible, submissionStatus: { status: column.submission ?? 'NO_STATUS' },
      lastAttemptId: column.status && column.submission !== 'PAST_DUE_AUTO_ZERO' ? `${column.id}-att` : undefined, version: column.score ? 2 : 1,
    })));
    for (const column of columns) {
      if (!column.status || column.submission === 'PAST_DUE_AUTO_ZERO') continue;
      routes[`${base}/gradebook/attempts/${column.id}-att`] = {
        id: `${column.id}-att`, userId: SELF, status: column.status === 'GRADED' ? 'COMPLETED' : 'NEEDS_GRADING',
        attemptDate: at((column.due ?? 0) - 1, 18, 0), attemptReceipt: { receiptId: 'r', submissionDate: at((column.due ?? 0) - 1, 18, 5) },
        attemptLastGradedDate: column.status === 'GRADED' ? at((column.due ?? 0) + 2, 10, 0) : undefined, displayGrade: column.score ? { score: column.score } : undefined,
      };
    }
    routes[`${base}/gradebook/schemas`] = page([]);
    routes[`${base}/gradebook/memberships/_m${COURSES.indexOf(course)}/exceptions`] = page([]);
    routes[`${base}/calendars/calendarItems`] = page(course.id === '_c2'
      ? [{ itemSourceType: 'blackboard.data.calendar.CalendarEntry', itemSourceId: 'ev1', title: 'Clase de repaso (virtual)', startDate: at(3, 18, 0), endDate: at(3, 19, 30) }]
      : []);
    routes[`${base}/announcements`] = page([
      { id: `${course.id}an1`, title: 'Bienvenida al ciclo', body: { rawText: '<p>Revisen el programa.</p>' }, createdDate: at(-80, 9, 0) },
      ...(stage === 'changes' && course.id === '_c3' ? [{ id: `${course.id}an2`, title: 'Cambio de aula para el diario reflexivo', body: { rawText: '<p>Aula 4-B</p>' }, createdDate: at(0, 8, 0) }] : []),
    ]);
  }
  return {
    async get(path) {
      const clean = path.split('?')[0]!;
      return clean in routes ? { status: 200, body: routes[clean] } : { status: 404, body: null };
    },
  };
}

const db = createDatabase(config, requireDatabaseUrl(config), { max: 2 });
try {
  await db.query(`DROP SCHEMA IF EXISTS ${config.dbSchema} CASCADE`);
  await migrate(db);
  const first = await importStudent(db, createBlackboardGateway(transport('base')), () => {});
  const second = await importStudent(db, createBlackboardGateway(transport('changes')), () => {});
  await db.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [first.user.id, await hashPassword(DEMO_PASSWORD)]);
  console.log(`Demo lista en el esquema ${config.dbSchema}: usuario ${first.user.username} / ${DEMO_PASSWORD} (datos ficticios).`);
  console.log(`Línea base: ${first.sync.baseline}; novedades en la segunda importación: ${second.sync.changesRecorded}.`);
} finally {
  await db.close();
}
