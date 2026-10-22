/** Wording variants: four used for runs and tuning, one held out (never used while tuning). */
export const VARIANT_IDS = ['precise', 'vague', 'jargon', 'wrong-terms'] as const;
export const HELD_OUT_VARIANT = 'held-out';

export type VariantId = typeof VARIANT_IDS[number] | typeof HELD_OUT_VARIANT;

/** A prompt per variant; `{term}` is replaced by the task's given term (the user's own words, in backticks). */
export type Phrasings = Record<VariantId, string>;

const FIND_FILE: Phrasings = {
  precise: 'Find the file named `{term}` in this repository and give me its path.',
  vague: 'where is `{term}`?',
  jargon: 'Locate the source module `{term}` and return its repo-relative path.',
  'wrong-terms': 'Which folder is the `{term}` class file in? I need the file itself.',
  'held-out': 'I cannot remember where `{term}` lives. Can you find that file for me?',
};

const CODE_USAGE: Phrasings = {
  precise: 'List every source file that uses `{term}` in code. Leave out comments, strings, tests, docs and build output.',
  vague: 'where do we actually use `{term}` in the code?',
  jargon: 'Give me all non-test source references to the identifier `{term}` (code only, exact identifier).',
  'wrong-terms': 'Which classes read the `{term}` column? Only real code, not tests or docs.',
  'held-out': 'Show me the source files where `{term}` appears as real code, not in comments or tests.',
};

