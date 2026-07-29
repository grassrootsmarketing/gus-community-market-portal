// Codex §4: a parser-based no-undef check. The undefined SERVICE_KEY defect was not a
// syntax error, so node --check and import tests were both blind to it. A regex guess
// would be, too. This uses a real parser and reports every violation in one run.
export default [
  {
    files: ['api/**/*.js', 'tools/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', Buffer: 'readonly', TextEncoder: 'readonly',
        TextDecoder: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        globalThis: 'readonly', crypto: 'readonly', AbortController: 'readonly',
        Response: 'readonly', Request: 'readonly', Headers: 'readonly', FormData: 'readonly',
        Blob: 'readonly', atob: 'readonly', btoa: 'readonly', structuredClone: 'readonly',
        global: 'readonly', __dirname: 'readonly', module: 'writable', require: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];
