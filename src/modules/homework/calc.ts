// Herramienta «calcular»: aritmética, álgebra lineal y funciones con mathjs, con lo peligroso desactivado.
// Ninguna cifra de una tarea debe salir del cálculo mental del modelo: todo pasa por aquí.
import { all, create } from 'mathjs';

const math = create(all as never);
const evaluate: (expression: string, scope: Record<string, unknown>) => unknown = math.evaluate.bind(math) as never;
const blocked = () => { throw new Error('Función no permitida.'); };
math.import({ import: blocked, createUnit: blocked, reviver: blocked, evaluate: blocked, parse: blocked, simplify: blocked, derivative: blocked, resolve: blocked }, { override: true });

export interface Calculator { run(expressions: unknown): Array<{ expresion: string; resultado: string }> }

function show(value: unknown): string {
  if (math.isFraction(value)) { const f = value as unknown as { s: number | bigint; n: number | bigint; d: number | bigint }; const num = Number(f.s) * Number(f.n); return Number(f.d) === 1 ? String(num) : `${num}/${Number(f.d)}`; }
  if (typeof value === 'function' || value === undefined) return 'sin valor';
  return math.format(value as never, { precision: 12 });
}

/** Cada corrida del agente tiene su propio ámbito de variables, que se conserva entre llamadas. */
export function createCalculator(): Calculator {
  const scope: Record<string, unknown> = {};
  return {
    run(expressions) {
      const list = (Array.isArray(expressions) ? expressions : [expressions]).slice(0, 60);
      return list.map((raw) => {
        const expresion = String(raw ?? '').slice(0, 600);
        try {
          return { expresion, resultado: show(evaluate(expresion, scope)) };
        } catch (error) {
          return { expresion, resultado: `ERROR: ${(error as Error).message.slice(0, 160)}` };
        }
      });
    },
  };
}
