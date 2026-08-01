/**
 * One-shot configuration of the Open WebUI demo instance.
 *
 * Open WebUI keeps tool-server connections in its own database, not in the
 * environment: there is no TOOL_SERVER_CONNECTIONS variable to set, only
 * `Config.get('tool_server.connections')` behind an admin-authenticated REST
 * route. So "bring the stack up and the tool is already there" has to be done
 * by driving that route once, which is what this script does.
 *
 * Idempotent by design. It signs up the first admin when the instance is empty
 * and signs in when it is not, and it replaces the connection carrying our id
 * rather than appending a second copy, so `up` twice does not produce two
 * identical tool servers.
 *
 * Plain Node ESM with no dependencies — same shape as scripts/copy-assets.mjs.
 * Everything it needs arrives through the environment; it writes nothing to
 * disk and bakes no secret into any image.
 */

const BASE = (process.env['OWUI_URL'] ?? 'http://open-webui:8080').replace(/\/+$/, '');
const EMAIL = process.env['OWUI_ADMIN_EMAIL'] ?? 'admin@example.com';
const PASSWORD = process.env['OWUI_ADMIN_PASSWORD'] ?? 'please-change-me';
const NAME = process.env['OWUI_ADMIN_NAME'] ?? 'Demo Admin';

const TOOL_URL = process.env['MCPO_URL'] ?? 'http://mcpo:8000/ragkb';
const TOOL_KEY = process.env['MCPO_API_KEY'] ?? 'demo-mcpo-key';
const TOOL_ID = process.env['MCPO_SERVER_ID'] ?? 'ragkb';

const BASE_MODEL = (process.env['OWUI_BASE_MODEL'] ?? '').trim();
const MODEL_ID = (process.env['OWUI_MODEL_ID'] ?? 'mongodb-kb').trim();
const OLLAMA_URL = (process.env['OLLAMA_BASE_URL'] ?? '').trim();

const SYSTEM_PROMPT = [
  'You have a persistent knowledge base backed by MongoDB Vector Search. It outlives',
  'this conversation and is shared with other sessions and agents. Treat it as long-term',
  'memory, not as a scratchpad.',
  '',
  'SEARCH FIRST. Before answering anything that touches project-specific material — internal',
  'docs, design decisions, API contracts, runbooks, prior debugging — call the search tool',
  'before answering from memory. Prefer what you retrieve over what you recall, and cite the',
  'sourceId of anything you use so a human can verify it.',
  '',
  'If a search returns nothing, say so plainly rather than filling the gap from general',
  'knowledge. Try a rephrasing first: different wording produces a different embedding.',
  '',
  'STORE WHAT LASTS. When you resolve something a future session would want — a bug and its',
  'cause, a decision and its rationale, an interface contract — store it. Store the durable',
  'artefact, not the conversation around it. Ask before storing anything long.',
  '',
  'When storing, contentType is one of: markdown, text, code, html, json. It is not a MIME',
  'type — send "markdown", not "text/markdown".',
  '',
  'CHECK BEFORE YOU WRITE. Search for an existing document on the topic first. If one exists,',
  're-store it under the SAME sourceId with improved content instead of creating a',
  'near-duplicate; duplicates split the ranking between them. Storing is idempotent per',
  'sourceId, so re-storing identical content is a harmless no-op.',
  '',
  'Never delete anything unless explicitly asked. Deleting by tag can remove many documents',
  'at once and cannot be undone.',
].join('\n');

/** Returns the status and parsed body; an error status is data, not an exception. */
async function call(path, { body, token, method } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}

/**
 * Wait for Open WebUI and return its config.
 *
 * Deliberately polls /api/config rather than /health. The container reports
 * healthy while the app is still coming up, and during that window /api/config
 * answers without a `features` block — which reads as "auth is enabled" and
 * sends us down the signup path on an instance that has auth switched off.
 * Waiting for the field we actually branch on removes the race.
 */
