#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const usage = `Usage:
  artifact-share.mjs publish FILE [--title TITLE] [--visibility link|users] [--users IDS | --usernames NAMES]
  artifact-share.mjs update ID FILE [--title TITLE] [--visibility link|users] [--users IDS | --usernames NAMES]
  artifact-share.mjs list | users | get ID | delete ID

Set ARTIFACT_SHARE_URL (including any base path) and ARTIFACT_SHARE_KEY.
Recipient IDs or exact usernames are comma-separated. Node.js 18+ is required.`;

function parse(args) {
  const options = {};
  const positional = [];
  const known = new Set(['title', 'visibility', 'users', 'usernames']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!known.has(name)) throw new Error(`Unknown option: ${arg}`);
    if (name in options) throw new Error(`Duplicate option: ${arg}`);
    if (++i >= args.length || args[i].startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[name] = args[i];
  }
  return { positional, options };
}

const split = value => [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
const idPath = id => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid artifact ID');
  return '/artifacts/' + encodeURIComponent(id);
};

async function main(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { console.log(usage); return; }
  const command = args[0];
  const counts = { publish: 1, update: 2, list: 0, users: 0, get: 1, delete: 1 };
  if (!Object.hasOwn(counts, command)) throw new Error(`Unknown command: ${command}\n${usage}`);
  const { positional, options } = parse(args.slice(1));
  if (positional.length !== counts[command]) throw new Error(usage);
  if (!['publish', 'update'].includes(command) && Object.keys(options).length) throw new Error('Options are only supported for publish and update');
  if ('users' in options && 'usernames' in options) throw new Error('Use either --users or --usernames, not both');
  if ('visibility' in options && !['link', 'users'].includes(options.visibility)) throw new Error('Visibility must be link or users');

  const service = process.env.ARTIFACT_SHARE_URL;
  const key = process.env.ARTIFACT_SHARE_KEY;
  if (!service || !key) throw new Error('Set ARTIFACT_SHARE_URL and ARTIFACT_SHARE_KEY in the environment');
  const url = new URL(service);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('ARTIFACT_SHARE_URL must be an HTTP(S) service URL without credentials, query, or fragment');
  }
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  async function api(path, method = 'GET', payload) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: expected JSON; check the service URL and base path`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error || response.statusText}`);
    return data;
  }
  function fullURL(artifact) {
    const share = new URL(artifact.url, url.origin);
    if (share.origin !== url.origin || !share.pathname.startsWith(url.pathname.replace(/\/+$/, '') + '/s/')) {
      throw new Error('Server returned an unexpected share URL');
    }
    return { ...artifact, url: share.href };
  }
  function summary(artifact) {
    const { content, ...metadata } = fullURL(artifact);
    return metadata;
  }

  let result;
  switch (command) {
    case 'list': result = (await api('/artifacts')).map(summary); break;
    case 'users': result = await api('/users'); break;
    case 'get': result = fullURL(await api(idPath(positional[0]))); break;
    case 'delete': result = await api(idPath(positional[0]), 'DELETE'); break;
    case 'publish':
    case 'update': {
      const file = positional[command === 'update' ? 1 : 0];
      const extension = extname(file).toLowerCase();
      const kind = ['.html', '.htm'].includes(extension) ? 'html' : ['.md', '.markdown'].includes(extension) ? 'md' : null;
      if (!kind) throw new Error('File must have an .html, .htm, .md, or .markdown extension');
      const content = await readFile(file, 'utf8');
      const old = command === 'update' ? await api(idPath(positional[0])) : null;
      const visibility = options.visibility ?? old?.visibility ?? 'link';
      const hasRecipients = 'users' in options || 'usernames' in options;
      if (hasRecipients && visibility !== 'users') throw new Error('Recipient options require --visibility users (or an existing users-only artifact)');
      let recipients = visibility === 'users' ? old?.users ?? [] : [];
      if ('users' in options) recipients = split(options.users);
      if ('usernames' in options) {
        const names = split(options.usernames);
        const users = names.length ? await api('/users') : [];
        recipients = names.map(name => {
          const matches = users.filter(user => user.name === name);
          if (matches.length !== 1) throw new Error(`Username not found or ambiguous: ${name}`);
          return matches[0].id;
        });
      }
      const title = options.title ?? old?.title ?? basename(file);
      if (!title.trim()) throw new Error('Title must not be empty');
      const payload = { title, kind, content, visibility, users: recipients };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 10 * 1024 * 1024) throw new Error('JSON request body exceeds 10 MiB');
      const path = command === 'publish' ? '/artifacts' : idPath(positional[0]);
      result = summary(await api(path, command === 'publish' ? 'POST' : 'PUT', payload));
      break;
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch(error => {
  // Redact the API key even if a remote error message happens to echo it.
  const key = process.env.ARTIFACT_SHARE_KEY;
  let message = error instanceof Error ? error.message : String(error);
  if (key) message = message.split(key).join('[REDACTED]');
  if (error.cause?.code) message += ` (${error.cause.code})`;
  console.error(message);
  process.exitCode = 1;
});
