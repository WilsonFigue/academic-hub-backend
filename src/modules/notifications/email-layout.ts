// Marco común de los correos de Academic Hub: cabecera con logo, banner con degradado, tarjeta blanca y pie con baja.
// Pensado para correo: tablas, estilos en línea y un solo bloque <style> con la adaptación a pantallas anchas.

export const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Primer nombre con inicial mayúscula (los nombres de Blackboard vienen en MAYÚSCULAS). */
export const firstName = (full: string) => { const first = full.trim().split(/\s+/)[0] ?? full; return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(); };
export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const font = "'Segoe UI',Helvetica,Arial,sans-serif";
export const ink = '#141a24';
export const accent = '#ff5a36';
export const muted = '#5b6270';
export const line = '#eceae4';
export const label = 'font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#c2401f;';
export const th = 'padding:8px 10px;text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#7a8190;background:#faf9f6;';
export const td = `padding:10px;border-top:1px solid ${line};font-size:13px;color:${ink};`;

/** Una fila de la tarjeta (con el margen lateral que se ensancha en pantallas grandes). */
export const row = (inner: string, padding = '12px 20px 0') => `<tr><td class="pad" style="padding:${padding}">${inner}</td></tr>`;
/** Título de sección. */
export const section = (title: string) => row(`<div style="${label}">${esc(title)}</div>`, '24px 20px 0');
/** Píldora de color (fecha, nota...). */
export const pill = (text: string, tone: 'amber' | 'green' | 'blue' | 'red' | 'gray' = 'amber') => {
  const colors = { amber: ['#fff1cc', '#f4dca5', '#8a5a00'], green: ['#e6f6ee', '#bfe5cf', '#1f6b43'], blue: ['#e8f0ff', '#c6d8ff', '#24509e'], red: ['#fdeceb', '#f5c4c0', '#a52a22'], gray: ['#f1f1ee', '#e0dfd9', '#5b6270'] }[tone];
  return `<span style="display:inline-block;padding:4px 10px;border-radius:99px;background:${colors[0]};border:1px solid ${colors[1]};color:${colors[2]};font-size:11px;font-weight:800;white-space:nowrap">${esc(text)}</span>`;
};
/** Tarjeta con título, detalle y una píldora a la derecha. */
export const itemCard = (title: string, detail: string, tag: string) => `<tr><td style="padding:6px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${line};border-radius:12px"><tr>
<td style="padding:11px 14px;font-size:13.5px;line-height:1.35;color:${ink}"><b>${esc(title)}</b><br><span style="font-size:12px;color:#7a8190">${esc(detail)}</span></td>
<td align="right" valign="middle" style="padding:11px 14px 11px 0">${tag}</td></tr></table></td></tr>`;

export function emailShell(options: { banner: string; dateLabel: string; rows: string; footer?: string }): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(options.banner)} · Academic Hub</title>
<style>
  body{margin:0;padding:0}
  @media screen and (min-width:768px){
    .wrap{padding:28px 0 !important}
    .shell{max-width:600px !important;border-radius:18px !important}
    .banner{font-size:26px !important;padding:22px 30px !important}
    .pad{padding-left:32px !important;padding-right:32px !important}
    .big{font-size:44px !important}
    .body-text{font-size:15px !important}
  }
</style></head>
<body style="margin:0;padding:0;background:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1d2433;background-image:linear-gradient(180deg,#141a24,#2f3a52)"><tr><td align="center" class="wrap" style="padding:16px 0 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px"><tr><td align="center" style="padding:14px 12px 16px;font-family:${font}">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="width:38px;height:38px;border-radius:11px;background:${accent};text-align:center;color:#ffffff;font-weight:800;font-size:15px;font-family:${font}" width="38" height="38">AH</td>
      <td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-.01em;font-family:${font}">Academic Hub</td>
    </tr></table>
  </td></tr></table>

  <table role="presentation" class="shell" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px 14px 0 0;overflow:hidden;font-family:${font}">
    <tr><td class="banner" align="center" style="background:${accent};background-image:linear-gradient(135deg,#ff5a36,#ff8a5c);color:#ffffff;padding:16px 20px;font-size:19px;font-weight:800;line-height:1.3">${esc(options.banner)}
      <div style="font-size:12.5px;font-weight:600;opacity:.92;margin-top:2px">${esc(capitalize(options.dateLabel))}</div></td></tr>

${options.rows}
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px"><tr><td align="center" style="padding:18px 16px 26px;font-family:${font};font-size:11.5px;line-height:1.6;color:#aab2c3">
    ${options.footer ?? 'Resumen automático de Academic Hub.'} <a href="*|UNSUB|*" style="color:#ffffff">Darte de baja</a><br>*|HTML:LIST_ADDRESS_HTML|*
  </td></tr></table>
</td></tr></table>
</body></html>`;
}
