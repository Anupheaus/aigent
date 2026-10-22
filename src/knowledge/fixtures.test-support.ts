import type { KnowledgeSource } from './knowledge-types.js';

/** One fixture document. */
interface FixtureDoc {
  id: string;
  text: string;
  topic: string;
}

/** A labelled query: the documents that answer it. */
export interface RelevanceJudgment {
  query: string;
  relevant: string[];
}

const DOCS: FixtureDoc[] = [
  { id: 'install.md', topic: 'setup', text: '# Installing Lumen\n\nInstall Lumen with npm install lumen. Node 20 or later is required. The installer downloads no binaries.' },
  { id: 'upgrade.md', topic: 'setup', text: '# Upgrading\n\nTo upgrade Lumen to a new major version, read the migration guide, then run npm update lumen and rebuild your project.' },
  { id: 'config-file.md', topic: 'config', text: '# Configuration file\n\nLumen reads lumen.config.json from the project root. The parseConfigFile function validates it and reports unknown keys.' },
  { id: 'config-env.md', topic: 'config', text: '# Environment variables\n\nEvery setting can be overridden with an environment variable prefixed LUMEN_, for example LUMEN_PORT=8080.' },
  { id: 'parse-config.ts', topic: 'config', text: 'export function parseConfigFile(path: string): LumenConfig {\n  const raw = readFileSync(path, "utf8");\n  return validateConfig(JSON.parse(raw));\n}\n' },
  { id: 'retry.md', topic: 'network', text: '# Retries\n\nFailed requests are retried with exponential backoff. MAX_RETRY_COUNT limits the attempts to five by default.' },
  { id: 'retry.ts', topic: 'network', text: 'export const MAX_RETRY_COUNT = 5;\nexport function backoffDelay(attempt: number): number {\n  return 2 ** attempt * 100;\n}\n' },
  { id: 'timeouts.md', topic: 'network', text: '# Timeouts\n\nEach request times out after thirty seconds. Raise requestTimeoutMs for slow upstream servers.' },
  { id: 'proxy.md', topic: 'network', text: '# Proxies\n\nLumen honours the HTTPS_PROXY variable. Requests to private addresses never go through the proxy.' },
  { id: 'tls.md', topic: 'network', text: '# TLS certificates\n\nCustom certificate authorities are loaded from the caFile setting. Self-signed certificates are refused unless allowInsecure is set.' },
  { id: 'auth-login.md', topic: 'auth', text: '# Logging in\n\nUsers sign in with an email address and a password. After five failed attempts the account is locked for fifteen minutes.' },
  { id: 'auth-tokens.md', topic: 'auth', text: '# Access tokens\n\nAccess tokens expire after one hour. Refresh tokens last thirty days and are rotated on every use.' },
  { id: 'auth-sso.md', topic: 'auth', text: '# Single sign-on\n\nLumen supports SAML and OpenID Connect single sign-on. Configure the identity provider in the admin console.' },
  { id: 'session-store.ts', topic: 'auth', text: 'export function useSessionStore(): SessionStore {\n  return { get: readSession, set: writeSession, clear: clearSession };\n}\n' },
  { id: 'sessions.md', topic: 'auth', text: '# Sessions\n\nSessions are stored server side. The useSessionStore hook reads and writes the current session.' },
  { id: 'billing-plans.md', topic: 'billing', text: '# Plans and pricing\n\nThe free plan includes three projects. The team plan costs twelve dollars per seat per month.' },
  { id: 'billing-invoices.md', topic: 'billing', text: '# Invoices\n\nInvoices are emailed on the first day of each month and can be downloaded as PDF from the billing page.' },
  { id: 'billing-refunds.md', topic: 'billing', text: '# Refunds\n\nAnnual subscriptions can be refunded within fourteen days. Monthly plans are not refunded.' },
  { id: 'billing-tax.md', topic: 'billing', text: '# Sales tax\n\nVAT is added to invoices for customers in the European Union unless a valid VAT number is provided.' },
  { id: 'db-migrations.md', topic: 'database', text: '# Database migrations\n\nRun lumen migrate to apply pending schema migrations. Each migration runs inside a transaction.' },
  { id: 'db-backups.md', topic: 'database', text: '# Backups\n\nThe database is backed up every night. Backups are kept for thirty five days and encrypted at rest.' },
  { id: 'db-indexes.md', topic: 'database', text: '# Indexes\n\nSlow queries usually need an index. Use lumen explain to see which index a query uses.' },
  { id: 'db-pool.ts', topic: 'database', text: 'export function createConnectionPool(size: number): Pool {\n  return new PoolImpl({ max: size, idleTimeoutMs: 10_000 });\n}\n' },
  { id: 'logging.md', topic: 'ops', text: '# Logging\n\nLogs are written as JSON lines to standard output. Set LUMEN_LOG_LEVEL to debug for more detail.' },
  { id: 'metrics.md', topic: 'ops', text: '# Metrics\n\nPrometheus metrics are served on /metrics. Request latency is reported as a histogram.' },
  { id: 'alerts.md', topic: 'ops', text: '# Alerts\n\nAlerts fire when the error rate stays above two percent for five minutes. Alerts are sent to the on-call channel.' },
  { id: 'deploy-docker.md', topic: 'deploy', text: '# Docker\n\nThe official Docker image runs as a non-root user. Mount your config file at /etc/lumen/lumen.config.json.' },
  { id: 'deploy-k8s.md', topic: 'deploy', text: '# Kubernetes\n\nA Helm chart deploys Lumen to Kubernetes. Liveness and readiness probes call the /health endpoint.' },
  { id: 'deploy-scaling.md', topic: 'deploy', text: '# Scaling\n\nLumen is stateless and scales horizontally. Put a load balancer in front of the instances.' },
  { id: 'cache.md', topic: 'performance', text: '# Caching\n\nResponses are cached in memory for sixty seconds. Set cacheTtlSeconds to zero to turn the cache off.' },
  { id: 'rate-limits.md', topic: 'performance', text: '# Rate limits\n\nEach API key may make one hundred requests per minute. Exceeding the limit returns HTTP 429 with a Retry-After header.' },
  { id: 'webhooks.md', topic: 'integrations', text: '# Webhooks\n\nWebhooks deliver events by HTTP POST. Each delivery is signed with an HMAC signature header.' },
  { id: 'slack.md', topic: 'integrations', text: '# Slack integration\n\nConnect a Slack workspace to receive notifications about failed builds and new comments.' },
  { id: 'cli.md', topic: 'cli', text: '# Command line\n\nThe lumen command has subcommands init, build, serve and migrate. Run lumen help for details.' },
  { id: 'plugins.md', topic: 'plugins', text: '# Plugins\n\nPlugins are npm packages that export a register function. They can add routes, commands and hooks.' },
  { id: 'i18n.md', topic: 'i18n', text: '# Translations\n\nInterface text is translated into twelve languages. Add a locale file under locales to contribute a translation.' },
  { id: 'accessibility.md', topic: 'i18n', text: '# Accessibility\n\nEvery screen supports keyboard navigation and screen readers. Colour contrast meets WCAG AA.' },
  { id: 'privacy.md', topic: 'legal', text: '# Privacy\n\nPersonal data is processed in the European Union. Users can export or delete their data from the account page.' },
  { id: 'faq-retry-copy.md', topic: 'network', text: '# Retries\n\nFailed requests are retried with exponential backoff. MAX_RETRY_COUNT limits the attempts to five by default!' },
  { id: 'config-errors.md', topic: 'config', text: '# Config errors\n\nWhen the file parser finds a config error it prints the file name, the line and the key it could not parse.' },
  { id: 'retry-policy.md', topic: 'network', text: '# Retry policy\n\nThe retry count and the delay between attempts can be changed per client. Counting starts at the first failure.' },
  { id: 'session-faq.md', topic: 'auth', text: '# Session questions\n\nA session store keeps user state between requests. Using a shared store lets several servers see the same session.' },
  { id: 'changelog.md', topic: 'setup', text: '# Changelog\n\nVersion 3 removed the legacy XML configuration format and added environment variable overrides.' },
];

