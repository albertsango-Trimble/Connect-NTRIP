// Emails a rover login's connection details to its operator (and company contact).
// Sending needs an SMTP server in the config ("email"); without one the extension opens drafts in the
// person's own email app instead, using the same text.
import nodemailer from 'nodemailer';

/** Who gets a login's details: the operator, with the company contact copied (or the company alone). */
export function recipients(device) {
  const p = device.profile || {};
  const op = p.operatorEmail?.trim();
  const co = p.companyEmail?.trim();
  if (op) return { to: [op], cc: co && co.toLowerCase() !== op.toLowerCase() ? [co] : [] };
  if (co) return { to: [co], cc: [] };
  return { to: [], cc: [] };
}

/**
 * The email for one login. `mounts` are the project's mountpoints ({ name, format }); a login limited to
 * some mountpoints only lists those.
 */
export function compose({ casterName, projectName, host, port, device, password, mounts }) {
  const allowed = device.mountpoints?.length ? mounts.filter(m => device.mountpoints.includes(m.name)) : mounts;
  const who = device.profile?.operatorName || device.profile?.companyName || '';
  const project = projectName || 'your project';
  const lines = [
    who ? `Hi ${who.split(/\s+/)[0]},` : 'Hi,',
    '',
    `Here are the NTRIP correction login details for ${device.label ? `${device.label} (${device.serial})` : device.serial} on ${project}.`,
    '',
    `Project:         ${project}`,
    `Server address:  ${host}`,
    `Port:            ${port}`,
    `Username:        ${device.serial}`,
    `Password:        ${password ?? '(your existing password; ask your site administrator if you don\'t have it)'}`,
    '',
    allowed.length > 1 ? 'Mountpoints (choose the format your receiver uses):' : 'Mountpoint:',
    ...(allowed.length ? allowed.map(m => `  ${m.name.padEnd(16)} ${m.format || ''}`.trimEnd()) : ['  (no base is set up on this project yet)']),
    '',
    'NTRIP version 1 or 2 both work. The username is the receiver\'s serial number.',
    'Please keep these details to yourself: they are for this receiver only.',
    '',
    casterName || 'NTRIP caster',
  ];
  return {
    ...recipients(device),
    subject: `NTRIP login for ${device.label || device.serial} – ${project}`,
    text: lines.join('\n'),
  };
}

let transport = null;
export function emailEnabled(config) {
  return !!(config.email?.host && config.email?.from);
}

export async function sendEmail(config, msg) {
  if (!emailEnabled(config)) throw new Error('Email sending is not set up on the caster');
  const e = config.email;
  transport ??= nodemailer.createTransport({
    host: e.host,
    port: e.port || 587,
    secure: !!e.secure, // true for port 465; 587 upgrades with STARTTLS
    auth: e.user ? { user: e.user, pass: process.env.EMAIL_PASS || e.pass } : undefined,
  });
  return transport.sendMail({
    from: e.from,
    replyTo: e.replyTo || undefined,
    to: msg.to.join(', '),
    cc: msg.cc.length ? msg.cc.join(', ') : undefined,
    subject: msg.subject,
    text: msg.text,
  });
}
