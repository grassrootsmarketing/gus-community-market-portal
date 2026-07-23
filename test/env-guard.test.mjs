import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotProduction, getConfig, PROD_SUPABASE_HOST } from '../api/_env.js';

test('assertNotProduction throws when pointed at the production Supabase host', () => {
  process.env.SUPABASE_URL = 'https://' + PROD_SUPABASE_HOST;
  delete process.env.VERCEL_ENV;
  assert.throws(() => assertNotProduction(), /PRODUCTION/);
});

test('assertNotProduction throws when VERCEL_ENV=production', () => {
  process.env.SUPABASE_URL = 'https://staging.supabase.co';
  process.env.VERCEL_ENV = 'production';
  assert.throws(() => assertNotProduction(), /PRODUCTION/);
});

test('assertNotProduction allows an isolated staging target', () => {
  process.env.SUPABASE_URL = 'https://staging-xyz.supabase.co';
  process.env.VERCEL_ENV = 'preview';
  assert.equal(assertNotProduction(), true);
});

test('getConfig fails closed when a required variable is missing', () => {
  delete process.env.SUPABASE_URL;
  assert.throws(() => getConfig(), /Missing required environment variable: SUPABASE_URL/);
});
