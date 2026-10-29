// Herramientas de estudio o de trabajo que una actividad pide usar (GeoGebra, Excel, Python…), detectadas en su texto.
// Es una detección determinista por palabras; no usa IA. La usan las guías (para ofrecer GeoGebra solo cuando se pide)
// y el estudio de herramientas.

export interface ToolDef { id: string; label: string; category: 'matemática' | 'ofimática' | 'programación' | 'datos' | 'diseño' | 'redes y electrónica' | 'colaboración' | 'referencias'; pattern: RegExp }

export const TOOLS: ToolDef[] = [
  { id: 'geogebra', label: 'GeoGebra', category: 'matemática', pattern: /geogebra/i },
  { id: 'desmos', label: 'Desmos', category: 'matemática', pattern: /desmos/i },
  { id: 'wolfram', label: 'Wolfram Alpha', category: 'matemática', pattern: /wolfram\s*alpha|wolframalpha/i },
  { id: 'matlab', label: 'MATLAB / Octave', category: 'matemática', pattern: /\bmatlab\b|\boctave\b/i },
  { id: 'calculadora', label: 'Calculadora científica', category: 'matemática', pattern: /calculadora (cient[ií]fica|gr[aá]ficadora)/i },
  { id: 'excel', label: 'Excel / hoja de cálculo', category: 'ofimática', pattern: /\bexcel\b|hojas? de c[aá]lculo|google sheets/i },
  { id: 'word', label: 'Word / documento de texto', category: 'ofimática', pattern: /microsoft word|\bword\b|google docs/i },
  { id: 'powerpoint', label: 'PowerPoint / diapositivas', category: 'ofimática', pattern: /power\s?point|\bppt\b|google slides|diapositivas/i },
  { id: 'python', label: 'Python', category: 'programación', pattern: /\bpython\b/i },
  { id: 'java', label: 'Java', category: 'programación', pattern: /\bjava\b(?!\s?script)/i },
  { id: 'javascript', label: 'JavaScript / web', category: 'programación', pattern: /javascript|\breact\b|node\.?js|desarrollo web|p[aá]ginas? web|sitios? web/i },
  { id: 'c', label: 'C / C++ / C#', category: 'programación', pattern: /c\+\+|\bc#|lenguaje c\b/i },
  { id: 'sql', label: 'SQL / bases de datos', category: 'programación', pattern: /\bsql\b|mysql|postgres|sql server|oracle|mongodb/i },
  { id: 'git', label: 'Git / GitHub', category: 'programación', pattern: /\bgit\b|github|gitlab/i },
  { id: 'ide', label: 'Entorno de desarrollo (VS Code, NetBeans, Eclipse…)', category: 'programación', pattern: /visual studio|vs ?code|netbeans|eclipse|intellij|pycharm/i },
  { id: 'notebook', label: 'Jupyter / Colab', category: 'programación', pattern: /jupyter|colab\b/i },
  { id: 'estadistica', label: 'Software estadístico (SPSS, Minitab, R)', category: 'datos', pattern: /\bspss\b|minitab|r ?studio|statgraphics|\blenguaje r\b/i },
  { id: 'powerbi', label: 'Power BI / Tableau', category: 'datos', pattern: /power ?bi|tableau/i },
  { id: 'canva', label: 'Canva / Figma / diseño', category: 'diseño', pattern: /\bcanva\b|figma|photoshop|illustrator|adobe/i },
  { id: 'diagramas', label: 'Herramienta de diagramas (draw.io, UML, Lucidchart)', category: 'diseño', pattern: /draw\.?io|diagrams\.net|lucidchart|\buml\b|visio\b|bizagi/i },
  { id: 'packet-tracer', label: 'Packet Tracer / simuladores de red', category: 'redes y electrónica', pattern: /packet tracer|gns3|wireshark|\bcisco\b/i },
  { id: 'electronica', label: 'Simuladores de electrónica (Logisim, Proteus, Tinkercad, Arduino)', category: 'redes y electrónica', pattern: /logisim|proteus|tinkercad|arduino|multisim/i },
  { id: 'videollamada', label: 'Videollamada (Teams, Zoom, Meet, Collaborate)', category: 'colaboración', pattern: /\bteams\b|\bzoom\b|google meet|collaborate/i },
  { id: 'kahoot', label: 'Cuestionarios en línea (Kahoot, Quizizz, Mentimeter)', category: 'colaboración', pattern: /kahoot|quizizz|mentimeter|socrative/i },
  { id: 'apa', label: 'Normas de citación (APA, Mendeley, Zotero)', category: 'referencias', pattern: /\bapa\b|mendeley|zotero|referencias bibliogr[aá]ficas|turnitin|antiplagio/i },
];

/** Formatos de entrega que se piden (informe, exposición, video…). */
export const DELIVERABLES: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'informe', label: 'Informe / reporte', pattern: /\binforme|\breporte\b/i },
  { id: 'ensayo', label: 'Ensayo / redacción', pattern: /\bensayo|rese[ñn]a|art[ií]culo|resumen/i },
  { id: 'presentacion', label: 'Presentación / exposición', pattern: /presentaci[oó]n|exposici[oó]n|exponer|defensa/i },
  { id: 'video', label: 'Video', pattern: /\bv[ií]deo|grabaci[oó]n|youtube/i },
  { id: 'infografia', label: 'Infografía / póster / mapa', pattern: /infograf|p[oó]ster|afiche|mapa (conceptual|mental)|cartel/i },
  { id: 'laboratorio', label: 'Laboratorio / práctica', pattern: /laboratorio|pr[aá]ctica/i },
  { id: 'proyecto', label: 'Proyecto', pattern: /\bproyecto/i },
  { id: 'foro', label: 'Foro de discusión', pattern: /\bforo|discusi[oó]n/i },
  { id: 'cuestionario', label: 'Cuestionario / examen en línea', pattern: /cuestionario|examen|parcial|\bquiz\b|\bprueba\b/i },
  { id: 'ejercicios', label: 'Resolución de ejercicios', pattern: /ejercicios|problemas|resolver|resoluci[oó]n/i },
];

export function detectTools(text: string): string[] {
  return TOOLS.filter((tool) => tool.pattern.test(text)).map((tool) => tool.id);
}
export function detectDeliverables(text: string): string[] {
  return DELIVERABLES.filter((item) => item.pattern.test(text)).map((item) => item.id);
}
