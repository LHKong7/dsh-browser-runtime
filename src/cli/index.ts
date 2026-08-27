#!/usr/bin/env node
/** `dsh-browser-runtime` command line entry. */

import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2))
