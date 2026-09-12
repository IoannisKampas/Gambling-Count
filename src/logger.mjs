// Append-only JSON-lines logger mirrored to the console. Scrubs anything that looks
// like a session token before writing, so tokens never reach the log file even if a
// caller passes one by accident.

import fs from 'node:fs';
import path from 'node:path';

// mask JSESSIONID=<token> and bare "<20+ chars>!<digits>-<hex>" session shapes
function scrub(s) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s
    .replace(/(JSESSIONID=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9_-]{16,}![0-9]{6,}-[0-9a-f]+/g, '<redacted-session>');
}

export function createLogger(file = 'scraper.log') {
  const logPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  function write(level, msg, extra) {
    const line = {
      t: new Date().toISOString(),
      level,
      msg: scrub(msg),
      ...(extra ? JSON.parse(scrub(JSON.stringify(extra))) : {}),
    };
    stream.write(JSON.stringify(line) + '\n');
    const tag = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[2m';
    console.log(tag + '[' + level + ']\x1b[0m', line.msg);
  }

  return {
    path: logPath,
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}