/** About forty short documents (markdown and code) about a fictional product, with near duplicates. */
export function fixtureSources(): KnowledgeSource[] {
  return DOCS.map(({ id, text, topic }) => ({ id, uri: `docs/${id}`, text, metadata: { topic } }));
}

/** Queries with the documents that answer them; identifier queries name an exact symbol. */
export const JUDGMENTS: RelevanceJudgment[] = [
  { query: 'how do I install lumen', relevant: ['install.md'] },
  { query: 'upgrade to a new major version', relevant: ['upgrade.md'] },
  { query: 'where is the configuration file read from', relevant: ['config-file.md', 'deploy-docker.md'] },
  { query: 'override settings with environment variables', relevant: ['config-env.md', 'changelog.md'] },
  { query: 'parseConfigFile', relevant: ['parse-config.ts', 'config-file.md'] },
  { query: 'MAX_RETRY_COUNT', relevant: ['retry.ts', 'retry.md', 'faq-retry-copy.md'] },
  { query: 'useSessionStore', relevant: ['session-store.ts', 'sessions.md'] },
  { query: 'request timeout for slow servers', relevant: ['timeouts.md'] },
  { query: 'account locked after failed login attempts', relevant: ['auth-login.md'] },
  { query: 'when do access tokens expire', relevant: ['auth-tokens.md'] },
  { query: 'refund an annual subscription', relevant: ['billing-refunds.md'] },
  { query: 'VAT on invoices', relevant: ['billing-tax.md', 'billing-invoices.md'] },
  { query: 'apply database schema migrations', relevant: ['db-migrations.md'] },
  { query: 'how long are backups kept', relevant: ['db-backups.md'] },
  { query: 'prometheus metrics endpoint', relevant: ['metrics.md'] },
  { query: 'deploy with helm on kubernetes', relevant: ['deploy-k8s.md'] },
  { query: 'HTTP 429 rate limit', relevant: ['rate-limits.md'] },
  { query: 'webhook signature', relevant: ['webhooks.md'] },
  { query: 'createConnectionPool', relevant: ['db-pool.ts'] },
  { query: 'delete my personal data', relevant: ['privacy.md'] },
  { query: 'what does the team plan cost per user', relevant: ['billing-plans.md'] },
  { query: 'notify me in chat when a build breaks', relevant: ['slack.md'] },
  { query: 'which languages does the interface support', relevant: ['i18n.md'] },
  { query: 'can it run as root inside a container', relevant: ['deploy-docker.md'] },
  { query: 'self signed certificate refused', relevant: ['tls.md'] },
  { query: 'how often is the data saved for disaster recovery', relevant: ['db-backups.md'] },
  { query: 'monitor request latency', relevant: ['metrics.md'] },
  { query: 'backoffDelay', relevant: ['retry.ts'] },
  { query: 'validateConfig', relevant: ['parse-config.ts'] },
];
