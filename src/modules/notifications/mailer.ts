// Envío de correo con Mailchimp (API normal). Cada correo es una campaña dirigida a UNA sola persona:
// se asegura el contacto en la audiencia, se le arma un segmento propio y, antes de enviar, se comprueba que
// la campaña tenga exactamente un destinatario. Si no, se borra y no sale nada.
import { createHash } from 'node:crypto';

export interface Mail { to: string; toName?: string; subject: string; html: string; text: string }
export class MailError extends Error { constructor(readonly code: string, message?: string) { super(message ?? code); this.name = 'MailError'; } }
export interface Mailer { configured: boolean; send(mail: Mail): Promise<{ ref: string }> }

export const notConfiguredMailer: Mailer = { configured: false, async send() { throw new MailError('mail_not_configured', 'Mailchimp no está configurado.'); } };

const md5 = (value: string) => createHash('md5').update(value.trim().toLowerCase()).digest('hex');

export function createMailchimpMailer(options: { apiKey: string; listId?: string | null; fromName: string; fetchFn?: typeof fetch }): Mailer {
  const dc = options.apiKey.split('-')[1];
  if (!dc || !/^[a-z]{2}\d{1,3}$/.test(dc)) throw new MailError('mail_bad_key', 'La llave de Mailchimp no tiene el formato esperado (…-usNN).');
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const doFetch = options.fetchFn ?? fetch;
  const auth = `Basic ${Buffer.from(`ah:${options.apiKey}`).toString('base64')}`;
  let audience: { id: string; fromEmail: string } | null = null;

  async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const response = await doFetch(`${base}${path}`, { method, headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let data = {} as T;
    try { data = text ? JSON.parse(text) as T : data; } catch { /* respuesta sin JSON */ }
    if (!response.ok && !okStatuses.includes(response.status)) {
      const title = (data as { title?: string }).title;
      throw new MailError(`mailchimp_${response.status}`, `Mailchimp respondió ${response.status}${title ? `: ${title}` : ''}.`);
    }
    return { status: response.status, data };
  }

  async function resolveAudience() {
    if (audience) return audience;
    const { data } = await call<{ lists: Array<{ id: string; campaign_defaults: { from_email: string } }> }>('GET', '/lists?count=20&fields=lists.id,lists.campaign_defaults.from_email');
    const list = options.listId ? data.lists.find((l) => l.id === options.listId) : data.lists.length === 1 ? data.lists[0] : undefined;
    if (!list) throw new MailError('mail_audience', options.listId ? 'No se encontró la audiencia indicada en MAILCHIMP_LIST_ID.' : 'Hay más de una audiencia: define MAILCHIMP_LIST_ID.');
    audience = { id: list.id, fromEmail: list.campaign_defaults.from_email };
    return audience;
  }

  return {
    configured: true,
    async send(mail) {
      const list = await resolveAudience();
      const hash = md5(mail.to);
      // 1. Contacto suscrito (si pidió darse de baja, se respeta y no se envía).
      const first = (mail.toName ?? '').trim().split(/\s+/)[0] ?? '';
      const member = await call<{ status: string }>('PUT', `/lists/${list.id}/members/${hash}`, { email_address: mail.to, status_if_new: 'subscribed', merge_fields: first ? { FNAME: first } : {} });
      if (member.data.status !== 'subscribed') throw new MailError('mail_unsubscribed', `El contacto está en estado «${member.data.status}»: no se le envía.`);
      // 2. Segmento propio de ese contacto.
      const name = `ah-${hash.slice(0, 12)}`;
      const found = await call<{ segments: Array<{ id: number; name: string }> }>('GET', `/lists/${list.id}/segments?type=static&count=200&fields=segments.id,segments.name`);
      let segmentId = found.data.segments.find((s) => s.name === name)?.id;
      if (segmentId === undefined) segmentId = (await call<{ id: number }>('POST', `/lists/${list.id}/segments`, { name, static_segment: [mail.to] })).data.id;
      else await call('POST', `/lists/${list.id}/segments/${segmentId}/members`, { email_address: mail.to }, [400]);
      // 3. Campaña a ese segmento, con comprobación de un solo destinatario.
      const created = await call<{ id: string }>('POST', '/campaigns', {
        type: 'regular',
        recipients: { list_id: list.id, segment_opts: { match: 'all', conditions: [{ condition_type: 'StaticSegment', field: 'static_segment', op: 'static_is', value: segmentId }] } },
        settings: { subject_line: mail.subject.slice(0, 150), title: `Academic Hub · ${mail.subject}`.slice(0, 95), from_name: options.fromName, reply_to: list.fromEmail },
      });
      const campaignId = created.data.id;
      try {
        const count = (await call<{ recipients?: { recipient_count?: number } }>('GET', `/campaigns/${campaignId}?fields=recipients.recipient_count`)).data.recipients?.recipient_count;
        if (count !== 1) throw new MailError('mail_segment_mismatch', `La campaña tenía ${count ?? '?'} destinatarios en lugar de 1; no se envió.`);
        await call('PUT', `/campaigns/${campaignId}/content`, { html: mail.html, plain_text: mail.text });
        const checklist = (await call<{ is_ready: boolean; items?: Array<{ type: string; heading: string; details: string }> }>('GET', `/campaigns/${campaignId}/send-checklist`)).data;
        if (!checklist.is_ready) {
          const why = (checklist.items ?? []).filter((item) => item.type === 'error').map((item) => `${item.heading}: ${item.details}`).join(' | ');
          throw new MailError('mail_not_ready', `Mailchimp no deja enviar todavía. ${why}`.slice(0, 400));
        }
        await call('POST', `/campaigns/${campaignId}/actions/send`, {}, [204]);
      } catch (error) {
        await call('DELETE', `/campaigns/${campaignId}`, undefined, [404]).catch(() => {});
        throw error;
      }
      return { ref: campaignId };
    },
  };
}
