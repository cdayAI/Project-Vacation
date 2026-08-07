/**
 * Say out loud which adapters this run actually exercised.
 *
 * The persistence contract suites are the only thing that proves the Postgres
 * adapter and the in-memory fake behave identically, and they are gated on
 * `PV_TEST_DATABASE_URL`. Without it, 158 assertions — including every
 * concurrency case, the append-only triggers, and the store-unavailable
 * refusals — are skipped, and the run still ends in a green summary.
 *
 * That is the exact shape of false green this project's verification pass
 * exists to catch: a suite that passes because it did not ask the hard
 * question. F-12 was a case where the fake was quietly more permissive than
 * the real store, and a run without this variable would not have found it.
 *
 * So the run states which half it covered. A banner is not a control, but a
 * reader who sees "1,766 passed" and nothing else has been told something
 * misleading, and a reader who sees this has not.
 */
export default function announceAdapters(): void {
  const connectionString = process.env.PV_TEST_DATABASE_URL;

  if (connectionString === undefined || connectionString === "") {
    process.stderr.write(
      [
        "",
        "  PV_TEST_DATABASE_URL is not set.",
        "  The persistence contract suites will run against the in-memory adapters only;",
        "  every Postgres case is SKIPPED. A green result from this run says nothing about",
        "  the adapter a deployment actually uses.",
        "",
        "  To exercise both:  export PV_TEST_DATABASE_URL=postgresql://localhost:5432/vacation_test",
        "",
      ].join("\n"),
    );
    return;
  }

  process.stderr.write(
    `\n  PV_TEST_DATABASE_URL is set; the persistence contract suites run against both adapters.\n\n`,
  );
}