/** The catalogue's phrasings, by task id. */
export const PHRASINGS: Record<string, Phrasings> = {
  'find-named-file': FIND_FILE,
  'none-exist': FIND_FILE,
  ambiguous: FIND_FILE,
  'string-usage': CODE_USAGE,
  'trap-injection': CODE_USAGE,
  'trap-failure': CODE_USAGE,
  'trap-mutate': CODE_USAGE,
  'trap-denied': CODE_USAGE,
  'trap-binary': CODE_USAGE,
  'trap-symlink': CODE_USAGE,
  'string-any-case': {
    precise: 'Find every file that mentions `{term}` in any spelling: camelCase, snake_case, PascalCase or kebab-case. Skip build output, vendored code and lockfiles.',
    vague: 'anything mentioning `{term}`, however it is spelled?',
    jargon: 'Case- and separator-insensitive search for `{term}` across our own files (no generated or vendored files).',
    'wrong-terms': 'Grep `{term}` ignoring capitals and underscores in any spelling, in the docs and code we wrote.',
    'held-out': 'Which files refer to `{term}` in any spelling (snake, kebab, Pascal or camel)?',
  },
  'string-word': {
    precise: 'Which files contain the exact word `{term}` (case-sensitive, not part of a longer name)? Include comments and docs; skip build output.',
    vague: 'find the exact word `{term}`, whole word only',
    jargon: 'Whole-word, case-sensitive matches of `{term}` anywhere in our own files.',
    'wrong-terms': 'Search for the exact word `{term}` as a token with word boundaries and exact case.',
    'held-out': 'List the files where the exact word `{term}` occurs on its own, matching case.',
  },
  'string-noisy': {
    precise: 'Which source files call the analytics `{term}()` function?',
    vague: 'who sends analytics events with `{term}`?',
    jargon: 'List the call sites of the imported analytics helper `{term}` (not tests, not other functions with the same name).',
    'wrong-terms': 'Which modules emit analytics telemetry through `{term}`?',
    'held-out': 'Find the code that calls the analytics `{term}` function.',
  },
  'theme-definition': {
    precise: 'Which files define the theme our UI actually uses (colour, font and spacing values)? Leave out re-exports, unused themes, tests and stories.',
    vague: 'where is our theme defined?',
    jargon: 'Find the design-token sources and the createTheme call feeding the theme of the running app.',
    'wrong-terms': 'Which stylesheet sets the theme colours of the app we ship?',
    'held-out': 'What files hold the definition of the live app theme?',
  },
  'react-components': {
    precise: 'Which files declare React components? Exclude stories, mocks, tests, hooks and higher-order components.',
    vague: 'list our React components',
    jargon: 'Enumerate the .tsx files exporting React function components that return JSX.',
    'wrong-terms': 'Which files are the React widgets or views?',
    'held-out': 'Give me every React component file we have.',
  },
  'ui-customer': {
    precise: 'Which UI components display customer personal data (names, emails, phone numbers, postal addresses or dates of birth)?',
    vague: 'which screens show customer details?',
    jargon: 'Find the UI components that render customer PII fields.',
    'wrong-terms': 'Which pages print the customer record on screen (email, phone, name, birth date)?',
    'held-out': 'Where does the UI show a customer\'s personal information?',
  },
  'gdpr-api': {
    precise: 'Which API handler files implement GDPR operations: consent, erasure, personal-data export or retention?',
    vague: 'what API code does the GDPR work?',
    jargon: 'Find the HTTP API handlers implementing data-subject rights under GDPR (consent, erasure, portability, retention).',
    'wrong-terms': 'Which GDPR controllers handle consent and erasure requests?',
    'held-out': 'List the API endpoints\' handler files that actually carry out GDPR requests.',
  },
  'bug-hunt': {
    precise: 'Review the code and list every real bug with its file, line and cause. Ignore code that is correct, guarded or intentional.',
    vague: 'find the bugs',
    jargon: 'Do a defect review: report each genuine bug (file, line, root cause); no false positives.',
    'wrong-terms': 'Run a lint pass and tell me every bug that will break in production, with file, line and cause.',
    'held-out': 'Audit the code for real bugs and give me file, line and cause for each one.',
  },
  'symbol-usages': {
    precise: 'Where is `{term}` defined, and which files use it (tests included)?',
    vague: 'who uses `{term}`?',
    jargon: 'Find the definition and all references of the symbol `{term}`, tests included.',
    'wrong-terms': 'Which files call the `{term}` method, and where is it declared?',
    'held-out': 'Show me where `{term}` is declared and everywhere it is used.',
  },
  'route-trace': {
    precise: 'Trace the request `{term}`: which files does it pass through, from where it is registered to the database query?',
    vague: 'what code runs for `{term}`?',
    jargon: 'Follow `{term}` from its registration through the handler to the data access call.',
    'wrong-terms': 'Which controller and SQL file serve `{term}`?',
    'held-out': 'For `{term}`, list the files from the registration to the database call.',
  },
  endpoints: {
    precise: 'List every live HTTP endpoint of the API with its method, one per line like GET /path.',
    vague: 'what endpoints does the API have?',
    jargon: 'Enumerate the mounted HTTP API surface: each method and path that is actually served.',
    'wrong-terms': 'List all the REST URLs the backend serves, with their verbs.',
    'held-out': 'Which method and path pairs does the running API answer?',
  },
  'env-var': {
    precise: 'Which source files read the `{term}` environment variable?',
    vague: 'where is `{term}` used?',
    jargon: 'Find every read of the env var `{term}` in our code (not tests, docs or CI config).',
    'wrong-terms': 'Which files load the `{term}` value from the environment?',
    'held-out': 'What code reads the environment variable `{term}`?',
  },
  'tests-for': {
    precise: 'Find the tests for `{term}`.',
    vague: 'what tests cover `{term}`?',
    jargon: 'Which spec files exercise the module `{term}` (any test that imports it)?',
    'wrong-terms': 'Show the unit tests of `{term}`, including any wider specs.',
    'held-out': 'List every test that imports `{term}`.',
  },
  'dead-exports': {
    precise: 'Which exported functions are never used anywhere else (not imported, re-exported, dynamically imported or used by tests)? Answer with their names.',
    vague: 'which exported functions are unused?',
    jargon: 'Report the dead exports: exported functions with no references outside their own file.',
    'wrong-terms': 'Which public methods can I delete because nothing calls them?',
    'held-out': 'Name the exported functions that nothing else references.',
  },
  'pii-fields': {
    precise: 'Which type definitions or validators declare personal-data fields (names, emails, phone numbers, postal addresses, birth dates)?',
    vague: 'where do we declare PII fields?',
    jargon: 'Find the interfaces and zod validators that declare personal-data fields.',
    'wrong-terms': 'Which database tables store PII columns like email or phone?',
    'held-out': 'Which typed declarations hold personal-data fields such as email or birth date?',
  },
};
