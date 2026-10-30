// Blackboard guarda los nombres sin tildes ("Hernandez", "Perez"). Esta lista devuelve la tilde SOLO a apellidos muy comunes cuya
// ortografía no deja dudas; no adivina nada más y nunca toca el resto del nombre. Es determinista a propósito: un nombre de persona
// mal "corregido" es peor que uno sin tilde.
const SURNAMES: Record<string, string> = {
  hernandez: 'Hernández', perez: 'Pérez', diaz: 'Díaz', gonzalez: 'González', lopez: 'López', martinez: 'Martínez', rodriguez: 'Rodríguez',
  ramirez: 'Ramírez', fernandez: 'Fernández', sanchez: 'Sánchez', garcia: 'García', gomez: 'Gómez', marquez: 'Márquez', jimenez: 'Jiménez',
  benitez: 'Benítez', alvarez: 'Álvarez', mejia: 'Mejía', rios: 'Ríos', valdes: 'Valdés', saenz: 'Sáenz', velasquez: 'Velásquez', menendez: 'Menéndez',
  gutierrez: 'Gutiérrez', chavez: 'Chávez', ordonez: 'Ordóñez', munoz: 'Muñoz', nunez: 'Núñez', zuniga: 'Zúñiga', pena: 'Peña',
};

/** Devuelve el nombre con la tilde en los apellidos conocidos. Conserva el resto tal cual. */
export function restoreSurnameAccents(name: string): string {
  return name.split(/(\s+)/).map((part) => SURNAMES[part.toLowerCase()] ?? part).join('');
}
