#!/usr/bin/env node
/**
 * Generic agent CLI dispatcher.
 * Agent name is determined by basename(argv[0]).
 */

import { run } from '../src/index.js';
import { basename } from 'path';

const agent = basename(process.argv[1]).replace(/\.(js|mjs|ts)$/, '');

run({
  agent,
  baseUrl: process.env.JERRY_URL ?? 'http://127.0.0.1:8787',
  version: '0.1.0',
});
