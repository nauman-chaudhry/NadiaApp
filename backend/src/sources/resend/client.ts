import axios from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Minimal Resend client — HTTP only, no DB (same convention as the other
 * sources/<name>/client.ts files).
 *
 * Resend will only deliver to arbitrary recipients when the `from` domain is
 * verified on the account; otherwise it restricts delivery to the account
 * owner's own address. `revlogicmedia.com` is the verified domain on this
 * account, which is why REPORT_EMAIL_FROM defaults to it.
 */
export interface EmailAttachment {
  filename: string;
  /** Raw file contents; encoded to base64 here. */
  content: string;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
}): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set — cannot send report email');
  }
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  const { data } = await axios.post<{ id: string }>(
    'https://api.resend.com/emails',
    {
      from: env.REPORT_EMAIL_FROM,
      to,
      subject: opts.subject,
      text: opts.text,
      attachments: (opts.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, 'utf8').toString('base64'),
      })),
    },
    {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 60_000,
    },
  );
  logger.info({ id: data.id, to, subject: opts.subject }, 'email sent');
  return data;
}
