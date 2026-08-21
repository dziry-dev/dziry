/**
 * This window's route. A signal here rather than in the framework because a
 * route is per window; `<Window route={…}>` hands it over and the host does the
 * rest. Navigation is `<a href>` in the pages — checked against the route table
 * at build time — plus `navigate()` where a handler decides the destination.
 */
import { signal } from "dziry";

export const route = signal("/");
