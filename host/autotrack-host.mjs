#!/usr/bin/env node
/**
 * Native messaging host `com.wrenautomation.autotrack`. Chrome or Edge starts it when the
 * extension connects and closes stdin when it disconnects. Relays the extension's events to the
 * running recorder's control socket (see relay.mjs). stdout carries framed messages only; logs go
 * to stderr, which the browser keeps in its own log.
 */
import { createConnection } from "node:net";
import { controlPath } from "./control.mjs";
import { relay } from "./relay.mjs";

relay({
  input: process.stdin,
  output: process.stdout,
  path: controlPath(),
  connect: (path) => createConnection(path),
  onEnd: () => process.exit(0),
});
