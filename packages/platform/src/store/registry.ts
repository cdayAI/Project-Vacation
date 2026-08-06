import { MIGRATIONS as RECORD_MIGRATIONS } from "../record/migrations.js";
import { MIGRATIONS as AUDIT_MIGRATIONS } from "../audit/migrations.js";
import { MIGRATIONS as GUARD_MIGRATIONS } from "../guard/migrations.js";
import { MIGRATIONS as KNOWLEDGE_MIGRATIONS } from "../knowledge/migrations.js";
import { MIGRATIONS as MODELS_MIGRATIONS } from "../models/migrations.js";
import { MIGRATIONS as IDENTITY_MIGRATIONS } from "../identity/migrations.js";
import { MIGRATIONS as CONTACT_MIGRATIONS } from "../contact/migrations.js";
import { MIGRATIONS as INTEGRATIONS_MIGRATIONS } from "../integrations/migrations.js";
import { MIGRATIONS as DOCUMENT_MIGRATIONS } from "../documents/migrations.js";
import { orderMigrations, type Migration } from "./migrate.js";

/**
 * Every module's schema, in one ordered list.
 *
 * **To add a module: add one import above and one entry to `SOURCES` below.**
 * Nothing else. The runner sorts by id, so the position of an entry in this
 * array does not matter and cannot be got wrong.
 *
 * Ids are allocated in blocks so two modules developed in parallel cannot
 * collide on a number, which would otherwise mean two different schema changes
 * claiming the same identity in `schema_migrations`:
 *
 *     0001  record       the operating record
 *     0002  audit        the hash-chained audit log
 *     0003  guard        approvals, approver decisions, containment switches
 *     0004+ unallocated  claim the next free number when you add a module
 *
 * A note on direction. Everything else under `store/` sits *below* the
 * modules: `db.ts` is the seam they share, and they import it. This file is
 * the exception — it is a composition point that imports *from* the modules,
 * in the same way the demo and the API do. It is here rather than in a module
 * because "the schema of the whole deployment" belongs to no single module,
 * and the migration runner needs one list.
 */

const SOURCES: readonly (readonly Migration[])[] = [
  RECORD_MIGRATIONS,
  AUDIT_MIGRATIONS,
  GUARD_MIGRATIONS,
  KNOWLEDGE_MIGRATIONS,
  MODELS_MIGRATIONS,
  IDENTITY_MIGRATIONS,
  CONTACT_MIGRATIONS,
  INTEGRATIONS_MIGRATIONS,
  DOCUMENT_MIGRATIONS,
];

/**
 * All migrations, sorted by id and checked for duplicates.
 *
 * Validated at module load rather than at migration time, so a collision
 * between two modules' ids is a startup failure in every environment
 * including a developer's laptop — not something discovered on the first
 * production deploy.
 */
export const ALL_MIGRATIONS: readonly Migration[] = orderMigrations(SOURCES.flat());
