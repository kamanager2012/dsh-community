#!/usr/bin/env node
import { runMarketplaceCli } from './cli.js'

const status = await runMarketplaceCli({ args: process.argv.slice(2) })
process.exit(status)
