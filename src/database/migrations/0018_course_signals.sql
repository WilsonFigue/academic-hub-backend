-- 0018 · Avisos de Blackboard por materia (solo contadores; no se guarda el contenido de mensajes ni foros).
-- Blackboard ya sabe qué tiene el estudiante sin ver: notas nuevas, mensajes, anuncios y foros con novedades.
-- Una fila por inscripción, se reemplaza en cada actualización.

CREATE TABLE course_signals (
  enrollment_id         uuid PRIMARY KEY REFERENCES course_enrollments (id) ON DELETE CASCADE,
  unread_grades         integer CHECK (unread_grades IS NULL OR unread_grades >= 0),
  announcements_unread  integer CHECK (announcements_unread IS NULL OR announcements_unread >= 0),
  announcements_posted  integer CHECK (announcements_posted IS NULL OR announcements_posted >= 0),
  conversations_total   integer CHECK (conversations_total IS NULL OR conversations_total >= 0),
  conversations_unread  integer CHECK (conversations_unread IS NULL OR conversations_unread >= 0),
  forum_unread          integer CHECK (forum_unread IS NULL OR forum_unread >= 0),
  content_with_news     integer CHECK (content_with_news IS NULL OR content_with_news >= 0),  -- elementos de contenido con indicador de novedad
  captured_at           timestamptz NOT NULL DEFAULT now()
);