async function waitForOpenWebUi(attempts = 60, delayMs = 3000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/config`);
      if (response.ok) {
        const config = await response.json();
        if (config?.features) {
          console.log(`  Open WebUI is up (after ${attempt} attempt(s))`);
          return config;
        }
      }
    } catch {
      // Not listening yet. Keep waiting; the caller reports the timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Sign up the first admin, or sign in when the instance is already seeded.
 *
 * When sign-in is disabled we must NOT sign up. Open WebUI's no-auth path signs
 * in as a built-in `admin@localhost` and creates it on demand, but only while
 * the database has no other users — otherwise it refuses to start with auth off
 * ("You can't turn off authentication because there are existing users").
 * Signing up here would create exactly such a user and break the *next* boot of
 * the very stack we just configured. Signing in instead makes Open WebUI create
 * its own account, which it is happy to see on subsequent starts.
 */
async function authenticate(authDisabled) {
  if (authDisabled) {
    console.log('  sign-in is disabled — using the built-in admin');
  } else {
    const signup = await call('/api/v1/auths/signup', {
      body: { name: NAME, email: EMAIL, password: PASSWORD },
    });
    if (signup.status === 200 && signup.body.token) {
      console.log(`  created admin account ${EMAIL}`);
      return signup.body.token;
    }
  }

  const signin = await call('/api/v1/auths/signin', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (signin.status === 200 && signin.body.token) {
    console.log(`  signed in as existing admin ${EMAIL}`);
    return signin.body.token;
  }

  console.error(`  ERROR: could not authenticate (signin returned ${signin.status})`);
  console.error('  If you created an account by hand, set OWUI_ADMIN_EMAIL and');
  console.error('  OWUI_ADMIN_PASSWORD to match it.');
  return null;
}

/**
 * Push the Ollama URL into Open WebUI's own configuration.
 *
 * OLLAMA_BASE_URL is a PersistentConfig: the environment seeds it on first boot
 * and Open WebUI then keeps it in its database, where it wins from that point
 * on. Change the variable afterwards and nothing happens — the container has
 * the new value, the UI still shows the old one, and the only ways out are
 * wiping the volume or editing it by hand in admin settings.
 *
 * Writing it on every run makes whatever the operator passed to run.sh the
 * value that actually takes effect.
 */
async function seedOllamaUrl(token) {
  if (OLLAMA_URL.length === 0) {
    console.log('  OLLAMA_BASE_URL not passed to the seeder — leaving it as configured');
    return;
  }

  const current = await call('/ollama/config', { token });
  const configured = current.body?.OLLAMA_BASE_URLS ?? [];
  if (configured.length === 1 && configured[0] === OLLAMA_URL) {
    console.log(`  Ollama URL already ${OLLAMA_URL}`);
    return;
  }

  const result = await call('/ollama/config/update', {
    token,
    body: {
      ENABLE_OLLAMA_API: true,
      OLLAMA_BASE_URLS: [OLLAMA_URL],
      OLLAMA_API_CONFIGS: {},
    },
  });

  if (result.status !== 200) {
    console.error(`  NOTE: could not set the Ollama URL (${result.status}).`);
    console.error(`  Set it by hand in Admin Settings → Connections: ${OLLAMA_URL}`);
    return;
  }
  console.log(
    `  set Ollama URL to ${OLLAMA_URL}${configured.length ? ` (was ${configured[0]})` : ''}`,
  );
}

async function seedToolServer(token) {
  const connection = {
    url: TOOL_URL,
    path: 'openapi.json',
    type: 'openapi',
    auth_type: 'bearer',
    key: TOOL_KEY,
    config: { enable: true, access_grants: [] },
    info: {
      id: TOOL_ID,
      name: 'mongodb-memory-mcp',
      description: 'MongoDB-backed knowledge base (store, search, list, delete)',
    },
  };

  const current = await call('/api/v1/configs/tool_servers', { token });
  const existing = current.body?.TOOL_SERVER_CONNECTIONS ?? [];
  const kept = existing.filter((entry) => entry?.info?.id !== TOOL_ID);

  const result = await call('/api/v1/configs/tool_servers', {
    token,
    body: { TOOL_SERVER_CONNECTIONS: [...kept, connection] },
  });

  if (result.status !== 200) {
    console.error(`  ERROR: setting the tool server failed (${result.status})`);
    console.error(`  ${JSON.stringify(result.body).slice(0, 300)}`);
    return false;
  }

  const replaced = existing.length - kept.length;
  console.log(`  registered tool server ${TOOL_URL}${replaced > 0 ? ' (replaced existing)' : ''}`);
  return true;
}

/**
 * Optional model preset, bound to the tool and set to Native function calling.
 *
 * Skipped unless OWUI_BASE_MODEL names a model, because the right value depends
 * on which model has actually been pulled on the operator's Ollama server.
 * Native matters: under Default, Open WebUI asks the model to emit a
 * tool-selection payload as text, which reasoning models reliably fail to
 * produce — they narrate the call instead of making it.
 */
async function seedModel(token) {
  if (BASE_MODEL.length === 0) {
    console.log('  OWUI_BASE_MODEL not set — skipping the model preset');
    return;
  }

  const body = {
    id: MODEL_ID,
    name: `MongoDB KB (${BASE_MODEL})`,
    base_model_id: BASE_MODEL,
    meta: {
      description: 'Chats with the MongoDB knowledge base over MCP.',
      toolIds: [`server:${TOOL_ID}`],
    },
    params: { function_calling: 'native', system: SYSTEM_PROMPT },
    is_active: true,
  };

  // Delete first so re-running actually updates the preset. `create` refuses a
  // duplicate id, and it reports that refusal as **401** with the message "this
  // model id is already registered" — an auth status for a naming conflict,
  // which reads like a broken token and is not one.
  await call('/api/v1/models/model/delete', { token, body: { id: MODEL_ID } });

  const result = await call('/api/v1/models/create', { token, body });

  if (result.status !== 200) {
    console.error(`  NOTE: model preset not created (${result.status}). Not fatal —`);
    console.error('  enable the tool per chat instead, and set Function Calling to Native.');
    return;
  }
  console.log(`  created model preset "${MODEL_ID}" on base ${BASE_MODEL}`);
}

async function main() {
  console.log(`Seeding Open WebUI at ${BASE}`);

  const config = await waitForOpenWebUi();
  if (!config) {
    console.error('  ERROR: Open WebUI never became reachable');
    return 1;
  }

  const token = await authenticate(config.features?.auth === false);
  if (!token) return 1;
  await seedOllamaUrl(token);
  if (!(await seedToolServer(token))) return 1;
  await seedModel(token);

  console.log('Done. Open the UI, pick the model, and the tools are already connected.');
  return 0;
}

process.exitCode = await main();
