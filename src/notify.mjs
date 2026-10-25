const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const project = required('REPAIR_PROJECT');
const url = required('REVIEW_URL');
const status = required('VALIDATION_STATUS');
const response = await fetch('https://api.resend.com/emails', {
  method: 'POST', signal: AbortSignal.timeout(30_000),
  headers: { Authorization: `Bearer ${required('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `monitor-review-${required('REVIEW_RUN_ID')}` },
  body: JSON.stringify({
    from: required('MONITOR_EMAIL_FROM'), to: [required('MONITOR_EMAIL_TO')],
    subject: `[${project}] Agent review ready — validation ${status}`,
    text: `The monitoring agent finished investigating ${project}.\n\nIndependent validation: ${status}. A successful validation can also mean diagnosis only; check whether repair.patch contains a change.\n\nReview the diagnosis, patch artifact and validation logs: ${url}\n\nPlease review and approve any code commit. No code has been committed, pushed, merged or deployed by this workflow. If validation failed or the patch is empty, manual troubleshooting is still required.`,
  }),
});
if (!response.ok) throw new Error(`Review email failed: Resend HTTP ${response.status}`);
console.log('Review email accepted by Resend');
