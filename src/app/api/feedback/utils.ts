import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendFeedbackEmail(data: {
  message: string;
  type: string;
  page: string;
  language: string;
  userAgent: string;
}) {
  await resend.emails.send({
    from: 'SteamReveal <onboarding@resend.dev>',
    to: ['walterfelipeberchez@outlook.com'],
    subject: `[Feedback][${data.type}] SteamReveal`,
    html: `
      <p><strong>Message:</strong></p>
      <p>${data.message}</p>
      <hr />
      <p>Page: ${data.page}</p>
      <p>Language: ${data.language}</p>
      <p>User Agent: ${data.userAgent}</p>
    `,
  });
}
